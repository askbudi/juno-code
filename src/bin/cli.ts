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
import { configureTestCommand } from '../cli/commands/test.js';
import { configureFeedbackCommand } from '../cli/commands/feedback.js';
import { configureSessionCommand } from '../cli/commands/session.js';
import { configureSetupGitCommand } from '../cli/commands/setup-git.js';
import { configureLogsCommand } from '../cli/commands/logs.js';
import { configureHelpCommand } from '../cli/commands/help.js';
import { setupConfigCommand } from '../cli/commands/config.js';
import CompletionCommand from '../cli/commands/completion.js';

// Version information
const VERSION = '1.0.0';

/** Determine if an error is a transient connection/pipe error. */
function isConnectionLikeError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const lower = msg.toLowerCase();
  return ['epipe', 'broken pipe', 'econnreset', 'socket hang up', 'err_socket_closed', 'connection reset by peer']
    .some(token => lower.includes(token));
}

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
    .option('-l, --log-file <path>', 'Log file path (auto-generated if not specified)')
    .option('--no-color', 'Disable colored output')
    .option('--log-level <level>', 'Log level for output (error, warn, info, debug, trace)', 'info')
    .option('-s, --subagent <name>', 'Subagent to use (claude, cursor, codex, gemini)')
    .option('--mcp-timeout <number>', 'MCP server timeout in milliseconds', parseInt)
    .option('--enable-feedback', 'Enable concurrent feedback collection during execution')

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
    .option('-p, --prompt <text>', 'Prompt input (file path or inline text)')
    .option('-w, --cwd <path>', 'Working directory')
    .option('-i, --max-iterations <number>', 'Maximum iterations (-1 for unlimited)', parseInt)
    .option('-m, --model <name>', 'Model to use (subagent-specific)')
    .option('-I, --interactive', 'Interactive mode for typing prompts')
    .option('-ip, --interactive-prompt', 'Launch TUI prompt editor')
    .action(async (options, command) => {
      try {
        // Get global options from program
        const globalOptions = program.opts();
        const allOptions = { ...options, ...globalOptions };

        // Check if we should auto-detect project configuration
        if (!globalOptions.subagent && !options.prompt && !options.interactive && !options.interactivePrompt) {
          const fs = await import('fs-extra');
          const path = await import('node:path');
          const cwd = process.cwd();
          const junoTaskDir = path.join(cwd, '.juno_task');

          // Check if project is initialized
          if (await fs.pathExists(junoTaskDir)) {
            console.log(chalk.blue.bold('🎯 Juno Task - Auto-detected Initialized Project\n'));

            // Try to load configuration for auto-detection
            try {
              const { loadConfig } = await import('../core/config.js');
              const config = await loadConfig({
                baseDir: cwd,
                cliConfig: {
                  verbose: allOptions.verbose || false,
                  quiet: allOptions.quiet || false,
                  logLevel: allOptions.logLevel || 'info',
                  workingDirectory: cwd
                }
              });

              // Auto-detect subagent from config
              if (!allOptions.subagent && config.defaultSubagent) {
                allOptions.subagent = config.defaultSubagent;
                console.log(chalk.gray(`🤖 Using configured subagent: ${chalk.cyan(config.defaultSubagent)}`));
              }

              // Auto-detect prompt file (.juno_task/prompt.md)
              const promptFile = path.join(junoTaskDir, 'prompt.md');
              if (!allOptions.prompt && await fs.pathExists(promptFile)) {
                allOptions.prompt = promptFile;
                console.log(chalk.gray(`📄 Using default prompt: ${chalk.cyan('.juno_task/prompt.md')}`));
              }

              // Check if we have enough information to proceed
              if (allOptions.subagent && (allOptions.prompt || await fs.pathExists(promptFile))) {
                console.log(chalk.green('✓ Auto-detected project configuration\n'));
                // Import and execute with auto-detected options
                const { mainCommandHandler } = await import('../cli/commands/main.js');
                await mainCommandHandler([], allOptions, command);
                return;
              }
            } catch (configError) {
              console.log(chalk.yellow(`⚠️  Could not load project configuration: ${configError}`));
            }
          }
        }

        // Show help if no arguments provided or auto-detection failed
        if (!globalOptions.subagent && !options.prompt && !options.interactive && !options.interactivePrompt) {
          console.log(chalk.blue.bold('🎯 Juno Task - TypeScript CLI for AI Subagent Orchestration\n'));
          console.log(chalk.white('To get started:'));
          console.log(chalk.gray('  juno-task init                    # Initialize new project'));
          console.log(chalk.gray('  juno-task start                   # Start execution'));
          console.log(chalk.gray('  juno-task test --generate --run   # AI-powered testing'));
          console.log(chalk.gray('  juno-task -s claude -p "prompt"   # Quick execution with Claude'));
          console.log(chalk.gray('  juno-task --help                  # Show all commands'));
          console.log('');
          return;
        }

        // Import and execute main command handler dynamically
        const { mainCommandHandler } = await import('../cli/commands/main.js');
        await mainCommandHandler([], { ...options, ...globalOptions }, command);
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
 * Setup enhanced completion support
 */
function setupCompletion(program: Command): void {
  try {
    const completionCommand = new CompletionCommand();
    completionCommand.register(program);
  } catch (error) {
    // Don't fail CLI startup if completion setup fails
    console.warn(chalk.yellow('⚠️  Warning: Could not setup completion commands'));
  }
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
      .option('-i, --max-iterations <number>', 'Maximum iterations', parseInt)
      .option('-m, --model <name>', 'Model to use')
      .option('-w, --cwd <path>', 'Working directory')
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
    'JUNO_TASK_NO_COLOR',
    'JUNO_TASK_ENABLE_FEEDBACK'
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
        case 'enable-feedback':
          if (value.toLowerCase() === 'true' || value === '1') {
            process.argv.push(`--${option}`);
          }
          break;
        default:
          process.argv.push(`--${option}`, value);
      }
    }
  }

  // Handle JUNO_INTERACTIVE_FEEDBACK_MODE environment variable (user-requested alternative)
  // This is an alias for --enable-feedback, provides user-friendly environment variable name
  if (!process.argv.includes('--enable-feedback')) {
    const feedbackMode = process.env.JUNO_INTERACTIVE_FEEDBACK_MODE;
    if (feedbackMode && (feedbackMode.toLowerCase() === 'true' || feedbackMode === '1')) {
      process.argv.push('--enable-feedback');
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

  // Validate JSON configuration files on startup
  // Skip validation for help/version commands or when no arguments provided to avoid unnecessary checks
  const isHelpOrVersion = process.argv.includes('--help') ||
                         process.argv.includes('-h') ||
                         process.argv.includes('--version') ||
                         process.argv.includes('-V');

  // Skip validation when no arguments provided (will show default help)
  const hasNoArguments = process.argv.length <= 2;

  // Skip validation for init command - it handles its own directory checks
  const isInitCommand = process.argv.includes('init');

  // Check if project is initialized - only validate if .juno_task exists
  const fs = await import('fs-extra');
  const path = await import('node:path');
  const junoTaskDir = path.join(process.cwd(), '.juno_task');
  const isInitialized = await fs.pathExists(junoTaskDir);

  // Only run validation for initialized projects (has .juno_task folder) and not for help/version/init/no-args
  if (!isHelpOrVersion && !hasNoArguments && !isInitCommand && isInitialized) {
    try {
      const { validateStartupConfigs } = await import('../utils/startup-validation.js');
      const validationPassed = await validateStartupConfigs(process.cwd(), isVerbose);

      if (!validationPassed) {
        console.log(chalk.red('💥 Cannot continue with invalid configuration. Please fix the errors above.\n'));
        process.exit(EXIT_CODES.CONFIGURATION_ERROR);
      }
    } catch (validationError) {
      // Validation system error - log but don't block startup
      console.log(chalk.yellow('⚠️  Configuration validation unavailable, continuing with startup...'));
      if (isVerbose) {
        console.log(chalk.gray(`   Validation error: ${validationError instanceof Error ? validationError.message : String(validationError)}`));
      }
    }
  }

  // Configure all commands
  configureInitCommand(program);
  configureStartCommand(program);
  configureTestCommand(program);
  configureFeedbackCommand(program);
  configureSessionCommand(program);
  configureSetupGitCommand(program);
  configureLogsCommand(program);
  configureHelpCommand(program);
  setupConfigCommand(program);

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

  ${chalk.gray('# AI-powered testing')}
  juno-task test --generate --run
  juno-task test src/utils.ts --subagent claude
  juno-task test --analyze --coverage

  ${chalk.gray('# Quick execution with Claude')}
  juno-task claude "Analyze this codebase and suggest improvements"

  ${chalk.gray('# Interactive project setup')}
  juno-task init --interactive

  ${chalk.gray('# Manage sessions')}
  juno-task session list
  juno-task session info abc123

  ${chalk.gray('# Enable feedback collection globally')}
  juno-task --enable-feedback start

  ${chalk.gray('# Collect feedback')}
  juno-task feedback --interactive

  ${chalk.gray('# Manage configuration profiles')}
  juno-task config list
  juno-task config create development

  ${chalk.gray('# Setup Git repository')}
  juno-task setup-git https://github.com/owner/repo

${chalk.blue.bold('Environment Variables:')}
  JUNO_TASK_SUBAGENT              Default subagent (claude, cursor, codex, gemini)
  JUNO_TASK_MCP_SERVER_PATH       Path to MCP server executable
  JUNO_TASK_CONFIG                Configuration file path
  JUNO_TASK_VERBOSE               Enable verbose output (true/false)
  JUNO_TASK_ENABLE_FEEDBACK       Enable concurrent feedback collection (true/false)
  JUNO_INTERACTIVE_FEEDBACK_MODE  Enable interactive feedback mode (true/false)
  NO_COLOR                        Disable colored output (standard)

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
process.on('unhandledRejection', async (reason, promise) => {
  try {
    if (isConnectionLikeError(reason)) {
      // Log and continue (don’t exit) for transient pipe/socket issues
      const { getMCPLogger } = await import('../utils/logger.js');
      const logger = getMCPLogger();
      await logger.error(`[Process][unhandledRejection][connection] ${String(reason)}`, false);
      const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
      if (verbose) {
        console.error(chalk.yellow('\n⚠️  Transient connection issue (continuing):'));
        console.error(chalk.gray('   Reason:'), reason);
      }
      return; // do not exit
    }
  } catch {
    // fall through to default handler
  }
  console.error(chalk.red.bold('\n💥 Unhandled Promise Rejection'));
  console.error(chalk.red('   This is likely a bug. Please report it.'));
  console.error(chalk.gray('   Promise:'), promise);
  console.error(chalk.gray('   Reason:'), reason);
  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
});

process.on('uncaughtException', async (error) => {
  try {
    if (isConnectionLikeError(error)) {
      const { getMCPLogger } = await import('../utils/logger.js');
      const logger = getMCPLogger();
      await logger.error(`[Process][uncaughtException][connection] ${error.message}`, false);
      const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
      if (verbose) {
        console.error(chalk.yellow('\n⚠️  Transient connection exception (continuing):'));
        console.error(chalk.gray('   Error:'), error.message);
      }
      return; // do not exit
    }
  } catch {
    // ignore and fall through
  }
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

// Always run main() when this file is executed as a CLI
// The shebang ensures this is only executed when run as a command
main().catch((error) => {
  console.error(chalk.red.bold('\n💥 Fatal Error'));
  console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));
  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
});
