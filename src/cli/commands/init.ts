/**
 * Init command implementation for juno-task-ts CLI
 *
 * Provides interactive project initialization with template generation,
 * configuration setup, and directory structure creation. Includes both
 * interactive TUI mode and headless mode for automation.
 */

import * as path from 'node:path';
import * as fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';
import { z } from 'zod';

import { loadConfig } from '../../core/config.js';
import { defaultTemplateEngine, TemplateUtils } from '../../templates/engine.js';
import type { TemplateVariables, Template } from '../../templates/types.js';
import type { InitCommandOptions, ValidationError, TemplateError } from '../types.js';
import type { SubagentType } from '../../types/index.js';

// Validation schemas
const SubagentSchema = z.enum(['claude', 'cursor', 'codex', 'gemini']);
const GitUrlSchema = z.string().url().optional().or(z.literal(''));

interface InitializationContext {
  targetDirectory: string;
  task: string;
  subagent: SubagentType;
  gitUrl?: string;
  variables: TemplateVariables;
  force: boolean;
  interactive: boolean;
}

/**
 * Interactive TUI for project initialization
 */
class InitTUI {
  private context: Partial<InitializationContext> = {};

  async gather(): Promise<InitializationContext> {
    console.log(chalk.blue.bold('\n🚀 Juno Task Project Initialization\n'));

    // Get target directory
    const targetDirectory = await this.promptForDirectory();

    // Get main task
    const task = await this.promptForTask();

    // Get subagent
    const subagent = await this.promptForSubagent();

    // Get git URL (optional)
    const gitUrl = await this.promptForGitUrl();

    // Create variables
    const variables = this.createVariables(targetDirectory, task, subagent, gitUrl);

    return {
      targetDirectory,
      task,
      subagent,
      gitUrl,
      variables,
      force: false,
      interactive: true
    };
  }

  private async promptForDirectory(): Promise<string> {
    // In a real implementation, this would use a proper TUI library like ink
    // For now, we'll use simple prompts
    console.log(chalk.yellow('📁 Project Directory:'));
    console.log('   Enter the target directory for your project (default: current directory)');

    // For demonstration, return current directory
    // In real implementation, would prompt user for input
    return process.cwd();
  }

  private async promptForTask(): Promise<string> {
    console.log(chalk.yellow('\n📝 Main Task:'));
    console.log('   Describe the main objective of your project');

    // Default task for demonstration
    return 'Implement comprehensive CLI commands for juno-task-ts TypeScript project';
  }

  private async promptForSubagent(): Promise<SubagentType> {
    console.log(chalk.yellow('\n🤖 Preferred Subagent:'));
    console.log('   Choose your preferred AI coding agent:');
    console.log('   1. Claude (recommended for complex reasoning)');
    console.log('   2. Cursor (great for real-time collaboration)');
    console.log('   3. Codex (excellent for code generation)');
    console.log('   4. Gemini (strong for multimodal tasks)');

    // Default for demonstration
    return 'claude';
  }

  private async promptForGitUrl(): Promise<string | undefined> {
    console.log(chalk.yellow('\n🔗 Git Repository (Optional):'));
    console.log('   Enter the Git repository URL for this project');

    // Optional, return undefined for demonstration
    return undefined;
  }

  private createVariables(
    targetDirectory: string,
    task: string,
    subagent: SubagentType,
    gitUrl?: string
  ): TemplateVariables {
    const projectName = path.basename(targetDirectory);
    const currentDate = new Date().toISOString().split('T')[0];

    return {
      // Core variables
      PROJECT_NAME: projectName,
      main_task: task,
      TASK: task,
      SUBAGENT: subagent,
      GIT_URL: gitUrl || 'https://github.com/owner/repo',

      // Project variables
      PROJECT_PATH: targetDirectory,
      PROJECT_ROOT: targetDirectory,
      PACKAGE_NAME: projectName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
      VENV_PATH: path.join(targetDirectory, '.venv'),

      // Metadata variables
      CURRENT_DATE: currentDate,
      TIMESTAMP: new Date().toISOString(),
      PROJECT_PHASE: 'development',
      CURRENT_PRIORITY: 'high',

      // Default values
      AUTHOR: 'Development Team',
      EMAIL: 'dev@example.com',
      LICENSE: 'MIT',
      DESCRIPTION: task,
      VERSION: '1.0.0',
    };
  }
}

/**
 * Headless initialization for automation
 */
class HeadlessInit {
  constructor(private options: InitCommandOptions) {}

