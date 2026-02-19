/**
 * Session command implementation for juno-code CLI
 *
 * Provides comprehensive session management including list, info, remove, and clean
 * operations with detailed statistics, filtering, and cleanup capabilities.
 */

import chalk from 'chalk';
import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import { createSessionManager } from '../../core/session.js';
import type {
  SessionListOptions,
  SessionInfoOptions,
  SessionRemoveOptions,
  SessionCleanOptions,
} from '../types.js';
import { RuntimeError, ConfigurationError } from '../types.js';
import type {
  SessionManager,
  SessionInfo,
  Session,
  SessionListFilter,
  CleanupOptions,
} from '../../core/session.js';
import type { SessionStatus } from '../../types/index.js';

/**
 * Session display formatter for consistent output
 */
class SessionDisplayFormatter {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  formatSessionList(sessions: SessionInfo[]): void {
    if (sessions.length === 0) {
      console.log(chalk.yellow('No sessions found.'));
      return;
    }

    console.log(chalk.blue.bold(`\n📊 Sessions (${sessions.length} total)\n`));

    // Group by status
    const grouped = this.groupByStatus(sessions);

    for (const [status, sessionList] of Object.entries(grouped)) {
      if (sessionList.length === 0) continue;

      const statusColor = this.getStatusColor(status as SessionStatus);
      const statusIcon = this.getStatusIcon(status as SessionStatus);

      console.log(
        statusColor.bold(`${statusIcon} ${status.toUpperCase()} (${sessionList.length})`),
      );

      for (const session of sessionList) {
        this.formatSessionSummary(session);
      }

      console.log('');
    }
  }

