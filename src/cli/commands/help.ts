/**
 * Help command implementation for yylo CLI
 *
 * Enhanced help system with interactive tutorials, contextual assistance,
 * and comprehensive documentation access.
 */

import { Command } from 'commander';
import chalk from 'chalk';

import { RichFormatter } from '../utils/rich-formatter.js';
import { cliLogger } from '../utils/advanced-logger.js';
import type { GlobalCLIOptions } from '../types.js';

// ============================================================================
// Interfaces
// ============================================================================

export interface HelpCommandOptions extends GlobalCLIOptions {
  /** Launch interactive help system */
  interactive?: boolean;
  /** Show specific topic */
  topic?: string;
  /** Search for help topics */
  search?: string;
  /** List all available topics */
  list?: boolean;
  /** Show getting started guide */
  quickstart?: boolean;
  /** Show troubleshooting guide */
  troubleshooting?: boolean;
  /** Output format */
  format?: 'console' | 'markdown' | 'json';
}

// ============================================================================
// Help Content Definitions
// ============================================================================

interface QuickReference {
  category: string;
  commands: Array<{
    name: string;
    description: string;
    usage: string;
  }>;
}

const QUICK_REFERENCE: QuickReference[] = [
  {
    category: 'Essential Commands',
    commands: [
      {
        name: 'init',
        description: 'Initialize new project',
        usage: 'yylo init [--interactive]',
      },
      {
        name: 'start',
        description: 'Execute task',
        usage: 'yylo start [--max-iterations N]',
      },
      {
        name: 'logs',
        description: 'View application logs',
        usage: 'yylo logs [--interactive]',
      },
      {
        name: 'session',
        description: 'Manage execution sessions',
        usage: 'yylo session <list|info|remove>',
      },
      {
        name: 'ledger',
        description: 'Manage tasks with YYLO Ledger',
        usage: 'yy ledger <list|create|get|update|mark>',
      },
    ],
  },
  {
    category: 'Subagent Shortcuts',
    commands: [
      {
        name: 'claude',
        description: 'Execute with Claude subagent',
        usage: 'yylo claude "task description"',
      },
      {
        name: 'cursor',
        description: 'Execute with Cursor subagent',
        usage: 'yylo cursor "task description"',
      },
      {
        name: 'codex',
        description: 'Execute with Codex subagent',
        usage: 'yylo codex "task description"',
      },
      {
        name: 'gemini',
        description: 'Execute with Gemini subagent',
        usage: 'yylo gemini "task description"',
      },
    ],
  },
  {
    category: 'Utility Commands',
    commands: [
      {
        name: 'feedback',
        description: 'Collect user feedback',
        usage: 'yylo feedback [--interactive]',
      },
      {
        name: 'setup-git',
        description: 'Initialize Git repository',
        usage: 'yylo setup-git <repository-url>',
      },
      {
        name: 'completion',
        description: 'Shell completion setup',
        usage: 'yylo completion <install|uninstall>',
      },
      {
        name: 'services',
        description: 'Manage service scripts (use --force to refresh codex.py/claude.py)',
        usage: 'yylo services install --force',
      },
      {
        name: 'help',
        description: 'Show help information',
        usage: 'yylo help [--interactive]',
      },
    ],
  },
];

