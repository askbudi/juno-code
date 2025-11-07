/**
 * Tests for Hook system utility functions
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import fs from 'fs-extra';
import { execa } from 'execa';
import {
  executeHook,
  executeHooks,
  validateHooksConfig,
  type HookType,
  type HooksConfig,
  type HookExecutionContext,
  type HookExecutionOptions,
  type HookExecutionResult,
  type CommandExecutionResult,
} from '../hooks.js';

// Mock dependencies
vi.mock('execa');
vi.mock('../../cli/utils/advanced-logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
  LogContext: {
    SYSTEM: 'SYSTEM',
    CLI: 'CLI',
    MCP: 'MCP',
    ENGINE: 'ENGINE',
    SESSION: 'SESSION',
    TEMPLATE: 'TEMPLATE',
    CONFIG: 'CONFIG',
    PERFORMANCE: 'PERFORMANCE',
  },
  LogLevel: {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    FATAL: 5,
  },
}));

const mockedExeca = vi.mocked(execa);

describe('hooks', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `hooks-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    await fs.ensureDir(testDir);

    // Reset all mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.remove(testDir);
    } catch (error) {
      console.warn('Failed to clean up test directory:', error);
    }
  });

  describe('executeHook', () => {
    const mockHooks: HooksConfig = {
      START_ITERATION: {
        commands: ['echo "Starting iteration"', 'npm test'],
      },
      END_ITERATION: {
        commands: ['echo "Ending iteration"'],
      },
    };

    const mockContext: HookExecutionContext = {
      iteration: 1,
      sessionId: 'test-session-123',
      workingDirectory: testDir,
      metadata: { testKey: 'testValue' },
      runId: 'run-456',
      totalIterations: 5,
    };

    it('should execute hook successfully with all commands', async () => {
      // Mock successful command execution
      mockedExeca
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'Starting iteration',
          stderr: '',
          all: 'Starting iteration',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'All tests passed',
          stderr: '',
          all: 'All tests passed',
        } as any);

      const result = await executeHook('START_ITERATION', mockHooks, mockContext);

      expect(result.success).toBe(true);
      expect(result.hookType).toBe('START_ITERATION');
      expect(result.commandsExecuted).toBe(2);
      expect(result.commandsFailed).toBe(0);
      expect(result.commandResults).toHaveLength(2);
      expect(result.totalDuration).toBeGreaterThanOrEqual(0);

      // Check first command result
      expect(result.commandResults[0].command).toBe('echo "Starting iteration"');
      expect(result.commandResults[0].success).toBe(true);
      expect(result.commandResults[0].exitCode).toBe(0);
      expect(result.commandResults[0].stdout).toBe('Starting iteration');

      // Check second command result
      expect(result.commandResults[1].command).toBe('npm test');
      expect(result.commandResults[1].success).toBe(true);
      expect(result.commandResults[1].exitCode).toBe(0);
      expect(result.commandResults[1].stdout).toBe('All tests passed');
    });

    it('should handle command with stdout and stderr output', async () => {
      const hooksWithOutput: HooksConfig = {
        START_RUN: {
          commands: ['echo "stdout" && echo "stderr" >&2'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'stdout',
        stderr: 'stderr',
        all: 'stdout\nstderr',
      } as any);

      const result = await executeHook('START_RUN', hooksWithOutput, mockContext);

      expect(result.success).toBe(true);
      expect(result.commandResults[0].stdout).toBe('stdout');
      expect(result.commandResults[0].stderr).toBe('stderr');
    });

    it('should handle command failure with non-zero exit code', async () => {
      const hooksWithFailure: HooksConfig = {
        END_RUN: {
          commands: ['exit 1', 'echo "should still run"'],
        },
      };

      mockedExeca
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'Command failed',
          all: 'Command failed',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'should still run',
          stderr: '',
          all: 'should still run',
        } as any);

      const result = await executeHook('END_RUN', hooksWithFailure, mockContext);

      expect(result.success).toBe(false);
      expect(result.commandsExecuted).toBe(2);
      expect(result.commandsFailed).toBe(1);

      // First command should fail
      expect(result.commandResults[0].success).toBe(false);
      expect(result.commandResults[0].exitCode).toBe(1);

      // Second command should still run (continueOnError default is true)
      expect(result.commandResults[1].success).toBe(true);
      expect(result.commandResults[1].exitCode).toBe(0);
    });

    it('should handle command timeout', async () => {
      const hooksWithTimeout: HooksConfig = {
        START_RUN: {
          commands: ['sleep 10'],
        },
      };

      const timeoutError = new Error('Command timed out');
      (timeoutError as any).timedOut = true;
      mockedExeca.mockRejectedValueOnce(timeoutError);

      const result = await executeHook('START_RUN', hooksWithTimeout, mockContext, {
        commandTimeout: 100,
      });

      expect(result.success).toBe(false);
      expect(result.commandsExecuted).toBe(1);
      expect(result.commandsFailed).toBe(1);
      expect(result.commandResults[0].success).toBe(false);
      expect(result.commandResults[0].exitCode).toBe(-1);
      expect(result.commandResults[0].error).toBeDefined();
    });

    it('should return silently when hook is not defined', async () => {
      const result = await executeHook('START_RUN', {}, mockContext);

      expect(result.success).toBe(true);
      expect(result.commandsExecuted).toBe(0);
      expect(result.commandsFailed).toBe(0);
      expect(result.commandResults).toHaveLength(0);
      expect(mockedExeca).not.toHaveBeenCalled();
    });

    it('should return silently when commands array is empty', async () => {
      const emptyHooks: HooksConfig = {
        START_RUN: {
          commands: [],
        },
      };

      const result = await executeHook('START_RUN', emptyHooks, mockContext);

      expect(result.success).toBe(true);
      expect(result.commandsExecuted).toBe(0);
      expect(result.commandsFailed).toBe(0);
      expect(result.commandResults).toHaveLength(0);
      expect(mockedExeca).not.toHaveBeenCalled();
    });

    it('should execute multiple commands in sequence', async () => {
      const sequentialHooks: HooksConfig = {
        START_ITERATION: {
          commands: ['echo "first"', 'echo "second"', 'echo "third"'],
        },
      };

      mockedExeca
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'first',
          stderr: '',
          all: 'first',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'second',
          stderr: '',
          all: 'second',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'third',
          stderr: '',
          all: 'third',
        } as any);

      const result = await executeHook('START_ITERATION', sequentialHooks, mockContext);

      expect(result.success).toBe(true);
      expect(result.commandsExecuted).toBe(3);
      expect(mockedExeca).toHaveBeenCalledTimes(3);

      // Verify commands were called in order
      expect(mockedExeca).toHaveBeenNthCalledWith(1, 'echo "first"', expect.objectContaining({
        shell: true,
      }));
      expect(mockedExeca).toHaveBeenNthCalledWith(2, 'echo "second"', expect.objectContaining({
        shell: true,
      }));
      expect(mockedExeca).toHaveBeenNthCalledWith(3, 'echo "third"', expect.objectContaining({
        shell: true,
      }));
    });

    it('should inject environment variables from context', async () => {
      const envHooks: HooksConfig = {
        START_ITERATION: {
          commands: ['echo $HOOK_TYPE $ITERATION $SESSION_ID'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'START_ITERATION 1 test-session-123',
        stderr: '',
        all: 'START_ITERATION 1 test-session-123',
      } as any);

      await executeHook('START_ITERATION', envHooks, mockContext);

      expect(mockedExeca).toHaveBeenCalledWith('echo $HOOK_TYPE $ITERATION $SESSION_ID', expect.objectContaining({
        shell: true,
        env: expect.objectContaining({
          HOOK_TYPE: 'START_ITERATION',
          ITERATION: '1',
          SESSION_ID: 'test-session-123',
          RUN_ID: 'run-456',
          TOTAL_ITERATIONS: '5',
          JUNO_TESTKEY: 'testValue', // metadata prefixed with JUNO_
        }),
      }));
    });

    it('should use custom environment variables from options', async () => {
      const customEnvHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo $CUSTOM_VAR'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'custom-value',
        stderr: '',
        all: 'custom-value',
      } as any);

      await executeHook('START_RUN', customEnvHooks, mockContext, {
        env: { CUSTOM_VAR: 'custom-value' },
      });

      expect(mockedExeca).toHaveBeenCalledWith('echo $CUSTOM_VAR', expect.objectContaining({
        shell: true,
        env: expect.objectContaining({
          CUSTOM_VAR: 'custom-value',
        }),
      }));
    });

    it('should stop execution on error when continueOnError is false', async () => {
      const stopOnErrorHooks: HooksConfig = {
        END_ITERATION: {
          commands: ['exit 1', 'echo "should not run"'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'Command failed',
        all: 'Command failed',
      } as any);

      const result = await executeHook('END_ITERATION', stopOnErrorHooks, mockContext, {
        continueOnError: false,
      });

      expect(result.success).toBe(false);
      expect(result.commandsExecuted).toBe(1); // Should stop after first failure
      expect(result.commandsFailed).toBe(1);
      expect(mockedExeca).toHaveBeenCalledTimes(1);
    });

    it('should handle execution errors gracefully', async () => {
      const errorHooks: HooksConfig = {
        START_RUN: {
          commands: ['invalid-command-xyz'],
        },
      };

      const executionError = new Error('Command not found');
      mockedExeca.mockRejectedValueOnce(executionError);

      const result = await executeHook('START_RUN', errorHooks, mockContext);

      expect(result.success).toBe(false);
      expect(result.commandsExecuted).toBe(1);
      expect(result.commandsFailed).toBe(1);
      expect(result.commandResults[0].success).toBe(false);
      expect(result.commandResults[0].exitCode).toBe(-1);
      expect(result.commandResults[0].error).toBe(executionError);
    });

    it('should use custom command timeout', async () => {
      const timeoutHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo "test"'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'test',
        stderr: '',
        all: 'test',
      } as any);

      await executeHook('START_RUN', timeoutHooks, mockContext, {
        commandTimeout: 5000,
      });

      expect(mockedExeca).toHaveBeenCalledWith('echo "test"', expect.objectContaining({
        shell: true,
        timeout: 5000,
      }));
    });

    it('should use default working directory when not specified in context', async () => {
      const basicHooks: HooksConfig = {
        START_RUN: {
          commands: ['pwd'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: process.cwd(),
        stderr: '',
        all: process.cwd(),
      } as any);

      await executeHook('START_RUN', basicHooks, {});

      expect(mockedExeca).toHaveBeenCalledWith('pwd', expect.objectContaining({
        shell: true,
        cwd: process.cwd(),
      }));
    });
  });

  describe('executeHooks', () => {
    const batchHooks: HooksConfig = {
      START_RUN: {
        commands: ['echo "start"'],
      },
      START_ITERATION: {
        commands: ['echo "iteration"'],
      },
      END_ITERATION: {
        commands: ['echo "end iteration"'],
      },
      END_RUN: {
        commands: ['echo "end"'],
      },
    };

    it('should execute multiple hooks in sequence', async () => {
      mockedExeca
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'start',
          stderr: '',
          all: 'start',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'iteration',
          stderr: '',
          all: 'iteration',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'end',
          stderr: '',
          all: 'end',
        } as any);

      const hookTypes: HookType[] = ['START_RUN', 'START_ITERATION', 'END_RUN'];
      const results = await executeHooks(hookTypes, batchHooks);

      expect(results).toHaveLength(3);
      expect(results[0].hookType).toBe('START_RUN');
      expect(results[1].hookType).toBe('START_ITERATION');
      expect(results[2].hookType).toBe('END_RUN');
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should continue executing hooks even if one fails', async () => {
      mockedExeca
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'start',
          stderr: '',
          all: 'start',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'iteration failed',
          all: 'iteration failed',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'end',
          stderr: '',
          all: 'end',
        } as any);

      const hookTypes: HookType[] = ['START_RUN', 'START_ITERATION', 'END_RUN'];
      const results = await executeHooks(hookTypes, batchHooks);

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false); // Failed hook
      expect(results[2].success).toBe(true); // Should still execute
    });

    it('should handle empty hook types array', async () => {
      const results = await executeHooks([], batchHooks);

      expect(results).toHaveLength(0);
      expect(mockedExeca).not.toHaveBeenCalled();
    });
  });

  describe('validateHooksConfig', () => {
    it('should validate valid hooks configuration', () => {
      const validHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo "starting"', 'npm install'],
        },
        END_ITERATION: {
          commands: ['npm test'],
        },
      };

      const result = validateHooksConfig(validHooks);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should detect invalid hook types', () => {
      const invalidHooks = {
        INVALID_HOOK: {
          commands: ['echo "test"'],
        },
        START_RUN: {
          commands: ['echo "valid"'],
        },
      };

      const result = validateHooksConfig(invalidHooks);

      expect(result.valid).toBe(true); // Still valid, just warnings
      expect(result.issues).toHaveLength(0);
      expect(result.warnings).toContain('Unknown hook type: INVALID_HOOK. Valid types are: START_RUN, START_ITERATION, END_ITERATION, END_RUN');
    });

    it('should detect missing commands array', () => {
      const hooksWithMissingCommands = {
        START_RUN: {
          // Missing commands array
        },
      };

      const result = validateHooksConfig(hooksWithMissingCommands as any);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Hook START_RUN is missing \'commands\' array');
    });

    it('should detect non-array commands field', () => {
      const hooksWithInvalidCommands = {
        START_RUN: {
          commands: 'not an array',
        },
      };

      const result = validateHooksConfig(hooksWithInvalidCommands as any);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Hook START_RUN \'commands\' must be an array');
    });

    it('should detect non-string commands', () => {
      const hooksWithInvalidCommandTypes = {
        START_RUN: {
          commands: ['valid command', 42, true, 'another valid'],
        },
      };

      const result = validateHooksConfig(hooksWithInvalidCommandTypes as any);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Hook START_RUN command 1 must be a string, got number');
      expect(result.issues).toContain('Hook START_RUN command 2 must be a string, got boolean');
    });

    it('should warn about empty commands', () => {
      const hooksWithEmptyCommands: HooksConfig = {
        START_RUN: {
          commands: ['echo "valid"', '', '   ', 'echo "also valid"'],
        },
      };

      const result = validateHooksConfig(hooksWithEmptyCommands);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('Hook START_RUN command 1 is empty');
      expect(result.warnings).toContain('Hook START_RUN command 2 is empty');
    });

    it('should warn about dangerous commands', () => {
      const dangerousHooks: HooksConfig = {
        START_RUN: {
          commands: [
            'rm -rf /',
            'sudo rm -rf /important',
            'format c:',
            'del /s /q',
            'echo "safe command"',
          ],
        },
      };

      const result = validateHooksConfig(dangerousHooks);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('rm -rf /'))).toBe(true);
      expect(result.warnings.some(w => w.includes('sudo rm -rf /important'))).toBe(true);
      expect(result.warnings.some(w => w.includes('format c:'))).toBe(true);
      expect(result.warnings.some(w => w.includes('del /s /q'))).toBe(true);
    });

    it('should handle empty hooks configuration', () => {
      const result = validateHooksConfig({});

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should validate all hook types at once', () => {
      const completeHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo "start run"'],
        },
        START_ITERATION: {
          commands: ['echo "start iteration"'],
        },
        END_ITERATION: {
          commands: ['echo "end iteration"'],
        },
        END_RUN: {
          commands: ['echo "end run"'],
        },
      };

      const result = validateHooksConfig(completeHooks);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('error handling and logging', () => {
    it('should not throw exceptions on command failure', async () => {
      const failingHooks: HooksConfig = {
        START_RUN: {
          commands: ['exit 1'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'Command failed',
        all: 'Command failed',
      } as any);

      // Should not throw
      const result = await executeHook('START_RUN', failingHooks);

      expect(result.success).toBe(false);
      expect(result.commandResults[0].success).toBe(false);
    });

    it('should continue execution after command failure', async () => {
      const mixedHooks: HooksConfig = {
        START_ITERATION: {
          commands: ['exit 1', 'echo "continued"', 'exit 2'],
        },
      };

      mockedExeca
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'First failure',
          all: 'First failure',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'continued',
          stderr: '',
          all: 'continued',
        } as any)
        .mockResolvedValueOnce({
          exitCode: 2,
          stdout: '',
          stderr: 'Second failure',
          all: 'Second failure',
        } as any);

      const result = await executeHook('START_ITERATION', mixedHooks);

      expect(result.commandsExecuted).toBe(3);
      expect(result.commandsFailed).toBe(2);
      expect(result.success).toBe(false);

      // All commands should have been executed
      expect(result.commandResults[0].exitCode).toBe(1);
      expect(result.commandResults[1].exitCode).toBe(0);
      expect(result.commandResults[2].exitCode).toBe(2);
    });

    it('should log execution details', async () => {
      const testHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo "test"'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'test',
        stderr: '',
        all: 'test',
      } as any);

      await executeHook('START_RUN', testHooks);

      // Logger should have been called with appropriate context
      const { logger } = await import('../../cli/utils/advanced-logger.js');
      expect(logger.child).toHaveBeenCalled();
    });
  });

  describe('auto-migration functionality', () => {
    it('should create config.json when missing', async () => {
      const { loadConfig } = await import('../../core/config.js');

      // Ensure clean test directory
      const configDir = join(testDir, '.juno_task');
      const configPath = join(configDir, 'config.json');

      expect(await fs.pathExists(configPath)).toBe(false);

      // Call loadConfig which should trigger ensureHooksConfig internally
      await loadConfig({ baseDir: testDir });

      // Check that config was created
      expect(await fs.pathExists(configPath)).toBe(true);

      const config = await fs.readJson(configPath);
      // Auto-migration now includes default hooks template with file size monitoring
      expect(config.hooks).toMatchObject({
        START_ITERATION: {
          commands: expect.arrayContaining([
            expect.stringContaining('CLAUDE.md'),
            expect.stringContaining('AGENTS.md')
          ])
        }
      });
    });

    it('should add hooks field to existing config', async () => {
      const { loadConfig } = await import('../../core/config.js');

      const configDir = join(testDir, '.juno_task');
      const configPath = join(configDir, 'config.json');

      // Create existing config without hooks field
      await fs.ensureDir(configDir);
      await fs.writeJson(configPath, {
        defaultSubagent: 'claude',
        logLevel: 'info',
        verbose: false,
      });

      await loadConfig({ baseDir: testDir });

      const config = await fs.readJson(configPath);
      // Auto-migration now includes default hooks template with file size monitoring
      expect(config.hooks).toMatchObject({
        START_ITERATION: {
          commands: expect.arrayContaining([
            expect.stringContaining('CLAUDE.md'),
            expect.stringContaining('AGENTS.md')
          ])
        }
      });
      expect(config.defaultSubagent).toBe('claude'); // Preserve existing config
      expect(config.logLevel).toBe('info');
    });

    it('should preserve existing hooks configuration', async () => {
      const { loadConfig } = await import('../../core/config.js');

      const configDir = join(testDir, '.juno_task');
      const configPath = join(configDir, 'config.json');

      // Create existing config with hooks field
      await fs.ensureDir(configDir);
      const existingHooks = {
        START_RUN: {
          commands: ['echo "existing"'],
        },
      };
      await fs.writeJson(configPath, {
        defaultSubagent: 'claude',
        hooks: existingHooks,
      });

      await loadConfig({ baseDir: testDir });

      const config = await fs.readJson(configPath);
      expect(config.hooks).toEqual(existingHooks); // Should be unchanged
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('should handle undefined context gracefully', async () => {
      const simpleHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo "test"'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'test',
        stderr: '',
        all: 'test',
      } as any);

      const result = await executeHook('START_RUN', simpleHooks);

      expect(result.success).toBe(true);
      expect(mockedExeca).toHaveBeenCalledWith('echo "test"', expect.objectContaining({
        shell: true,
        env: expect.objectContaining({
          HOOK_TYPE: 'START_RUN',
          ITERATION: '',
          SESSION_ID: '',
          RUN_ID: '',
          TOTAL_ITERATIONS: '',
        }),
      }));
    });

    it('should handle very long command output', async () => {
      const longOutputHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo "test"'],
        },
      };

      const longOutput = 'x'.repeat(10000);
      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: longOutput,
        stderr: '',
        all: longOutput,
      } as any);

      const result = await executeHook('START_RUN', longOutputHooks);

      expect(result.success).toBe(true);
      expect(result.commandResults[0].stdout).toBe(longOutput);
    });

    it('should handle special characters in commands', async () => {
      const specialCharHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo "Hello & goodbye; echo done | cat"'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'Hello & goodbye; echo done | cat',
        stderr: '',
        all: 'Hello & goodbye; echo done | cat',
      } as any);

      const result = await executeHook('START_RUN', specialCharHooks);

      expect(result.success).toBe(true);
      expect(mockedExeca).toHaveBeenCalledWith('echo "Hello & goodbye; echo done | cat"', expect.any(Object));
    });

    it('should handle metadata with special characters', async () => {
      const specialMetadataContext: HookExecutionContext = {
        metadata: {
          'special-key': 'value with spaces',
          'number_key': 123,
          'boolean_key': true,
        },
      };

      const metadataHooks: HooksConfig = {
        START_RUN: {
          commands: ['echo "test"'],
        },
      };

      mockedExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'test',
        stderr: '',
        all: 'test',
      } as any);

      await executeHook('START_RUN', metadataHooks, specialMetadataContext);

      expect(mockedExeca).toHaveBeenCalledWith('echo "test"', expect.objectContaining({
        env: expect.objectContaining({
          'JUNO_SPECIAL-KEY': 'value with spaces',
          'JUNO_NUMBER_KEY': '123',
          'JUNO_BOOLEAN_KEY': 'true',
        }),
      }));
    });
  });
});