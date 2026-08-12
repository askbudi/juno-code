import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as nodeFs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireTestResourceLock,
  processBirthIdentity,
  sharedHeavyWorkloadLockPath,
  type TestResourceLockOwner,
} from '../../test-utils/resource-lock.js';

const fixtures: string[] = [];
const children: ChildProcess[] = [];
const pythonLockModule = path.resolve(
  import.meta.dirname,
  '../../templates/scripts/tests/test_task_workspace.py',
);

async function fixtureLockPath(): Promise<{ root: string; lockPath: string }> {
  const configuredRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-resource-lock-test-'));
  const root = await fs.realpath(configuredRoot);
  fixtures.push(root);
  return { root, lockPath: path.join(root, 'shared.lock') };
}

async function owner(overrides: Partial<TestResourceLockOwner> = {}): Promise<TestResourceLockOwner> {
  return {
    pid: process.pid,
    processBirthId: (await processBirthIdentity(process.pid))!,
    token: 'fixture-token',
    workload: 'fixture workload',
    process: 'vitest fixture',
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function waitFor(pathname: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await fs.pathExists(pathname))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${pathname}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function replaceOwnerAtomically(lockPath: string, value: TestResourceLockOwner): Promise<void> {
  const temporary = `${lockPath}.replacement`;
  await fs.writeJson(temporary, value);
  await fs.rename(temporary, lockPath);
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const fixture of fixtures.splice(0)) await fs.remove(fixture);
});

