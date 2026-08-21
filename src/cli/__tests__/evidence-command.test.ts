import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureEvidenceCommand } from '../commands/evidence.js';

describe('standing evidence CLI', () => {
  it.each([
    ['run', 'evidence-run'],
    ['status', 'evidence-status'],
    ['await', 'evidence-await'],
  ] as const)('routes evidence %s through the task runtime', async (command, operation) => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const program = new Command().exitOverride();
    configureEvidenceCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'evidence', command, 'T123']);
    expect(invoke).toHaveBeenCalledWith(operation, 'T123', []);
  });
});
