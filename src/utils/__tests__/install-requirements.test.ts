import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const REQUIRED_PACKAGES = ['juno-kanban', 'requests', 'python-dotenv', 'slack_sdk', 'PyYAML'];

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
if [[ "$1" == */controller_resolver.py ]]; then
  exec "${'${REAL_PYTHON:?}'}" "$@"
fi
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
  cache_format=""
  cache_policy=""
  checked_at=""
  cached_packages=""
  package_lines=0
  if [[ -f "$cache_file" ]]; then
    while IFS='=' read -r key value; do
      [[ "$key" == "format" ]] && cache_format="$value"
      [[ "$key" == "policy.juno-kanban" ]] && cache_policy="$value"
      [[ "$key" == "checked_at" ]] && checked_at="$value"
      [[ "$key" == "packages" ]] && cached_packages="$value"
      [[ "$key" == package.* && -n "$value" ]] && package_lines=$((package_lines + 1))
    done < "$cache_file"
  fi
  cache_status=stale
  now=$(date +%s)
  if [[ "$cache_format" == "2" && "$cache_policy" == ">=2.0.5,<3.0.0" && "$checked_at" =~ ^[0-9]+$ && "$cached_packages" == "$expected" && "$package_lines" -eq "$#" && $((now - checked_at)) -lt $((interval_hours * 3600)) ]]; then
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
      package="${'${arg%%[<>=!~]*}'}"
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
    REAL_PYTHON: spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim(),
    VERSION_CHECK_INTERVAL_HOURS: '24',
    VERSION_CHECK_CACHE_DIR: path.join(tempDir, '.juno_task'),
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
      'format=2',
      `checked_at=${checkedAt}`,
      'policy.juno-kanban=>=2.0.5,<3.0.0',
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
    package="${'${arg%%[<>=!~]*}'}"
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

  it('keeps default transient version-check state outside a Git worktree', async () => {
    expect(spawnSync('git', ['init', '-q', tempDir], { encoding: 'utf8' }).status).toBe(0);
    await createVenv();

    const result = runScript([], { VERSION_CHECK_CACHE_DIR: undefined });

    expect(result.status).toBe(0);
    expect(await fs.pathExists(path.join(tempDir, '.juno_task', '.version_check_cache'))).toBe(false);
    const commonDir = spawnSync(
      'git',
      ['-C', tempDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' },
    ).stdout.trim();
    expect(await fs.pathExists(path.join(commonDir, 'juno', 'version-checks', '.version_check_cache'))).toBe(true);
  });

  it('keeps a real linked worktree byte-stable while writing the shared version cache', async () => {
    const repository = path.join(tempDir, 'repository');
    const candidate = path.join(tempDir, 'candidate');
    await fs.ensureDir(repository);
    expect(spawnSync('git', ['init', '-q'], { cwd: repository, encoding: 'utf8' }).status).toBe(0);
    await fs.writeFile(path.join(repository, '.gitignore'), '.venv_juno/\n');
    await fs.writeFile(path.join(repository, 'product.txt'), 'unchanged\n');
    expect(spawnSync('git', ['add', '.'], { cwd: repository, encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], {
      cwd: repository, encoding: 'utf8',
    }).status).toBe(0);
    expect(spawnSync('git', ['worktree', 'add', '--detach', candidate, 'HEAD'], { cwd: repository, encoding: 'utf8' }).status).toBe(0);
    const candidateVenvBin = path.join(candidate, '.venv_juno', 'bin');
    await fs.ensureDir(candidateVenvBin);
    await writeExecutable(path.join(candidateVenvBin, 'activate'), `#!/usr/bin/env bash
VIRTUAL_ENV="$(cd "$(dirname "${'${BASH_SOURCE[0]}'}")/.." && pwd)"
export VIRTUAL_ENV
PATH="${binDir}:${'${PATH}'}"
export PATH
`);

    const git = (...args: string[]) => spawnSync('git', ['-C', candidate, ...args], { encoding: 'buffer' }).stdout;
    const before = {
      head: git('rev-parse', 'HEAD').toString(),
      index: await fs.readFile(git('rev-parse', '--path-format=absolute', '--git-path', 'index').toString().trim()),
      logical: git('ls-files', '--stage', '-z'),
      status: git('status', '--porcelain=v2', '-z', '--untracked-files=all'),
    };
    const result = spawnSync('bash', [scriptPath], {
      cwd: candidate,
      env: testEnv({ VERSION_CHECK_CACHE_DIR: undefined }),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const indexPath = git('rev-parse', '--path-format=absolute', '--git-path', 'index').toString().trim();
    expect(git('rev-parse', 'HEAD').toString()).toBe(before.head);
    expect(await fs.readFile(indexPath)).toEqual(before.index);
    expect(git('ls-files', '--stage', '-z')).toEqual(before.logical);
    expect(git('status', '--porcelain=v2', '-z', '--untracked-files=all')).toEqual(before.status);
    const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir').toString().trim();
    expect(await fs.pathExists(path.join(commonDir, 'juno', 'version-checks', '.version_check_cache'))).toBe(true);
    expect(await fs.pathExists(path.join(candidate, '.juno_task', '.version_check_cache'))).toBe(false);
  });

  it('routes matching and failed task-worktree version checks to controller-private state', async () => {
    const controller = path.join(tempDir, 'controller');
    const task = path.join(tempDir, 'task');
    const scripts = path.join(controller, '.juno_task', 'scripts');
    await fs.ensureDir(scripts);
    await fs.copyFile(scriptPath, path.join(scripts, 'install_requirements.sh'));
    await fs.copyFile(
      path.resolve(process.cwd(), 'src/templates/scripts/controller_resolver.py'),
      path.join(scripts, 'controller_resolver.py'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'src/templates/scripts/workflow_runner.sh'),
      path.join(scripts, 'workflow_runner.sh'),
    );
    for (const dependency of ['workflow_run_evidence.py', 'invocation_correlation.py']) {
      await fs.copyFile(
        path.resolve(process.cwd(), 'src/templates/scripts', dependency),
        path.join(scripts, dependency),
      );
    }
    await fs.writeFile(path.join(controller, '.gitignore'), '.venv_juno/\n.juno_task/runtime/\n');
    await fs.writeFile(path.join(controller, 'product.txt'), 'unchanged\n');
    expect(spawnSync('git', ['init', '-q', '-b', 'controller'], { cwd: controller }).status).toBe(0);
    expect(spawnSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: controller }).status).toBe(0);
    expect(spawnSync('git', ['add', '.'], { cwd: controller }).status).toBe(0);
    expect(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], {
      cwd: controller,
    }).status).toBe(0);
    expect(spawnSync('git', ['worktree', 'add', '-q', '-b', 'task-version-routing', task], {
      cwd: controller,
    }).status).toBe(0);
    const configure = (scope: '--local' | '--worktree', key: string, value: string) =>
      expect(spawnSync('git', ['config', scope, key, value], { cwd: task }).status).toBe(0);
    configure('--local', 'juno.controller.path', controller);
    configure('--local', 'juno.controller.branch', 'controller');
    configure('--worktree', 'juno.workspace.role', 'task');
    configure('--worktree', 'juno.workspace.taskId', 'VERSION1');
    configure('--worktree', 'juno.workspace.manifestIdentity', 'fixture-manifest');
    configure('--worktree', 'juno.workspace.createReceiptSha256', 'a'.repeat(64));
    configure('--worktree', 'juno.workspace.expectedPathsSha256', 'b'.repeat(64));

    const taskVenvBin = path.join(task, '.venv_juno', 'bin');
    await fs.ensureDir(taskVenvBin);
    await writeExecutable(path.join(taskVenvBin, 'activate'), `#!/usr/bin/env bash
VIRTUAL_ENV=${JSON.stringify(path.join(task, '.venv_juno'))}
export VIRTUAL_ENV
PATH=${JSON.stringify(binDir)}:$PATH
export PATH
`);
    const taskScript = path.join(task, '.juno_task', 'scripts', 'install_requirements.sh');
    const workflowRunner = path.join(task, '.juno_task', 'scripts', 'workflow_runner.sh');
    const workflow = path.join(tempDir, 'nested-version-check.yaml');
    const nestedCommand = path.join(tempDir, 'nested-version-check');
    await writeExecutable(path.join(binDir, 'yy'), `#!/usr/bin/env bash
[[ "$1" == pi ]] || { echo "expected nested yy pi" >&2; exit 64; }
source "${'${TASK_WORKTREE:?}'}/.venv_juno/bin/activate"
exec bash "${'${TASK_VERSION_SCRIPT:?}'}"
`);
    await writeExecutable(nestedCommand, '#!/usr/bin/env bash\nexec yy pi\n');
    await fs.writeFile(workflow, `schema_version: 1
workflow_id: nested_version_check
fail_workflow: true
steps:
  - id: nested_pi
    command: ${JSON.stringify(nestedCommand)}
    fail_workflow: true
`);
    const realPython = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
    const controllerVenv = path.join(controller, '.venv_juno');
    const createControllerVenv = spawnSync(realPython, ['-m', 'venv', '--system-site-packages', controllerVenv], {
      encoding: 'utf8',
    });
    expect(createControllerVenv.status, createControllerVenv.stderr).toBe(0);
    const hostileTaskCache = path.join(task, '.juno_task');
    const nestedEnv = testEnv({
      TASK_VERSION_SCRIPT: taskScript,
      TASK_WORKTREE: task,
      VERSION_CHECK_CACHE_DIR: hostileTaskCache,
      JUNO_TASK_ROOT: controller,
      JUNO_PROJECT_PATH: controller,
      JUNO_WORKSPACE_ROLE: 'controller',
    });
    const gitStatus = () => spawnSync(
      'git', ['-C', task, 'status', '--porcelain=v2', '-z', '--untracked-files=all'],
      { encoding: 'buffer' },
    ).stdout;
    const before = gitStatus();
    expect(before.byteLength).toBe(0);

    const runNestedWorkflow = (label: string, extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(
      realPython,
      [workflowRunner, '--workflow', workflow, '--out-dir', path.join(tempDir, `run-${label}`),
        '--print-output', 'none', '--no-print-step-stdout'],
      { cwd: task, env: { ...nestedEnv, ...extraEnv }, encoding: 'utf8', timeout: 60_000 },
    );
    const matching = runNestedWorkflow('matching');
    expect(await fs.pathExists(path.join(tempDir, 'run-matching', 'manifest.json')), `${matching.stdout}\n${matching.stderr}`).toBe(true);
    const matchingReport = await fs.readJson(path.join(tempDir, 'run-matching', 'manifest.json'));
    expect(matching.status, `${matching.stdout}\n${matching.stderr}\n${JSON.stringify(matchingReport)}`).toBe(0);
    const matchingStep = matchingReport.steps.find((step: { id: string }) => step.id === 'nested_pi');
    expect(matchingStep?.status).toBe('success');
    const matchingLog = [
      await fs.readFile(matchingStep.stdout_path, 'utf8'),
      await fs.readFile(matchingStep.stderr_path, 'utf8'),
    ].join('\n');
    expect(matchingLog).toContain('install_requirements.sh is being executed');
    expect(matchingLog).toContain(`executed from: ${await fs.realpath(task)}`);
    const privateRoot = path.join(controller, '.juno_task', 'runtime', 'managed-controller', 'version-checks');
    const privateEntries = await fs.readdir(privateRoot);
    expect(privateEntries).toHaveLength(1);
    const privateCache = path.join(privateRoot, privateEntries[0]!, '.version_check_cache');
    expect(await fs.pathExists(privateCache)).toBe(true);
    expect(await fs.pathExists(path.join(hostileTaskCache, '.version_check_cache'))).toBe(false);
    expect(gitStatus()).toEqual(before);

    await fs.writeFile(path.join(installedDir, 'juno-kanban'), '0.5.0');
    const mismatch = runNestedWorkflow('mismatch', { UV_FAIL: '1', PIP_FAIL: '1' });
    expect(mismatch.status).not.toBe(0);
    const mismatchManifest = await fs.readJson(path.join(tempDir, 'run-mismatch', 'manifest.json'));
    const mismatchStep = mismatchManifest.steps.find((step: { id: string }) => step.id === 'nested_pi');
    const mismatchLog = [
      await fs.readFile(mismatchStep.stdout_path, 'utf8'),
      await fs.readFile(mismatchStep.stderr_path, 'utf8'),
    ].join('\n');
    expect(mismatchLog).toContain('repair failed');
    expect(mismatchLog.length).toBeLessThan(10_000);
    expect(await fs.pathExists(path.join(path.dirname(privateCache), '.version_check_failure'))).toBe(true);
    expect(await fs.pathExists(path.join(hostileTaskCache, '.version_check_failure'))).toBe(false);
    expect(gitStatus()).toEqual(before);
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
if [[ -f "${'${SELECTED_SOURCE_REPAIRED_MARKER:?}'}" ]]; then echo 'task 2.0.5'; exit 0; fi
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
    expect(first.status).toBe(2);
    expect(firstOutput).toContain('Cached dependency repair failed');
    expect(firstOutput).not.toContain('All requirements already satisfied');
    expect(await fs.readFile(cachePath, 'utf-8')).toBe(originalCache);
    expect(await fs.pathExists(path.join(tempDir, '.juno_task', '.version_check_failure'))).toBe(true);
    expect(await lineCount(curlLogPath)).toBe(0);
    expect(await lineCount(uvLogPath)).toBe(1);

    const second = runScript([], { UV_FAIL: '1', PIP_FAIL: '1' });
    expect(second.status).toBe(2);
    expect(`${second.stdout}\n${second.stderr}`).toContain('retry suppressed for one hour');
    expect(await lineCount(uvLogPath)).toBe(1);
    expect(await lineCount(curlLogPath)).toBe(0);
  });

  it('blocks on a stale check, upgrades, verifies, then atomically publishes success', async () => {
    await createVenv();
    await fs.writeFile(path.join(latestDir, 'juno-kanban'), '2.0.5');
    await writeSuccessCache(0);

    const startedAt = Date.now();
    const result = runScript([], { CURL_SLEEP_SECONDS: '0.04' });
    const elapsedMs = Date.now() - startedAt;
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.status).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(120);
    expect(combinedOutput).toContain('Upgrading packages: juno-kanban');
    expect(await fs.readFile(path.join(installedDir, 'juno-kanban'), 'utf-8')).toBe('2.0.5');
    expect(await lineCount(metadataLogPath)).toBe(2);
    expect(await lineCount(curlLogPath)).toBe(REQUIRED_PACKAGES.length);
    const cache = await fs.readFile(path.join(tempDir, '.juno_task', '.version_check_cache'), 'utf-8');
    expect(cache).toContain('format=2');
    expect(cache).toContain('policy.juno-kanban=>=2.0.5,<3.0.0');
    expect(cache).toContain('package.juno-kanban=2.0.5');
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
    expect(await lineCount(curlLogPath)).toBe(1 + REQUIRED_PACKAGES.length);
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
    expect(await lineCount(curlLogPath)).toBe(REQUIRED_PACKAGES.length);
    expect(await fs.pathExists(path.join(tempDir, '.juno_task', '.version_check_lock'))).toBe(false);
  });

  it('invalidates a legacy cache that could pin juno-kanban below the minimum', async () => {
    await createVenv();
    await fs.writeFile(path.join(installedDir, 'juno-kanban'), '1.42.0');
    await fs.writeFile(path.join(latestDir, 'juno-kanban'), '2.0.5');
    await writeSuccessCache();
    const cachePath = path.join(tempDir, '.juno_task', '.version_check_cache');
    const cache = await fs.readFile(cachePath, 'utf8');
    await fs.writeFile(
      cachePath,
      cache.replace('format=2', 'format=1').replace('policy.juno-kanban=>=2.0.5,<3.0.0\n', ''),
    );

    const result = runScript();
    expect(result.status).toBe(0);
    expect(await lineCount(curlLogPath)).toBe(REQUIRED_PACKAGES.length);
    expect(await fs.readFile(path.join(installedDir, 'juno-kanban'), 'utf8')).toBe('2.0.5');
    expect(await fs.readFile(cachePath, 'utf8')).toContain('policy.juno-kanban=>=2.0.5,<3.0.0');
  });

  it('invalidates a fresh-looking cache when the required package list drifts', async () => {
    await createVenv();
    await writeSuccessCache(Math.floor(Date.now() / 1000), REQUIRED_PACKAGES.slice(0, 3));

    expect(runScript().status).toBe(0);
    expect(await lineCount(curlLogPath)).toBe(REQUIRED_PACKAGES.length);
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
    expect(await fs.readFile(uvLogPath, 'utf8')).toContain('juno-kanban>=2.0.5,<3.0.0');
  });
});
