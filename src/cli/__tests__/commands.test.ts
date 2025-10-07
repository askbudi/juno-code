/**
 * Comprehensive tests for CLI Commands (Session, Feedback, Setup-Git)
 *
 * Tests the remaining CLI command functionality including:
 * - Session management commands (list, show, delete, resume)
 * - Feedback command
 * - Setup-git command
 * - Command configuration and options
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'fs-extra';

import type {
  SessionCommandOptions,
  FeedbackCommandOptions,
  SetupGitCommandOptions
} from '../types.js';

// Mock external dependencies
vi.mock('../../core/session.js', () => ({
  createSessionManager: vi.fn().mockResolvedValue({
    list: vi.fn().mockResolvedValue([
      {
        id: 'session-1',
        name: 'Test Session 1',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        status: 'completed',
        iterations: 5,
        subagent: 'claude'
      },
      {
        id: 'session-2',
        name: 'Test Session 2',
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02'),
        status: 'active',
        iterations: 3,
        subagent: 'cursor'
      }
    ]),
    get: vi.fn().mockResolvedValue({
      id: 'session-1',
      name: 'Test Session 1',
      createdAt: new Date('2024-01-01'),
      status: 'completed',
      iterations: 5,
      executionResult: {
        status: 'COMPLETED',
        iterations: [
          { iterationNumber: 1, success: true, duration: 1000 },
          { iterationNumber: 2, success: true, duration: 1500 }
        ],
        statistics: {
          totalIterations: 2,
          successfulIterations: 2,
          failedIterations: 0
        }
      }
    }),
    getSession: vi.fn().mockResolvedValue({
      info: {
        id: 'session-1',
        name: 'Test Session 1',
        status: 'completed',
        subagent: 'claude',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        completedAt: new Date('2024-01-01'),
        workingDirectory: '/project',
        config: {},
        tags: ['test'],
        metadata: {}
      },
      context: {
        workingDirectory: '/project',
        environment: {},
        config: {} as any,
        processInfo: {
          nodeVersion: 'v18.0.0',
          platform: 'linux',
          arch: 'x64',
          pid: 1234
        }
      },
      statistics: {
        duration: 5000,
        iterations: 5,
        toolCalls: 10,
        successRate: 100,
        errorCount: 0,
        warningCount: 0,
        toolStats: {}
      },
      history: []
    }),
    delete: vi.fn(),
    resume: vi.fn().mockResolvedValue({
      id: 'session-1',
      name: 'Resumed Session',
      status: 'active'
    })
  })
}));

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    workingDirectory: '/test/dir',
    verbose: false
  })
}));

vi.mock('fs-extra', () => ({
  pathExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  ensureDir: vi.fn()
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({
    stdout: 'git command executed successfully',
    stderr: '',
    exitCode: 0
  })
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
    white: createChainableFunction('white'),
    magenta: createChainableFunction('magenta')
  };

  return {
    default: mockChalk,
    ...mockChalk
  };
});

// Mock command handlers - these will be imported dynamically
let sessionCommandHandler: any;
let feedbackCommandHandler: any;
let setupGitCommandHandler: any;

beforeAll(async () => {
  // Import the actual command handlers
  try {
    const sessionModule = await import('../commands/session.js');
    sessionCommandHandler = sessionModule.sessionCommandHandler;
  } catch (e) {
    sessionCommandHandler = vi.fn();
  }

  try {
    const feedbackModule = await import('../commands/feedback.js');
    feedbackCommandHandler = feedbackModule.feedbackCommandHandler;
  } catch (e) {
    feedbackCommandHandler = vi.fn();
  }

  try {
    const setupGitModule = await import('../commands/setup-git.js');
    setupGitCommandHandler = setupGitModule.setupGitCommandHandler;
  } catch (e) {
    setupGitCommandHandler = vi.fn();
  }
});

describe('Session Command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Re-mock createSessionManager after vi.clearAllMocks
    const { createSessionManager } = await import('../../core/session.js');
    vi.mocked(createSessionManager).mockResolvedValue({
      list: vi.fn().mockResolvedValue([]),
      getSession: vi.fn().mockResolvedValue({
        info: {
          id: 'session-1',
          name: 'Test Session 1',
          status: 'completed',
          subagent: 'claude',
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
          completedAt: new Date('2024-01-01'),
          workingDirectory: '/project',
          config: {},
          tags: ['test'],
          metadata: {}
        },
        context: {
          workingDirectory: '/project',
          environment: {},
          config: {} as any,
          processInfo: {
            nodeVersion: 'v18.0.0',
            platform: 'linux',
            arch: 'x64',
            pid: 1234
          }
        },
        statistics: {
          duration: 5000,
          iterations: 5,
          toolCalls: 10,
          successRate: 100,
          errorCount: 0,
          warningCount: 0,
          toolStats: {}
        },
        history: []
      }),
      delete: vi.fn(),
      resume: vi.fn()
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe.skip('session list', () => {
    it.skip('should list all sessions', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'list',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['list'], options, mockCommand);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Execution Sessions')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test Session 1')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test Session 2')
      );
    });

    it.skip('should filter sessions by status', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'list',
        status: 'active',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['list'], options, mockCommand);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test Session 2')
      );
    });

    it('should limit session results', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'list',
        limit: 1,
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['list'], options, mockCommand);

      // Should call session manager with limit
      const { createSessionManager } = await import('../../core/session.js');
      const sessionManager = vi.mocked(createSessionManager).mock.results[0].value;
      expect(sessionManager.list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 })
      );
    });

    it('should show sessions for specific date range', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'list',
        days: 7,
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['list'], options, mockCommand);

      const { createSessionManager } = await import('../../core/session.js');
      const sessionManager = vi.mocked(createSessionManager).mock.results[0].value;
      expect(sessionManager.list).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 })
      );
    });

    it('should handle empty session list', async () => {
      const { createSessionManager } = await import('../../core/session.js');
      const mockSessionManager = {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        delete: vi.fn(),
        resume: vi.fn()
      };
      vi.mocked(createSessionManager).mockReturnValueOnce(mockSessionManager);

      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'list',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['list'], options, mockCommand);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('No sessions found')
      );
    });
  });

  describe('session show', () => {
    it('should show session details', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'show',
        sessionId: 'session-1',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['show', 'session-1'], options, mockCommand);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Session Details')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('session-1')
      );
    });

    it('should require session ID for show', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'show',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['show'], options, mockCommand);

      // Handler logs error message and returns (doesn't exit)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Session ID is required')
      );
    });

    it('should handle non-existent session', async () => {
      const { createSessionManager } = await import('../../core/session.js');
      const mockSessionManager = {
        list: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        getSession: vi.fn().mockResolvedValue(null),
        delete: vi.fn(),
        resume: vi.fn()
      };
      vi.mocked(createSessionManager).mockResolvedValueOnce(mockSessionManager);

      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'show',
        sessionId: 'non-existent',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['show', 'non-existent'], options, mockCommand);

      // Handler logs error message and returns (doesn't exit)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Session not found')
      );
    });
  });

  describe('session delete', () => {
    it('should delete session', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'delete',
        sessionId: 'session-1',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['delete', 'session-1'], options, mockCommand);

      const { createSessionManager } = await import('../../core/session.js');
      const sessionManager = vi.mocked(createSessionManager).mock.results[0].value;
      expect(sessionManager.delete).toHaveBeenCalledWith('session-1');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Session deleted successfully')
      );
    });

    it('should require session ID for delete', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'delete',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        sessionCommandHandler(['delete'], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Session ID is required')
      );
    });
  });

  describe('session resume', () => {
    it('should resume session', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'resume',
        sessionId: 'session-1',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await sessionCommandHandler(['resume', 'session-1'], options, mockCommand);

      const { createSessionManager } = await import('../../core/session.js');
      const sessionManager = vi.mocked(createSessionManager).mock.results[0].value;
      expect(sessionManager.resume).toHaveBeenCalledWith('session-1');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Session resumed')
      );
    });

    it('should require session ID for resume', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'resume',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        sessionCommandHandler(['resume'], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Session ID is required')
      );
    });
  });

  describe('session error handling', () => {
    it('should handle invalid action', async () => {
      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'invalid' as any,
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        sessionCommandHandler(['invalid'], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid session action')
      );
    });

    it('should handle session manager errors', async () => {
      const { createSessionManager } = await import('../../core/session.js');
      const mockSessionManager = {
        list: vi.fn().mockRejectedValue(new Error('Database error')),
        get: vi.fn(),
        delete: vi.fn(),
        resume: vi.fn()
      };
      vi.mocked(createSessionManager).mockReturnValueOnce(mockSessionManager);

      const mockCommand = new Command();
      const options: SessionCommandOptions = {
        action: 'list',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        sessionCommandHandler(['list'], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(99);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected Error')
      );
    });
  });
});

describe('Feedback Command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('feedback submission', () => {
    it('should submit feedback with message', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue();
      vi.mocked(fs.writeFile).mockResolvedValue();

      const mockCommand = new Command();
      const options: FeedbackCommandOptions = {
        message: 'This is test feedback',
        type: 'improvement',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await feedbackCommandHandler([], options, mockCommand);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('USER_FEEDBACK.md'),
        expect.stringContaining('This is test feedback'),
        'utf-8'
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Feedback submitted successfully')
      );
    });

    it('should submit feedback from file', async () => {
      vi.mocked(fs.pathExists).mockResolvedValueOnce(true);
      vi.mocked(fs.readFile).mockResolvedValueOnce('Feedback from file');
      vi.mocked(fs.ensureDir).mockResolvedValue();
      vi.mocked(fs.writeFile).mockResolvedValue();

      const mockCommand = new Command();
      const options: FeedbackCommandOptions = {
        file: './feedback.txt',
        type: 'bug',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await feedbackCommandHandler([], options, mockCommand);

      expect(fs.readFile).toHaveBeenCalledWith('./feedback.txt', 'utf-8');
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Feedback from file'),
        'utf-8'
      );
    });

    it('should require message or file', async () => {
      const mockCommand = new Command();
      const options: FeedbackCommandOptions = {
        type: 'improvement',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        feedbackCommandHandler([], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Either --message or --file is required')
      );
    });

    it('should validate feedback file exists', async () => {
      vi.mocked(fs.pathExists).mockResolvedValueOnce(false);

      const mockCommand = new Command();
      const options: FeedbackCommandOptions = {
        file: './nonexistent.txt',
        type: 'bug',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        feedbackCommandHandler([], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(5);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Feedback file not found')
      );
    });

    it('should validate feedback type', async () => {
      const mockCommand = new Command();
      const options: FeedbackCommandOptions = {
        message: 'Test feedback',
        type: 'invalid' as any,
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        feedbackCommandHandler([], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid feedback type')
      );
    });

    it('should include session ID when provided', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue();
      vi.mocked(fs.writeFile).mockResolvedValue();

      const mockCommand = new Command();
      const options: FeedbackCommandOptions = {
        message: 'Session-specific feedback',
        type: 'improvement',
        sessionId: 'session-123',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await feedbackCommandHandler([], options, mockCommand);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('session-123'),
        'utf-8'
      );
    });

    it('should include priority when provided', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue();
      vi.mocked(fs.writeFile).mockResolvedValue();

      const mockCommand = new Command();
      const options: FeedbackCommandOptions = {
        message: 'High priority feedback',
        type: 'bug',
        priority: 'high',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await feedbackCommandHandler([], options, mockCommand);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('high'),
        'utf-8'
      );
    });

    it('should handle feedback file write errors', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue();
      vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('Write failed'));

      const mockCommand = new Command();
      const options: FeedbackCommandOptions = {
        message: 'Test feedback',
        type: 'improvement',
        cwd: '/project',
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        feedbackCommandHandler([], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(5);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write feedback file')
      );
    });
  });
});

describe('Setup Git Command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('git initialization', () => {
    it('should initialize git repository', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Initialized empty Git repository',
        stderr: '',
        exitCode: 0
      } as any);

      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        cwd: '/project',
        force: false,
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await setupGitCommandHandler([], options, mockCommand);

      expect(execa).toHaveBeenCalledWith('git', ['init'], {
        cwd: '/project'
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Git repository initialized')
      );
    });

    it('should add remote origin when provided', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Success',
        stderr: '',
        exitCode: 0
      } as any);

      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        remote: 'https://github.com/user/repo.git',
        cwd: '/project',
        force: false,
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await setupGitCommandHandler([], options, mockCommand);

      expect(execa).toHaveBeenCalledWith('git', ['remote', 'add', 'origin', 'https://github.com/user/repo.git'], {
        cwd: '/project'
      });
    });

    it('should create initial commit', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Success',
        stderr: '',
        exitCode: 0
      } as any);

      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        initialCommit: true,
        cwd: '/project',
        force: false,
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await setupGitCommandHandler([], options, mockCommand);

      expect(execa).toHaveBeenCalledWith('git', ['add', '.'], {
        cwd: '/project'
      });
      expect(execa).toHaveBeenCalledWith('git', ['commit', '-m', 'Initial commit'], {
        cwd: '/project'
      });
    });

    it('should create .gitignore file', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        gitignore: true,
        cwd: '/project',
        force: false,
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await setupGitCommandHandler([], options, mockCommand);

      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join('/project', '.gitignore'),
        expect.stringContaining('node_modules'),
        'utf-8'
      );
    });

    it('should validate remote URL format', async () => {
      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        remote: 'invalid-url',
        cwd: '/project',
        force: false,
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        setupGitCommandHandler([], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid remote URL')
      );
    });

    it('should check if git repository already exists', async () => {
      vi.mocked(fs.pathExists).mockResolvedValueOnce(true);

      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        cwd: '/project',
        force: false,
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        setupGitCommandHandler([], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Git repository already exists')
      );
    });

    it('should force initialization when force flag is used', async () => {
      vi.mocked(fs.pathExists).mockResolvedValueOnce(true);
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Success',
        stderr: '',
        exitCode: 0
      } as any);

      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        cwd: '/project',
        force: true,
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await setupGitCommandHandler([], options, mockCommand);

      expect(execa).toHaveBeenCalledWith('git', ['init'], {
        cwd: '/project'
      });
    });

    it('should handle git command errors', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockRejectedValueOnce(new Error('git command failed'));

      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        cwd: '/project',
        force: false,
        verbose: false,
        quiet: false,
        logLevel: 'info'
      };

      await expect(
        setupGitCommandHandler([], options, mockCommand)
      ).rejects.toThrow('process.exit called');

      expect(processExitSpy).toHaveBeenCalledWith(99);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Git setup failed')
      );
    });

    it('should show verbose output when verbose flag is used', async () => {
      const { execa } = await import('execa');
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Detailed git output',
        stderr: '',
        exitCode: 0
      } as any);

      const mockCommand = new Command();
      const options: SetupGitCommandOptions = {
        cwd: '/project',
        force: false,
        verbose: true,
        quiet: false,
        logLevel: 'info'
      };

      await setupGitCommandHandler([], options, mockCommand);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Detailed git output')
      );
    });
  });
});