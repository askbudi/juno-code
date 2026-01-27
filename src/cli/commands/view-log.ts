/**
 * View-log command implementation for juno-code CLI
 *
 * Parses and displays log files produced by juno-code.
 * Extracts content between [thinking] and | metadata:, formats JSON content
 * with jq-style coloring, and displays non-JSON content as plain text.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

import type { GlobalCLIOptions } from '../types.js';

// ============================================================================
// Interfaces
// ============================================================================

export interface ViewLogCommandOptions extends GlobalCLIOptions {
  /** Show raw output without paging */
  raw?: boolean;
  /** Maximum number of lines to show (0 = all) */
  limit?: number;
  /** Filter by pattern (regex) */
  filter?: string;
  /** Show line numbers */
  lineNumbers?: boolean;
  /** Output format: json-only, text-only, or all (default) */
  output?: 'json-only' | 'text-only' | 'all';
}

// ============================================================================
// Log Parsing Functions
// ============================================================================

/**
 * Extract thinking content from a log line
 * Parses content between [thinking] and | metadata:
 */
function extractThinkingContent(line: string): string | null {
  // Match content after [thinking] and before | metadata:
  const match = line.match(/\[thinking\]\s*(.+?)(?:\s*\|\s*metadata:|$)/);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

/**
 * Check if a string is valid JSON
 */
function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format JSON with jq-style colorization
 */
function formatJsonWithColors(jsonStr: string): string {
  try {
    const parsed = JSON.parse(jsonStr);
    return formatValue(parsed, 0);
  } catch {
    return jsonStr;
  }
}

/**
 * Format a JSON value with colors and indentation
 */
function formatValue(value: unknown, indent: number): string {
  const indentStr = '  '.repeat(indent);
  const nextIndent = '  '.repeat(indent + 1);

  if (value === null) {
    return chalk.gray('null');
  }

  if (typeof value === 'boolean') {
    return chalk.yellow(String(value));
  }

  if (typeof value === 'number') {
    return chalk.cyan(String(value));
  }

  if (typeof value === 'string') {
    return chalk.green(`"${escapeJsonString(value)}"`);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const items = value.map(item => nextIndent + formatValue(item, indent + 1));
    return '[\n' + items.join(',\n') + '\n' + indentStr + ']';
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return '{}';
    }
    const items = entries.map(([key, val]) =>
      nextIndent + chalk.blue(`"${key}"`) + ': ' + formatValue(val, indent + 1)
    );
    return '{\n' + items.join(',\n') + '\n' + indentStr + '}';
  }

  return String(value);
}

/**
 * Escape special characters in JSON strings
 */
function escapeJsonString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Process a single log line and return formatted output
 */
function processLogLine(
  line: string,
  options: ViewLogCommandOptions
): string | null {
  const content = extractThinkingContent(line);

  if (content === null) {
    return null;
  }

  // Check if content is JSON
  const isJson = isValidJson(content);

  // Apply output filter
  if (options.output === 'json-only' && !isJson) {
    return null;
  }
  if (options.output === 'text-only' && isJson) {
    return null;
  }

  // Apply regex filter if specified
  if (options.filter) {
    try {
      const regex = new RegExp(options.filter, 'i');
      if (!regex.test(content)) {
        return null;
      }
    } catch {
      // Invalid regex, skip filtering
    }
  }

  // Format output
  if (isJson) {
    return formatJsonWithColors(content);
  }

  return content;
}

/**
 * Stream and process a log file
 */
