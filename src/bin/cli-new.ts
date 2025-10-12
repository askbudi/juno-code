/**
 * CLI entry point for juno-task-ts using the new framework
 *
 * Comprehensive TypeScript CLI implementation with full functionality parity
 * to the Python budi-cli. Uses the new CLI framework for consistent command
 * registration, validation, and execution.
 */

import chalk from 'chalk';
import { defaultCLIFramework } from '../cli/framework.js';
import { createMainCommand } from '../cli/commands/main.js';
import { getEnvironmentOptions, printEnvironmentHelp } from '../cli/utils/environment.js';
import { generateCompletion, installCompletion } from '../cli/utils/completion.js';
import { isHeadlessEnvironment as isHeadless } from '../utils/environment.js';

// Import command configurations (these will need to be updated to use the new framework)
import { configureInitCommand } from '../cli/commands/init.js';
import { configureStartCommand } from '../cli/commands/start.js';
import { configureFeedbackCommand } from '../cli/commands/feedback.js';
import { configureSessionCommand } from '../cli/commands/session.js';
import { configureSetupGitCommand } from '../cli/commands/setup-git.js';

// Version information
const VERSION = '1.0.0';

/**
 * Setup completion commands
 */
function setupCompletionCommands(): void {
  // Hidden completion command for shell integration
  const completionCommand = {
    name: 'completion',
    description: 'Generate shell completion script',
    arguments: [
      {
        name: '<shell>',
        description: 'Shell type (bash, zsh, fish)',
        required: true,
        choices: ['bash', 'zsh', 'fish']
      }
    ],
    options: [],
    handler: async (args: string[]) => {
      try {
        const shell = args[0];
        const script = generateCompletion(shell as any, 'juno-task');
        console.log(script);
      } catch (error) {
        throw error;
      }
    }
  };

  // Install completion command
  const installCompletionCommand = {
    name: 'install-completion',
    description: 'Install shell completion',
    options: [
      {
        flags: '--shell <type>',
        description: 'Shell type (auto-detected if not specified)',
        choices: ['bash', 'zsh', 'fish']
      }
    ],
    handler: async (args: string[], options: any) => {
      try {
        await installCompletion(options.shell);
      } catch (error) {
        throw error;
      }
    }
  };

  // Hide these commands from help
  (completionCommand as any).hidden = true;
  (installCompletionCommand as any).hidden = true;

  defaultCLIFramework.registerCommand(completionCommand);
  defaultCLIFramework.registerCommand(installCompletionCommand);
}

/**
 * Setup subagent alias commands
 */
function setupSubagentAliases(): void {
  const subagents = ['claude', 'cursor', 'codex', 'gemini'];

  for (const subagent of subagents) {
    const aliasCommand = {
      name: subagent,
      description: `Execute with ${subagent} subagent`,
      arguments: [
        {
          name: '[prompt...]',
          description: 'Prompt text or file path'
        }
      ],
      options: [
        {
          flags: '-m, --max-iterations <number>',
          description: 'Maximum iterations',
          defaultValue: 1
        },
        {
          flags: '--model <name>',
          description: 'Model to use'
        },
        {
          flags: '--cwd <path>',
          description: 'Working directory',
          defaultValue: process.cwd()
        }
      ],
      handler: async (args: string[], options: any) => {
        // Import main command handler
        const { mainCommandHandler } = await import('../cli/commands/main.js');
        const promptText = Array.isArray(args[0]) ? args[0].join(' ') : args[0];

        await mainCommandHandler([], {
          ...options,
          subagent,
          prompt: promptText
        }, {} as any);
      }
    };

    // Hide from main help to keep it clean
    (aliasCommand as any).hidden = true;
    defaultCLIFramework.registerCommand(aliasCommand);
  }
}

/**
 * Setup environment variable help command
 */
function setupEnvironmentHelpCommand(): void {
  const envHelpCommand = {
    name: 'env-help',
    description: 'Show environment variable documentation',
    options: [],
    handler: async () => {
      printEnvironmentHelp();
    }
  };

  (envHelpCommand as any).hidden = true;
  defaultCLIFramework.registerCommand(envHelpCommand);
}

/**
 * Setup main execution command for when no subcommand is provided
 */
function setupDefaultBehavior(): void {
  // Add before execute hook to handle default behavior
  defaultCLIFramework.addBeforeExecuteHook(async (options: any) => {
    // Handle environment variable validation
    const envOptions = getEnvironmentOptions();

    // Show welcome message if no specific command and no prompt
    if (!options.subagent && !options.prompt && !options.interactive && process.argv.length === 2) {
      console.log(chalk.blue.bold('🎯 Juno Task - TypeScript CLI for AI Subagent Orchestration\\n'));
      console.log(chalk.white('To get started:'));
      console.log(chalk.gray('  juno-task init                    # Initialize new project'));
      console.log(chalk.gray('  juno-task start                   # Start execution'));
      console.log(chalk.gray('  juno-task claude "your prompt"    # Quick execution with Claude'));
      console.log(chalk.gray('  juno-task --help                  # Show all commands'));
      console.log('');
      process.exit(0);
    }
  });
}

/**
 * Create temporary command wrappers for existing commands
 * TODO: These should be updated to use the new framework properly
 */
