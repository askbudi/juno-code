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

  it('forwards explicit canonical owner registration', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    configureIntegrationCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'integration', 'register', '/integration', '--replace']);
    expect(invoke).toHaveBeenCalledWith('register', { owner: '/integration', replace: true });
  });
});
