import { describe, it, expect, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

import {
  findPromptCommandSubstitutions,
  resolvePromptCommandSubstitutions,
} from '../prompt-command-substitution.js';

afterEach(() => {
  mocks.execFile.mockReset();
  delete process.env.JUNO_CODE_PROMPT_SUBSTITUTION_TIMEOUT_MS;
  delete process.env.JUNO_CODE_LAST_SESSION_ID_SCOPE_0123456789ABCDEF;
  delete process.env.JUNO_CODE_LAST_EXECUTION_SETTINGS;
  delete process.env.PROMPT_BOUNDARY_CONFIG;
});

describe('prompt-command-substitution', () => {
  describe('findPromptCommandSubstitutions', () => {
    it('should find single-quoted and triple-backtick substitutions in order', () => {
      const prompt = "prefix !'echo one' middle !```echo two``` suffix";

      const matches = findPromptCommandSubstitutions(prompt);

      expect(matches).toHaveLength(2);
      expect(matches[0]).toMatchObject({
        syntax: 'single-quoted',
        command: 'echo one',
        raw: "!'echo one'",
      });
      expect(matches[1]).toMatchObject({
        syntax: 'triple-backtick',
        command: 'echo two',
        raw: '!```echo two```',
      });
      expect(matches[0]?.startIndex).toBeLessThan(matches[1]?.startIndex ?? Infinity);
    });

    it('should ignore unterminated substitution markers', () => {
      const prompt = "before !'echo one after !```echo two";

      const matches = findPromptCommandSubstitutions(prompt);

      expect(matches).toHaveLength(0);
    });
  });

  describe('resolvePromptCommandSubstitutions', () => {
    it('should replace each substitution with command output', async () => {
      const executor = vi.fn(async (command: string) => {
        if (command.trim() === 'echo one') return 'one\n';
        if (command.trim() === 'echo two') return 'two\n';
        return '';
      });

      const result = await resolvePromptCommandSubstitutions(
        "A !'echo one' and !```echo two``` B",
        {
          workingDirectory: '/tmp',
          executor,
        },
      );

      expect(result).toBe('A one and two B');
      expect(executor).toHaveBeenCalledTimes(2);
      expect(executor).toHaveBeenNthCalledWith(1, 'echo one');
      expect(executor).toHaveBeenNthCalledWith(2, 'echo two');
    });

    it('should keep prompt unchanged when no valid substitution exists', async () => {
      const prompt = "Keep this text !'unterminated";
      const executor = vi.fn(async () => 'unused');

      const result = await resolvePromptCommandSubstitutions(prompt, {
        workingDirectory: '/tmp',
        executor,
      });

      expect(result).toBe(prompt);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should surface executor failures with the command context', async () => {
      await expect(
        resolvePromptCommandSubstitutions("Run !'boom'", {
          workingDirectory: '/tmp',
          executor: async (command: string) => {
            throw new Error(`failure on ${command}`);
          },
        }),
      ).rejects.toThrow('failure on boom');
    });

    it('should pass commandTimeoutMs to the default prompt substitution executor', async () => {
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          | ((error: Error | null, stdout?: string, stderr?: string) => void)
          | undefined
        );
        callback?.(null, 'ready\n', '');
        return {};
      });

      const result = await resolvePromptCommandSubstitutions("Run !'echo ready'", {
        workingDirectory: '/tmp',
        commandTimeoutMs: 4321,
      });

      expect(result).toBe('Run ready');
      expect(mocks.execFile).toHaveBeenCalledTimes(1);
      const call = mocks.execFile.mock.calls[0];
      expect(call?.[2]).toMatchObject({ timeout: 4321 });
    });

    it('should filter continuity while preserving arbitrary config at the substitution boundary', async () => {
      process.env.JUNO_CODE_LAST_SESSION_ID_SCOPE_0123456789ABCDEF = 'historical-session';
      process.env.JUNO_CODE_LAST_EXECUTION_SETTINGS = 'legacy-settings';
      process.env.PROMPT_BOUNDARY_CONFIG = 'preserved';
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as
          | ((error: Error | null, stdout?: string, stderr?: string) => void)
          | undefined;
        callback?.(null, 'ok\n', '');
        return {};
      });

      await resolvePromptCommandSubstitutions("Run !'true'", { workingDirectory: '/tmp' });

      const environment = mocks.execFile.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
      expect(environment.PROMPT_BOUNDARY_CONFIG).toBe('preserved');
      expect(environment.JUNO_CODE_LAST_SESSION_ID_SCOPE_0123456789ABCDEF).toBeUndefined();
      expect(environment.JUNO_CODE_LAST_EXECUTION_SETTINGS).toBeUndefined();
    });

    it('should execute prompt substitution commands with stdin closed to avoid shell-read hangs', async () => {
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          | ((error: Error | null, stdout?: string, stderr?: string) => void)
          | undefined
        );
        callback?.(null, 'ok\n', '');
        return {};
      });

      const result = await resolvePromptCommandSubstitutions("Run !'kanban-juno list'", {
        workingDirectory: '/tmp',
      });

      expect(result).toBe('Run ok');
      const call = mocks.execFile.mock.calls[0];
      const argv = call?.[1] as string[] | undefined;
      expect(argv?.[0]).toBe('-lc');
      expect(argv?.[1]).toBe('(kanban-juno list) </dev/null');
    });

    it('should honor JUNO_CODE_PROMPT_SUBSTITUTION_TIMEOUT_MS when commandTimeoutMs is not provided', async () => {
      process.env.JUNO_CODE_PROMPT_SUBSTITUTION_TIMEOUT_MS = '6543';
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          | ((error: Error | null, stdout?: string, stderr?: string) => void)
          | undefined
        );
        callback?.(null, 'env-timeout\n', '');
        return {};
      });

      const result = await resolvePromptCommandSubstitutions("Run !'echo env-timeout'", {
        workingDirectory: '/tmp',
      });

      expect(result).toBe('Run env-timeout');
      const call = mocks.execFile.mock.calls[0];
      expect(call?.[2]).toMatchObject({ timeout: 6543 });
    });

    it('should raise a clear timeout error when prompt substitution command execution times out', async () => {
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          | ((error: Error | null, stdout?: string, stderr?: string) => void)
          | undefined
        );
        const timeoutError = Object.assign(new Error('Command failed: timed out'), {
          code: 'ETIMEDOUT',
          killed: true,
          signal: 'SIGTERM',
          stderr: '',
        });
        callback?.(timeoutError, '', '');
        return {};
      });

      await expect(
        resolvePromptCommandSubstitutions("Run !'sleep 10'", {
          workingDirectory: '/tmp',
          commandTimeoutMs: 321,
        }),
      ).rejects.toThrow('Prompt command substitution timed out after 321ms for `sleep 10`');
    });
  });
});