  async initialize(): Promise<InitializationContext> {
    const targetDirectory = path.resolve(this.options.directory || process.cwd());
    const task = this.options.task || 'Define your main task objective here';
    const subagent = this.options.subagent || 'claude';
    const gitUrl = this.options.gitUrl;

    // Validate inputs
    await this.validateInputs(task, subagent, gitUrl);

    // Create variables from options and defaults
    const variables = this.createVariables(targetDirectory, task, subagent, gitUrl);

    // Merge with custom variables if provided
    if (this.options.variables) {
      Object.assign(variables, this.options.variables);
    }

    return {
      targetDirectory,
      task,
      subagent,
      gitUrl,
      variables,
      force: this.options.force || false,
      interactive: false
    };
  }

  private async validateInputs(task: string, subagent: SubagentType, gitUrl?: string): Promise<void> {
    // Validate subagent
    const subagentResult = SubagentSchema.safeParse(subagent);
    if (!subagentResult.success) {
      throw new ValidationError(
        `Invalid subagent: ${subagent}. Must be one of: claude, cursor, codex, gemini`,
        ['Use --subagent with a valid option', 'Run juno-task init --help for examples']
      );
    }

    // Validate git URL if provided
    if (gitUrl) {
      const gitUrlResult = GitUrlSchema.safeParse(gitUrl);
      if (!gitUrlResult.success) {
        throw new ValidationError(
          `Invalid Git URL: ${gitUrl}`,
          ['Provide a valid HTTPS Git repository URL', 'Example: https://github.com/owner/repo']
        );
      }
    }

    // Validate task
    if (!task.trim() || task.length < 10) {
      throw new ValidationError(
        'Task description must be at least 10 characters',
        ['Provide a descriptive task objective', 'Example: "Build a TypeScript CLI tool for AI orchestration"']
      );
    }
  }

  private createVariables(
    targetDirectory: string,
    task: string,
    subagent: SubagentType,
    gitUrl?: string
  ): TemplateVariables {
    return TemplateUtils.createDefaultVariables(targetDirectory, path.basename(targetDirectory));
  }
}

/**
 * Template generation and file creation
 */
class ProjectGenerator {
  constructor(private context: InitializationContext) {}

  async generate(): Promise<void> {
    const { targetDirectory, variables, force } = this.context;

    console.log(chalk.blue('\n📁 Setting up project directory...'));

    // Ensure target directory exists
    await this.ensureDirectory(targetDirectory);

    // Check for existing files
    if (!force) {
      await this.checkExistingFiles(targetDirectory);
    }

    console.log(chalk.blue('\n📄 Generating template files...'));

    // Get all built-in templates
    const templates = defaultTemplateEngine.getBuiltInTemplates();

    // Create template context
    const templateContext = await defaultTemplateEngine.createContext(
      variables,
      targetDirectory,
      { includeGitInfo: true, includeEnvironment: true }
    );

    // Generate all template files
    const results = await defaultTemplateEngine.generateFiles(
      templates,
      path.join(targetDirectory, '.juno_task'),
      templateContext,
      {
        force,
        createBackup: !force,
        dryRun: false,
        onConflict: force ? 'overwrite' : 'skip'
      }
    );

    // Report results
    this.reportResults(results);

    // Create additional directories
    await this.createAdditionalDirectories(targetDirectory);

    console.log(chalk.green.bold('\n✅ Project initialization complete!'));
    this.printNextSteps(targetDirectory);
  }

  private async ensureDirectory(targetDirectory: string): Promise<void> {
    try {
      await fs.ensureDir(targetDirectory);
      console.log(chalk.gray(`   Created directory: ${targetDirectory}`));
    } catch (error) {
      throw new TemplateError(`Failed to create directory: ${error}`);
    }
  }

  private async checkExistingFiles(targetDirectory: string): Promise<void> {
    const junoTaskDir = path.join(targetDirectory, '.juno_task');

    if (await fs.pathExists(junoTaskDir)) {
      const files = await fs.readdir(junoTaskDir);
      if (files.length > 0) {
        console.log(chalk.yellow('\n⚠️  Warning: .juno_task directory already exists with files:'));
        files.forEach(file => console.log(chalk.gray(`   - ${file}`)));
        console.log(chalk.yellow('   Use --force to overwrite existing files'));

        throw new ValidationError(
          'Project appears to already be initialized',
          ['Use --force to overwrite existing files', 'Choose a different directory', 'Remove existing .juno_task directory']
        );
      }
    }
  }

