import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/codex-auth-mapper.js', () => ({
  DEFAULT_CODEX_AUTH_PATH: '/home/test/.codex/auth.json',
  DEFAULT_PI_AUTH_PATH: '/home/test/.pi/agent/auth.json',
  importCodexAuth: vi.fn(),
}));

import { createAuthCommand } from '../commands/auth.js';

describe('auth command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards custom input/output/provider options to importCodexAuth', async () => {
    const { importCodexAuth } = await import('../../utils/codex-auth-mapper.js');
    vi.mocked(importCodexAuth).mockResolvedValue({
      provider: 'openai-codex',
      outputPath: '/tmp/pi-auth.json',
      expires: Date.now(),
      replacedExisting: false,
    });

    const cmd = createAuthCommand();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmd.parseAsync(
      ['node', 'juno-code', 'import-codex', '--input', '/in.json', '--output', '/out.json', '--provider', 'p'],
      { from: 'node' },
    );

    expect(importCodexAuth).toHaveBeenCalledWith({
      inputPath: '/in.json',
      outputPath: '/out.json',
      provider: 'p',
    });

    logSpy.mockRestore();
  });

  it('exits with code 1 when import fails', async () => {
    const { importCodexAuth } = await import('../../utils/codex-auth-mapper.js');
    vi.mocked(importCodexAuth).mockRejectedValue(new Error('boom'));

    const cmd = createAuthCommand();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    await expect(
      cmd.parseAsync(['node', 'juno-code', 'import-codex'], { from: 'node' }),
    ).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
