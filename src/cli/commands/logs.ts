/**
 * Logs command implementation for juno-code CLI
 *
 * Interactive log viewer with filtering, search, and real-time updates.
 * Provides access to structured logs with Python Rich-style aesthetics.
 */

import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import chalk from 'chalk';

import { loadConfig } from '../../core/config.js';
import { logger, LogLevel, LogContext, AdvancedLogger } from '../utils/advanced-logger.js';
import { LogViewer } from '../../tui/components/LogViewer.js';
import type { GlobalCLIOptions } from '../types.js';
import { ConfigurationError } from '../types.js';

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
// Log Export Functions
// ============================================================================

/**
 * Export logs to file
 */
async function exportLogs(
  logger: AdvancedLogger,
  filepath: string,
  options: LogsCommandOptions
): Promise<void> {
  try {
    const fs = await import('fs-extra');

    let entries = logger.getRecentEntries(options.tail || 1000);

    // Apply filters
    if (options.level) {
      const level = LogLevel[options.level.toUpperCase() as keyof typeof LogLevel];
      if (level !== undefined) {
        entries = entries.filter(entry => entry.level >= level);
      }
    }

    if (options.context) {
      const context = LogContext[options.context.toUpperCase() as keyof typeof LogContext];
      if (context) {
        entries = entries.filter(entry => entry.context === context);
      }
    }

    if (options.search) {
      const searchLower = options.search.toLowerCase();
      entries = entries.filter(entry =>
        entry.message.toLowerCase().includes(searchLower) ||
        (entry.data && JSON.stringify(entry.data).toLowerCase().includes(searchLower))
      );
    }

    // Format and export
    const exportData = {
      timestamp: new Date().toISOString(),
      total_entries: entries.length,
      filters: {
        level: options.level,
        context: options.context,
        search: options.search
      },
      entries: entries
    };

    await fs.writeFile(filepath, JSON.stringify(exportData, null, 2));
    console.log(chalk.green(`✅ Exported ${entries.length} log entries to: ${filepath}`));

  } catch (error) {
    console.error(chalk.red(`❌ Failed to export logs: ${error}`));
    process.exit(1);
  }
}

/**
 * Display log statistics
 */