const TROUBLESHOOTING_GUIDE = `# Troubleshooting Guide

## Common Issues and Solutions

### 📁 File System Issues

**Issue**: "init.md not found"
**Cause**: No project initialized in current directory
**Solution**: Run \`yylo init\` to create project structure

**Issue**: "Permission denied"
**Cause**: Insufficient file permissions
**Solution**: Check directory permissions or run with appropriate user

### ⚡ Performance Issues

**Issue**: Slow execution or timeouts
**Causes & Solutions**:
- Large codebase: Add patterns to .gitignore
- Complex tasks: Break into smaller, focused tasks
- Server overload: Reduce max iterations

### 🔧 Configuration Problems

**Issue**: "Configuration file not found"
**Solution**: Create config file or use environment variables

**Issue**: "Invalid configuration"
**Solution**: Validate JSON/TOML syntax and required fields

## Debug Information

Get detailed debug information:
\`\`\`bash
# Verbose execution with debug logging
yylo start --verbose --log-level debug

# View recent error logs
yylo logs --level error --tail 50

# Export logs for analysis
yylo logs --export debug.json --level debug
\`\`\`

## Getting More Help

1. **Interactive Help**: \`yylo help --interactive\`
2. **View Logs**: \`yylo logs --interactive\`
3. **Check Configuration**: Review .juno_task/config.json
4. **Report Issues**: Include debug logs when reporting problems

## Environment Variables

Useful for debugging:
\`\`\`bash
export YYLO_VERBOSE=true
export YYLO_LOG_LEVEL=debug
export NO_COLOR=true  # Disable colors for log analysis
\`\`\`
`;

// ============================================================================
// Help Display Functions
// ============================================================================

/**
 * Display quick reference guide
 */
function displayQuickReference(formatter: RichFormatter): void {
  console.log(
    formatter.panel(
      'Welcome to yylo! This quick reference shows the most commonly used commands.',
      {
        title: '🚀 yylo Quick Reference',
        border: 'rounded',
        style: 'success',
        padding: 1,
      },
    ),
  );

  QUICK_REFERENCE.forEach((section) => {
    console.log(chalk.yellow.bold(`\n📂 ${section.category}`));
    console.log(chalk.gray('─'.repeat(60)));

    section.commands.forEach((cmd) => {
      console.log(chalk.cyan(`  ${cmd.name.padEnd(12)}`), cmd.description);
      console.log(chalk.gray(`  ${' '.repeat(12)} ${cmd.usage}`));
      console.log();
    });
  });

  console.log(
    formatter.panel(
      `Use ${chalk.cyan('yylo help --interactive')} for comprehensive help with search and tutorials.\nUse ${chalk.cyan('yylo <command> --help')} for detailed command information.`,
      {
        title: '💡 Next Steps',
        border: 'rounded',
        style: 'info',
        padding: 1,
      },
    ),
  );
}

/**
 * Display troubleshooting guide
 */
function displayTroubleshooting(formatter: RichFormatter): void {
  console.log(
    formatter.panel(TROUBLESHOOTING_GUIDE, {
      title: '🔧 Troubleshooting Guide',
      border: 'rounded',
      style: 'warning',
      padding: 1,
    }),
  );
}

/**
 * List all available help topics
 */
function listHelpTopics(): void {
  const topics = [
    { id: 'quickstart', title: 'Quick Start Guide', difficulty: 'beginner' },
    { id: 'commands-init', title: 'Init Command', difficulty: 'beginner' },
    { id: 'commands-start', title: 'Start Command', difficulty: 'beginner' },
    { id: 'commands-logs', title: 'Logs Command', difficulty: 'intermediate' },
    { id: 'configuration', title: 'Configuration Guide', difficulty: 'intermediate' },
    { id: 'sessions', title: 'Session Management', difficulty: 'intermediate' },
    { id: 'services', title: 'Service Scripts', difficulty: 'advanced' },
    { id: 'troubleshooting', title: 'Troubleshooting Guide', difficulty: 'intermediate' },
  ];

  console.log(chalk.blue.bold('\n📖 Available Help Topics'));
  console.log(chalk.gray('═'.repeat(60)));

  const getDifficultyIcon = (difficulty: string) => {
    switch (difficulty) {
      case 'beginner':
        return '🟢';
      case 'intermediate':
        return '🟡';
      case 'advanced':
        return '🔴';
      default:
        return '⚪';
    }
  };

  topics.forEach((topic) => {
    const icon = getDifficultyIcon(topic.difficulty);
    console.log(`${icon} ${chalk.cyan(topic.id.padEnd(20))} ${topic.title}`);
  });

  console.log(
    chalk.yellow(`\nUse ${chalk.cyan('yylo help --topic <id>')} to view a specific topic`),
  );
  console.log(
    chalk.yellow(`Use ${chalk.cyan('yylo help --interactive')} for full interactive help`),
  );
}

