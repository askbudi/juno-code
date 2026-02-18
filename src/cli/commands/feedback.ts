/**
 * Simplified Feedback command implementation for juno-code CLI
 *
 * Simple feedback collection with minimal interface.
 * Removes complex features: structured data, metadata, categorization, etc.
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';

import type { FeedbackCommandOptions } from '../types.js';
import { ValidationError } from '../types.js';
import { promptMultiline, promptInputOnce } from '../utils/multiline.js';
import { compactConfigFile, formatFileSize, shouldCompactFile } from '../../utils/file-compaction.js';
import { archiveResolvedIssues, countOpenIssues, shouldArchive } from '../../utils/feedback-archival.js';

/**
 * Simple Interactive Feedback for user feedback collection
 * Minimal flow as requested by user:
 * Issue Description [Multi line] → Save → Done
 */
class SimpleFeedbackTUI {
  /**
   * Simple gather method implementing the minimal flow
   */
  async gather(): Promise<{ issue: string; testCriteria?: string }> {
    console.log(chalk.blue.bold('\n📝 Submit Feedback\n'));

    // Issue Description (multi-line, NO character limits)
    console.log(chalk.yellow('📄 Step 1: Describe your issue or feedback'));
    const issue = await this.promptForFeedback();

    // Optional Test Criteria (multi-line)
    console.log(chalk.yellow('\n🧪 Step 2: (Optional) Provide Test Criteria'));
    console.log(chalk.gray('   Would you like to add test criteria? (y/n)'));
    const addCriteriaAnswer = (await promptInputOnce('Add test criteria', 'n')).toLowerCase();
    let testCriteria: string | undefined = undefined;
    if (addCriteriaAnswer === 'y' || addCriteriaAnswer === 'yes') {
      testCriteria = await promptMultiline({
        label: 'Describe how we should validate the fix',
        hint: 'Finish with double Enter. Blank lines are kept.',
        prompt: '  ',
      });
      testCriteria = testCriteria.trim() || undefined;
    }

    console.log(chalk.green('\n✅ Feedback submitted successfully!'));
    console.log(chalk.gray('   Thank you for your input.'));

    return { issue, testCriteria };
  }

