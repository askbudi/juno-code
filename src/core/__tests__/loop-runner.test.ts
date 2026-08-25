import { PassThrough } from 'node:stream';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeLoopInput,
  runLoop,
  type LoopDefinition,
  type LoopStepExecutor,
} from '../loop-runner.js';

const temporaryDirectories: string[] = [];

async function workflow(contents: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yylo-loop-'));
  temporaryDirectories.push(directory);
  const target = path.join(directory, 'loop.yaml');
  await fs.writeFile(target, contents);
  return target;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.remove(directory)));
});

function sink(): PassThrough {
  const stream = new PassThrough();
  stream.resume();
  return stream;
}

describe('loop input normalization', () => {
  it('normalizes equivalent inline and YAML workflows through one contract', async () => {
    const target = await workflow('iterations: 2\nsteps:\n  - run: echo one\n  - run: echo two\n');
    const inline = await normalizeLoopInput({ iterations: '2', steps: ['echo one', 'echo two'] });
    const fromYaml = await normalizeLoopInput({ workflow: target });
    expect(fromYaml).toEqual(inline);
    expect(inline).toMatchObject({ continuity: 'iteration', onError: 'continue' });
  });

  it('applies CLI overrides while retaining per-step YAML policy', async () => {
    const target = await workflow(`
iterations: 2
continuity: shell
on_error: continue
steps:
  - run: exit 3
    on_error: stop
`);
    await expect(normalizeLoopInput({
      workflow: target, iterations: '3', continuity: 'run', onError: 'stop',
    })).resolves.toEqual({
      iterations: 3,
      continuity: 'run',
      onError: 'stop',
      steps: [{ run: 'exit 3', onError: 'stop' }],
    });
  });

  it.each([
    [{}, 'provide either'],
    [{ iterations: '1', steps: [], workflow: 'x' }, 'cannot be combined'],
    [{ iterations: '0', steps: ['echo ok'] }, 'positive integer'],
    [{ iterations: '1.5', steps: ['echo ok'] }, 'positive integer'],
    [{ iterations: '1', steps: [''] }, 'nonempty string'],
    [{ iterations: '1', steps: ['echo ok'], continuity: 'other' }, 'continuity must'],
    [{ iterations: '1', steps: ['echo ok'], onError: 'retry' }, '--on-error must'],
  ] as const)('rejects invalid inline input before execution', async (input, message) => {
    await expect(normalizeLoopInput(input)).rejects.toThrow(message);
  });

  it('rejects unreadable, malformed, and unknown-field workflows', async () => {
    await expect(normalizeLoopInput({ workflow: '/missing/loop.yaml' })).rejects.toThrow('cannot read');
    const malformed = await workflow('steps: [unterminated');
    await expect(normalizeLoopInput({ workflow: malformed })).rejects.toThrow('malformed');
    const unknown = await workflow('iterations: 1\nunknown: true\nsteps:\n  - run: echo ok\n');
    await expect(normalizeLoopInput({ workflow: unknown })).rejects.toThrow('unknown field');
    const stepUnknown = await workflow('iterations: 1\nsteps:\n  - run: echo ok\n    retry: 2\n');
    await expect(normalizeLoopInput({ workflow: stepUnknown })).rejects.toThrow('steps[0] contains unknown');
  });
});

describe('loop execution', () => {
  const base: LoopDefinition = {
    iterations: 2,
    continuity: 'iteration',
    onError: 'continue',
    steps: [{ run: 'yy pi "start"' }, { run: 'yy cc "continue"' }],
  };

  it('preserves command text and shares scope within, but not across, iterations', async () => {
    const calls: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    const execute: LoopStepExecutor = async (command, env) => {
      calls.push({ command, env });
      return { exitCode: 0, signal: null };
    };
    const result = await runLoop(base, sink(), execute);
    expect(calls.map((call) => call.command)).toEqual([
      'yy pi "start"', 'yy cc "continue"', 'yy pi "start"', 'yy cc "continue"',
    ]);
    expect(calls[0]!.env.YYLO_CONTINUE_SCOPE).toBe(calls[1]!.env.YYLO_CONTINUE_SCOPE);
    expect(calls[2]!.env.YYLO_CONTINUE_SCOPE).toBe(calls[3]!.env.YYLO_CONTINUE_SCOPE);
    expect(calls[0]!.env.YYLO_CONTINUE_SCOPE).not.toBe(calls[2]!.env.YYLO_CONTINUE_SCOPE);
    expect(calls[3]!.env).toMatchObject({
      YYLO_ITERATION: '2', YYLO_ITERATION_COUNT: '2', YYLO_STEP: '2', YYLO_STEP_COUNT: '2',
    });
    expect(result).toMatchObject({ completed: 4, failed: 0, skipped: 0, exitCode: 0 });
  });

  it('uses one run scope and preserves the inherited shell scope', async () => {
    const scopes: Array<string | undefined> = [];
    const execute: LoopStepExecutor = async (_command, env) => {
      scopes.push(env.YYLO_CONTINUE_SCOPE);
      return { exitCode: 0, signal: null };
    };
    await runLoop({ ...base, continuity: 'run' }, sink(), execute);
    expect(new Set(scopes).size).toBe(1);

    const inherited = process.env.YYLO_CONTINUE_SCOPE;
    process.env.YYLO_CONTINUE_SCOPE = 'caller-owned';
    try {
      scopes.length = 0;
      await runLoop({ ...base, continuity: 'shell' }, sink(), execute);
      expect(scopes).toEqual(Array(4).fill('caller-owned'));
    } finally {
      if (inherited === undefined) delete process.env.YYLO_CONTINUE_SCOPE;
      else process.env.YYLO_CONTINUE_SCOPE = inherited;
    }
  });

  it('skips the failed iteration remainder, continues, and returns the failure', async () => {
    let call = 0;
    const execute: LoopStepExecutor = async () => {
      call += 1;
      return { exitCode: call === 2 ? 7 : 0, signal: null };
    };
    const result = await runLoop({ ...base, steps: [...base.steps, { run: 'never-in-first' }] }, sink(), execute);
    expect(call).toBe(5);
    expect(result).toMatchObject({ completed: 4, failed: 1, skipped: 1, exitCode: 7 });
  });

  it('honors global and per-step stop without launching later commands', async () => {
    const commands: string[] = [];
    const execute: LoopStepExecutor = async (command) => {
      commands.push(command);
      return { exitCode: 9, signal: null };
    };
    const result = await runLoop({ ...base, onError: 'stop' }, sink(), execute);
    expect(commands).toEqual(['yy pi "start"']);
    expect(result).toMatchObject({ failed: 1, skipped: 3, exitCode: 9 });

    commands.length = 0;
    await runLoop({ ...base, steps: [{ run: 'first', onError: 'stop' }, { run: 'later' }] }, sink(), execute);
    expect(commands).toEqual(['first']);
  });

  it('treats interruption as terminal and launches nothing further', async () => {
    let calls = 0;
    const execute: LoopStepExecutor = async () => {
      calls += 1;
      return { exitCode: 143, signal: 'SIGTERM' };
    };
    const result = await runLoop(base, sink(), execute);
    expect(calls).toBe(1);
    expect(result).toMatchObject({ failed: 1, skipped: 3, exitCode: 143, interrupted: 'SIGTERM' });
  });
});
