/**
 * Simplified Feedback command implementation for juno-task-ts CLI
 *
 * Simple feedback collection with minimal interface.
 * Removes complex features: structured data, metadata, categorization, etc.
 */

import * as path from 'node:path';
import * as readline from 'node:readline';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';

import type { FeedbackCommandOptions } from '../types.js';
import { ValidationError } from '../types.js';

/**
 * Simple Interactive Feedback for user feedback collection
 * Minimal flow as requested by user:
 * Issue Description [Multi line] → Save → Done
 */
class SimpleFeedbackTUI {
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
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim() || defaultValue);
      });
    });
  }

  /**
   * Simple gather method implementing the minimal flow
   */
  async gather(): Promise<string> {
    console.log(chalk.blue.bold('\n📝 Submit Feedback\n'));

    // Issue Description (multi-line, NO character limits)
    console.log(chalk.yellow('📄 Step 1: Describe your issue or feedback'));
    const feedback = await this.promptForFeedback();

    console.log(chalk.green('\n✅ Feedback submitted successfully!'));
    console.log(chalk.gray('   Thank you for your input.'));

    return feedback;
  }

  private async promptForFeedback(): Promise<string> {
    console.log(chalk.gray('   Describe your issue, bug report, or suggestion'));
    console.log(chalk.gray('   You can write multiple lines. Press Enter on empty line when finished.\n'));

    const lines: string[] = [];

    while (true) {
      const line = await this.promptForInput(lines.length === 0 ? 'Feedback' : '   (continue, empty line to finish)', '');

      if (line.trim() === '') {
        break; // Empty line signals end of input
      }

      lines.push(line);
    }

    const input = lines.join('\n').trim();

    if (!input || input.length < 5) {
      throw new ValidationError(
        'Feedback must be at least 5 characters',
        ['Provide a description of your issue or suggestion']
      );
    }

    return input;
  }
}

/**
 * Simple Feedback file manager for USER_FEEDBACK.md manipulation
 */
class SimpleFeedbackFileManager {
  constructor(private feedbackFile: string) {}

  async ensureExists(): Promise<void> {
    if (!(await fs.pathExists(this.feedbackFile))) {
      await this.createInitialFile();
    }
  }

  async addFeedback(feedback: string): Promise<void> {
    await this.ensureExists();

    try {
      const content = await fs.readFile(this.feedbackFile, 'utf-8');
      const updatedContent = this.addIssueToContent(content, feedback);
      await fs.writeFile(this.feedbackFile, updatedContent, 'utf-8');
    } catch (error) {
      throw new ValidationError(
        `Failed to save feedback: ${error}`,
        ['Check file permissions and try again']
      );
    }
  }

  private async createInitialFile(): Promise<void> {
    const initialContent = `# User Feedback

List any features you'd like to see added or bugs you've encountered.

## OPEN_ISSUES

<OPEN_ISSUES>
   <!-- New issues will be added here -->
</OPEN_ISSUES>

## Past Issues

<!-- Resolved issues will be moved here -->
`;
    await fs.ensureDir(path.dirname(this.feedbackFile));
    await fs.writeFile(this.feedbackFile, initialContent, 'utf-8');
  }

  private addIssueToContent(content: string, feedback: string): string {
    const timestamp = new Date().toISOString().split('T')[0];
    const newIssue = `   <ISSUE>
      ${feedback}

Added: ${timestamp}
   </ISSUE>`;

    // Find the OPEN_ISSUES section and add the new issue
    const openIssuesMatch = content.match(/(<OPEN_ISSUES>[\s\S]*?<\/OPEN_ISSUES>)/);

    if (openIssuesMatch) {
      const openIssuesSection = openIssuesMatch[1];
      const closingTag = '</OPEN_ISSUES>';
      const insertionPoint = openIssuesSection.lastIndexOf(closingTag);

      if (insertionPoint !== -1) {
        const updatedSection =
          openIssuesSection.slice(0, insertionPoint) +
          '\n' + newIssue + '\n' +
          openIssuesSection.slice(insertionPoint);

        return content.replace(openIssuesSection, updatedSection);
      }
    }

    // Fallback: just append to file
    return content + '\n\n' + newIssue;
  }
}

/**
 * Append issue to USER_FEEDBACK.md
 */
