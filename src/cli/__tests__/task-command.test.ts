import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import {
  checkpointTaskWorkspaceAfterFinalization,
  configureTaskWorkspaceCommand,
} from '../commands/task.js';

describe('task workspace CLI', () => {
  it.each(['start', 'status', 'finish'] as const)(
    'forwards task %s and its positional ID to one managed-runtime invoker',
    async (operation) => {
      const invoke = vi.fn(async () => undefined);
      const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
      configureTaskWorkspaceCommand(program, invoke);
      await program.parseAsync(['node', 'yy', 'task', operation, 'T123']);
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith(operation, 'T123', []);
    },
  );

  it('exposes only start, status, and finish below task', () => {
    const program = new Command();
    configureTaskWorkspaceCommand(program, async () => undefined);
    const task = program.commands.find((command) => command.name() === 'task');
    expect(task?.commands.map((command) => command.name())).toEqual(['start', 'status', 'finish']);
    expect(task?.commands.every((command) => command.registeredArguments[0]?.required)).toBe(true);
  });

  it('forwards repeatable required product roots only for task start', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureTaskWorkspaceCommand(program, invoke);
    await program.parseAsync([
      'node', 'yy', 'task', 'start', 'T123', '--path', 'juno_kanban', '--path', 'frontend',
    ]);
    expect(invoke).toHaveBeenCalledWith('start', 'T123', ['juno_kanban', 'frontend']);
  });

  it.each(['start', 'finish'] as const)(
    'checkpoints durable controller state after task %s without replacing its outcome',
    async (operation) => {
      const checkpoint = vi.fn(async () => ({ attempted: true, ok: true }));
      await checkpointTaskWorkspaceAfterFinalization(operation, '/controller', 0, checkpoint);
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenCalledWith('/controller', 0);
    },
  );

  it('does not checkpoint after read-only task status', async () => {
    const checkpoint = vi.fn(async () => ({ attempted: true, ok: true }));
    await checkpointTaskWorkspaceAfterFinalization('status', '/controller', 0, checkpoint);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('preserves a failed task outcome while the best-effort checkpointer reports recovery', async () => {
    const checkpoint = vi.fn(async () => ({
      attempted: true,
      ok: false,
      warning: 'run controller_checkpoint.py manually',
    }));
    await checkpointTaskWorkspaceAfterFinalization('start', '/controller', 9, checkpoint);
    expect(checkpoint).toHaveBeenCalledWith('/controller', 9);
  });
});
