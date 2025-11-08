/**
 * CLI Framework Module for juno-code
 *
 * Comprehensive CLI framework implementation providing command registration,
 * routing, validation, error handling, and execution management. This module
 * serves as the core orchestrator for all CLI commands and operations.
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../core/config.js';
import {
  CLIError,
  ValidationError,
  ConfigurationError,
  EXIT_CODES,
  ENVIRONMENT_MAPPINGS,
  SUBAGENT_ALIASES
} from './types.js';
import type {
  CLICommand,
  CommandOption,
  CommandHandler,
  CommandExample,
  GlobalCLIOptions,
  AllCommandOptions,
  HelpContent
} from './types.js';
import type { SubagentType, JunoTaskConfig } from '../types/index.js';

// ============================================================================
// Framework Core Classes
// ============================================================================

/**
 * Main CLI framework class that manages command registration and execution
 */
export class CLIFramework {
  private program: Command;
  private commands: Map<string, CLICommand> = new Map();
  private globalOptions: CommandOption[] = [];
  private beforeExecuteHooks: Array<(options: any) => Promise<void>> = [];
  private afterExecuteHooks: Array<(result: any, options: any) => Promise<void>> = [];

  constructor() {
    this.program = new Command();
    this.setupGlobalOptions();
    this.setupErrorHandling();
  }

  /**
   * Setup global options available to all commands
   */
  private setupGlobalOptions(): void {
    this.globalOptions = [
      {
        flags: '-v, --verbose',
        description: 'Enable verbose output with detailed progress',
        defaultValue: false,
        env: 'JUNO_CODE_VERBOSE'
      },
      {
        flags: '-q, --quiet',
        description: 'Disable rich formatting, use plain text',
        defaultValue: false,
        env: 'JUNO_CODE_QUIET'
      },
      {
        flags: '-c, --config <path>',
        description: 'Configuration file path (.json, .toml, pyproject.toml)',
        env: 'JUNO_CODE_CONFIG'
      },
      {
        flags: '--log-file <path>',
        description: 'Log file path (auto-generated if not specified)',
        env: 'JUNO_CODE_LOG_FILE'
      },
      {
        flags: '--no-color',
        description: 'Disable colored output'
      },
      {
        flags: '--log-level <level>',
        description: 'Log level for output (error, warn, info, debug, trace)',
        defaultValue: 'info',
        choices: ['error', 'warn', 'info', 'debug', 'trace'],
        env: 'JUNO_CODE_LOG_LEVEL'
      },
      {
        flags: '-s, --subagent <type>',
        description: 'Subagent to use',
        env: 'JUNO_CODE_SUBAGENT'
      },
      {
        flags: '--max-iterations <number>',
        description: 'Maximum iterations (-1 for unlimited)',
        defaultValue: undefined,
        env: 'JUNO_CODE_MAX_ITERATIONS'
      },
      {
        flags: '--mcp-timeout <number>',
        description: 'MCP server timeout in milliseconds',
        defaultValue: undefined,
        env: 'JUNO_CODE_MCP_TIMEOUT'
      }
    ];

    // Add global options to program
    for (const option of this.globalOptions) {
      this.program.addOption(this.createCommanderOption(option));
    }
  }

  /**
   * Setup global error handling
   */
  private setupErrorHandling(): void {
    this.program.exitOverride((err) => {
      if (err.code === 'commander.helpDisplayed') {
        process.exit(0);
      }
      if (err.code === 'commander.version') {
        process.exit(0);
      }
      throw err;
    });

    // Configure help formatting
    this.program.configureHelp({
      sortSubcommands: true,
      subcommandTerm: (cmd) => cmd.name() + ' ' + cmd.usage(),
      commandUsage: (cmd) => cmd.name() + ' ' + cmd.usage(),
      commandDescription: (cmd) => cmd.description(),
    });
  }

  /**
   * Register a command with the framework
   */
  registerCommand(command: CLICommand): void {
    this.commands.set(command.name, command);

    const cmd = this.program
      .command(command.name)
      .description(command.description);

    // Add aliases
    if (command.aliases) {
      for (const alias of command.aliases) {
        cmd.alias(alias);
      }
    }

    // Add arguments
    if (command.arguments) {
      for (const arg of command.arguments) {
        cmd.argument(arg.name, arg.description, arg.defaultValue);
      }
    }

    // Add options
    for (const option of command.options) {
      cmd.addOption(this.createCommanderOption(option));
    }

    // Add subcommands if present
    if (command.subcommands) {
      for (const subcommand of command.subcommands) {
        this.registerSubcommand(cmd, subcommand);
      }
    }

    // Set action handler
    cmd.action(async (...args) => {
      try {
        await this.executeCommand(command, args);
      } catch (error) {
        await this.handleCommandError(error, command.name, args[args.length - 2]);
      }
    });

    // Add examples to help
    if (command.examples) {
      this.addExamplesToHelp(cmd, command.examples);
    }
  }

