import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import type { Command } from 'commander';
import semver from 'semver';
import packageMetadata from '../../../package.json';

// This is intentionally exact and sourced from release metadata: a Juno Code
// release is validated with one independently packaged benchmark artifact.
export const BENCHMARK_VERSION_RANGE = packageMetadata.junoBenchmark.version;
const BENCHMARK_SEMVER_RANGE = BENCHMARK_VERSION_RANGE;
const VERSION_HANDSHAKE_TIMEOUT_MS = 10_000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
type ForwardedSignal = (typeof SIGNALS)[number];

let activeChild: ChildProcess | undefined;

export class BenchmarkDelegateError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = 'BenchmarkDelegateError';
  }
}

export interface BenchmarkDelegateResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function executableCandidates(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string[] {
  const pathValue = env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  return pathValue.split(path.delimiter).flatMap((entry) => {
    // Empty and relative PATH entries are interpreted from the delegated cwd,
    // matching executable lookup after spawn changes into that directory.
    const directory = path.resolve(cwd, entry || '.');
    return extensions.map((extension) => path.join(directory, `${name}${extension}`));
  });
}

export function discoverBenchmarkExecutable(
  env: NodeJS.ProcessEnv = process.env,
  name = 'juno-benchmark',
  cwd = process.cwd(),
): string {
  for (const candidate of executableCandidates(name, env, cwd)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through PATH. Discovery deliberately has no repository-local fallback.
    }
  }
  throw new BenchmarkDelegateError(
    `juno-code: cannot find independently installed '${name}' on PATH. ` +
      `Install a compatible @juno-ai/juno-benchmark (${BENCHMARK_VERSION_RANGE}) and retry.`,
    127,
  );
}

function waitForChild(
  child: ChildProcess,
  timeout?: { readonly milliseconds: number; readonly description: string },
): Promise<BenchmarkDelegateResult> {
  activeChild = child;
  return new Promise<BenchmarkDelegateResult>((resolve, reject) => {
    let timedOut = false;
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      if (!child.kill('SIGKILL')) {
        reject(new BenchmarkDelegateError(
          `juno-code: ${timeout.description} timed out after ${timeout.milliseconds}ms.`,
          69,
        ));
      }
    }, timeout.milliseconds);
    timer?.unref();
    child.once('error', (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut && timeout !== undefined) {
        reject(new BenchmarkDelegateError(
          `juno-code: ${timeout.description} timed out after ${timeout.milliseconds}ms.`,
          69,
        ));
      } else {
        resolve({ code, signal });
      }
    });
  }).finally(() => {
    if (activeChild === child) activeChild = undefined;
  });
}

/** Called by the CLI's process-level signal handlers while delegation is active. */
export function forwardBenchmarkSignal(signal: ForwardedSignal): boolean {
  if (activeChild === undefined || activeChild.exitCode !== null || activeChild.signalCode !== null) {
    return false;
  }
  activeChild.kill(signal);
  return true;
}

function parseVersion(output: string): string | undefined {
  const match = output.trim().match(/^(?:juno-benchmark\s+)?(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  if (match === null) return undefined;
  return semver.valid(match[1]) ?? undefined;
}

function isCompatibleVersion(version: string): boolean {
  return semver.satisfies(version, BENCHMARK_SEMVER_RANGE);
}

async function readVersion(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const child = spawn(executable, ['--version'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const result = await waitForChild(child, {
    milliseconds: timeoutMs,
    description: `'${executable} --version'`,
  });
  const output = Buffer.concat(stdout).toString('utf8').trim();
  const detail = Buffer.concat(stderr).toString('utf8').trim();
  if (result.signal !== null) terminateWithSignal(result.signal);
  if (result.code !== 0) {
    throw new BenchmarkDelegateError(
      `juno-code: '${executable} --version' failed with exit ${result.code ?? 1}` +
        `${detail ? `: ${detail}` : ''}. Reinstall @juno-ai/juno-benchmark and retry.`,
      69,
    );
  }
  return output;
}

function terminateWithSignal(signal: NodeJS.Signals): never {
  // Juno Code owns generic signal handlers. Remove them only at terminal handoff so
  // the delegate itself has the same signal outcome as the canonical executable.
  for (const forwarded of SIGNALS) process.removeAllListeners(forwarded);
  process.kill(process.pid, signal);
  const number = osConstants.signals[signal] ?? 1;
  process.exit(128 + number);
}

export async function invokeBenchmark(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly executableName?: string;
    readonly versionTimeoutMs?: number;
  } = {},
): Promise<BenchmarkDelegateResult> {
  const cwd = options.cwd ?? process.cwd();
  // The wrapper's preflight marker is scoped to its probe subprocess, so the
  // delegated process can receive an exact copy of the actual caller environment.
  const env = { ...(options.env ?? process.env) };
  const executable = discoverBenchmarkExecutable(env, options.executableName, cwd);
  const output = await readVersion(
    executable,
    cwd,
    env,
    options.versionTimeoutMs ?? VERSION_HANDSHAKE_TIMEOUT_MS,
  );
  const version = parseVersion(output);
  if (version === undefined || !isCompatibleVersion(version)) {
    throw new BenchmarkDelegateError(
      `juno-code: incompatible juno-benchmark version from '${executable}': ` +
        `${output || 'unknown'} (required ${BENCHMARK_VERSION_RANGE}). ` +
        `Install a compatible @juno-ai/juno-benchmark and retry.`,
      69,
    );
  }

  const child = spawn(executable, [...args], { cwd, env, stdio: 'inherit' });
  return waitForChild(child);
}

export async function runBenchmarkDelegate(args: readonly string[]): Promise<void> {
  try {
    const result = await invokeBenchmark(args);
    if (result.signal !== null) terminateWithSignal(result.signal);
    process.exitCode = result.code ?? 1;
  } catch (error) {
    if (error instanceof BenchmarkDelegateError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`juno-code: failed to delegate to juno-benchmark: ${detail}\n`);
    process.exitCode = 126;
  }
}

export function configureBenchmarkCommand(program: Command): void {
  program
    .command('benchmark [args...]')
    .description('Delegate transparently to an independently installed juno-benchmark CLI')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(runBenchmarkDelegate);
}
