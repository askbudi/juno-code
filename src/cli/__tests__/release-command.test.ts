import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { configureReleaseTrainCommand } from '../commands/release.js';

describe('release train CLI', () => {
  it.each(['plan', 'status', 'inspect'] as const)('forwards %s with stable projection options', async (operation) => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureReleaseTrainCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'release', 'train', operation, '/train.json',
      '--json', '--output', '/plan.json']);
    expect(invoke).toHaveBeenCalledWith(operation, '/train.json', ['--json', '--output', '/plan.json']);
  });

  it('forwards explicit seal and fenced drive without weakening token identity', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureReleaseTrainCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'release', 'train', 'seal', '/train.json', '--json']);
    expect(invoke).toHaveBeenLastCalledWith('seal', '/train.json', ['--json']);
    await program.parseAsync(['node', 'yy', 'release', 'train', 'drive', 'epoch-1',
      '--epoch-token', 'exact-token', '--json']);
    expect(invoke).toHaveBeenLastCalledWith('drive', 'epoch-1',
      ['--epoch-token', 'exact-token', '--json']);
  });

  it('labels observation, epoch mutation, and external authority boundaries in help', () => {
    const program = new Command();
    configureReleaseTrainCommand(program, async () => undefined);
    const release = program.commands.find((command) => command.name() === 'release');
    const train = release?.commands.find((command) => command.name() === 'train');
    const command = (name: string) => train?.commands.find((entry) => entry.name() === name);
    expect(release?.description()).toContain('no command implies publish/deploy authority');
    for (const name of ['plan', 'status', 'inspect']) {
      expect(command(name)?.description()).toContain('Read-only');
    }
    expect(command('epoch-status')?.description()).toContain('Read-only');
    expect(command('shadow')?.description()).toContain('Read-only');
    expect(command('seal')?.description()).toContain('Explicitly close admission');
    expect(command('drive')?.description()).toContain('one target CAS');
    expect(command('repair')?.description()).toContain('one bounded');
  });

  it('forwards optional ejection and read-only shadow projection', async () => {
    const invoke = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    configureReleaseTrainCommand(program, invoke);
    await program.parseAsync(['node', 'yy', 'release', 'train', 'eject', 'epoch-1', 'TASK01',
      '--reason', 'optional-red', '--epoch-token', 'exact-token']);
    expect(invoke).toHaveBeenLastCalledWith('eject', 'epoch-1',
      ['TASK01', '--reason', 'optional-red', '--epoch-token', 'exact-token']);
    await program.parseAsync(['node', 'yy', 'release', 'train', 'shadow', '/train.json',
      '--baseline', '/baseline.json', '--output', '/decision.json']);
    expect(invoke).toHaveBeenLastCalledWith('shadow', '/train.json',
      ['--baseline', '/baseline.json', '--output', '/decision.json']);
  });
});
