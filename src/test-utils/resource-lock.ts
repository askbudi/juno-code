import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll } from 'vitest';

const execFileAsync = promisify(execFile);
// Lifecycle policy allows loaded concurrent worktrees to wait up to 20 minutes.
// Keep that wait separate from each test's bounded operation budget.
export const DEFAULT_SHARED_RESOURCE_ACQUIRE_TIMEOUT_MS = 1_200_000;
export const SHARED_RESOURCE_LOCK_HOOK_TIMEOUT_MS = 1_210_000;
export const MANAGED_INSTALL_OPERATION_TIMEOUT_MS = 900_000;
const DEFAULT_DIAGNOSTIC_INTERVAL_MS = 5_000;
const DEFAULT_LOCK_NAME = 'juno-code-real-git-managed-install.lock';
const PYTHON_PROTOCOL = path.resolve(import.meta.dirname, '../templates/scripts/tests/test_task_workspace.py');

export interface TestResourceLockOwner {
  pid: number;
  processBirthId: string;
  token: string;
  workload: string;
  process: string;
  cwd: string;
  startedAt: string;
  _inode?: [number, number];
}
export interface TestResourceLockOptions {
  lockPath?: string; timeoutMs?: number; pollMs?: number;
  diagnosticIntervalMs?: number; onDiagnostic?: (message: string) => void;
}
export interface TestResourceLease {
  lockPath: string; owner: TestResourceLockOwner; waitedMs: number; release: () => Promise<void>;
}
interface ProtocolResult {
  outcome: 'acquired' | 'blocked' | 'released' | 'not-owner' | 'absent' | 'present';
  owner?: TestResourceLockOwner | null; recovered?: TestResourceLockOwner | null;
}

export function normalizeTestResourceLockPath(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return path.join(realpathSync(os.tmpdir()), DEFAULT_LOCK_NAME);
  const parsed = path.parse(candidate);
  const tail = candidate.slice(parsed.root.length);
  const components = tail.split(path.sep);
  if (!path.isAbsolute(candidate) || candidate !== parsed.root + components.join(path.sep)
      || components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new Error(`[test-resource-lock] lock path must be one normalized absolute path: ${JSON.stringify(candidate)}`);
  }
  return candidate;
}

export function sharedHeavyWorkloadLockPath(): string {
  return normalizeTestResourceLockPath(process.env.JUNO_TEST_RESOURCE_LOCK_PATH);
}

async function assertNoSymlinkComponents(pathname: string): Promise<void> {
  const parsed = path.parse(pathname);
  const parts = pathname.slice(parsed.root.length).split(path.sep);
  let cursor = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]!);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`[test-resource-lock] symlinked lock path component is forbidden: ${cursor}`);
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`[test-resource-lock] lock path parent is not a directory: ${cursor}`);
      if (index === parts.length - 1 && !stat.isFile()) throw new Error(`[test-resource-lock] lock protocol path must be a file: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (index !== parts.length - 1) throw new Error(`[test-resource-lock] path parent must already exist: ${cursor}`);
    }
  }
}

async function python(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('python3', [PYTHON_PROTOCOL, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export async function processBirthIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { return JSON.parse(await python(['--resource-lock-birth', String(pid)])) as string | null; }
  catch { return null; }
}

async function protocol(lockPath: string, action: string, payload: object): Promise<ProtocolResult> {
  await assertNoSymlinkComponents(lockPath);
  await assertNoSymlinkComponents(path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.protocol`));
  return JSON.parse(await python(['--resource-lock-op', action, lockPath, JSON.stringify(payload)])) as ProtocolResult;
}

function describeOwner(owner: TestResourceLockOwner | null | undefined): string {
  if (!owner) return 'owner=<invalid-or-unavailable>';
  return `owner_pid=${owner.pid} owner_birth=${JSON.stringify(owner.processBirthId)} owner_inode=${JSON.stringify(owner._inode)} owner_workload=${JSON.stringify(owner.workload)} owner_process=${JSON.stringify(owner.process)} owner_cwd=${JSON.stringify(owner.cwd)} owner_started_at=${owner.startedAt}`;
}
function loadDiagnostics(): string {
  return `waiter_pid=${process.pid} loadavg=${os.loadavg().map((value) => value.toFixed(2)).join(',')} cpus=${os.cpus().length}`;
}

export async function acquireTestResourceLock(workload: string, options: TestResourceLockOptions = {}): Promise<TestResourceLease> {
  const lockPath = normalizeTestResourceLockPath(options.lockPath ?? process.env.JUNO_TEST_RESOURCE_LOCK_PATH);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHARED_RESOURCE_ACQUIRE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 50;
  const diagnosticIntervalMs = options.diagnosticIntervalMs ?? DEFAULT_DIAGNOSTIC_INTERVAL_MS;
  const onDiagnostic = options.onDiagnostic ?? ((message) => console.error(message));
  const token = randomUUID();
  const started = Date.now(); let nextDiagnostic = Math.min(1_000, diagnosticIntervalMs);
  const owner: TestResourceLockOwner = {
    pid: process.pid, processBirthId: '', token, workload,
    process: process.argv.join(' '), cwd: process.cwd(), startedAt: new Date().toISOString(),
  };
  for (;;) {
    const result = await protocol(lockPath, 'acquire', owner);
    if (result.outcome === 'acquired') {
      const waitedMs = Date.now() - started;
      if (result.recovered) onDiagnostic(`[test-resource-lock] recovered stale lock=${lockPath} ${describeOwner(result.recovered)} ${loadDiagnostics()}`);
      if (waitedMs > 0) onDiagnostic(`[test-resource-lock] acquired workload=${JSON.stringify(workload)} waited_ms=${waitedMs} lock=${lockPath} ${loadDiagnostics()}`);
      const inspected = await protocol(lockPath, 'inspect', {});
      const acquiredOwner = inspected.owner ?? result.owner ?? owner;
      return {
        lockPath, owner: acquiredOwner, waitedMs,
        release: async () => { await protocol(lockPath, 'release', { token, inode: acquiredOwner._inode }); },
      };
    }
    const waitedMs = Date.now() - started;
    if (waitedMs >= timeoutMs) throw new Error(`[test-resource-lock] acquisition timed out workload=${JSON.stringify(workload)} waited_ms=${waitedMs} lock=${lockPath} ${describeOwner(result.owner)} ${loadDiagnostics()}`);
    if (waitedMs >= nextDiagnostic) {
      onDiagnostic(`[test-resource-lock] waiting workload=${JSON.stringify(workload)} waited_ms=${waitedMs} lock=${lockPath} ${describeOwner(result.owner)} ${loadDiagnostics()}`);
      nextDiagnostic += diagnosticIntervalMs;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function useSharedHeavyWorkloadLock(workload: string): void {
  let lease: TestResourceLease | undefined;
  beforeAll(async () => { lease = await acquireTestResourceLock(workload); }, SHARED_RESOURCE_LOCK_HOOK_TIMEOUT_MS);
  afterAll(async () => { await lease?.release(); }, 30_000);
}
