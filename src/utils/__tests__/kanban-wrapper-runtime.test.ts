import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const templateWrapper = path.resolve(process.cwd(), 'src/templates/scripts/kanban.sh');
const templateResolver = path.resolve(process.cwd(), 'src/templates/scripts/controller_resolver.py');
const templatePolicy = path.resolve(process.cwd(), 'src/templates/scripts/juno-toolchain-policy.sh');

describe('kanban wrapper runtime selection', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-wrapper-runtime-'));

    const scriptsDir = path.join(projectRoot, '.juno_task', 'scripts');
    const venvBin = path.join(projectRoot, '.venv_juno', 'bin');
    const installedSite = path.join(projectRoot, 'installed-site');
    const localSource = path.join(projectRoot, 'juno_kanban', 'src', 'kanban');

    await Promise.all([
      fs.ensureDir(scriptsDir),
      fs.ensureDir(venvBin),
      fs.ensureDir(path.join(installedSite, 'kanban')),
      fs.ensureDir(localSource),
      fs.ensureDir(path.join(projectRoot, '.juno_task', 'tasks')),
    ]);

    await fs.copy(templateWrapper, path.join(scriptsDir, 'kanban.sh'));
    await fs.copy(templateResolver, path.join(scriptsDir, 'controller_resolver.py'));
    await fs.copy(templatePolicy, path.join(scriptsDir, 'juno-toolchain-policy.sh'));
    await fs.chmod(path.join(scriptsDir, 'kanban.sh'), 0o755);
    await fs.writeJson(path.join(projectRoot, '.juno_task', 'tasks', 'config.json'), {
      storage: 'legacy-ndjson',
    });
    await fs.writeFile(path.join(projectRoot, '.juno_task', 'tasks', 'backlog.ndjson'), '');

    await fs.writeFile(path.join(installedSite, 'kanban', '__init__.py'), "RUNTIME = 'installed-controller-v2'\n");
    await fs.writeFile(path.join(localSource, '__init__.py'), "RUNTIME = 'local-v2'\n");
    await fs.writeFile(
      path.join(venvBin, 'activate'),
      `export VIRTUAL_ENV=${JSON.stringify(path.join(projectRoot, '.venv_juno'))}\nexport PATH=${JSON.stringify(venvBin)}:$PATH\n`,
    );
    await fs.writeFile(
      path.join(venvBin, 'juno-kanban'),
      `#!/usr/bin/env bash
if [[ "${'$'}{1:-}" == "--version" ]]; then
  if IFS= read -r unexpected; then echo "version probe consumed stdin: ${'$'}unexpected" >&2; exit 2; fi
  echo "task 2.0.0"
  exit 0
fi
if [[ "${'$'}{1:-}" == "create" ]]; then
  body=${'$'}(cat)
  printf 'created:%s\\n' "${'$'}body"
  exit 0
fi
if [[ ${'$'}# -eq 0 ]]; then
  body=${'$'}(cat)
  printf 'implicit-created:%s\\n' "${'$'}body"
  exit 0
fi
python3 -c 'import os, kanban; print(f"{kanban.RUNTIME}|{os.environ[\"JUNO_TASK_ROOT\"]}")'
`,
    );
    await fs.chmod(path.join(venvBin, 'juno-kanban'), 0o755);
  });

  afterEach(async () => {
    await fs.remove(projectRoot);
  });

  it('closes stdin for the identity probe without consuming a heredoc create body', () => {
    const result = spawnSync(path.join(projectRoot, '.juno_task', 'scripts', 'kanban.sh'), ['create'], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: 'heredoc regression body\n',
      env: {
        ...process.env,
        JUNO_TASK_ROOT: '',
        VIRTUAL_ENV: '',
        PYTHONPATH: path.join(projectRoot, 'installed-site'),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('created:heredoc regression body');
    expect(result.stderr).not.toContain('version probe consumed stdin');
  });

  it('forwards commandless heredoc input for the implicit create shortcut', () => {
    const result = spawnSync(path.join(projectRoot, '.juno_task', 'scripts', 'kanban.sh'), [], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: 'commandless heredoc body\n',
      env: {
        ...process.env,
        JUNO_TASK_ROOT: '',
        VIRTUAL_ENV: '',
        PYTHONPATH: path.join(projectRoot, 'installed-site'),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('implicit-created:commandless heredoc body');
    expect(result.stderr).not.toContain('version probe consumed stdin');
  });

  it('uses the compatible controller executable even when a neighboring source tree is present', () => {
    const result = spawnSync(path.join(projectRoot, '.juno_task', 'scripts', 'kanban.sh'), ['list'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        JUNO_TASK_ROOT: '',
        VIRTUAL_ENV: '',
        PYTHONPATH: path.join(projectRoot, 'installed-site'),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`installed-controller-v2|${fs.realpathSync(projectRoot)}`);
  });
});