/**
 * Search help topics
 */
function searchHelpTopics(searchTerm: string): void {
  // Mock search functionality - in real implementation would search through help content
  const matchingTopics = ['quickstart', 'commands-init', 'configuration'].filter((id) =>
    id.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  console.log(chalk.blue.bold(`\n🔍 Search Results for "${searchTerm}"`));
  console.log(chalk.gray('═'.repeat(60)));

  if (matchingTopics.length === 0) {
    console.log(chalk.gray('No topics found matching your search.'));
    console.log(chalk.yellow('Try different keywords or use --list to see all topics.'));
    return;
  }

  matchingTopics.forEach((topicId) => {
    console.log(chalk.cyan(`• ${topicId}`));
  });

  console.log(chalk.yellow(`\nUse ${chalk.cyan('yylo help --topic <id>')} to view details`));
}

// ============================================================================
// Main Command Handler
// ============================================================================

/**
 * Main help command handler
 */
export async function helpCommandHandler(
  _args: any,
  options: HelpCommandOptions,
  _command: Command,
): Promise<void> {
  try {
    const formatter = new RichFormatter();

    cliLogger.info('Help command accessed', { options });

    // Interactive help (TUI removed, display all help topics)
    if (options.interactive) {
      displayQuickReference(formatter);
      listHelpTopics();
      displayTroubleshooting(formatter);
      return;
    }

    // Troubleshooting guide
    if (options.troubleshooting) {
      displayTroubleshooting(formatter);
      return;
    }

    // List all topics
    if (options.list) {
      listHelpTopics();
      return;
    }

    // Search topics
    if (options.search) {
      searchHelpTopics(options.search);
      return;
    }

    // Specific topic
    if (options.topic) {
      console.log(
        chalk.yellow(`Topic-specific help for "${options.topic}" would be displayed here.`),
      );
      console.log(chalk.gray('Use --interactive for full topic content.'));
      return;
    }

    // Default: Quick reference
    displayQuickReference(formatter);
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Help Command Error'));
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
 * Configure the help command for Commander.js
 */
export function configureHelpCommand(program: Command): void {
  program
    .command('help')
    .description('Show comprehensive help and documentation')
    .option('-i, --interactive', 'Launch interactive help system')
    .option('-t, --topic <id>', 'Show specific help topic')
    .option('-s, --search <term>', 'Search help topics')
    .option('-l, --list', 'List all available help topics')
    .option('--quickstart', 'Show quick start guide')
    .option('--troubleshooting', 'Show troubleshooting guide')
    .option('--format <format>', 'Output format (console, markdown, json)', 'console')
    .action(async (options, command) => {
      await helpCommandHandler([], options, command);
    })
    .addHelpText(
      'after',
      `
Examples:
  $ yylo help                                    # Quick reference guide
  $ yylo help --interactive                      # Interactive help system
  $ yylo help --topic quickstart                 # Specific topic
  $ yylo help --search "session"                  # Search topics
  $ yylo help --list                             # List all topics
  $ yylo help --troubleshooting                  # Troubleshooting guide

Help Features:
  - Browse help by category
  - Search across all topics
  - View examples and tutorials
  - Quick reference and troubleshooting guides

Available Topics:
  quickstart          Get started in 5 minutes
  commands-*          Detailed command help
  configuration       Setup and configuration
  sessions            Session management
  troubleshooting     Common issues and solutions

Notes:
  - Use --interactive to display all help topics at once
  - Use --verbose with any command for detailed output
  - Check logs with 'yylo logs' for debugging
    `,
    );
}

export default helpCommandHandler;
