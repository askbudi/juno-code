import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

export const SHARED_RESOURCE_LOCK_HOOK_TIMEOUT_MS = 310_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 300_000;
const DEFAULT_DIAGNOSTIC_INTERVAL_MS = 5_000;
const OWNER_FILE = 'owner.json';

export interface TestResourceLockOwner {
  pid: number;
  token: string;
  workload: string;
  process: string;
  cwd: string;
  startedAt: string;
}

export interface TestResourceLockOptions {
  lockPath?: string;
  timeoutMs?: number;
  pollMs?: number;
  diagnosticIntervalMs?: number;
  onDiagnostic?: (message: string) => void;
}

export interface TestResourceLease {
  lockPath: string;
  owner: TestResourceLockOwner;
  waitedMs: number;
  release: () => Promise<void>;
}

export function sharedHeavyWorkloadLockPath(): string {
  return process.env.JUNO_TEST_RESOURCE_LOCK_PATH
    || path.join(os.tmpdir(), 'juno-code-real-git-managed-install.lock');
}

async function readOwner(lockPath: string): Promise<TestResourceLockOwner | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8')) as TestResourceLockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function describeOwner(owner: TestResourceLockOwner | null): string {
  if (!owner) return 'owner=<unavailable>';
  return `owner_pid=${owner.pid} owner_workload=${JSON.stringify(owner.workload)} owner_process=${JSON.stringify(owner.process)} owner_cwd=${JSON.stringify(owner.cwd)} owner_started_at=${owner.startedAt}`;
}

function loadDiagnostics(): string {
  const load = os.loadavg().map((value) => value.toFixed(2)).join(',');
  return `waiter_pid=${process.pid} loadavg=${load} cpus=${os.cpus().length}`;
}

async function recoverStaleOwner(lockPath: string, owner: TestResourceLockOwner | null, token: string): Promise<boolean> {
  // A live acquirer may briefly exist before owner.json is published. Only an
  // explicit dead owner, or an ownerless directory older than five seconds,
  // is recoverable.
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner) {
    try {
      if (Date.now() - (await fs.stat(lockPath)).mtimeMs < 5_000) return false;
    } catch {
      return false;
    }
  }
  const quarantine = `${lockPath}.stale-${process.pid}-${token}`;
  try {
    await fs.rename(lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
  return true;
}

export async function acquireTestResourceLock(
  workload: string,
  options: TestResourceLockOptions = {},
): Promise<TestResourceLease> {
  const lockPath = options.lockPath || sharedHeavyWorkloadLockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 50;
  const diagnosticIntervalMs = options.diagnosticIntervalMs ?? DEFAULT_DIAGNOSTIC_INTERVAL_MS;
  const onDiagnostic = options.onDiagnostic ?? ((message) => console.error(message));
  const token = randomUUID();
  const started = Date.now();
  let nextDiagnostic = Math.min(1_000, diagnosticIntervalMs);
  const owner: TestResourceLockOwner = {
    pid: process.pid,
    token,
    workload,
    process: process.argv.join(' '),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
      const waitedMs = Date.now() - started;
      if (waitedMs > 0) {
        onDiagnostic(`[test-resource-lock] acquired workload=${JSON.stringify(workload)} waited_ms=${waitedMs} lock=${lockPath} ${loadDiagnostics()}`);
      }
      return {
        lockPath,
        owner,
        waitedMs,
        release: async () => {
          const current = await readOwner(lockPath);
          if (current?.token !== token) return;
          const quarantine = `${lockPath}.release-${process.pid}-${token}`;
          try {
            await fs.rename(lockPath, quarantine);
            await fs.rm(quarantine, { recursive: true, force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const current = await readOwner(lockPath);
    if (await recoverStaleOwner(lockPath, current, token)) {
      onDiagnostic(`[test-resource-lock] recovered stale lock=${lockPath} ${describeOwner(current)} ${loadDiagnostics()}`);
      continue;
    }

    const waitedMs = Date.now() - started;
    if (waitedMs >= timeoutMs) {
      throw new Error(`[test-resource-lock] acquisition timed out workload=${JSON.stringify(workload)} waited_ms=${waitedMs} lock=${lockPath} ${describeOwner(current)} ${loadDiagnostics()}`);
    }
    if (waitedMs >= nextDiagnostic) {
      onDiagnostic(`[test-resource-lock] waiting workload=${JSON.stringify(workload)} waited_ms=${waitedMs} lock=${lockPath} ${describeOwner(current)} ${loadDiagnostics()}`);
      nextDiagnostic += diagnosticIntervalMs;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Serialize only process-heavy real-Git/managed-install suites, not product concurrency. */
export function useSharedHeavyWorkloadLock(workload: string): void {
  let lease: TestResourceLease | undefined;
  beforeAll(async () => {
    lease = await acquireTestResourceLock(workload);
  }, SHARED_RESOURCE_LOCK_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await lease?.release();
  }, 10_000);
}
