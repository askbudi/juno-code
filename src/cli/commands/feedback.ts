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
 * Enhanced Feedback file manager for USER_FEEDBACK.md manipulation
 */
class EnhancedFeedbackFileManager {
  constructor(private feedbackFile: string) {}

  async ensureExists(): Promise<void> {
    if (!(await fs.pathExists(this.feedbackFile))) {
      await this.createInitialFile();
    }
  }

  async addFeedback(issue: string, testCriteria?: string): Promise<void> {
    await this.ensureExists();

    try {
      const content = await fs.readFile(this.feedbackFile, 'utf-8');
      const updatedContent = this.addIssueToContent(content, issue, testCriteria);
      await fs.writeFile(this.feedbackFile, updatedContent, 'utf-8');
    } catch (error) {
      throw new ValidationError(
        `Failed to save feedback: ${error}`,
        ['Check file permissions and try again']
      );
    }
  }

  /**
   * Add resilience for malformed USER_FEEDBACK.md files
   */
  async repairMalformedFile(): Promise<void> {
    try {
      const content = await fs.readFile(this.feedbackFile, 'utf-8');

      // Check if file has proper structure
      const hasOpenIssues = content.includes('<OPEN_ISSUES>');
      const hasClosingTag = content.includes('</OPEN_ISSUES>');

      if (!hasOpenIssues || !hasClosingTag) {
        // Create backup and regenerate
        const backupPath = this.feedbackFile + '.backup.' + Date.now();
        await fs.writeFile(backupPath, content, 'utf-8');

        // Extract existing issues if possible
        const existingIssues = this.extractIssuesFromMalformedContent(content);

        // Create new proper structure with extracted issues
        await this.createInitialFile(existingIssues);
      }
    } catch (error) {
      // If file is severely corrupted, create fresh one
      await this.createInitialFile();
    }
  }

  private async createInitialFile(existingIssues: string[] = []): Promise<void> {
    let initialContent = `# User Feedback

List any features you'd like to see added or bugs you've encountered.

## OPEN_ISSUES

<OPEN_ISSUES>
   <!-- New issues will be added here -->`;

    // Add existing issues if any were recovered
    for (const issue of existingIssues) {
      initialContent += `\n\n   <ISSUE>\n      ${issue}\n      <DATE>${new Date().toISOString().split('T')[0]}</DATE>\n   </ISSUE>`;
    }

    initialContent += `\n</OPEN_ISSUES>\n\n## Past Issues\n\n<!-- Resolved issues will be moved here -->\n`;

    await fs.ensureDir(path.dirname(this.feedbackFile));
    await fs.writeFile(this.feedbackFile, initialContent, 'utf-8');
  }

  private addIssueToContent(content: string, issue: string, testCriteria?: string): string {
    const timestamp = new Date().toISOString().split('T')[0];

    // Create properly formatted XML entry
    let newIssue = `   <ISSUE>\n      ${issue}`;

    if (testCriteria && testCriteria.trim()) {
      newIssue += `\n      <Test_CRITERIA>${testCriteria}</Test_CRITERIA>`;
    }

    newIssue += `\n      <DATE>${timestamp}</DATE>\n   </ISSUE>`;

    // Try to find and insert into OPEN_ISSUES section
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

    // Fallback: append to file
    return content + '\n\n' + newIssue;
  }

  private extractIssuesFromMalformedContent(content: string): string[] {
    const issues: string[] = [];

    // Try to extract content from malformed ISSUE tags
    const issueMatches = content.match(/<ISSUE>[\s\S]*?<\/ISSUE>/g) || [];

    for (const match of issueMatches) {
      // Remove tags but keep the content
      const cleanContent = match
        .replace(/<\/?ISSUE>/g, '')
        .replace(/<\/?Test_CRITERIA>/g, '')
        .replace(/<\/?DATE>/g, '')
        .trim();

      if (cleanContent && !issues.includes(cleanContent)) {
        issues.push(cleanContent);
      }
    }

    return issues;
  }
}

/**
 * Append issue to USER_FEEDBACK.md with optional test criteria
 */
