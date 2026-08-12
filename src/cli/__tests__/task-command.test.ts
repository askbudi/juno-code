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

  it('exposes ordinary lifecycle plus bounded umbrella recovery below task', () => {
    const program = new Command();
    configureTaskWorkspaceCommand(program, async () => undefined);
    const task = program.commands.find((command) => command.name() === 'task');
    expect(task?.commands.map((command) => command.name())).toEqual([
      'start', 'status', 'finish', 'recovery-plan', 'recovery-apply',
    ]);
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

  it('forwards umbrella admission and exact recovery plan/apply arguments', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureTaskWorkspaceCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'task', 'start', 'U1',
      '--umbrella-admission', '/tmp/umbrella.json']);
    expect(invoke).toHaveBeenLastCalledWith('start', 'U1', [],
      ['--umbrella-admission', '/tmp/umbrella.json']);
    await program.parseAsync(['node', 'yy', 'task', 'recovery-plan', 'U1',
      '--umbrella-admission', '/tmp/umbrella.json', '--output', '/tmp/plan.json',
      '--authorization-source', 'ticket:1']);
    expect(invoke).toHaveBeenLastCalledWith('recovery-plan', 'U1', [], [
      '--umbrella-admission', '/tmp/umbrella.json', '--output', '/tmp/plan.json',
      '--authorization-source', 'ticket:1',
    ]);
    await program.parseAsync(['node', 'yy', 'task', 'recovery-apply', 'U1',
      '--umbrella-admission', '/tmp/umbrella.json', '--plan', '/tmp/plan.json',
      '--authorization-source', 'ticket:1']);
    expect(invoke).toHaveBeenLastCalledWith('recovery-apply', 'U1', [], [
      '--umbrella-admission', '/tmp/umbrella.json', '--plan', '/tmp/plan.json',
      '--authorization-source', 'ticket:1',
    ]);
  });

  it.each(['start', 'finish', 'recovery-apply'] as const)(
    'checkpoints durable controller state after task %s without replacing its outcome',
    async (operation) => {
      const checkpoint = vi.fn(async () => ({ attempted: true, ok: true }));
      await checkpointTaskWorkspaceAfterFinalization(operation, '/controller', 0, checkpoint);
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenCalledWith('/controller', 0);
    },
  );

  it.each(['status', 'recovery-plan'] as const)('does not checkpoint after read-only task %s', async (operation) => {
    const checkpoint = vi.fn(async () => ({ attempted: true, ok: true }));
    await checkpointTaskWorkspaceAfterFinalization(operation, '/controller', 0, checkpoint);
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
