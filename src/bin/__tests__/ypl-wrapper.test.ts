import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');
const PACKAGE_LOCK_JSON = path.join(PROJECT_ROOT, 'package-lock.json');
const YPL_SOURCE = path.join(PROJECT_ROOT, 'src/bin/ypl.sh');
const JUNO_CODE_SOURCE = path.join(PROJECT_ROOT, 'src/bin/juno-code.sh');
const BUILT_YPL = path.join(PROJECT_ROOT, 'dist/bin/ypl.sh');
const BUILT_PI_EXTENSION = path.join(
  PROJECT_ROOT,
  'dist/templates/extensions/pi/juno-skill-preprocessor.ts',
);
const BUILT_RALPH_SKILL = path.join(PROJECT_ROOT, 'dist/templates/skills/pi/ralph-loop/SKILL.md');

describe('ypl wrapper', () => {
  it('is exposed as an npm binary beside yy', async () => {
    const pkg = await fs.readJson(PACKAGE_JSON);

    const lock = await fs.readJson(PACKAGE_LOCK_JSON);

    expect(pkg.bin.yy).toBe('./dist/bin/juno-code.sh');
    expect(pkg.bin.ypl).toBe('./dist/bin/ypl.sh');
    expect(lock.packages[''].bin.ypl).toBe('dist/bin/ypl.sh');
    expect(pkg.scripts['build:copy-wrapper']).toContain('src/bin/ypl.sh');
    expect(pkg.scripts['build:copy-wrapper']).toContain('dist/bin/ypl.sh');
  });

  it('keeps --version read-only by bypassing project bootstrap', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-version-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      const scriptsDir = path.join(tempDir, '.juno_task', 'scripts');
      const bootstrapMarker = path.join(tempDir, 'bootstrap-ran');
      await fs.ensureDir(binDir);
      await fs.ensureDir(scriptsDir);
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'juno-code.sh'));
      await fs.chmod(path.join(binDir, 'juno-code.sh'), 0o755);
      await fs.writeFile(
        path.join(binDir, 'cli.mjs'),
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
        'utf8',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'bootstrap.sh'),
        `#!/usr/bin/env bash\ntouch "${bootstrapMarker}"\nexit 91\n`,
        { mode: 0o755 },
      );

      const result = await execa(path.join(binDir, 'juno-code.sh'), ['--version'], {
        cwd: tempDir,
        reject: false,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['--version']);
      expect(await fs.pathExists(bootstrapMarker)).toBe(false);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it.each([['kanban', 'list'], ['task', 'status', 'T1'], ['merge', 'status'], ['integration', 'status'], ['info'], ['where', 'controller'], ['doctor', 'workspace']])(
    'classifies %s before checkout bootstrap',
    async (...args) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-control-wrapper-'));
      try {
        const binDir = path.join(tempDir, 'bin');
        const scriptsDir = path.join(tempDir, '.juno_task', 'scripts');
        const marker = path.join(tempDir, 'bootstrap-ran');
        await fs.ensureDir(binDir);
        await fs.ensureDir(scriptsDir);
        await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'juno-code.sh'));
        await fs.chmod(path.join(binDir, 'juno-code.sh'), 0o755);
        await fs.writeFile(path.join(binDir, 'cli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n');
        await fs.writeFile(path.join(scriptsDir, 'bootstrap.sh'), `#!/usr/bin/env bash\ntouch "${marker}"\nexit 91\n`);
        const result = await execa(path.join(binDir, 'juno-code.sh'), args, { cwd: tempDir, reject: false });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(args);
        expect(await fs.pathExists(marker)).toBe(false);
      } finally {
        await fs.remove(tempDir);
      }
    },
  );

  it.each([
    ['--quiet', 'kanban', 'list'],
    ['--config', 'controller.json', '--no-color', 'task', 'status', 'T1'],
    ['-v', '0', 'merge', 'status'],
  ])('classifies a control command after leading global options: %s', async (...args) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-leading-option-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      const scriptsDir = path.join(tempDir, '.juno_task', 'scripts');
      const marker = path.join(tempDir, 'bootstrap-ran');
      await fs.ensureDir(binDir);
      await fs.ensureDir(scriptsDir);
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'juno-code.sh'));
      await fs.chmod(path.join(binDir, 'juno-code.sh'), 0o755);
      await fs.writeFile(path.join(binDir, 'cli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n');
      await fs.writeFile(path.join(scriptsDir, 'bootstrap.sh'), `#!/usr/bin/env bash\ntouch "${marker}"\nexit 91\n`);
      const result = await execa(path.join(binDir, 'juno-code.sh'), args, { cwd: tempDir, reject: false });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
      expect(await fs.pathExists(marker)).toBe(false);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it.each([
    ['please', 'list', 'tasks'],
    ['debug', 'status', 'endpoint'],
    ['explain', 'sync', 'behavior'],
    ['future-command', 'status'],
  ])('preserves unknown-leading free-form prompt input before bootstrap: %s', async (...args) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-free-prompt-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      await fs.ensureDir(binDir);
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'yy'));
      await fs.chmod(path.join(binDir, 'yy'), 0o755);
      await fs.writeFile(
        path.join(binDir, 'cli.mjs'),
        `// JUNO_CODE_PREFLIGHT_ONLY\nif (process.env.JUNO_CODE_PREFLIGHT_ONLY !== '1') console.log(JSON.stringify(process.argv.slice(2)));\n`,
      );

      const result = await execa(path.join(binDir, 'yy'), args, { cwd: tempDir, reject: false });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it('keeps pi on the normal product bootstrap path and cwd', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-pi-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      const scriptsDir = path.join(tempDir, '.juno_task', 'scripts');
      await fs.ensureDir(binDir);
      await fs.ensureDir(scriptsDir);
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'yy'));
      await fs.chmod(path.join(binDir, 'yy'), 0o755);
      await fs.writeFile(path.join(binDir, 'cli.mjs'), 'unused\n');
      await fs.writeFile(
        path.join(scriptsDir, 'bootstrap.sh'),
        '#!/usr/bin/env bash\nprintf "cwd=%s\\n" "$PWD"\nprintf "arg=%s\\n" "$@"\n',
      );
      const result = await execa(path.join(binDir, 'yy'), ['pi', '--cwd', tempDir, 'prompt'], {
        cwd: tempDir, reject: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`cwd=${await fs.realpath(tempDir)}`);
      expect(result.stdout).toContain('arg=pi');
      expect(result.stdout).toContain(`arg=${tempDir}`);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it('routes a registered integration control command to the pinned controller runtime', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-routed-wrapper-'));
    try {
      const controller = path.join(tempDir, 'controller');
      const integration = path.join(tempDir, 'integration');
      const launcherBin = path.join(tempDir, 'launcher-bin');
      const packagedScripts = path.join(tempDir, 'templates', 'scripts');
      const untrustedResolverMarker = path.join(tempDir, 'untrusted-resolver-ran');
      await fs.ensureDir(path.join(controller, '.juno_task', 'scripts'));
      await fs.ensureDir(path.join(controller, 'nested', 'directory'));
      await fs.writeFile(path.join(controller, 'nested', 'directory', '.keep'), '');
      await fs.copy(
        path.join(PROJECT_ROOT, 'src/templates/scripts/controller_resolver.py'),
        path.join(controller, '.juno_task', 'scripts', 'controller_resolver.py'),
      );
      await execa('git', ['init', '-b', 'controller'], { cwd: controller });
      await execa('git', ['config', 'user.email', 'test@example.invalid'], { cwd: controller });
      await execa('git', ['config', 'user.name', 'Test'], { cwd: controller });
      await execa('git', ['add', '.'], { cwd: controller });
      await execa('git', ['commit', '-m', 'fixture'], { cwd: controller });
      await execa('git', ['worktree', 'add', '-b', 'product', integration], { cwd: controller });
      await execa('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: integration });
      await execa('git', ['config', 'juno.controller.path', controller], { cwd: integration });
      await execa('git', ['config', 'juno.controller.branch', 'refs/heads/controller'], { cwd: integration });
      await execa('git', ['config', '--worktree', 'juno.workspace.role', 'integration-owner'], { cwd: integration });
      await execa('git', ['config', '--worktree', 'juno.workspace.roleAuthority', 'protected-integration.v1'], { cwd: integration });
      const runtime = path.join(controller, 'controller-runtime.mjs');
      await fs.writeFile(runtime, `console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:{invocation:process.env.JUNO_CONTROL_INVOCATION_ROOT,role:process.env.JUNO_CONTROL_INVOCATION_ROLE,effective:process.env.JUNO_CONTROL_EFFECTIVE_ROOT,asserted:process.env.JUNO_WORKSPACE_ROLE,enforcement:process.env.JUNO_WORKSPACE_ENFORCEMENT}}))\n`);
      await execa('git', ['config', '--worktree', 'juno.controller.runtimeExecutable', runtime], { cwd: controller });
      await fs.ensureDir(launcherBin);
      await fs.ensureDir(packagedScripts);
      await fs.copy(
        path.join(PROJECT_ROOT, 'src/templates/scripts/controller_resolver.py'),
        path.join(packagedScripts, 'controller_resolver.py'),
      );
      await fs.copy(JUNO_CODE_SOURCE, path.join(launcherBin, 'yy'));
      await fs.writeFile(path.join(launcherBin, 'cli.mjs'), 'process.exit(98)\n');
      await fs.chmod(path.join(launcherBin, 'yy'), 0o755);
      await fs.writeFile(
        path.join(integration, '.juno_task', 'scripts', 'controller_resolver.py'),
        `#!/usr/bin/env python3\nfrom pathlib import Path\nPath(${JSON.stringify(untrustedResolverMarker)}).write_text('ran')\nraise SystemExit(97)\n`,
      );
      const before = await execa('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: integration });

      const result = await execa(path.join(launcherBin, 'yy'), ['merge', 'status'], {
        cwd: path.join(integration, 'nested', 'directory'),
        reject: false,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        args: ['merge', 'status'], cwd: await fs.realpath(controller),
        env: { invocation: await fs.realpath(integration), role: 'integration-owner',
          effective: await fs.realpath(controller), asserted: 'controller', enforcement: 'strict' },
      });
      expect(await fs.pathExists(path.join(integration, '.venv_juno'))).toBe(false);
      expect(await fs.pathExists(untrustedResolverMarker)).toBe(false);
      const after = await execa('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: integration });
      expect(after.stdout).toBe(before.stdout);

      await execa('git', ['config', '--local', '--unset-all', 'juno.controller.path'], { cwd: integration });
      await execa('git', ['config', '--local', '--unset-all', 'juno.controller.branch'], { cwd: integration });
      const missingRegistration = await execa(path.join(launcherBin, 'yy'), ['merge', 'status'], {
        cwd: path.join(integration, 'nested', 'directory'), reject: false,
      });
      expect(missingRegistration.exitCode).toBe(2);
      expect(missingRegistration.stdout).toBe('');
      expect(missingRegistration.stderr.trim()).toBe(
        'controller-resolver: linked product workspace requires exactly one non-empty controller path and branch registration',
      );
      expect(await fs.pathExists(path.join(integration, '.venv_juno'))).toBe(false);
      expect(await fs.pathExists(untrustedResolverMarker)).toBe(false);
      expect((await execa('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: integration })).stdout).toBe(before.stdout);
      await execa('git', ['config', '--local', 'juno.controller.path', controller], { cwd: integration });
      await execa('git', ['config', '--local', 'juno.controller.branch', 'refs/heads/controller'], { cwd: integration });

      const leadingOption = await execa(path.join(launcherBin, 'yy'), ['--quiet', 'kanban', 'list'], {
        cwd: path.join(integration, 'nested', 'directory'), reject: false,
      });
      expect(leadingOption.exitCode).toBe(0);
      expect(JSON.parse(leadingOption.stdout).args).toEqual(['--quiet', 'kanban', 'list']);
      expect((await execa('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: integration })).stdout).toBe(before.stdout);

      await execa('git', ['config', '--local', '--add', 'juno.controller.path', controller], { cwd: integration });
      const ambiguous = await execa(path.join(launcherBin, 'yy'), ['merge', 'status'], {
        cwd: path.join(integration, 'nested'), reject: false,
      });
      expect(ambiguous.exitCode).toBe(2);
      expect(ambiguous.stdout).toBe('');
      expect(ambiguous.stderr).toContain('controller registration is ambiguous: juno.controller.path has multiple values');
      expect(await fs.pathExists(path.join(integration, '.venv_juno'))).toBe(false);
      await execa('git', ['config', '--local', '--unset-all', 'juno.controller.path'], { cwd: integration });
      await execa('git', ['config', '--local', 'juno.controller.path', controller], { cwd: integration });

      const localController = await execa(path.join(launcherBin, 'yy'), ['merge', 'status'], {
        cwd: controller, reject: false,
      });
      expect(localController.exitCode).toBe(98);
      expect(localController.stdout).toBe('');

      await execa('git', ['config', '--worktree', 'juno.controller.runtimeExecutable', path.join(controller, 'missing-runtime.mjs')], { cwd: controller });
      const invalidRuntime = await execa(path.join(launcherBin, 'yy'), ['merge', 'status'], {
        cwd: path.join(integration, 'nested'), reject: false,
      });
      expect(invalidRuntime.exitCode).toBe(2);
      expect(invalidRuntime.stderr).toContain('registered controller runtime is missing or stale');
      await execa('git', ['config', '--worktree', 'juno.controller.runtimeExecutable', runtime], { cwd: controller });

      const staleRuntimeMarker = path.join(tempDir, 'stale-runtime-ran');
      await fs.writeFile(
        path.join(launcherBin, 'cli.mjs'),
        `// JUNO_CODE_PREFLIGHT_ONLY\nif (process.argv.includes('--version')) console.log('2.1.2');\n`,
      );
      await fs.writeFile(
        runtime,
        `if (process.argv.includes('--version')) console.log('2.1.1'); else require('node:fs').writeFileSync(${JSON.stringify(staleRuntimeMarker)}, 'ran');\n`,
      );
      const staleRuntime = await execa(path.join(launcherBin, 'yy'), ['integration', 'sync'], {
        cwd: path.join(integration, 'nested'), reject: false,
      });
      expect(staleRuntime.exitCode).toBe(2);
      expect(staleRuntime.stderr).toContain('selected controller runtime cannot be proven to support this explicit command');
      expect(staleRuntime.stderr).toContain(`launcher executable: ${path.join(launcherBin, 'cli.mjs')}`);
      expect(staleRuntime.stderr).toContain('launcher version: 2.1.2');
      expect(staleRuntime.stderr).toContain(`effective executable: ${runtime}`);
      expect(staleRuntime.stderr).toContain('effective version: 2.1.1');
      expect(await fs.pathExists(staleRuntimeMarker)).toBe(false);

      await execa('git', ['config', '--worktree', '--unset-all', 'juno.workspace.role'], { cwd: integration });
      const invalidRole = await execa(path.join(launcherBin, 'yy'), ['task', 'status', 'T1'], {
        cwd: path.join(integration, 'nested'), reject: false,
      });
      expect(invalidRole.exitCode).toBe(2);
      expect(invalidRole.stderr).toContain('no persisted workspace role registration');
      expect(await fs.pathExists(path.join(integration, '.venv_juno'))).toBe(false);
    } finally {
      await fs.remove(tempDir);
    }
  }, 30_000);

  it.each(['start', 'status', 'finish'] as const)(
    'fails task %s closed in an exact task worktree before a stale registered runtime executes',
    async (operation) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `juno-stale-task-${operation}-`));
      try {
        const controller = path.join(tempDir, 'controller');
        const task = path.join(tempDir, 'task');
        const launcherBin = path.join(tempDir, 'launcher-bin');
        const packagedScripts = path.join(tempDir, 'templates', 'scripts');
        const staleRuntimeMarker = path.join(tempDir, 'stale-runtime-ran');
        await fs.ensureDir(path.join(controller, '.juno_task', 'scripts'));
        await fs.copy(
          path.join(PROJECT_ROOT, 'src/templates/scripts/controller_resolver.py'),
          path.join(controller, '.juno_task/scripts/controller_resolver.py'),
        );
        await execa('git', ['init', '-b', 'controller'], { cwd: controller });
        await execa('git', ['config', 'user.email', 'test@example.invalid'], { cwd: controller });
        await execa('git', ['config', 'user.name', 'Test'], { cwd: controller });
        await fs.writeFile(path.join(controller, 'fixture'), 'fixture\n');
        await execa('git', ['add', '.'], { cwd: controller });
        await execa('git', ['commit', '-m', 'fixture'], { cwd: controller });
        await execa('git', ['worktree', 'add', '-b', 'juno/task-T1', task], { cwd: controller });
        await execa('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: task });
        await execa('git', ['config', 'juno.controller.path', controller], { cwd: task });
        await execa('git', ['config', 'juno.controller.branch', 'refs/heads/controller'], { cwd: task });
        await execa('git', ['config', '--worktree', 'juno.workspace.role', 'task'], { cwd: task });
        await execa('git', ['config', '--worktree', 'juno.workspace.taskId', 'T1'], { cwd: task });
        for (const key of ['manifestIdentity', 'createReceiptSha256', 'expectedPathsSha256']) {
          await execa('git', ['config', '--worktree', `juno.workspace.${key}`, 'a'.repeat(64)], { cwd: task });
        }

        const runtime = path.join(controller, 'controller-runtime.mjs');
        await fs.writeFile(runtime, [
          "import { writeFileSync } from 'node:fs';",
          `if (process.argv.includes('--version')) console.log('2.1.1');`,
          `else writeFileSync(${JSON.stringify(staleRuntimeMarker)}, 'ran');`,
        ].join('\n'));
        await execa('git', ['config', '--worktree', 'juno.controller.runtimeExecutable', runtime], {
          cwd: controller,
        });
        await fs.ensureDir(launcherBin);
        await fs.ensureDir(packagedScripts);
        await fs.copy(
          path.join(PROJECT_ROOT, 'src/templates/scripts/controller_resolver.py'),
          path.join(packagedScripts, 'controller_resolver.py'),
        );
        const launcher = path.join(launcherBin, 'yy');
        const launcherCli = path.join(launcherBin, 'cli.mjs');
        await fs.copy(JUNO_CODE_SOURCE, launcher);
        await fs.chmod(launcher, 0o755);
        await fs.writeFile(
          launcherCli,
          `// JUNO_CODE_PREFLIGHT_ONLY\nif (process.argv.includes('--version')) console.log('2.1.2');\n`,
        );

        const result = await execa(launcher, ['task', operation, 'T1'], {
          cwd: task, reject: false,
        });
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('selected controller runtime cannot be proven');
        expect(result.stderr).toContain(`launcher executable: ${launcherCli}`);
        expect(result.stderr).toContain('launcher version: 2.1.2');
        expect(result.stderr).toContain(`effective executable: ${runtime}`);
        expect(result.stderr).toContain('effective version: 2.1.1');
        expect(await fs.pathExists(staleRuntimeMarker)).toBe(false);
      } finally {
        await fs.remove(tempDir);
      }
    },
    30_000,
  );

  it.each([
    { args: ['kanban', 'list'], operation: 'kanban' },
    { args: ['task', 'status', 'T1'], operation: 'kanban' },
    { args: ['merge', 'status'], operation: 'kanban' },
    { args: ['task', 'start', 'T1'], operation: 'orchestration' },
    { args: ['task', 'finish', 'T1'], operation: 'orchestration' },
    { args: ['merge', 'next'], operation: 'orchestration' },
    { args: ['merge', 'resolve', 'T1'], operation: 'orchestration' },
    { args: ['merge', 'review', 'T1'], operation: 'orchestration' },
    { args: ['merge', 'reopen', 'T1'], operation: 'orchestration' },
    { args: ['integration', 'status'], operation: 'kanban' },
    { args: ['integration', 'sync'], operation: 'orchestration' },
    { args: ['integration', 'runtime-doctor'], operation: 'orchestration' },
    { args: ['integration', 'runtime-refresh', '--previous-sha', 'a'.repeat(40)], operation: 'orchestration' },
    { args: ['integration', 'register', '/owner'], operation: 'orchestration' },
    { args: ['integration', 'repair', '--dry-run'], operation: 'orchestration' },
    { args: ['integration', 'push', '--dry-run'], operation: 'orchestration' },
    { args: ['integration', 'mystery'], operation: null },
    { args: ['merge', 'mystery'], operation: null },
  ])('authorizes $operation before dispatching controller runtime bytes', async ({ args, operation }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-wrapper-operation-gate-'));
    try {
      const controller = path.join(tempDir, 'controller');
      const integration = path.join(tempDir, 'integration');
      const launcherBin = path.join(tempDir, 'launcher-bin');
      const packagedScripts = path.join(tempDir, 'templates', 'scripts');
      const operationMarker = path.join(tempDir, 'resolver-operation');
      const runtimeMarker = path.join(tempDir, 'runtime-ran');
      await fs.ensureDir(controller);
      await fs.ensureDir(integration);
      await fs.ensureDir(launcherBin);
      await fs.ensureDir(packagedScripts);
      await execa('git', ['init', '-b', 'controller'], { cwd: controller });
      const runtime = path.join(controller, 'controller-runtime.mjs');
      await fs.writeFile(runtime, `require('node:fs').writeFileSync(${JSON.stringify(runtimeMarker)}, 'ran')\n`);
      await execa('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: controller });
      await execa('git', ['config', '--worktree', 'juno.controller.runtimeExecutable', runtime], { cwd: controller });
      await fs.writeFile(
        path.join(packagedScripts, 'controller_resolver.py'),
        [
          'import json, pathlib, sys',
          `marker = pathlib.Path(${JSON.stringify(operationMarker)})`,
          "operation = sys.argv[sys.argv.index('--operation') + 1]",
          'marker.write_text(operation)',
          "if operation != 'diagnostic':",
          "    print('operation-specific controller policy refused dirty state', file=sys.stderr)",
          '    raise SystemExit(77)',
          `print(json.dumps({'path': ${JSON.stringify(controller)}, 'current_root': ${JSON.stringify(integration)}, 'role': 'integration-owner', 'expected_branch': 'refs/heads/controller', 'source': 'registration'}))`,
        ].join('\n'),
      );
      await fs.copy(JUNO_CODE_SOURCE, path.join(launcherBin, 'yy'));
      await fs.writeFile(path.join(launcherBin, 'cli.mjs'), 'process.exit(98)\n');
      await fs.chmod(path.join(launcherBin, 'yy'), 0o755);

      const result = await execa(path.join(launcherBin, 'yy'), args, { cwd: integration, reject: false });

      expect(result.exitCode).toBe(2);
      if (operation === null) {
        expect(await fs.pathExists(operationMarker)).toBe(false);
        expect(result.stderr).toContain(
          `control-plane routing refused unknown ${args[0]} subcommand 'mystery'`,
        );
      } else {
        expect(await fs.readFile(operationMarker, 'utf8')).toBe(operation);
        expect(result.stderr).toContain('operation-specific controller policy refused dirty state');
      }
      expect(await fs.pathExists(runtimeMarker)).toBe(false);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it('forwards the effective task policy to the pinned controller runtime', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-wrapper-forwarded-policy-'));
    try {
      const controller = path.join(tempDir, 'controller');
      const integration = path.join(tempDir, 'integration');
      const launcherBin = path.join(tempDir, 'launcher-bin');
      const packagedScripts = path.join(tempDir, 'templates', 'scripts');
      const runtimeMarker = path.join(tempDir, 'runtime-policy');
      await fs.ensureDir(controller);
      await fs.ensureDir(integration);
      await fs.ensureDir(launcherBin);
      await fs.ensureDir(packagedScripts);
      await execa('git', ['init', '-b', 'controller'], { cwd: controller });
      const runtime = path.join(controller, 'controller-runtime.mjs');
      await fs.writeFile(
        runtime,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(runtimeMarker)}, process.env.JUNO_CONTROL_OPERATION || '')\n`,
      );
      await execa('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: controller });
      await execa('git', ['config', '--worktree', 'juno.controller.runtimeExecutable', runtime], {
        cwd: controller,
      });
      await fs.writeFile(
        path.join(packagedScripts, 'controller_resolver.py'),
        [
          'import json',
          `print(json.dumps({'path': ${JSON.stringify(controller)}, 'current_root': ${JSON.stringify(integration)}, 'role': 'integration-owner', 'expected_branch': 'refs/heads/controller', 'source': 'registration'}))`,
        ].join('\n'),
      );
      await fs.copy(JUNO_CODE_SOURCE, path.join(launcherBin, 'yy'));
      await fs.writeFile(path.join(launcherBin, 'cli.mjs'), 'process.exit(98)\n');
      await fs.chmod(path.join(launcherBin, 'yy'), 0o755);

      const result = await execa(path.join(launcherBin, 'yy'), ['task', 'finish', 'T1'], {
        cwd: integration,
        reject: false,
      });
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile(runtimeMarker, 'utf8')).toBe('orchestration');
    } finally {
      await fs.remove(tempDir);
    }
  });

  it('keeps fake-node wrapper assertions compatible with the runtime version probe', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-compatible-node-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      const fakeBin = path.join(tempDir, 'fake-bin');
      await fs.ensureDir(binDir);
      await fs.ensureDir(fakeBin);
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'juno-code.sh'));
      await fs.chmod(path.join(binDir, 'juno-code.sh'), 0o755);
      await fs.writeFile(path.join(binDir, 'cli.mjs'), 'unused\n');
      await fs.writeFile(
        path.join(fakeBin, 'node'),
        '#!/usr/bin/env bash\nif [ "$1" = "-p" ] && [ "$2" = "process.versions.node" ]; then echo 22.22.0; exit 0; fi\n[ "$JUNO_CODE_NODE_EXECUTABLE" = "$0" ] || exit 88\n[ "${PATH%%:*}" = "$(dirname "$0")" ] || exit 89\nprintf "%s\\n" "$@"\n',
        { mode: 0o755 },
      );
      const result = await execa(path.join(binDir, 'juno-code.sh'), ['--version'], {
        cwd: tempDir, env: { PATH: `${fakeBin}:${process.env.PATH}` }, reject: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.split('\n')).toEqual([path.join(binDir, 'cli.mjs'), '--version']);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it('refuses modern distribution code under an unsupported ambient Node', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-node-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      const fakeBin = path.join(tempDir, 'fake-bin');
      const marker = path.join(tempDir, 'cli-ran');
      await fs.ensureDir(binDir);
      await fs.ensureDir(fakeBin);
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'juno-code.sh'));
      await fs.chmod(path.join(binDir, 'juno-code.sh'), 0o755);
      await fs.writeFile(path.join(binDir, 'cli.mjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`);
      await fs.writeFile(path.join(fakeBin, 'node'), '#!/usr/bin/env bash\nif [ "$1" = "-p" ]; then echo 18.19.0; else exit 97; fi\n', { mode: 0o755 });
      const result = await execa(path.join(binDir, 'juno-code.sh'), ['--version'], {
        cwd: tempDir,
        env: { PATH: `${fakeBin}:${process.env.PATH}`, NVM_DIR: path.join(tempDir, 'missing-nvm') },
        reject: false,
      });
      expect(result.exitCode).toBe(69);
      expect(result.stderr).toContain('unsupported Node 18.19.0');
      expect(await fs.pathExists(marker)).toBe(false);
    } finally {
      await fs.remove(tempDir);
    }
  });

  it('selects the highest compatible installed NVM Node when ambient Node is stale', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-stale-nvm-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      const fakeBin = path.join(tempDir, 'fake-bin');
      const nvmDir = path.join(tempDir, 'nvm');
      const selectedMarker = path.join(tempDir, 'selected-node');
      await fs.ensureDir(binDir);
      await fs.ensureDir(fakeBin);
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'juno-code.sh'));
      await fs.chmod(path.join(binDir, 'juno-code.sh'), 0o755);
      await fs.writeFile(path.join(binDir, 'cli.mjs'), "console.log('selected-compatible-node')\n");
      await fs.writeFile(
        path.join(fakeBin, 'node'),
        '#!/usr/bin/env bash\nif [ "$1" = "-p" ]; then echo 18.19.0; else exit 97; fi\n',
        { mode: 0o755 },
      );
      for (const version of ['20.10.0', '22.22.3']) {
        const candidate = path.join(nvmDir, 'versions', 'node', `v${version}`, 'bin', 'node');
        await fs.ensureDir(path.dirname(candidate));
        await fs.writeFile(
          candidate,
          `#!/usr/bin/env bash\nif [ "$1" = "-p" ]; then echo ${version}; exit 0; fi\nprintf '%s' ${JSON.stringify(version)} > ${JSON.stringify(selectedMarker)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
          { mode: 0o755 },
        );
      }

      const result = await execa(path.join(binDir, 'juno-code.sh'), ['--version'], {
        cwd: tempDir,
        env: { PATH: `${fakeBin}:${process.env.PATH}`, NVM_DIR: nvmDir },
        reject: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('selected-compatible-node');
      expect(await fs.readFile(selectedMarker, 'utf8')).toBe('22.22.3');
    } finally {
      await fs.remove(tempDir);
    }
  });

  it('passes a real multiline heredoc through built ypl, CLI rewriting, and the installed Pi preprocessor', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-built-ypl-skill-'));
    try {
      const homeDir = path.join(tempDir, 'home');
      const projectDir = path.join(tempDir, 'project');
      const builtPackageRoot = path.join(tempDir, 'built-package');
      const builtPackageDir = path.join(builtPackageRoot, 'dist');
      const fixtureYpl = path.join(builtPackageDir, 'bin/ypl.sh');
      const fixturePiExtension = path.join(
        builtPackageDir,
        'templates/extensions/pi/juno-skill-preprocessor.ts',
      );
      const fixtureRalphSkill = path.join(
        builtPackageDir,
        'templates/skills/pi/ralph-loop/SKILL.md',
      );
      const fakeBin = path.join(tempDir, 'fake-bin');
      const servicesDir = path.join(homeDir, '.juno_code', 'services');
      const installedExtension = path.join(projectDir, '.pi/extensions/juno-skill-preprocessor.ts');
      const compiledExtension = path.join(projectDir, '.pi/extensions/juno-skill-preprocessor.mjs');
      const installedSkill = path.join(projectDir, '.pi/skills/ralph-loop/SKILL.md');
      const harnessPath = path.join(tempDir, 'invoke-installed-preprocessor.mjs');
      const observedPromptPath = path.join(tempDir, 'prompt-before-preprocessor.txt');
      const kanbanCallsPath = path.join(tempDir, 'kanban-read-calls.txt');
      await Promise.all([
        fs.ensureDir(path.dirname(installedExtension)),
        fs.ensureDir(path.dirname(installedSkill)),
        fs.ensureDir(fakeBin),
        fs.ensureDir(servicesDir),
      ]);
      expect(await fs.pathExists(BUILT_YPL)).toBe(true);
      expect(await fs.pathExists(BUILT_PI_EXTENSION)).toBe(true);
      expect(await fs.pathExists(BUILT_RALPH_SKILL)).toBe(true);
      await fs.copy(path.join(PROJECT_ROOT, 'dist'), builtPackageDir);
      await fs.copy(path.join(PROJECT_ROOT, 'package.json'), path.join(builtPackageRoot, 'package.json'));
      await fs.symlink(path.join(PROJECT_ROOT, 'node_modules'), path.join(builtPackageRoot, 'node_modules'));
      await fs.copy(fixturePiExtension, installedExtension);
      await fs.copy(fixtureRalphSkill, installedSkill);
      await execa(path.join(PROJECT_ROOT, 'node_modules/.bin/esbuild'), [
        installedExtension,
        '--bundle',
        '--platform=node',
        '--format=esm',
        `--outfile=${compiledExtension}`,
      ]);
      await fs.writeFile(
        harnessPath,
        [
          "import { readFileSync } from 'node:fs';",
          "import { pathToFileURL } from 'node:url';",
          'const extension = (await import(pathToFileURL(process.argv[2]).href)).default;',
          "const prompt = readFileSync(0, 'utf8');",
          'let inputHandler;',
          "extension({ on(event, handler) { if (event === 'input') inputHandler = handler; } });",
          "if (!inputHandler) throw new Error('installed Pi extension did not register input');",
          'const result = await inputHandler({ text: prompt });',
          "if (result.action !== 'transform') throw new Error(`unexpected extension action: ${result.action}`);",
          'process.stdout.write(result.text);',
        ].join('\n'),
      );
      await fs.writeFile(
        path.join(builtPackageDir, 'templates/services/pi.py'),
        `#!/usr/bin/env python3
import json, pathlib, subprocess, sys
argv = sys.argv[1:]
prompt = None
if '-p' in argv:
    prompt = argv[argv.index('-p') + 1]
elif '--prompt-file' in argv:
    prompt = pathlib.Path(argv[argv.index('--prompt-file') + 1]).read_text()
if prompt is None:
    raise SystemExit('fixture Pi service received no prompt')
pathlib.Path(${JSON.stringify(observedPromptPath)}).write_text(prompt)
completed = subprocess.run([${JSON.stringify(process.execPath)}, ${JSON.stringify(harnessPath)}, ${JSON.stringify(compiledExtension)}], input=prompt, text=True, capture_output=True, cwd=${JSON.stringify(projectDir)}, check=True)
print(json.dumps({'type': 'result', 'result': completed.stdout, 'content': completed.stdout, 'session_id': 'fixture-no-provider'}))
`,
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(fakeBin, 'juno-kanban'),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(kanbanCallsPath)}
printf 'Task(s) not found: oD5g4o\\n' >&2
exit 1
`,
        { mode: 0o755 },
      );

      const noCodeDirective = `${String.fromCharCode(64, 64)}no_code`;
      const payload = [
        '%ralph-loop ## oD5g4o',
        'What is the root cause of 504',
        noCodeDirective,
      ].join('\n');
      const result = await execa(
        'bash',
        ['-c', '"$1" <<\'JUNO_YPL_PAYLOAD\'\n' + payload + '\nJUNO_YPL_PAYLOAD\n', '_', fixtureYpl],
        {
          cwd: projectDir,
          env: {
            ...process.env,
            HOME: homeDir,
            PATH: `${fakeBin}:${process.env.PATH}`,
            JUNO_CODE_HEADLESS: '1',
            NO_COLOR: '1',
          },
          reject: false,
        },
      );

      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      const rewritten = await fs.readFile(observedPromptPath, 'utf8');
      expect(rewritten).toBe(payload.replace('%ralph-loop', '/skill:ralph-loop'));
      expect(rewritten.split(noCodeDirective)).toHaveLength(2);
      expect(await fs.readFile(kanbanCallsPath, 'utf8')).toContain('get oD5g4o');
      for (const exact of [
        '## oD5g4o',
        'What is the root cause of 504',
        noCodeDirective,
      ]) {
        expect(result.stdout.split(exact)).toHaveLength(2);
      }
      expect(result.stdout).toContain(
        `<skill name="ralph-loop" location="${await fs.realpath(installedSkill)}">`,
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain('fixture-no-provider');
      expect(await fs.pathExists(path.join(projectDir, '.juno_task', 'tasks'))).toBe(false);
    } finally {
      await fs.remove(tempDir);
    }
  }, 30_000);

  it('executes the juno-code wrapper with pi --live before forwarded args', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-ypl-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      await fs.ensureDir(binDir);
      await fs.copy(YPL_SOURCE, path.join(binDir, 'ypl.sh'));
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'juno-code.sh'));
      await fs.chmod(path.join(binDir, 'ypl.sh'), 0o755);
      await fs.chmod(path.join(binDir, 'juno-code.sh'), 0o755);
      await fs.writeFile(
        path.join(binDir, 'cli.mjs'),
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
        'utf8',
      );

      const result = await execa(path.join(binDir, 'ypl.sh'), ['hello world', '--model', 'sonnet'], {
        cwd: tempDir,
        reject: false,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['pi', '--live', 'hello world', '--model', 'sonnet']);
    } finally {
      await fs.remove(tempDir);
    }
  });
});
