/**
 * Comprehensive tests for Init Command
 *
 * Tests the init command functionality including:
 * - Interactive and headless initialization
 * - Template generation
 * - Project structure creation
 * - Validation and error handling
 * - Configuration setup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'fs-extra';

import {
  initCommandHandler,
  configureInitCommand
} from '../commands/init.js';

import type {
  InitCommandOptions
} from '../types.js';

// Mock external dependencies
vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    workingDirectory: '/test/dir',
    verbose: false
  })
}));

vi.mock('../../templates/engine.js', () => ({
  defaultTemplateEngine: {
    getBuiltInTemplates: vi.fn().mockReturnValue([
      { name: 'init.md', path: '/templates/init.md' },
      { name: 'plan.md', path: '/templates/plan.md' },
      { name: 'config.json', path: '/templates/config.json' }
    ]),
    createContext: vi.fn().mockResolvedValue({}),
    generateFiles: vi.fn().mockResolvedValue({
      files: [
        { path: '.juno_task/init.md', status: 'created' },
        { path: '.juno_task/plan.md', status: 'created' },
        { path: '.juno_task/config.json', status: 'created' }
      ],
      summary: { created: 3, skipped: 0, errors: 0 }
    })
  },
  TemplateUtils: {
    createDefaultVariables: vi.fn().mockReturnValue({
      PROJECT_NAME: 'test-project',
      CURRENT_DATE: '2023-01-01',
      TIMESTAMP: '2023-01-01T00:00:00.000Z'
    })
  }
}));

vi.mock('fs-extra', () => ({
  ensureDir: vi.fn(),
  pathExists: vi.fn(),
  readdir: vi.fn().mockResolvedValue([])
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

describe('Init Command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Mock process.cwd()
    vi.spyOn(process, 'cwd').mockReturnValue('/current/dir');
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('configureInitCommand', () => {
    it('should configure init command with correct structure', () => {
      const program = new Command();
      configureInitCommand(program);

      const initCommand = program.commands.find(cmd => cmd.name() === 'init');

      expect(initCommand).toBeDefined();
      expect(initCommand?.description()).toContain('Initialize new juno-task project');
      expect(initCommand?.args).toHaveLength(1); // directory argument
      expect(initCommand?.options).toHaveLength(7); // All options
    });

    it('should have correct options configured', () => {
      const program = new Command();
      configureInitCommand(program);

      const initCommand = program.commands.find(cmd => cmd.name() === 'init');
      const options = initCommand?.options || [];

      expect(options.some(opt => opt.flags.includes('--force'))).toBe(true);
      expect(options.some(opt => opt.flags.includes('--task'))).toBe(true);
      expect(options.some(opt => opt.flags.includes('--subagent'))).toBe(true);
      expect(options.some(opt => opt.flags.includes('--git-url'))).toBe(true);
      expect(options.some(opt => opt.flags.includes('--interactive'))).toBe(true);
      expect(options.some(opt => opt.flags.includes('--template'))).toBe(true);
      expect(options.some(opt => opt.flags.includes('--var'))).toBe(true);
    });

    it('should have help text with examples', () => {
      const program = new Command();
      configureInitCommand(program);

      const initCommand = program.commands.find(cmd => cmd.name() === 'init');

      // Test that help text is added (this is visual, so we test that no error occurs)
      expect(() => configureInitCommand(program)).not.toThrow();
    });
  });

  describe('initCommandHandler', () => {
    const mockCommand = new Command();

    describe('headless initialization', () => {
      it('should initialize project in current directory', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(fs.ensureDir).toHaveBeenCalledWith('/current/dir');
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Project initialization complete')
        );
      });

      it('should initialize project in specified directory', async () => {
        const options: InitCommandOptions = {
          directory: './my-project',
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(fs.ensureDir).toHaveBeenCalledWith(
          path.resolve('./my-project')
        );
      });

      it('should use default task when not provided', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: undefined,
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Project initialization complete')
        );
      });

      it('should use default subagent when not provided', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: undefined,
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Project initialization complete')
        );
      });

      it('should validate subagent choices', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'invalid' as any,
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await expect(
          initCommandHandler([], options, mockCommand)
        ).rejects.toThrow('process.exit called');

        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Invalid subagent: invalid')
        );
      });

      it('should validate task length', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'short',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await expect(
          initCommandHandler([], options, mockCommand)
        ).rejects.toThrow('process.exit called');

        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Task description must be at least 10 characters')
        );
      });

      it('should validate git URL format', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          gitUrl: 'invalid-url',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await expect(
          initCommandHandler([], options, mockCommand)
        ).rejects.toThrow('process.exit called');

        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Invalid Git URL')
        );
      });

      it('should accept valid git URL', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          gitUrl: 'https://github.com/owner/repo',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Project initialization complete')
        );
      });

      it('should accept empty git URL', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          gitUrl: '',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Project initialization complete')
        );
      });

      it('should merge custom variables', async () => {
        const customVariables = {
          CUSTOM_VAR: 'custom_value',
          ANOTHER_VAR: 'another_value'
        };

        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: customVariables
        };

        await initCommandHandler([], options, mockCommand);

        const { defaultTemplateEngine } = await import('../../templates/engine.js');
        expect(defaultTemplateEngine.createContext).toHaveBeenCalled();
      });
    });

    describe('interactive initialization', () => {
      it('should run interactive mode', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: undefined,
          subagent: undefined,
          force: false,
          interactive: true,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Juno Task Project Initialization')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Project initialization complete')
        );
      });

      it('should display interactive prompts', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: undefined,
          subagent: undefined,
          force: false,
          interactive: true,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Project Directory:')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Main Task:')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Preferred Subagent:')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Git Repository (Optional):')
        );
      });
    });

    describe('project generation', () => {
      it('should generate template files', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        const { defaultTemplateEngine } = await import('../../templates/engine.js');
        expect(defaultTemplateEngine.getBuiltInTemplates).toHaveBeenCalled();
        expect(defaultTemplateEngine.createContext).toHaveBeenCalled();
        expect(defaultTemplateEngine.generateFiles).toHaveBeenCalled();
      });

      it('should create additional directories', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(fs.ensureDir).toHaveBeenCalledWith('/current/dir/.juno_task/specs');
        expect(fs.ensureDir).toHaveBeenCalledWith('/current/dir/.juno_task/sessions');
        expect(fs.ensureDir).toHaveBeenCalledWith('/current/dir/.juno_task/logs');
        expect(fs.ensureDir).toHaveBeenCalledWith('/current/dir/.juno_task/cache');
      });

      it('should report generation results', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Generated files:')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('.juno_task/init.md')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('.juno_task/plan.md')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('.juno_task/config.json')
        );
      });

      it('should display next steps', async () => {
        const options: InitCommandOptions = {
          directory: './my-project',
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Next Steps:')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('cd my-project')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('juno-task start')
        );
      });

      it('should not show cd command for current directory', async () => {
        const options: InitCommandOptions = {
          directory: undefined, // Current directory
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Next Steps:')
        );
        // Should not show cd command
        expect(consoleSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('cd ')
        );
      });

      it('should display useful commands', async () => {
        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Useful Commands:')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('juno-task start')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('juno-task session list')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('juno-task feedback')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('juno-task --help')
        );
      });
    });

    describe('force mode', () => {
      it('should overwrite existing files with force flag', async () => {
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true);
        vi.mocked(fs.readdir).mockResolvedValueOnce(['existing-file.md']);

        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: true,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        const { defaultTemplateEngine } = await import('../../templates/engine.js');
        expect(defaultTemplateEngine.generateFiles).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            force: true,
            onConflict: 'overwrite'
          })
        );
      });

      it('should fail without force when files exist', async () => {
        vi.mocked(fs.pathExists).mockResolvedValueOnce(true);
        vi.mocked(fs.readdir).mockResolvedValueOnce(['existing-file.md']);

        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await expect(
          initCommandHandler([], options, mockCommand)
        ).rejects.toThrow('process.exit called');

        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Project appears to already be initialized')
        );
      });
    });

    describe('error handling', () => {
      it('should handle template errors', async () => {
        const { defaultTemplateEngine } = await import('../../templates/engine.js');
        const templateError = new Error('Template error');
        templateError.constructor.name = 'TemplateError';
        templateError.suggestions = ['Check template syntax'];
        vi.mocked(defaultTemplateEngine.generateFiles).mockRejectedValueOnce(templateError);

        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await expect(
          initCommandHandler([], options, mockCommand)
        ).rejects.toThrow('process.exit called');

        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Initialization Failed')
        );
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Template error')
        );
      });

      it('should handle directory creation errors', async () => {
        vi.mocked(fs.ensureDir).mockRejectedValueOnce(new Error('Permission denied'));

        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await expect(
          initCommandHandler([], options, mockCommand)
        ).rejects.toThrow('process.exit called');

        expect(processExitSpy).toHaveBeenCalledWith(1);
      });

      it('should handle unexpected errors', async () => {
        const { defaultTemplateEngine } = await import('../../templates/engine.js');
        vi.mocked(defaultTemplateEngine.getBuiltInTemplates).mockImplementation(() => {
          throw new Error('Unexpected error');
        });

        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await expect(
          initCommandHandler([], options, mockCommand)
        ).rejects.toThrow('process.exit called');

        expect(processExitSpy).toHaveBeenCalledWith(99);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Unexpected Error')
        );
      });

      it('should show stack trace in verbose mode', async () => {
        const { defaultTemplateEngine } = await import('../../templates/engine.js');
        vi.mocked(defaultTemplateEngine.getBuiltInTemplates).mockImplementation(() => {
          throw new Error('Unexpected error');
        });

        const options: InitCommandOptions = {
          directory: undefined,
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {},
          verbose: true
        };

        await expect(
          initCommandHandler([], options, mockCommand)
        ).rejects.toThrow('process.exit called');

        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Stack Trace')
        );
      });
    });

    describe('template variable creation', () => {
      it('should create proper template variables', async () => {
        const options: InitCommandOptions = {
          directory: './test-project',
          task: 'Build a comprehensive TypeScript CLI tool',
          subagent: 'claude',
          gitUrl: 'https://github.com/owner/test-repo',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        const { defaultTemplateEngine } = await import('../../templates/engine.js');
        expect(defaultTemplateEngine.createContext).toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('test-project'),
          expect.objectContaining({
            includeGitInfo: true,
            includeEnvironment: true
          })
        );
      });

      it('should handle project name with special characters', async () => {
        const options: InitCommandOptions = {
          directory: './my-special-project@2024',
          task: 'Build a test project',
          subagent: 'claude',
          force: false,
          interactive: false,
          template: 'default',
          variables: {}
        };

        await initCommandHandler([], options, mockCommand);

        // Should not throw error due to special characters
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Project initialization complete')
        );
      });
    });
  });
});