function setupLegacyCommands(): void {
  // For now, create wrapper commands that delegate to the existing implementations
  const wrapperCommands = [
    { name: 'init', configFn: configureInitCommand },
    { name: 'start', configFn: configureStartCommand },
    { name: 'feedback', configFn: configureFeedbackCommand },
    { name: 'session', configFn: configureSessionCommand },
    { name: 'setup-git', configFn: configureSetupGitCommand }
  ];

  // Create a temporary commander program to get the command configurations
  const tempProgram = defaultCLIFramework.getProgram();

  for (const { configFn } of wrapperCommands) {
    try {
      configFn(tempProgram);
    } catch (error) {
      console.warn(`Warning: Failed to configure legacy command: ${error}`);
    }
  }
}

/**
 * Main CLI setup and execution
 */
async function main(): Promise<void> {
  try {
    // Configure the CLI framework
    defaultCLIFramework.configure({
      name: 'juno-task',
      description: 'TypeScript implementation of juno-task CLI tool for AI subagent orchestration',
      version: VERSION
    });

    // Register the main execution command
    defaultCLIFramework.registerCommand(createMainCommand());

    // Setup completion commands
    setupCompletionCommands();

    // Setup subagent aliases
    setupSubagentAliases();

    // Setup environment help
    setupEnvironmentHelpCommand();

    // Setup default behavior
    setupDefaultBehavior();

    // Setup legacy commands (temporary)
    setupLegacyCommands();

    // Add comprehensive help text
    defaultCLIFramework.addHelpText('beforeAll', `
${chalk.blue.bold('🎯 Juno Task')} - TypeScript CLI for AI Subagent Orchestration

`);

    defaultCLIFramework.addHelpText('afterAll', `
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

  Use 'juno-task env-help' for complete environment variable documentation

${chalk.blue.bold('Configuration:')}
  Configuration can be specified via:
  1. Command line arguments (highest priority)
  2. Environment variables
  3. Configuration files (.json, .toml, pyproject.toml)
  4. Built-in defaults (lowest priority)

${chalk.blue.bold('Shell Completion:')}
  juno-task install-completion     # Install for current shell
  juno-task completion bash        # Generate bash completion

${chalk.blue.bold('Support:')}
  Documentation: https://github.com/owner/juno-task-ts#readme
  Issues: https://github.com/owner/juno-task-ts/issues
  License: MIT

`);

    // Execute the CLI
    await defaultCLIFramework.execute(process.argv);

  } catch (error) {
    // Final error handler
    const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

    if (!process.argv.includes('--quiet') && !process.argv.includes('-q')) {
      console.error(chalk.red.bold('\\n💥 Fatal Error'));
      console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));

      if (verbose && error instanceof Error) {
        console.error(chalk.gray('\\n📍 Stack Trace:'));
        console.error(error.stack);
      }
    }

    process.exit(99);
  }
}

/**
 * Global error handlers
 */
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  const lower = msg.toLowerCase();
  const isConnectionLike = ['epipe', 'broken pipe', 'econnreset', 'socket hang up', 'err_socket_closed', 'connection reset by peer']
    .some(t => lower.includes(t));
  if (isConnectionLike) {
    import('../utils/logger.js').then(async ({ getMCPLogger }) => {
      try { await getMCPLogger().error(`[Process][unhandledRejection][connection] ${msg}`, false); } catch {}
    });
    const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
    if (verbose) {
      console.error(chalk.yellow('\\n⚠️  Transient connection issue (continuing):'));
      console.error(chalk.gray('   Reason:'), reason);
    }
    return; // do not exit
  }
  console.error(chalk.red.bold('\\n💥 Unhandled Promise Rejection'));
  console.error(chalk.red('   This is likely a bug. Please report it.'));
  console.error(chalk.gray('   Promise:'), promise);
  console.error(chalk.gray('   Reason:'), reason);
  process.exit(99);
});

process.on('uncaughtException', (error) => {
  const msg = `${error.name}: ${error.message}`;
  const lower = msg.toLowerCase();
  const isConnectionLike = ['epipe', 'broken pipe', 'econnreset', 'socket hang up', 'err_socket_closed', 'connection reset by peer']
    .some(t => lower.includes(t));
  if (isConnectionLike) {
    import('../utils/logger.js').then(async ({ getMCPLogger }) => {
      try { await getMCPLogger().error(`[Process][uncaughtException][connection] ${msg}`, false); } catch {}
    });
    const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
    if (verbose) {
      console.error(chalk.yellow('\\n⚠️  Transient connection exception (continuing):'));
      console.error(chalk.gray('   Error:'), error.message);
    }
    return; // do not exit
  }
  console.error(chalk.red.bold('\\n💥 Uncaught Exception'));
  console.error(chalk.red('   This is likely a bug. Please report it.'));
  console.error(chalk.gray('   Error:'), error.message);
  console.error(chalk.gray('   Stack:'), error.stack);
  process.exit(99);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log(chalk.yellow('\\n\\n⚠️  Execution cancelled by user'));
  process.exit(0);
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
  console.log(chalk.yellow('\\n\\n⚠️  Execution terminated'));
  process.exit(0);
});

// Run the CLI if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
