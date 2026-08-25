/**
 * CLI wiring tests for the advisory test-daemon surface (Wave 2 of PDR
 * 7djT8N). `yy test daemon ...` and `yy test affected ...` must route before
 * the variadic AI-framework target interpretation, with injectable handlers.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

const daemonHandler = vi.fn();
const affectedHandler = vi.fn();

vi.mock('../../test-daemon/cli.js', () => ({
  runTestDaemonCommand: (...args: unknown[]) => daemonHandler(...args),
  runTestAffectedCommand: (...args: unknown[]) => affectedHandler(...args),
}));

vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readJson: vi.fn(),
    writeJson: vi.fn(),
    pathExists: vi.fn(),
  },
}));

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    workingDirectory: '/test',
    defaultSubagent: 'claude',
    mcpServerName: 'test-server',
    mcpRetries: 3,
    verbose: 0,
  }),
}));

vi.mock('../../core/session.js', () => ({
  createSessionManager: vi.fn().mockResolvedValue({
    createSession: vi.fn().mockResolvedValue({
      info: { id: 'test-session-id' },
      addHistoryEntry: vi.fn(),
      completeSession: vi.fn(),
    }),
  }),
}));

const { configureTestCommand } = await import('../commands/test.js');

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  configureTestCommand(program);
  return program;
}

describe('test command daemon routing', () => {
  it('routes `test daemon start` to the daemon surface', async () => {
    daemonHandler.mockClear();
    const program = buildProgram();
    await program.parseAsync(['node', 'yylo', 'test', 'daemon', 'start', '--json']);
    expect(daemonHandler).toHaveBeenCalledTimes(1);
    const [args, options] = daemonHandler.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ];
    expect(args).toEqual(['start']);
    expect(options.json).toBe(true);
  });

  it('routes `test daemon status` and forwards idle bounds', async () => {
    daemonHandler.mockClear();
    const program = buildProgram();
    await program.parseAsync([
      'node',
      'yylo',
      'test',
      'daemon',
      'status',
      '--daemon-idle-timeout-ms',
      '60000',
    ]);
    expect(daemonHandler).toHaveBeenCalledTimes(1);
    expect((daemonHandler.mock.calls[0] as unknown[][])[0]).toEqual(['status']);
    expect(
      (daemonHandler.mock.calls[0] as [string[], Record<string, unknown>])[1]
        .idleTimeoutMs,
    ).toBe('60000');
  });

  it('routes `test affected` with daemon opt-out', async () => {
    affectedHandler.mockClear();
    const program = buildProgram();
    await program.parseAsync(['node', 'yylo', 'test', 'affected', '--no-daemon']);
    expect(affectedHandler).toHaveBeenCalledTimes(1);
    const [args, options] = affectedHandler.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ];
    expect(args).toEqual([]);
    expect(options.useDaemon).toBe(false);
  });

  it('does not route ordinary targets to the daemon surface', async () => {
    daemonHandler.mockClear();
    affectedHandler.mockClear();
    const program = buildProgram();
    // The mocked AI-framework path fails fast (process.exit 99); the point is
    // that daemon/affected handlers stay cold for ordinary targets.
    await expect(
      program.parseAsync(['node', 'yylo', 'test', 'src/utils.ts', '--generate']),
    ).rejects.toThrow();
    expect(daemonHandler).not.toHaveBeenCalled();
    expect(affectedHandler).not.toHaveBeenCalled();
  });
});