  /**
   * Register a subcommand
   */
  private registerSubcommand(parentCmd: Command, subcommand: CLICommand): void {
    const subCmd = parentCmd
      .command(subcommand.name)
      .description(subcommand.description);

    // Add arguments
    if (subcommand.arguments) {
      for (const arg of subcommand.arguments) {
        subCmd.argument(arg.name, arg.description, arg.defaultValue);
      }
    }

    // Add options
    for (const option of subcommand.options) {
      subCmd.addOption(this.createCommanderOption(option));
    }

    // Set action handler
    subCmd.action(async (...args) => {
      try {
        await this.executeCommand(subcommand, args);
      } catch (error) {
        await this.handleCommandError(error, subcommand.name, args[args.length - 2]);
      }
    });

    // Add examples to help
    if (subcommand.examples) {
      this.addExamplesToHelp(subCmd, subcommand.examples);
    }
  }

  /**
   * Create a Commander.js option from our option interface
   */
  private createCommanderOption(option: CommandOption): Option {
    const opt = new Option(option.flags, option.description);

    if (option.defaultValue !== undefined) {
      opt.default(option.defaultValue);
    }

    if (option.choices) {
      opt.choices(option.choices);
    }

    if (option.required) {
      opt.makeOptionMandatory();
    }

    if (option.conflicts) {
      for (const conflict of option.conflicts) {
        opt.conflicts(conflict);
      }
    }

    if (option.implies) {
      for (const implies of option.implies) {
        opt.implies({ [implies]: true });
      }
    }

    // Link environment variable if specified
    if (option.env) {
      opt.env(option.env);
    }

    // Add parser for numeric options
    if (option.flags.includes('--max-iterations') || option.flags.includes('--mcp-timeout') || option.flags.includes('--mcp-retries')) {
      opt.argParser((value: string) => {
        const num = parseInt(value, 10);
        if (isNaN(num)) {
          throw new Error(`Invalid number: ${value}`);
        }
        return num;
      });
    }

    return opt;
  }

  /**
   * Add examples to command help
   */
  private addExamplesToHelp(cmd: Command, examples: CommandExample[]): void {
    const helpText = examples
      .map(example => `  ${chalk.gray('$')} ${example.command}\n    ${example.description}`)
      .join('\n\n');

    cmd.addHelpText('after', `\n${chalk.blue.bold('Examples:')}\n${helpText}\n`);
  }

  /**
   * Execute a command with proper error handling and hooks
   */
  private async executeCommand(command: CLICommand, args: any[]): Promise<void> {
    const options = args[args.length - 2] || {};
    const commandObj = args[args.length - 1];

    // Get global options from parent program
    const parentOptions = commandObj?.parent?.opts() || {};

    // Process environment variables
    const envOptions = this.processEnvironmentVariables();

    // Merge all option sources: env < command < parent
    const mergedOptions = { ...envOptions, ...options, ...parentOptions };

    // Validate options
    await this.validateOptions(mergedOptions, command);

    // Run before execute hooks
    for (const hook of this.beforeExecuteHooks) {
      await hook(mergedOptions);
    }

    let result: any;
    try {
      // Execute command
      result = await command.handler(args.slice(0, -2), mergedOptions, commandObj);
    } catch (error) {
      // Run after execute hooks even on error
      for (const hook of this.afterExecuteHooks) {
        try {
          await hook(null, mergedOptions);
        } catch (hookError) {
          console.warn(chalk.yellow(`Warning: After-execute hook failed: ${hookError}`));
        }
      }
      throw error;
    }

    // Run after execute hooks
    for (const hook of this.afterExecuteHooks) {
      await hook(result, mergedOptions);
    }
  }

  /**
   * Process environment variables and map them to CLI options
   */
  private processEnvironmentVariables(): Partial<AllCommandOptions> {
    const options: Partial<AllCommandOptions> = {};

    for (const [envVar, optionKey] of Object.entries(ENVIRONMENT_MAPPINGS)) {
      const envValue = process.env[envVar];

      if (envValue !== undefined) {
        options[optionKey as keyof AllCommandOptions] = this.parseEnvironmentValue(envValue, optionKey);
      }
    }

    return options;
  }

