/**
 * Init command implementation for juno-task-ts CLI
 *
 * Provides interactive project initialization with template generation,
 * configuration setup, and directory structure creation. Includes both
 * interactive TUI mode and headless mode for automation.
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';
import { z } from 'zod';

import { loadConfig } from '../../core/config.js';
import { defaultTemplateEngine, TemplateUtils } from '../../templates/engine.js';
import type { TemplateVariables, Template } from '../../templates/types.js';
import type { InitCommandOptions } from '../types.js';
import { ValidationError, TemplateError } from '../types.js';
import type { SubagentType } from '../../types/index.js';
import { headlessSelection, headlessConfirmation } from '../../tui/utils/headless.js';
import * as readline from 'readline';

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
 * Simplified Interactive TUI for project initialization
 * Minimal flow: Project Root → Main Task → Editor Selection → Git Setup → Save
 */
class SimpleInitTUI {
  private context: Partial<InitializationContext> = {};

  /**
   * Helper method to prompt for text input using readline
   */
  private async promptForInput(prompt: string, defaultValue: string = ''): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const question = `${prompt}${defaultValue ? ` (default: ${defaultValue})` : ''}: `;

      rl.question(question, (answer: string) => {
        rl.close();
        resolve(answer.trim() || defaultValue);
      });
    });
  }

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
    console.log(chalk.yellow('📁 Project Directory:'));
    console.log('   Enter the target directory for your project (default: current directory)');

    const answer = await this.promptForInput('Directory path', process.cwd());
    return path.resolve(answer || process.cwd());
  }

  private async promptForTask(): Promise<string> {
    console.log(chalk.yellow('\n📝 Main Task:'));
    console.log('   Describe the main objective of your project');
    console.log('   You can enter multiple lines. Press Ctrl+D when finished.');

    try {
      // Use the TUI prompt editor for multiline input
      const { launchPromptEditor, isTUISupported } = await import('../../tui/index.js');

      if (isTUISupported()) {
        console.log(chalk.blue('\n🎨 Launching TUI editor for task description...'));

        const task = await launchPromptEditor({
          initialValue: '',
          title: 'Project Task Description',
          maxLength: 1000
        });

        if (!task || task.trim().length < 10) {
          throw new ValidationError(
            'Task description must be at least 10 characters',
            ['Provide a descriptive task objective', 'Example: "Build a TypeScript CLI tool for AI orchestration"']
          );
        }

        return task.trim();
      } else {
        // Fallback to multiline input
        return await this.collectMultilineInput('Main task description');
      }
    } catch (error) {
      console.log(chalk.yellow('TUI not available, using text input...'));
      return await this.collectMultilineInput('Main task description');
    }
  }

  private async collectMultilineInput(prompt: string): Promise<string> {
    console.log(chalk.blue(`\n${prompt}:`));
    console.log(chalk.gray('Enter your text (press Ctrl+D when finished):'));

    return new Promise((resolve, reject) => {
      let input = '';

      process.stdin.setEncoding('utf8');
      process.stdin.resume();

      process.stdin.on('data', (chunk) => {
        input += chunk;
      });

      process.stdin.on('end', () => {
        const trimmed = input.trim();
        if (!trimmed || trimmed.length < 10) {
          reject(new ValidationError(
            'Task description must be at least 10 characters',
            ['Provide a descriptive task objective', 'Example: "Build a TypeScript CLI tool for AI orchestration"']
          ));
        } else {
          resolve(trimmed);
        }
      });

      process.stdin.on('error', (error) => {
        reject(new ValidationError(
          `Failed to read input: ${error}`,
          ['Try again with valid input']
        ));
      });
    });
  }

  private async promptForSubagent(): Promise<SubagentType> {
    const choices = [
      { label: 'Claude', value: 'claude' as SubagentType, description: 'Recommended for complex reasoning and code quality' },
      { label: 'Cursor', value: 'cursor' as SubagentType, description: 'Great for real-time collaboration' },
      { label: 'Codex', value: 'codex' as SubagentType, description: 'Excellent for code generation' },
      { label: 'Gemini', value: 'gemini' as SubagentType, description: 'Strong for multimodal tasks' }
    ];

    const selected = await headlessSelection({
      message: '🤖 Choose your preferred AI coding agent',
      choices
    });

    return selected || 'claude';
  }

  private async promptForGitUrl(): Promise<string | undefined> {
    console.log(chalk.yellow('\n🔗 Git Repository (Optional):'));
    console.log('   Enter the Git repository URL for this project (press Enter to skip)');

    const gitUrl = await this.promptForInput('Git URL (optional)', '');

    if (gitUrl && gitUrl.trim()) {
      // Validate URL format
      if (!/^https?:\/\/.+/.test(gitUrl.trim())) {
        throw new ValidationError(
          'Invalid Git URL format',
          ['Provide a valid HTTPS Git repository URL', 'Example: https://github.com/owner/repo']
        );
      }
      return gitUrl.trim();
    }

    return undefined;
  }

  public createVariables(
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

      // Agent status variables (computed based on selected subagent)
      CLAUDE_STATUS: subagent === 'claude' ? '✅ SELECTED' : '⭕ Available',
      CURSOR_STATUS: subagent === 'cursor' ? '✅ SELECTED' : '⭕ Available',
      CODEX_STATUS: subagent === 'codex' ? '✅ SELECTED' : '⭕ Available',
      GEMINI_STATUS: subagent === 'gemini' ? '✅ SELECTED' : '⭕ Available',

      // Requirements template variables with defaults
      FEATURE_1_DESCRIPTION: 'Core feature description to be defined',
      FEATURE_2_DESCRIPTION: 'Core feature description to be defined',
      FEATURE_3_DESCRIPTION: 'Core feature description to be defined',
      USER_TYPE: 'user',
      ACTION: 'perform an action',
      BENEFIT: 'achieve a benefit',
      BUSINESS_RULE_1: 'Business rule to be defined',
      BUSINESS_RULE_2: 'Business rule to be defined',
      BUSINESS_RULE_3: 'Business rule to be defined',
      RESPONSE_TIME: '200',
      THROUGHPUT: '1000',
      SCALE_TARGET: '10000 users',
      AUTH_METHOD: 'JWT tokens',
      AVAILABILITY_TARGET: '99.9',
      TARGET_PLATFORM: 'Node.js',
      PROGRAMMING_LANGUAGE: 'TypeScript',
      DATABASE_TYPE: 'PostgreSQL',
      DEPENDENCIES: 'Node.js, npm',
      BUDGET_CONSTRAINT: 'To be determined',
      TIMELINE_CONSTRAINT: 'To be determined',
      RESOURCE_CONSTRAINT: 'To be determined',
      METRIC_1: 'Performance metric',
      TARGET_VALUE: 'Target value',
      METRIC_2: 'Quality metric',
      METRIC_3: 'User satisfaction metric',

      // Architecture template variables with defaults
      SYSTEM_PURPOSE: 'System purpose to be defined',
      SYSTEM_SCOPE: 'System scope to be defined',
      STAKEHOLDER_1: 'Development Team',
      ROLE_DESCRIPTION: 'Role description to be defined',
      STAKEHOLDER_2: 'Product Owner',
      STAKEHOLDER_3: 'End Users',
      ARCHITECTURE_PATTERN: 'Modular architecture',
      ARCHITECTURE_RATIONALE: 'Architecture rationale to be defined',
      FRONTEND_TECH: 'TypeScript CLI',
      BACKEND_TECH: 'Node.js',
      DATABASE_TECH: 'File-based storage',
      INFRASTRUCTURE_TECH: 'Local development',
      FRONTEND_DESCRIPTION: 'Command-line interface',
      BACKEND_DESCRIPTION: 'Core application logic',
      DATABASE_DESCRIPTION: 'Configuration and data storage',
      DATA_MODEL_DESCRIPTION: 'Data model to be defined',
      PERSISTENCE_STRATEGY: 'File-based persistence',
      DATA_FLOW_DESCRIPTION: 'Data flow to be defined',
      API_STYLE: 'Internal APIs',
      API_AUTH_METHOD: 'Local authentication',
      RATE_LIMITING_STRATEGY: 'No rate limiting required',
      AUTH_FLOW: 'Local authentication flow',
      AUTHZ_MODEL: 'Simple authorization model',
      DATA_PROTECTION: 'Local data protection',
      DEPLOYMENT_STRATEGY: 'Local deployment',
      CONTAINER_STRATEGY: 'No containerization initially',
      ORCHESTRATION_PLATFORM: 'Local orchestration',
      MONITORING_SOLUTION: 'Console logging',
      LOGGING_SOLUTION: 'File-based logging',
      ALERTING_STRATEGY: 'Console alerts',
      BACKUP_STRATEGY: 'Version control backup',
      RTO: '1 hour',
      RPO: '1 hour',
      RESPONSE_TIME_TARGETS: 'Sub-second response',
      THROUGHPUT_REQUIREMENTS: 'Single user initially',
      SCALABILITY_STRATEGY: 'Horizontal scaling future',
      FAULT_TOLERANCE_STRATEGY: 'Graceful error handling',
      DISASTER_RECOVERY_PLAN: 'Version control recovery',
      THREAT_MODEL: 'Local threat model',
      SECURITY_CONTROLS: 'Input validation',
      COMPLIANCE_REQUIREMENTS: 'No specific compliance initially',
      CODING_STANDARDS: 'TypeScript strict mode',
      TESTING_STRATEGY: 'Unit and integration tests',
      DOCUMENTATION_REQUIREMENTS: 'Comprehensive documentation',
      DATA_MIGRATION_PLAN: 'No migration initially',
      SYSTEM_MIGRATION_PLAN: 'No migration initially',
      ROLLBACK_STRATEGY: 'Version control rollback',
      RISK_DESCRIPTION: 'Risk to be identified',
      MITIGATION_STRATEGY: 'Mitigation strategy to be defined'
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
    // Use the comprehensive variable creation from InitTUI
    const tui = new InitTUI();
    return tui.createVariables(targetDirectory, task, subagent, gitUrl);
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

    // Separate templates for different locations
    const junoTaskTemplates = templates.filter(t =>
      !['CLAUDE.md', 'AGENTS.md'].includes(t.id)
    );
    const rootTemplates = templates.filter(t =>
      ['CLAUDE.md', 'AGENTS.md'].includes(t.id)
    );

    // Generate .juno_task templates
    const junoResults = await defaultTemplateEngine.generateFiles(
      junoTaskTemplates,
      path.join(targetDirectory, '.juno_task'),
      templateContext,
      {
        force,
        createBackup: !force,
        dryRun: false,
        onConflict: force ? 'overwrite' : 'skip'
      }
    );

    // Generate root directory templates (CLAUDE.md, AGENTS.md)
    const rootResults = await defaultTemplateEngine.generateFiles(
      rootTemplates,
      targetDirectory, // Put in current working directory
      templateContext,
      {
        force,
        createBackup: !force,
        dryRun: false,
        onConflict: force ? 'overwrite' : 'skip'
      }
    );

    // Combine results
    const results = {
      success: junoResults.success && rootResults.success,
      files: [...junoResults.files, ...rootResults.files],
      context: templateContext,
      duration: junoResults.duration + rootResults.duration,
      timestamp: new Date(),
      ...((!junoResults.success || !rootResults.success) && {
        error: junoResults.error || rootResults.error
      })
    };

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

      // Show error message if present
      if (result.error) {
        console.log(chalk.red(`      Error: ${result.error}`));
      }
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

    // Default to interactive mode if no task is provided
    const shouldUseInteractive = options.interactive || (!options.task && !process.env.CI);

    if (shouldUseInteractive) {
      // Interactive mode with TUI
      console.log(chalk.yellow('🚀 Starting interactive mode...'));
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
        force: options.force,
        task: options.task,
        subagent: options.subagent,
        gitUrl: options.gitUrl,
        interactive: options.interactive,
        template: options.template,
        variables: options.var,
        // Global options
        verbose: options.verbose,
        quiet: options.quiet,
        config: options.config,
        logFile: options.logFile,
        logLevel: options.logLevel
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