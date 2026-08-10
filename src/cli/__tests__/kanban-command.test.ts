import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureKanbanCommand } from '../commands/kanban.js';

describe('kanban facade CLI', () => {
  it('forwards arbitrary canonical wrapper arguments without interpreting them', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureKanbanCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'kanban', 'create', '--body-file', '-', '--status', 'todo']);
    expect(invoke).toHaveBeenCalledWith(['create', '--body-file', '-', '--status', 'todo']);
  });
});
