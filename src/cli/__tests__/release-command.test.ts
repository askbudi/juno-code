import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureReleaseTrainCommand } from '../commands/release.js';

describe('release train CLI', () => {
  it.each(['plan', 'status'] as const)('forwards %s with stable projection options', async (operation) => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureReleaseTrainCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'release', 'train', operation, '/train.json',
      '--json', '--output', '/plan.json']);
    expect(invoke).toHaveBeenCalledWith(operation, '/train.json', ['--json', '--output', '/plan.json']);
  });
});
