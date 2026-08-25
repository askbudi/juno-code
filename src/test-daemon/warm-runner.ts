/**
 * Warm Vitest host for the YYLO advisory test daemon (Wave 2 of PDR 7djT8N).
 *
 * Keeps one Vitest instance (module transform cache, dependency resolution,
 * global-setup fixture state, Python runtime state materialized by the
 * global setup) warm across requests. Runs are dispatched through
 * `rerunFiles`, and structured results are read from Vitest state — never
 * parsed from console output.
 *
 * The Vitest Node API is resolved through `createRequire` anchored at the
 * *project root*, so an installed CLI daemon uses the consumer project's own
 * Vitest instead of bundling a private (and drifting) copy.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import type {
  DaemonFileResult,
  DaemonRunResults,
  DaemonRunTotals,
} from './protocol.js';
import { digestCanonical } from './protocol.js';

export interface WarmRunOptions {
  readonly timeoutMs: number;
  readonly onLateFailure?: (error: Error) => void;
}

export interface WarmRunner {
  readonly kind: string;
  readonly version: string;
  /** Initialize the warm instance once; safe to call exactly once. */
  initialize(): Promise<void>;
  /**
   * Run the selected files. Resolves with structured results. Rejects on
   * infrastructure failure (never on test failure — that is data).
   */
  run(selectedTests: readonly string[], options: WarmRunOptions): Promise<DaemonRunResults>;
  /** Attempt to cancel the in-flight run; best effort. */
  cancel(reason: string): Promise<void>;
  /** Tear the warm instance down; the daemon stops serving afterwards. */
  close(): Promise<void>;
}

export class WarmRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarmRunnerError';
  }
}

interface VitestTask {
  type: string;
  name: string;
  mode?: string;
  result?: { state?: string; duration?: number; errors?: unknown[] } | undefined;
  tasks?: VitestTask[];
}

interface VitestFileTask {
  filepath: string;
  name: string;
  result?: { state?: string; duration?: number } | undefined;
  tasks: VitestTask[];
}

interface VitestNodeApi {
  createVitest: (
    mode: string,
    options: Record<string, unknown>,
  ) => Promise<VitestInstance>;
}

interface VitestInstance {
  init(): Promise<void>;
  rerunFiles(files?: string[], trigger?: string): Promise<void>;
  cancelCurrentRun(reason: string): Promise<void> | void;
  close(): Promise<void>;
  state: {
    getFiles(paths?: string[]): VitestFileTask[];
  };
  config: { root: string };
}

/**
 * Quiet reporter: the daemon emits protocol frames, not console noise.
 * An explicit no-op class (never a Proxy — a Proxy `then` would become an
 * unsettled thenable inside Vitest's reporter await chain).
 */
class QuietReporter {
  onInit(): void {}
  onCollected(): void {}
  onTestFileEnd(): void {}
  onTestFileResult(): void {}
  onFinished(): void {}
  onTaskUpdate(): void {}
  onUserConsoleLog(): void {}
  onWatcherStart(): void {}
  onWatcherRerun(): void {}
  onServerRestart(): void {}
  onBeforeRun(): void {}
  onBeforeTryRun(): void {}
  onAfterRun(): void {}
  onAfterTryRun(): void {}
}

function quietReporter(): Record<string, unknown> {
  return new QuietReporter() as unknown as Record<string, unknown>;
}

function collectTestSummary(file: VitestFileTask): {
  tests: number;
  failed: number;
  passed: number;
  skipped: number;
  failures: string[];
} {
  let tests = 0;
  let failed = 0;
  let passed = 0;
  let skipped = 0;
  const failures: string[] = [];
  const visit = (task: VitestTask): void => {
    if (task.type === 'test') {
      tests += 1;
      // Vitest 1.x task states are the short forms: pass/fail/skip/todo/run.
      const state = task.result?.state ?? task.mode ?? 'skip';
      if (state === 'pass' || state === 'passed') passed += 1;
      else if (state === 'fail' || state === 'failed') {
        failed += 1;
        const message = task.result?.errors?.[0];
        const rendered =
          message && typeof message === 'object' && 'message' in message
            ? String((message as { message?: unknown }).message)
            : task.name;
        failures.push(`${task.name}: ${rendered}`.slice(0, 2048));
      } else skipped += 1;
    }
    for (const child of task.tasks ?? []) visit(child);
  };
  for (const task of file.tasks ?? []) visit(task);
  return { tests, failed, passed, skipped, failures };
}

/** Resolve the consumer project's own Vitest version from its lockfile tree. */
export async function resolveProjectVitestVersion(projectRoot: string): Promise<string> {
  const anchoredRequire = createRequire(path.join(projectRoot, 'package.json'));
  try {
    return (anchoredRequire('vitest/package.json') as { version: string }).version;
  } catch {
    throw new WarmRunnerError(
      `cannot resolve the project's Vitest version from ${projectRoot}`,
    );
  }
}

