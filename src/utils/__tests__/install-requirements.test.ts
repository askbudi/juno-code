import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const REQUIRED_PACKAGES = ['juno-kanban', 'requests', 'python-dotenv', 'slack_sdk'];

describe('install_requirements.sh cached dependency flow', { timeout: 120_000 }, () => {
  let tempDir: string;
  let binDir: string;
  let homeDir: string;
  let scriptPath: string;
  let uvLogPath: string;
  let curlLogPath: string;
  let pipxLogPath: string;
  let metadataLogPath: string;
  let installedDir: string;
  let latestDir: string;

  const writeExecutable = async (filePath: string, content: string): Promise<void> => {
    await fs.writeFile(filePath, content, { mode: 0o755 });
    await fs.chmod(filePath, 0o755);
  };

  const writePythonStub = async (requiresVenvForMetadata = false): Promise<void> => {
    await writeExecutable(
      path.join(binDir, 'python3'),
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "Python 3.12.8"
  exit 0
fi

if [[ "$1" == "-m" && "$2" == "venv" ]]; then
  target_dir="$3"
  mkdir -p "$target_dir/bin"
  cat > "$target_dir/bin/activate" <<'ACTIVATE_EOF'
#!/usr/bin/env bash
VIRTUAL_ENV="$(cd "$(dirname "${'${BASH_SOURCE[0]}'}")/.." && pwd)"
export VIRTUAL_ENV
ACTIVATE_EOF
  chmod +x "$target_dir/bin/activate"
  exit 0
fi

if [[ "$1" == "-" ]]; then
  echo metadata >> "${'${PYTHON_METADATA_LOG_FILE:?}'}"
  cache_file="$2"
  interval_hours="$3"
  shift 3
  expected=""
  for package in "$@"; do
    [[ -n "$expected" ]] && expected="${'${expected}'},"
    expected="${'${expected}'}${'${package}'}"
  done
  checked_at=""
  cached_packages=""
  package_lines=0
  if [[ -f "$cache_file" ]]; then
    while IFS='=' read -r key value; do
      [[ "$key" == "checked_at" ]] && checked_at="$value"
      [[ "$key" == "packages" ]] && cached_packages="$value"
      [[ "$key" == package.* && -n "$value" ]] && package_lines=$((package_lines + 1))
    done < "$cache_file"
  fi
  cache_status=stale
  now=$(date +%s)
  if [[ "$checked_at" =~ ^[0-9]+$ && "$cached_packages" == "$expected" && "$package_lines" -eq "$#" && $((now - checked_at)) -lt $((interval_hours * 3600)) ]]; then
    cache_status=fresh
  fi
  printf '__cache__|%s|\\n' "$cache_status"
  if [[ "${requiresVenvForMetadata ? 'true' : 'false'}" == "true" && "${'${VIRTUAL_ENV:-}'}" != *".venv_juno"* ]]; then
    for package in "$@"; do printf '%s||\\n' "$package"; done
    exit 0
  fi
  for package in "$@"; do
    version=""
    expected_version=""
    [[ -f "${'${INSTALLED_VERSION_DIR:?}'}/$package" ]] && version=$(cat "${'${INSTALLED_VERSION_DIR}'}/$package")
    if [[ "$cache_status" == "fresh" ]]; then
      expected_version=$(grep -F "package.$package=" "$cache_file" | head -1 | cut -d= -f2-)
    fi
    printf '%s|%s|%s\\n' "$package" "$version" "$expected_version"
  done
  exit 0
fi

if [[ "$1" == "-m" && "$2" == "pip" && "$3" == "install" ]]; then
  [[ "${'${PIP_FAIL:-0}'}" == "1" ]] && exit 1
  upgrade=false
  for arg in "$@"; do
    [[ "$arg" == "--upgrade" ]] && upgrade=true && continue
    if [[ "$upgrade" == true && "$arg" != --* ]]; then
      package="${'${arg%%==*}'}"
      if [[ "$arg" == *"=="* ]]; then
        printf '%s' "${'${arg#*==}'}" > "${'${INSTALLED_VERSION_DIR:?}'}/$package"
      elif [[ -f "${'${LATEST_VERSION_DIR:?}'}/$package" ]]; then
        cp "${'${LATEST_VERSION_DIR}'}/$package" "${'${INSTALLED_VERSION_DIR}'}/$package"
      fi
    fi
  done
  exit 0
fi

if [[ "$1" == "-m" && "$2" == "pip" && "$3" == "--version" ]]; then
  echo "pip 25.0 from /tmp/fake/site-packages/pip (python 3.12)"
  exit 0
fi

if [[ "$1" == "-c" ]]; then
  if [[ "$2" == *"sys.prefix != sys.base_prefix"* ]]; then
    [[ "${'${VIRTUAL_ENV:-}'}" == *".venv_juno"* ]] && exit 0
    exit 1
  fi
  if [[ "$2" == *"sysconfig.get_path('stdlib')"* ]]; then
    echo "${'${STDLIB_DIR:-/tmp/fake-stdlib}'}"
    exit 0
  fi
fi
exit 0
`,
    );
    await writeExecutable(
      path.join(binDir, 'python'),
      '#!/usr/bin/env bash\nexec "$(dirname "$0")/python3" "$@"\n',
    );
  };

  const createVenv = async (): Promise<void> => {
    const venvBinDir = path.join(tempDir, '.venv_juno', 'bin');
    await fs.ensureDir(venvBinDir);
    await writeExecutable(
      path.join(venvBinDir, 'activate'),
      `#!/usr/bin/env bash
VIRTUAL_ENV="$(cd "$(dirname "${'${BASH_SOURCE[0]}'}")/.." && pwd)"
export VIRTUAL_ENV
PATH="${binDir}:${'${PATH}'}"
export PATH
`,
    );
  };

  const testEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
    UV_LOG_FILE: uvLogPath,
    CURL_LOG_FILE: curlLogPath,
    PIPX_LOG_FILE: pipxLogPath,
    PYTHON_METADATA_LOG_FILE: metadataLogPath,
    INSTALLED_VERSION_DIR: installedDir,
    LATEST_VERSION_DIR: latestDir,
    VERSION_CHECK_INTERVAL_HOURS: '24',
    VIRTUAL_ENV: '',
    CONDA_DEFAULT_ENV: '',
    ...extra,
  });

  const runScript = (args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync('bash', [scriptPath, ...args], {
      cwd: tempDir,
      env: testEnv(extraEnv),
      encoding: 'utf-8',
    });

  const writeSuccessCache = async (
    checkedAt = Math.floor(Date.now() / 1000),
    packages = REQUIRED_PACKAGES,
  ): Promise<void> => {
    const cacheDir = path.join(tempDir, '.juno_task');
    await fs.ensureDir(cacheDir);
    const lines = [
      'format=1',
      `checked_at=${checkedAt}`,
      `packages=${packages.join(',')}`,
      ...packages.map((packageName) => `package.${packageName}=1.0.0`),
      '',
    ];
    await fs.writeFile(path.join(cacheDir, '.version_check_cache'), lines.join('\n'));
  };

  const lineCount = async (filePath: string): Promise<number> => {
    if (!(await fs.pathExists(filePath))) return 0;
    return (await fs.readFile(filePath, 'utf-8')).trim().split('\n').filter(Boolean).length;
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'install-req-test-'));
    binDir = path.join(tempDir, 'bin');
    homeDir = path.join(tempDir, 'home');
    installedDir = path.join(tempDir, 'installed');
    latestDir = path.join(tempDir, 'latest');
    scriptPath = path.join(tempDir, 'install_requirements.sh');
    uvLogPath = path.join(tempDir, 'uv.log');
    curlLogPath = path.join(tempDir, 'curl.log');
    pipxLogPath = path.join(tempDir, 'pipx.log');
    metadataLogPath = path.join(tempDir, 'metadata.log');

    await Promise.all([
      fs.ensureDir(binDir),
      fs.ensureDir(homeDir),
      fs.ensureDir(installedDir),
      fs.ensureDir(latestDir),
    ]);
    for (const packageName of REQUIRED_PACKAGES) {
      await fs.writeFile(path.join(installedDir, packageName), '1.0.0');
      await fs.writeFile(path.join(latestDir, packageName), '1.0.0');
    }

    const sourceScript = path.resolve(process.cwd(), 'src/templates/scripts/install_requirements.sh');
    await fs.copyFile(sourceScript, scriptPath);
    await fs.chmod(scriptPath, 0o755);
    await writePythonStub(false);

    await writeExecutable(
      path.join(binDir, 'curl'),
      `#!/usr/bin/env bash
echo "$*" >> "${'${CURL_LOG_FILE:?}'}"
[[ -n "${'${CURL_SLEEP_SECONDS:-}'}" ]] && sleep "${'${CURL_SLEEP_SECONDS}'}"
url="${'${!#}'}"
package="${'${url#*/pypi/}'}"
package="${'${package%/json}'}"
if [[ "${'${CURL_FAIL_PACKAGE:-}'}" == "$package" ]]; then exit 1; fi
version=$(cat "${'${LATEST_VERSION_DIR:?}'}/$package")
printf '{"info":{"version":"%s"}}\\n' "$version"
`,
    );

    await writeExecutable(
      path.join(binDir, 'uv'),
      `#!/usr/bin/env bash
echo "$*" >> "${'${UV_LOG_FILE:?}'}"
[[ "${'${UV_FAIL:-0}'}" == "1" ]] && exit 1
upgrade=false
for arg in "$@"; do
  [[ "$arg" == "--upgrade" ]] && upgrade=true && continue
  if [[ "$upgrade" == true && "$arg" != --* ]]; then
    package="${'${arg%%==*}'}"
    if [[ "$arg" == *"=="* ]]; then
      printf '%s' "${'${arg#*==}'}" > "${'${INSTALLED_VERSION_DIR:?}'}/$package"
    elif [[ -f "${'${LATEST_VERSION_DIR:?}'}/$package" ]]; then
      cp "${'${LATEST_VERSION_DIR}'}/$package" "${'${INSTALLED_VERSION_DIR}'}/$package"
    fi
  fi
done
exit 0
`,
    );
    await writeExecutable(
      path.join(binDir, 'pipx'),
      `#!/usr/bin/env bash
echo "$*" >> "${'${PIPX_LOG_FILE:?}'}"
exit 0
`,
    );
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('uses one metadata process and no network on a fresh complete cache', async () => {
    await createVenv();
    await writeSuccessCache();

    const result = runScript();

    expect(result.status).toBe(0);
    expect(await lineCount(metadataLogPath)).toBe(1);
    expect(await lineCount(curlLogPath)).toBe(0);
    const script = await fs.readFile(scriptPath, 'utf-8');
    expect(script).not.toContain('pip show');
    expect(script.match(/load_installed_package_metadata/g)?.length).toBeGreaterThan(1);
  });

  it('repairs installed-version drift from a fresh complete cache without PyPI', async () => {
    await createVenv();
    await writeSuccessCache();
    await fs.writeFile(path.join(installedDir, 'juno-kanban'), '0.5.0');
    await fs.writeFile(path.join(latestDir, 'juno-kanban'), '9.9.9');

    const result = runScript();
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.status).toBe(0);
    expect(output).toContain('Repairing dependencies from fresh cached versions: juno-kanban==1.0.0');
    expect(output).toContain('All packages match fresh cached versions');
    expect(await fs.readFile(path.join(installedDir, 'juno-kanban'), 'utf-8')).toBe('1.0.0');
    expect(await lineCount(metadataLogPath)).toBe(3);
    expect(await lineCount(curlLogPath)).toBe(0);
    expect(await fs.readFile(uvLogPath, 'utf-8')).toContain('juno-kanban==1.0.0');
  });

  it('repairs an incompatible controller from selected source without cached PyPI downgrade', async () => {
    await createVenv();
    await writeSuccessCache();
    const selectedSource = path.join(tempDir, 'selected juno kanban');
    await fs.ensureDir(selectedSource);
    await fs.writeFile(path.join(selectedSource, 'setup.py'), '# selected source fixture\n');
    await fs.writeFile(path.join(installedDir, 'juno-kanban'), '1.42.0');
    await writeExecutable(
      path.join(binDir, 'juno-kanban'),
      `#!/usr/bin/env bash
if [[ -f "${'${SELECTED_SOURCE_REPAIRED_MARKER:?}'}" ]]; then echo 'task 2.0.0'; exit 0; fi
echo 'juno-kanban: error: unrecognized arguments: --version' >&2
exit 2
`,
    );
    const repairedMarker = path.join(tempDir, 'source-repaired');
    const originalUv = await fs.readFile(path.join(binDir, 'uv'), 'utf8');
    await writeExecutable(
      path.join(binDir, 'uv'),
      originalUv.replace('[[ "${UV_FAIL:-0}" == "1" ]] && exit 1', '[[ "${UV_FAIL:-0}" == "1" ]] && exit 1\n[[ "$*" == *"${JUNO_002_KANBAN_SOURCE:-__unset__}"* ]] && touch "${SELECTED_SOURCE_REPAIRED_MARKER:?}"'),
    );

    const result = runScript([], {
      JUNO_002_KANBAN_SOURCE: selectedSource,
      SELECTED_SOURCE_REPAIRED_MARKER: repairedMarker,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const uvLog = await fs.readFile(uvLogPath, 'utf8');

    expect(result.status, output).toBe(0);
    expect(output).toContain('Repairing incompatible juno-kanban runtime from selected source');
    expect(uvLog).toContain(selectedSource);
    expect(uvLog).not.toContain('juno-kanban==1.0.0');
    expect(await fs.pathExists(repairedMarker)).toBe(true);
    expect(await lineCount(curlLogPath)).toBe(0);
  });

  it('repairs a missing package from a fresh complete cache without PyPI', async () => {
    await createVenv();
    await writeSuccessCache();
    await fs.remove(path.join(installedDir, 'python-dotenv'));

    const result = runScript();

    expect(result.status).toBe(0);
    expect(await fs.readFile(path.join(installedDir, 'python-dotenv'), 'utf-8')).toBe('1.0.0');
    expect(await lineCount(metadataLogPath)).toBe(3);
    expect(await lineCount(curlLogPath)).toBe(0);
    expect(await fs.readFile(uvLogPath, 'utf-8')).toContain('python-dotenv==1.0.0');
  });

  it('records repair failure cooldown without false success or PyPI requests', async () => {
    await createVenv();
    await writeSuccessCache();
    await fs.writeFile(path.join(installedDir, 'juno-kanban'), '0.5.0');
    const cachePath = path.join(tempDir, '.juno_task', '.version_check_cache');
    const originalCache = await fs.readFile(cachePath, 'utf-8');

    const first = runScript([], { UV_FAIL: '1', PIP_FAIL: '1' });
    const firstOutput = `${first.stdout ?? ''}\n${first.stderr ?? ''}`;
    expect(first.status).toBe(0);
    expect(firstOutput).toContain('Cached dependency repair failed');
    expect(firstOutput).not.toContain('All requirements already satisfied');
    expect(await fs.readFile(cachePath, 'utf-8')).toBe(originalCache);
    expect(await fs.pathExists(path.join(tempDir, '.juno_task', '.version_check_failure'))).toBe(true);
    expect(await lineCount(curlLogPath)).toBe(0);
    expect(await lineCount(uvLogPath)).toBe(1);

    const second = runScript([], { UV_FAIL: '1', PIP_FAIL: '1' });
    expect(second.status).toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).toContain('retry suppressed for one hour');
    expect(await lineCount(uvLogPath)).toBe(1);
    expect(await lineCount(curlLogPath)).toBe(0);
  });

  it('blocks on a stale check, upgrades, verifies, then atomically publishes success', async () => {
    await createVenv();
    await fs.writeFile(path.join(latestDir, 'juno-kanban'), '2.0.0');
    await writeSuccessCache(0);

    const startedAt = Date.now();
    const result = runScript([], { CURL_SLEEP_SECONDS: '0.04' });
    const elapsedMs = Date.now() - startedAt;
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.status).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(120);
    expect(combinedOutput).toContain('Upgrading packages: juno-kanban');
    expect(await fs.readFile(path.join(installedDir, 'juno-kanban'), 'utf-8')).toBe('2.0.0');
    expect(await lineCount(metadataLogPath)).toBe(2);
    expect(await lineCount(curlLogPath)).toBe(4);
    const cache = await fs.readFile(path.join(tempDir, '.juno_task', '.version_check_cache'), 'utf-8');
    expect(cache).toContain('package.juno-kanban=2.0.0');
    expect((await fs.readdir(path.join(tempDir, '.juno_task'))).some((name) => name.includes('.tmp.'))).toBe(false);
  });

  it('does not publish partial success when one PyPI request fails', async () => {
    await createVenv();
    await writeSuccessCache(0);
    const cachePath = path.join(tempDir, '.juno_task', '.version_check_cache');
    const originalCache = await fs.readFile(cachePath, 'utf-8');

    const result = runScript([], { CURL_FAIL_PACKAGE: 'python-dotenv' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.status).toBe(0);
    expect(output).toContain('Could not complete PyPI check');
    expect(await fs.readFile(cachePath, 'utf-8')).toBe(originalCache);
    expect(await fs.pathExists(path.join(tempDir, '.juno_task', '.version_check_failure'))).toBe(true);
  });

  it('suppresses failed network retries for one hour and retries afterward', async () => {
    await createVenv();
    await writeSuccessCache(0);

    expect(runScript([], { CURL_FAIL_PACKAGE: 'juno-kanban' }).status).toBe(0);
    expect(await lineCount(curlLogPath)).toBe(1);
    const second = runScript([], { CURL_FAIL_PACKAGE: 'juno-kanban' });
    expect(second.status).toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).toContain('retry suppressed for one hour');
    expect(await lineCount(curlLogPath)).toBe(1);

    await fs.writeFile(path.join(tempDir, '.juno_task', '.version_check_failure'), 'failed_at=0\n');
    expect(runScript().status).toBe(0);
    expect(await lineCount(curlLogPath)).toBe(5);
  });

  it('serializes concurrent stale invocations so only one performs PyPI requests', async () => {
    await createVenv();
    await writeSuccessCache(0);

    const runConcurrent = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn('bash', [scriptPath], {
          cwd: tempDir,
          env: testEnv({ CURL_SLEEP_SECONDS: '0.05' }),
          stdio: 'ignore',
        });
        child.on('close', resolve);
      });

    const statuses = await Promise.all([runConcurrent(), runConcurrent()]);
    expect(statuses).toEqual([0, 0]);
    expect(await lineCount(curlLogPath)).toBe(4);
    expect(await fs.pathExists(path.join(tempDir, '.juno_task', '.version_check_lock'))).toBe(false);
  });

  it('invalidates a fresh-looking cache when the required package list drifts', async () => {
    await createVenv();
    await writeSuccessCache(Math.floor(Date.now() / 1000), REQUIRED_PACKAGES.slice(0, 3));

    expect(runScript().status).toBe(0);
    expect(await lineCount(curlLogPath)).toBe(4);
    const cache = await fs.readFile(path.join(tempDir, '.juno_task', '.version_check_cache'), 'utf-8');
    expect(cache).toContain(`packages=${REQUIRED_PACKAGES.join(',')}`);
  });

  it('activates .venv_juno before the one-process metadata check', async () => {
    await writePythonStub(true);
    await createVenv();
    await writeSuccessCache();

    const result = runScript();
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(output).toContain('Detected project virtual environment at .venv_juno');
    expect(await lineCount(metadataLogPath)).toBe(1);
  });

  it('creates .venv_juno when dependencies exist only outside the project venv', async () => {
    await writePythonStub(true);

    const result = runScript();
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(output).toContain('Project virtual environment missing: .venv_juno');
    expect(output).toContain('Created virtual environment at .venv_juno');
    expect(await fs.pathExists(path.join(tempDir, '.venv_juno', 'bin', 'activate'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.env.juno'))).toBe(false);
    expect(await fs.pathExists(path.join(tempDir, '.env_juno'))).toBe(false);
  });
});
