/**
 * Advisory test-daemon client (Wave 2 of PDR 7djT8N).
 *
 * Connects to a daemon over its identity-keyed Unix socket, exchanges
 * versioned NDJSON frames with strict validation, and treats every transport
 * or protocol failure as a cold-fallback instruction. Starting a daemon is
 * bounded and stale sockets, stale owners, and crashed children recover
 * deterministically without orphan producers.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawnDaemonChild } from './entry.js';
import {
  currentEnvironmentBinding,
  inputClosureDigest,
  treeSnapshot,
} from './identity.js';
import {
  DAEMON_REQUEST_SCHEMA,
  parseDaemonResponse,
  type DaemonIdentity,
  type DaemonRequest,
  type DaemonResponse,
} from './protocol.js';
import { daemonLayoutFor, type DaemonLayout } from './paths.js';


export const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
export const DEFAULT_START_TIMEOUT_MS = 60_000;
export const DEFAULT_STOP_GRACE_MS = 10_000;

export class DaemonClientError extends Error {
  constructor(
    readonly code: 'connect_failed' | 'protocol_invalid' | 'start_failed' | 'stop_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DaemonClientError';
  }
}

export interface DaemonRequestEnvelope {
  readonly identity: DaemonIdentity;
  readonly selectedTests: readonly string[];
  readonly timeoutMs: number;
  readonly commandArgv: readonly string[];
}

export function layoutFor(identity: DaemonIdentity): DaemonLayout {
  return daemonLayoutFor(identity.identity_sha256);
}

/** Send one frame and read exactly one response line. */
export async function daemonFrame(
  layout: DaemonLayout,
  request: DaemonRequest,
  timeoutMs: number,
): Promise<DaemonResponse> {
  const frame = `${JSON.stringify(request)}\n`;
  return new Promise<DaemonResponse>((resolve, reject) => {
    const socket = net.connect(layout.socketPath);
    socket.setNoDelay(true);
    const fail = (error: Error): void => {
      socket.destroy();
      reject(
        new DaemonClientError(
          'connect_failed',
          `daemon at ${layout.socketPath} is unreachable: ${error.message}`,
        ),
      );
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('request timed out')));
    socket.once('error', fail);
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        if (buffer.length > 1024 * 1024) fail(new Error('oversized response'));
        return;
      }
      const line = buffer.slice(0, newline);
      socket.end();
      try {
        resolve(parseDaemonResponse(line));
      } catch (error) {
        reject(
          new DaemonClientError('protocol_invalid', (error as Error).message),
        );
      }
    });
    socket.on('connect', () => socket.write(frame));
  });
}

