import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll } from 'vitest';

const execFileAsync = promisify(execFile);
export const SHARED_RESOURCE_LOCK_HOOK_TIMEOUT_MS = 310_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 300_000;
const DEFAULT_DIAGNOSTIC_INTERVAL_MS = 5_000;
const DEFAULT_LOCK_NAME = 'juno-code-real-git-managed-install.lock';

export interface TestResourceLockOwner {
  pid: number;
  processBirthId: string;
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

function configuredPath(value: string | undefined): string {
  const candidate = value?.trim() || path.join(realpathSync(os.tmpdir()), DEFAULT_LOCK_NAME);
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
    throw new Error(`[test-resource-lock] lock path must be one normalized absolute path: ${JSON.stringify(candidate)}`);
  }
  return candidate;
}

export function sharedHeavyWorkloadLockPath(): string {
  return configuredPath(process.env.JUNO_TEST_RESOURCE_LOCK_PATH);
}

async function assertSafeLockPath(lockPath: string): Promise<void> {
  const normalized = configuredPath(lockPath);
  const parsed = path.parse(normalized);
  const parts = normalized.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]!);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`[test-resource-lock] symlinked lock path component is forbidden: ${cursor}`);
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new Error(`[test-resource-lock] lock path parent is not a directory: ${cursor}`);
      }
      if (index === parts.length - 1 && !stat.isFile()) {
        throw new Error(`[test-resource-lock] lock path must be an owner file: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (index !== parts.length - 1) {
        throw new Error(`[test-resource-lock] lock path parent must already exist: ${cursor}`);
      }
    }
  }
}

export async function processBirthIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000,
    });
    return stdout.trim().replace(/\s+/g, ' ') || null;
  } catch {
    return null;
  }
}

async function readOwner(lockPath: string): Promise<TestResourceLockOwner | null> {
  try {
    const stat = await fs.lstat(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const value = JSON.parse(await fs.readFile(lockPath, 'utf8')) as TestResourceLockOwner;
    return value && typeof value.token === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function ownerIsLive(owner: TestResourceLockOwner): Promise<boolean> {
  const observed = await processBirthIdentity(owner.pid);
  if (observed !== null) return observed === owner.processBirthId;
  // Distinguish a provably absent PID from an unavailable birth lookup. The
  // latter is indeterminate and therefore live (portable fail-closed behavior).
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function describeOwner(owner: TestResourceLockOwner | null): string {
  if (!owner) return 'owner=<invalid-or-unavailable>';
  return `owner_pid=${owner.pid} owner_birth=${JSON.stringify(owner.processBirthId)} owner_workload=${JSON.stringify(owner.workload)} owner_process=${JSON.stringify(owner.process)} owner_cwd=${JSON.stringify(owner.cwd)} owner_started_at=${owner.startedAt}`;
}

function loadDiagnostics(): string {
  const load = os.loadavg().map((value) => value.toFixed(2)).join(',');
  return `waiter_pid=${process.pid} loadavg=${load} cpus=${os.cpus().length}`;
}

async function publishOwnerAtomically(lockPath: string, owner: TestResourceLockOwner): Promise<boolean> {
  const temporary = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.owner-${process.pid}-${owner.token}`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeLockPath(lockPath);
    try {
      // The fully populated inode becomes the lock in one no-overwrite syscall.
      await fs.link(temporary, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function removeIfTokenMatches(lockPath: string, expectedToken: string, purpose: string): Promise<boolean> {
  const quarantine = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${purpose}-${process.pid}-${randomUUID()}`);
  try {
    await fs.rename(lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  const moved = await readOwner(quarantine);
  if (moved?.token === expectedToken) {
    await fs.unlink(quarantine);
    return true;
  }
  // The name changed after inspection. Restore the successor atomically; never
  // delete an inode whose ownership token is not ours.
  try {
    await fs.link(quarantine, lockPath);
    await fs.unlink(quarantine);
  } catch {
    // Another valid lock already occupies lockPath. Preserve the unexpected
    // inode for diagnostics rather than deleting possible successor state.
  }
  return false;
}

async function recoverStaleOwner(lockPath: string, owner: TestResourceLockOwner | null): Promise<boolean> {
  if (!owner || await ownerIsLive(owner)) return false;
  return removeIfTokenMatches(lockPath, owner.token, 'stale');
}

export async function acquireTestResourceLock(
  workload: string,
  options: TestResourceLockOptions = {},
): Promise<TestResourceLease> {
  const lockPath = configuredPath(options.lockPath ?? process.env.JUNO_TEST_RESOURCE_LOCK_PATH);
  await assertSafeLockPath(lockPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 50;
  const diagnosticIntervalMs = options.diagnosticIntervalMs ?? DEFAULT_DIAGNOSTIC_INTERVAL_MS;
  const onDiagnostic = options.onDiagnostic ?? ((message) => console.error(message));
  const token = randomUUID();
  const started = Date.now();
  let nextDiagnostic = Math.min(1_000, diagnosticIntervalMs);
  const processBirthId = await processBirthIdentity(process.pid);
  if (!processBirthId) throw new Error('[test-resource-lock] cannot establish process birth identity; refusing unsafe acquisition');
  const owner: TestResourceLockOwner = {
    pid: process.pid, processBirthId, token, workload,
    process: process.argv.join(' '), cwd: process.cwd(), startedAt: new Date().toISOString(),
  };

  for (;;) {
    if (await publishOwnerAtomically(lockPath, owner)) {
      const waitedMs = Date.now() - started;
      if (waitedMs > 0) onDiagnostic(`[test-resource-lock] acquired workload=${JSON.stringify(workload)} waited_ms=${waitedMs} lock=${lockPath} ${loadDiagnostics()}`);
      return {
        lockPath, owner, waitedMs,
        release: async () => { await removeIfTokenMatches(lockPath, token, 'release'); },
      };
    }

    const current = await readOwner(lockPath);
    if (await recoverStaleOwner(lockPath, current)) {
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
  beforeAll(async () => { lease = await acquireTestResourceLock(workload); }, SHARED_RESOURCE_LOCK_HOOK_TIMEOUT_MS);
  afterAll(async () => { await lease?.release(); }, 10_000);
}
