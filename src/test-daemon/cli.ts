/**
 * CLI surface for the advisory test daemon (Wave 2 of PDR 7djT8N).
 *
 * `yy test daemon start|status|stop` manages the bounded warm validator.
 * `yy test affected [paths...]` runs the affected edit loop: warm when the
 * daemon is available (auto-started unless disabled), cold otherwise. Every
 * result is printed with an explicit advisory marker — lifecycle admission
 * remains on the cold, receipt-bound path.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { selectAffectedTests } from './affected.js';
import {
  daemonRun,
  daemonStatus,
  daemonStop,
  layoutFor,
  runColdFallback,
  startDaemon,
} from './client.js';
import { runDaemonServe } from './entry.js';
import {
  dependencyLockDigest,
  daemonIdentityFromParts,
  resolveRepositoryTopology,
  runtimeGenerationDigest,
  toolchainIdentity,
} from './identity.js';
import { resolveProjectVitestVersion } from './warm-runner.js';
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonIdentity,
  type DaemonResponse,
} from './protocol.js';

export interface TestDaemonCliOptions {
  readonly json?: boolean;
  readonly force?: boolean;
  readonly idleTimeoutMs?: number | string;
  readonly maxRequests?: number | string;
  readonly timeoutMs?: number | string;
  readonly changedBase?: string;
  readonly useDaemon?: boolean;
}

function positiveInteger(
  value: number | string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const RUN_TIMEOUT_DEFAULT_MS = 300_000;

export async function resolveDaemonIdentity(
  projectRoot: string,
  vitestVersion: string,
): Promise<DaemonIdentity> {
  const topology = await resolveRepositoryTopology(projectRoot);
  const lock = await dependencyLockDigest(projectRoot);
  const runtime = await runtimeGenerationDigest(projectRoot, vitestVersion);
  return daemonIdentityFromParts(
    DAEMON_PROTOCOL_VERSION,
    topology,
    projectRoot,
    lock,
    runtime,
    toolchainIdentity(),
  );
}

export async function runTestDaemonCommand(
  args: readonly string[],
  options: TestDaemonCliOptions,
): Promise<void> {
  const [operation, ...rest] = args;
  const projectRoot = await fs.realpath(process.cwd());
  const vitestVersion = await resolveProjectVitestVersion(projectRoot);
  const identity = await resolveDaemonIdentity(projectRoot, vitestVersion);
  const layout = layoutFor(identity);

  if (operation === '_serve') {
    process.exitCode = await runDaemonServe(rest);
    return;
  }

  switch (operation) {
    case 'start': {
  const idleTimeoutMs = positiveInteger(options.idleTimeoutMs);
  const maxRequests = positiveInteger(options.maxRequests);
      const result = await startDaemon(identity, {
        ...(options.force === true ? { force: true } : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        ...(maxRequests !== undefined ? { maxRequests } : {}),
      });
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              schema_version: 'juno.test.daemon.start.v1',
              outcome: result.outcome,
              identity_sha256: identity.identity_sha256,
              directory: layout.directory,
              pid: result.childPid ?? null,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(chalk.blue.bold('🧪 YYLO advisory test daemon'));
      console.log(`   outcome: ${result.outcome}`);
      console.log(`   identity: ${identity.identity_sha256.slice(0, 12)}`);
      console.log(`   directory: ${layout.directory}`);
      console.log(
        chalk.gray('   advisory-only: lifecycle admission stays on the cold path'),
      );
      return;
    }
    case 'status': {
      const started = Date.now();
      const response = await daemonStatus(identity);
      const elapsedMs = Date.now() - started;
      if (options.json) {
        console.log(JSON.stringify({ ...response, status_elapsed_ms: elapsedMs }, null, 2));
        return;
      }
      console.log(chalk.blue.bold('🧪 YYLO advisory test daemon status'));
      if (response.daemon) {
        console.log(`   protocol: ${response.daemon.protocol_version}`);
        console.log(`   identity: ${response.daemon.identity_sha256.slice(0, 12)}`);
        console.log(`   runner: ${response.daemon.runner.kind}@${response.daemon.runner.version}`);
        console.log(`   pid: ${response.daemon.pid}`);
        console.log(`   started_at: ${response.daemon.started_at}`);
        console.log(`   requests_served: ${response.daemon.requests_served}`);
        console.log(`   runs_served: ${response.daemon.runs_served}`);
        console.log(`   idle_shutdown_at: ${response.daemon.idle_shutdown_at}`);
        console.log(`   status_elapsed_ms: ${elapsedMs}`);
      }
      return;
    }
    case 'stop': {
      const { response, note } = await daemonStop(identity);
      if (options.json) {
        console.log(
          JSON.stringify({ schema_version: 'juno.test.daemon.stop.v1', note }, null, 2),
        );
        return;
      }
      console.log(chalk.blue.bold('🧪 YYLO advisory test daemon stop'));
      console.log(`   acknowledged: ${response?.outcome ?? 'no-listener'}`);
      console.log(`   ${note}`);
      return;
    }
    default:
      throw new Error(
        `unknown daemon operation ${JSON.stringify(operation ?? '')}; expected start, status, or stop`,
      );
  }
}

export interface AffectedRunSummary {
  readonly path: 'warm' | 'cold';
  readonly exit_code: number;
  readonly invalidated?: boolean;
  readonly error_code?: string;
}

export async function runTestAffectedCommand(
  args: readonly string[],
  options: TestDaemonCliOptions,
  exit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<AffectedRunSummary> {
  const projectRoot = await fs.realpath(process.cwd());
  const vitestVersion = await resolveProjectVitestVersion(projectRoot);
  const identity = await resolveDaemonIdentity(projectRoot, vitestVersion);

  let selectedTests: string[];
  if (args.length > 0) {
    selectedTests = args.map((entry) =>
      path.isAbsolute(entry)
        ? path.relative(projectRoot, entry).split(path.sep).join('/')
        : entry,
    );
  } else {
    const selection = await selectAffectedTests(
      projectRoot,
      identity.worktree,
      options.changedBase ?? 'HEAD',
    );
    selectedTests = [...selection.selected_tests];
    if (!options.json) {
      console.log(chalk.gray(`   base: ${selection.base}`));
      console.log(
        chalk.gray(`   changed files: ${selection.changed_files.length}`),
      );
      console.log(
        chalk.gray(`   affected tests: ${selectedTests.length}`),
      );
    }
  }
  if (selectedTests.length === 0) {
    console.log(
      chalk.gray(
        '[test-daemon] no affected tests selected; nothing to run (advisory)',
      ),
    );
    exit(0);
    return { path: 'warm', exit_code: 0 };
  }

  const useDaemon = options.useDaemon !== false;
  if (useDaemon) {
    try {
      await startDaemon(identity);
    } catch (error) {
      if (!options.json) {
        console.log(
          chalk.yellow(
            `[test-daemon] warm start unavailable (${(error as Error).message.split('\n')[0]}); falling back cold`,
          ),
        );
      }
    }
  }

  if (useDaemon) {
    try {
      const response = await daemonRun(
        {
          identity,
          selectedTests,
          timeoutMs: positiveInteger(options.timeoutMs) ?? RUN_TIMEOUT_DEFAULT_MS,
          commandArgv: ['npm', 'test', '--', ...selectedTests],
        },
        (positiveInteger(options.timeoutMs) ?? RUN_TIMEOUT_DEFAULT_MS) + 30_000,
      );
      if (response.type === 'run') {
        printWarmResults(response, options.json ?? false);
        const code = response.outcome === 'invalidated' ? 1 : (response.results?.exit_code ?? 1);
        exit(code);
        return {
          path: 'warm',
          exit_code: code,
          invalidated: response.outcome === 'invalidated',
        };
      }
      if (!options.json) {
        console.log(
          chalk.yellow(
            `[test-daemon] warm path refused (${response.error?.code ?? response.outcome}); falling back cold`,
          ),
        );
      }
    } catch (error) {
      if (!options.json) {
        console.log(
          chalk.yellow(
            `[test-daemon] warm path unavailable (${(error as Error).message.split('\n')[0]}); falling back cold`,
          ),
        );
      }
    }
  }

  const cold = await runColdFallback(projectRoot, selectedTests);
  exit(cold.exitCode);
  return { path: 'cold', exit_code: cold.exitCode };
}

function printWarmResults(response: DaemonResponse, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  const results = response.results;
  console.log(chalk.blue.bold('🧪 YYLO affected tests (warm, advisory)'));
  for (const file of results?.files ?? []) {
    const icon =
      file.status === 'passed' ? chalk.green('✓') : chalk.red('✗');
    console.log(
      `   ${icon} ${file.path} (${file.tests} tests, ${Math.round(file.duration_ms)}ms)`,
    );
    for (const failure of file.failures.slice(0, 5)) {
      console.log(chalk.red(`       ${(failure.split('\n')[0] ?? failure).slice(0, 200)}`));
    }
  }
  if (results) {
    console.log(
      `   totals: ${results.totals.tests} tests, ${results.totals.failed} failed (${response.timings_ms?.total_ms ?? 0}ms warm)`,
    );
  }
  if (response.outcome === 'invalidated') {
    console.log(
      chalk.yellow('   invalidated: the working tree changed during the run'),
    );
  }
  console.log(
    chalk.gray('   advisory-only: lifecycle admission requires the cold receipt path'),
  );
}