async function appendIssueToFeedback(feedbackFile: string, issueText: string): Promise<void> {
  try {
    const fileManager = new SimpleFeedbackFileManager(feedbackFile);
    await fileManager.addFeedback(issueText);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(
      `Failed to append feedback: ${error}`,
      ['Check file permissions and try again']
    );
  }
}

/**
 * Collect multiline feedback from user
 */
async function collectFeedback(): Promise<string> {
  const feedbackTUI = new SimpleFeedbackTUI();
  return await feedbackTUI.gather();
}

/**
 * Get feedback file path from options
 */
function getFeedbackFile(options: FeedbackCommandOptions): string {
  return options.file || path.join(process.cwd(), '.juno_task', 'USER_FEEDBACK.md');
}

/**
 * Configure the feedback command for Commander.js (simplified)
 */
export function configureFeedbackCommand(program: Command): void {
  program
    .command('feedback')
    .description('Submit feedback about juno-task (simplified interface)')
    .argument('[feedback...]', 'Feedback text or issue description')
    .option('-f, --file <path>', 'Feedback file path (default: .juno_task/USER_FEEDBACK.md)')
    .option('-i, --interactive', 'Launch simple interactive feedback form')
    .action(async (feedback, options, command) => {
      // Get merged options including global ones
      const mergedOptions = command.optsWithGlobals();

      const feedbackOptions: FeedbackCommandOptions = {
        file: mergedOptions.file,
        interactive: mergedOptions.interactive,
        // Global options
        verbose: mergedOptions.verbose,
        quiet: mergedOptions.quiet,
        config: mergedOptions.config,
        logFile: mergedOptions.logFile,
        logLevel: mergedOptions.logLevel
      };

      const feedbackText = Array.isArray(feedback) ? feedback.join(' ') : feedback;
      await feedbackCommandHandler([feedbackText], feedbackOptions, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-task feedback                                    # Interactive feedback form
  $ juno-task feedback "Issue with command"              # Direct feedback text
  $ juno-task feedback --interactive                     # Use simple interactive form

Simplified Interactive Flow:
  1. Issue Description → Multi-line feedback input
  2. Save → Automatically saved to USER_FEEDBACK.md

Notes:
  - No character limits or token counting
  - Simple readline interface
  - Direct file manipulation without structured data
  - Focus on quick feedback collection
    `);
}

/**
 * Feedback command handler
 */
export async function feedbackCommandHandler(
  args: string[],
  options: FeedbackCommandOptions,
  command: Command
): Promise<void> {
  try {
    // Default to interactive mode if no arguments provided
    const shouldUseInteractive = options.interactive || args.length === 0;

    if (shouldUseInteractive) {
      // Use simplified interactive mode
      const issueText = await collectFeedback();
      const feedbackFile = getFeedbackFile(options);

      // Append issue to USER_FEEDBACK.md
      await appendIssueToFeedback(feedbackFile, issueText);

      console.log(chalk.green.bold('✅ Feedback added to USER_FEEDBACK.md!'));
      console.log(chalk.gray(`   File: ${feedbackFile}`));

    } else {
      // Handle subcommands
      const [subcommand, ...subArgs] = args;

      switch (subcommand) {
        case 'list':
          console.log(chalk.yellow('📋 Feedback listing not yet implemented'));
          break;

        case 'resolve':
        case 'close':
          console.log(chalk.yellow('🔧 Feedback resolution not yet implemented'));
          break;

        case 'remove':
        case 'delete':
          console.log(chalk.yellow('🗑️ Feedback removal not yet implemented'));
          break;

        default:
          // Treat as feedback text
          const feedbackText = args.join(' ');
          if (feedbackText.trim()) {
            const feedbackFile = getFeedbackFile(options);
            await appendIssueToFeedback(feedbackFile, feedbackText);
            console.log(chalk.green.bold('✅ Feedback added to USER_FEEDBACK.md!'));
          } else {
            console.log(chalk.yellow('Use --interactive mode or provide feedback text'));
          }
          break;
      }
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(chalk.red('❌ Validation Error:'));
      console.error(chalk.red(error.message));
      if (error.suggestions.length > 0) {
        console.error(chalk.yellow('\nSuggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.gray(`  • ${suggestion}`));
        });
      }
      process.exit(1);
    } else {
      console.error(chalk.red('❌ Unexpected Error:'), error);
      process.exit(1);
    }
  }
}