export class VitestWarmRunner implements WarmRunner {
  readonly kind = 'vitest';
  private readonly projectRoot: string;
  private instance: VitestInstance | undefined;
  private initialization: Promise<void> | undefined;

  constructor(projectRoot: string, readonly version: string) {
    this.projectRoot = projectRoot;
  }

  private async api(): Promise<VitestNodeApi> {
    const anchoredRequire = createRequire(path.join(this.projectRoot, 'package.json'));
    const load = async (): Promise<VitestNodeApi | undefined> => {
      try {
        const api = anchoredRequire('vitest/node') as VitestNodeApi;
        return typeof api?.createVitest === 'function' ? api : undefined;
      } catch {
        return undefined;
      }
    };
    let api = await load();
    if (!api) {
      // Source-checkout fallback: some TypeScript loaders (tsx) patch the
      // CommonJS resolver and mis-resolve Vitest's transitive exports. Import
      // the exact dist artifact by URL instead; installed packages use the
      // ordinary require above.
      try {
        const vitestRoot = path.dirname(
          anchoredRequire.resolve('vitest/package.json'),
        );
        const { pathToFileURL } = await import('node:url');
        const module = (await import(
          pathToFileURL(path.join(vitestRoot, 'dist', 'node.js')).href
        )) as { default?: VitestNodeApi } & VitestNodeApi;
        api = (module.default ?? module) as VitestNodeApi;
      } catch {
        api = undefined;
      }
    }
    if (!api || typeof api.createVitest !== 'function') {
      throw new WarmRunnerError(
        `cannot load the project's Vitest Node API from ${this.projectRoot}`,
      );
    }
    return api;
  }

  async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const api = await this.api();
      const instance = await api.createVitest('test', {
        root: this.projectRoot,
        watch: false,
        // The daemon drives runs itself; suppress Vitest's own lifecycle exits.
        reporters: [quietReporter() as never],
        bail: 0,
        env: {},
      });
      await instance.init();
      this.instance = instance;
    })();
    await this.initialization;
  }

  async run(
    selectedTests: readonly string[],
    options: WarmRunOptions,
  ): Promise<DaemonRunResults> {
    await this.initialize();
    const instance = this.instance;
    if (!instance) throw new WarmRunnerError('warm runner failed to initialize');
    const absolute = selectedTests.map((relative) => path.resolve(this.projectRoot, relative));
    const run = instance.rerunFiles(absolute, 'yylo-test-daemon');
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void instance.cancelCurrentRun('yylo-test-daemon-timeout');
    }, options.timeoutMs);
    try {
      await run;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      throw new WarmRunnerError(
        `run exceeded the bounded timeout of ${options.timeoutMs}ms and was cancelled`,
      );
    }
    return this.collectResults(instance, selectedTests);
  }

  private collectResults(
    instance: VitestInstance,
    selectedTests: readonly string[],
  ): DaemonRunResults {
    const wanted = new Set(selectedTests);
    const files: DaemonFileResult[] = [];
    let totalFiles = 0;
    let totalTests = 0;
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    for (const file of instance.state.getFiles()) {
      const relative = path.relative(this.projectRoot, file.filepath);
      if (!wanted.has(relative)) continue;
      const summary = collectTestSummary(file);
      const status: DaemonFileResult['status'] =
        summary.failed > 0
          ? 'failed'
          : summary.passed > 0
            ? 'passed'
            : 'skipped';
      files.push({
        path: relative.split(path.sep).join('/'),
        status,
        tests: summary.tests,
        failed: summary.failed,
        duration_ms: Math.round(file.result?.duration ?? 0),
        failures: summary.failures.slice(0, 64),
      });
      totalFiles += 1;
      totalTests += summary.tests;
      totalFailed += summary.failed;
      totalPassed += summary.passed;
      totalSkipped += summary.skipped;
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (files.length === 0) {
      throw new WarmRunnerError(
        'vitest reported no results for the selected files; treating as malformed',
      );
    }
    const totals: DaemonRunTotals = {
      files: totalFiles,
      tests: totalTests,
      passed: totalPassed,
      failed: totalFailed,
      skipped: totalSkipped,
    };
    return {
      files,
      totals,
      exit_code: totals.failed > 0 ? 1 : 0,
      results_digest: digestCanonical(files),
    };
  }

  async cancel(reason: string): Promise<void> {
    try {
      await this.instance?.cancelCurrentRun(reason);
    } catch {
      // Cancellation is best effort; the run promise still settles.
    }
  }

  async close(): Promise<void> {
    const instance = this.instance;
    this.instance = undefined;
    try {
      await instance?.close();
    } catch {
      // Closing a cancelled or crashed instance may reject; shutdown continues.
    }
  }
}
