import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('install_requirements.sh periodic update flow', () => {
  let tempDir: string;
  let binDir: string;
  let homeDir: string;
  let scriptPath: string;
  let uvLogPath: string;
  let curlLogPath: string;

  const writeExecutable = async (filePath: string, content: string): Promise<void> => {
    await fs.writeFile(filePath, content, { mode: 0o755 });
    await fs.chmod(filePath, 0o755);
  };

  const writePythonStub = async (requiresVenvForShow = false): Promise<void> => {
    const showHandler = requiresVenvForShow
      ? `if [[ "${'${VIRTUAL_ENV:-}'}" == *".venv_juno"* ]]; then
  package="$4"
  echo "Name: ${'${package}'}"
  echo "Version: 1.0.0"
  exit 0
fi
exit 1`
      : `package="$4"
echo "Name: ${'${package}'}"
echo "Version: 1.0.0"
exit 0`;

    await writeExecutable(
      path.join(binDir, 'python3'),
      `#!/usr/bin/env bash
if [[ "$1" == "-m" && "$2" == "pip" && "$3" == "show" ]]; then
  ${showHandler}
fi

if [[ "$1" == "-m" && "$2" == "pip" && "$3" == "install" ]]; then
  exit 0
fi

if [[ "$1" == "-m" && "$2" == "pip" && "$3" == "--version" ]]; then
  echo "pip 25.0 from /tmp/fake/site-packages/pip (python 3.12)"
  exit 0
fi

if [[ "$1" == "-c" ]]; then
  if [[ "$2" == *"sys.prefix != sys.base_prefix"* ]]; then
    if [[ "${'${VIRTUAL_ENV:-}'}" == *".venv_juno"* ]]; then
      exit 0
    fi
    exit 1
  fi

  if [[ "$2" == *"sysconfig.get_path('stdlib')"* ]]; then
    echo "/tmp/fake-stdlib"
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

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'install-req-test-'));
    binDir = path.join(tempDir, 'bin');
    homeDir = path.join(tempDir, 'home');
    scriptPath = path.join(tempDir, 'install_requirements.sh');
    uvLogPath = path.join(tempDir, 'uv.log');
    curlLogPath = path.join(tempDir, 'curl.log');

    await fs.ensureDir(binDir);
    await fs.ensureDir(homeDir);

    const sourceScript = path.resolve(process.cwd(), 'src/templates/scripts/install_requirements.sh');
    await fs.copyFile(sourceScript, scriptPath);
    await fs.chmod(scriptPath, 0o755);

    await writePythonStub(false);

    await writeExecutable(
      path.join(binDir, 'curl'),
      `#!/usr/bin/env bash
echo "$*" >> "${'${CURL_LOG_FILE:?CURL_LOG_FILE must be set}'}"

url=""
for arg in "$@"; do
  url="$arg"
done

version="1.0.0"
if [[ "$url" == *"/juno-kanban/json" ]]; then
  version="2.0.0"
fi

printf '{"info":{"version":"%s"}}\n' "${'${version}'}"
exit 0
`,
    );

    await writeExecutable(
      path.join(binDir, 'uv'),
      `#!/usr/bin/env bash
echo "$*" >> "${'${UV_LOG_FILE:?UV_LOG_FILE must be set}'}"
exit 0
`,
    );
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('continues update checks and upgrades when a package is outdated', async () => {
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: homeDir,
      UV_LOG_FILE: uvLogPath,
      CURL_LOG_FILE: curlLogPath,
      VERSION_CHECK_INTERVAL_HOURS: '24',
      VIRTUAL_ENV: '',
      CONDA_DEFAULT_ENV: '',
    };

    const result = spawnSync('bash', [scriptPath, '--force-update'], {
      cwd: tempDir,
      env,
      encoding: 'utf-8',
    });

    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.status).toBe(0);
    expect(combinedOutput).toContain('Performing periodic version check...');
    expect(combinedOutput).toContain('Upgrading packages: juno-kanban');

    const curlLog = await fs.readFile(curlLogPath, 'utf-8');
    expect(curlLog).toContain('/pypi/juno-kanban/json');

    const uvLog = await fs.readFile(uvLogPath, 'utf-8');
    expect(uvLog).toContain('pip install --upgrade juno-kanban --quiet');
  });

  it('activates .venv_juno before requirement checks so periodic updates still run', async () => {
    await writePythonStub(true);

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

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: homeDir,
      UV_LOG_FILE: uvLogPath,
      CURL_LOG_FILE: curlLogPath,
      VERSION_CHECK_INTERVAL_HOURS: '24',
      VIRTUAL_ENV: '',
      CONDA_DEFAULT_ENV: '',
    };

    const result = spawnSync('bash', [scriptPath, '--force-update'], {
      cwd: tempDir,
      env,
      encoding: 'utf-8',
    });

    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.status).toBe(0);
    expect(combinedOutput).toContain(
      'Detected project virtual environment at .venv_juno; activating for dependency checks',
    );
    expect(combinedOutput).toContain('Performing periodic version check...');
    expect(combinedOutput).toContain('Upgrading packages: juno-kanban');

    const uvLog = await fs.readFile(uvLogPath, 'utf-8');
    expect(uvLog).toContain('pip install --upgrade juno-kanban --quiet');
  });
});