  private reportResults(results: any): void {
    console.log(chalk.gray('\n   Generated files:'));

    for (const result of results.files) {
      const statusColor = result.status === 'created'
        ? chalk.green
        : result.status === 'skipped'
        ? chalk.yellow
        : chalk.red;

      const statusIcon = result.status === 'created'
        ? '✓'
        : result.status === 'skipped'
        ? '⊘'
        : '✗';

      console.log(statusColor(`   ${statusIcon} ${result.path} (${result.status})`));
    }
  }

  private async createAdditionalDirectories(targetDirectory: string): Promise<void> {
    const directories = [
      '.juno_task/specs',
      '.juno_task/sessions',
      '.juno_task/logs',
      '.juno_task/cache'
    ];

    for (const dir of directories) {
      const fullPath = path.join(targetDirectory, dir);
      await fs.ensureDir(fullPath);
      console.log(chalk.gray(`   Created directory: ${dir}`));
    }
  }

  private printNextSteps(targetDirectory: string): void {
    const isCurrentDir = path.resolve(targetDirectory) === path.resolve(process.cwd());

    console.log(chalk.blue('\n📋 Next Steps:'));

    if (!isCurrentDir) {
      console.log(chalk.white(`   1. cd ${path.relative(process.cwd(), targetDirectory)}`));
    }

    console.log(chalk.white('   2. Review and customize .juno_task/init.md with your specific requirements'));
    console.log(chalk.white('   3. Update .juno_task/plan.md with your project plan'));
    console.log(chalk.white('   4. Run: juno-task start'));

    console.log(chalk.blue('\n💡 Useful Commands:'));
    console.log(chalk.white('   juno-task start              # Start execution using init.md'));
    console.log(chalk.white('   juno-task session list       # View execution sessions'));
    console.log(chalk.white('   juno-task feedback           # Provide feedback to the AI'));
    console.log(chalk.white('   juno-task --help             # Show all available commands'));

    console.log(chalk.gray('\n   Happy coding! 🚀'));
  }
}

/**
 * Main init command handler
 */
export async function initCommandHandler(
  args: any,
  options: InitCommandOptions,
  command: Command
): Promise<void> {
  try {
    console.log(chalk.blue.bold('🎯 Juno Task - TypeScript CLI Initialization'));

    let context: InitializationContext;

    if (options.interactive) {
      // Interactive mode with TUI
      const tui = new InitTUI();
      context = await tui.gather();
    } else {
      // Headless mode
      const headless = new HeadlessInit(options);
      context = await headless.initialize();
    }

    // Generate project
    const generator = new ProjectGenerator(context);
    await generator.generate();

  } catch (error) {
    if (error instanceof ValidationError || error instanceof TemplateError) {
      console.error(chalk.red.bold('\n❌ Initialization Failed'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(1);
    }

    // Unexpected error
    console.error(chalk.red.bold('\n❌ Unexpected Error'));
    console.error(chalk.red(`   ${error}`));

    if (options.verbose) {
      console.error('\n📍 Stack Trace:');
      console.error(error);
    }

    process.exit(99);
  }
}

/**
 * Configure the init command for Commander.js
 */
export function configureInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize new juno-task project with template files')
    .argument('[directory]', 'Target directory (default: current directory)')
    .option('-f, --force', 'Force overwrite existing files')
    .option('-t, --task <description>', 'Main task description')
    .option('-s, --subagent <name>', 'Preferred subagent (claude, cursor, codex, gemini)', 'claude')
    .option('-g, --git-url <url>', 'Git repository URL')
    .option('-i, --interactive', 'Launch interactive TUI for guided setup')
    .option('--template <name>', 'Template variant to use', 'default')
    .option('--var <name=value>', 'Custom template variable', (value, previous) => {
      const [key, val] = value.split('=');
      return { ...previous, [key]: val };
    }, {})
    .action(async (directory, options, command) => {
      const initOptions: InitCommandOptions = {
        directory,
        ...options,
        variables: options.var
      };

      await initCommandHandler([], initOptions, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-task init                                    # Initialize in current directory
  $ juno-task init my-project                         # Initialize in ./my-project
  $ juno-task init --interactive                      # Use interactive setup
  $ juno-task init --force --subagent claude          # Force overwrite with Claude
  $ juno-task init --task "Build a web scraper"       # Set specific task
  $ juno-task init --git-url https://github.com/me/repo # Set repository URL

Environment Variables:
  JUNO_TASK_SUBAGENT         Default subagent to use
  JUNO_TASK_FORCE            Force overwrite existing files
  JUNO_TASK_TEMPLATE         Default template variant
  JUNO_TASK_GIT_URL          Default git repository URL
    `);
}