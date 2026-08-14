import { spawn, type SpawnOptions } from 'node:child_process';

export interface BoundedTestProcessOptions extends SpawnOptions {
  timeoutMs: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface BoundedTestProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  diagnostic: string;
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const joined = Buffer.concat([current, chunk]);
  return joined.length <= limit ? joined : joined.subarray(joined.length - limit);
}

/**
 * Runs an integration-test subprocess as a process-group owner. Timeout and
 * caller cancellation terminate the whole descendant group before returning;
 * this mirrors the managed producer ownership contract instead of relying on
 * Vitest's non-cancelling Promise timeout.
 */
export function runBoundedTestProcess(
  command: string,
  args: string[],
  options: BoundedTestProcessOptions,
): Promise<BoundedTestProcessResult> {
  const {
    timeoutMs,
    terminationGraceMs = 500,
    signal: abortSignal,
    maxOutputBytes = 1024 * 1024,
    ...spawnOptions
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`bounded test process timeout must be positive: ${timeoutMs}`);
  }
  const started = Date.now();
  const child = spawn(command, args, {
    ...spawnOptions,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk, maxOutputBytes);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk, maxOutputBytes);
  });

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let cancelled = false;
    let terminating = false;
    let escalationComplete = false;
    let closed: { status: number | null; signal: NodeJS.Signals | null } | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;

    const killOwnedGroup = (killSignal: NodeJS.Signals): void => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, killSignal);
        else child.kill(killSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    const finish = (): void => {
      if (!closed || (terminating && !escalationComplete)) return;
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      const reason = timedOut ? 'timeout' : cancelled ? 'cancellation' : 'exit';
      resolve({
        ...closed,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        diagnostic: `[test-process-owner] reason=${reason} pid=${child.pid ?? 'unavailable'} pgid=${process.platform === 'win32' ? 'unsupported' : child.pid ?? 'unavailable'} timeout_ms=${timeoutMs} grace_ms=${terminationGraceMs}`,
      });
    };
    const terminate = (reason: 'timeout' | 'cancellation'): void => {
      if (terminating || closed) return;
      terminating = true;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancellation';
      killOwnedGroup('SIGTERM');
      escalationTimer = setTimeout(() => {
        killOwnedGroup('SIGKILL');
        escalationComplete = true;
        finish();
      }, terminationGraceMs);
      escalationTimer.unref();
    };
    const onAbort = (): void => terminate('cancellation');
    const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);
    timeoutTimer.unref();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();

    child.once('error', (error) => {
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (status, childSignal) => {
      closed = { status, signal: childSignal };
      finish();
    });
  });
}
