/**
 * Advisory test-daemon server (Wave 2 of PDR 7djT8N).
 *
 * Bounded, fail-safe, warm affected-test execution over a local Unix socket.
 * Every response is advisory: identity is rechecked before dispatch and after
 * completion, closure drift and tree races invalidate the result, shared
 * managed-install resources are serialized through the existing Python lock
 * protocol, and any failure returns a structured error with a cold-fallback
 * hint instead of an ambiguous success.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  currentEnvironmentBinding,
  inputClosureDigest,
  treeSnapshot as defaultTreeSnapshot,
} from './identity.js';
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RESPONSE_SCHEMA,
  DAEMON_RUNFILE_SCHEMA,
  MAX_FRAME_BYTES,
  parseDaemonRequest,
  type DaemonErrorCode,
  type DaemonIdentity,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonRunResults,
  type TreeSnapshot,
} from './protocol.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_REQUESTS = 2_000;
export const DEFAULT_MAX_RSS_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_MANAGED_INSTALL_WAIT_MS = 120_000;
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Suites that share the cross-process real-Git install lease. Requests
 * intersecting these globs serialize on the existing lock protocol before
 * dispatch, exactly like the cold focused-validation runner.
 */
export const MANAGED_INSTALL_POOL_MATCHERS: readonly RegExp[] = [
  /(^|\/)managed-project-assets\.test\.ts$/,
  /(^|\/)script-installer\.test\.ts$/,
];

const PYTHON_LOCK_PROTOCOL = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../templates/scripts/tests/test_task_workspace.py',
);

export interface ManagedInstallLease {
  release: () => Promise<void>;
}

export interface DaemonServerOptions {
  readonly identity: DaemonIdentity;
  readonly runner: {
    readonly kind: string;
    readonly version: string;
    initialize(): Promise<void>;
    run(
      selectedTests: readonly string[],
      options: { timeoutMs: number },
    ): Promise<DaemonRunResults>;
    cancel(reason: string): Promise<void>;
    close(): Promise<void>;
  };
  readonly treeSnapshot?: (worktree: string) => Promise<TreeSnapshot>;
  readonly environmentBinding?: () => Record<string, string | null>;
  readonly acquireManagedInstallLease?: (
    waitMs: number,
  ) => Promise<ManagedInstallLease>;
  readonly idleTimeoutMs?: number;
  readonly maxRequests?: number;
  readonly maxRssBytes?: number;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly pid?: number;
}

export interface DaemonRunFileState {
  schema_version: string;
  protocol_version: string;
  identity_sha256: string;
  pid: number;
  started_at: string;
  state: 'starting' | 'serving' | 'stopping' | 'stopped';
  requests_served: number;
  runs_served: number;
  last_request_at: string | null;
  last_error: string | null;
  idle_timeout_ms: number;
  runner: { kind: string; version: string };
}

function errorBody(
  code: DaemonErrorCode,
  message: string,
): NonNullable<DaemonResponse['error']> {
  return { code, message, cold_fallback: true };
}

/**
 * The protocol core. Transport-independent so lifecycle, identity, and
 * fail-safety semantics are table-testable without a socket.
 */
export class TestDaemonServer {
  readonly identity: DaemonIdentity;
  private readonly runner: DaemonServerOptions['runner'];
  private readonly treeSnapshot: (worktree: string) => Promise<TreeSnapshot>;
  private readonly environmentBinding: () => Record<string, string | null>;
  /**
   * The admitted environment is frozen at daemon start: Vite mutates
   * NODE_ENV during warm-runner initialization, and identity must bind the
   * startup environment, not the drifted live one.
   */
  private readonly frozenEnvironment: Record<string, string | null>;
  private readonly acquireLease: (waitMs: number) => Promise<ManagedInstallLease>;
  private readonly idleTimeoutMs: number;
  private readonly maxRequests: number;
  private readonly maxRssBytes: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly startedAt = new Date().toISOString();

  private requestsServed = 0;
  private runsServed = 0;
  private lastRequestAt: number | null = null;
  private busy = false;
  private stopping = false;
  private stopped = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly stopWaiters: Array<() => void> = [];

