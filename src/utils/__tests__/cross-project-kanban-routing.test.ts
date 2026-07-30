import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const wrapperTemplate = path.resolve(process.cwd(), 'src/templates/scripts/kanban.sh');
const resolverTemplate = path.resolve(process.cwd(), 'src/templates/scripts/controller_resolver.py');
const policyTemplate = path.resolve(process.cwd(), 'src/templates/scripts/juno-toolchain-policy.sh');
const kanbanSource = path.resolve(process.cwd(), '..', 'juno_kanban', 'src');

describe('cross-project Kanban wrapper routing', () => {
  let sandbox = '';

  afterEach(async () => {
    if (sandbox) await fs.remove(sandbox);
  });

  async function installProject(root: string, runtime: string) {
    const scripts = path.join(root, '.juno_task', 'scripts');
    const bin = path.join(root, '.venv_juno', 'bin');
    await fs.ensureDir(scripts);
    await fs.ensureDir(bin);
    await fs.copy(wrapperTemplate, path.join(scripts, 'kanban.sh'));
    await fs.copy(resolverTemplate, path.join(scripts, 'controller_resolver.py'));
    await fs.copy(policyTemplate, path.join(scripts, 'juno-toolchain-policy.sh'));
    await fs.chmod(path.join(scripts, 'kanban.sh'), 0o755);
    await fs.writeFile(
      path.join(bin, 'activate'),
      `export VIRTUAL_ENV=${JSON.stringify(path.join(root, '.venv_juno'))}\nexport PATH=${JSON.stringify(bin)}:$PATH\n`,
    );
    await fs.writeFile(path.join(bin, 'juno-kanban'), runtime);
    await fs.chmod(path.join(bin, 'juno-kanban'), 0o755);
  }

  it('uses the destination wrapper and venv while preserving exact stdin', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-project-kanban-'));
    const source = path.join(sandbox, 'source project');
    const destination = path.join(sandbox, 'destination project');
    const registry = path.join(sandbox, 'projects.json');
    const destinationBody = path.join(destination, 'received-body.bin');

    await installProject(
      source,
      `#!/usr/bin/env bash\nexec env PYTHONPATH=${JSON.stringify(kanbanSource)} python3 -c 'import sys; from kanban.cli import main; sys.exit(main())' "$@"\n`,
    );
    await installProject(
      destination,
      `#!/usr/bin/env bash
if [[ "${'$'}{1:-}" == "--version" ]]; then echo "task 2.0.5"; exit 0; fi
cat > ${JSON.stringify(destinationBody)}
printf 'destination=%s|root=%s|args=%s\n' "${'$'}VIRTUAL_ENV" "${'$'}JUNO_TASK_ROOT" "${'$'}*"
`,
    );
    await fs.writeJson(path.join(source, '.juno_task', 'config.json'), {
      kanbanRegistry: { enabled: true, allowedProjects: ['destination'] },
    });
    await fs.writeJson(path.join(destination, '.juno_task', 'config.json'), {});

    const baseEnv = {
      ...process.env,
      JUNO_CONTROLLER_BRANCH: '',
      JUNO_WORKSPACE_ENFORCEMENT: 'off',
      JUNO_WORKSPACE_ROLE: '',
      JUNO_TASK_ROOT: '',
      VIRTUAL_ENV: '',
      JUNO_KANBAN_REGISTRY_PATH: registry,
    };
    const sourceWrapper = path.join(source, '.juno_task', 'scripts', 'kanban.sh');
    const register = spawnSync(
      sourceWrapper,
      ['project', 'add', 'destination', '--path', destination],
      { cwd: source, encoding: 'utf8', env: baseEnv },
    );
    expect(register.status, register.stderr).toBe(0);
    expect(JSON.parse(register.stdout).alias).toBe('destination');

    const payload = 'line one\n$VARIABLE and `ticks`\nline three\n';
    const routed = spawnSync(
      sourceWrapper,
      ['create', '--body-file', '-', '--project', 'destination'],
      { cwd: source, encoding: 'utf8', input: payload, env: baseEnv },
    );
    expect(routed.status, routed.stderr).toBe(0);
    expect(routed.stdout.trim()).toBe(
      `destination=${path.join(destination, '.venv_juno')}|root=${fs.realpathSync(destination)}|args=create --body-file -`,
    );
    expect(await fs.readFile(destinationBody, 'utf8')).toBe(payload);
    expect(await fs.pathExists(path.join(source, 'received-body.bin'))).toBe(false);
  });
});
