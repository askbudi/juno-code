import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { configureLoopCommand } from '../commands/loop.js';

function successfulResult() {
  return {
    loopId: 'test-loop', completed: 1, failed: 0, skipped: 0, exitCode: 0, interrupted: null,
  };
}

describe('loop command', () => {
  it('collects repeated inline steps without consuming global -i', async () => {
    const invoke = vi.fn().mockResolvedValue(successfulResult());
    const program = new Command().exitOverride();
    configureLoopCommand(program, invoke);
    await program.parseAsync([
      'node', 'test', 'loop', '-n', '2', '--step', 'echo one', '--step', 'echo two',
      '--continuity', 'run', '--on-error', 'stop',
    ]);
    expect(invoke).toHaveBeenCalledWith({
      iterations: '2', steps: ['echo one', 'echo two'], continuity: 'run', onError: 'stop',
    });
  });

  it('routes workflow input and CLI overrides', async () => {
    const invoke = vi.fn().mockResolvedValue(successfulResult());
    const program = new Command().exitOverride();
    configureLoopCommand(program, invoke);
    await program.parseAsync([
      'node', 'test', 'loop', '--workflow', 'flow.yaml', '-n', '3', '--continuity', 'shell',
    ]);
    expect(invoke).toHaveBeenCalledWith({
      workflow: 'flow.yaml', iterations: '3', continuity: 'shell',
    });
  });

  it('propagates the aggregate loop exit code', async () => {
    const prior = process.exitCode;
    process.exitCode = undefined;
    const invoke = vi.fn().mockResolvedValue({ ...successfulResult(), exitCode: 7, failed: 1 });
    const program = new Command().exitOverride();
    configureLoopCommand(program, invoke);
    try {
      await program.parseAsync(['node', 'test', 'loop', '-n', '1', '--step', 'false']);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = prior;
    }
  });
});