function displayStats(logger: AdvancedLogger, options: LogsCommandOptions): void {
  let entries = logger.getRecentEntries(options.tail || 1000);

  // Apply filters
  if (options.level) {
    const level = LogLevel[options.level.toUpperCase() as keyof typeof LogLevel];
    if (level !== undefined) {
      entries = entries.filter(entry => entry.level >= level);
    }
  }

  if (options.context) {
    const context = LogContext[options.context.toUpperCase() as keyof typeof LogContext];
    if (context) {
      entries = entries.filter(entry => entry.context === context);
    }
  }

  // Calculate statistics
  const levelCounts = entries.reduce((acc, entry) => {
    const level = LogLevel[entry.level];
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const contextCounts = entries.reduce((acc, entry) => {
    acc[entry.context] = (acc[entry.context] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const timeRange = entries.length > 0 ? {
    start: entries[0].timestamp,
    end: entries[entries.length - 1].timestamp
  } : null;

  // Display statistics
  console.log(chalk.blue.bold('\n📊 Log Statistics'));
  console.log(chalk.gray('═'.repeat(50)));

  console.log(chalk.cyan(`Total Entries: ${entries.length}`));

  if (timeRange) {
    console.log(chalk.gray(`Time Range: ${timeRange.start.toLocaleString()} - ${timeRange.end.toLocaleString()}`));
  }

  console.log(chalk.yellow('\nLevel Distribution:'));
  Object.entries(levelCounts)
    .sort(([, a], [, b]) => b - a)
    .forEach(([level, count]) => {
      const percentage = ((count / entries.length) * 100).toFixed(1);
      const levelColor = getLevelDisplayColor(level);
      console.log(chalk.gray(`  ${level.padEnd(8)}: `) + chalk[levelColor](`${count.toString().padStart(4)} (${percentage}%)`));
    });

  console.log(chalk.yellow('\nContext Distribution:'));
  Object.entries(contextCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10) // Top 10 contexts
    .forEach(([context, count]) => {
      const percentage = ((count / entries.length) * 100).toFixed(1);
      console.log(chalk.gray(`  ${context.padEnd(12)}: `) + chalk.cyan(`${count.toString().padStart(4)} (${percentage}%)`));
    });

  console.log();
}

/**
 * Display logs in console format
 */
function displayLogs(logger: AdvancedLogger, options: LogsCommandOptions): void {
  let entries = logger.getRecentEntries(options.tail || 50);

  // Apply filters
  if (options.level) {
    const level = LogLevel[options.level.toUpperCase() as keyof typeof LogLevel];
    if (level !== undefined) {
      entries = entries.filter(entry => entry.level >= level);
    }
  }

  if (options.context) {
    const context = LogContext[options.context.toUpperCase() as keyof typeof LogContext];
    if (context) {
      entries = entries.filter(entry => entry.context === context);
    }
  }

  if (options.search) {
    const searchLower = options.search.toLowerCase();
    entries = entries.filter(entry =>
      entry.message.toLowerCase().includes(searchLower) ||
      (entry.data && JSON.stringify(entry.data).toLowerCase().includes(searchLower))
    );
  }

  // Set logger format
  const originalFormat = options.format || 'detailed';
  logger.setFormat(originalFormat as any);

  if (entries.length === 0) {
    console.log(chalk.gray('No log entries match the specified criteria'));
    return;
  }

  // Display entries
  console.log(chalk.blue.bold(`\n📋 Recent Logs (${entries.length} entries)`));
  console.log(chalk.gray('═'.repeat(80)));

  entries.forEach(entry => {
    const formatted = formatLogEntry(entry, options.format || 'detailed');
    console.log(formatted);
  });
}

/**
 * Format a single log entry for console display
 */
function formatLogEntry(entry: any, format: string): string {
  const timestamp = entry.timestamp.toLocaleTimeString();
  const level = LogLevel[entry.level];
  const levelColor = getLevelDisplayColor(level);
  const icon = getLevelIcon(entry.level);

  switch (format) {
    case 'simple':
      return `${chalk.gray(timestamp)} ${chalk[levelColor](icon)} ${entry.message}`;

    case 'json':
      return JSON.stringify(entry);

    case 'rich':
      return `${chalk.gray('│')} ${chalk.gray(timestamp)} ${chalk[levelColor](icon)} ${chalk.cyan(`[${entry.context}]`)} ${entry.message}${entry.duration ? chalk.yellow(` (${entry.duration}ms)`) : ''}`;

    case 'detailed':
    default:
      let result = `${chalk.gray(timestamp)} ${chalk[levelColor](`[${level}]`)} ${chalk.cyan(`[${entry.context}]`)} ${entry.message}`;

      if (entry.duration) {
        result += chalk.yellow(` (${entry.duration}ms)`);
      }

      if (entry.data) {
        const dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
        result += '\n' + chalk.gray('  ↳ ') + chalk.gray(dataStr);
      }

      return result;
  }
}

/**
 * Get display color for log level
 */
function getLevelDisplayColor(level: string): 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'redBright' {
  switch (level) {
    case 'TRACE': return 'gray';
    case 'DEBUG': return 'blue';
    case 'INFO': return 'green';
    case 'WARN': return 'yellow';
    case 'ERROR': return 'red';
    case 'FATAL': return 'redBright';
    default: return 'gray';
  }
}

/**
 * Get icon for log level
 */
function getLevelIcon(level: LogLevel): string {
  switch (level) {
    case LogLevel.TRACE: return '🔍';
    case LogLevel.DEBUG: return '🐛';
    case LogLevel.INFO: return 'ℹ️';
    case LogLevel.WARN: return '⚠️';
    case LogLevel.ERROR: return '❌';
    case LogLevel.FATAL: return '💀';
    default: return '📝';
  }
}

// ============================================================================
// Main Command Handler
// ============================================================================

/**
 * Main logs command handler
 */
export async function logsCommandHandler(
  args: any,
  options: LogsCommandOptions,
  command: Command
): Promise<void> {
  try {
    // Load configuration for logging setup
    const config = await loadConfig({
      baseDir: process.cwd(),
      configFile: options.config,
      cliConfig: {
        verbose: options.verbose || false,
        quiet: options.quiet || false,
        logLevel: options.logLevel || 'info',
        workingDirectory: process.cwd()
      }
    });

    // Export logs if requested
    if (options.export) {
      await exportLogs(logger, options.export, options);
      return;
    }

    // Show statistics if requested
    if (options.stats) {
      displayStats(logger, options);
      return;
    }

    // Interactive viewer
    if (options.interactive) {
      await new Promise<void>((resolve) => {
        const { unmount } = render(
          React.createElement(LogViewer, {
            logger,
            maxEntries: options.tail || 1000,
            refreshInterval: options.follow ? 1000 : 0,
            interactive: true,
            autoScroll: options.follow,
            onClose: () => {
              unmount();
              resolve();
            }
          })
        );
      });
    } else {
      // Console display
      displayLogs(logger, options);

      // Follow mode for console
      if (options.follow) {
        console.log(chalk.yellow('\nFollowing logs... Press Ctrl+C to stop'));

        setInterval(() => {
          const newEntries = logger.getRecentEntries(10);
          if (newEntries.length > 0) {
            newEntries.forEach(entry => {
              const formatted = formatLogEntry(entry, options.format || 'detailed');
              console.log(formatted);
            });
          }
        }, 1000);
      }
    }

  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(chalk.red.bold('\n❌ Configuration Error'));
      console.error(chalk.red(`   ${error.message}`));
      process.exit(2);
    }

    console.error(chalk.red.bold('\n❌ Logs Command Error'));
    console.error(chalk.red(`   ${error}`));

    if (options.verbose) {
      console.error(error);
    }

    process.exit(99);
  }
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
    .option('-i, --interactive', 'Launch interactive log viewer')
    .option('-l, --level <level>', 'Filter by log level (trace, debug, info, warn, error, fatal)')
    .option('-c, --context <context>', 'Filter by context (cli, mcp, engine, session, template, config, performance, system)')
    .option('-s, --search <term>', 'Search in log messages and data')
    .option('-t, --tail <number>', 'Number of recent entries to show', parseInt)
    .option('-f, --follow', 'Follow logs in real-time')
    .option('-e, --export <file>', 'Export logs to JSON file')
    .option('--stats', 'Show log statistics only')
    .option('--format <format>', 'Output format (simple, detailed, json, rich)', 'detailed')
    .action(async (options, command) => {
      await logsCommandHandler([], options, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-code logs                                    # Show recent logs
  $ juno-code logs --interactive                      # Interactive log viewer
  $ juno-code logs --level error                      # Show only errors
  $ juno-code logs --context mcp                      # Show only MCP logs
  $ juno-code logs --search "connection"              # Search for connection logs
  $ juno-code logs --tail 100                         # Show last 100 entries
  $ juno-code logs --follow                           # Follow logs in real-time
  $ juno-code logs --export logs.json                 # Export logs to file
  $ juno-code logs --stats                            # Show statistics only
  $ juno-code logs --format json                      # JSON output format

Interactive Viewer:
  ↑↓ or j/k       Navigate entries
  1-6             Filter by log level
  c               Cycle through contexts
  s               Search (not yet implemented)
  d               Toggle details view
  f               Toggle filters panel
  g               Toggle statistics panel
  h or ?          Show help
  q or Esc        Quit

Log Levels:
  1. TRACE        Very detailed debugging information
  2. DEBUG        Debug information
  3. INFO         General information messages
  4. WARN         Warning messages
  5. ERROR        Error messages
  6. FATAL        Critical error messages

Contexts:
  CLI             Command-line interface operations
  MCP             Model Context Protocol operations
  ENGINE          Execution engine operations
  SESSION         Session management operations
  TEMPLATE        Template processing operations
  CONFIG          Configuration operations
  PERFORMANCE     Performance monitoring
  SYSTEM          System-level operations

Notes:
  - Logs are stored in memory with configurable retention
  - Interactive viewer provides real-time filtering and search
  - Export format includes metadata and filtering information
  - Follow mode updates every second with new entries
    `);
}

export default logsCommandHandler;