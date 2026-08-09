import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureMergeQueueCommand, requireExactMergeController } from '../commands/merge.js';

describe('merge queue CLI', () => {
  it.each([
    { argv: ['status'], expected: ['status'] },
    { argv: ['next'], expected: ['next'] },
    { argv: ['resolve', 'T123'], expected: ['resolve', 'T123'] },
  ] as const)('forwards merge $argv', async ({ argv, expected }) => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureMergeQueueCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'merge', ...argv]);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(...expected);
  });

  it('keeps TASK_ID exclusive to resolve', () => {
    const program = new Command();
    configureMergeQueueCommand(program, async () => undefined);
    const merge = program.commands.find((command) => command.name() === 'merge');
    expect(merge?.commands.map((command) => command.name())).toEqual(['status', 'next', 'resolve']);
    expect(merge?.commands[0]?.registeredArguments).toHaveLength(0);
    expect(merge?.commands[1]?.registeredArguments).toHaveLength(0);
    expect(merge?.commands[2]?.registeredArguments[0]?.required).toBe(true);
  });

  it('fails closed unless the installed resolver proves the exact controller root', () => {
    const valid = {
      resolver: 'installed', valid: true, role: 'controller', path: '/controller',
      current_root: '/controller', source: 'registration', expected_branch: null,
      actual_branch: null, enforcement: 'strict', operation: 'orchestration', diagnostics: [],
    } as const;
    expect(requireExactMergeController(valid)).toBe('/controller');
    for (const patch of [
      { resolver: 'missing' },
      { valid: false },
      { role: 'task' },
      { role: 'integration-owner' },
      { path: '/controller', current_root: '/task' },
    ] as const) {
      expect(() => requireExactMergeController({ ...valid, ...patch } as never)).toThrow(
        'installed resolver and the exact canonical controller root',
      );
    }
  });
});