  formatSessionInfo(session: Session): void {
    const { info, context, statistics, history } = session;

    console.log(chalk.blue.bold(`\n📋 Session Details: ${info.id}\n`));

    // Basic information
    console.log(chalk.white.bold('Basic Information:'));
    console.log(`   ID: ${chalk.cyan(info.id)}`);
    if (info.name) {
      console.log(`   Name: ${chalk.white(info.name)}`);
    }
    console.log(`   Status: ${this.getStatusDisplay(info.status)}`);
    console.log(`   Subagent: ${chalk.magenta(info.subagent)}`);
    console.log(`   Created: ${chalk.gray(info.createdAt.toLocaleString())}`);
    console.log(`   Updated: ${chalk.gray(info.updatedAt.toLocaleString())}`);
    if (info.completedAt) {
      console.log(`   Completed: ${chalk.gray(info.completedAt.toLocaleString())}`);
    }

    // Context information
    console.log(chalk.white.bold('\nContext:'));
    console.log(`   Working Directory: ${chalk.cyan(context.workingDirectory)}`);

    // Statistics
    console.log(chalk.white.bold('\nStatistics:'));
    console.log(`   Duration: ${this.formatDuration(statistics.duration)}`);
    console.log(`   Iterations: ${chalk.cyan(statistics.iterations)}`);
    console.log(`   Tool Calls: ${chalk.cyan(statistics.toolCalls)}`);
    console.log(`   Errors: ${chalk.red(statistics.errorCount)}`);

    // Tags
    if (info.tags.length > 0) {
      console.log(chalk.white.bold('\nTags:'));
      console.log(`   ${info.tags.map((tag) => chalk.cyan(`#${tag}`)).join(' ')}`);
    }

    // Recent history
    if (history.length > 0) {
      console.log(chalk.white.bold('\nRecent History:'));
      const recentEntries = history.slice(-5);
      recentEntries.forEach((entry) => {
        const time = entry.timestamp.toLocaleTimeString();
        const typeColor = this.getHistoryTypeColor(entry.type);
        console.log(
          `   ${chalk.gray(time)} ${typeColor(entry.type)}: ${entry.content.substring(0, 80)}${entry.content.length > 80 ? '...' : ''}`,
        );
      });

      if (history.length > 5) {
        console.log(chalk.gray(`   ... and ${history.length - 5} more entries`));
      }
    }

    // Result
    if (session.result) {
      console.log(chalk.white.bold('\nResult:'));
      console.log(`   Success: ${session.result.success ? chalk.green('Yes') : chalk.red('No')}`);
      if (session.result.error) {
        console.log(`   Error: ${chalk.red(session.result.error)}`);
      }
      if (session.result.output) {
        console.log(
          `   Output: ${session.result.output.substring(0, 200)}${session.result.output.length > 200 ? '...' : ''}`,
        );
      }
    }
  }

  formatSessionSummary(session: SessionInfo): void {
    const ageText = this.getAgeText(session.updatedAt);
    const durationText = session.completedAt
      ? this.formatDuration(session.completedAt.getTime() - session.createdAt.getTime())
      : this.formatDuration(Date.now() - session.createdAt.getTime());

    console.log(
      `   ${chalk.cyan(session.id.substring(0, 8))} ${chalk.white(session.name || 'Unnamed')} ${chalk.gray(ageText)} ${chalk.magenta(session.subagent)} ${chalk.gray(durationText)}`,
    );

    if (session.tags.length > 0 && this.verbose) {
      console.log(`     Tags: ${session.tags.map((tag) => chalk.cyan(`#${tag}`)).join(' ')}`);
    }
  }

  private groupByStatus(sessions: SessionInfo[]): Record<SessionStatus, SessionInfo[]> {
    const groups: Record<SessionStatus, SessionInfo[]> = {
      running: [],
      completed: [],
      failed: [],
      cancelled: [],
    };

    sessions.forEach((session) => {
      groups[session.status].push(session);
    });

    return groups;
  }

  private getStatusColor(status: SessionStatus): typeof chalk.green {
    switch (status) {
      case 'running':
        return chalk.blue;
      case 'completed':
        return chalk.green;
      case 'failed':
        return chalk.red;
      case 'cancelled':
        return chalk.yellow;
      default:
        return chalk.gray;
    }
  }

  private getStatusIcon(status: SessionStatus): string {
    switch (status) {
      case 'running':
        return '🔄';
      case 'completed':
        return '✅';
      case 'failed':
        return '❌';
      case 'cancelled':
        return '⚠️';
      default:
        return '❓';
    }
  }

  private getStatusDisplay(status: SessionStatus): string {
    const color = this.getStatusColor(status);
    const icon = this.getStatusIcon(status);
    return `${icon} ${color(status)}`;
  }

  private getHistoryTypeColor(type: string): typeof chalk.green {
    switch (type) {
      case 'prompt':
        return chalk.blue;
      case 'response':
        return chalk.green;
      case 'tool_call':
        return chalk.magenta;
      case 'error':
        return chalk.red;
      case 'system':
        return chalk.gray;
      default:
        return chalk.white;
    }
  }

  private getAgeText(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ago`;
    } else if (hours > 0) {
      return `${hours}h ago`;
    } else if (minutes > 0) {
      return `${minutes}m ago`;
    } else {
      return 'just now';
    }
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

/**
 * Session list command handler
 */
async function handleSessionList(
  _args: string[],
  options: SessionListOptions,
  sessionManager: SessionManager,
): Promise<void> {
  const filter: SessionListFilter = {};

  // Apply filters
  if (options.subagent) {
    filter.subagent = [options.subagent];
  }

  if (options.status) {
    filter.status = options.status;
  }

  if (options.limit) {
    filter.limit = options.limit;
  }

  // Default sort by update time, newest first
  filter.sortBy = 'updatedAt';
  filter.sortOrder = 'desc';

  const sessions = await sessionManager.listSessions(filter);
  const formatter = new SessionDisplayFormatter(options.verbose);
  formatter.formatSessionList(sessions);
}

/**
 * Session info command handler
 */
async function handleSessionInfo(
  args: string[],
  options: SessionInfoOptions,
  sessionManager: SessionManager,
): Promise<void> {
  const sessionId = args[0];

  if (!sessionId) {
    console.log(chalk.red('Session ID is required'));
    console.log(chalk.gray('Usage: juno-code session info <session-id>'));
    console.log(chalk.gray('Use "juno-code session list" to see available sessions'));
    return;
  }

  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    console.log(chalk.red(`Session not found: ${sessionId}`));
    console.log(chalk.gray('Use "juno-code session list" to see available sessions'));
    return;
  }

  const formatter = new SessionDisplayFormatter(options.verbose);
  formatter.formatSessionInfo(session);
}

/**
 * Session remove command handler
 */
async function handleSessionRemove(
  args: string[],
  options: SessionRemoveOptions,
  sessionManager: SessionManager,
): Promise<void> {
  const sessionIds = args;

  if (sessionIds.length === 0) {
    console.log(chalk.red('At least one session ID is required'));
    console.log(chalk.gray('Usage: juno-code session remove <session-id> [session-id...]'));
    process.exit(1);
  }

  let successCount = 0;
  let errorCount = 0;

  for (const sessionId of sessionIds) {
    try {
      const session = await sessionManager.getSession(sessionId);

      if (!session) {
        console.log(chalk.red(`❌ Session not found: ${sessionId}`));
        errorCount++;
        continue;
      }

      if (!options.force) {
        // In real implementation, would prompt for confirmation
        console.log(
          chalk.yellow(`Would remove session: ${sessionId} (${session.info.name || 'Unnamed'})`),
        );
        console.log(chalk.gray('Use --force to skip confirmation'));
        continue;
      }

      await sessionManager.removeSession(sessionId);
      console.log(chalk.green(`✅ Removed session: ${sessionId}`));
      successCount++;
    } catch (error) {
      console.log(chalk.red(`❌ Failed to remove session ${sessionId}: ${error}`));
      errorCount++;
    }
  }

  console.log(chalk.blue(`\n📊 Removal Summary: ${successCount} removed, ${errorCount} errors`));
}

/**
 * Session clean command handler
 */
async function handleSessionClean(
  _args: string[],
  options: SessionCleanOptions,
  sessionManager: SessionManager,
): Promise<void> {
  const cleanupOptions: CleanupOptions = {
    dryRun: !options.force,
  };

  if (options.days) {
    cleanupOptions.removeOlderThanDays = options.days;
  }

  if (options.empty) {
    cleanupOptions.removeEmpty = true;
  }

  // Set default cleanup criteria if none specified
  if (!options.days && !options.empty) {
    cleanupOptions.removeOlderThanDays = 30; // Default: remove sessions older than 30 days
    cleanupOptions.removeStatus = ['completed', 'failed', 'cancelled'];
  }

  if (cleanupOptions.dryRun) {
    console.log(chalk.yellow('🔍 Dry run mode - no sessions will be actually removed'));
    console.log(chalk.gray('Use --force to perform actual cleanup'));
  }

  console.log(chalk.blue('🧹 Cleaning up sessions...'));

  await sessionManager.cleanupSessions(cleanupOptions);

  if (cleanupOptions.dryRun) {
    console.log(chalk.green('✅ Cleanup preview complete'));
    console.log(chalk.gray('Run with --force to perform actual cleanup'));
  } else {
    console.log(chalk.green('✅ Session cleanup complete'));
  }
}

/**
 * Main session command handler
 */
export async function sessionCommandHandler(
  args: string[],
  options: any,
  _command: Command,
): Promise<void> {
  try {
    const subcommand = args[0];

    if (!subcommand) {
      // No subcommand - default to list
      args.unshift('list');
    }

    // Load configuration
    const config = await loadConfig({
      baseDir: process.cwd(),
      configFile: options.config,
      cliConfig: {
        verbose: options.verbose || false,
        quiet: options.quiet || false,
        logLevel: options.logLevel || 'info',
      },
    });

    // Create session manager
    const sessionManager = await createSessionManager(config);

    // Route to appropriate handler
    switch (args[0]) {
      case 'list':
      case 'ls':
        await handleSessionList(args.slice(1), options, sessionManager);
        break;

      case 'info':
      case 'show':
        await handleSessionInfo(args.slice(1), options, sessionManager);
        break;

      case 'remove':
      case 'rm':
      case 'delete':
        await handleSessionRemove(args.slice(1), options, sessionManager);
        break;

      case 'clean':
      case 'cleanup':
        await handleSessionClean(args.slice(1), options, sessionManager);
        break;

      default:
        console.log(chalk.red(`Unknown session subcommand: ${args[0]}`));
        console.log(chalk.gray('Available subcommands: list, info, remove, clean'));
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof RuntimeError) {
      console.error(chalk.red.bold('\n❌ Session Error'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach((suggestion) => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(6);
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
 * Configure the session command for Commander.js
 */
export function configureSessionCommand(program: Command): void {
  const sessionCommand = program
    .command('session')
    .description('Manage execution sessions')
    .argument('[subcommand]', 'Session operation (list, info, remove, clean)', 'list')
    .argument('[args...]', 'Subcommand arguments')
    .option('-l, --limit <number>', 'Maximum sessions to show', parseInt)
    .option('-s, --subagent <name>', 'Filter by subagent')
    .option('--status <status...>', 'Filter by status (running, completed, failed, cancelled)')
    .option('-f, --force', 'Skip confirmation prompts')
    .option('-d, --days <number>', 'Remove sessions older than N days', parseInt)
    .option('-e, --empty', 'Remove only empty sessions')
    .action(async (subcommand, args, options, command) => {
      const allArgs = [subcommand, ...args];
      await sessionCommandHandler(allArgs, options, command);
    });

  // Add help text
  sessionCommand.addHelpText(
    'after',
    `
Subcommands:
  list, ls                    List all sessions (default)
  info <id>, show <id>        Show detailed session information
  remove <id...>, rm <id...>  Remove one or more sessions
  clean, cleanup              Clean up old/empty sessions

Examples:
  $ juno-code session                                 # List all sessions
  $ juno-code session list --limit 10                # Show 10 most recent
  $ juno-code session list --subagent claude         # Filter by subagent
  $ juno-code session list --status completed failed # Filter by status
  $ juno-code session info abc123                    # Show session details
  $ juno-code session remove abc123 def456           # Remove sessions
  $ juno-code session remove abc123 --force          # Skip confirmation
  $ juno-code session clean --days 30                # Remove sessions >30 days
  $ juno-code session clean --empty --force          # Remove empty sessions

Environment Variables:
  JUNO_TASK_SESSION_DIR      Session storage directory

Notes:
  - Session IDs can be abbreviated (first 8 characters usually sufficient)
  - Use --verbose for detailed information
  - Clean operations show preview unless --force is used
  - Sessions are automatically cleaned up based on age and status
    `,
  );
}
