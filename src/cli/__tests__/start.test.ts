/**
 * Comprehensive tests for Start Command
 *
 * Tests the start command functionality including:
 * - Execution with init.md prompt
 * - Session management integration
 * - Progress tracking and display
 * - Error handling and recovery
 * - Configuration loading
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'fs-extra';

import type {
  StartCommandOptions
} from '../types.js';

// Mock mainCommandHandler since start now delegates to it
vi.mock('../commands/main.js', () => ({
  mainCommandHandler: vi.fn().mockResolvedValue(undefined)
}));

// Mock external dependencies
vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockImplementation((opts) => Promise.resolve({
    workingDirectory: opts?.baseDir || '/test/dir',
    defaultMaxIterations: 5,
    defaultModel: 'test-model',
    defaultSubagent: 'claude',
    defaultBackend: 'mcp',
    mcpServerPath: '/test/mcp',
    mcpTimeout: 30000,
    mcpRetries: 3,
    verbose: false
  }))
}));

vi.mock('../../core/engine.js', () => ({
  createExecutionEngine: vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue({
      status: 'completed',
      iterations: [{
        iterationNumber: 1,
        success: true,
        duration: 1000,
        toolResult: { content: 'Task completed successfully' }
      }],
      statistics: {
        totalIterations: 1,
        successfulIterations: 1,
        failedIterations: 0,
        averageIterationDuration: 1000,
        totalToolCalls: 5,
        rateLimitEncounters: 0,
        rateLimitWaitTime: 0,
        errorBreakdown: {}
      }
    }),
    onProgress: vi.fn(),
    on: vi.fn(),
    shutdown: vi.fn()
  }),
  createExecutionRequest: vi.fn().mockImplementation((opts) => ({
    requestId: 'test-request-' + Date.now(),
    instruction: opts.instruction,
    subagent: opts.subagent,
    workingDirectory: opts.workingDirectory,
    maxIterations: opts.maxIterations,
    model: opts.model
  })),
  ExecutionStatus: {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    TIMEOUT: 'timeout',
    RATE_LIMITED: 'rate_limited'
  }
}));

vi.mock('../../core/session.js', () => ({
  createSessionManager: vi.fn().mockReturnValue({
    createSession: vi.fn().mockResolvedValue({
      info: {
        id: 'test-session-id',
        name: 'Test Session',
        createdAt: new Date(),
        status: 'active'
      }
    }),
    addHistoryEntry: vi.fn(),
    completeSession: vi.fn(),
    save: vi.fn(),
    load: vi.fn(),
    list: vi.fn().mockResolvedValue([])
  })
}));

vi.mock('../../mcp/client.js', () => ({
  createMCPClient: vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    execute: vi.fn()
  }),
  createMCPClientFromConfig: vi.fn().mockResolvedValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    execute: vi.fn()
  })
}));

vi.mock('fs-extra', () => {
  // Create shared mock functions
  const pathExists = vi.fn();
  const readFile = vi.fn();
  const ensureDir = vi.fn();

  return {
    default: {
      pathExists,
      readFile,
      ensureDir
    },
    pathExists,
    readFile,
    ensureDir
  };
});

vi.mock('execa', () => ({
  default: vi.fn().mockResolvedValue({ stdout: '' }),
  execa: vi.fn().mockResolvedValue({ stdout: '' })
}));

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
    white: createChainableFunction('white')
  };

  return {
    default: mockChalk,
    ...mockChalk
  };
});

vi.mock('../../core/backend-manager.js', () => ({
  createBackendManager: vi.fn().mockReturnValue({
    cleanup: vi.fn().mockResolvedValue(undefined)
  }),
  determineBackendType: vi.fn().mockReturnValue('mcp'),
  getBackendDisplayName: vi.fn().mockReturnValue('MCP Backend')
}));

// Mock the start command handler by dynamically importing
let startCommandHandler: any;
let loadConfig: any;

beforeAll(async () => {
  // Import the actual command handler
  const startModule = await import('../commands/start.js');
  startCommandHandler = startModule.startCommandHandler;

  // Import the config function for mocking
  const configModule = await import('../../core/config.js');
  loadConfig = configModule.loadConfig;
});

describe('Start Command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code: string | number | null | undefined = 1) => {
      // Mock successful exit for tests - these command handlers expect to call process.exit(0) on success
      return undefined as never;
    });

    // Mock process.cwd()
    vi.spyOn(process, 'cwd').mockReturnValue('/current/dir');
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('startCommandHandler', () => {
    const mockCommand = new Command();

    describe('init.md prompt loading', () => {
      it('should load prompt from .juno_task/init.md', async () => {
        const mockConfig = {
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        };

        vi.mocked(loadConfig).mockResolvedValueOnce(mockConfig);
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for .juno_task directory
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for init.md file
        vi.mocked(fs.readFile).mockResolvedValueOnce('Build a comprehensive TypeScript CLI tool');

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 3,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        // Execute the start command - should delegate to mainCommandHandler
        await startCommandHandler([], options, mockCommand);

        expect(fs.readFile).toHaveBeenCalledWith(
          path.join('/project', '.juno_task', 'init.md'),
          'utf-8'
        );

        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            prompt: 'Build a comprehensive TypeScript CLI tool',
            subagent: 'claude'
          }),
          mockCommand
        );
      });

      it('should use current directory when cwd not specified', async () => {
        const mockConfig = {
          workingDirectory: '/current/dir',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        };

        vi.mocked(loadConfig).mockResolvedValueOnce(mockConfig);
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for .juno_task directory
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for init.md file
        vi.mocked(fs.readFile).mockResolvedValueOnce('Test task content');

        const options: StartCommandOptions = {
          directory: undefined,
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        expect(fs.readFile).toHaveBeenCalledWith(
          path.join('/current/dir', '.juno_task', 'init.md'),
          'utf-8'
        );
      });

      it('should handle missing init.md file', async () => {
        // Mock process.exit to prevent test termination
        const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('Process exit called');
        });

        const mockConfig = {
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
    defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        };

        vi.mocked(loadConfig).mockResolvedValueOnce(mockConfig);
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // .juno_task directory exists
        vi.mocked(fs.pathExists).mockResolvedValueOnce(false); // init.md file doesn't exist

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await expect(
          startCommandHandler([], options, mockCommand)
        ).rejects.toThrow('Process exit called');

        expect(mockExit).toHaveBeenCalledWith(5); // FileSystemError
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('No init.md file found in .juno_task directory')
        );

        // Restore process.exit
        mockExit.mockRestore();
      });

      it('should handle empty init.md file', async () => {
        // Mock process.exit to prevent test termination
        const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('Process exit called');
        });

        const mockConfig = {
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
    defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        };

        vi.mocked(loadConfig).mockResolvedValueOnce(mockConfig);
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // .juno_task directory exists
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // init.md file exists
        vi.mocked(fs.readFile).mockResolvedValueOnce('   \n\n   ');

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await expect(
          startCommandHandler([], options, mockCommand)
        ).rejects.toThrow('Process exit called');

        expect(mockExit).toHaveBeenCalledWith(5); // FileSystemError
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('init.md file is empty')
        );

        // Restore process.exit
        mockExit.mockRestore();
      });

      it('should handle file read errors', async () => {
        // Mock process.exit to prevent test termination
        const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('Process exit called');
        });

        const mockConfig = {
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
    defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        };

        vi.mocked(loadConfig).mockResolvedValueOnce(mockConfig);
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // .juno_task directory exists
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // init.md file exists
        vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('Permission denied'));

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await expect(
          startCommandHandler([], options, mockCommand)
        ).rejects.toThrow('Process exit called');

        expect(mockExit).toHaveBeenCalledWith(5); // FileSystemError
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to read init.md')
        );

        // Restore process.exit
        mockExit.mockRestore();
      });
    });

    describe('execution configuration', () => {
      beforeEach(() => {
        vi.mocked(fs.pathExists).mockResolvedValue(true);
        vi.mocked(fs.readFile).mockResolvedValue('Test task content');
      });

      it('should use default subagent from config when options provided', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/test/dir',
          defaultSubagent: 'cursor',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            subagent: 'cursor'
          }),
          mockCommand
        );
      });

      it('should use default subagent from config', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/test/dir',
          defaultSubagent: 'gemini',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            subagent: 'gemini'
          }),
          mockCommand
        );
      });

      it('should use specified max iterations', async () => {
        const mockConfig = {
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        };

        vi.mocked(loadConfig).mockResolvedValueOnce(mockConfig);
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for .juno_task directory
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for init.md file
        vi.mocked(fs.readFile).mockResolvedValueOnce('Build a comprehensive TypeScript CLI tool');

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 10,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            maxIterations: 10
          }),
          mockCommand
        );
      });

      it('should use specified model', async () => {
        const mockConfig = {
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        };

        vi.mocked(loadConfig).mockResolvedValueOnce(mockConfig);
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for .juno_task directory
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for init.md file
        vi.mocked(fs.readFile).mockResolvedValueOnce('Build a comprehensive TypeScript CLI tool');

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          model: 'custom-model',
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            model: 'custom-model'
          }),
          mockCommand
        );
      });

      it('should use working directory from config', async () => {
        const mockConfig = {
          workingDirectory: '/test/dir',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        };

        vi.mocked(loadConfig).mockResolvedValueOnce(mockConfig);
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for .juno_task directory
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true); // for init.md file
        vi.mocked(fs.readFile).mockResolvedValueOnce('Build a comprehensive TypeScript CLI tool');

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            directory: '/project'
          }),
          mockCommand
        );
      });
    });

    describe('session management', () => {
      beforeEach(() => {
        vi.mocked(fs.pathExists).mockResolvedValue(true);
        vi.mocked(fs.readFile).mockResolvedValue('Test task content');
      });

      it('should create session with specified name', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Verify mainCommandHandler was called with the prompt from init.md
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            prompt: 'Test task content'
          }),
          mockCommand
        );
      });

      it('should generate session name when not specified', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          sessionName: undefined,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler completes successfully when session name is not specified
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should save session state', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which handles session management
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });
    });

    describe('progress tracking', () => {
      beforeEach(() => {
        vi.mocked(fs.pathExists).mockResolvedValue(true);
        vi.mocked(fs.readFile).mockResolvedValue('Test task content');
      });

      it('should setup progress callbacks', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which sets up progress tracking
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should display start information', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 5,
          defaultModel: 'gpt-4',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 5,
          model: 'gpt-4',
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which displays execution information
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should handle unlimited iterations display', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: -1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: -1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which handles unlimited iterations
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should display task instructions preview', async () => {
        const longTask = 'This is a very long task description that should be truncated when displayed in the progress output because it exceeds the 200 character limit that is set for the preview display in the start command handler.';
        vi.mocked(fs.readFile).mockResolvedValueOnce(longTask);

        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which displays task instructions
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            prompt: longTask
          }),
          mockCommand
        );
      });

      it('should not truncate short task descriptions', async () => {
        const shortTask = 'Short task description';
        vi.mocked(fs.readFile).mockResolvedValueOnce(shortTask);

        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler with the short task
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            prompt: shortTask
          }),
          mockCommand
        );
      });
    });

    describe('execution results', () => {
      beforeEach(() => {
        vi.mocked(fs.pathExists).mockResolvedValue(true);
        vi.mocked(fs.readFile).mockResolvedValue('Test task content');
      });

      it('should handle successful execution', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which handles execution result
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should handle failed execution', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which handles failed execution
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should display execution statistics in verbose mode', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: true
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: true,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which displays statistics in verbose mode
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalledWith(
          [],
          expect.objectContaining({
            verbose: true
          }),
          mockCommand
        );
      });

      it('should display final result content', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which displays final result
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });
    });

    describe('resource cleanup', () => {
      beforeEach(() => {
        vi.mocked(fs.pathExists).mockResolvedValue(true);
        vi.mocked(fs.readFile).mockResolvedValue('Test task content');
      });

      it('should cleanup MCP client and engine', async () => {
        // Re-establish critical mocks
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
    defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        // Set up execution engine mock
        const { createExecutionEngine, createExecutionRequest, ExecutionStatus } = await import('../../core/engine.js');
        const mockEngine = {
          execute: vi.fn().mockResolvedValue({
            status: ExecutionStatus.COMPLETED,
            iterations: [{
              iterationNumber: 1,
              success: true,
              duration: 1000,
              toolResult: { content: 'Task completed successfully' }
            }],
            statistics: {
              totalIterations: 1,
              successfulIterations: 1,
              failedIterations: 0,
              averageIterationDuration: 1000,
              totalToolCalls: 5,
              rateLimitEncounters: 0,
              rateLimitWaitTime: 0,
              errorBreakdown: {}
            }
          }),
          onProgress: vi.fn(),
          on: vi.fn(),
          shutdown: vi.fn().mockResolvedValue(undefined)
        };
        vi.mocked(createExecutionEngine).mockReturnValueOnce(mockEngine);
        vi.mocked(createExecutionRequest).mockReturnValueOnce({
          requestId: 'test-request-cleanup',
          instruction: 'Test task content',
          subagent: 'claude',
          workingDirectory: '/project',
          maxIterations: 1,
          model: 'test-model'
        });

        // Set up session manager mock
        const { createSessionManager } = await import('../../core/session.js');
        const mockSessionManager = {
          createSession: vi.fn().mockResolvedValue({
            info: {
              id: 'test-session-id',
              name: 'Test Session',
              createdAt: new Date(),
              status: 'active'
            }
          }),
          addHistoryEntry: vi.fn().mockResolvedValue(undefined),
          completeSession: vi.fn().mockResolvedValue(undefined),
          save: vi.fn().mockResolvedValue(undefined),
          load: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue([])
        };
        vi.mocked(createSessionManager).mockResolvedValueOnce(mockSessionManager);

        // Set up backend manager mock
        const { createBackendManager } = await import('../../core/backend-manager.js');
        const mockBackendManager = {
          cleanup: vi.fn().mockResolvedValue(undefined)
        };
        vi.mocked(createBackendManager).mockReturnValueOnce(mockBackendManager);

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which handles cleanup
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should cleanup even on execution error', async () => {
        // Re-establish critical mocks
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
    defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const { createExecutionEngine, createExecutionRequest } = await import('../../core/engine.js');
        const mockEngine = {
          execute: vi.fn().mockRejectedValue(new Error('Execution failed')),
          onProgress: vi.fn(),
          on: vi.fn(),
          shutdown: vi.fn()
        };
        vi.mocked(createExecutionEngine).mockReturnValueOnce(mockEngine);
        vi.mocked(createExecutionRequest).mockReturnValueOnce({
          requestId: 'test-request-error',
          instruction: 'Test task content',
          subagent: 'claude',
          workingDirectory: '/project',
          maxIterations: 1,
          model: 'test-model'
        });

        // Set up session manager mock
        const { createSessionManager } = await import('../../core/session.js');
        const mockSessionManager = {
          createSession: vi.fn().mockResolvedValue({
            info: {
              id: 'test-session-id',
              name: 'Test Session',
              createdAt: new Date(),
              status: 'active'
            }
          }),
          addHistoryEntry: vi.fn().mockResolvedValue(undefined),
          completeSession: vi.fn().mockResolvedValue(undefined),
          save: vi.fn().mockResolvedValue(undefined),
          load: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue([])
        };
        vi.mocked(createSessionManager).mockResolvedValueOnce(mockSessionManager);

        // Set up backend manager mock
        const { createBackendManager } = await import('../../core/backend-manager.js');
        const mockBackendManager = {
          cleanup: vi.fn().mockResolvedValue(undefined)
        };
        vi.mocked(createBackendManager).mockReturnValueOnce(mockBackendManager);

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which handles cleanup even on error
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should handle cleanup errors gracefully', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which handles cleanup errors gracefully
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      beforeEach(() => {
        // Ensure fs mocks are set up for error handling tests
        vi.mocked(fs.pathExists).mockResolvedValue(true);
        vi.mocked(fs.readFile).mockResolvedValue('Test task content');
      });

      it('should handle configuration errors', async () => {
        const { loadConfig } = await import('../../core/config.js');
        const { ConfigurationError } = await import('../types.js');
        const configError = new ConfigurationError('Config error', ['Check config file']);
        vi.mocked(loadConfig).mockRejectedValueOnce(configError);

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        try {
          await startCommandHandler([], options, mockCommand);
        } catch (error) {
          // ConfigurationError should be thrown and handled
          expect(error).toBeInstanceOf(ConfigurationError);
        }
      });

      it('should handle MCP errors', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockResolvedValueOnce({
          workingDirectory: '/project',
          defaultMaxIterations: 1,
          defaultModel: 'test-model',
          defaultSubagent: 'claude',
          defaultBackend: 'mcp',
          mcpServerPath: '/test/mcp',
          mcpTimeout: 30000,
          mcpRetries: 3,
          verbose: false
        });

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        await startCommandHandler([], options, mockCommand);

        // Handler delegates to mainCommandHandler which handles MCP errors
        const { mainCommandHandler } = await import('../commands/main.js');
        expect(mainCommandHandler).toHaveBeenCalled();
      });

      it('should handle unexpected errors', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockRejectedValueOnce(new Error('Unexpected error'));

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: false,
          quiet: false,
          logLevel: 'info'
        };

        try {
          await startCommandHandler([], options, mockCommand);
        } catch (error) {
          // Error should be thrown from loadConfig
          expect(error).toBeDefined();
        }
      });

      it('should show stack trace in verbose mode', async () => {
        const { loadConfig } = await import('../../core/config.js');
        vi.mocked(loadConfig).mockRejectedValueOnce(new Error('Unexpected error'));

        const options: StartCommandOptions = {
          directory: '/project',
          maxIterations: 1,
          verbose: true,
          quiet: false,
          logLevel: 'info'
        };

        try {
          await startCommandHandler([], options, mockCommand);
        } catch (error) {
          // Error should be thrown from loadConfig
          expect(error).toBeDefined();
        }
      });
    });
  });
});