async function streamLogFile(
  filePath: string,
  options: ViewLogCommandOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineNumber = 0;
    let outputCount = 0;
    const limit = options.limit || 0;

    rl.on('line', (line) => {
      lineNumber++;

      // Check limit
      if (limit > 0 && outputCount >= limit) {
        rl.close();
        stream.destroy();
        return;
      }

      const processed = processLogLine(line, options);
      if (processed !== null) {
        outputCount++;
        if (options.lineNumbers) {
          console.log(chalk.gray(`${lineNumber.toString().padStart(6)}:`) + ' ' + processed);
        } else {
          console.log(processed);
        }
      }
    });

    rl.on('close', () => resolve());
    rl.on('error', (err) => reject(err));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Pipe output through less for paging (if not raw mode)
 */
async function processWithPager(
  filePath: string,
  options: ViewLogCommandOptions
): Promise<void> {
  const { spawn } = await import('node:child_process');

  // Collect all processed lines
  const lines: string[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  const limit = options.limit || 0;

  return new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      lineNumber++;

      if (limit > 0 && lines.length >= limit) {
        return;
      }

      const processed = processLogLine(line, options);
      if (processed !== null) {
        if (options.lineNumbers) {
          lines.push(chalk.gray(`${lineNumber.toString().padStart(6)}:`) + ' ' + processed);
        } else {
          lines.push(processed);
        }
      }
    });

    rl.on('close', () => {
      if (lines.length === 0) {
        console.log(chalk.yellow('No matching log entries found.'));
        resolve();
        return;
      }

      // Try to use less with -R for color support
      const less = spawn('less', ['-R'], {
        stdio: ['pipe', 'inherit', 'inherit']
      });

      less.stdin.write(lines.join('\n'));
      less.stdin.end();

      less.on('close', () => resolve());
      less.on('error', () => {
        // If less is not available, just print to stdout
        console.log(lines.join('\n'));
        resolve();
      });
    });

    rl.on('error', (err) => reject(err));
    stream.on('error', (err) => reject(err));
  });
}

// ============================================================================
// Main Command Handler
// ============================================================================

/**
 * Main view-log command handler
 */
export async function viewLogCommandHandler(
  logFilePath: string,
  options: ViewLogCommandOptions,
  command: Command
): Promise<void> {
  try {
    // Validate file exists
    if (!await fs.pathExists(logFilePath)) {
      console.error(chalk.red.bold('\n Error: Log file not found'));
      console.error(chalk.red(`   Path: ${logFilePath}`));
      process.exit(1);
    }

    // Check if file is readable
    try {
      await fs.access(logFilePath, fs.constants.R_OK);
    } catch {
      console.error(chalk.red.bold('\n Error: Cannot read log file'));
      console.error(chalk.red(`   Path: ${logFilePath}`));
      process.exit(1);
    }

    // Get file stats for info
    const stats = await fs.stat(logFilePath);
    if (options.verbose) {
      console.error(chalk.gray(`File: ${logFilePath}`));
      console.error(chalk.gray(`Size: ${formatBytes(stats.size)}`));
      console.error(chalk.gray(`Modified: ${stats.mtime.toLocaleString()}`));
      console.error('');
    }

    // Process the log file
    if (options.raw || !process.stdout.isTTY) {
      // Raw mode or non-interactive - stream directly
      await streamLogFile(logFilePath, options);
    } else {
      // Interactive mode - use pager
      await processWithPager(logFilePath, options);
    }

  } catch (error) {
    console.error(chalk.red.bold('\n View Log Error'));
    console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));

    if (options.verbose && error instanceof Error) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(error.stack);
    }

    process.exit(99);
  }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================================================
// Command Configuration
// ============================================================================

/**
 * Configure the view-log command for Commander.js
 */
export function configureViewLogCommand(program: Command): void {
  program
    .command('view-log <logFilePath>')
    .description('View and parse juno-code log files with formatted output')
    .option('-r, --raw', 'Output without paging (no less)')
    .option('-l, --limit <number>', 'Maximum number of entries to show', parseInt)
    .option('-f, --filter <pattern>', 'Filter entries by regex pattern')
    .option('-n, --line-numbers', 'Show line numbers')
    .option('-o, --output <type>', 'Output type: json-only, text-only, or all', 'all')
    .action(async (logFilePath: string, options, command) => {
      await viewLogCommandHandler(logFilePath, options, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-code view-log log_file.log                    # View log with pager
  $ juno-code view-log log_file.log --raw              # Output without pager
  $ juno-code view-log log_file.log --limit 100        # Show first 100 entries
  $ juno-code view-log log_file.log --filter "error"   # Filter by pattern
  $ juno-code view-log log_file.log --output json-only # Show only JSON entries
  $ juno-code view-log log_file.log --line-numbers     # Show line numbers

Description:
  This command parses juno-code log files and extracts content between
  [thinking] and | metadata: markers. JSON content is formatted with
  jq-style colorization for easy reading.

  The command extracts the "thinking" content from log lines and:
  - Formats valid JSON with syntax highlighting
  - Displays non-JSON content as plain text
  - Supports filtering by regex patterns
  - Pipes output through 'less -R' for comfortable reading

Output Modes:
  all        Show all entries (default)
  json-only  Show only JSON-formatted entries
  text-only  Show only non-JSON text entries
    `);
}

export default viewLogCommandHandler;