  constructor(options: DaemonServerOptions) {
    this.identity = options.identity;
    this.runner = options.runner;
    this.treeSnapshot = options.treeSnapshot ?? defaultTreeSnapshot;
    this.environmentBinding =
      options.environmentBinding ?? (() => currentEnvironmentBinding());
    this.frozenEnvironment = this.environmentBinding();
    this.acquireLease =
      options.acquireManagedInstallLease ??
      ((waitMs: number) => acquirePythonProtocolLease(waitMs));
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.maxRssBytes = options.maxRssBytes ?? DEFAULT_MAX_RSS_BYTES;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get counters(): { requests_served: number; runs_served: number } {
    return { requests_served: this.requestsServed, runs_served: this.runsServed };
  }

  idleShutdownDeadline(now: number = this.now()): string {
    const reference = this.lastRequestAt ?? this.now();
    void now;
    return new Date(reference + this.idleTimeoutMs).toISOString();
  }

  runFileState(state: DaemonRunFileState['state']): DaemonRunFileState {
    return {
      schema_version: DAEMON_RUNFILE_SCHEMA,
      protocol_version: DAEMON_PROTOCOL_VERSION,
      identity_sha256: this.identity.identity_sha256,
      pid: this.pid,
      started_at: this.startedAt,
      state,
      requests_served: this.requestsServed,
      runs_served: this.runsServed,
      last_request_at:
        this.lastRequestAt === null ? null : new Date(this.lastRequestAt).toISOString(),
      last_error: null,
      idle_timeout_ms: this.idleTimeoutMs,
      runner: { kind: this.runner.kind, version: this.runner.version },
    };
  }

  statusBody(): NonNullable<DaemonResponse['daemon']> {
    return {
      pid: this.pid,
      started_at: this.startedAt,
      protocol_version: DAEMON_PROTOCOL_VERSION,
      identity_sha256: this.identity.identity_sha256,
      requests_served: this.requestsServed,
      runs_served: this.runsServed,
      idle_shutdown_at: this.idleShutdownDeadline(),
      runner: { kind: this.runner.kind, version: this.runner.version },
    };
  }

  private respond(request: DaemonRequest, response: Omit<DaemonResponse, 'schema_version' | 'id' | 'request_id' | 'advisory'>): string {
    const frame: DaemonResponse = {
      schema_version: DAEMON_RESPONSE_SCHEMA,
      id: request.id,
      request_id: request.id,
      advisory: true,
      ...response,
    };
    const line = JSON.stringify(frame);
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
      const bounded: DaemonResponse = {
        schema_version: DAEMON_RESPONSE_SCHEMA,
        id: request.id,
        request_id: request.id,
        advisory: true,
        type: 'error',
        outcome: 'error',
        error: errorBody('internal_error', 'response frame exceeded the bounded size'),
      };
      return JSON.stringify(bounded);
    }
    return line;
  }

  private error(request: DaemonRequest | null, code: Parameters<typeof errorBody>[0], message: string): string {
    const id = request?.id ?? 'unknown';
    const frame: DaemonResponse = {
      schema_version: DAEMON_RESPONSE_SCHEMA,
      id,
      request_id: id,
      advisory: true,
      type: 'error',
      outcome: 'error',
      error: errorBody(code, message),
    };
    return JSON.stringify(frame);
  }

  /** Handle one raw NDJSON request frame. */
  async handleRequest(raw: string): Promise<string> {
    if (this.stopping) {
      const probe = safeParseId(raw);
      return this.error(probe, 'busy', 'daemon is stopping; cold fallback required');
    }
    let request: DaemonRequest;
    try {
      request = parseDaemonRequest(raw);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const probe = safeParseId(raw);
      if (code === 'protocol_skew') {
        return this.error(probe, 'protocol_skew', (error as Error).message);
      }
      return this.error(probe, 'malformed_request', (error as Error).message);
    }
    try {
      switch (request.type) {
        case 'status':
          return this.handleStatus(request);
        case 'stop':
          return await this.handleStop(request);
        case 'run':
          return await this.handleRun(request);
      }
    } catch (error) {
      this.log(`request ${request.id} failed: ${(error as Error).stack ?? error}`);
      return this.error(request, 'internal_error', (error as Error).message);
    }
  }

  private handleStatus(request: DaemonRequest): string {
    this.requestsServed += 1;
    this.lastRequestAt = this.now();
    return this.respond(request, {
      type: 'status',
      outcome: 'status',
      daemon: this.statusBody(),
    });
  }

  private async handleStop(request: DaemonRequest): Promise<string> {
    this.requestsServed += 1;
    this.stopping = true;
    this.log(`stop requested by request ${request.id}`);
    const frame = this.respond(request, {
      type: 'stop',
      outcome: 'stopping',
      daemon: this.statusBody(),
    });
    void this.shutdown('stop-request');
    return frame;
  }

  private identityMismatch(request: DaemonRequest): string | null {
    if (request.worktree !== this.identity.worktree) {
      return `request worktree ${request.worktree} does not match daemon worktree ${this.identity.worktree}`;
    }
    if (request.project_root !== this.identity.project_root) {
      return `request project root ${request.project_root} does not match daemon project root ${this.identity.project_root}`;
    }
    if (request.identity_sha256 !== this.identity.identity_sha256) {
      return 'daemon identity digest differs; restart the daemon for the current generation';
    }
    return null;
  }

