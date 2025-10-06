/**
 * Setup-git command implementation for juno-task-ts CLI
 *
 * Provides Git repository configuration and setup with URL management,
 * branch setup, remote configuration, and integration with project templates.
 */

import * as path from 'node:path';
import * as fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';
import { z } from 'zod';

import type { SetupGitOptions, ValidationError, FileSystemError } from '../types.js';

// Validation schemas
const GitUrlSchema = z.string().url('Must be a valid URL').refine(
  (url) => url.includes('github.com') || url.includes('gitlab.com') || url.includes('bitbucket.org') || url.includes('.git'),
  'Must be a valid Git repository URL'
);

/**
 * Git configuration and repository information
 */
interface GitConfig {
  remotes: Record<string, string>;
  branch: string;
  upstreamUrl?: string;
  isRepository: boolean;
  hasRemote: boolean;
  isDirty: boolean;
  lastCommit?: {
    hash: string;
    message: string;
    author: string;
    date: Date;
  };
}

/**
 * Git utility for repository operations
 */
class GitUtils {
  constructor(private workingDirectory: string) {}

  /**
   * Check if directory is a Git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      const { execa } = await import('execa');
      await execa('git', ['rev-parse', '--git-dir'], { cwd: this.workingDirectory });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize Git repository
   */
  async initRepository(): Promise<void> {
    try {
      const { execa } = await import('execa');
      await execa('git', ['init'], { cwd: this.workingDirectory });
    } catch (error) {
      throw new FileSystemError(
        `Failed to initialize Git repository: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Get current Git configuration
   */
  async getConfig(): Promise<GitConfig> {
    const isRepo = await this.isGitRepository();

    if (!isRepo) {
      return {
        remotes: {},
        branch: '',
        isRepository: false,
        hasRemote: false,
        isDirty: false
      };
    }

    try {
      const { execa } = await import('execa');

      // Get remotes
      const remotesResult = await execa('git', ['remote', '-v'], { cwd: this.workingDirectory });
      const remotes = this.parseRemotes(remotesResult.stdout);

      // Get current branch
      const branchResult = await execa('git', ['branch', '--show-current'], { cwd: this.workingDirectory });
      const branch = branchResult.stdout.trim();

      // Check if working directory is dirty
      const statusResult = await execa('git', ['status', '--porcelain'], { cwd: this.workingDirectory });
      const isDirty = statusResult.stdout.trim().length > 0;

      // Get last commit info
      let lastCommit;
      try {
        const commitResult = await execa('git', ['log', '-1', '--pretty=format:%H|%s|%an|%ad'], { cwd: this.workingDirectory });
        const [hash, message, author, date] = commitResult.stdout.split('|');
        lastCommit = {
          hash: hash.substring(0, 8),
          message,
          author,
          date: new Date(date)
        };
      } catch {
        // No commits yet
      }

      return {
        remotes,
        branch,
        upstreamUrl: remotes.origin,
        isRepository: true,
        hasRemote: Object.keys(remotes).length > 0,
        isDirty,
        lastCommit
      };
    } catch (error) {
      throw new FileSystemError(
        `Failed to get Git configuration: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Set upstream URL
   */
  async setUpstreamUrl(url: string): Promise<void> {
    try {
      const { execa } = await import('execa');

      // Validate URL
      const urlResult = GitUrlSchema.safeParse(url);
      if (!urlResult.success) {
        throw new ValidationError(
          `Invalid Git URL: ${url}`,
          [
            'Provide a valid HTTPS Git repository URL',
            'Example: https://github.com/owner/repo.git',
            'Supported platforms: GitHub, GitLab, Bitbucket'
          ]
        );
      }

      // Check if origin remote exists
      try {
        await execa('git', ['remote', 'get-url', 'origin'], { cwd: this.workingDirectory });
        // Remote exists, update it
        await execa('git', ['remote', 'set-url', 'origin', url], { cwd: this.workingDirectory });
      } catch {
        // Remote doesn't exist, add it
        await execa('git', ['remote', 'add', 'origin', url], { cwd: this.workingDirectory });
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }

      throw new FileSystemError(
        `Failed to set upstream URL: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Remove upstream URL
   */
  async removeUpstreamUrl(): Promise<void> {
    try {
      const { execa } = await import('execa');
      await execa('git', ['remote', 'remove', 'origin'], { cwd: this.workingDirectory });
    } catch (error) {
      throw new FileSystemError(
        `Failed to remove upstream URL: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Create initial commit if none exists
   */
  async createInitialCommit(): Promise<void> {
    try {
      const { execa } = await import('execa');

      // Add all files
      await execa('git', ['add', '.'], { cwd: this.workingDirectory });

      // Create initial commit
      await execa('git', ['commit', '-m', 'Initial commit - juno-task project setup'], { cwd: this.workingDirectory });
    } catch (error) {
      throw new FileSystemError(
        `Failed to create initial commit: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Set up default branch
   */
  async setupDefaultBranch(branchName: string = 'main'): Promise<void> {
    try {
      const { execa } = await import('execa');

      // Check if we're already on the desired branch
      const currentBranchResult = await execa('git', ['branch', '--show-current'], { cwd: this.workingDirectory });
      const currentBranch = currentBranchResult.stdout.trim();

      if (currentBranch === branchName) {
        return; // Already on the correct branch
      }

      // Create and switch to the new branch
      if (currentBranch) {
        await execa('git', ['branch', '-m', branchName], { cwd: this.workingDirectory });
      } else {
        await execa('git', ['checkout', '-b', branchName], { cwd: this.workingDirectory });
      }
    } catch (error) {
      throw new FileSystemError(
        `Failed to setup default branch: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Update .juno_task configuration with Git info
   */
  async updateJunoTaskConfig(gitUrl: string): Promise<void> {
    const configPath = path.join(this.workingDirectory, '.juno_task', 'init.md');

    if (!(await fs.pathExists(configPath))) {
      return; // No juno-task configuration to update
    }

    try {
      let content = await fs.readFile(configPath, 'utf-8');

      // Update or add git URL in the configuration
      if (content.includes('GIT_URL:')) {
        content = content.replace(/GIT_URL:.*$/m, `GIT_URL: ${gitUrl}`);
      } else {
        // Add git URL to the configuration
        const lines = content.split('\n');
        const insertIndex = lines.findIndex(line => line.trim().startsWith('---')) + 1;
        if (insertIndex > 0) {
          lines.splice(insertIndex, 0, `GIT_URL: ${gitUrl}`);
          content = lines.join('\n');
        }
      }

      await fs.writeFile(configPath, content, 'utf-8');
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Failed to update juno-task configuration: ${error}`));
    }
  }

  /**
   * Parse Git remotes output
   */
  private parseRemotes(output: string): Record<string, string> {
    const remotes: Record<string, string> = {};

    for (const line of output.split('\n')) {
      const match = line.match(/^(\w+)\s+(.+?)\s+\(fetch\)$/);
      if (match) {
        remotes[match[1]] = match[2];
      }
    }

    return remotes;
  }
}

/**
 * Git configuration display formatter
 */
class GitDisplayFormatter {
  formatConfig(config: GitConfig): void {
    if (!config.isRepository) {
      console.log(chalk.yellow('📁 Not a Git repository'));
      return;
    }

    console.log(chalk.blue.bold('\n📋 Git Configuration\n'));

    // Repository status
    console.log(chalk.white.bold('Repository Status:'));
    console.log(`   Initialized: ${chalk.green('Yes')}`);
    console.log(`   Current Branch: ${config.branch ? chalk.cyan(config.branch) : chalk.gray('(no branch)')}`);
    console.log(`   Working Directory: ${config.isDirty ? chalk.red('Dirty') : chalk.green('Clean')}`);

    // Remotes
    console.log(chalk.white.bold('\nRemotes:'));
    if (Object.keys(config.remotes).length === 0) {
      console.log(chalk.gray('   No remotes configured'));
    } else {
      Object.entries(config.remotes).forEach(([name, url]) => {
        console.log(`   ${chalk.cyan(name)}: ${chalk.white(url)}`);
      });
    }

    // Last commit
    if (config.lastCommit) {
      console.log(chalk.white.bold('\nLast Commit:'));
      console.log(`   Hash: ${chalk.gray(config.lastCommit.hash)}`);
      console.log(`   Message: ${chalk.white(config.lastCommit.message)}`);
      console.log(`   Author: ${chalk.gray(config.lastCommit.author)}`);
      console.log(`   Date: ${chalk.gray(config.lastCommit.date.toLocaleString())}`);
    } else {
      console.log(chalk.white.bold('\nCommits:'));
      console.log(chalk.gray('   No commits yet'));
    }
  }

  formatSetupResult(config: GitConfig, url?: string): void {
    console.log(chalk.green.bold('\n✅ Git Setup Complete!\n'));

    console.log(chalk.blue('📋 Configuration Summary:'));
    console.log(`   Repository: ${chalk.green('Initialized')}`);
    console.log(`   Branch: ${chalk.cyan(config.branch || 'main')}`);

    if (url) {
      console.log(`   Remote URL: ${chalk.white(url)}`);
    }

    console.log(chalk.blue('\n💡 Next Steps:'));
    console.log('   1. Review and commit your changes:');
    console.log(chalk.gray('      git add .'));
    console.log(chalk.gray('      git commit -m "Initial commit"'));

    if (url) {
      console.log('   2. Push to remote repository:');
      console.log(chalk.gray('      git push -u origin main'));
    }

    console.log('   3. Start working on your project:');
    console.log(chalk.gray('      juno-task start'));
  }
}

/**
 * Interactive Git setup
 */
class GitSetupInteractive {
  constructor(private gitUtils: GitUtils, private formatter: GitDisplayFormatter) {}

  async setup(): Promise<void> {
    console.log(chalk.blue.bold('\n🔧 Git Repository Setup\n'));

    const config = await this.gitUtils.getConfig();

    if (!config.isRepository) {
      console.log(chalk.yellow('No Git repository found. Initializing...'));
      await this.gitUtils.initRepository();
      console.log(chalk.green('✅ Git repository initialized'));
    }

    // Prompt for upstream URL
    const url = await this.promptForUrl(config.upstreamUrl);

    if (url) {
      await this.gitUtils.setUpstreamUrl(url);
      await this.gitUtils.updateJunoTaskConfig(url);
      console.log(chalk.green(`✅ Upstream URL set: ${url}`));
    }

    // Setup default branch
    await this.gitUtils.setupDefaultBranch('main');

    // Get updated config
    const updatedConfig = await this.gitUtils.getConfig();

    // Create initial commit if needed
    if (!updatedConfig.lastCommit) {
      console.log(chalk.blue('Creating initial commit...'));
      await this.gitUtils.createInitialCommit();
      console.log(chalk.green('✅ Initial commit created'));
    }

    // Display results
    const finalConfig = await this.gitUtils.getConfig();
    this.formatter.formatSetupResult(finalConfig, url);
  }

  private async promptForUrl(currentUrl?: string): Promise<string | undefined> {
    console.log(chalk.yellow('🔗 Repository URL:'));
    if (currentUrl) {
      console.log(`   Current: ${chalk.white(currentUrl)}`);
      console.log('   Press Enter to keep current URL, or enter new URL:');
    } else {
      console.log('   Enter the Git repository URL (optional):');
      console.log('   Example: https://github.com/owner/repo.git');
    }

    // In real implementation, would prompt for user input
    // For demonstration, return current URL or undefined
    return currentUrl;
  }
}

/**
 * Main setup-git command handler
 */
export async function setupGitCommandHandler(
  args: string[],
  options: SetupGitOptions,
  command: Command
): Promise<void> {
  try {
    const workingDirectory = process.cwd();
    const gitUtils = new GitUtils(workingDirectory);
    const formatter = new GitDisplayFormatter();

    if (options.show) {
      // Show current configuration
      const config = await gitUtils.getConfig();
      formatter.formatConfig(config);
      return;
    }

    if (options.remove) {
      // Remove upstream URL
      const config = await gitUtils.getConfig();

      if (!config.isRepository) {
        console.log(chalk.yellow('Not a Git repository'));
        return;
      }

      if (!config.hasRemote) {
        console.log(chalk.yellow('No remote configured'));
        return;
      }

      await gitUtils.removeUpstreamUrl();
      console.log(chalk.green('✅ Upstream URL removed'));
      return;
    }

    // Handle URL argument
    const url = args[0];

    if (url) {
      // Direct URL setup
      const config = await gitUtils.getConfig();

      if (!config.isRepository) {
        console.log(chalk.blue('Initializing Git repository...'));
        await gitUtils.initRepository();
      }

      await gitUtils.setUpstreamUrl(url);
      await gitUtils.updateJunoTaskConfig(url);

      console.log(chalk.green(`✅ Upstream URL set: ${url}`));

      // Display updated configuration
      const updatedConfig = await gitUtils.getConfig();
      formatter.formatConfig(updatedConfig);

    } else {
      // Interactive setup
      const interactive = new GitSetupInteractive(gitUtils, formatter);
      await interactive.setup();
    }

  } catch (error) {
    if (error instanceof ValidationError || error instanceof FileSystemError) {
      console.error(chalk.red.bold('\n❌ Git Setup Failed'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(1);
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
 * Configure the setup-git command for Commander.js
 */
export function configureSetupGitCommand(program: Command): void {
  program
    .command('setup-git')
    .description('Configure Git repository and upstream URL')
    .argument('[url]', 'Git repository URL')
    .option('-s, --show', 'Show current Git configuration')
    .option('-r, --remove', 'Remove upstream URL configuration')
    .action(async (url, options, command) => {
      const args = url ? [url] : [];
      await setupGitCommandHandler(args, options, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-task setup-git                                    # Interactive setup
  $ juno-task setup-git https://github.com/owner/repo     # Set specific URL
  $ juno-task setup-git --show                            # Show current config
  $ juno-task setup-git --remove                          # Remove upstream URL

Git URL Examples:
  https://github.com/owner/repo.git                       # GitHub HTTPS
  https://gitlab.com/owner/repo.git                       # GitLab HTTPS
  https://bitbucket.org/owner/repo.git                    # Bitbucket HTTPS

Environment Variables:
  JUNO_TASK_GIT_URL         Default Git repository URL

Notes:
  - Automatically initializes Git repository if needed
  - Sets up 'main' as default branch
  - Updates .juno_task/init.md with Git URL
  - Creates initial commit if repository is empty
  - Use HTTPS URLs for better compatibility
    `);
}