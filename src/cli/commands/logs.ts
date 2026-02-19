/**
 * Logs command implementation for juno-code CLI
 *
 * The logger writes to stderr in real-time and does not store entries in memory.
 * This command informs users how to capture logs via stderr redirection.
 */

import { Command } from 'commander';
import chalk from 'chalk';

import type { GlobalCLIOptions } from '../types.js';

// ============================================================================
// Interfaces
// ============================================================================

export interface LogsCommandOptions extends GlobalCLIOptions {
  /** Show logs in interactive viewer */
  interactive?: boolean;
  /** Log level filter */
  level?: string;
  /** Context filter */
  context?: string;
  /** Search term */
  search?: string;
  /** Number of entries to show */
  tail?: number;
  /** Follow logs in real-time */
  follow?: boolean;
  /** Export logs to file */
  export?: string;
  /** Show statistics only */
  stats?: boolean;
  /** Format output */
  format?: 'simple' | 'detailed' | 'json' | 'rich';
}

// ============================================================================
// Main Command Handler
// ============================================================================

/**
 * Main logs command handler
 */
export async function logsCommandHandler(
  _args: any,
  _options: LogsCommandOptions,
  _command: Command,
): Promise<void> {
  console.log(
    chalk.yellow(
      '\nLog history is not available - the logger writes to stderr in real-time and does not store entries in memory.',
    ),
  );
  console.log(chalk.gray('Redirect stderr to a file to capture logs: juno-code start 2> logs.txt'));
}

// ============================================================================
// Command Configuration
// ============================================================================

/**
 * Configure the logs command for Commander.js
 */
export function configureLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('View and manage application logs')
    .option('-l, --level <level>', 'Filter by log level (trace, debug, info, warn, error, fatal)')
    .option('-t, --tail <number>', 'Number of recent entries to show', parseInt)
    .action(async (options, command) => {
      await logsCommandHandler([], options, command);
    })
    .addHelpText(
      'after',
      `
Notes:
  - The logger writes to stderr in real-time
  - Redirect stderr to capture logs: juno-code start 2> logs.txt
    `,
    );
}

export default logsCommandHandler;
