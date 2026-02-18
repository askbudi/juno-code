/**
 * @fileoverview Comprehensive tests for Git management functionality
 * Tests for GitManager, GitUrlUtils, and related functionality
 * Target: 98% coverage for src/core/git.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { tmpdir } from 'node:os';

// Mock fs-extra
vi.mock('fs-extra', () => {
  // Create shared mock functions
  const pathExists = vi.fn();
  const readFile = vi.fn();
  const writeFile = vi.fn();
  const mkdtemp = vi.fn();
  const remove = vi.fn();

  return {
    default: {
      pathExists,
      readFile,
      writeFile,
      mkdtemp,
      remove
    },
    pathExists,
    readFile,
    writeFile,
    mkdtemp,
    remove
  };
});

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Import after mocks
import {
  GitManager,
  GitUrlUtils,
  GitUrlSchema,
  GitHttpsUrlSchema,
  GitSshUrlSchema,
  type GitRepositoryInfo,
  type GitCommitInfo,
  type GitUpstreamConfig,
} from '../git.js';

describe('GitManager', () => {
  let gitManager: GitManager;
  let tempDir: string;
  let mockExeca: any;
  let mockFs: any;

  beforeEach(async () => {
    tempDir = '/tmp/test-git-repo';
    gitManager = new GitManager(tempDir);

    // Get mocked modules
    const { execa } = await import('execa');
    mockExeca = execa as any;
    mockFs = fs as any;

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isGitRepository', () => {
    it('should return true for valid git repository', async () => {
      mockExeca.mockResolvedValue({ stdout: '.git' });

      const result = await gitManager.isGitRepository();

      expect(result).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--git-dir'],
        {
          cwd: tempDir,
          stdio: 'pipe'
        }
      );
    });

    it('should return false when not a git repository', async () => {
      mockExeca.mockRejectedValue(new Error('Not a git repository'));

      const result = await gitManager.isGitRepository();

      expect(result).toBe(false);
    });

    it('should return false when git command fails', async () => {
      mockExeca.mockRejectedValue(new Error('Command not found'));

      const result = await gitManager.isGitRepository();

      expect(result).toBe(false);
    });
  });

  describe('initRepository', () => {
    it('should initialize git repository successfully', async () => {
      mockExeca.mockResolvedValue({ stdout: '' });

      await gitManager.initRepository();

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['init'],
        { cwd: tempDir }
      );

      // Should also setup default branch
      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['branch', '--show-current'],
        { cwd: tempDir }
      );
    });

    it('should throw FileSystemError when git init fails', async () => {
      mockExeca.mockRejectedValue(new Error('Permission denied'));

      await expect(gitManager.initRepository()).rejects.toThrow(
        'Failed to initialize Git repository'
      );
    });

    it('should setup main as default branch', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '' }) // git init
        .mockResolvedValueOnce({ stdout: '' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }); // checkout -b main

      await gitManager.initRepository();

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['checkout', '-b', 'main'],
        { cwd: tempDir }
      );
    });
  });

  describe('getRepositoryInfo', () => {
    it('should return not-repository info when not a git repo', async () => {
      mockExeca.mockRejectedValue(new Error('Not a git repository'));

      const info = await gitManager.getRepositoryInfo();

      expect(info).toEqual({
        isRepository: false,
        currentBranch: '',
        remotes: {},
        hasUncommittedChanges: false,
        hasUntrackedFiles: false,
        commitCount: 0,
        status: 'not-repository'
      });
    });

    it('should return comprehensive repository info for clean repo', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // rev-parse --git-dir
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: 'origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)' }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '5' }) // rev-list --count HEAD
        .mockResolvedValueOnce({ stdout: 'abc123|abc|Initial commit|John Doe|john@example.com|2024-01-01|1704067200' }) // log -1
        .mockResolvedValueOnce({ stdout: 'README.md\npackage.json' }); // diff-tree

      const info = await gitManager.getRepositoryInfo();

      expect(info.isRepository).toBe(true);
      expect(info.currentBranch).toBe('main');
      expect(info.remotes.origin).toBe('https://github.com/user/repo.git');
      expect(info.hasUncommittedChanges).toBe(false);
      expect(info.hasUntrackedFiles).toBe(false);
      expect(info.commitCount).toBe(5);
      expect(info.status).toBe('clean');
      expect(info.lastCommit).toBeDefined();
      expect(info.lastCommit?.hash).toBe('abc');
      expect(info.lastCommit?.fullHash).toBe('abc123');
      expect(info.lastCommit?.message).toBe('Initial commit');
      expect(info.lastCommit?.author).toBe('John Doe');
      expect(info.lastCommit?.email).toBe('john@example.com');
      expect(info.lastCommit?.filesChanged).toBe(2);
    });

    it('should detect dirty repository status', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // rev-parse --git-dir
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }) // remote -v
        .mockResolvedValueOnce({ stdout: 'M  file.txt\nA  newfile.txt' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '3' }); // rev-list --count HEAD

      const info = await gitManager.getRepositoryInfo();

      expect(info.hasUncommittedChanges).toBe(true);
      expect(info.hasUntrackedFiles).toBe(false);
      expect(info.status).toBe('dirty');
    });

    it('should detect untracked files status', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // rev-parse --git-dir
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }) // remote -v
        .mockResolvedValueOnce({ stdout: '?? untracked.txt\n?? another.txt' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '2' }); // rev-list --count HEAD

      const info = await gitManager.getRepositoryInfo();

      expect(info.hasUncommittedChanges).toBe(false);
      expect(info.hasUntrackedFiles).toBe(true);
      expect(info.status).toBe('untracked');
    });

    it('should detect mixed repository status', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // rev-parse --git-dir
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }) // remote -v
        .mockResolvedValueOnce({ stdout: 'M  modified.txt\n?? untracked.txt' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }); // rev-list --count HEAD

      const info = await gitManager.getRepositoryInfo();

      expect(info.hasUncommittedChanges).toBe(true);
      expect(info.hasUntrackedFiles).toBe(true);
      expect(info.status).toBe('mixed');
    });

    it('should detect empty repository status', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // rev-parse --git-dir
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '0' }); // rev-list --count HEAD

      const info = await gitManager.getRepositoryInfo();

      expect(info.commitCount).toBe(0);
      expect(info.status).toBe('empty');
      expect(info.lastCommit).toBeUndefined();
    });

    it('should handle git command failures gracefully', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // rev-parse --git-dir
        .mockRejectedValueOnce(new Error('Command failed')) // branch --show-current
        .mockRejectedValueOnce(new Error('Command failed')) // remote -v
        .mockRejectedValueOnce(new Error('Command failed')) // status --porcelain
        .mockRejectedValueOnce(new Error('Command failed')); // rev-list --count HEAD

      const info = await gitManager.getRepositoryInfo();

      expect(info.isRepository).toBe(true);
      expect(info.currentBranch).toBe('');
      expect(info.remotes).toEqual({});
      expect(info.commitCount).toBe(0);
    });

    it('should handle commit info parsing errors', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // rev-parse --git-dir
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }) // rev-list --count HEAD
        .mockRejectedValueOnce(new Error('Log failed')); // log -1

      const info = await gitManager.getRepositoryInfo();

      expect(info.commitCount).toBe(1);
      expect(info.lastCommit).toBeUndefined();
    });

    it('should throw FileSystemError when critical git operations fail', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // rev-parse --git-dir
        .mockRejectedValueOnce(new Error('Fatal error')); // branch --show-current throws

      // Mock the dynamic import for FileSystemError
      vi.doMock('../cli/types.js', () => ({
        FileSystemError: class extends Error {
          constructor(message: string, path: string) {
            super(message);
            this.name = 'FileSystemError';
          }
        }
      }));

      await expect(gitManager.getRepositoryInfo()).rejects.toThrow(
        'Failed to get Git repository information'
      );
    });
  });

  describe('getUpstreamConfig', () => {
    it('should return upstream config when origin is configured', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: 'origin\thttps://github.com/user/repo.git (fetch)' }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }); // rev-list --count HEAD

      const config = await gitManager.getUpstreamConfig();

      expect(config).toEqual({
        url: 'https://github.com/user/repo.git',
        remote: 'origin',
        branch: 'main',
        isConfigured: true
      });
    });

    it('should return unconfigured upstream when no origin', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }) // remote -v (no remotes)
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }); // rev-list --count HEAD

      const config = await gitManager.getUpstreamConfig();

      expect(config).toEqual({
        url: undefined,
        remote: 'origin',
        branch: 'main',
        isConfigured: false
      });
    });

    it('should use default branch when no current branch', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository
        .mockResolvedValueOnce({ stdout: '' }) // branch --show-current (empty repo)
        .mockResolvedValueOnce({ stdout: '' }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '0' }); // rev-list --count HEAD

      const config = await gitManager.getUpstreamConfig();

      expect(config.branch).toBe('main');
    });
  });

  describe('setupUpstream', () => {
    it('should setup upstream with valid HTTPS URL', async () => {
      const url = 'https://github.com/user/repo.git';

      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository
        .mockRejectedValueOnce(new Error('No remote')) // remote get-url origin (doesn't exist)
        .mockResolvedValueOnce({ stdout: '' }) // remote add origin
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getRepositoryInfo)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: 'origin\thttps://github.com/user/repo.git (fetch)' }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }) // rev-list --count HEAD
        .mockResolvedValueOnce({ stdout: '' }); // branch --set-upstream-to

      await gitManager.setupUpstream(url);

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['remote', 'add', 'origin', url],
        { cwd: tempDir }
      );
    });

    it('should setup upstream with valid SSH URL', async () => {
      const url = 'git@github.com:user/repo.git';

      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository
        .mockRejectedValueOnce(new Error('No remote')) // remote get-url origin (doesn't exist)
        .mockResolvedValueOnce({ stdout: '' }) // remote add origin
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getRepositoryInfo)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: `origin\t${url} (fetch)` }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }) // rev-list --count HEAD
        .mockResolvedValueOnce({ stdout: '' }); // branch --set-upstream-to

      await gitManager.setupUpstream(url);

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['remote', 'add', 'origin', url],
        { cwd: tempDir }
      );
    });

    it('should update existing remote URL', async () => {
      const url = 'https://github.com/user/new-repo.git';

      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository
        .mockResolvedValueOnce({ stdout: 'https://github.com/user/old-repo.git' }) // remote get-url origin (exists)
        .mockResolvedValueOnce({ stdout: '' }) // remote set-url origin
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getRepositoryInfo)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: `origin\t${url} (fetch)` }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }) // rev-list --count HEAD
        .mockResolvedValueOnce({ stdout: '' }); // branch --set-upstream-to

      await gitManager.setupUpstream(url);

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['remote', 'set-url', 'origin', url],
        { cwd: tempDir }
      );
    });

    it('should initialize repository if not a git repo', async () => {
      const url = 'https://github.com/user/repo.git';

      mockExeca
        .mockRejectedValueOnce(new Error('Not a git repository')) // isGitRepository (first check)
        .mockResolvedValueOnce({ stdout: '' }) // git init
        .mockResolvedValueOnce({ stdout: '' }) // branch --show-current (for setupDefaultBranch)
        .mockResolvedValueOnce({ stdout: '' }) // checkout -b main
        .mockRejectedValueOnce(new Error('No remote')) // remote get-url origin
        .mockResolvedValueOnce({ stdout: '' }) // remote add origin
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getRepositoryInfo)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: `origin\t${url} (fetch)` }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '0' }); // rev-list --count HEAD

      await gitManager.setupUpstream(url);

      expect(mockExeca).toHaveBeenCalledWith('git', ['init'], { cwd: tempDir });
    });

    it('should throw ValidationError for invalid URL', async () => {
      const invalidUrl = 'not-a-valid-url';

      await expect(gitManager.setupUpstream(invalidUrl)).rejects.toThrow(
        'Invalid Git URL'
      );
    });

    it('should handle upstream branch setting errors gracefully', async () => {
      const url = 'https://github.com/user/repo.git';

      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository
        .mockRejectedValueOnce(new Error('No remote')) // remote get-url origin
        .mockResolvedValueOnce({ stdout: '' }) // remote add origin
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getRepositoryInfo)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: `origin\t${url} (fetch)` }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }) // rev-list --count HEAD
        .mockRejectedValueOnce(new Error('Upstream setting failed')); // branch --set-upstream-to

      // Should not throw error - upstream setting is optional
      await expect(gitManager.setupUpstream(url)).resolves.not.toThrow();
    });

    it('should throw FileSystemError for git operation failures', async () => {
      const url = 'https://github.com/user/repo.git';

      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository
        .mockRejectedValueOnce(new Error('Fatal git error')); // remote get-url origin fails

      await expect(gitManager.setupUpstream(url)).rejects.toThrow(
        'Failed to setup upstream'
      );
    });
  });

  describe('removeUpstream', () => {
    it('should remove existing upstream', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getUpstreamConfig)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: 'origin\thttps://github.com/user/repo.git (fetch)' }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }) // rev-list --count HEAD
        .mockResolvedValueOnce({ stdout: '' }); // remote remove origin

      const result = await gitManager.removeUpstream();

      expect(result).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['remote', 'remove', 'origin'],
        { cwd: tempDir }
      );
    });

    it('should return false when no upstream configured', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getUpstreamConfig)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }) // remote -v (no remotes)
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }); // rev-list --count HEAD

      const result = await gitManager.removeUpstream();

      expect(result).toBe(false);
      expect(mockExeca).not.toHaveBeenCalledWith(
        'git',
        ['remote', 'remove', 'origin'],
        expect.any(Object)
      );
    });

    it('should throw FileSystemError when removal fails', async () => {
      // Mock the dynamic import for FileSystemError
      vi.doMock('../cli/types.js', () => ({
        FileSystemError: class extends Error {
          constructor(message: string, path: string) {
            super(message);
            this.name = 'FileSystemError';
          }
        }
      }));

      // Mock getUpstreamConfig to return configured upstream
      vi.spyOn(gitManager, 'getUpstreamConfig').mockResolvedValueOnce({
        url: 'https://github.com/user/repo.git',
        remote: 'origin',
        branch: 'main',
        isConfigured: true
      });

      // Mock the git remote remove command to fail
      mockExeca.mockRejectedValueOnce(new Error('Permission denied'));

      await expect(gitManager.removeUpstream()).rejects.toThrow(
        'Failed to remove upstream'
      );
    });
  });

  describe('setupDefaultBranch', () => {
    it('should setup main as default branch name', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '' }) // branch --show-current (empty repo)
        .mockResolvedValueOnce({ stdout: '' }); // checkout -b main

      await gitManager.setupDefaultBranch();

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['checkout', '-b', 'main'],
        { cwd: tempDir }
      );
    });

    it('should setup custom branch name', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '' }) // branch --show-current (empty repo)
        .mockResolvedValueOnce({ stdout: '' }); // checkout -b develop

      await gitManager.setupDefaultBranch('develop');

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['checkout', '-b', 'develop'],
        { cwd: tempDir }
      );
    });

    it('should rename existing branch', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: 'master' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }); // branch -m main

      await gitManager.setupDefaultBranch('main');

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['branch', '-m', 'main'],
        { cwd: tempDir }
      );
    });

    it('should do nothing if already on target branch', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'main' }); // branch --show-current

      await gitManager.setupDefaultBranch('main');

      expect(mockExeca).toHaveBeenCalledTimes(1); // Only the branch check
    });

    it('should throw FileSystemError when branch operations fail', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: 'master' }) // branch --show-current
        .mockRejectedValueOnce(new Error('Branch rename failed')); // branch -m

      await expect(gitManager.setupDefaultBranch('main')).rejects.toThrow(
        'Failed to setup default branch'
      );
    });
  });

  describe('createInitialCommit', () => {
    it('should create initial commit with default message', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '' }) // git add .
        .mockResolvedValueOnce({ stdout: 'A  file.txt' }) // status --porcelain (files to commit)
        .mockResolvedValueOnce({ stdout: '' }); // git commit

      await gitManager.createInitialCommit();

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['add', '.'],
        { cwd: tempDir }
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'Initial commit - juno-code project setup'],
        { cwd: tempDir }
      );
    });

    it('should create initial commit with custom message', async () => {
      const customMessage = 'Custom initial commit';

      mockExeca
        .mockResolvedValueOnce({ stdout: '' }) // git add .
        .mockResolvedValueOnce({ stdout: 'A  file.txt' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '' }); // git commit

      await gitManager.createInitialCommit(customMessage);

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', customMessage],
        { cwd: tempDir }
      );
    });

    it('should do nothing when no files to commit', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '' }) // git add .
        .mockResolvedValueOnce({ stdout: '' }); // status --porcelain (no files)

      await gitManager.createInitialCommit();

      expect(mockExeca).not.toHaveBeenCalledWith(
        'git',
        ['commit', '-m', expect.any(String)],
        expect.any(Object)
      );
    });

    it('should throw FileSystemError when commit fails', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '' }) // git add .
        .mockResolvedValueOnce({ stdout: 'A  file.txt' }) // status --porcelain
        .mockRejectedValueOnce(new Error('Commit failed')); // git commit

      await expect(gitManager.createInitialCommit()).rejects.toThrow(
        'Failed to create initial commit'
      );
    });
  });

  describe('performInitialPush', () => {
    it('should perform initial push to configured upstream', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getUpstreamConfig)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: 'origin\thttps://github.com/user/repo.git (fetch)' }) // remote -v
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }) // rev-list --count HEAD
        .mockResolvedValueOnce({ stdout: '' }); // git push -u origin main

      await gitManager.performInitialPush();

      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['push', '-u', 'origin', 'main'],
        {
          cwd: tempDir,
          stdio: 'inherit'
        }
      );
    });

    it('should throw ValidationError when no upstream configured', async () => {
      mockExeca
        .mockResolvedValueOnce({ stdout: '.git' }) // isGitRepository (for getUpstreamConfig)
        .mockResolvedValueOnce({ stdout: 'main' }) // branch --show-current
        .mockResolvedValueOnce({ stdout: '' }) // remote -v (no remotes)
        .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
        .mockResolvedValueOnce({ stdout: '1' }); // rev-list --count HEAD

      await expect(gitManager.performInitialPush()).rejects.toThrow(
        'No upstream repository configured'
      );
    });

    it('should throw FileSystemError when push fails', async () => {
      // Mock the dynamic import for FileSystemError
      vi.doMock('../cli/types.js', () => ({
        FileSystemError: class extends Error {
          constructor(message: string, path: string) {
            super(message);
            this.name = 'FileSystemError';
          }
        }
      }));

      // Mock getUpstreamConfig to return configured upstream
      vi.spyOn(gitManager, 'getUpstreamConfig').mockResolvedValueOnce({
        url: 'https://github.com/user/repo.git',
        remote: 'origin',
        branch: 'main',
        isConfigured: true
      });

      // Mock the git push command to fail
      mockExeca.mockRejectedValueOnce(new Error('Push failed'));

      await expect(gitManager.performInitialPush()).rejects.toThrow(
        'Failed to push to upstream'
      );
    });
  });

  describe('updateJunoTaskConfig', () => {
    it('should update existing frontmatter with GIT_URL', async () => {
      const gitUrl = 'https://github.com/user/repo.git';
      const configPath = path.join(tempDir, '.juno_task', 'init.md');
      const existingContent = `---
EXISTING_CONFIG: value
GIT_URL: old-url
---

# Project Content`;

      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(existingContent);
      mockFs.writeFile.mockResolvedValue(undefined);

      await gitManager.updateJunoTaskConfig(gitUrl);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        configPath,
        expect.stringContaining(`GIT_URL: ${gitUrl}`),
        'utf-8'
      );
    });

    it('should add GIT_URL to existing frontmatter', async () => {
      const gitUrl = 'https://github.com/user/repo.git';
      const configPath = path.join(tempDir, '.juno_task', 'init.md');
      const existingContent = `---
EXISTING_CONFIG: value
---

# Project Content`;

      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(existingContent);
      mockFs.writeFile.mockResolvedValue(undefined);

      await gitManager.updateJunoTaskConfig(gitUrl);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        configPath,
        expect.stringContaining(`GIT_URL: ${gitUrl}`),
        'utf-8'
      );
    });

    it('should create frontmatter when none exists', async () => {
      const gitUrl = 'https://github.com/user/repo.git';
      const configPath = path.join(tempDir, '.juno_task', 'init.md');
      const existingContent = '# Project Content\n\nSome content here.';

      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readFile.mockResolvedValue(existingContent);
      mockFs.writeFile.mockResolvedValue(undefined);

      await gitManager.updateJunoTaskConfig(gitUrl);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        configPath,
        expect.stringContaining(`---\nGIT_URL: ${gitUrl}\n---`),
        'utf-8'
      );
    });

    it('should do nothing when config file does not exist', async () => {
      const gitUrl = 'https://github.com/user/repo.git';

      mockFs.pathExists.mockResolvedValue(false);

      await gitManager.updateJunoTaskConfig(gitUrl);

      expect(mockFs.readFile).not.toHaveBeenCalled();
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should warn and continue when file operations fail', async () => {
      const gitUrl = 'https://github.com/user/repo.git';
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readFile.mockRejectedValue(new Error('File read failed'));

      await gitManager.updateJunoTaskConfig(gitUrl);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Warning: Failed to update juno-code configuration')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('parseRemotes', () => {
    it('should parse git remote output correctly', () => {
      const gitManager = new GitManager('/test');
      const output = `origin\thttps://github.com/user/repo.git (fetch)
origin\thttps://github.com/user/repo.git (push)
upstream\thttps://github.com/original/repo.git (fetch)
upstream\thttps://github.com/original/repo.git (push)`;

      // Access private method
      const parseRemotes = (gitManager as any).parseRemotes;
      const result = parseRemotes(output);

      expect(result).toEqual({
        origin: 'https://github.com/user/repo.git',
        upstream: 'https://github.com/original/repo.git'
      });
    });

    it('should handle empty remote output', () => {
      const gitManager = new GitManager('/test');
      const output = '';

      const parseRemotes = (gitManager as any).parseRemotes;
      const result = parseRemotes(output);

      expect(result).toEqual({});
    });

    it('should handle malformed remote lines', () => {
      const gitManager = new GitManager('/test');
      const output = `origin\thttps://github.com/user/repo.git (fetch)
invalid line format
upstream\thttps://github.com/original/repo.git (fetch)`;

      const parseRemotes = (gitManager as any).parseRemotes;
      const result = parseRemotes(output);

      expect(result).toEqual({
        origin: 'https://github.com/user/repo.git',
        upstream: 'https://github.com/original/repo.git'
      });
    });
  });

  describe('static validateGitUrl', () => {
    it('should validate GitHub HTTPS URL', () => {
      const result = GitManager.validateGitUrl('https://github.com/user/repo.git');

      expect(result.valid).toBe(true);
      expect(result.provider).toBe('GitHub');
    });

    it('should validate GitHub SSH URL', () => {
      const result = GitManager.validateGitUrl('git@github.com:user/repo.git');

      expect(result.valid).toBe(true);
      expect(result.provider).toBe('GitHub');
    });

    it('should validate GitLab URLs', () => {
      const httpsResult = GitManager.validateGitUrl('https://gitlab.com/user/repo.git');
      const sshResult = GitManager.validateGitUrl('git@gitlab.com:user/repo.git');

      expect(httpsResult.valid).toBe(true);
      expect(httpsResult.provider).toBe('GitLab');
      expect(sshResult.valid).toBe(true);
      expect(sshResult.provider).toBe('GitLab');
    });

    it('should validate Bitbucket URLs', () => {
      const httpsResult = GitManager.validateGitUrl('https://bitbucket.org/user/repo.git');
      const sshResult = GitManager.validateGitUrl('git@bitbucket.org:user/repo.git');

      expect(httpsResult.valid).toBe(true);
      expect(httpsResult.provider).toBe('Bitbucket');
      expect(sshResult.valid).toBe(true);
      expect(sshResult.provider).toBe('Bitbucket');
    });

    it('should reject invalid URLs', () => {
      const invalidUrls = [
        'not-a-url',
        'https://example.com/not-git',
        'git@invalid:format',
        'ftp://github.com/user/repo.git'
      ];

      for (const url of invalidUrls) {
        const result = GitManager.validateGitUrl(url);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }
    });

    it('should identify unknown provider', () => {
      const result = GitManager.validateGitUrl('https://custom-git.com/user/repo.git');

      expect(result.valid).toBe(true);
      expect(result.provider).toBe('unknown');
    });
  });
});

describe('GitUrlUtils', () => {
  describe('normalizeToHttps', () => {
    it('should convert SSH URL to HTTPS', () => {
      const sshUrl = 'git@github.com:user/repo.git';
      const result = GitUrlUtils.normalizeToHttps(sshUrl);

      expect(result).toBe('https://github.com/user/repo');
    });

    it('should add .git suffix to HTTPS URLs', () => {
      const httpsUrl = 'https://github.com/user/repo';
      const result = GitUrlUtils.normalizeToHttps(httpsUrl);

      expect(result).toBe('https://github.com/user/repo.git');
    });

    it('should preserve HTTPS URLs with .git suffix', () => {
      const httpsUrl = 'https://github.com/user/repo.git';
      const result = GitUrlUtils.normalizeToHttps(httpsUrl);

      expect(result).toBe('https://github.com/user/repo.git');
    });

    it('should handle various SSH formats', () => {
      const testCases = [
        ['git@gitlab.com:user/repo.git', 'https://gitlab.com/user/repo'],
        ['git@bitbucket.org:user/repo.git', 'https://bitbucket.org/user/repo'],
        ['git@custom-host.com:user/repo.git', 'https://custom-host.com/user/repo']
      ];

      for (const [input, expected] of testCases) {
        expect(GitUrlUtils.normalizeToHttps(input)).toBe(expected);
      }
    });
  });

  describe('parseRepositoryUrl', () => {
    it('should parse HTTPS URLs correctly', () => {
      const url = 'https://github.com/user/repo.git';
      const result = GitUrlUtils.parseRepositoryUrl(url);

      expect(result).toEqual({
        provider: 'github.com',
        owner: 'user',
        repo: 'repo',
        isSSH: false
      });
    });

    it('should parse SSH URLs correctly', () => {
      const url = 'git@github.com:user/repo.git';
      const result = GitUrlUtils.parseRepositoryUrl(url);

      expect(result).toEqual({
        provider: 'github.com',
        owner: 'user',
        repo: 'repo',
        isSSH: true
      });
    });

    it('should handle URLs without .git suffix', () => {
      const httpsUrl = 'https://github.com/user/repo';
      const sshUrl = 'git@github.com:user/repo';

      const httpsResult = GitUrlUtils.parseRepositoryUrl(httpsUrl);
      const sshResult = GitUrlUtils.parseRepositoryUrl(sshUrl);

      expect(httpsResult?.repo).toBe('repo');
      expect(sshResult?.repo).toBe('repo');
    });

    it('should return null for invalid URLs', () => {
      const invalidUrls = [
        'not-a-valid-url',
        'https://github.com/incomplete',
        'git@github.com:incomplete'
      ];

      for (const url of invalidUrls) {
        expect(GitUrlUtils.parseRepositoryUrl(url)).toBeNull();
      }
    });

    it('should handle various providers', () => {
      const testCases = [
        ['https://gitlab.com/user/repo.git', 'gitlab.com'],
        ['https://bitbucket.org/user/repo.git', 'bitbucket.org'],
        ['git@gitlab.com:user/repo.git', 'gitlab.com'],
        ['git@bitbucket.org:user/repo.git', 'bitbucket.org']
      ];

      for (const [url, expectedProvider] of testCases) {
        const result = GitUrlUtils.parseRepositoryUrl(url);
        expect(result?.provider).toBe(expectedProvider);
      }
    });
  });

  describe('getWebUrl', () => {
    it('should convert Git URLs to web URLs', () => {
      const testCases = [
        ['https://github.com/user/repo.git', 'https://github.com/user/repo'],
        ['git@github.com:user/repo.git', 'https://github.com/user/repo'],
        ['https://gitlab.com/user/repo.git', 'https://gitlab.com/user/repo'],
        ['git@gitlab.com:user/repo.git', 'https://gitlab.com/user/repo']
      ];

      for (const [input, expected] of testCases) {
        expect(GitUrlUtils.getWebUrl(input)).toBe(expected);
      }
    });

    it('should return original URL for unparseable URLs', () => {
      const invalidUrl = 'not-a-valid-git-url';
      expect(GitUrlUtils.getWebUrl(invalidUrl)).toBe(invalidUrl);
    });

    it('should handle URLs without .git suffix', () => {
      const url = 'https://github.com/user/repo';
      expect(GitUrlUtils.getWebUrl(url)).toBe('https://github.com/user/repo');
    });
  });
});

describe('Git URL Schemas', () => {
  describe('GitHttpsUrlSchema', () => {
    it('should validate GitHub HTTPS URLs', () => {
      const validUrls = [
        'https://github.com/user/repo.git',
        'https://github.com/user/repo',
        'https://github.com/user/repo-name.git',
        'https://github.com/user-name/repo.git'
      ];

      for (const url of validUrls) {
        expect(() => GitHttpsUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should validate GitLab HTTPS URLs', () => {
      const validUrls = [
        'https://gitlab.com/user/repo.git',
        'https://gitlab.com/user/repo'
      ];

      for (const url of validUrls) {
        expect(() => GitHttpsUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should validate Bitbucket HTTPS URLs', () => {
      const validUrls = [
        'https://bitbucket.org/user/repo.git',
        'https://bitbucket.org/user/repo'
      ];

      for (const url of validUrls) {
        expect(() => GitHttpsUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should validate generic Git hosting URLs', () => {
      const validUrls = [
        'https://git.example.com/user/repo.git',
        'https://code.company.com/team/project.git'
      ];

      for (const url of validUrls) {
        expect(() => GitHttpsUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should reject invalid HTTPS URLs', () => {
      const invalidUrls = [
        'https://example.com/not-git',
        'https://github.com/incomplete',
        'https://github.com',
        'http://github.com/user/repo.git', // HTTP not HTTPS
        'ftp://github.com/user/repo.git'
      ];

      for (const url of invalidUrls) {
        expect(() => GitHttpsUrlSchema.parse(url)).toThrow();
      }
    });
  });

  describe('GitSshUrlSchema', () => {
    it('should validate GitHub SSH URLs', () => {
      const validUrls = [
        'git@github.com:user/repo.git',
        'git@github.com:user/repo',
        'git@github.com:user/repo-name.git',
        'git@github.com:user-name/repo.git'
      ];

      for (const url of validUrls) {
        expect(() => GitSshUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should validate GitLab SSH URLs', () => {
      const validUrls = [
        'git@gitlab.com:user/repo.git',
        'git@gitlab.com:user/repo'
      ];

      for (const url of validUrls) {
        expect(() => GitSshUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should validate Bitbucket SSH URLs', () => {
      const validUrls = [
        'git@bitbucket.org:user/repo.git',
        'git@bitbucket.org:user/repo'
      ];

      for (const url of validUrls) {
        expect(() => GitSshUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should reject invalid SSH URLs', () => {
      const invalidUrls = [
        'git@github.com/user/repo.git', // Wrong separator
        'user@github.com:user/repo.git', // Wrong user
        'git@github.com:incomplete',
        'git@github.com',
        'ssh://git@github.com/user/repo.git' // Wrong format
      ];

      for (const url of invalidUrls) {
        expect(() => GitSshUrlSchema.parse(url)).toThrow();
      }
    });
  });

  describe('GitUrlSchema', () => {
    it('should accept both HTTPS and SSH URLs', () => {
      const validUrls = [
        'https://github.com/user/repo.git',
        'git@github.com:user/repo.git',
        'https://gitlab.com/user/repo.git',
        'git@gitlab.com:user/repo.git'
      ];

      for (const url of validUrls) {
        expect(() => GitUrlSchema.parse(url)).not.toThrow();
      }
    });

    it('should reject invalid URLs', () => {
      const invalidUrls = [
        'not-a-url',
        'https://example.com/not-git',
        'git@invalid:format',
        'ftp://github.com/user/repo.git'
      ];

      for (const url of invalidUrls) {
        expect(() => GitUrlSchema.parse(url)).toThrow();
      }
    });
  });
});