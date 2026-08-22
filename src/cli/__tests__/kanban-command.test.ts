import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureKanbanCommand } from '../commands/kanban.js';

describe('YYLO Ledger facade CLI', () => {
  it.each(['ledger', 'kanban'])('forwards arbitrary canonical wrapper arguments through %s', async (surface) => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureKanbanCommand(program, invoke);
    await program.parseAsync(['node', 'yy', surface, 'create', '--body-file', '-', '--status', 'todo']);
    expect(invoke).toHaveBeenCalledWith(['create', '--body-file', '-', '--status', 'todo']);
  });

  it('advertises ledger as the preferred command and kanban as its compatibility alias', () => {
    const program = new Command().configureOutput({ writeOut: () => undefined });
    configureKanbanCommand(program, vi.fn(async () => undefined));
    const command = program.commands.find((candidate) => candidate.name() === 'ledger');
    expect(command?.aliases()).toContain('kanban');
    expect(command?.description()).toContain('YYLO Ledger');
  });
});
