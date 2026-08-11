import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureIntegrationCommand } from '../commands/integration.js';

describe('integration workspace CLI', () => {
  it('forwards offline and fetching status explicitly', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureIntegrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'integration', 'status']);
    expect(invoke).toHaveBeenLastCalledWith('status', {});
    await program.parseAsync(['node', 'yy', 'integration', 'status', '--fetch']);
    expect(invoke).toHaveBeenLastCalledWith('status', { fetch: true });
  });

  it('forwards guarded sync without implicit options', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureIntegrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'integration', 'sync']);
    expect(invoke).toHaveBeenCalledWith('sync', {});
  });

  it('forwards managed runtime doctor and exact-generation recovery', async () => {
    const invoke = vi.fn(async () => undefined);
    const doctor = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureIntegrationCommand(doctor, invoke);
    await doctor.parseAsync(['node', 'yy', 'integration', 'runtime-doctor', '--target-sha', 'b'.repeat(40)]);
    expect(invoke).toHaveBeenLastCalledWith('runtime-doctor', { targetSha: 'b'.repeat(40) });

    const refresh = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureIntegrationCommand(refresh, invoke);
    await refresh.parseAsync([
      'node', 'yy', 'integration', 'runtime-refresh',
      '--previous-sha', 'a'.repeat(40), '--target-sha', 'b'.repeat(40),
    ]);
    expect(invoke).toHaveBeenLastCalledWith('runtime-refresh', {
      previousSha: 'a'.repeat(40), targetSha: 'b'.repeat(40),
    });
  });

  it('forwards explicit canonical owner registration', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureIntegrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'integration', 'register', '/integration', '--replace']);
    expect(invoke).toHaveBeenCalledWith('register', { owner: '/integration', replace: true });
  });

  it.each(['repair', 'push'] as const)('requires and forwards receipt-bound %s modes', async (operation) => {
    const invoke = vi.fn(async () => undefined);
    const dryRunProgram = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureIntegrationCommand(dryRunProgram, invoke);
    await dryRunProgram.parseAsync(['node', 'yy', 'integration', operation, '--dry-run']);
    expect(invoke).toHaveBeenLastCalledWith(operation, { dryRun: true });
    const applyProgram = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureIntegrationCommand(applyProgram, invoke);
    await applyProgram.parseAsync(['node', 'yy', 'integration', operation, '--apply', '/tmp/plan.json']);
    expect(invoke).toHaveBeenLastCalledWith(operation, { apply: '/tmp/plan.json' });
  });
});
