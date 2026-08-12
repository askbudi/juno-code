import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireTestResourceLock } from '../../test-utils/resource-lock.js';

const fixtures: string[] = [];
const children: ChildProcess[] = [];

async function fixtureLockPath(): Promise<{ root: string; lockPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-resource-lock-test-'));
  fixtures.push(root);
  return { root, lockPath: path.join(root, 'shared.lock') };
}

async function waitFor(pathname: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await fs.pathExists(pathname))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${pathname}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const fixture of fixtures.splice(0)) await fs.remove(fixture);
});

describe('cross-process heavy test resource lock', () => {
  it('serializes behind a live process and reports owner/workload wait diagnostics', async () => {
    const { root, lockPath } = await fixtureLockPath();
    const ready = path.join(root, 'ready');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const lock = ${JSON.stringify(lockPath)};
      fs.mkdirSync(lock);
      fs.writeFileSync(lock + '/owner.json', JSON.stringify({
        pid: process.pid, token: 'child-token', workload: 'child real-Git suite',
        process: process.argv.join(' '), cwd: process.cwd(), startedAt: new Date().toISOString()
      }));
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), 250);
      setTimeout(() => process.exit(0), 300);
    `], { stdio: 'ignore' });
    children.push(child);
    await waitFor(ready);

    const diagnostics: string[] = [];
    const lease = await acquireTestResourceLock('waiting managed install', {
      lockPath,
      timeoutMs: 2_000,
      pollMs: 10,
      diagnosticIntervalMs: 40,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(lease.waitedMs).toBeGreaterThanOrEqual(150);
    expect(diagnostics.join('\n')).toContain('owner_pid=');
    expect(diagnostics.join('\n')).toContain('child real-Git suite');
    expect(diagnostics.join('\n')).toContain('waited_ms=');
    await lease.release();
  });

  it('atomically recovers a dead owner before acquiring the lease', async () => {
    const { lockPath } = await fixtureLockPath();
    await fs.ensureDir(lockPath);
    await fs.writeJson(path.join(lockPath, 'owner.json'), {
      pid: 2_147_483_647,
      token: 'stale-token',
      workload: 'crashed install',
      process: 'dead-worker',
      cwd: '/tmp/dead',
      startedAt: '2000-01-01T00:00:00.000Z',
    });
    const diagnostics: string[] = [];

    const lease = await acquireTestResourceLock('recovery probe', {
      lockPath,
      timeoutMs: 1_000,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(lease.owner.workload).toBe('recovery probe');
    expect(diagnostics.join('\n')).toContain('recovered stale');
    expect(diagnostics.join('\n')).toContain('owner_pid=2147483647');
    await lease.release();
    expect(await fs.pathExists(lockPath)).toBe(false);
  });

  it('names the live owner, process, workload, wait, and load when acquisition times out', async () => {
    const { lockPath } = await fixtureLockPath();
    await fs.ensureDir(lockPath);
    await fs.writeJson(path.join(lockPath, 'owner.json'), {
      pid: process.pid,
      token: 'live-token',
      workload: 'blocking workload',
      process: 'vitest blocker',
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });

    await expect(acquireTestResourceLock('timeout probe', {
      lockPath,
      timeoutMs: 30,
      pollMs: 5,
      onDiagnostic: () => undefined,
    })).rejects.toThrow(/waited_ms=.*owner_pid=.*owner_workload="blocking workload".*owner_process="vitest blocker".*loadavg=/);
  });
});
