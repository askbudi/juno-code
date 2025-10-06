/**
 * CLI entry point for juno-task-ts
 *
 * Comprehensive TypeScript CLI implementation with full functionality parity
 * to the Python budi-cli. Provides all core commands with interactive and
 * headless support, comprehensive error handling, and real-time progress tracking.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../core/config.js';
import { EXIT_CODES, isCLIError } from '../cli/types.js';

// Import command configurations
import { configureInitCommand } from '../cli/commands/init.js';
import { configureStartCommand } from '../cli/commands/start.js';
import { configureFeedbackCommand } from '../cli/commands/feedback.js';
import { configureSessionCommand } from '../cli/commands/session.js';
import { configureSetupGitCommand } from '../cli/commands/setup-git.js';

// Version information
const VERSION = '1.0.0';

/**
 * Global error handler for CLI operations
 */
function handleCLIError(error: unknown, verbose: boolean = false): void {
  if (isCLIError(error)) {
    // Handle known CLI errors
    console.error(chalk.red.bold(`\n❌ ${error.constructor.name}`));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    }

    if (error.showHelp) {
      console.error(chalk.gray('\n   Use --help for usage information'));
    }

    // Map CLI error to exit code
    const exitCode = Object.values(EXIT_CODES).includes((error as any).code)
      ? (error as any).code
      : EXIT_CODES.UNEXPECTED_ERROR;

    process.exit(exitCode);
  }

  // Handle unexpected errors
  console.error(chalk.red.bold('\n❌ Unexpected Error'));
  console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));

  if (verbose && error instanceof Error) {
    console.error(chalk.gray('\n📍 Stack Trace:'));
    console.error(error.stack);
  }

  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
}

/**
 * Setup global CLI options and behaviors
 */
function setupGlobalOptions(program: Command): void {
  // Global options available to all commands
  program
    .option('-v, --verbose', 'Enable verbose output with detailed progress')
    .option('-q, --quiet', 'Disable rich formatting, use plain text')
    .option('-c, --config <path>', 'Configuration file path (.json, .toml, pyproject.toml)')
    .option('--log-file <path>', 'Log file path (auto-generated if not specified)')
    .option('--no-color', 'Disable colored output')
    .option('--log-level <level>', 'Log level for output (error, warn, info, debug, trace)', 'info');

  // Global error handling
  program.exitOverride((err) => {
    if (err.code === 'commander.helpDisplayed') {
      process.exit(0);
    }
    if (err.code === 'commander.version') {
      process.exit(0);
    }
    handleCLIError(err, false);
  });

  // Custom help formatting
  program.configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => cmd.name() + ' ' + cmd.usage(),
    commandUsage: (cmd) => cmd.name() + ' ' + cmd.usage(),
    commandDescription: (cmd) => cmd.description(),
  });
}

/**
 * Setup main execution command (default command)
 */
function setupMainCommand(program: Command): void {
  // Main command for direct execution with subagent
  program
    .argument('[subagent]', 'Subagent to use (claude, cursor, codex, gemini)')
    .option('-p, --prompt <text>', 'Prompt input (file path or inline text)')
    .option('--cwd <path>', 'Working directory')
    .option('-m, --max-iterations <number>', 'Maximum iterations (-1 for unlimited)', parseInt)
    .option('--model <name>', 'Model to use (subagent-specific)')
    .option('-i, --interactive', 'Interactive mode for typing prompts')
    .option('--interactive-prompt', 'Launch TUI prompt editor')
    .action(async (subagent, options, command) => {
      try {
        if (!subagent) {
          console.log(chalk.blue.bold('🎯 Juno Task - TypeScript CLI for AI Subagent Orchestration\n'));
          console.log(chalk.white('To get started:'));
          console.log(chalk.gray('  juno-task init                    # Initialize new project'));
          console.log(chalk.gray('  juno-task start                   # Start execution'));
          console.log(chalk.gray('  juno-task claude "your prompt"    # Quick execution with Claude'));
          console.log(chalk.gray('  juno-task --help                  # Show all commands'));
          console.log('');
          return;
        }

        // Import and execute main command handler dynamically
        const { mainCommandHandler } = await import('../cli/commands/main.js');
        await mainCommandHandler([subagent], { ...options, subagent }, command);
      } catch (error) {
        handleCLIError(error, options.verbose);
      }
    });
}