  /**
   * Parse environment variable values with proper type conversion
   */
  private parseEnvironmentValue(value: string, key: string): any {
    // Boolean values
    if (['verbose', 'quiet', 'interactive', 'force', 'noColor'].includes(key)) {
      return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
    }

    // Number values
    if (['maxIterations', 'mcpTimeout', 'mcpRetries', 'limit', 'days'].includes(key)) {
      const num = parseInt(value, 10);
      return isNaN(num) ? undefined : num;
    }

    // String values (default)
    return value;
  }

  /**
   * Validate command options
   */
  private async validateOptions(options: any, command: CLICommand): Promise<void> {
    // Normalize subagent if present
    if (options.subagent && SUBAGENT_ALIASES[options.subagent]) {
      options.subagent = SUBAGENT_ALIASES[options.subagent];
    }

    // Validate subagent choices
    if (options.subagent) {
      const validSubagents: SubagentType[] = ['claude', 'cursor', 'codex', 'gemini'];
      if (!validSubagents.includes(options.subagent)) {
        throw new ValidationError(
          `Invalid subagent: ${options.subagent}`,
          [
            `Valid subagents: ${validSubagents.join(', ')}`,
            `Aliases: ${Object.keys(SUBAGENT_ALIASES).join(', ')}`
          ]
        );
      }
    }

    // Validate max iterations
    if (options.maxIterations !== undefined) {
      if (options.maxIterations !== -1 && options.maxIterations < 1) {
        throw new ValidationError(
          'Max iterations must be -1 (unlimited) or a positive number',
          ['Use -1 for unlimited iterations', 'Use positive numbers for limited iterations']
        );
      }
    }

    // Validate working directory
    if (options.cwd) {
      const fs = await import('fs-extra');
      if (!await fs.pathExists(options.cwd)) {
        throw new ValidationError(
          `Working directory does not exist: ${options.cwd}`,
          ['Verify the path exists', 'Use absolute paths to avoid ambiguity']
        );
      }
    }
  }

  /**
   * Handle command execution errors
   */
  private async handleCommandError(error: unknown, commandName: string, options: any): Promise<void> {
    const verbose = options?.verbose || false;
    const quiet = options?.quiet || false;

    if (!quiet) {
      if (error instanceof CLIError) {
        console.error(chalk.red.bold(`\n❌ ${error.constructor.name}`));
        console.error(chalk.red(`   ${error.message}`));

        if (error.suggestions?.length) {
          console.error(chalk.yellow('\n💡 Suggestions:'));
          error.suggestions.forEach(suggestion => {
            console.error(chalk.yellow(`   • ${suggestion}`));
          });
        }

        if (error.showHelp) {
          console.error(chalk.gray(`\n   Use 'juno-code ${commandName} --help' for usage information`));
        }

        const exitCode = Object.values(EXIT_CODES).includes((error as any).code)
          ? (error as any).code
          : EXIT_CODES.UNEXPECTED_ERROR;

        process.exit(exitCode);
      }

      // Handle unexpected errors
      console.error(chalk.red.bold('\n❌ Unexpected Error'));
      console.error(chalk.red.bold(`   ${error instanceof Error ? error.message : String(error)}`));

      if (verbose && error instanceof Error) {
        console.error(chalk.gray('\n📍 Stack Trace:'));
        console.error(error.stack);
      }
    }

    process.exit(EXIT_CODES.UNEXPECTED_ERROR);
  }

  /**
   * Add before execute hook
   */
  addBeforeExecuteHook(hook: (options: any) => Promise<void>): void {
    this.beforeExecuteHooks.push(hook);
  }

  /**
   * Add after execute hook
   */
  addAfterExecuteHook(hook: (result: any, options: any) => Promise<void>): void {
    this.afterExecuteHooks.push(hook);
  }

  /**
   * Configure program metadata
   */
  configure(options: {
    name: string;
    description: string;
    version: string;
    helpOption?: string;
  }): void {
    this.program
      .name(options.name)
      .description(options.description)
      .version(options.version, '-V, --version', 'Display version information')
      .helpOption(options.helpOption || '-h, --help', 'Display help information');
  }

  /**
   * Add global help text
   */
  addHelpText(position: 'before' | 'after' | 'beforeAll' | 'afterAll', text: string): void {
    this.program.addHelpText(position, text);
  }

