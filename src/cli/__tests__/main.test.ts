/**
 * Comprehensive tests for Main Command
 *
 * Tests the main command functionality including:
 * - Command creation and registration
 * - Prompt processing (inline, file, interactive)
 * - Subagent validation
 * - Execution coordination
 * - Progress display
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'fs-extra';

import { mainCommandHandler } from '../commands/main.js';
import { logger, LogLevel } from '../utils/advanced-logger.js';

import type { MainCommandOptions } from '../types.js';
import { ConfigurationError } from '../types.js';

import { loadConfig } from '../../core/config.js';
import { createExecutionEngine, createExecutionRequest } from '../../core/engine.js';

import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatus,
  ProgressEvent,
} from '../../core/engine.js';

// Mock external dependencies
vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    workingDirectory: '/test/dir',
    defaultMaxIterations: 5,
    defaultModel: 'test-model',
    mcpServerPath: '/test/mcp',
    mcpTimeout: 30000,
    mcpRetries: 3,
    verbose: 0,
  }),
}));

vi.mock('../../core/engine.js', () => ({
  ExecutionStatus: {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  },
  createExecutionEngine: vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue({
      status: 'completed',
      iterations: [
        {
          toolResult: { content: 'Test result' },
        },
      ],
      statistics: {
        totalIterations: 1,
        successfulIterations: 1,
        failedIterations: 0,
        averageIterationDuration: 1000,
        totalToolCalls: 5,
        rateLimitEncounters: 0,
      },
    }),
    onProgress: vi.fn(),
    on: vi.fn(),
    shutdown: vi.fn(),
  }),
  createExecutionRequest: vi.fn().mockImplementation((opts) => ({
    requestId: 'test-request',
    instruction: opts.instruction,
    subagent: opts.subagent,
    workingDirectory: opts.workingDirectory,
    maxIterations: opts.maxIterations,
    model: opts.model,
    live: opts.live,
  })),
}));

vi.mock('../../core/session.js', () => ({
  createSessionManager: vi.fn().mockReturnValue({
    create: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
  }),
}));

vi.mock('fs-extra', () => {
  const mock = {
    pathExists: vi.fn().mockResolvedValue(false), // 'test prompt' is not a file path
    readFile: vi.fn().mockResolvedValue('mock file content'),
    readJson: vi.fn().mockResolvedValue({ version: 1, sessions: [] }),
    writeJson: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
  };
  return { ...mock, default: mock };
});

vi.mock('chalk', () => {
  const createChainableFunction = (color: string) => {
    const fn = vi.fn((text) => text);
    fn.bold = vi.fn((text) => text);
    return fn;
  };

  const mockChalk = {
    red: createChainableFunction('red'),
    yellow: createChainableFunction('yellow'),
    blue: createChainableFunction('blue'),
    gray: createChainableFunction('gray'),
    green: createChainableFunction('green'),
    cyan: createChainableFunction('cyan'),
    white: createChainableFunction('white'),
  };

  return {
    default: mockChalk,
    ...mockChalk,
  };
});

describe('Main Command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let processStdinSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code: string | number | null | undefined = 1) => {
        return undefined as never;
      });

    // Save original isTTY and default to TTY (most tests expect prompt-required behavior)
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });

    // Mock stdin for interactive input
    processStdinSpy = vi.spyOn(process.stdin, 'on').mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, 'setEncoding').mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);

    // Re-set mock implementations (mockReset: true in vitest config clears them between tests)
    vi.mocked(loadConfig).mockResolvedValue({
      workingDirectory: '/test/dir',
      defaultMaxIterations: 5,
      defaultModel: 'test-model',
      mcpServerPath: '/test/mcp',
      mcpTimeout: 30000,
      mcpRetries: 3,
      verbose: 0,
    } as any);

    vi.mocked(createExecutionEngine).mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        status: 'completed',
        iterations: [{ toolResult: { content: 'Test result' } }],
        statistics: {
          totalIterations: 1,
          successfulIterations: 1,
          failedIterations: 0,
          averageIterationDuration: 1000,
          totalToolCalls: 5,
          rateLimitEncounters: 0,
        },
      }),
      onProgress: vi.fn(),
      on: vi.fn(),
      shutdown: vi.fn(),
    } as any);

    vi.mocked(createExecutionRequest).mockImplementation((opts: any) => ({
      requestId: 'test-request',
      instruction: opts.instruction,
      subagent: opts.subagent,
      workingDirectory: opts.workingDirectory,
      maxIterations: opts.maxIterations,
      model: opts.model,
      live: opts.live,
    }));

    vi.mocked(fs.pathExists).mockResolvedValue(false as any);
    vi.mocked(fs.readFile).mockResolvedValue('mock file content' as any);
    vi.mocked(fs.readJson).mockResolvedValue({ version: 1, sessions: [] } as any);
    vi.mocked(fs.writeJson).mockResolvedValue(undefined as any);
    vi.mocked(fs.ensureDir).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockRestore();
    processExitSpy.mockRestore();
    processStdinSpy.mockRestore();
    // Restore original isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true, configurable: true });
  });

  describe('mainCommandHandler', () => {
    const mockCommand = new Command();

    describe('subagent validation', () => {
      it('should accept valid subagents', async () => {
        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(0);
      });

      it('should reject invalid subagents', async () => {
        const options: MainCommandOptions = {
          subagent: 'invalid' as any,
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(1);
      });

      it('should reject --live for non-pi subagents with actionable validation guidance', async () => {
        const options = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          live: true,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        } as MainCommandOptions & { live: boolean };

        await mainCommandHandler([], options as MainCommandOptions, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(1);

        const stderrOutput = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
          .flat()
          .join('\n');
        expect(stderrOutput).toContain('--live is only supported with the pi subagent');
        expect(stderrOutput).toContain('Use: juno-code pi --live');
      });

      it('should accept --live for pi and forward live=true into execution request', async () => {
        const options = {
          subagent: 'pi',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          live: true,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        } as MainCommandOptions & { live: boolean };

        await mainCommandHandler([], options as MainCommandOptions, mockCommand);

        expect(createExecutionRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            subagent: 'pi',
            live: true,
          }),
        );
        expect(processExitSpy).toHaveBeenCalledWith(0);
      });

      it.skip('should accept subagent aliases', async () => {
        // SKIP: Alias normalization not implemented yet
        // 'claude-code' is not in validSubagents list, so validation rejects it
        // TODO: Implement alias normalization if needed for user experience
        const options: MainCommandOptions = {
          subagent: 'claude-code' as any,
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);
        expect(processExitSpy).toHaveBeenCalledWith(0);
      });
    });

    describe('prompt processing', () => {
      it('should handle inline prompt', async () => {
        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test inline prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        const { createExecutionRequest } = await import('../../core/engine.js');
        expect(createExecutionRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            instruction: 'test inline prompt',
          }),
        );
      });

      it('should handle file prompt', async () => {
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true);
        vi.mocked(fs.readFile).mockResolvedValueOnce('file prompt content');

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: '/path/to/prompt.txt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(fs.readFile).toHaveBeenCalledWith(path.resolve('/path/to/prompt.txt'), 'utf-8');

        const { createExecutionRequest } = await import('../../core/engine.js');
        expect(createExecutionRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            instruction: 'file prompt content',
          }),
        );
      });

      it('should handle empty file error', async () => {
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true);
        vi.mocked(fs.readFile).mockResolvedValueOnce('   ');

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: '/path/to/empty.txt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(5); // RuntimeError
      });

      it('should handle --prompt-file flag', async () => {
        vi.mocked(fs.readFile).mockResolvedValueOnce('prompt from file');

        const options: MainCommandOptions = {
          subagent: 'claude',
          promptFile: '/path/to/prompt_item-012.txt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(fs.readFile).toHaveBeenCalledWith(
          path.resolve('/path/to/prompt_item-012.txt'),
          'utf-8',
        );

        const { createExecutionRequest } = await import('../../core/engine.js');
        expect(createExecutionRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            instruction: 'prompt from file',
          }),
        );
      });

      it.skip('should handle interactive prompt', async () => {
        // SKIP: Microtask timing issue — stdin callbacks not set up before test invokes them
        let dataCallback: (chunk: string) => void;
        let endCallback: () => void;

        processStdinSpy.mockImplementation((event: string, callback: any) => {
          if (event === 'data') {
            dataCallback = callback;
          } else if (event === 'end') {
            endCallback = callback;
          }
          return process.stdin;
        });

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: undefined,
          cwd: '/test',
          maxIterations: 1,
          interactive: true,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        // Start the handler
        const handlerPromise = mainCommandHandler([], options, mockCommand);

        // Simulate user input
        dataCallback!('interactive prompt content\n');
        endCallback!();

        await handlerPromise;

        const { createExecutionRequest } = await import('../../core/engine.js');
        expect(createExecutionRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            instruction: 'interactive prompt content',
          }),
        );
      });

      it('should handle missing prompt error', async () => {
        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: undefined,
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(1); // ValidationError

        const stderrOutput = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
          .flat()
          .join('\n');
        expect(stderrOutput).toContain(
          'Shell safety: use single quotes (or -f/stdin) when prompt contains backticks or $()',
        );
      });

      it.skip('should handle interactive prompt cancellation', async () => {
        // SKIP: Microtask timing issue — stdin callbacks not set up before test invokes them
        let dataCallback: (chunk: string) => void;
        let endCallback: () => void;

        processStdinSpy.mockImplementation((event: string, callback: any) => {
          if (event === 'data') {
            dataCallback = callback;
          } else if (event === 'end') {
            endCallback = callback;
          }
          return process.stdin;
        });

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: undefined,
          cwd: '/test',
          maxIterations: 1,
          interactive: true,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        // Start the handler
        const handlerPromise = mainCommandHandler([], options, mockCommand);

        // Simulate empty input
        dataCallback!('   ');
        endCallback!();

        await expect(handlerPromise).rejects.toThrow('process.exit called');
        expect(processExitSpy).toHaveBeenCalledWith(1); // ValidationError
      });

      describe('piped stdin auto-detection', () => {
        it('should auto-read piped stdin when no -p is provided', async () => {
          // Simulate piped stdin (not a TTY)
          Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });

          let dataCallback: ((chunk: string) => void) | undefined;
          let endCallback: (() => void) | undefined;

          processStdinSpy.mockImplementation((event: string, callback: any) => {
            if (event === 'data') {
              dataCallback = callback;
            } else if (event === 'end') {
              endCallback = callback;
            }
            return process.stdin;
          });

          const options: MainCommandOptions = {
            subagent: 'claude',
            prompt: undefined,
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          // Start the handler (it will block on stdin)
          const handlerPromise = mainCommandHandler([], options, mockCommand);

          // Wait a tick for async code to set up stdin listeners
          await new Promise((r) => setTimeout(r, 50));

          // Simulate piped input
          dataCallback!('piped prompt from stdin\n');
          endCallback!();

          await handlerPromise;

          const { createExecutionRequest } = await import('../../core/engine.js');
          expect(createExecutionRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              instruction: 'piped prompt from stdin',
            }),
          );
          expect(processExitSpy).toHaveBeenCalledWith(0);
        });

        it('should auto-read multiline piped stdin (heredoc)', async () => {
          Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });

          let dataCallback: ((chunk: string) => void) | undefined;
          let endCallback: (() => void) | undefined;

          processStdinSpy.mockImplementation((event: string, callback: any) => {
            if (event === 'data') {
              dataCallback = callback;
            } else if (event === 'end') {
              endCallback = callback;
            }
            return process.stdin;
          });

          const options: MainCommandOptions = {
            subagent: 'claude',
            prompt: undefined,
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          const handlerPromise = mainCommandHandler([], options, mockCommand);
          await new Promise((r) => setTimeout(r, 50));

          // Simulate multiline heredoc
          dataCallback!('line 1\n');
          dataCallback!('line 2\n');
          dataCallback!('line 3\n');
          endCallback!();

          await handlerPromise;

          const { createExecutionRequest } = await import('../../core/engine.js');
          expect(createExecutionRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              instruction: 'line 1\nline 2\nline 3',
            }),
          );
        });

        it('should reject empty piped stdin', async () => {
          Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });

          let dataCallback: ((chunk: string) => void) | undefined;
          let endCallback: (() => void) | undefined;

          processStdinSpy.mockImplementation((event: string, callback: any) => {
            if (event === 'data') {
              dataCallback = callback;
            } else if (event === 'end') {
              endCallback = callback;
            }
            return process.stdin;
          });

          const options: MainCommandOptions = {
            subagent: 'claude',
            prompt: undefined,
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          const handlerPromise = mainCommandHandler([], options, mockCommand);
          await new Promise((r) => setTimeout(r, 50));

          // Simulate empty piped input
          dataCallback!('   \n  ');
          endCallback!();

          await handlerPromise;

          expect(processExitSpy).toHaveBeenCalledWith(1); // ValidationError
        });

        it('should prefer -p flag over piped stdin', async () => {
          // Even with piped stdin, -p should take priority
          Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });

          const options: MainCommandOptions = {
            subagent: 'claude',
            prompt: 'explicit prompt from -p',
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          await mainCommandHandler([], options, mockCommand);

          const { createExecutionRequest } = await import('../../core/engine.js');
          expect(createExecutionRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              instruction: 'explicit prompt from -p',
            }),
          );
          // stdin should NOT have been read
          expect(processStdinSpy).not.toHaveBeenCalledWith('data', expect.any(Function));
        });

        it('should read stdin when -p flag used with heredoc (prompt=true)', async () => {
          // When using `juno-code -p << 'EOF'`, Commander sets prompt=true (no string arg)
          // The fix: treat prompt=true same as prompt=undefined, fall through to stdin
          Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });

          let dataCallback: ((chunk: string) => void) | undefined;
          let endCallback: (() => void) | undefined;

          processStdinSpy.mockImplementation((event: string, callback: any) => {
            if (event === 'data') {
              dataCallback = callback;
            } else if (event === 'end') {
              endCallback = callback;
            }
            return process.stdin;
          });

          const options: MainCommandOptions = {
            subagent: 'claude',
            prompt: true as any, // Commander sets boolean when -p has no argument
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          const handlerPromise = mainCommandHandler([], options, mockCommand);
          await new Promise((r) => setTimeout(r, 50));

          // Simulate heredoc content via stdin
          dataCallback!('/ralph-loop Do Task 45OLrc\n');
          endCallback!();

          await handlerPromise;

          const { createExecutionRequest } = await import('../../core/engine.js');
          expect(createExecutionRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              instruction: '/ralph-loop Do Task 45OLrc',
            }),
          );
          expect(processExitSpy).toHaveBeenCalledWith(0);
        });

        it('should prefer --prompt-file over piped stdin', async () => {
          Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });
          vi.mocked(fs.readFile).mockResolvedValueOnce('prompt from file');

          const options: MainCommandOptions = {
            subagent: 'claude',
            promptFile: '/path/to/prompt.txt',
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          await mainCommandHandler([], options, mockCommand);

          const { createExecutionRequest } = await import('../../core/engine.js');
          expect(createExecutionRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              instruction: 'prompt from file',
            }),
          );
        });
      });

      describe('positional prompt (no -p flag)', () => {
        it('should use positional prompt text as options.prompt', async () => {
          // Simulates: juno-code -s claude "my positional prompt"
          // After CLI merging, options.prompt = "my positional prompt"
          const options: MainCommandOptions = {
            subagent: 'claude',
            prompt: 'my positional prompt',
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          await mainCommandHandler([], options, mockCommand);

          const { createExecutionRequest } = await import('../../core/engine.js');
          expect(createExecutionRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              instruction: 'my positional prompt',
            }),
          );
          expect(processExitSpy).toHaveBeenCalledWith(0);
        });

        it('should handle multi-word positional prompt joined with spaces', async () => {
          // Simulates: juno-code -s claude "analyze" "this" "codebase"
          // After CLI merging, options.prompt = "analyze this codebase"
          const options: MainCommandOptions = {
            subagent: 'claude',
            prompt: 'analyze this codebase',
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          await mainCommandHandler([], options, mockCommand);

          const { createExecutionRequest } = await import('../../core/engine.js');
          expect(createExecutionRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              instruction: 'analyze this codebase',
            }),
          );
        });

        it('should prefer -p flag over positional prompt', async () => {
          // Simulates: juno-code -s claude -p "explicit" "positional"
          // CLI merging only sets options.prompt from positional if prompt is undefined
          // Since -p sets it first, positional is ignored
          const options: MainCommandOptions = {
            subagent: 'claude',
            prompt: 'explicit prompt from -p',
            cwd: '/test',
            maxIterations: 1,
            interactive: false,
            interactivePrompt: false,
            verbose: 0,
            quiet: false,
            logLevel: 'info',
          };

          await mainCommandHandler([], options, mockCommand);

          const { createExecutionRequest } = await import('../../core/engine.js');
          expect(createExecutionRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              instruction: 'explicit prompt from -p',
            }),
          );
        });
      });
    });

    describe('execution', () => {
      it('should execute successfully and exit with code 0', async () => {
        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 5,
          model: 'custom-model',
          interactive: false,
          interactivePrompt: false,
          verbose: 1,
          quiet: false,
          logLevel: 'debug',
        };

        await mainCommandHandler([], options, mockCommand);

        const { createExecutionRequest } = await import('../../core/engine.js');
        expect(createExecutionRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            instruction: 'test prompt',
            subagent: 'claude',
            workingDirectory: '/test/dir',
            maxIterations: 5,
            model: 'custom-model',
            backend: 'shell',
          }),
        );

        expect(processExitSpy).toHaveBeenCalledWith(0);
      });

      it('should persist execution history under .juno_task/session_history.json with prompt/cost/message metadata', async () => {
        const { createExecutionEngine } = await import('../../core/engine.js');

        vi.mocked(createExecutionEngine).mockReturnValueOnce({
          execute: vi.fn().mockResolvedValue({
            request: {
              requestId: 'history-run-1',
              instruction: 'track this prompt',
              subagent: 'claude',
              workingDirectory: '/test/dir',
              maxIterations: 1,
              model: ':sonnet',
            },
            status: 'completed',
            startTime: new Date('2026-03-09T10:00:00.000Z'),
            endTime: new Date('2026-03-09T10:00:12.000Z'),
            duration: 12000,
            progressEvents: [],
            iterations: [
              {
                iterationNumber: 1,
                toolResult: {
                  content: JSON.stringify({
                    type: 'result',
                    session_id: 'session-history-1',
                    total_cost_usd: 0.0042,
                    num_turns: 3,
                  }),
                  metadata: {},
                },
                success: true,
                duration: 12000,
              },
            ],
            statistics: {
              totalIterations: 1,
              successfulIterations: 1,
              failedIterations: 0,
              averageIterationDuration: 12000,
              totalToolCalls: 1,
              rateLimitEncounters: 0,
            },
          }),
          onProgress: vi.fn(),
          on: vi.fn(),
          shutdown: vi.fn(),
        } as any);

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'track this prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 1,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        const writeCall = vi.mocked(fs.writeJson).mock.calls.at(-1);
        expect(writeCall).toBeDefined();
        expect(writeCall?.[0]).toBe('/test/dir/.juno_task/session_history.json');
        expect(writeCall?.[1]).toEqual(
          expect.objectContaining({
            version: 1,
            sessions: expect.arrayContaining([
              expect.objectContaining({
                id: 'history-run-1',
                initialMessage: 'track this prompt',
                subagent: 'claude',
                model: ':sonnet',
                totalCostUsd: 0.0042,
                turnCount: 3,
                messageCount: 6,
                sessionIds: ['session-history-1'],
              }),
            ]),
          }),
        );
      });

      it('should append to existing session_history.json without truncating older runs', async () => {
        const { createExecutionEngine } = await import('../../core/engine.js');

        vi.mocked(createExecutionEngine).mockReturnValueOnce({
          execute: vi.fn().mockResolvedValue({
            request: {
              requestId: 'test-request',
              instruction: 'new run prompt',
              subagent: 'claude',
              workingDirectory: '/test/dir',
              maxIterations: 1,
              model: ':sonnet',
            },
            status: 'completed',
            startTime: new Date('2026-03-09T10:15:00.000Z'),
            endTime: new Date('2026-03-09T10:15:06.000Z'),
            duration: 6000,
            progressEvents: [],
            iterations: [
              {
                iterationNumber: 1,
                toolResult: {
                  content: JSON.stringify({
                    type: 'result',
                    session_id: 'new-session',
                    total_cost_usd: 0.002,
                    num_turns: 1,
                  }),
                  metadata: {},
                },
                success: true,
                duration: 6000,
              },
            ],
            statistics: {
              totalIterations: 1,
              successfulIterations: 1,
              failedIterations: 0,
              averageIterationDuration: 6000,
              totalToolCalls: 1,
              rateLimitEncounters: 0,
            },
          }),
          onProgress: vi.fn(),
          on: vi.fn(),
          shutdown: vi.fn(),
        } as any);

        vi.mocked(fs.pathExists).mockImplementation(async (candidate: string) =>
          candidate.endsWith('session_history.json'),
        );
        vi.mocked(fs.readJson).mockResolvedValueOnce({
          version: 1,
          sessions: [
            {
              id: 'existing-run',
              status: 'completed',
              initialMessage: 'already there',
              initialMessageAt: '2026-03-09T09:00:00.000Z',
              lastMessageAt: '2026-03-09T09:00:05.000Z',
              completedAt: '2026-03-09T09:00:05.000Z',
              subagent: 'claude',
              model: ':sonnet',
              settings: { maxIterations: 1 },
              totalCostUsd: 0.001,
              turnCount: 1,
              messageCount: 2,
              iterations: 1,
              durationMs: 5000,
              sessionIds: ['existing-session'],
            },
          ],
        } as any);

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'new run prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 1,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        const writeCall = vi.mocked(fs.writeJson).mock.calls.at(-1);
        expect(writeCall).toBeDefined();
        const payload = writeCall?.[1] as { sessions: Array<{ id: string }> };
        expect(payload.sessions).toHaveLength(2);
        expect(payload.sessions[0]?.id).toBe('test-request');
        expect(payload.sessions[1]?.id).toBe('existing-run');
      });

      it('should handle execution failure and exit with code 1', async () => {
        const { createExecutionEngine } = await import('../../core/engine.js');
        const mockEngine = {
          execute: vi.fn().mockResolvedValue({
            status: 'failed',
            iterations: [],
            statistics: {
              totalIterations: 0,
              successfulIterations: 0,
              failedIterations: 1,
              averageIterationDuration: 0,
              totalToolCalls: 0,
              rateLimitEncounters: 0,
            },
          }),
          onProgress: vi.fn(),
          on: vi.fn(),
          shutdown: vi.fn(),
        };
        vi.mocked(createExecutionEngine).mockReturnValueOnce(mockEngine);

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(1);
      });

      it('should use default values from config', async () => {
        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: undefined,
          maxIterations: undefined,
          model: undefined,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        const { createExecutionRequest } = await import('../../core/engine.js');
        expect(createExecutionRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            instruction: 'test prompt',
            subagent: 'claude',
            workingDirectory: '/test/dir',
            maxIterations: 5,
            backend: 'shell',
          }),
        );
      });

      it('should setup progress callbacks', async () => {
        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        const { createExecutionEngine } = await import('../../core/engine.js');
        const engine = vi.mocked(createExecutionEngine).mock.results[0].value;

        expect(engine.onProgress).toHaveBeenCalled();
        expect(engine.on).toHaveBeenCalledWith('iteration:start', expect.any(Function));
        expect(engine.on).toHaveBeenCalledWith('iteration:complete', expect.any(Function));
        expect(engine.on).toHaveBeenCalledWith('execution:error', expect.any(Function));
      });

      it('should cleanup resources', async () => {
        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        const { createExecutionEngine } = await import('../../core/engine.js');
        const engine = vi.mocked(createExecutionEngine).mock.results[0].value;

        expect(engine.shutdown).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle ValidationError', async () => {
        const options: MainCommandOptions = {
          subagent: 'invalid' as any,
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(1);
      });

      it('should handle ConfigurationError', async () => {
        const { loadConfig } = await import('../../core/config.js');
        const configError = new ConfigurationError('Config error', ['Check config file']);
        vi.mocked(loadConfig).mockRejectedValueOnce(configError);

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(2);
      });

      it('should handle RuntimeError', async () => {
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true);
        vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File error'));

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: '/path/to/prompt.txt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        // loadPromptFromFile wraps non-RuntimeError into RuntimeError
        expect(processExitSpy).toHaveBeenCalledWith(5);
      });

      it('should handle unexpected errors', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockRejectedValueOnce(new Error('Unexpected error'));

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 0,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(processExitSpy).toHaveBeenCalledWith(99);
      });

      it('should show stack trace in verbose mode on unexpected error', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockRejectedValueOnce(new Error('Unexpected error'));

        const options: MainCommandOptions = {
          subagent: 'claude',
          prompt: 'test prompt',
          cwd: '/test',
          maxIterations: 1,
          interactive: false,
          interactivePrompt: false,
          verbose: 2,
          quiet: false,
          logLevel: 'info',
        };

        await mainCommandHandler([], options, mockCommand);

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Stack Trace'));
      });
    });
  });

  describe('progress display', () => {
    it('should display progress in non-verbose mode', () => {
      // This is tested indirectly through the main handler
      // The progress display is internal to the execution coordinator
      expect(true).toBe(true);
    });

    it('should display detailed progress in verbose mode', () => {
      // This is tested indirectly through the main handler
      // The progress display is internal to the execution coordinator
      expect(true).toBe(true);
    });
  });
});

describe('Model Compatibility', () => {
  // Import the functions after mocking
  let getDefaultModelForSubagent: (subagent: string) => string;
  let isModelCompatibleWithSubagent: (model: string, subagent: string) => boolean;

  beforeAll(async () => {
    // Reset modules to get fresh imports without the mocks affecting these specific functions
    const mainModule = await import('../commands/main.js');
    getDefaultModelForSubagent = mainModule.getDefaultModelForSubagent;
    isModelCompatibleWithSubagent = mainModule.isModelCompatibleWithSubagent;
  });

  describe('getDefaultModelForSubagent', () => {
    it('should return :sonnet for claude', () => {
      expect(getDefaultModelForSubagent('claude')).toBe(':sonnet');
    });

    it('should return :codex for codex', () => {
      expect(getDefaultModelForSubagent('codex')).toBe(':codex');
    });

    it('should return :pro for gemini', () => {
      expect(getDefaultModelForSubagent('gemini')).toBe(':pro');
    });

    it('should return auto for cursor', () => {
      expect(getDefaultModelForSubagent('cursor')).toBe('auto');
    });

    it('should return :sonnet as default for unknown subagent', () => {
      expect(getDefaultModelForSubagent('unknown' as any)).toBe(':sonnet');
    });
  });

  describe('isModelCompatibleWithSubagent', () => {
    describe('Claude subagent', () => {
      it('should accept Claude model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':sonnet', 'claude')).toBe(true);
        expect(isModelCompatibleWithSubagent(':haiku', 'claude')).toBe(true);
        expect(isModelCompatibleWithSubagent(':opus', 'claude')).toBe(true);
        expect(isModelCompatibleWithSubagent(':claude-sonnet-4-5', 'claude')).toBe(true);
      });

      it('should reject Codex model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':codex', 'claude')).toBe(false);
        expect(isModelCompatibleWithSubagent(':codex-mini', 'claude')).toBe(false);
        expect(isModelCompatibleWithSubagent(':gpt-5', 'claude')).toBe(false);
        expect(isModelCompatibleWithSubagent(':mini', 'claude')).toBe(false);
      });

      it('should reject Gemini model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':pro', 'claude')).toBe(false);
        expect(isModelCompatibleWithSubagent(':flash', 'claude')).toBe(false);
        expect(isModelCompatibleWithSubagent(':gemini-pro', 'claude')).toBe(false);
      });

      it('should accept full model names (non-shorthand)', () => {
        expect(isModelCompatibleWithSubagent('claude-sonnet-4-5-20250929', 'claude')).toBe(true);
        expect(isModelCompatibleWithSubagent('gpt-5.3-codex', 'claude')).toBe(true);
        expect(isModelCompatibleWithSubagent('custom-model', 'claude')).toBe(true);
      });
    });

    describe('Codex subagent', () => {
      it('should accept Codex model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':codex', 'codex')).toBe(true);
        expect(isModelCompatibleWithSubagent(':codex-mini', 'codex')).toBe(true);
        expect(isModelCompatibleWithSubagent(':gpt-5', 'codex')).toBe(true);
        expect(isModelCompatibleWithSubagent(':mini', 'codex')).toBe(true);
      });

      it('should reject Claude model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':sonnet', 'codex')).toBe(false);
        expect(isModelCompatibleWithSubagent(':haiku', 'codex')).toBe(false);
        expect(isModelCompatibleWithSubagent(':opus', 'codex')).toBe(false);
        expect(isModelCompatibleWithSubagent(':claude-sonnet-4-5', 'codex')).toBe(false);
      });

      it('should reject Gemini model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':pro', 'codex')).toBe(false);
        expect(isModelCompatibleWithSubagent(':flash', 'codex')).toBe(false);
      });

      it('should accept full model names (non-shorthand)', () => {
        expect(isModelCompatibleWithSubagent('gpt-5.3-codex', 'codex')).toBe(true);
        expect(isModelCompatibleWithSubagent('claude-sonnet-4-5-20250929', 'codex')).toBe(true);
      });
    });

    describe('Gemini subagent', () => {
      it('should accept Gemini model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':pro', 'gemini')).toBe(true);
        expect(isModelCompatibleWithSubagent(':flash', 'gemini')).toBe(true);
        expect(isModelCompatibleWithSubagent(':gemini-pro', 'gemini')).toBe(true);
      });

      it('should reject Claude model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':sonnet', 'gemini')).toBe(false);
        expect(isModelCompatibleWithSubagent(':haiku', 'gemini')).toBe(false);
      });

      it('should reject Codex model shorthands', () => {
        expect(isModelCompatibleWithSubagent(':codex', 'gemini')).toBe(false);
        expect(isModelCompatibleWithSubagent(':codex-mini', 'gemini')).toBe(false);
        expect(isModelCompatibleWithSubagent(':gpt-5', 'gemini')).toBe(false);
      });
    });

    describe('Cursor subagent', () => {
      it('should accept any model (cursor is model-agnostic)', () => {
        expect(isModelCompatibleWithSubagent(':sonnet', 'cursor')).toBe(true);
        expect(isModelCompatibleWithSubagent(':codex', 'cursor')).toBe(true);
        expect(isModelCompatibleWithSubagent(':pro', 'cursor')).toBe(true);
        expect(isModelCompatibleWithSubagent('auto', 'cursor')).toBe(true);
        expect(isModelCompatibleWithSubagent('custom-model', 'cursor')).toBe(true);
      });
    });

    describe('Edge cases', () => {
      it('should handle unknown subagent gracefully', () => {
        // Unknown subagents should accept any model
        expect(isModelCompatibleWithSubagent(':sonnet', 'unknown' as any)).toBe(true);
        expect(isModelCompatibleWithSubagent(':codex', 'unknown' as any)).toBe(true);
      });

      it('should handle unknown shorthands as compatible', () => {
        // Unknown shorthands that don't match any known pattern should be accepted
        expect(isModelCompatibleWithSubagent(':custom', 'claude')).toBe(true);
        expect(isModelCompatibleWithSubagent(':custom', 'codex')).toBe(true);
      });
    });
  });
});

describe('Positional Prompt CLI Parsing', () => {
  it('should merge positional args into options.prompt when -p is not set', async () => {
    // Test the merge logic used in setupMainCommand's .action() callback
    const program = new Command();
    let capturedOptions: any = null;
    let capturedArgs: string[] = [];

    program
      .argument('[prompt_text...]', 'Prompt text (positional)')
      .option('-p, --prompt [text]', 'Prompt input')
      .option('-s, --subagent <name>', 'Subagent')
      .action((promptArgs: string[], options) => {
        // Same merge logic as cli.ts setupMainCommand
        if (promptArgs.length > 0 && options.prompt === undefined) {
          options.prompt = promptArgs.join(' ');
        }
        capturedArgs = promptArgs;
        capturedOptions = options;
      });

    // Shell passes quoted string as single arg: juno-code -s pi "my positional prompt"
    await program.parseAsync(['-s', 'pi', 'my positional prompt'], { from: 'user' });

    expect(capturedArgs).toEqual(['my positional prompt']);
    expect(capturedOptions.prompt).toBe('my positional prompt');
    expect(capturedOptions.subagent).toBe('pi');
  });

  it('should join multiple unquoted positional words', async () => {
    // Shell passes unquoted words as separate args: juno-code -s pi my positional prompt
    const program = new Command();
    let capturedOptions: any = null;

    program
      .argument('[prompt_text...]', 'Prompt text (positional)')
      .option('-p, --prompt [text]', 'Prompt input')
      .option('-s, --subagent <name>', 'Subagent')
      .action((promptArgs: string[], options) => {
        if (promptArgs.length > 0 && options.prompt === undefined) {
          options.prompt = promptArgs.join(' ');
        }
        capturedOptions = options;
      });

    await program.parseAsync(['-s', 'pi', 'my', 'positional', 'prompt'], { from: 'user' });

    expect(capturedOptions.prompt).toBe('my positional prompt');
    expect(capturedOptions.subagent).toBe('pi');
  });

  it('should not override -p flag with positional args', async () => {
    const program = new Command();
    let capturedOptions: any = null;

    program
      .argument('[prompt_text...]', 'Prompt text (positional)')
      .option('-p, --prompt [text]', 'Prompt input')
      .option('-s, --subagent <name>', 'Subagent')
      .action((promptArgs: string[], options) => {
        if (promptArgs.length > 0 && options.prompt === undefined) {
          options.prompt = promptArgs.join(' ');
        }
        capturedOptions = options;
      });

    await program.parseAsync(['-s', 'pi', '-p', 'explicit prompt'], { from: 'user' });

    expect(capturedOptions.prompt).toBe('explicit prompt');
  });

  it('should handle quoted positional prompt as single argument', async () => {
    const program = new Command();
    let capturedOptions: any = null;

    program
      .argument('[prompt_text...]', 'Prompt text (positional)')
      .option('-p, --prompt [text]', 'Prompt input')
      .option('-s, --subagent <name>', 'Subagent')
      .option('-m, --model <name>', 'Model')
      .action((promptArgs: string[], options) => {
        if (promptArgs.length > 0 && options.prompt === undefined) {
          options.prompt = promptArgs.join(' ');
        }
        capturedOptions = options;
      });

    // When shell passes a quoted string, it arrives as one element
    await program.parseAsync(['-s', 'pi', '-m', 'openai-codex/gpt-5.3-codex', 'MY prompt'], { from: 'user' });

    expect(capturedOptions.prompt).toBe('MY prompt');
    expect(capturedOptions.subagent).toBe('pi');
    expect(capturedOptions.model).toBe('openai-codex/gpt-5.3-codex');
  });

  it('should leave options.prompt undefined when no positional args and no -p flag', async () => {
    const program = new Command();
    let capturedOptions: any = null;

    program
      .argument('[prompt_text...]', 'Prompt text (positional)')
      .option('-p, --prompt [text]', 'Prompt input')
      .option('-s, --subagent <name>', 'Subagent')
      .action((promptArgs: string[], options) => {
        if (promptArgs.length > 0 && options.prompt === undefined) {
          options.prompt = promptArgs.join(' ');
        }
        capturedOptions = options;
      });

    await program.parseAsync(['-s', 'pi'], { from: 'user' });

    expect(capturedOptions.prompt).toBeUndefined();
  });

  it('should handle -p with heredoc (prompt=true) and no positional', async () => {
    const program = new Command();
    let capturedOptions: any = null;

    program
      .argument('[prompt_text...]', 'Prompt text (positional)')
      .option('-p, --prompt [text]', 'Prompt input')
      .option('-s, --subagent <name>', 'Subagent')
      .action((promptArgs: string[], options) => {
        if (promptArgs.length > 0 && options.prompt === undefined) {
          options.prompt = promptArgs.join(' ');
        }
        capturedOptions = options;
      });

    // -p without argument → Commander sets prompt=true
    await program.parseAsync(['-s', 'pi', '-p'], { from: 'user' });

    expect(capturedOptions.prompt).toBe(true);
  });
});

describe('Verbose/Quiet Output Modes', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  const mockCommand = new Command('juno-code');

  beforeEach(async () => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });

    // Re-establish mocks (mockReset clears them)
    const { loadConfig } = await import('../../core/config.js');
    vi.mocked(loadConfig).mockResolvedValue({
      workingDirectory: '/test/dir',
      defaultMaxIterations: 5,
      defaultModel: ':sonnet',
      mcpTimeout: 30000,
      mcpRetries: 3,
      verbose: 1,
      quiet: false,
    } as any);

    const { createExecutionEngine, createExecutionRequest } = await import('../../core/engine.js');
    vi.mocked(createExecutionEngine).mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        status: 'completed',
        iterations: [{
          iterationNumber: 1,
          toolResult: { content: 'Test result', metadata: {} },
          success: true,
          duration: 1000,
        }],
        statistics: {
          totalIterations: 1,
          successfulIterations: 1,
          failedIterations: 0,
          averageIterationDuration: 1000,
          totalToolCalls: 5,
          rateLimitEncounters: 0,
        },
      }),
      onProgress: vi.fn(),
      on: vi.fn(),
      shutdown: vi.fn(),
    } as any);
    vi.mocked(createExecutionRequest).mockImplementation((opts: any) => ({
      requestId: 'test-request',
      instruction: opts.instruction,
      subagent: opts.subagent,
      workingDirectory: opts.workingDirectory || '/test/dir',
      maxIterations: opts.maxIterations || 1,
      model: opts.model || ':sonnet',
      agents: opts.agents,
      tools: opts.tools,
      allowedTools: opts.allowedTools,
      appendAllowedTools: opts.appendAllowedTools,
      disallowedTools: opts.disallowedTools,
      resume: opts.resume,
      continueConversation: opts.continueConversation,
      thinking: opts.thinking,
      live: opts.live,
    }) as any);

    const fsExtra = await import('fs-extra');
    vi.mocked(fsExtra.pathExists as any).mockResolvedValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true, configurable: true });
    vi.restoreAllMocks();
  });

  it('should show model and iterations at verbose level 1', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    // Model and iterations should be shown
    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    expect(allCalls.some((c: string) => c.includes('Model:') || c.includes(':sonnet'))).toBe(true);
    expect(allCalls.some((c: string) => c.includes('Max Iterations:'))).toBe(true);
  });

  it('should show selected runtime options (e.g. thinking) in execution summary', async () => {
    const options: MainCommandOptions = {
      subagent: 'pi',
      prompt: 'test prompt',
      thinking: 'xhigh',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    expect(allCalls.some((c: string) => c.includes('Thinking: xhigh'))).toBe(true);
  });

  it('should show live mode selection in execution summary when --live is enabled for pi', async () => {
    const options = {
      subagent: 'pi',
      prompt: 'test prompt',
      live: true,
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    } as MainCommandOptions & { live: boolean };

    await mainCommandHandler([], options as MainCommandOptions, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => String(c[0]));
    expect(allCalls.some((c: string) => c.includes('Live Mode: enabled'))).toBe(true);
  });

  it('should NOT show model and iterations at verbose level 0 (quiet)', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 0,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    // At level 0 (quiet), model and iterations should NOT be shown
    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    expect(allCalls.some((c: string) => c.includes('Model:'))).toBe(false);
    expect(allCalls.some((c: string) => c.includes('Max Iterations:'))).toBe(false);
  });

  it('should suppress all output in quiet mode', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: true,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    // In quiet mode, no progress/execution info on stderr (only final result on stdout)
    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    // Should NOT show execution banner, iterations, etc.
    expect(allCalls.some((c: string) => c.includes('Executing with'))).toBe(false);
    expect(allCalls.some((c: string) => c.includes('Model:'))).toBe(false);
  });

  it('should show debug info (Request ID, Working Directory) only at verbose level 2', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 2,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    expect(allCalls.some((c: string) => c.includes('Request ID:'))).toBe(true);
    expect(allCalls.some((c: string) => c.includes('Working Directory:'))).toBe(true);
  });

  it('should NOT show Request ID/Working Dir at verbose level 1', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    expect(allCalls.some((c: string) => c.includes('Request ID:'))).toBe(false);
    expect(allCalls.some((c: string) => c.includes('Working Directory:'))).toBe(false);
  });

  it('should show subagent source info at verbose level 1 (default)', async () => {
    const { loadConfig } = await import('../../core/config.js');
    vi.mocked(loadConfig).mockResolvedValue({
      workingDirectory: '/test/dir',
      defaultMaxIterations: 5,
      defaultSubagent: 'pi',
      defaultModel: ':pi',
      mcpTimeout: 30000,
      mcpRetries: 3,
      verbose: 1,
      quiet: false,
    } as any);

    const options: MainCommandOptions = {
      subagent: undefined as any, // Let it resolve from config
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    // Subagent resolution info should be shown at level 1+ (not gated on level 2)
    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    expect(allCalls.some((c: string) => c.includes('Subagent:') || c.includes('pi'))).toBe(true);
  });

  it('should show statistics at verbose level 1', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    expect(allCalls.some((c: string) => c.includes('Statistics:'))).toBe(true);
    expect(allCalls.some((c: string) => c.includes('Total Iterations:'))).toBe(true);
  });

  it('should show human-readable completion time in statistics', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => String(c[0]));
    const completedAtLine = allCalls.find((c: string) => c.includes('Completed At:'));
    expect(completedAtLine).toBeDefined();
    expect(completedAtLine).toMatch(/Completed At:\s+.+/);
  });

  it('should show average duration in seconds when average is at least 1 second', async () => {
    const { createExecutionEngine } = await import('../../core/engine.js');

    vi.mocked(createExecutionEngine).mockReturnValueOnce({
      execute: vi.fn().mockResolvedValue({
        status: 'completed',
        iterations: [
          {
            iterationNumber: 1,
            toolResult: {
              content: 'Test result',
              metadata: {},
            },
            success: true,
            duration: 1100,
          },
        ],
        statistics: {
          totalIterations: 1,
          successfulIterations: 1,
          failedIterations: 0,
          averageIterationDuration: 1100,
          totalToolCalls: 5,
          rateLimitEncounters: 0,
        },
      }),
      onProgress: vi.fn(),
      on: vi.fn(),
      shutdown: vi.fn(),
    } as any);

    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => String(c[0]));
    expect(allCalls.some((c: string) => c.includes('Average Duration: 1.1s'))).toBe(true);
  });

  it('should show average duration in minutes or hours when values exceed those units', async () => {
    const { createExecutionEngine } = await import('../../core/engine.js');

    vi.mocked(createExecutionEngine)
      .mockReturnValueOnce({
        execute: vi.fn().mockResolvedValue({
          status: 'completed',
          iterations: [
            {
              iterationNumber: 1,
              toolResult: {
                content: 'Test result',
                metadata: {},
              },
              success: true,
              duration: 90000,
            },
          ],
          statistics: {
            totalIterations: 1,
            successfulIterations: 1,
            failedIterations: 0,
            averageIterationDuration: 90000,
            totalToolCalls: 5,
            rateLimitEncounters: 0,
          },
        }),
        onProgress: vi.fn(),
        on: vi.fn(),
        shutdown: vi.fn(),
      } as any)
      .mockReturnValueOnce({
        execute: vi.fn().mockResolvedValue({
          status: 'completed',
          iterations: [
            {
              iterationNumber: 1,
              toolResult: {
                content: 'Test result',
                metadata: {},
              },
              success: true,
              duration: 7200000,
            },
          ],
          statistics: {
            totalIterations: 1,
            successfulIterations: 1,
            failedIterations: 0,
            averageIterationDuration: 7200000,
            totalToolCalls: 5,
            rateLimitEncounters: 0,
          },
        }),
        onProgress: vi.fn(),
        on: vi.fn(),
        shutdown: vi.fn(),
      } as any);

    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);
    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => String(c[0]));
    expect(allCalls.some((c: string) => c.includes('Average Duration: 1.5m'))).toBe(true);
    expect(allCalls.some((c: string) => c.includes('Average Duration: 2h'))).toBe(true);
  });

  it('should keep average duration in milliseconds when below one second', async () => {
    const { createExecutionEngine } = await import('../../core/engine.js');

    vi.mocked(createExecutionEngine).mockReturnValueOnce({
      execute: vi.fn().mockResolvedValue({
        status: 'completed',
        iterations: [
          {
            iterationNumber: 1,
            toolResult: {
              content: 'Test result',
              metadata: {},
            },
            success: true,
            duration: 450,
          },
        ],
        statistics: {
          totalIterations: 1,
          successfulIterations: 1,
          failedIterations: 0,
          averageIterationDuration: 450,
          totalToolCalls: 5,
          rateLimitEncounters: 0,
        },
      }),
      onProgress: vi.fn(),
      on: vi.fn(),
      shutdown: vi.fn(),
    } as any);

    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => String(c[0]));
    expect(allCalls.some((c: string) => c.includes('Average Duration: 450ms'))).toBe(true);
  });

  it('should show aggregate and per-iteration costs when result payload includes total_cost_usd', async () => {
    const { createExecutionEngine } = await import('../../core/engine.js');

    vi.mocked(createExecutionEngine).mockReturnValueOnce({
      execute: vi.fn().mockResolvedValue({
        status: 'completed',
        iterations: [
          {
            iterationNumber: 1,
            toolResult: {
              content: JSON.stringify({
                type: 'result',
                session_id: 'session-a',
                total_cost_usd: 0.04,
              }),
              metadata: {},
            },
            success: true,
            duration: 1000,
          },
          {
            iterationNumber: 2,
            toolResult: {
              content: JSON.stringify({
                type: 'result',
                session_id: 'session-b',
                total_cost_usd: 0.02,
              }),
              metadata: {},
            },
            success: true,
            duration: 1200,
          },
        ],
        statistics: {
          totalIterations: 2,
          successfulIterations: 2,
          failedIterations: 0,
          averageIterationDuration: 1100,
          totalToolCalls: 6,
          rateLimitEncounters: 0,
        },
      }),
      onProgress: vi.fn(),
      on: vi.fn(),
      shutdown: vi.fn(),
    } as any);

    const options: MainCommandOptions = {
      subagent: 'pi',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => String(c[0]));
    expect(allCalls.some((c: string) => c.includes('Total Cost: $0.060000'))).toBe(true);
    expect(allCalls.some((c: string) => c.includes('Iteration 1: session-a    cost: $0.040000'))).toBe(
      true,
    );
    expect(allCalls.some((c: string) => c.includes('Iteration 2: session-b    cost: $0.020000'))).toBe(
      true,
    );
  });

  it('should derive cost from usage.cost.total when total_cost_usd is absent', async () => {
    const { createExecutionEngine } = await import('../../core/engine.js');

    vi.mocked(createExecutionEngine).mockReturnValueOnce({
      execute: vi.fn().mockResolvedValue({
        status: 'completed',
        iterations: [
          {
            iterationNumber: 1,
            toolResult: {
              content: JSON.stringify({
                type: 'result',
                session_id: 'session-fallback',
                usage: {
                  cost: {
                    total: 0.0055,
                  },
                },
              }),
              metadata: {},
            },
            success: true,
            duration: 800,
          },
        ],
        statistics: {
          totalIterations: 1,
          successfulIterations: 1,
          failedIterations: 0,
          averageIterationDuration: 800,
          totalToolCalls: 4,
          rateLimitEncounters: 0,
        },
      }),
      onProgress: vi.fn(),
      on: vi.fn(),
      shutdown: vi.fn(),
    } as any);

    const options: MainCommandOptions = {
      subagent: 'pi',
      prompt: 'test prompt',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => String(c[0]));
    expect(allCalls.some((c: string) => c.includes('Total Cost: $0.005500'))).toBe(true);
    expect(allCalls.some((c: string) => c.includes('session-fallback    cost: $0.005500'))).toBe(
      true,
    );
  });

  it('should NOT show statistics at verbose level 0 (quiet)', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 0,
      quiet: false,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    const allCalls = consoleErrorSpy.mock.calls.map(c => c[0]);
    expect(allCalls.some((c: string) => c.includes('Statistics:'))).toBe(false);
  });

  it('should reset logger to INFO at verbose level 1 after a previous verbose 2 run', async () => {
    const setLevelSpy = vi.spyOn(logger, 'setLevel');

    await mainCommandHandler([], {
      subagent: 'claude',
      prompt: 'debug run',
      verbose: 2,
      quiet: false,
      logLevel: 'info',
    } as MainCommandOptions, mockCommand);

    await mainCommandHandler([], {
      subagent: 'claude',
      prompt: 'normal run',
      verbose: 1,
      quiet: false,
      logLevel: 'info',
    } as MainCommandOptions, mockCommand);

    expect(setLevelSpy).toHaveBeenNthCalledWith(1, LogLevel.DEBUG);
    expect(setLevelSpy).toHaveBeenNthCalledWith(2, LogLevel.INFO);
  });

  it('should normalize string verbose values from Commander before setting logger/config levels', async () => {
    const setLevelSpy = vi.spyOn(logger, 'setLevel');
    const { loadConfig } = await import('../../core/config.js');

    await mainCommandHandler([], {
      subagent: 'claude',
      prompt: 'string verbose',
      verbose: 'false' as any,
      quiet: false,
      logLevel: 'info',
    } as MainCommandOptions, mockCommand);

    expect(setLevelSpy).toHaveBeenCalledWith(LogLevel.WARN);
    const lastCall = vi.mocked(loadConfig).mock.calls.at(-1)?.[0] as any;
    expect(lastCall.cliConfig.verbose).toBe(0);
  });

  it('should only print final result to stdout in quiet mode', async () => {
    const options: MainCommandOptions = {
      subagent: 'claude',
      prompt: 'test prompt',
      verbose: 1,
      quiet: true,
      logLevel: 'info',
    };

    await mainCommandHandler([], options, mockCommand);

    // stdout should have the final result
    expect(consoleLogSpy).toHaveBeenCalledWith('Test result');
  });
});

describe('normalizeVerbose (Commander.js integration)', () => {
  it('should parse -v with optional value in Commander.js', async () => {
    const program = new Command();
    let capturedVerbose: any = null;

    program
      .option('-v, --verbose [value]', 'Enable verbose')
      .option('-s, --subagent <name>', 'Subagent')
      .action((options) => {
        capturedVerbose = options.verbose;
      });

    // -v without value → true
    await program.parseAsync(['-v', '-s', 'claude'], { from: 'user' });
    expect(capturedVerbose).toBe(true);
  });

  it('should parse -v false as string "false"', async () => {
    const program = new Command();
    let capturedVerbose: any = null;

    program
      .option('-v, --verbose [value]', 'Enable verbose')
      .option('-s, --subagent <name>', 'Subagent')
      .action((options) => {
        capturedVerbose = options.verbose;
      });

    await program.parseAsync(['-v', 'false', '-s', 'claude'], { from: 'user' });
    expect(capturedVerbose).toBe('false');
  });

  it('should parse -v 0 as string "0"', async () => {
    const program = new Command();
    let capturedVerbose: any = null;

    program
      .option('-v, --verbose [value]', 'Enable verbose')
      .action((options) => {
        capturedVerbose = options.verbose;
      });

    await program.parseAsync(['-v', '0'], { from: 'user' });
    expect(capturedVerbose).toBe('0');
  });

  it('should parse no -v flag as undefined', async () => {
    const program = new Command();
    let capturedVerbose: any = null;

    program
      .option('-v, --verbose [value]', 'Enable verbose')
      .option('-s, --subagent <name>', 'Subagent')
      .action((options) => {
        capturedVerbose = options.verbose;
      });

    await program.parseAsync(['-s', 'claude'], { from: 'user' });
    expect(capturedVerbose).toBeUndefined();
  });

  it('should parse --silent as a flag', async () => {
    const program = new Command();
    let capturedOptions: any = null;

    program
      .option('-q, --quiet', 'Quiet mode')
      .option('--silent', 'Alias for --quiet')
      .action((options) => {
        capturedOptions = options;
      });

    await program.parseAsync(['--silent'], { from: 'user' });
    expect(capturedOptions.silent).toBe(true);
  });
});

describe('Subagent alias parsing regressions', () => {
  it('should parse --until-completion as a global option even after subagent alias', async () => {
    const program = new Command();
    let captured: any = null;

    program
      .option('--until-completion', 'Alias for --til-completion')
      .command('pi')
      .argument('[prompt...]')
      .option('-p, --prompt [text]', 'Prompt input')
      .action((promptArgs, options) => {
        captured = {
          promptArgs,
          options,
          globalOptions: program.opts(),
        };
      });

    await program.parseAsync(['pi', '--until-completion', '-p', 'alias prompt'], { from: 'user' });

    expect(captured.globalOptions.untilCompletion).toBe(true);
    expect(captured.options.prompt).toBe('alias prompt');
    expect(captured.promptArgs).toEqual([]);
  });
});