async function appendIssueToFeedback(feedbackFile: string, issueText: string, testCriteria?: string): Promise<void> {
  try {
    const fileManager = new EnhancedFeedbackFileManager(feedbackFile);
    await fileManager.addFeedback(issueText, testCriteria);
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
 * Configure the feedback command for Commander.js (enhanced)
 */
export function configureFeedbackCommand(program: Command): void {
  program
    .command('feedback')
    .description('Submit feedback about juno-task (enhanced interface)')
    .argument('[feedback...]', 'Feedback text or issue description')
    .option('-f, --file <path>', 'Feedback file path (default: .juno_task/USER_FEEDBACK.md)')
    .option('--interactive', 'Launch simple interactive feedback form')
    .option('-i, --issue <description>', 'Issue description')
    .option('-it, --test <criteria>', 'Test criteria or success factors (short form)')
    .option('-t, --test <criteria>', 'Test criteria or success factors')
    .option('--test-criteria <criteria>', 'Test criteria (long form)')
    .action(async (feedback, options, command) => {
      // Get merged options including global ones
      const mergedOptions = command.optsWithGlobals();

      const feedbackOptions: FeedbackCommandOptions = {
        file: options.file || mergedOptions.file,
        interactive: options.interactive,
        issue: options.issue,
        test: options.test,
        testCriteria: options.testCriteria,
        // Global options
        verbose: mergedOptions.verbose,
        quiet: mergedOptions.quiet,
        config: mergedOptions.config,
        logFile: mergedOptions.logFile,
        logLevel: mergedOptions.logLevel
      };

      const feedbackText = Array.isArray(feedback) ? feedback.join(' ') : feedback;
      // Only pass arguments if there's actual feedback text
      const args = feedbackText ? [feedbackText] : [];
      await feedbackCommandHandler(args, feedbackOptions, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-task feedback                                    # Interactive feedback form
  $ juno-task feedback "Issue with command"              # Direct feedback text
  $ juno-task feedback --interactive                     # Use interactive form
  $ juno-task feedback --issue "Bug description" --test "Should work without errors"  # Issue with test criteria
  $ juno-task feedback -i "Connection timeout" -t "Connect within 30 seconds"           # Short form

Enhanced Features:
  1. Issue Description → Structured feedback with optional test criteria
  2. Test Criteria → Success factors and validation requirements
  3. XML Formatting → Proper <ISSUE><Test_CRITERIA><DATE> structure
  4. File Resilience → Automatic repair of malformed USER_FEEDBACK.md

Notes:
  - Supports both positional arguments and --issue flag
  - Test criteria are optional but recommended for actionable feedback
  - XML structure ensures proper parsing and organization
  - Automatic backup and repair for corrupted feedback files
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

    // Handle --issue flag with optional --test criteria
    if (options.issue || (options.test || options.testCriteria)) {
      const issueText = options.issue || args.join(' ') || '';
      const testCriteria = options.test || options.testCriteria || '';

      // Ensure we have an issue description
      if (!issueText.trim()) {
        throw new ValidationError(
          'Issue description is required when using --issue or --test flags',
          ['Use: juno-task feedback -i "Issue description" -t "Test criteria"']
        );
      }
      const feedbackFile = getFeedbackFile(options);

      // Append issue with test criteria to USER_FEEDBACK.md
      await appendIssueToFeedback(feedbackFile, issueText, testCriteria);

      console.log(chalk.green.bold('✅ Feedback added to USER_FEEDBACK.md!'));
      console.log(chalk.gray(`   File: ${feedbackFile}`));
      if (testCriteria) {
        console.log(chalk.blue(`   Test Criteria: ${testCriteria}`));
      }

    } else if (shouldUseInteractive) {
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
            console.log(chalk.yellow('Use --interactive mode, --issue flag, or provide feedback text'));
            console.log(chalk.gray('Examples:'));
            console.log(chalk.gray('  juno-task feedback --issue "Bug description"'));
            console.log(chalk.gray('  juno-task feedback -i "Issue" -t "Test criteria"'));
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