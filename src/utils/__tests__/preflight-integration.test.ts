/**
 * Preflight Tests Integration Test
 *
 * Tests for preflight functionality that runs before subagent iterations
 * to ensure configuration files remain lean and manageable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import { createTempProject, cleanupTempProject } from '../../test-utils/temp-project.js';
import type { PreflightResult } from '../../utils/preflight.js';

describe('Preflight Tests - Integration', () => {
  let tempProject: string;
  const originalEnv = process.env;
  const projectRoot = path.resolve(__dirname, '../../..');
  const cliPath = path.join(projectRoot, 'dist', 'bin', 'cli.mjs');

  beforeEach(async () => {
    tempProject = await createTempProject();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await cleanupTempProject(tempProject);
  });

  describe('Environment Variable Configuration', () => {
    it('should respect JUNO_PREFLIGHT_THRESHOLD', async () => {
      // Create a large USER_FEEDBACK.md file that exceeds custom threshold
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      const largeContent = Array(150).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Set custom threshold
      process.env.JUNO_PREFLIGHT_THRESHOLD = '100';

      try {
        const { stdout } = await execa('node', [
          cliPath,
          'start',
          '--max-iterations', '1',
          '--subagent', 'claude',
          '--prompt', 'test',
          '--mcp-timeout', '120000'
        ], {
          cwd: tempProject,
          timeout: 30000
        });

        // Should trigger preflight tests
        expect(stdout).toContain('Preflight tests triggered');
        expect(stdout).toContain('USER_FEEDBACK.md');
        expect(stdout).toContain('threshold: 100');
      } catch (error: any) {
        // May fail due to MCP issues, but preflight should still run
        expect(error.stdout || error.message).toContain('Preflight tests triggered');
      }
    });

    it('should respect JUNO_PREFLIGHT_DISABLED', async () => {
      // Create a large file that would normally trigger preflight
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      const largeContent = Array(600).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Disable preflight tests
      process.env.JUNO_PREFLIGHT_DISABLED = 'true';

      try {
        const { stdout } = await execa('node', [
          cliPath,
          'start',
          '--max-iterations', '1',
          '--subagent', 'claude',
          '--prompt', 'test',
          '--mcp-timeout', '120000'
        ], {
          cwd: tempProject,
          timeout: 30000
        });

        // Should NOT trigger preflight tests
        expect(stdout).not.toContain('Preflight tests triggered');
      } catch (error: any) {
        // May fail due to MCP issues, but preflight should be disabled
        const output = error.stdout || error.message;
        expect(output).not.toContain('Preflight tests triggered');
      }
    });
  });

  describe('File Size Detection', () => {
    it('should detect when USER_FEEDBACK.md exceeds threshold', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      // Create content that exceeds default 500 line threshold
      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Test with default threshold
      const { runPreflightTests, getPreflightConfig } = await import('../../utils/preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('feedback_compaction');
      expect(result.actions[0].file).toBe('.juno_task/USER_FEEDBACK.md');
      expect(result.actions[0].lineCount).toBeGreaterThan(500);
    });

    it('should detect when CLAUDE.md exceeds threshold', async () => {
      const claudePath = path.join(tempProject, 'CLAUDE.md');

      // Create content that exceeds default 500 line threshold
      const largeContent = Array(550).fill('# Test line for Claude config testing\n').join('');
      await fs.writeFile(claudePath, largeContent);

      const { runPreflightTests, getPreflightConfig } = await import('../../utils/preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('config_compaction');
      expect(result.actions[0].file).toBe('CLAUDE.md');
      expect(result.actions[0].lineCount).toBeGreaterThan(500);
    });

    it('should detect when AGENTS.md exceeds threshold for non-Claude subagents', async () => {
      const agentsPath = path.join(tempProject, 'AGENTS.md');

      // Create content that exceeds default 500 line threshold
      const largeContent = Array(550).fill('# Test line for agents config testing\n').join('');
      await fs.writeFile(agentsPath, largeContent);

      const { runPreflightTests, getPreflightConfig } = await import('../../utils/preflight.js');
      const config = getPreflightConfig(tempProject, 'cursor');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('config_compaction');
      expect(result.actions[0].file).toBe('AGENTS.md');
    });

    it('should not trigger when files are within threshold', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      // Create content that is within threshold
      const smallContent = Array(100).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, smallContent);

      const { runPreflightTests, getPreflightConfig } = await import('../../utils/preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(false);
      expect(result.actions).toHaveLength(0);
    });
  });

  describe('Feedback Command Execution', () => {
    it('should execute feedback command when threshold exceeded', async () => {
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      // Create initial content that exceeds threshold
      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      const initialLineCount = (await fs.readFile(feedbackPath, 'utf8')).split('\n').length;

      // Run preflight tests
      const { runPreflightTests, getPreflightConfig } = await import('../../utils/preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);

      // Check that feedback command was executed (file should have grown)
      const finalLineCount = (await fs.readFile(feedbackPath, 'utf8')).split('\n').length;
      expect(finalLineCount).toBeGreaterThan(initialLineCount);

      // Check that the feedback contains the expected message
      const finalContent = await fs.readFile(feedbackPath, 'utf8');
      expect(finalContent).toContain('System Feedback');
      expect(finalContent).toContain('needs to kept lean');
    });
  });

  describe('Preflight Integration with Engine', () => {
    it('should run preflight tests before first iteration', async () => {
      // Create a large USER_FEEDBACK.md file
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      try {
        const { stdout } = await execa('node', [
          cliPath,
          'start',
          '--max-iterations', '1',
          '--subagent', 'claude',
          '--prompt', 'test',
          '--mcp-timeout', '120000'
        ], {
          cwd: tempProject,
          timeout: 30000
        });

        // Should show preflight test execution
        expect(stdout).toContain('Preflight tests triggered');
      } catch (error: any) {
        // May fail due to MCP issues, but preflight should still run
        const output = error.stdout || error.message;
        expect(output).toContain('Preflight tests triggered');
      }
    });

    it('should not run preflight tests when disabled', async () => {
      // Create a large USER_FEEDBACK.md file
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Disable preflight tests
      process.env.JUNO_PREFLIGHT_DISABLED = 'true';

      try {
        const { stdout } = await execa('node', [
          cliPath,
          'start',
          '--max-iterations', '1',
          '--subagent', 'claude',
          '--prompt', 'test',
          '--mcp-timeout', '120000'
        ], {
          cwd: tempProject,
          timeout: 30000
        });

        // Should NOT show preflight test execution
        expect(stdout).not.toContain('Preflight tests triggered');
      } catch (error: any) {
        // May fail due to MCP issues, but preflight should be disabled
        const output = error.stdout || error.message;
        expect(output).not.toContain('Preflight tests triggered');
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle missing files gracefully', async () => {
      const { runPreflightTests, getPreflightConfig } = await import('../../utils/preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');

      // Should not fail even when files don't exist
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(false);
      expect(result.actions).toHaveLength(0);
    });

    it('should handle feedback command failures gracefully', async () => {
      // Create a large file
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      // Mock the feedback command to fail
      const { runPreflightTests, getPreflightConfig } = await import('../../utils/preflight.js');

      // Temporarily rename CLI binary to simulate failure
      const cliPath = path.join(tempProject, 'dist', 'bin', 'cli.mjs');
      const originalCliExists = await fs.pathExists(cliPath);
      if (originalCliExists) {
        await fs.rename(cliPath, `${cliPath}.backup`);
      }

      try {
        const config = getPreflightConfig(tempProject, 'claude');
        const result = await runPreflightTests(config);

        // Should handle failure gracefully
        expect(result.triggered).toBe(false); // Should not be marked as triggered if command failed
        expect(result.actions).toHaveLength(0);
      } finally {
        // Restore CLI binary
        if (originalCliExists) {
          await fs.rename(`${cliPath}.backup`, cliPath);
        }
      }
    });
  });

  describe('Progress Reporting', () => {
    it('should emit progress events for preflight tests', async () => {
      // This test would require mocking the engine's event emitter
      // For now, we just test that the progress data structure is correct
      const feedbackPath = path.join(tempProject, '.juno_task', 'USER_FEEDBACK.md');
      await fs.ensureDir(path.dirname(feedbackPath));

      const largeContent = Array(550).fill('# Test line for preflight testing\n').join('');
      await fs.writeFile(feedbackPath, largeContent);

      const { runPreflightTests, getPreflightConfig } = await import('../../utils/preflight.js');
      const config = getPreflightConfig(tempProject, 'claude');
      const result = await runPreflightTests(config);

      expect(result.triggered).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('feedback_compaction');
      expect(result.actions[0].lineCount).toBeGreaterThan(500);
      expect(result.actions[0].threshold).toBe(500);
      expect(result.actions[0].feedbackCommand).toContain('feedback --issue');
    });
  });
});