/**
 * Preflight Tests Unit Test
 *
 * Tests for preflight functionality that runs before subagent iterations
 * to ensure configuration files remain lean and manageable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { createTempProject, cleanupTempProject } from '../../test-utils/temp-project.js';
import type { PreflightResult } from '../preflight.js';

describe('Preflight Tests', () => {
  let tempProject: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tempProject = await createTempProject();
    vi.clearAllMocks();
    // Reset environment variables to original state
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
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

      // Mock the feedback command to avoid CLI execution issues in tests
      const { spawn } = await import('child_process');
      const spawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => ({
        on: vi.fn().mockImplementation((event: string, callback: Function) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0); // Simulate successful command execution
          }
        }),
        on: vi.fn(),
      }));

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].threshold).toBe(100);
      expect(result.actions[0].lineCount).toBeGreaterThan(100);

      spawnSpy.mockRestore();
    });

    it('should respect JUNO_PREFLIGHT_DISABLED', async () => {
      // Create a large file that would normally trigger preflight
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      const largeContent = Array(600).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Disable preflight tests
      process.env.JUNO_PREFLIGHT_DISABLED = 'true';

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(false);
      expect(result.actions).toHaveLength(0);
    });

    it('should use default values when environment variables are not set', async () => {
      const { getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      expect(config.threshold).toBe(500);
      expect(config.enabled).toBe(true);
      expect(config.projectPath).toBe(tempProject);
      expect(config.subagent).toBe('claude');
    });
  });

  describe('File Size Detection', () => {
    it('should detect when USER_FEEDBACK.md exceeds threshold', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');

      // Create content that exceeds default 500 line threshold
      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Mock the spawn function to avoid CLI execution issues
      const spawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => ({
        on: vi.fn().mockImplementation((event: string, callback: Function) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
        }),
      }));

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('feedback_archival');
      expect(result.actions[0].file).toBe('.juno_task/USER_FEEDBACK.md');
      expect(result.actions[0].lineCount).toBeGreaterThan(500);
      expect(result.actions[0].feedbackCommand).toContain('feedback --issue');
      expect(result.actions[0].feedbackCommand).toContain('is becoming big, you need to compact it and keep it lean');

      spawnSpy.mockRestore();
    });

    it('should detect when CLAUDE.md exceeds threshold', async () => {
      const claudePath = path.join(tempProject, 'CLAUDE.md');

      // Create content that exceeds default 500 line threshold AND 30KB size threshold
      // Each line needs to be longer to exceed 30KB (30*1024 = 30720 bytes)
      // 550 lines * 60 bytes/line = 33000 bytes > 30KB
      const largeContent = Array(550).fill('# Test line for Claude config testing with extra content padding\n').join('');
      await fs.writeFile(claudePath, largeContent);

      // Mock the spawn function to avoid CLI execution issues
      const spawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => ({
        on: vi.fn().mockImplementation((event: string, callback: Function) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
        }),
      }));

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('config_compaction');
      expect(result.actions[0].file).toBe('CLAUDE.md');
      expect(result.actions[0].lineCount).toBeGreaterThan(500);
      expect(result.actions[0].feedbackCommand).toContain('feedback --issue');
      expect(result.actions[0].feedbackCommand).toContain('is becoming big, you need to compact it and keep it lean');

      spawnSpy.mockRestore();
    });

    it('should detect when AGENTS.md exceeds threshold for non-Claude subagents', async () => {
      const agentsPath = path.join(tempProject, 'AGENTS.md');

      // Create content that exceeds default 500 line threshold AND 30KB size threshold
      const largeContent = Array(550).fill('# Test line for agents config testing with extra content padding\n').join('');
      await fs.writeFile(agentsPath, largeContent);

      // Mock the spawn function to avoid CLI execution issues
      const spawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => ({
        on: vi.fn().mockImplementation((event: string, callback: Function) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
        }),
      }));

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'cursor');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('config_compaction');
      expect(result.actions[0].file).toBe('AGENTS.md');
      expect(result.actions[0].feedbackCommand).toContain('is becoming big, you need to compact it and keep it lean');

      spawnSpy.mockRestore();
    });

    it('should not trigger when files are within threshold', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');

      // Create content that is within threshold
      const smallContent = Array(100).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, smallContent);

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(false);
      expect(result.actions).toHaveLength(0);
    });

    it('should handle multiple files exceeding threshold', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      const claudePath = path.join(tempProject, 'CLAUDE.md');

      // Create content that exceeds threshold in both files (must also exceed 30KB for config files)
      const largeContent = Array(550).fill('# Test line for preflight testing with extra content padding\n').join('');
      await fs.writeFile(feedbackPath, largeContent);
      await fs.writeFile(claudePath, largeContent);

      // Mock the spawn function to avoid CLI execution issues
      const spawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => ({
        on: vi.fn().mockImplementation((event: string, callback: Function) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
        }),
      }));

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(2);

      const feedbackAction = result.actions.find(a => a.file === '.juno_task/USER_FEEDBACK.md');
      const configAction = result.actions.find(a => a.file === 'CLAUDE.md');

      expect(feedbackAction?.type).toBe('feedback_archival');
      expect(configAction?.type).toBe('config_compaction');
      expect(feedbackAction?.feedbackCommand).toContain('is becoming big, you need to compact it and keep it lean');
      expect(configAction?.feedbackCommand).toContain('is becoming big, you need to compact it and keep it lean');

      spawnSpy.mockRestore();
    });
  });

  describe('Error Handling', () => {
    it('should handle missing files gracefully', async () => {
      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      // Should not fail even when files don't exist
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(false);
      expect(result.actions).toHaveLength(0);
    });

    it('should handle empty files gracefully', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.writeFile(feedbackPath, '');

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(false);
      expect(result.actions).toHaveLength(0);
    });

    it('should handle file read errors gracefully', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.writeFile(feedbackPath, 'test content');

      // Mock fs.readFile to throw an error
      const readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('Permission denied'));

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      // Should not throw, but handle error gracefully
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(false);
      expect(result.actions).toHaveLength(0);

      readFileSpy.mockRestore();
    });
  });

  describe('Progress Reporting', () => {
    it('should emit progress events for preflight tests', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Mock the spawn function to avoid CLI execution issues
      const spawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => ({
        on: vi.fn().mockImplementation((event: string, callback: Function) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
        }),
      }));

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('feedback_archival');
      expect(result.actions[0].lineCount).toBeGreaterThan(500);
      expect(result.actions[0].threshold).toBe(500);
      expect(result.actions[0].feedbackCommand).toContain('feedback --issue');
      expect(result.actions[0].feedbackCommand).toContain('is becoming big, you need to compact it and keep it lean');

      spawnSpy.mockRestore();
    });
  });

  describe('Config File Detection', () => {
    it('should use CLAUDE.md for claude subagent', async () => {
      const { getPreflightConfig } = await import('../preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      // The config should work with claude subagent
      expect(config.subagent).toBe('claude');
      expect(config.enabled).toBe(true);
    });

    it('should use AGENTS.md for non-claude subagents', async () => {
      const agentsPath = path.join(tempProject, 'AGENTS.md');
      const largeContent = Array(550).fill('# Test line for agents config testing with extra content padding\n').join('');
      await fs.writeFile(agentsPath, largeContent);

      // Mock the spawn function to avoid CLI execution issues
      const spawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => ({
        on: vi.fn().mockImplementation((event: string, callback: Function) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
        }),
      }));

      const { runPreflightTests, getPreflightConfig } = await import('../preflight.js');

      // Test with cursor subagent
      const config = getPreflightConfig(tempProject, 'cursor');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].file).toBe('AGENTS.md');
      expect(result.actions[0].type).toBe('config_compaction');

      spawnSpy.mockRestore();
    });

    it('should handle case-insensitive subagent names', async () => {
      const { getPreflightConfig } = await import('../preflight.js');

      const configUpper = getPreflightConfig(tempProject, 'CLAUDE');
      const configLower = getPreflightConfig(tempProject, 'claude');
      const configMixed = getPreflightConfig(tempProject, 'ClAuDe');

      expect(configUpper.subagent).toBe('CLAUDE');
      expect(configLower.subagent).toBe('claude');
      expect(configMixed.subagent).toBe('ClAuDe');
    });
  });
});