import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureMigrationCommand } from '../commands/migrate.js';

describe('migration CLI', () => {
  it('forwards a read-only inventory with an explicit external receipt', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureMigrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'migrate', 'inventory', '--project', '/project', '--controller', '/controller', '--product-ref', 'refs/heads/product', '--runtime', '/bin/yy', '--kanban-runtime', '/bin/juno-kanban', '--heavy-threshold-bytes', '42', '--output', '/receipts/inventory.json']);
    expect(invoke).toHaveBeenCalledWith(['inventory', '--project', '/project', '--heavy-threshold-bytes', '42', '--output', '/receipts/inventory.json', '--controller', '/controller', '--product-ref', 'refs/heads/product', '--runtime', '/bin/yy', '--kanban-runtime', '/bin/juno-kanban']);
  });

  it('forwards only immutable inputs to policy generation', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureMigrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'migrate', 'generate-policy', '--inventory', '/r/i.json', '--answers', '/r/a.json', '--output', '/r/p.json']);
    expect(invoke).toHaveBeenCalledWith(['generate-policy', '--inventory', '/r/i.json', '--answers', '/r/a.json', '--output', '/r/p.json']);
  });

  it('creates an owner template bound to the immutable inventory', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureMigrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'migrate', 'owner-template', '--inventory', '/r/i.json', '--output', '/r/a.json']);
    expect(invoke).toHaveBeenCalledWith(['owner-template', '--inventory', '/r/i.json', '--output', '/r/a.json']);
  });
});
