/**
 * Git Management Service for juno-task-ts
 *
 * Centralized Git repository operations, upstream configuration management,
 * repository validation and initialization with full integration support.
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import { z } from 'zod';
import type { ValidationError, FileSystemError } from '../cli/types.js';

// Git URL validation schemas
const GitHttpsUrlSchema = z.string().url().refine(
  (url) => {
    const gitUrlPatterns = [
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/,
      /^https:\/\/gitlab\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/,
      /^https:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+(?:\.git)?$/,
      /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+(?:\.git)?$/, // Generic Git hosting
    ];
    return gitUrlPatterns.some(pattern => pattern.test(url));
  },
  'Must be a valid Git repository URL from a supported provider'
);

const GitSshUrlSchema = z.string().refine(
  (url) => {
    const sshPatterns = [
      /^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/,
      /^git@gitlab\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/,
      /^git@bitbucket\.org:[\w.-]+\/[\w.-]+(?:\.git)?$/,
    ];
    return sshPatterns.some(pattern => pattern.test(url));
  },
  'Must be a valid SSH Git repository URL'
);

const GitUrlSchema = z.union([GitHttpsUrlSchema, GitSshUrlSchema]);

/**
 * Git repository information
 */
export interface GitRepositoryInfo {
  /** Whether the directory is a Git repository */
  isRepository: boolean;
  /** Current branch name */
  currentBranch: string;
  /** All configured remotes */
  remotes: Record<string, string>;
  /** Whether there are uncommitted changes */
  hasUncommittedChanges: boolean;
  /** Whether there are untracked files */
  hasUntrackedFiles: boolean;
  /** Total number of commits */
  commitCount: number;
  /** Last commit information */
  lastCommit?: GitCommitInfo;
  /** Repository status summary */
  status: GitRepositoryStatus;
}

/**
 * Git commit information
 */
export interface GitCommitInfo {
  /** Commit hash (short) */
  hash: string;
  /** Full commit hash */
  fullHash: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** Author email */
  email: string;
  /** Commit date */
  date: Date;
  /** Files changed in commit */
  filesChanged: number;
}

/**
 * Git repository status
 */
export type GitRepositoryStatus =
  | 'clean'           // No changes
  | 'dirty'           // Uncommitted changes
  | 'untracked'       // Untracked files only
  | 'mixed'           // Both uncommitted and untracked
  | 'empty'           // No commits yet
  | 'not-repository'; // Not a Git repository

/**
 * Git upstream configuration
 */
export interface GitUpstreamConfig {
  /** Upstream URL */
  url?: string;
  /** Remote name (usually 'origin') */
  remote: string;
  /** Default branch name */
  branch: string;
  /** Whether upstream is configured */
  isConfigured: boolean;
}

/**
 * Git repository management service
 */
export class GitManager {
  constructor(private workingDirectory: string) {}