  private environmentMismatch(
    request: NonNullable<DaemonRequest['environment']>,
  ): string | null {
    for (const key of Object.keys(this.frozenEnvironment).sort()) {
      const mine = this.frozenEnvironment[key];
      const theirs = request[key];
      if (mine !== theirs) {
        return `environment ${key} differs: daemon=${JSON.stringify(mine)} request=${JSON.stringify(theirs)}`;
      }
    }
    return null;
  }

  private async handleRun(request: DaemonRequest): Promise<string> {
    if (this.busy) {
      return this.error(request, 'busy', 'another run is in flight; retry or fall back cold');
    }
    const startedAt = this.now();
    const mismatch = this.identityMismatch(request);
    if (mismatch) {
      return this.error(request, 'identity_mismatch', mismatch);
    }
    const requestedEnvironment = request.environment ?? {};
    const envMismatch = this.environmentMismatch(requestedEnvironment);
    if (envMismatch) {
      return this.error(request, 'environment_mismatch', envMismatch);
    }
    this.busy = true;
    let lease: ManagedInstallLease | undefined;
    let timings = { total_ms: 0, identity_check_ms: 0, acquire_ms: 0, run_ms: 0, recheck_ms: 0 };
    try {
      // Identity before dispatch: HEAD, tree, and closure must match exactly.
      const checkStart = this.now();
      const before = await this.treeSnapshot(this.identity.worktree);
      if (before.head !== request.head || before.digest !== request.tree_digest) {
        return this.error(
          request,
          'tree_race',
          `working tree changed between request and dispatch: head ${before.head} digest ${before.digest.slice(0, 12)}…`,
        );
      }
      const closure = await inputClosureDigest(
        this.identity.project_root,
        request.selected_tests!,
        this.identity.runtime_generation,
      );
      if (closure !== request.input_closure_sha256) {
        return this.error(
          request,
          'stale_closure',
          'input closure digest differs from the request; the selection changed in flight',
        );
      }
      timings.identity_check_ms = this.now() - checkStart;

      // Shared managed-install resources serialize exactly like cold runs.
      const acquireStart = this.now();
      if (requestIntersectsManagedInstallPool(request.selected_tests!)) {
        lease = await this.acquireLease(DEFAULT_MANAGED_INSTALL_WAIT_MS);
      }
      timings.acquire_ms = this.now() - acquireStart;

      const runStart = this.now();
      let results: DaemonRunResults;
      try {
        results = await this.runner.run(request.selected_tests!, {
          timeoutMs: request.timeout_ms!,
        });
      } catch (error) {
        this.stopping = true;
        this.log(`runner failure poisons the warm instance: ${(error as Error).message}`);
        void this.shutdown('runner-failure');
        return this.error(
          request,
          'internal_error',
          `warm run failed: ${(error as Error).message}; daemon is restarting`,
        );
      }
      timings.run_ms = this.now() - runStart;

      // Identity after completion: a mutated tree invalidates the advisory result.
      const recheckStart = this.now();
      const after = await this.treeSnapshot(this.identity.worktree);
      timings.recheck_ms = this.now() - recheckStart;
      timings.total_ms = this.now() - startedAt;
      this.requestsServed += 1;
      this.runsServed += 1;
      this.lastRequestAt = this.now();
      const stable = after.head === before.head && after.digest === before.digest;
      if (!stable) {
        return this.respond(request, {
          type: 'run',
          outcome: 'invalidated',
          results,
          identity_recheck: {
            before_head: before.head,
            before_tree_digest: before.digest,
            after_head: after.head,
            after_tree_digest: after.digest,
            stable: false,
          },
          timings_ms: timings,
          notice:
            'working tree changed during the run; result is invalidated and advisory-only',
        });
      }
      return this.respond(request, {
        type: 'run',
        outcome: results.totals.tests === 0 ? 'no_tests' : 'completed',
        results,
        identity_recheck: {
          before_head: before.head,
          before_tree_digest: before.digest,
          after_head: after.head,
          after_tree_digest: after.digest,
          stable: true,
        },
        timings_ms: timings,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('[test-resource-lock]')) {
        return this.error(
          request,
          'resource_unavailable',
          `managed-install serialization unavailable: ${message}`,
        );
      }
      return this.error(request, 'internal_error', message);
    } finally {
      try {
        await lease?.release();
      } catch {
        // Release failures are logged; the lease self-heals via dead-owner recovery.
      }
      this.busy = false;
    }
  }

  /** Bounded resource limits: request-count and memory ceilings. */
  private withinResourceLimits(): boolean {
    if (this.requestsServed >= this.maxRequests) {
      this.log(`max requests (${this.maxRequests}) reached; stopping`);
      return false;
    }
    const rss = process.memoryUsage.rss();
    if (rss > this.maxRssBytes) {
      this.log(`rss ${rss} exceeds ceiling ${this.maxRssBytes}; stopping`);
      return false;
    }
    return true;
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopping = true;
    this.log(`shutting down: ${reason}`);
    await this.runner.cancel(`daemon-shutdown:${reason}`);
    await this.runner.close();
    this.stopped = true;
    for (const waiter of this.stopWaiters.splice(0)) waiter();
  }

  armIdleShutdown(): void {
    this.idleTimer?.refresh();
    if (!this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        void this.shutdown('idle-timeout');
      }, this.idleTimeoutMs);
      this.idleTimer.unref?.();
    }
  }

  notifyActivity(): void {
    this.lastRequestAt = this.now();
    this.armIdleShutdown();
  }

  /** Serve on a Unix socket with strict NDJSON framing. */
  async listen(socketPath: string, onReady: () => Promise<void> | void): Promise<void> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error(
        `the advisory test daemon requires a Unix socket platform; ${process.platform} must use the cold path`,
      );
    }
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    await fs.rm(socketPath, { force: true });
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
          socket.end(
            `${this.error(null, 'malformed_request', 'frame exceeds the bounded size')}\n`,
          );
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!this.withinResourceLimits()) {
          socket.end(
            `${this.error(null, 'resource_unavailable', 'daemon hit a bounded resource limit and is stopping')}\n`,
          );
          void this.shutdown('resource-limit');
          return;
        }
        this.notifyActivity();
        void this.handleRequest(line)
          .then((response) => {
            if (!socket.destroyed) socket.end(`${response}\n`);
          })
          .catch((error) => {
            this.log(`transport failure: ${(error as Error).stack ?? error}`);
            if (!socket.destroyed) {
              socket.end(
                `${this.error(null, 'internal_error', 'request handling crashed')}\n`,
              );
            }
          });
      });
      socket.on('error', () => socket.destroy());
    });
    server.on('close', () => {
      void fs.rm(socketPath, { force: true }).catch(() => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    this.armIdleShutdown();
    await onReady();
    await new Promise<void>((resolve) => {
      if (this.stopped) resolve();
      else this.stopWaiters.push(resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function requestIntersectsManagedInstallPool(
  selectedTests: readonly string[],
): boolean {
  return selectedTests.some((candidate) =>
    MANAGED_INSTALL_POOL_MATCHERS.some((pattern) => pattern.test(candidate)),
  );
}

function safeParseId(raw: string): DaemonRequest | null {
  try {
    const value = JSON.parse(raw) as { id?: unknown };
    return typeof value.id === 'string' ? ({ id: value.id } as DaemonRequest) : null;
  } catch {
    return null;
  }
}

/**
 * Client for the existing Python cross-process lock protocol (the same
 * authority the cold focused-validation runner uses), so daemon runs and
 * cold runs serialize on one lease for shared managed-install resources.
 */
export async function acquirePythonProtocolLease(
  waitMs: number,
  workload = 'yylo-test-daemon managed-install serialization',
): Promise<ManagedInstallLease> {
  const lockPath =
    process.env.JUNO_TEST_RESOURCE_LOCK_PATH?.trim() ||
    path.join(await fs.realpath(os.tmpdir()), 'yylo-real-git-managed-install.lock');
  const owner = {
    pid: process.pid,
    processBirthId: '',
    token: createHash('sha256')
      .update(`${process.pid}:${Date.now()}:${Math.random()}`)
      .digest('hex'),
    workload,
    process: process.argv.join(' '),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  const call = (action: string, payload: object) =>
    execFileAsync('python3', [
      PYTHON_LOCK_PROTOCOL,
      '--resource-lock-op',
      action,
      lockPath,
      JSON.stringify(payload),
    ]).then(({ stdout }) => JSON.parse(stdout.trim()));

  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = (await call('acquire', owner)) as {
      outcome: string;
      owner?: { _inode?: [number, number] } | null;
    };
    if (result.outcome === 'acquired') {
      const inode = result.owner?._inode;
      return {
        release: async () => {
          try {
            await call('release', { token: owner.token, inode });
          } catch {
            // Dead-owner recovery on the protocol side heals a lost release.
          }
        },
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[test-resource-lock] daemon acquisition timed out after ${waitMs}ms on ${lockPath}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
