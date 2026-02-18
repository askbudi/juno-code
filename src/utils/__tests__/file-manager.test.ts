/**
 * Tests for FileManager utility class
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import fs from 'fs-extra';
import {
  FileManager,
  fileManager,
  safeWrite,
  safeRead,
  ensureDirectory,
  safeRemove,
  copy,
  move,
  getMetadata,
  traverse,
  type FileOperationOptions,
  type TraversalOptions,
} from '../file-manager.js';

describe('FileManager', () => {
  let testDir: string;
  let manager: FileManager;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `file-manager-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    await fs.ensureDir(testDir);
    manager = new FileManager();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.remove(testDir);
    } catch (error) {
      console.warn('Failed to clean up test directory:', error);
    }
  });

  describe('Constructor and Singleton', () => {
    it('should create instance with default options', () => {
      const fm = new FileManager();
      expect(fm).toBeInstanceOf(FileManager);
    });

    it('should create instance with custom options', () => {
      const fm = new FileManager({ backup: true, overwrite: true });
      expect(fm).toBeInstanceOf(FileManager);
    });

    it('should return singleton instance', () => {
      const instance1 = FileManager.getInstance();
      const instance2 = FileManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('safeWrite', () => {
    it('should write string content to file', async () => {
      const filePath = join(testDir, 'test.txt');
      const content = 'Hello, World!';

      const result = await manager.safeWrite(filePath, content);

      expect(result.success).toBe(true);
      expect(result.path).toBe(filePath);
      expect(result.operation).toBe('write');
      expect(result.size).toBe(Buffer.byteLength(content));
      expect(result.checksum).toBeDefined();
      expect(result.duration).toBeGreaterThan(0);

      // Verify file was created with correct content
      const fileContent = await fs.readFile(filePath, 'utf8');
      expect(fileContent).toBe(content);
    });

    it('should write buffer content to file', async () => {
      const filePath = join(testDir, 'test.bin');
      const content = Buffer.from([1, 2, 3, 4, 5]);

      const result = await manager.safeWrite(filePath, content);

      expect(result.success).toBe(true);
      expect(result.size).toBe(content.length);

      // Verify file was created with correct content
      const fileContent = await fs.readFile(filePath);
      expect(fileContent).toEqual(content);
    });

    it('should create parent directories automatically', async () => {
      const filePath = join(testDir, 'nested', 'deep', 'test.txt');
      const content = 'Test content';

      const result = await manager.safeWrite(filePath, content);

      expect(result.success).toBe(true);
      expect(await fs.pathExists(filePath)).toBe(true);
    });

    it('should fail when file exists and overwrite is false', async () => {
      const filePath = join(testDir, 'existing.txt');
      await fs.writeFile(filePath, 'Existing content');

      const result = await manager.safeWrite(filePath, 'New content', { overwrite: false });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('already exists');
    });

    it('should create backup when requested', async () => {
      const filePath = join(testDir, 'backup-test.txt');
      const originalContent = 'Original content';
      const newContent = 'New content';

      // Create original file
      await fs.writeFile(filePath, originalContent);

      // Write with backup
      const result = await manager.safeWrite(filePath, newContent, {
        overwrite: true,
        backup: true,
        backupSuffix: '.backup',
      });

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(result.backupPath).toBe(`${filePath}.backup`);

      // Verify backup contains original content
      const backupContent = await fs.readFile(result.backupPath!, 'utf8');
      expect(backupContent).toBe(originalContent);

      // Verify file contains new content
      const fileContent = await fs.readFile(filePath, 'utf8');
      expect(fileContent).toBe(newContent);
    });

    it('should fail when content exceeds max size', async () => {
      const filePath = join(testDir, 'large.txt');
      const content = 'x'.repeat(1000);

      const result = await manager.safeWrite(filePath, content, { maxSize: 100 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('exceeds maximum allowed size');
    });

    it('should use atomic writes by default', async () => {
      const filePath = join(testDir, 'atomic.txt');
      const content = 'Atomic content';

      const result = await manager.safeWrite(filePath, content, { atomic: true });

      expect(result.success).toBe(true);
      expect(await fs.pathExists(filePath)).toBe(true);
    });
  });

  describe('safeRead', () => {
    it('should read string content from file', async () => {
      const filePath = join(testDir, 'read-test.txt');
      const content = 'Test content for reading';
      await fs.writeFile(filePath, content);

      const result = await manager.safeRead(filePath);

      expect(result.success).toBe(true);
      expect(result.content).toBe(content);
      expect(result.size).toBe(Buffer.byteLength(content));
      expect(result.checksum).toBeDefined();
    });

    it('should read binary content from file', async () => {
      const filePath = join(testDir, 'read-test.bin');
      const content = Buffer.from([1, 2, 3, 4, 5]);
      await fs.writeFile(filePath, content);

      const result = await manager.safeRead(filePath, { encoding: undefined });

      expect(result.success).toBe(true);
      expect(Buffer.isBuffer(result.content)).toBe(true);
      expect(result.content).toEqual(content);
    });

    it('should fail when file does not exist', async () => {
      const filePath = join(testDir, 'nonexistent.txt');

      const result = await manager.safeRead(filePath);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('does not exist');
    });

    it('should fail when file exceeds max size', async () => {
      const filePath = join(testDir, 'large.txt');
      const content = 'x'.repeat(1000);
      await fs.writeFile(filePath, content);

      const result = await manager.safeRead(filePath, { maxSize: 100 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('exceeds maximum allowed size');
    });
  });

  describe('ensureDirectory', () => {
    it('should create directory', async () => {
      const dirPath = join(testDir, 'new-directory');

      const result = await manager.ensureDirectory(dirPath);

      expect(result.success).toBe(true);
      expect(result.path).toBe(dirPath);
      expect(result.operation).toBe('ensureDirectory');
      expect(await fs.pathExists(dirPath)).toBe(true);

      const stats = await fs.stat(dirPath);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should create nested directories', async () => {
      const dirPath = join(testDir, 'nested', 'deep', 'directories');

      const result = await manager.ensureDirectory(dirPath);

      expect(result.success).toBe(true);
      expect(await fs.pathExists(dirPath)).toBe(true);
    });

    it('should not fail if directory already exists', async () => {
      const dirPath = join(testDir, 'existing-dir');
      await fs.ensureDir(dirPath);

      const result = await manager.ensureDirectory(dirPath);

      expect(result.success).toBe(true);
    });

    it('should set permissions when specified', async () => {
      const dirPath = join(testDir, 'permissions-dir');

      const result = await manager.ensureDirectory(dirPath, { mode: 0o755 });

      expect(result.success).toBe(true);

      // Note: Permission testing is platform-specific and may not work on all systems
      if (process.platform !== 'win32') {
        const stats = await fs.stat(dirPath);
        expect(stats.mode & 0o777).toBe(0o755);
      }
    });
  });

  describe('safeRemove', () => {
    it('should remove file', async () => {
      const filePath = join(testDir, 'remove-test.txt');
      await fs.writeFile(filePath, 'Content to remove');

      const result = await manager.safeRemove(filePath);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('remove');
      expect(await fs.pathExists(filePath)).toBe(false);
    });

    it('should remove directory', async () => {
      const dirPath = join(testDir, 'remove-dir');
      await fs.ensureDir(dirPath);
      await fs.writeFile(join(dirPath, 'file.txt'), 'content');

      const result = await manager.safeRemove(dirPath);

      expect(result.success).toBe(true);
      expect(await fs.pathExists(dirPath)).toBe(false);
    });

    it('should create backup before removal', async () => {
      const filePath = join(testDir, 'backup-remove.txt');
      const content = 'Content to backup';
      await fs.writeFile(filePath, content);

      const result = await manager.safeRemove(filePath, { backup: true });

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(await fs.pathExists(filePath)).toBe(false);
      expect(await fs.pathExists(result.backupPath!)).toBe(true);

      const backupContent = await fs.readFile(result.backupPath!, 'utf8');
      expect(backupContent).toBe(content);
    });

    it('should fail when path does not exist', async () => {
      const filePath = join(testDir, 'nonexistent.txt');

      const result = await manager.safeRemove(filePath);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('does not exist');
    });
  });

  describe('copy', () => {
    it('should copy file', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const destPath = join(testDir, 'destination.txt');
      const content = 'Content to copy';
      await fs.writeFile(sourcePath, content);

      const result = await manager.copy(sourcePath, destPath);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('copy');
      expect(await fs.pathExists(destPath)).toBe(true);

      const copiedContent = await fs.readFile(destPath, 'utf8');
      expect(copiedContent).toBe(content);
    });

    it('should copy directory with contents', async () => {
      const sourceDir = join(testDir, 'source-dir');
      const destDir = join(testDir, 'dest-dir');

      await fs.ensureDir(sourceDir);
      await fs.writeFile(join(sourceDir, 'file1.txt'), 'Content 1');
      await fs.writeFile(join(sourceDir, 'file2.txt'), 'Content 2');

      const result = await manager.copy(sourceDir, destDir);

      expect(result.success).toBe(true);
      expect(await fs.pathExists(join(destDir, 'file1.txt'))).toBe(true);
      expect(await fs.pathExists(join(destDir, 'file2.txt'))).toBe(true);
    });

    it('should fail when source does not exist', async () => {
      const sourcePath = join(testDir, 'nonexistent.txt');
      const destPath = join(testDir, 'destination.txt');

      const result = await manager.copy(sourcePath, destPath);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('does not exist');
    });

    it('should create backup when destination exists', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const destPath = join(testDir, 'destination.txt');

      await fs.writeFile(sourcePath, 'New content');
      await fs.writeFile(destPath, 'Original content');

      const result = await manager.copy(sourcePath, destPath, {
        overwrite: true,
        backup: true,
      });

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(await fs.pathExists(result.backupPath!)).toBe(true);
    });
  });

  describe('move', () => {
    it('should move file', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const destPath = join(testDir, 'destination.txt');
      const content = 'Content to move';
      await fs.writeFile(sourcePath, content);

      const result = await manager.move(sourcePath, destPath);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('move');
      expect(await fs.pathExists(sourcePath)).toBe(false);
      expect(await fs.pathExists(destPath)).toBe(true);

      const movedContent = await fs.readFile(destPath, 'utf8');
      expect(movedContent).toBe(content);
    });

    it('should move directory', async () => {
      const sourceDir = join(testDir, 'source-dir');
      const destDir = join(testDir, 'dest-dir');

      await fs.ensureDir(sourceDir);
      await fs.writeFile(join(sourceDir, 'file.txt'), 'Content');

      const result = await manager.move(sourceDir, destDir);

      expect(result.success).toBe(true);
      expect(await fs.pathExists(sourceDir)).toBe(false);
      expect(await fs.pathExists(join(destDir, 'file.txt'))).toBe(true);
    });
  });

  describe('getMetadata', () => {
    it('should get file metadata', async () => {
      const filePath = join(testDir, 'metadata-test.txt');
      const content = 'Test content';
      await fs.writeFile(filePath, content);

      const metadata = await manager.getMetadata(filePath);

      expect(metadata.path).toBe(filePath);
      expect(metadata.size).toBe(Buffer.byteLength(content));
      expect(metadata.isFile).toBe(true);
      expect(metadata.isDirectory).toBe(false);
      expect(metadata.isSymlink).toBe(false);
      expect(metadata.created).toBeInstanceOf(Date);
      expect(metadata.modified).toBeInstanceOf(Date);
      expect(metadata.accessed).toBeInstanceOf(Date);
      expect(metadata.permissions).toBeDefined();
    });

    it('should get directory metadata', async () => {
      const dirPath = join(testDir, 'metadata-dir');
      await fs.ensureDir(dirPath);

      const metadata = await manager.getMetadata(dirPath);

      expect(metadata.isFile).toBe(false);
      expect(metadata.isDirectory).toBe(true);
      expect(metadata.isSymlink).toBe(false);
    });
  });

  describe('traverse', () => {
    beforeEach(async () => {
      // Create test directory structure
      const structure = {
        'file1.txt': 'Content 1',
        'file2.js': 'console.log("test");',
        '.hidden.txt': 'Hidden content',
        'subdir1': {
          'file3.txt': 'Content 3',
          'file4.md': '# Markdown',
          'subsubdir': {
            'file5.txt': 'Content 5',
          },
        },
        'subdir2': {
          'file6.json': '{"test": true}',
        },
      };

      await createTestStructure(testDir, structure);
    });

    it('should traverse directory recursively', async () => {
      const results = await manager.traverse(testDir, { recursive: true });

      expect(results.length).toBeGreaterThan(0);

      const filePaths = results.map(r => r.path);
      expect(filePaths.some(p => p.includes('file1.txt'))).toBe(true);
      expect(filePaths.some(p => p.includes('subdir1'))).toBe(true);
      expect(filePaths.some(p => p.includes('file5.txt'))).toBe(true);
    });

    it('should traverse directory non-recursively', async () => {
      const results = await manager.traverse(testDir, { recursive: false });

      const filePaths = results.map(r => r.path);
      expect(filePaths.some(p => p.includes('file1.txt'))).toBe(true);
      expect(filePaths.some(p => p.includes('subdir1'))).toBe(true);
      expect(filePaths.some(p => p.includes('file5.txt'))).toBe(false); // Should not include nested files
    });

    it('should include hidden files when specified', async () => {
      const results = await manager.traverse(testDir, {
        recursive: true,
        includeHidden: true,
      });

      const filePaths = results.map(r => r.path);
      expect(filePaths.some(p => p.includes('.hidden.txt'))).toBe(true);
    });

    it('should exclude hidden files by default', async () => {
      const results = await manager.traverse(testDir, {
        recursive: true,
        includeHidden: false,
      });

      const filePaths = results.map(r => r.path);
      expect(filePaths.some(p => p.includes('.hidden.txt'))).toBe(false);
    });

    it('should filter by include patterns', async () => {
      const results = await manager.traverse(testDir, {
        recursive: true,
        include: ['*.txt'],
      });

      const filePaths = results.map(r => r.path);
      expect(filePaths.every(p => p.endsWith('.txt') || results.find(r => r.path === p)?.isDirectory)).toBe(true);
    });

    it('should filter by exclude patterns', async () => {
      const results = await manager.traverse(testDir, {
        recursive: true,
        exclude: ['*.js', '*.json'],
      });

      const filePaths = results.map(r => r.path);
      expect(filePaths.some(p => p.endsWith('.js'))).toBe(false);
      expect(filePaths.some(p => p.endsWith('.json'))).toBe(false);
    });

    it('should respect max depth', async () => {
      const results = await manager.traverse(testDir, {
        recursive: true,
        maxDepth: 1,
      });

      // Should not include file5.txt which is at depth 2 (testDir/subdir1/subsubdir/file5.txt)
      const filePaths = results.map(r => r.path);
      expect(filePaths.some(p => p.includes('file5.txt'))).toBe(false);
    });
  });

  describe('checksum and integrity', () => {
    it('should calculate checksum for string content', () => {
      const content = 'Test content for checksum';
      const checksum = manager.calculateChecksum(content);

      expect(checksum).toBeDefined();
      expect(checksum).toHaveLength(64); // SHA-256 hex string length
      expect(typeof checksum).toBe('string');
    });

    it('should calculate checksum for buffer content', () => {
      const content = Buffer.from([1, 2, 3, 4, 5]);
      const checksum = manager.calculateChecksum(content);

      expect(checksum).toBeDefined();
      expect(checksum).toHaveLength(64);
    });

    it('should verify file integrity', async () => {
      const filePath = join(testDir, 'integrity-test.txt');
      const content = 'Content for integrity check';

      // Write file and get expected checksum
      const writeResult = await manager.safeWrite(filePath, content);
      expect(writeResult.success).toBe(true);

      const expectedChecksum = writeResult.checksum!;

      // Verify integrity
      const isValid = await manager.verifyIntegrity(filePath, expectedChecksum);
      expect(isValid).toBe(true);

      // Modify file and verify integrity fails
      await fs.appendFile(filePath, ' modified');
      const isValidAfterModification = await manager.verifyIntegrity(filePath, expectedChecksum);
      expect(isValidAfterModification).toBe(false);
    });
  });

  describe('convenience functions', () => {
    it('should export convenience functions', async () => {
      expect(typeof safeWrite).toBe('function');
      expect(typeof safeRead).toBe('function');
      expect(typeof ensureDirectory).toBe('function');
      expect(typeof safeRemove).toBe('function');
      expect(typeof copy).toBe('function');
      expect(typeof move).toBe('function');
      expect(typeof getMetadata).toBe('function');
      expect(typeof traverse).toBe('function');
    });

    it('should use default fileManager instance', async () => {
      const filePath = join(testDir, 'convenience-test.txt');
      const content = 'Convenience function test';

      const result = await safeWrite(filePath, content);

      expect(result.success).toBe(true);
      expect(await fs.pathExists(filePath)).toBe(true);
    });
  });
});

/**
 * Helper function to create test directory structure
 */
async function createTestStructure(
  basePath: string,
  structure: Record<string, any>
): Promise<void> {
  for (const [name, content] of Object.entries(structure)) {
    const fullPath = join(basePath, name);

    if (typeof content === 'string') {
      // It's a file
      await fs.writeFile(fullPath, content);
    } else if (typeof content === 'object') {
      // It's a directory
      await fs.ensureDir(fullPath);
      await createTestStructure(fullPath, content);
    }
  }
}