import { fstatSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  InvocationLifecycle,
  WRAPPER_LIFECYCLE_ENV,
  type InvocationContinuation,
  type InvocationStatus,
} from '../core/invocation-lifecycle.js';
import { version } from '../version.js';

function launchSurface(): string {
  const executable = basename(process.argv0);
  return executable === 'yy' || executable === 'ypl' ? executable : 'yylo';
}

function validState(value: unknown): value is InvocationContinuation {
  const state = value as InvocationContinuation;
  return Boolean(state && typeof state.workingDirectory === 'string' &&
    typeof state.startedAt === 'string' && Number.isFinite(state.startedMonotonicMs) &&
    state.identity?.schema_version === 1 && typeof state.identity.request_id === 'string' &&
    typeof state.identity.trace_id === 'string' && typeof state.identity.span_id === 'string');
}

async function main(): Promise<void> {
  const [mode = 'start', first = process.cwd(), stateFile, explicitStatus] = process.argv.slice(2);
  if (!stateFile) throw new Error('missing private boundary state path');

  if (mode === 'finish') {
    const descriptor = Number(process.env[WRAPPER_LIFECYCLE_ENV]);
    if (!Number.isInteger(descriptor) || descriptor < 3) throw new Error('missing wrapper lifecycle capability');
    const [descriptorStat, pathStat] = await Promise.all([Promise.resolve(fstatSync(descriptor)), stat(stateFile)]);
    if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
      throw new Error('wrapper lifecycle capability mismatch');
    }
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as unknown;
    if (!validState(parsed) || parsed.stateFile !== stateFile) throw new Error('invalid private boundary state');
    const lifecycle = new InvocationLifecycle({
      workingDirectory: parsed.workingDirectory,
      junoCodeVersion: parsed.identity.juno_code_version,
      continuation: parsed,
    });
    const status = ['success', 'failure', 'timeout', 'interrupted'].includes(explicitStatus ?? '')
      ? explicitStatus as InvocationStatus
      : undefined;
    await lifecycle.finish(Number(first), status);
    return;
  }

  const lifecycle = new InvocationLifecycle({
    workingDirectory: first,
    junoCodeVersion: version,
    launchSurface: launchSurface(),
  });
  await lifecycle.start();
  await writeFile(stateFile, JSON.stringify({ ...lifecycle.continuation(), stateFile }), { mode: 0o600 });
}

void main().catch((error) => {
  console.error(`[yylo telemetry] invocation boundary failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
