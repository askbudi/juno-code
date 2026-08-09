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

  it('forwards exact identities to a no-mutation registration plan', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureMigrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'migrate', 'registration', 'plan',
      '--source-controller', '/old', '--source-ref', 'refs/heads/old', '--expected-source-head', 'a'.repeat(40),
      '--target-controller', '/new', '--target-ref', 'refs/heads/new', '--expected-target-head', 'b'.repeat(40),
      '--product-root', '/integration', '--product-ref', 'refs/heads/main', '--expected-product-head', 'c'.repeat(40),
      '--runtime', '/bin/yy', '--runtime-version', '2.1.1', '--inventory', '/r/inventory.json', '--policy-bundle', '/r/policy.json', '--pending-verification', '/r/pending.json', '--output', '/r/plan.json']);
    expect(invoke).toHaveBeenCalledWith(['registration', 'plan',
      '--source-controller', '/old', '--source-ref', 'refs/heads/old', '--expected-source-head', 'a'.repeat(40),
      '--target-controller', '/new', '--target-ref', 'refs/heads/new', '--expected-target-head', 'b'.repeat(40),
      '--product-root', '/integration', '--product-ref', 'refs/heads/main', '--expected-product-head', 'c'.repeat(40),
      '--runtime', '/bin/yy', '--runtime-version', '2.1.1', '--inventory', '/r/inventory.json', '--policy-bundle', '/r/policy.json', '--pending-verification', '/r/pending.json', '--output', '/r/plan.json']);
  });

  it('keeps apply and rollback behind explicit authorization flags', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureMigrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'migrate', 'registration', 'apply', '--plan', '/r/plan.json', '--output', '/r/apply.json', '--authorize-apply']);
    expect(invoke).toHaveBeenLastCalledWith(['registration', 'apply', '--plan', '/r/plan.json', '--output', '/r/apply.json', '--authorize-apply']);
    await program.parseAsync(['node', 'yy', 'migrate', 'registration', 'rollback', '--plan', '/r/plan.json', '--output', '/r/rollback.json', '--authorize-rollback']);
    expect(invoke).toHaveBeenLastCalledWith(['registration', 'rollback', '--plan', '/r/plan.json', '--output', '/r/rollback.json', '--authorize-rollback']);
  });
});
