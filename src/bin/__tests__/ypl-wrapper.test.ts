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

  it.each([['kanban', 'list'], ['task', 'status', 'T1'], ['merge', 'status'], ['info'], ['where', 'controller'], ['doctor', 'workspace']])(
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
      await fs.copy(JUNO_CODE_SOURCE, path.join(launcherBin, 'yy'));
      await fs.writeFile(path.join(launcherBin, 'cli.mjs'), 'process.exit(98)\n');
      await fs.chmod(path.join(launcherBin, 'yy'), 0o755);
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
      const after = await execa('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: integration });
      expect(after.stdout).toBe(before.stdout);

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
        '#!/usr/bin/env bash\nif [ "$1" = "-p" ] && [ "$2" = "process.versions.node" ]; then echo 22.22.0; exit 0; fi\nprintf "%s\\n" "$@"\n',
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
        env: { PATH: `${fakeBin}:${process.env.PATH}` },
        reject: false,
      });
      expect(result.exitCode).toBe(69);
      expect(result.stderr).toContain('unsupported Node 18.19.0');
      expect(await fs.pathExists(marker)).toBe(false);
    } finally {
      await fs.remove(tempDir);
    }
  });

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
