import { randomUUID } from 'node:crypto';
import { hrtime } from 'node:process';

import {
  INVOCATION_TELEMETRY_SCHEMA_VERSION,
  type InvocationFinishedEvent,
  type InvocationStartedEvent,
  writeInvocationTelemetryEvent,
} from './invocation-telemetry.js';
import {
  normalizeProviderObservations,
  type ProviderObservations,
  unavailableProviderObservations,
} from './provider-observations.js';

export type InvocationStatus = InvocationFinishedEvent['status'];
export type InvocationEventWriter = (
  workingDirectory: string,
  event: InvocationStartedEvent | InvocationFinishedEvent,
  env: NodeJS.ProcessEnv,
) => Promise<unknown>;

export interface InvocationLifecycleOptions {
  workingDirectory: string;
  junoCodeVersion: string;
  launchSurface?: string;
  continuation?: InvocationContinuation;
  env?: NodeJS.ProcessEnv;
  writeEvent?: InvocationEventWriter;
  writeTimeoutMs?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  warn?: (message: string) => void;
}

export interface InvocationExecutionContext {
  workingDirectory?: string;
  service?: string;
  requestedModel?: string | null;
}

/** Private state owned by the canonical shell boundary process. */
export interface InvocationContinuation {
  /** Private wrapper state path, added by the boundary process. */
  stateFile?: string;
  workingDirectory: string;
  identity: {
    schema_version: 1;
    request_id: string;
    trace_id: string;
    span_id: string;
    parent_span_id: null;
    task_id: null;
    workflow_run_id: null;
    workflow_step_id: null;
    launch_surface: string;
    juno_code_version: string;
  };
  startedAt: string;
  startedMonotonicMs: number;
}

export const WRAPPER_LIFECYCLE_ENV = 'JUNO_CODE_WRAPPER_LIFECYCLE';
export const WRAPPER_OBSERVATION_ENV = 'JUNO_CODE_WRAPPER_OBSERVATION';
// Removed legacy path transport must never reach provider descendants.
delete process.env[WRAPPER_OBSERVATION_ENV];

const DEFAULT_WRITE_TIMEOUT_MS = 500;
const KNOWN_LAUNCH_SURFACES = new Set(['juno-code', 'yy', 'ypl']);