/**
 * Display welcome banner with version and environment info
 */
function displayBanner(verbose: boolean = false): void {
  if (verbose) {
    console.log(chalk.blue.bold(`\n🎯 Juno Task v${VERSION} - TypeScript CLI`));
    console.log(chalk.gray(`   Node.js ${process.version} on ${process.platform}`));
    console.log(chalk.gray(`   Working directory: ${process.cwd()}`));
    console.log('');
  }
}

/**
 * Setup completion support
 */
function setupCompletion(program: Command): void {
  // Hidden completion command for shell integration
  program
    .command('completion', { hidden: true })
    .description('Generate shell completion script')
    .argument('<shell>', 'Shell type (bash, zsh, fish)')
    .action(async (shell, options, command) => {
      try {
        const { generateCompletion } = await import('../cli/utils/completion.js');
        const script = generateCompletion(shell, 'juno-task');
        console.log(script);
      } catch (error) {
        handleCLIError(error, false);
      }
    });

  // Install completion command
  program
    .command('install-completion', { hidden: true })
    .description('Install shell completion')
    .option('--shell <type>', 'Shell type (auto-detected if not specified)')
    .action(async (options, command) => {
      try {
        const { installCompletion } = await import('../cli/utils/completion.js');
        await installCompletion(options.shell);
      } catch (error) {
        handleCLIError(error, false);
      }
    });
}

/**
 * Create command aliases for common operations
 */
function setupAliases(program: Command): void {
  // Subagent aliases as direct commands
  const subagents = ['claude', 'cursor', 'codex', 'gemini'];

  for (const subagent of subagents) {
    program
      .command(subagent, { hidden: true })
      .description(`Execute with ${subagent} subagent`)
      .argument('[prompt...]', 'Prompt text or file path')
      .option('-m, --max-iterations <number>', 'Maximum iterations', parseInt)
      .option('--model <name>', 'Model to use')
      .option('--cwd <path>', 'Working directory')
      .action(async (prompt, options, command) => {
        try {
          const { mainCommandHandler } = await import('../cli/commands/main.js');
          const promptText = Array.isArray(prompt) ? prompt.join(' ') : prompt;
          await mainCommandHandler([], {
            ...options,
            subagent,
            prompt: promptText
          }, command);
        } catch (error) {
          handleCLIError(error, options.verbose);
        }
      });
  }
}

/**
 * Configure environment variable integration
 */
function configureEnvironment(): void {
  // Load environment variables with JUNO_TASK_ prefix
  const envVars = [
    'JUNO_TASK_SUBAGENT',
    'JUNO_TASK_PROMPT',
    'JUNO_TASK_CWD',
    'JUNO_TASK_MAX_ITERATIONS',
    'JUNO_TASK_MODEL',
    'JUNO_TASK_LOG_FILE',
    'JUNO_TASK_VERBOSE',
    'JUNO_TASK_QUIET',
    'JUNO_TASK_CONFIG',
    'JUNO_TASK_MCP_SERVER_PATH',
    'JUNO_TASK_MCP_TIMEOUT',
    'JUNO_TASK_NO_COLOR'
  ];

  // Set defaults from environment variables
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (value && !process.argv.includes(`--${envVar.toLowerCase().replace('juno_task_', '').replace(/_/g, '-')}`)) {
      // Environment variable is set but not overridden by CLI argument
      const option = envVar.toLowerCase().replace('juno_task_', '').replace(/_/g, '-');

      switch (option) {
        case 'verbose':
        case 'quiet':
        case 'no-color':
          if (value.toLowerCase() === 'true' || value === '1') {
            process.argv.push(`--${option}`);
          }
          break;
        default:
          process.argv.push(`--${option}`, value);
      }
    }
  }

  // Handle NO_COLOR standard
  if (process.env.NO_COLOR && !process.argv.includes('--no-color')) {
    process.argv.push('--no-color');
  }

  // Handle CI environment
  if (process.env.CI && !process.argv.includes('--quiet')) {
    process.argv.push('--quiet');
  }
}