  /**
   * Check if directory is a Git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      const { execa } = await import('execa');
      await execa('git', ['rev-parse', '--git-dir'], {
        cwd: this.workingDirectory,
        stdio: 'pipe'
      });
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

      // Set up default branch as 'main'
      await this.setupDefaultBranch('main');
    } catch (error) {
      const { FileSystemError } = await import('../cli/types.js');
      throw new FileSystemError(
        `Failed to initialize Git repository: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Get comprehensive repository information
   */
  async getRepositoryInfo(): Promise<GitRepositoryInfo> {
    const isRepo = await this.isGitRepository();

    if (!isRepo) {
      return {
        isRepository: false,
        currentBranch: '',
        remotes: {},
        hasUncommittedChanges: false,
        hasUntrackedFiles: false,
        commitCount: 0,
        status: 'not-repository'
      };
    }

    try {
      const { execa } = await import('execa');

      // Get current branch
      const branchResult = await execa('git', ['branch', '--show-current'], {
        cwd: this.workingDirectory
      }).catch(() => ({ stdout: '' }));
      const currentBranch = branchResult.stdout.trim();

      // Get remotes
      const remotesResult = await execa('git', ['remote', '-v'], {
        cwd: this.workingDirectory
      }).catch(() => ({ stdout: '' }));
      const remotes = this.parseRemotes(remotesResult.stdout);

      // Check status
      const statusResult = await execa('git', ['status', '--porcelain'], {
        cwd: this.workingDirectory
      }).catch(() => ({ stdout: '' }));
      const statusLines = statusResult.stdout.trim().split('\n').filter(line => line.trim());

      const hasUncommittedChanges = statusLines.some(line => line.match(/^[MADRC]/));
      const hasUntrackedFiles = statusLines.some(line => line.startsWith('??'));

      // Get commit count
      const commitCountResult = await execa('git', ['rev-list', '--count', 'HEAD'], {
        cwd: this.workingDirectory
      }).catch(() => ({ stdout: '0' }));
      const commitCount = parseInt(commitCountResult.stdout.trim(), 10) || 0;

      // Get last commit info
      let lastCommit: GitCommitInfo | undefined;
      if (commitCount > 0) {
        try {
          const commitResult = await execa('git', [
            'log', '-1',
            '--pretty=format:%H|%h|%s|%an|%ae|%ad|%ct',
            '--stat=1,1'
          ], { cwd: this.workingDirectory });

          const [fullHash, hash, message, author, email, dateStr, timestamp] =
            commitResult.stdout.split('|');

          // Get files changed count
          const diffResult = await execa('git', [
            'diff-tree', '--no-commit-id', '--name-only', '-r', fullHash
          ], { cwd: this.workingDirectory });
          const filesChanged = diffResult.stdout.trim().split('\n').filter(line => line).length;

          lastCommit = {
            hash,
            fullHash,
            message,
            author,
            email,
            date: new Date(parseInt(timestamp) * 1000),
            filesChanged
          };
        } catch {
          // Ignore errors getting commit info
        }
      }

      // Determine status
      let status: GitRepositoryStatus;
      if (commitCount === 0) {
        status = 'empty';
      } else if (hasUncommittedChanges && hasUntrackedFiles) {
        status = 'mixed';
      } else if (hasUncommittedChanges) {
        status = 'dirty';
      } else if (hasUntrackedFiles) {
        status = 'untracked';
      } else {
        status = 'clean';
      }

      return {
        isRepository: true,
        currentBranch,
        remotes,
        hasUncommittedChanges,
        hasUntrackedFiles,
        commitCount,
        lastCommit,
        status
      };
    } catch (error) {
      const { FileSystemError } = await import('../cli/types.js');
      throw new FileSystemError(
        `Failed to get Git repository information: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Get upstream configuration
   */
  async getUpstreamConfig(): Promise<GitUpstreamConfig> {
    const info = await this.getRepositoryInfo();

    return {
      url: info.remotes.origin,
      remote: 'origin',
      branch: info.currentBranch || 'main',
      isConfigured: !!info.remotes.origin
    };
  }

  /**
   * Setup upstream repository URL
   */
  async setupUpstream(url: string): Promise<void> {
    try {
      // Validate URL
      const validation = GitUrlSchema.safeParse(url);
      if (!validation.success) {
        const { ValidationError } = await import('../cli/types.js');
        throw new ValidationError(
          `Invalid Git URL: ${url}`,
          [
            'Use HTTPS format: https://github.com/owner/repo.git',
            'Use SSH format: git@github.com:owner/repo.git',
            'Supported providers: GitHub, GitLab, Bitbucket'
          ]
        );
      }

      const { execa } = await import('execa');

      // Ensure repository is initialized
      if (!(await this.isGitRepository())) {
        await this.initRepository();
      }

      // Check if origin remote exists
      try {
        await execa('git', ['remote', 'get-url', 'origin'], {
          cwd: this.workingDirectory
        });
        // Remote exists, update it
        await execa('git', ['remote', 'set-url', 'origin', url], {
          cwd: this.workingDirectory
        });
      } catch {
        // Remote doesn't exist, add it
        await execa('git', ['remote', 'add', 'origin', url], {
          cwd: this.workingDirectory
        });
      }

      // Set upstream branch
      const info = await this.getRepositoryInfo();
      if (info.currentBranch && info.commitCount > 0) {
        try {
          await execa('git', [
            'branch', '--set-upstream-to', `origin/${info.currentBranch}`, info.currentBranch
          ], { cwd: this.workingDirectory });
        } catch {
          // Ignore upstream setting errors
        }
      }

    } catch (error) {
      if (error instanceof Error && error.name === 'ValidationError') {
        throw error;
      }

      const { FileSystemError } = await import('../cli/types.js');
      throw new FileSystemError(
        `Failed to setup upstream: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Remove upstream configuration
   */
  async removeUpstream(): Promise<boolean> {
    try {
      const config = await this.getUpstreamConfig();

      if (!config.isConfigured) {
        return false; // No upstream to remove
      }

      const { execa } = await import('execa');
      await execa('git', ['remote', 'remove', 'origin'], {
        cwd: this.workingDirectory
      });

      return true;
    } catch (error) {
      const { FileSystemError } = await import('../cli/types.js');
      throw new FileSystemError(
        `Failed to remove upstream: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Setup default branch
   */
  async setupDefaultBranch(branchName: string = 'main'): Promise<void> {
    try {
      const { execa } = await import('execa');

      // Get current branch
      const currentResult = await execa('git', ['branch', '--show-current'], {
        cwd: this.workingDirectory
      }).catch(() => ({ stdout: '' }));
      const currentBranch = currentResult.stdout.trim();

      if (currentBranch === branchName) {
        return; // Already on the correct branch
      }

      if (currentBranch) {
        // Rename current branch
        await execa('git', ['branch', '-m', branchName], {
          cwd: this.workingDirectory
        });
      } else {
        // Create new branch (for empty repositories)
        await execa('git', ['checkout', '-b', branchName], {
          cwd: this.workingDirectory
        });
      }
    } catch (error) {
      const { FileSystemError } = await import('../cli/types.js');
      throw new FileSystemError(
        `Failed to setup default branch: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Create initial commit
   */
  async createInitialCommit(message: string = 'Initial commit - juno-code project setup'): Promise<void> {
    try {
      const { execa } = await import('execa');

      // Add all files
      await execa('git', ['add', '.'], { cwd: this.workingDirectory });

      // Check if there are files to commit
      const statusResult = await execa('git', ['status', '--porcelain'], {
        cwd: this.workingDirectory
      });

      if (!statusResult.stdout.trim()) {
        return; // Nothing to commit
      }

      // Create commit
      await execa('git', ['commit', '-m', message], {
        cwd: this.workingDirectory
      });
    } catch (error) {
      const { FileSystemError } = await import('../cli/types.js');
      throw new FileSystemError(
        `Failed to create initial commit: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Perform initial push to upstream
   */
  async performInitialPush(): Promise<void> {
    try {
      const config = await this.getUpstreamConfig();

      if (!config.isConfigured) {
        const { ValidationError } = await import('../cli/types.js');
        throw new ValidationError(
          'No upstream repository configured',
          ['Run setup-git with a repository URL first']
        );
      }

      const { execa } = await import('execa');

      // Push with upstream setting
      await execa('git', [
        'push', '-u', 'origin', config.branch
      ], {
        cwd: this.workingDirectory,
        stdio: 'inherit' // Show progress to user
      });
    } catch (error) {
      const { FileSystemError } = await import('../cli/types.js');
      throw new FileSystemError(
        `Failed to push to upstream: ${error}`,
        this.workingDirectory
      );
    }
  }

  /**
   * Update juno-task configuration with Git information
   */
  async updateJunoTaskConfig(gitUrl: string): Promise<void> {
    const configPath = path.join(this.workingDirectory, '.juno_task', 'init.md');

    if (!(await fs.pathExists(configPath))) {
      return; // No juno-task configuration to update
    }

    try {
      let content = await fs.readFile(configPath, 'utf-8');

      // Check if frontmatter exists
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

      if (frontmatterMatch) {
        // Update existing frontmatter
        let frontmatter = frontmatterMatch[1];

        if (frontmatter.includes('GIT_URL:')) {
          frontmatter = frontmatter.replace(/GIT_URL:.*$/m, `GIT_URL: ${gitUrl}`);
        } else {
          frontmatter += `\nGIT_URL: ${gitUrl}`;
        }

        content = content.replace(/^---\n([\s\S]*?)\n---/, `---\n${frontmatter}\n---`);
      } else {
        // Add frontmatter
        const frontmatter = `---
GIT_URL: ${gitUrl}
---

`;
        content = frontmatter + content;
      }

      await fs.writeFile(configPath, content, 'utf-8');
    } catch (error) {
      // Log warning but don't fail the operation
      console.warn(`Warning: Failed to update juno-code configuration: ${error}`);
    }
  }

  /**
   * Validate Git URL format
   */
  static validateGitUrl(url: string): { valid: boolean; error?: string; provider?: string } {
    const validation = GitUrlSchema.safeParse(url);

    if (!validation.success) {
      return {
        valid: false,
        error: validation.error.errors[0]?.message || 'Invalid Git URL format'
      };
    }

    // Determine provider
    let provider = 'unknown';
    if (url.includes('github.com')) provider = 'GitHub';
    else if (url.includes('gitlab.com')) provider = 'GitLab';
    else if (url.includes('bitbucket.org')) provider = 'Bitbucket';

    return { valid: true, provider };
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
 * Git URL utilities
 */
export class GitUrlUtils {
  /**
   * Normalize Git URL to HTTPS format
   */
  static normalizeToHttps(url: string): string {
    // Convert SSH to HTTPS
    if (url.startsWith('git@')) {
      return url
        .replace(/^git@([^:]+):(.+)$/, 'https://$1/$2')
        .replace(/\.git$/, '');
    }

    // Ensure .git suffix for HTTPS URLs
    if (url.startsWith('https://') && !url.endsWith('.git')) {
      return url + '.git';
    }

    return url;
  }

  /**
   * Extract repository information from URL
   */
  static parseRepositoryUrl(url: string): {
    provider: string;
    owner: string;
    repo: string;
    isSSH: boolean;
  } | null {
    // HTTPS format
    const httpsMatch = url.match(/^https:\/\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (httpsMatch) {
      return {
        provider: httpsMatch[1],
        owner: httpsMatch[2],
        repo: httpsMatch[3],
        isSSH: false
      };
    }

    // SSH format
    const sshMatch = url.match(/^git@([^:]+):([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (sshMatch) {
      return {
        provider: sshMatch[1],
        owner: sshMatch[2],
        repo: sshMatch[3],
        isSSH: true
      };
    }

    return null;
  }

  /**
   * Get repository web URL from Git URL
   */
  static getWebUrl(gitUrl: string): string {
    const info = this.parseRepositoryUrl(gitUrl);
    if (!info) return gitUrl;

    return `https://${info.provider}/${info.owner}/${info.repo}`;
  }
}

// Export types and classes
export {
  GitUrlSchema,
  GitHttpsUrlSchema,
  GitSshUrlSchema
};