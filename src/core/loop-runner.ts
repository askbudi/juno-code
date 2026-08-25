import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'fs-extra';
import yaml from 'js-yaml';

import { CONTINUE_SCOPE_OVERRIDE_ENV_KEY } from './continue-scope.js';

export type LoopContinuity = 'iteration' | 'run' | 'shell';
export type LoopErrorPolicy = 'continue' | 'stop';

export interface LoopStep {
  run: string;
  onError?: LoopErrorPolicy;
}

export interface LoopDefinition {
  iterations: number;
  continuity: LoopContinuity;
  onError: LoopErrorPolicy;
  steps: LoopStep[];
}

export interface LoopInput {
  iterations?: string | number;
  steps?: string[];
  workflow?: string;
  continuity?: string;
  onError?: string;
}

export interface LoopResult {
  loopId: string;
  completed: number;
  failed: number;
  skipped: number;
  exitCode: number;
  interrupted: NodeJS.Signals | null;
}

export interface LoopStepResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export type LoopStepExecutor = (
  command: string,
  env: NodeJS.ProcessEnv,
  setActive: (child: ChildProcess | null) => void,
) => Promise<LoopStepResult>;

const TOP_LEVEL_KEYS = new Set(['iterations', 'continuity', 'on_error', 'steps']);
const STEP_KEYS = new Set(['run', 'on_error']);
const CONTINUITIES = new Set<LoopContinuity>(['iteration', 'run', 'shell']);
const ERROR_POLICIES = new Set<LoopErrorPolicy>(['continue', 'stop']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.sort().join(', ')}`);
}

function parseIterations(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('iterations must be a positive integer');
  }
  return parsed;
}

function parseContinuity(value: unknown): LoopContinuity {
  if (typeof value !== 'string' || !CONTINUITIES.has(value as LoopContinuity)) {
    throw new Error('continuity must be one of: iteration, run, shell');
  }
  return value as LoopContinuity;
}

function parseErrorPolicy(value: unknown, label = 'on_error'): LoopErrorPolicy {
  if (typeof value !== 'string' || !ERROR_POLICIES.has(value as LoopErrorPolicy)) {
    throw new Error(`${label} must be one of: continue, stop`);
  }
  return value as LoopErrorPolicy;
}

function parseSteps(value: unknown): LoopStep[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('steps must be a nonempty list');
  return value.map((raw, index) => {
    const step = record(raw, `steps[${index}]`);
    rejectUnknownKeys(step, STEP_KEYS, `steps[${index}]`);
    if (typeof step.run !== 'string' || step.run.trim().length === 0) {
      throw new Error(`steps[${index}].run must be a nonempty string`);
    }
    return {
      run: step.run,
      ...(step.on_error === undefined ? {} : { onError: parseErrorPolicy(step.on_error, `steps[${index}].on_error`) }),
    };
  });
}

export async function normalizeLoopInput(input: LoopInput): Promise<LoopDefinition> {
  const hasWorkflow = input.workflow !== undefined;
  const hasInlineSteps = input.steps !== undefined;
  if (hasWorkflow && hasInlineSteps) throw new Error('--workflow cannot be combined with --step');
  if (!hasWorkflow && !hasInlineSteps) throw new Error('provide either --workflow FILE or one or more --step commands');

  let source: Record<string, unknown>;
  if (hasWorkflow) {
    const workflowPath = input.workflow!;
    let text: string;
    try {
      text = await fs.readFile(workflowPath, 'utf8');
    } catch (error) {
      throw new Error(`cannot read loop workflow '${workflowPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
    let loaded: unknown;
    try {
      loaded = yaml.load(text);
    } catch (error) {
      throw new Error(`malformed loop workflow '${workflowPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
    source = record(loaded, 'workflow');
    rejectUnknownKeys(source, TOP_LEVEL_KEYS, 'workflow');
  } else {
    source = {
      iterations: input.iterations,
      steps: input.steps!.map((run) => ({ run })),
    };
  }

  const iterations = input.iterations === undefined ? source.iterations : input.iterations;
  if (iterations === undefined) throw new Error('iterations is required');
  const continuity = input.continuity === undefined
    ? (source.continuity === undefined ? 'iteration' : parseContinuity(source.continuity))
    : parseContinuity(input.continuity);
  const onError = input.onError === undefined
    ? (source.on_error === undefined ? 'continue' : parseErrorPolicy(source.on_error))
    : parseErrorPolicy(input.onError, '--on-error');

  return {
    iterations: parseIterations(iterations),
    continuity,
    onError,
    steps: parseSteps(source.steps),
  };
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process-group signalling is unavailable.
    }
  }
  try { child.kill(signal); } catch { /* The child may already be terminal. */ }
}

async function runShellStep(command: string, env: NodeJS.ProcessEnv, setActive: (child: ChildProcess | null) => void): Promise<LoopStepResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      env,
      shell: true,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    setActive(child);
    let settled = false;
    const finish = (result: LoopStepResult) => {
      if (settled) return;
      settled = true;
      setActive(null);
      resolve(result);
    };
    child.once('error', () => finish({ exitCode: 1, signal: null }));
    child.once('exit', (code, signal) => finish({
      exitCode: signal ? signalExitCode(signal) : (code ?? 1),
      signal,
    }));
  });
}

export async function runLoop(
  definition: LoopDefinition,
  output: NodeJS.WritableStream = process.stderr,
  executeStep: LoopStepExecutor = runShellStep,
): Promise<LoopResult> {
  const loopId = randomUUID();
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let firstFailure = 0;
  let interrupted: NodeJS.Signals | null = null;
  let activeChild: ChildProcess | null = null;
  const runScope = `yylo-loop:${loopId}`;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (interrupted === null) interrupted = signal;
    if (activeChild) terminateChild(activeChild, signal);
  };
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  process.prependListener('SIGINT', onSigint);
  process.prependListener('SIGTERM', onSigterm);

  try {
    outer: for (let iteration = 1; iteration <= definition.iterations; iteration += 1) {
      const iterationScope = `${runScope}:iteration:${iteration}`;
      for (let stepIndex = 1; stepIndex <= definition.steps.length; stepIndex += 1) {
        if (interrupted) {
          skipped += ((definition.iterations - iteration) * definition.steps.length) + (definition.steps.length - stepIndex + 1);
          break outer;
        }
        const step = definition.steps[stepIndex - 1]!;
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          YYLO_LOOP_ID: loopId,
          YYLO_ITERATION: String(iteration),
          YYLO_ITERATION_COUNT: String(definition.iterations),
          YYLO_STEP: String(stepIndex),
          YYLO_STEP_COUNT: String(definition.steps.length),
        };
        if (definition.continuity === 'run') env[CONTINUE_SCOPE_OVERRIDE_ENV_KEY] = runScope;
        else if (definition.continuity === 'iteration') env[CONTINUE_SCOPE_OVERRIDE_ENV_KEY] = iterationScope;

        const result = await executeStep(step.run, env, (child) => { activeChild = child; });
        if (result.exitCode === 0 && !result.signal) {
          completed += 1;
          continue;
        }
        failed += 1;
        if (firstFailure === 0) firstFailure = result.exitCode || 1;
        if (result.signal && interrupted === null) interrupted = result.signal;
        const policy = step.onError ?? definition.onError;
        if (interrupted || policy === 'stop') {
          skipped += ((definition.iterations - iteration) * definition.steps.length) + (definition.steps.length - stepIndex);
          break outer;
        }
        skipped += definition.steps.length - stepIndex;
        continue outer;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  const exitCode = interrupted ? signalExitCode(interrupted) : firstFailure;
  output.write(`Loop ${loopId}: completed=${completed} failed=${failed} skipped=${skipped} status=${exitCode === 0 ? 'passed' : 'failed'}\n`);
  return { loopId, completed, failed, skipped, exitCode, interrupted };
}
