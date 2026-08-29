import { spawnSync } from 'node:child_process';

export const MAX_BENCHMARK_RELEASE_COMMAND_TIMEOUT_MS = 300_000;
export const BENCHMARK_RELEASE_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Run one benchmark release command with a bounded wall-clock execution budget. */
export function runBoundedReleaseCommand(command, args, options = {}) {
  const timeout = options.timeout ?? MAX_BENCHMARK_RELEASE_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_BENCHMARK_RELEASE_COMMAND_TIMEOUT_MS) {
    throw new Error(`benchmark release command timeout must be an integer in [1, ${MAX_BENCHMARK_RELEASE_COMMAND_TIMEOUT_MS}]ms`);
  }
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    input: options.input ?? '',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: BENCHMARK_RELEASE_COMMAND_MAX_BUFFER_BYTES,
  });
}
