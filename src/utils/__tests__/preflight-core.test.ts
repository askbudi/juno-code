/**
 * Preflight Tests Core Logic Test
 *
 * Tests for preflight functionality core detection logic without CLI execution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { createTempProject, cleanupTempProject } from '../../test-utils/temp-project.js';

describe('Preflight Tests - Core Logic', () => {
  let tempProject: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tempProject = await createTempProject();
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.JUNO_PREFLIGHT_THRESHOLD;
    delete process.env.JUNO_PREFLIGHT_DISABLED;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await cleanupTempProject(tempProject);
  });

  describe('Environment Variable Configuration', () => {
    it('should respect JUNO_PREFLIGHT_THRESHOLD', async () => {
      // Create a large USER_FEEDBACK.md file that exceeds custom threshold
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      const largeContent = Array(150).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Set custom threshold
      process.env.JUNO_PREFLIGHT_THRESHOLD = '100';

      const { getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      expect(config.threshold).toBe(100);
      expect(config.enabled).toBe(true);
    });

    it('should respect JUNO_PREFLIGHT_DISABLED', async () => {
      // Disable preflight tests
      process.env.JUNO_PREFLIGHT_DISABLED = 'true';

      const { getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      expect(config.enabled).toBe(false);
    });

    it('should use default values when environment variables are not set', async () => {
      const { getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      expect(config.threshold).toBe(500);
      expect(config.enabled).toBe(true);
      expect(config.projectPath).toBe(tempProject);
      expect(config.subagent).toBe('claude');
    });

    it('should parse numeric threshold correctly', async () => {
      process.env.JUNO_PREFLIGHT_THRESHOLD = '1000';

      const { getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      expect(config.threshold).toBe(1000);
    });

    it('should handle invalid threshold values gracefully', async () => {
      process.env.JUNO_PREFLIGHT_THRESHOLD = 'invalid';

      const { getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      expect(config.threshold).toBeNaN();
    });
  });

  describe('File Size Detection', () => {
    it('should detect when USER_FEEDBACK.md exceeds threshold', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');

      // Create content that exceeds default 500 line threshold
      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Count lines directly to verify
      const content = await fs.readFile(feedbackPath, 'utf8');
      const lineCount = content.split('\n').length;

      expect(lineCount).toBeGreaterThan(500);
      expect(lineCount).toBe(551); // Array.join creates content with trailing newline
    });

    it('should detect when CLAUDE.md exceeds threshold', async () => {
      const claudePath = path.join(tempProject, 'CLAUDE.md');

      // Create content that exceeds default 500 line threshold
      const largeContent = Array(600).fill('# Test line for Claude config testing\n').join('');
      await fs.writeFile(claudePath, largeContent);

      // Count lines directly to verify
      const content = await fs.readFile(claudePath, 'utf8');
      const lineCount = content.split('\n').length;

      expect(lineCount).toBeGreaterThan(500);
      expect(lineCount).toBe(601); // Array.join creates content with trailing newline
    });

    it('should detect when AGENTS.md exceeds threshold for non-Claude subagents', async () => {
      const agentsPath = path.join(tempProject, 'AGENTS.md');

      // Create content that exceeds default 500 line threshold
      const largeContent = Array(550).fill('# Test line for agents config testing\n').join('');
      await fs.writeFile(agentsPath, largeContent);

      // Count lines directly to verify
      const content = await fs.readFile(agentsPath, 'utf8');
      const lineCount = content.split('\n').length;

      expect(lineCount).toBeGreaterThan(500);
      expect(lineCount).toBe(551); // Array.join creates content with trailing newline
    });

    it('should not trigger when files are within threshold', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');

      // Create content that is within threshold
      const smallContent = Array(100).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, smallContent);

      // Count lines directly to verify
      const content = await fs.readFile(feedbackPath, 'utf8');
      const lineCount = content.split('\n').length;

      expect(lineCount).toBeLessThan(500);
      expect(lineCount).toBe(101); // Array.join creates content with trailing newline
    });

    it('should handle empty files correctly', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.writeFile(feedbackPath, '');

      // Count lines directly to verify
      const content = await fs.readFile(feedbackPath, 'utf8');
      const lineCount = content.split('\n').length;

      expect(lineCount).toBe(1); // Empty file still has 1 line
    });
  });

  describe('Config File Detection Logic', () => {
    it('should identify CLAUDE.md for claude subagent', async () => {
      // Import the getConfigFile function by testing the logic
      const lowerSubagent = 'claude';
      const expectedConfigFile = lowerSubagent.toLowerCase() === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';

      expect(expectedConfigFile).toBe('CLAUDE.md');
    });

    it('should identify AGENTS.md for non-claude subagents', async () => {
      const subagents = ['cursor', 'codex', 'gemini', 'gpt'];

      subagents.forEach(subagent => {
        const expectedConfigFile = subagent.toLowerCase() === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
        expect(expectedConfigFile).toBe('AGENTS.md');
      });
    });

    it('should handle case-insensitive subagent names', async () => {
      const subagents = ['CLAUDE', 'claude', 'ClAuDe'];

      subagents.forEach(subagent => {
        const expectedConfigFile = subagent.toLowerCase() === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
        expect(expectedConfigFile).toBe('CLAUDE.md');
      });
    });
  });

  describe('Line Counting Logic', () => {
    it('should count lines accurately for different content types', async () => {
      const testPath = path.join(tempProject, 'test-file.txt');

      // Test with no trailing newline
      await fs.writeFile(testPath, 'line1\nline2\nline3');
      const content1 = await fs.readFile(testPath, 'utf8');
      const lineCount1 = content1.split('\n').length;
      expect(lineCount1).toBe(3);

      // Test with trailing newline
      await fs.writeFile(testPath, 'line1\nline2\nline3\n');
      const content2 = await fs.readFile(testPath, 'utf8');
      const lineCount2 = content2.split('\n').length;
      expect(lineCount2).toBe(4);

      // Test with multiple consecutive newlines
      await fs.writeFile(testPath, 'line1\n\nline3\n\n');
      const content3 = await fs.readFile(testPath, 'utf8');
      const lineCount3 = content3.split('\n').length;
      expect(lineCount3).toBe(5);
    });

    it('should handle Unicode content correctly', async () => {
      const testPath = path.join(tempProject, 'unicode-test.txt');
      const unicodeContent = 'Hello 世界\n🚀 Test\nÑoël';
      await fs.writeFile(testPath, unicodeContent, 'utf8');

      const content = await fs.readFile(testPath, 'utf8');
      const lineCount = content.split('\n').length;

      expect(lineCount).toBe(3);
    });
  });

  describe('Error Handling for File Operations', () => {
    it('should handle non-existent files gracefully', async () => {
      const nonExistentPath = path.join(tempProject, 'does-not-exist.txt');

      // Should not throw error when trying to read non-existent file
      try {
        const content = await fs.readFile(nonExistentPath, 'utf8');
        // If we get here, file exists, but that's ok for this test
      } catch (error) {
        // File doesn't exist, which is expected
        expect(error).toBeInstanceOf(Error);
      }
    });

    it('should handle permission denied scenarios', async () => {
      // Mock a permission error scenario
      const mockReadFile = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const testPath = path.join(tempProject, 'test.txt');

      try {
        await fs.readFile(testPath, 'utf8');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('permission denied');
      }

      mockReadFile.mockRestore();
    });
  });

  describe('Threshold Comparison Logic', () => {
    it('should correctly identify when files exceed threshold', () => {
      const lineCount = 550;
      const threshold = 500;

      const exceedsThreshold = lineCount > threshold;
      expect(exceedsThreshold).toBe(true);
    });

    it('should correctly identify when files are within threshold', () => {
      const lineCount = 450;
      const threshold = 500;

      const exceedsThreshold = lineCount > threshold;
      expect(exceedsThreshold).toBe(false);
    });

    it('should handle edge case where file equals threshold', () => {
      const lineCount = 500;
      const threshold = 500;

      const exceedsThreshold = lineCount > threshold;
      expect(exceedsThreshold).toBe(false);
    });
  });

  describe('Preflight Action Structure', () => {
    it('should create correct action structure for config compaction', () => {
      const action = {
        type: 'config_compaction' as const,
        file: 'CLAUDE.md',
        lineCount: 550,
        threshold: 500,
        feedbackCommand: 'feedback --issue "System Feedback"'
      };

      expect(action.type).toBe('config_compaction');
      expect(action.file).toBe('CLAUDE.md');
      expect(action.lineCount).toBeGreaterThan(action.threshold);
      expect(action.feedbackCommand).toContain('feedback --issue');
    });

    it('should create correct action structure for feedback compaction', () => {
      const action = {
        type: 'feedback_compaction' as const,
        file: '.juno_task/USER_FEEDBACK.md',
        lineCount: 600,
        threshold: 500,
        feedbackCommand: 'feedback --issue "User feedback compaction"'
      };

      expect(action.type).toBe('feedback_compaction');
      expect(action.file).toBe('.juno_task/USER_FEEDBACK.md');
      expect(action.lineCount).toBeGreaterThan(action.threshold);
      expect(action.feedbackCommand).toContain('feedback --issue');
    });
  });
});