describe('cross-process heavy test resource lock', () => {
  it('allows only one simultaneous acquirer and gives the follower a populated owner', async () => {
    const { lockPath } = await fixtureLockPath();
    const diagnostics: string[] = [];
    const options = {
      lockPath, pollMs: 5, diagnosticIntervalMs: 20,
      onDiagnostic: (message: string) => diagnostics.push(message),
    };
    const firstPromise = acquireTestResourceLock('simultaneous first', options);
    const secondPromise = acquireTestResourceLock('simultaneous second', options);
    const winner = await Promise.race([
      firstPromise.then((lease) => ({ index: 0, lease })),
      secondPromise.then((lease) => ({ index: 1, lease })),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await winner.lease.release();
    const follower = winner.index === 0 ? await secondPromise : await firstPromise;
    expect(follower.waitedMs).toBeGreaterThanOrEqual(50);
    expect(diagnostics.join('\n')).toMatch(/owner_workload="simultaneous (first|second)"/);
    await follower.release();
  });

  it('fails closed on ownerless/delayed publication instead of stealing it', async () => {
    const { lockPath } = await fixtureLockPath();
    await fs.writeFile(lockPath, '');
    await expect(acquireTestResourceLock('ownerless probe', {
      lockPath, timeoutMs: 30, pollMs: 5, onDiagnostic: () => undefined,
    })).rejects.toThrow(/owner=<invalid-or-unavailable>/);
    expect(await fs.readFile(lockPath, 'utf8')).toBe('');
  });

  it('atomically recovers dead owners and PID reuse using process birth identity', async () => {
    const { lockPath } = await fixtureLockPath();
    await fs.writeJson(lockPath, await owner({
      token: 'reused-pid-token', processBirthId: 'Mon Jan 1 00:00:00 1900',
      workload: 'crashed reused PID',
    }));
    const diagnostics: string[] = [];
    const lease = await acquireTestResourceLock('PID reuse recovery', {
      lockPath, timeoutMs: 1_000, onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(diagnostics.join('\n')).toContain('recovered stale');
    expect(diagnostics.join('\n')).toContain('crashed reused PID');
    await lease.release();

    await fs.writeJson(lockPath, await owner({
      pid: 2_147_483_647, token: 'dead-owner-token', processBirthId: 'unknown',
      workload: 'provably dead owner',
    }));
    const afterDeath = await acquireTestResourceLock('dead owner recovery', { lockPath });
    await afterDeath.release();
  });

  it('restores a successor when an obsolete lease attempts token-protected cleanup', async () => {
    const { lockPath } = await fixtureLockPath();
    const lease = await acquireTestResourceLock('obsolete owner', { lockPath });
    const successor = await owner({ token: 'successor-token', workload: 'successor' });
    await replaceOwnerAtomically(lockPath, successor);
    await lease.release();
    expect((await fs.readJson(lockPath)).token).toBe('successor-token');
  });

  it('cleans publication temporaries when atomic publication itself fails', async () => {
    const { root, lockPath } = await fixtureLockPath();
    const failure = Object.assign(new Error('injected hard-link failure'), { code: 'EIO' });
    const link = vi.spyOn(nodeFs, 'link').mockRejectedValueOnce(failure);
    try {
      await expect(acquireTestResourceLock('failure cleanup', { lockPath })).rejects.toThrow(
        /injected hard-link failure/,
      );
    } finally {
      link.mockRestore();
    }
    expect((await fs.readdir(root)).filter((name) => name.includes('.owner-'))).toEqual([]);
    expect(await fs.pathExists(lockPath)).toBe(false);
  });

  it('normalizes empty overrides to the default and rejects relative/non-normal paths', async () => {
    const prior = process.env.JUNO_TEST_RESOURCE_LOCK_PATH;
    process.env.JUNO_TEST_RESOURCE_LOCK_PATH = '';
    try {
      expect(sharedHeavyWorkloadLockPath()).toBe(
        path.join(await fs.realpath(os.tmpdir()), 'juno-code-real-git-managed-install.lock'),
      );
    } finally {
      if (prior === undefined) delete process.env.JUNO_TEST_RESOURCE_LOCK_PATH;
      else process.env.JUNO_TEST_RESOURCE_LOCK_PATH = prior;
    }
    await expect(acquireTestResourceLock('relative', { lockPath: 'relative.lock' })).rejects.toThrow(
      /normalized absolute path/,
    );
    const { root } = await fixtureLockPath();
    await expect(acquireTestResourceLock('non-normal', {
      lockPath: `${root}${path.sep}child${path.sep}..${path.sep}lock`,
    })).rejects.toThrow(/normalized absolute path/);
  });

  it('rejects symlinked parents and lock files', async () => {
    const { root } = await fixtureLockPath();
    const real = path.join(root, 'real');
    const linked = path.join(root, 'linked');
    await fs.ensureDir(real);
    await fs.symlink(real, linked);
    await expect(acquireTestResourceLock('parent symlink', {
      lockPath: path.join(linked, 'lock'),
    })).rejects.toThrow(/symlinked lock path component/);
    const target = path.join(real, 'target');
    await fs.writeFile(target, 'do not touch');
    const lockLink = path.join(real, 'lock-link');
    await fs.symlink(target, lockLink);
    await expect(acquireTestResourceLock('lock symlink', { lockPath: lockLink })).rejects.toThrow(
      /symlinked lock path component/,
    );
    expect(await fs.readFile(target, 'utf8')).toBe('do not touch');
  });

  it('interoperates with the actual Python protocol and reports its owner to Node', async () => {
    const { root, lockPath } = await fixtureLockPath();
    const ready = path.join(root, 'python-ready');
    const code = `
import importlib.util, pathlib, sys, time
spec=importlib.util.spec_from_file_location("lock_probe", sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
lock=pathlib.Path(sys.argv[2]); token,_=module._acquire_resource_lock("Python interoperability owner", lock)
pathlib.Path(sys.argv[3]).write_text("ready")
time.sleep(.35)
module._remove_if_token_matches(lock, token, "release")
`;
    const child = spawn('python3', ['-c', code, pythonLockModule, lockPath, ready], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    await waitFor(ready);
    const diagnostics: string[] = [];
    const lease = await acquireTestResourceLock('Node interoperability follower', {
      lockPath, timeoutMs: 2_000, pollMs: 10, diagnosticIntervalMs: 30,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(lease.waitedMs).toBeGreaterThanOrEqual(150);
    expect(diagnostics.join('\n')).toContain('Python interoperability owner');
    expect(diagnostics.join('\n')).toContain('owner_birth=');
    await lease.release();
  });

  it('uses identical Python and Node empty/relative path rules', async () => {
    const code = `
import importlib.util, sys
spec=importlib.util.spec_from_file_location("lock_probe", sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(module._configured_lock_path(""))
try: module._configured_lock_path("relative.lock")
except RuntimeError as error: print(error)
`;
    const result = spawnSync('python3', ['-c', code, pythonLockModule], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('juno-code-real-git-managed-install.lock');
    expect(result.stdout).toContain('normalized absolute path');
  });
});
