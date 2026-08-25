import { Command } from 'commander';

import {
  normalizeLoopInput,
  runLoop,
  type LoopInput,
  type LoopResult,
} from '../../core/loop-runner.js';

export type LoopInvoker = (input: LoopInput) => Promise<LoopResult>;

export async function invokeLoop(input: LoopInput): Promise<LoopResult> {
  const definition = await normalizeLoopInput(input);
  return runLoop(definition);
}

function collectStep(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function configureLoopCommand(program: Command, invoke: LoopInvoker = invokeLoop): void {
  program.command('loop')
    .description('Repeat an ordered sequence of arbitrary shell commands')
    .option('-n, --iterations <count>', 'Number of outer workflow iterations')
    .option('--step <command>', 'Shell command to run (repeatable)', collectStep, [])
    .option('--workflow <file>', 'YAML workflow file')
    .option('--continuity <mode>', 'Continuity scope: iteration, run, or shell')
    .option('--on-error <policy>', 'Failure policy: continue or stop')
    .action(async (options: {
      iterations?: string;
      step: string[];
      workflow?: string;
      continuity?: string;
      onError?: string;
    }) => {
      const result = await invoke({
        ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
        ...(options.step.length === 0 ? {} : { steps: options.step }),
        ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
        ...(options.continuity === undefined ? {} : { continuity: options.continuity }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      });
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });
}