export async function daemonStatus(
  identity: DaemonIdentity,
  timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<DaemonResponse> {
  return daemonFrame(
    layoutFor(identity),
    {
      schema_version: DAEMON_REQUEST_SCHEMA,
      id: `status-${Date.now().toString(36)}`,
      type: 'status',
      worktree: identity.worktree,
      project_root: identity.project_root,
      identity_sha256: identity.identity_sha256,
    },
    timeoutMs,
  );
}

export async function daemonStop(
  identity: DaemonIdentity,
  graceMs: number = DEFAULT_STOP_GRACE_MS,
): Promise<{ response: DaemonResponse | null; note: string }> {
  const layout = layoutFor(identity);
  let response: DaemonResponse | null = null;
  try {
    response = await daemonFrame(
      layout,
      {
        schema_version: DAEMON_REQUEST_SCHEMA,
        id: `stop-${Date.now().toString(36)}`,
        type: 'stop',
        worktree: identity.worktree,
        project_root: identity.project_root,
        identity_sha256: identity.identity_sha256,
      },
      DEFAULT_CONNECT_TIMEOUT_MS,
    );
  } catch {
    // No listener: fall through to owner-checked signal cleanup.
  }
  const note = await ensureDaemonChildGone(layout, identity, graceMs);
  return { response, note };
}

/** Build the strict run request for the current tree and closure. */
export async function buildRunRequest(
  envelope: DaemonRequestEnvelope,
): Promise<DaemonRequest> {
  const snapshot = await treeSnapshot(envelope.identity.worktree);
  const closure = await inputClosureDigest(
    envelope.identity.project_root,
    envelope.selectedTests,
    envelope.identity.runtime_generation,
  );
  return {
    schema_version: DAEMON_REQUEST_SCHEMA,
    id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'run',
    worktree: envelope.identity.worktree,
    project_root: envelope.identity.project_root,
    identity_sha256: envelope.identity.identity_sha256,
    head: snapshot.head,
    tree_digest: snapshot.digest,
    environment: currentEnvironmentBinding(),
    selected_tests: envelope.selectedTests,
    input_closure_sha256: closure,
    timeout_ms: envelope.timeoutMs,
    command_argv: envelope.commandArgv,
  };
}

export async function daemonRun(
  envelope: DaemonRequestEnvelope,
  timeoutMs: number,
): Promise<DaemonResponse> {
  const request = await buildRunRequest(envelope);
  return daemonFrame(layoutFor(envelope.identity), request, timeoutMs);
}

export interface StartDaemonOptions {
  readonly idleTimeoutMs?: number;
  readonly maxRequests?: number;
  readonly startTimeoutMs?: number;
  readonly force?: boolean;
  /** Test seam: explicit CLI entry to re-execute for the daemon child. */
  readonly entryOverride?: string;
}

export interface DaemonStartResult {
  outcome: 'started' | 'already_running' | 'recovered_and_started';
  layout: DaemonLayout;
  childPid?: number;
}

/**
 * Start (or confirm) the daemon for an identity. Stale sockets without a
 * listener and crashed children are recovered; a live daemon is reused.
 */
export async function startDaemon(
  identity: DaemonIdentity,
  options: StartDaemonOptions = {},
): Promise<DaemonStartResult> {
  const layout = layoutFor(identity);
  await fs.mkdir(layout.directory, { recursive: true });

  try {
    await daemonStatus(identity, DEFAULT_CONNECT_TIMEOUT_MS);
    return { outcome: 'already_running', layout };
  } catch {
    // Not serving: recover any stale artifacts before spawning.
  }

  if (options.force) {
    await ensureDaemonChildGone(layout, identity, DEFAULT_STOP_GRACE_MS);
  }

  await fs.rm(layout.socketPath, { force: true });
  const identityFile = layout.identityPath;
  await fs.writeFile(
    identityFile,
    `${JSON.stringify(identity, null, 2)}\n`,
    { mode: 0o600 },
  );
  const child = spawnDaemonChild({
    identityFile,
    projectRoot: identity.project_root,
    ...(options.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: options.idleTimeoutMs }
      : {}),
    ...(options.maxRequests !== undefined ? { maxRequests: options.maxRequests } : {}),
    ...(options.entryOverride !== undefined ? { entryOverride: options.entryOverride } : {}),
  });

  const deadline = Date.now() + (options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      await daemonStatus(identity, DEFAULT_CONNECT_TIMEOUT_MS);
      const result: DaemonStartResult = { outcome: 'started', layout };
  if (child.pid !== undefined) result.childPid = child.pid;
  return result;
    } catch (error) {
      lastError = (error as Error).message;
      if (child.exitCode !== null) {
        throw new DaemonClientError(
          'start_failed',
          `daemon child exited with code ${child.exitCode} before serving; log: ${layout.logPath} (${lastError})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  killOwnedChild(child.pid ?? 0, layout, identity);
  throw new DaemonClientError(
    'start_failed',
    `daemon did not become ready within ${options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms: ${lastError}; log: ${layout.logPath}`,
  );
}

/**
 * Wait for the child to exit; escalate only against a process whose command
 * line proves it is this identity's daemon (never a recycled PID).
 */
async function ensureDaemonChildGone(
  layout: DaemonLayout,
  identity: DaemonIdentity,
  graceMs: number,
): Promise<string> {
  const childPid = await readDaemonPid(layout);
  if (childPid === null) {
    await fs.rm(layout.socketPath, { force: true });
    return 'no daemon child recorded; socket cleaned';
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!killOwnedChild(0, layout, identity, 0, childPid)) {
      await fs.rm(layout.socketPath, { force: true });
      return 'daemon child exited';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (killOwnedChild(childPid, layout, identity, 'SIGTERM')) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (killOwnedChild(childPid, layout, identity, 'SIGKILL')) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await fs.rm(layout.socketPath, { force: true });
  return 'daemon child signalled after grace';
}

async function readDaemonPid(layout: DaemonLayout): Promise<number | null> {
  try {
    const raw = JSON.parse(await fs.readFile(layout.runJsonPath, 'utf8')) as {
      pid?: unknown;
    };
    return typeof raw.pid === 'number' && Number.isSafeInteger(raw.pid) ? raw.pid : null;
  } catch {
    return null;
  }
}

/** Signal only a provably-owned daemon PID. Returns whether it still lives. */
function killOwnedChild(
  pid: number,
  layout: DaemonLayout,
  _identity: DaemonIdentity,
  signal: NodeJS.Signals | 0 = 0,
  probePid?: number,
): boolean {
  const target = probePid ?? pid;
  if (!target || target <= 1) return false;
  try {
    const stdout = execFileSync('ps', ['-o', 'command=', '-p', String(target)], {
      encoding: 'utf8',
    }).trim();
    if (!stdout) return false;
    // Ownership proof: the command line must be this identity's daemon child.
    const owned =
      stdout.includes('yylo-test-daemon-serve') &&
      stdout.includes(`--identity-file ${layout.identityPath}`);
    if (!owned) return false;
    if (signal !== 0) process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

export interface ColdFallbackOutcome {
  readonly exitCode: number;
  readonly command: readonly string[];
}

/**
 * The authoritative cold path: identical argv to lifecycle admission
 * (`npm test -- <files>`), stdio inherited, advisory marker printed first.
 */
export async function runColdFallback(
  projectRoot: string,
  selectedTests: readonly string[],
): Promise<ColdFallbackOutcome> {
  const command = ['npm', 'test', '--', ...selectedTests];
  const runner = command[0];
  if (runner === undefined) throw new Error('cold fallback command is empty');
  process.stderr.write(
    '[test-daemon] cold fallback executed; results remain advisory-only for this invocation\n',
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child: ChildProcess = spawn(runner, command.slice(1), {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`cold fallback terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  return { exitCode, command };
}

export function describeDaemonResponse(response: DaemonResponse): string[] {
  const lines: string[] = [];
  if (response.daemon) {
    lines.push(
      `pid=${response.daemon.pid}`,
      `protocol=${response.daemon.protocol_version}`,
      `identity=${response.daemon.identity_sha256.slice(0, 12)}`,
      `runner=${response.daemon.runner.kind}@${response.daemon.runner.version}`,
      `requests_served=${response.daemon.requests_served}`,
      `runs_served=${response.daemon.runs_served}`,
      `idle_shutdown_at=${response.daemon.idle_shutdown_at}`,
      `started_at=${response.daemon.started_at}`,
    );
  }
  if (response.timings_ms) {
    lines.push(`timings_ms=${JSON.stringify(response.timings_ms)}`);
  }
  return lines;
}

export function projectRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}
