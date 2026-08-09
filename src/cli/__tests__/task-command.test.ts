import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureTaskWorkspaceCommand } from '../commands/task.js';

describe('task workspace CLI', () => {
  it.each(['start', 'status', 'finish'] as const)(
    'forwards task %s and its positional ID to one managed-runtime invoker',
    async (operation) => {
      const invoke = vi.fn(async () => undefined);
      const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
      configureTaskWorkspaceCommand(program, invoke);
      await program.parseAsync(['node', 'yy', 'task', operation, 'T123']);
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith(operation, 'T123');
    },
  );

  it('exposes only start, status, and finish below task', () => {
    const program = new Command();
    configureTaskWorkspaceCommand(program, async () => undefined);
    const task = program.commands.find((command) => command.name() === 'task');
    expect(task?.commands.map((command) => command.name())).toEqual(['start', 'status', 'finish']);
    expect(task?.commands.every((command) => command.registeredArguments[0]?.required)).toBe(true);
  });
});