  private async promptForFeedback(): Promise<string> {
    const input = await promptMultiline({
      label: 'Describe your issue, bug report, or suggestion',
      hint: 'Finish with double Enter. Blank lines are kept.',
      prompt: '  ',
      minLength: 5,
    });

    if (!input || input.replace(/\s+/g, '').length < 5) {
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
async function collectFeedback(): Promise<{ issue: string; testCriteria?: string }> {
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
    .description('Submit feedback about juno-code (enhanced interface)')
    .argument('[feedback...]', 'Feedback text or issue description')
    .option('-f, --file <path>', 'Feedback file path (default: .juno_task/USER_FEEDBACK.md)')
    .option('--interactive', 'Launch simple interactive feedback form')
    .option('-is, --issue <description>', 'Issue description')
    .option('-d, --detail <description>', 'Issue description (alternative form)')
    .option('--details <description>', 'Issue description (alternative form)')
    .option('--description <description>', 'Issue description (alternative form)')
    .option('-t, --test <criteria>', 'Test criteria or success factors')
    .option('-tc, --test-criteria <criteria>', 'Test criteria or success factors (alternative form)')
    .action(async (feedback, options, command) => {
      // Create feedback options from command options (similar to init command)
      const feedbackOptions: FeedbackCommandOptions = {
        file: options.file,
        interactive: options.interactive,
        issue: options.issue || options.detail || options.details || options.description,
        test: options.test, // Handle -t/--test flag
        testCriteria: options.testCriteria, // Handle -it/--test-criteria flag
        // Global options
        verbose: options.verbose,
        quiet: options.quiet,
        config: options.config,
        logFile: options.logFile,
        logLevel: options.logLevel
      };

      const feedbackText = Array.isArray(feedback) ? feedback.join(' ') : feedback;
      // Only pass arguments if there's actual feedback text
      const args = feedbackText ? [feedbackText] : [];
      await feedbackCommandHandler(args, feedbackOptions, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-code feedback                                    # Interactive feedback form
  $ juno-code feedback "Issue with command"              # Direct feedback text
  $ juno-code feedback --interactive                     # Use interactive form
  $ juno-code feedback --issue "Bug description" --test "Should work without errors"      # Issue with test criteria
  $ juno-code feedback -is "Connection timeout" -t "Connect within 30 seconds"           # Short form flags
  $ juno-code feedback -is "UI issue" -tc "Should be intuitive"                        # Alternative short form
  $ juno-code feedback --detail "Bug description" --test "Should work without errors"   # Issue with test criteria
  $ juno-code feedback -d "Connection timeout" -t "Connect within 30 seconds"           # Short form flags
  $ juno-code feedback --description "UI issue" --test "Should be intuitive"             # Alternative form
  $ juno-code feedback archive                                                       # Archive resolved issues to keep file lean
  $ juno-code feedback compact                                                        # Compact CLAUDE.md and AGENTS.md
  $ juno-code feedback compact CLAUDE.md                                             # Compact specific file

Enhanced Features:
  1. Issue Description → Structured feedback with optional test criteria
  2. Test Criteria → Success factors and validation requirements
  3. XML Formatting → Proper <ISSUE><Test_CRITERIA><DATE> structure
  4. File Resilience → Automatic repair of malformed USER_FEEDBACK.md
  5. Archival System → Archive resolved issues to yearly archive files
  5. File Compaction → Smart compaction of CLAUDE.md/AGENTS.md files

Notes:
  - Supports both positional arguments and --issue/-is/--detail/--description/-d flag
  - Use -t/--test or -tc/--test-criteria for test criteria (recommended for actionable feedback)
  - XML structure ensures proper parsing and organization
  - Automatic backup and repair for corrupted feedback files
    `);
}

/**
 * Handle compact subcommand for compacting CLAUDE.md and AGENTS.md files
 */
async function handleCompactCommand(subArgs: string[], options: FeedbackCommandOptions): Promise<void> {
  try {
    // Default to compacting CLAUDE.md in current directory
    const defaultClaudeFile = path.join(process.cwd(), 'CLAUDE.md');
    const defaultAgentsFile = path.join(process.cwd(), 'AGENTS.md');

    // Check which files exist and should be compacted
    const filesToCompact: string[] = [];

    if (subArgs.length > 0) {
      // Specific files provided
      for (const filePath of subArgs) {
        const resolvedPath = path.resolve(filePath);
        if (await fs.pathExists(resolvedPath)) {
          filesToCompact.push(resolvedPath);
        } else {
          console.warn(chalk.yellow(`⚠️  File not found: ${filePath}`));
        }
      }
    } else {
      // Auto-detect config files
      if (await fs.pathExists(defaultClaudeFile)) {
        filesToCompact.push(defaultClaudeFile);
      }
      if (await fs.pathExists(defaultAgentsFile)) {
        filesToCompact.push(defaultAgentsFile);
      }
    }

    if (filesToCompact.length === 0) {
      console.log(chalk.yellow('📄 No config files found to compact'));
      console.log(chalk.gray('   Looking for: CLAUDE.md, AGENTS.md'));
      console.log(chalk.gray('   Usage: juno-code feedback compact [file1] [file2]'));
      return;
    }

    console.log(chalk.blue.bold('\n🗜️  File Compaction Process\n'));

    for (const filePath of filesToCompact) {
      const fileName = path.basename(filePath);

      // Check if file needs compaction
      const needsCompaction = await shouldCompactFile(filePath, 30); // 30KB threshold

      if (!needsCompaction) {
        console.log(chalk.green(`✅ ${fileName} - File is already compact (< 30KB)`));
        continue;
      }

      console.log(chalk.cyan(`📝 Compacting ${fileName}...`));

      try {
        const result = await compactConfigFile(filePath, {
          createBackup: true,
          dryRun: false,
          preserveDays: 30,
          preservePatterns: [
            'CRITICAL',
            'OPEN ISSUES',
            'BUILD.*LOOP',
            'TEST PATTERNS',
            'UX.*TUI',
            'important-instruction-reminders'
          ]
        });

        console.log(chalk.green(`✅ ${fileName} compacted successfully!`));
        console.log(chalk.gray(`   Original size: ${formatFileSize(result.originalSize)}`));
        console.log(chalk.gray(`   Compacted size: ${formatFileSize(result.compactedSize)}`));
        console.log(chalk.gray(`   Space saved: ${result.reductionPercentage}%`));
        console.log(chalk.gray(`   Backup created: ${path.basename(result.backupPath)}`));

        if (result.sectionsRemoved.length > 0) {
          console.log(chalk.gray(`   Removed sections: ${result.sectionsRemoved.length}`));
          if (options.verbose) {
            result.sectionsRemoved.forEach(section => {
              console.log(chalk.gray(`     - ${section}`));
            });
          }
        }

        console.log('');
      } catch (error) {
        console.error(chalk.red(`❌ Failed to compact ${fileName}: ${error}`));
      }
    }

    console.log(chalk.green.bold('🎉 Compaction process completed!'));
    console.log(chalk.gray('   Essential information preserved, historical content removed'));

  } catch (error) {
    console.error(chalk.red('❌ Compaction failed:'), error);
    throw error;
  }
}

/**
 * Handle archive subcommand
 */
async function handleArchiveCommand(options: FeedbackCommandOptions): Promise<void> {
  const feedbackFile = getFeedbackFile(options);

  try {
    // Check if archival is needed
    const archivalCheck = await shouldArchive(feedbackFile, {
      openIssuesThreshold: 10,
      fileSizeThreshold: 50 * 1024, // 50KB
      lineCountThreshold: 500
    });

    if (!archivalCheck.shouldArchive) {
      console.log(chalk.blue('📋 No archival needed'));
      console.log(chalk.gray(`   Open issues: ${archivalCheck.stats.openIssuesCount}`));
      console.log(chalk.gray(`   Resolved issues: ${archivalCheck.stats.resolvedIssuesCount}`));
      console.log(chalk.gray(`   File size: ${(archivalCheck.stats.fileSizeBytes / 1024).toFixed(1)}KB`));
      console.log(chalk.gray(`   Line count: ${archivalCheck.stats.lineCount}`));
      return;
    }

    // Perform archival
    const results = await archiveResolvedIssues({
      feedbackFile,
      archiveDir: path.join(path.dirname(feedbackFile), 'archives'),
      openIssuesThreshold: 10,
      dryRun: false,
      verbose: true
    });

    // Display results
    console.log(chalk.green.bold('✅ Feedback archival completed!'));
    console.log(chalk.gray(`   Archived issues: ${results.archivedCount}`));
    console.log(chalk.gray(`   Remaining open issues: ${results.openIssuesCount}`));

    if (results.archiveFile) {
      console.log(chalk.gray(`   Archive file: ${results.archiveFile}`));
    }

    // Display warnings
    if (results.warningsGenerated.length > 0) {
      console.log(chalk.yellow('\n⚠️  Warnings:'));
      results.warningsGenerated.forEach(warning => {
        console.log(chalk.yellow(`   • ${warning}`));
      });
      console.log(chalk.gray('   Check .juno_task/logs/feedback-warnings.log for details'));
    }

    // Show summary
    console.log(chalk.blue('\n📊 Archival reasons:'));
    archivalCheck.reasons.forEach(reason => {
      console.log(chalk.gray(`   • ${reason}`));
    });

  } catch (error) {
    throw new ValidationError(
      `Failed to archive feedback: ${error}`,
      ['Check file permissions and try again', 'Verify USER_FEEDBACK.md is not corrupted']
    );
  }
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
    // Handle explicit --issue/--detail/--description flags (headless mode)
    if (options.issue || options.test || options.testCriteria) {
      const issueText = options.issue || '';
      const testCriteria = options.test || options.testCriteria || '';

      // Ensure we have an issue description when using explicit flags
      if (!issueText.trim()) {
        throw new ValidationError(
          'Issue description is required when using --issue/-is/--detail/--description or --test/-tc flags',
          ['Use: juno-code feedback -is "Issue description" -t "Test criteria" or -tc "Test criteria"']
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

    } else {
      // Default to interactive mode if no headless arguments provided
      const shouldUseInteractive = options.interactive || args.length === 0;

      if (shouldUseInteractive) {
        // Use simplified interactive mode
        const { issue: issueText, testCriteria } = await collectFeedback();
        const feedbackFile = getFeedbackFile(options);

        // Append issue to USER_FEEDBACK.md
        await appendIssueToFeedback(feedbackFile, issueText, testCriteria);

        console.log(chalk.green.bold('✅ Feedback added to USER_FEEDBACK.md!'));
        console.log(chalk.gray(`   File: ${feedbackFile}`));
        if (testCriteria) {
          console.log(chalk.blue(`   Test Criteria: ${testCriteria}`));
        }

      } else {
        // Handle subcommands
        const [subcommand, ...subArgs] = args;

        switch (subcommand) {
          case 'archive':
            await handleArchiveCommand(options);
            break;

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

          case 'compact':
            await handleCompactCommand(subArgs, options);
            break;

          default:
            // Treat as feedback text
            const feedbackText = args.join(' ');
            if (feedbackText.trim()) {
              const feedbackFile = getFeedbackFile(options);
              await appendIssueToFeedback(feedbackFile, feedbackText);
              console.log(chalk.green.bold('✅ Feedback added to USER_FEEDBACK.md!'));
            } else {
              console.log(chalk.yellow('Use --interactive mode, --issue/-is/--detail/--description flag, or provide feedback text'));
              console.log(chalk.gray('Examples:'));
              console.log(chalk.gray('  juno-code feedback --issue "Bug description"'));
              console.log(chalk.gray('  juno-code feedback -is "Issue" -t "Test criteria"'));
              console.log(chalk.gray('  juno-code feedback --detail "Bug description"'));
              console.log(chalk.gray('  juno-code feedback -d "Issue" -t "Test criteria"'));
            }
            break;
        }
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
