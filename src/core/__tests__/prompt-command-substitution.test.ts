import { describe, it, expect, vi } from 'vitest';

import {
  findPromptCommandSubstitutions,
  resolvePromptCommandSubstitutions,
} from '../prompt-command-substitution.js';

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
  });
});