function normalizeLaunchSurface(candidate: string | undefined): string {
  const value = candidate?.trim();
  return value && KNOWN_LAUNCH_SURFACES.has(value) ? value : 'juno-code';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns exactly one direct CLI invocation start/finish pair. */
export class InvocationLifecycle {
  private readonly env: NodeJS.ProcessEnv;
  private readonly writer: InvocationEventWriter;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly warn: (message: string) => void;
  private readonly identity;
  private workingDirectory: string;
  private service = 'juno-code';
  private requestedModel: string | null = null;
  private readonly startedAt: string;
  private readonly startedMonotonicMs: number;
  private startPromise: Promise<void> | null = null;
  private finishPromise: Promise<void> | null = null;
  private interrupted = false;
  private terminalStatus: InvocationStatus | undefined;
  private providerObservations: ProviderObservations | null = null;

  constructor(options: InvocationLifecycleOptions) {
    this.env = options.env ?? process.env;
    this.writer = options.writeEvent ?? writeInvocationTelemetryEvent;
    this.timeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    // hrtime is host-monotonic and remains comparable across the wrapper's
    // short-lived boundary process and the selected runtime process.
    this.monotonicNow = options.monotonicNow ?? (() => Number(hrtime.bigint()) / 1_000_000);
    this.warn = options.warn ?? ((message) => console.error(message));
    const continuation = options.continuation;
    this.workingDirectory = continuation?.workingDirectory ?? options.workingDirectory;

    this.identity = continuation?.identity ?? {
      schema_version: INVOCATION_TELEMETRY_SCHEMA_VERSION,
      request_id: randomUUID(),
      trace_id: randomUUID(),
      span_id: randomUUID(),
      parent_span_id: null,
      task_id: null,
      workflow_run_id: null,
      workflow_step_id: null,
      // Launch identity is supplied by the executable boundary, never trusted
      // from ambient/inherited environment.
      launch_surface: normalizeLaunchSurface(options.launchSurface),
      juno_code_version: options.junoCodeVersion,
    } as const;
    this.startedAt = continuation?.startedAt ?? this.now().toISOString();
    this.startedMonotonicMs = continuation?.startedMonotonicMs ?? this.monotonicNow();
    if (continuation) this.startPromise = Promise.resolve();
  }

  configure(context: InvocationExecutionContext): void {
    // Storage identity is fixed by the attempted-invocation boundary. Resolved
    // Commander/config observations may become available later and belong on
    // the terminal event; they never rewrite IDs, timing, or project identity.
    if (!this.startPromise && context.workingDirectory) this.workingDirectory = context.workingDirectory;
    if (context.service) this.service = context.service;
    if (context.requestedModel !== undefined) this.requestedModel = context.requestedModel;
  }

  continuation(): InvocationContinuation {
    return {
      workingDirectory: this.workingDirectory,
      identity: this.identity,
      startedAt: this.startedAt,
      startedMonotonicMs: this.startedMonotonicMs,
    };
  }

  markInterrupted(): void { this.interrupted = true; }
  isInterrupted(): boolean { return this.interrupted; }
  markTerminalStatus(status: InvocationStatus): void { this.terminalStatus = status; }

  /** Capture the completed engine result while it is still structured and in-process. */
  observeProviderResult(result: unknown): void {
    if (this.finishPromise) return;
    this.providerObservations = normalizeProviderObservations(result);
  }

  start(context?: InvocationExecutionContext): Promise<void> {
    if (context) this.configure(context);
    if (!this.startPromise) {
      const event: InvocationStartedEvent = {
        ...this.identity,
        service: this.service,
        requested_model: this.requestedModel,
        event_id: randomUUID(),
        event_type: 'invocation_started',
        recorded_at: this.now().toISOString(),
        started_at: this.startedAt,
        started_monotonic_ms: this.startedMonotonicMs,
      };
      this.startPromise = this.writeBounded(this.workingDirectory, event);
    }
    return this.startPromise;
  }

  finish(exitCode: number, status?: InvocationStatus): Promise<void> {
    if (!this.finishPromise) {
      this.finishPromise = (async () => {
        await this.start();
        const finishedMonotonicMs = this.monotonicNow();
        const truthfulStatus = status ?? (this.interrupted ? 'interrupted' : this.terminalStatus) ?? (
          exitCode === 0 ? 'success' : exitCode === 124 ? 'timeout' : 'failure'
        );
        const finishedAt = this.now().toISOString();
        await this.writeBounded(this.workingDirectory, {
          ...this.identity,
          service: this.service,
          requested_model: this.requestedModel,
          event_id: randomUUID(),
          event_type: 'invocation_finished',
          recorded_at: finishedAt,
          finished_at: finishedAt,
          finished_monotonic_ms: finishedMonotonicMs,
          duration_ms: Math.max(0, finishedMonotonicMs - this.startedMonotonicMs),
          status: truthfulStatus,
          exit_code: exitCode,
          provider_observations: this.providerObservations ?? unavailableProviderObservations(this.service),
        });
      })();
    }
    return this.finishPromise;
  }

  private async writeBounded(
    workingDirectory: string,
    event: InvocationStartedEvent | InvocationFinishedEvent,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.writer(workingDirectory, event, this.env),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`write exceeded ${this.timeoutMs}ms`)), this.timeoutMs);
          timer.unref();
        }),
      ]);
    } catch (error) {
      this.warn(`[juno-code telemetry] ${event.event_type} write failed: ${errorMessage(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

interface ActiveInvocation {
  lifecycle: InvocationLifecycle;
  exitRequested: boolean;
  joins: Set<Promise<unknown>>;
}

let activeInvocation: ActiveInvocation | null = null;

/** Configure and durably start the active invocation before provider dispatch. */
export async function startActiveInvocation(context: InvocationExecutionContext = {}): Promise<boolean> {
  const active = activeInvocation;
  if (!active) return true;
  await active.lifecycle.start(context);
  // Let a signal already delivered in this turn reach the prepended observer
  // before a provider/child dispatch gate is opened.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  return !active.exitRequested;
}

export function joinActiveInvocation(promise: Promise<unknown>): void {
  const active = activeInvocation;
  if (!active) return;
  active.joins.add(promise);
  void promise.finally(() => active.joins.delete(promise)).catch(() => undefined);
}

export function markActiveInvocationTimeout(): void {
  activeInvocation?.lifecycle.markTerminalStatus('timeout');
}

export function observeActiveInvocationProviderResult(result: unknown): void {
  activeInvocation?.lifecycle.observeProviderResult(result);
}

/**
 * Installs one process lifecycle boundary. process.exit is captured as data,
 * rather than thrown through broad command handlers, then performed only after
 * joined child work and the bounded terminal write complete.
 */
export async function runWithInvocationLifecycle(
  lifecycle: InvocationLifecycle,
  run: () => Promise<void>,
  context: InvocationExecutionContext = {},
): Promise<void> {
  const originalExit = process.exit.bind(process);
  const active: ActiveInvocation = { lifecycle, exitRequested: false, joins: new Set() };
  activeInvocation = active;
  let requestedCode: number | null = null;
  let exitTask: Promise<never> | null = null;

  const requestExit = (code?: number | string | null): never => {
    if (requestedCode === null) {
      const candidate = typeof code === 'number' ? code : Number(code ?? process.exitCode ?? 0);
      requestedCode = Number.isInteger(candidate) ? candidate : 1;
      active.exitRequested = true;
      exitTask = (async (): Promise<never> => {
        // Snapshot repeatedly so joins registered by the current synchronous
        // signal turn are observed before finalization.
        await Promise.resolve();
        while (active.joins.size > 0) await Promise.allSettled([...active.joins]);
        await lifecycle.finish(requestedCode!);
        originalExit(requestedCode!);
        throw new Error('process.exit unexpectedly returned');
      })();
    }
    return undefined as never;
  };

  const signalObserver = () => {
    lifecycle.markInterrupted();
    requestExit(0);
  };
  process.prependListener('SIGINT', signalObserver);
  process.prependListener('SIGTERM', signalObserver);
  process.exit = requestExit as typeof process.exit;

  try {
    // The durable start is the common CLI boundary: before Commander, config,
    // bootstrap-facing startup, prompt processing, or provider dispatch.
    await lifecycle.start(context);
    if (exitTask) {
      await exitTask;
      return;
    }
    await run();
    if (exitTask) {
      await exitTask;
      return;
    }
    const naturalCode = Number(process.exitCode ?? 0);
    await lifecycle.finish(Number.isInteger(naturalCode) ? naturalCode : 1);
  } catch (error) {
    if (!active.exitRequested) await lifecycle.finish(99, 'failure');
    throw error;
  } finally {
    process.removeListener('SIGINT', signalObserver);
    process.removeListener('SIGTERM', signalObserver);
    if (activeInvocation === active) activeInvocation = null;
    process.exit = originalExit;
  }
}