/**
 * Main CLI function
 */
async function main(): Promise<void> {
  const program = new Command();

  // Configure environment
  configureEnvironment();

  // Basic program setup
  program
    .name('juno-task')
    .description('TypeScript implementation of juno-task CLI tool for AI subagent orchestration')
    .version(VERSION, '-V, --version', 'Display version information')
    .helpOption('-h, --help', 'Display help information');

  // Setup global options and behaviors
  setupGlobalOptions(program);

  // Display banner if verbose
  const isVerbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  displayBanner(isVerbose);

  // Configure all commands
  configureInitCommand(program);
  configureStartCommand(program);
  configureFeedbackCommand(program);
  configureSessionCommand(program);
  configureSetupGitCommand(program);

  // Setup completion
  setupCompletion(program);

  // Setup aliases
  setupAliases(program);

  // Setup main command (must be last)
  setupMainCommand(program);

  // Add comprehensive help
  program.addHelpText('beforeAll', `
${chalk.blue.bold('🎯 Juno Task')} - TypeScript CLI for AI Subagent Orchestration

`);

  program.addHelpText('afterAll', `
${chalk.blue.bold('Examples:')}
  ${chalk.gray('# Initialize new project')}
  juno-task init

  ${chalk.gray('# Start execution using .juno_task/init.md')}
  juno-task start

  ${chalk.gray('# Quick execution with Claude')}
  juno-task claude "Analyze this codebase and suggest improvements"

  ${chalk.gray('# Interactive project setup')}
  juno-task init --interactive

  ${chalk.gray('# Manage sessions')}
  juno-task session list
  juno-task session info abc123

  ${chalk.gray('# Collect feedback')}
  juno-task feedback --interactive

  ${chalk.gray('# Setup Git repository')}
  juno-task setup-git https://github.com/owner/repo

${chalk.blue.bold('Environment Variables:')}
  JUNO_TASK_SUBAGENT         Default subagent (claude, cursor, codex, gemini)
  JUNO_TASK_MCP_SERVER_PATH  Path to MCP server executable
  JUNO_TASK_CONFIG           Configuration file path
  JUNO_TASK_VERBOSE          Enable verbose output (true/false)
  NO_COLOR                   Disable colored output (standard)

${chalk.blue.bold('Configuration:')}
  Configuration can be specified via:
  1. Command line arguments (highest priority)
  2. Environment variables
  3. Configuration files (.json, .toml, pyproject.toml)
  4. Built-in defaults (lowest priority)

${chalk.blue.bold('Support:')}
  Documentation: https://github.com/owner/juno-task-ts#readme
  Issues: https://github.com/owner/juno-task-ts/issues
  License: MIT

`);

  // Parse and execute
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    handleCLIError(error, isVerbose);
  }
}

/**
 * Global error handlers
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red.bold('\n💥 Unhandled Promise Rejection'));
  console.error(chalk.red('   This is likely a bug. Please report it.'));
  console.error(chalk.gray('   Promise:'), promise);
  console.error(chalk.gray('   Reason:'), reason);
  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
});

process.on('uncaughtException', (error) => {
  console.error(chalk.red.bold('\n💥 Uncaught Exception'));
  console.error(chalk.red('   This is likely a bug. Please report it.'));
  console.error(chalk.gray('   Error:'), error.message);
  console.error(chalk.gray('   Stack:'), error.stack);
  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\n⚠️  Execution cancelled by user'));
  process.exit(EXIT_CODES.SUCCESS);
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n\n⚠️  Execution terminated'));
  process.exit(EXIT_CODES.SUCCESS);
});

// Export for testing
export { main, handleCLIError };

// Run the CLI if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(chalk.red.bold('\n💥 Fatal Error'));
    console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));
    process.exit(EXIT_CODES.UNEXPECTED_ERROR);
  });
}