  /**
   * Parse and execute CLI arguments
   */
  async execute(argv?: string[]): Promise<void> {
    try {
      await this.program.parseAsync(argv);
    } catch (error) {
      await this.handleCommandError(error, 'juno-code', {});
    }
  }

  /**
   * Get the underlying Commander program
   */
  getProgram(): Command {
    return this.program;
  }

  /**
   * Get registered commands
   */
  getCommands(): Map<string, CLICommand> {
    return this.commands;
  }
}

// ============================================================================
// Command Factory Functions
// ============================================================================

/**
 * Create a new CLI command
 */
export function createCommand(options: {
  name: string;
  description: string;
  aliases?: string[];
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
    choices?: string[];
    defaultValue?: any;
  }>;
  options?: CommandOption[];
  handler: CommandHandler;
  examples?: CommandExample[];
  subcommands?: CLICommand[];
}): CLICommand {
  return {
    name: options.name,
    description: options.description,
    aliases: options.aliases,
    arguments: options.arguments,
    options: options.options || [],
    handler: options.handler,
    examples: options.examples,
    subcommands: options.subcommands
  };
}

/**
 * Create a command option
 */
export function createOption(options: {
  flags: string;
  description: string;
  defaultValue?: any;
  required?: boolean;
  choices?: string[];
  conflicts?: string[];
  implies?: string[];
  env?: string;
}): CommandOption {
  return {
    flags: options.flags,
    description: options.description,
    defaultValue: options.defaultValue,
    required: options.required,
    choices: options.choices,
    conflicts: options.conflicts,
    implies: options.implies,
    env: options.env
  };
}

// ============================================================================
// Configuration Loader Integration
// ============================================================================

/**
 * Load configuration with CLI options integration
 */
export async function loadCLIConfig(options: {
  cliOptions: any;
  configFile?: string;
  baseDir?: string;
}): Promise<JunoTaskConfig> {
  return await loadConfig({
    baseDir: options.baseDir || process.cwd(),
    configFile: options.configFile,
    cliConfig: {
      verbose: options.cliOptions.verbose,
      quiet: options.cliOptions.quiet,
      logLevel: options.cliOptions.logLevel,
      workingDirectory: options.cliOptions.cwd || process.cwd(),
      // Add other CLI options as needed
    }
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Normalize subagent type with alias support
 */
export function normalizeSubagent(subagent: string): SubagentType | null {
  const normalized = SUBAGENT_ALIASES[subagent] || subagent;
  const validSubagents: SubagentType[] = ['claude', 'cursor', 'codex', 'gemini'];

  return validSubagents.includes(normalized as SubagentType)
    ? normalized as SubagentType
    : null;
}

/**
 * Format command help content
 */
export function formatHelpContent(content: HelpContent): string {
  const lines: string[] = [];

  lines.push(chalk.blue.bold(`${content.command} - ${content.description}`));
  lines.push('');
  lines.push(chalk.white.bold('Usage:'));
  lines.push(`  ${content.usage}`);
  lines.push('');

  if (content.options.length > 0) {
    lines.push(chalk.white.bold('Options:'));
    for (const option of content.options) {
      const defaultText = option.defaultValue !== undefined
        ? ` (default: ${option.defaultValue})`
        : '';
      const choicesText = option.choices
        ? ` [choices: ${option.choices.join(', ')}]`
        : '';
      lines.push(`  ${chalk.cyan(option.flags)}\t${option.description}${defaultText}${choicesText}`);
    }
    lines.push('');
  }

  if (content.subcommands && content.subcommands.length > 0) {
    lines.push(chalk.white.bold('Subcommands:'));
    for (const subcommand of content.subcommands) {
      const aliasText = subcommand.aliases?.length
        ? ` (aliases: ${subcommand.aliases.join(', ')})`
        : '';
      lines.push(`  ${chalk.cyan(subcommand.name)}\t${subcommand.description}${aliasText}`);
    }
    lines.push('');
  }

  if (content.examples.length > 0) {
    lines.push(chalk.white.bold('Examples:'));
    for (const example of content.examples) {
      lines.push(`  ${chalk.gray('$')} ${example.command}`);
      lines.push(`    ${example.description}`);
      lines.push('');
    }
  }

  if (content.notes && content.notes.length > 0) {
    lines.push(chalk.white.bold('Notes:'));
    for (const note of content.notes) {
      lines.push(`  • ${note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Create a singleton CLI framework instance
 */
export const defaultCLIFramework = new CLIFramework();