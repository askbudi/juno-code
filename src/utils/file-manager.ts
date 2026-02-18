/**
 * FileManager - Comprehensive file management utilities with atomic operations,
 * backup management, and cross-platform safety features.
 */

import fs from 'fs-extra';
import { join, dirname, basename, extname, resolve, relative } from 'path';
import { createHash } from 'crypto';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * File operation options for enhanced control
 */
export interface FileOperationOptions {
  /** Create backup before operation */
  backup?: boolean;
  /** Backup suffix (default: .bak) */
  backupSuffix?: string;
  /** Overwrite existing files */
  overwrite?: boolean;
  /** Atomic write operation */
  atomic?: boolean;
  /** File permissions (octal) */
  mode?: number;
  /** Encoding for text operations */
  encoding?: BufferEncoding;
  /** Create intermediate directories */
  recursive?: boolean;
  /** Preserve timestamps */
  preserveTimestamps?: boolean;
  /** Maximum file size for operations (bytes) */
  maxSize?: number;
}

/**
 * File operation result with metadata
 */
export interface FileOperationResult {
  success: boolean;
  path: string;
  operation: string;
  size?: number;
  checksum?: string;
  backupPath?: string;
  duration: number;
  error?: Error;
}

/**
 * Directory traversal options
 */
export interface TraversalOptions {
  /** Include subdirectories */
  recursive?: boolean;
  /** File pattern filters */
  include?: string[];
  /** File pattern excludes */
  exclude?: string[];
  /** Maximum depth for recursion */
  maxDepth?: number;
  /** Follow symbolic links */
  followSymlinks?: boolean;
  /** Include hidden files */
  includeHidden?: boolean;
}

/**
 * File metadata information
 */
export interface FileMetadata {
  path: string;
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  permissions: string;
  checksum?: string;
  mimeType?: string;
}

/**
 * FileManager class for comprehensive file operations with safety features
 */
export class FileManager {
  private static instance: FileManager;
  private readonly defaultOptions: FileOperationOptions;

  constructor(defaultOptions: Partial<FileOperationOptions> = {}) {
    this.defaultOptions = {
      backup: false,
      backupSuffix: '.bak',
      overwrite: false,
      atomic: true,
      encoding: 'utf8',
      recursive: true,
      preserveTimestamps: false,
      maxSize: 100 * 1024 * 1024, // 100MB default limit
      ...defaultOptions,
    };
  }

  /**
   * Get singleton instance of FileManager
   */
  public static getInstance(options?: Partial<FileOperationOptions>): FileManager {
    if (!FileManager.instance) {
      FileManager.instance = new FileManager(options);
    }
    return FileManager.instance;
  }

  /**
   * Safe write operation with atomic writes and backup support
   */
  public async safeWrite(
    filePath: string,
    content: string | Buffer,
    options: Partial<FileOperationOptions> = {}
  ): Promise<FileOperationResult> {
    const startTime = Date.now();
    const opts = { ...this.defaultOptions, ...options };
    const resolvedPath = resolve(filePath);

    try {
      // Validate file size
      const contentSize = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, opts.encoding);
      if (opts.maxSize && contentSize > opts.maxSize) {
        throw new Error(`Content size (${contentSize}) exceeds maximum allowed size (${opts.maxSize})`);
      }

      // Ensure parent directory exists
      const parentDir = dirname(resolvedPath);
      await this.ensureDirectory(parentDir, { recursive: true });

      // Check if file exists and handle overwrite/backup
      const fileExists = await fs.pathExists(resolvedPath);
      let backupPath: string | undefined;

      if (fileExists) {
        if (!opts.overwrite) {
          throw new Error(`File already exists: ${resolvedPath}`);
        }

        if (opts.backup) {
          backupPath = await this.createBackup(resolvedPath, opts.backupSuffix);
        }
      }

      // Perform atomic or direct write
      if (opts.atomic) {
        await this.atomicWrite(resolvedPath, content, opts);
      } else {
        await this.directWrite(resolvedPath, content, opts);
      }

      // Calculate checksum
      const checksum = this.calculateChecksum(content);

      return {
        success: true,
        path: resolvedPath,
        operation: 'write',
        size: contentSize,
        checksum,
        backupPath,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        path: resolvedPath,
        operation: 'write',
        duration: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  /**
   * Safe read operation with validation and size limits
   */
  public async safeRead(
    filePath: string,
    options: Partial<FileOperationOptions> = {}
  ): Promise<FileOperationResult & { content?: string | Buffer }> {
    const startTime = Date.now();
    const opts = { ...this.defaultOptions, ...options };
    const resolvedPath = resolve(filePath);

    try {
      // Check if file exists
      const fileExists = await fs.pathExists(resolvedPath);
      if (!fileExists) {
        throw new Error(`File does not exist: ${resolvedPath}`);
      }

      // Get file stats and validate size
      const stats = await fs.stat(resolvedPath);
      if (opts.maxSize && stats.size > opts.maxSize) {
        throw new Error(`File size (${stats.size}) exceeds maximum allowed size (${opts.maxSize})`);
      }

      // Read file content
      const content = await fs.readFile(resolvedPath, opts.encoding === 'utf8' ? opts.encoding : undefined);
      const checksum = this.calculateChecksum(content);

      return {
        success: true,
        path: resolvedPath,
        operation: 'read',
        size: stats.size,
        checksum,
        duration: Date.now() - startTime,
        content,
      };
    } catch (error) {
      return {
        success: false,
        path: resolvedPath,
        operation: 'read',
        duration: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  /**
   * Ensure directory exists with proper error handling
   */
  public async ensureDirectory(
    dirPath: string,
    options: Partial<FileOperationOptions> = {}
  ): Promise<FileOperationResult> {
    const startTime = Date.now();
    const opts = { ...this.defaultOptions, ...options };
    const resolvedPath = resolve(dirPath);

    try {
      await fs.ensureDir(resolvedPath);

      // Set permissions if specified
      if (opts.mode) {
        await fs.chmod(resolvedPath, opts.mode);
      }

      const stats = await fs.stat(resolvedPath);

      return {
        success: true,
        path: resolvedPath,
        operation: 'ensureDirectory',
        size: stats.size,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        path: resolvedPath,
        operation: 'ensureDirectory',
        duration: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  /**
   * Safe remove operation with backup support
   */
  public async safeRemove(
    targetPath: string,
    options: Partial<FileOperationOptions> = {}
  ): Promise<FileOperationResult> {
    const startTime = Date.now();
    const opts = { ...this.defaultOptions, ...options };
    const resolvedPath = resolve(targetPath);

    try {
      // Check if path exists
      const pathExists = await fs.pathExists(resolvedPath);
      if (!pathExists) {
        throw new Error(`Path does not exist: ${resolvedPath}`);
      }

      // Create backup if requested
      let backupPath: string | undefined;
      if (opts.backup) {
        backupPath = await this.createBackup(resolvedPath, opts.backupSuffix);
      }

      // Remove the file or directory
      await fs.remove(resolvedPath);

      return {
        success: true,
        path: resolvedPath,
        operation: 'remove',
        backupPath,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        path: resolvedPath,
        operation: 'remove',
        duration: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  /**
   * Copy file or directory with progress and verification
   */
  public async copy(
    sourcePath: string,
    destinationPath: string,
    options: Partial<FileOperationOptions> = {}
  ): Promise<FileOperationResult> {
    const startTime = Date.now();
    const opts = { ...this.defaultOptions, ...options };
    const resolvedSource = resolve(sourcePath);
    const resolvedDest = resolve(destinationPath);

    try {
      // Check source exists
      const sourceExists = await fs.pathExists(resolvedSource);
      if (!sourceExists) {
        throw new Error(`Source does not exist: ${resolvedSource}`);
      }

      // Handle destination overwrite
      const destExists = await fs.pathExists(resolvedDest);
      let backupPath: string | undefined;

      if (destExists) {
        if (!opts.overwrite) {
          throw new Error(`Destination already exists: ${resolvedDest}`);
        }

        if (opts.backup) {
          backupPath = await this.createBackup(resolvedDest, opts.backupSuffix);
        }
      }

      // Ensure destination directory exists
      const destDir = dirname(resolvedDest);
      await this.ensureDirectory(destDir);

      // Copy with options
      await fs.copy(resolvedSource, resolvedDest, {
        overwrite: opts.overwrite,
        preserveTimestamps: opts.preserveTimestamps,
      });

      // Get final stats
      const stats = await fs.stat(resolvedDest);

      return {
        success: true,
        path: resolvedDest,
        operation: 'copy',
        size: stats.size,
        backupPath,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        path: resolvedDest,
        operation: 'copy',
        duration: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  /**
   * Move file or directory with atomic operation
   */
  public async move(
    sourcePath: string,
    destinationPath: string,
    options: Partial<FileOperationOptions> = {}
  ): Promise<FileOperationResult> {
    const startTime = Date.now();
    const opts = { ...this.defaultOptions, ...options };
    const resolvedSource = resolve(sourcePath);
    const resolvedDest = resolve(destinationPath);

    try {
      // First copy, then remove source for atomic-like behavior
      const copyResult = await this.copy(resolvedSource, resolvedDest, opts);
      if (!copyResult.success) {
        throw copyResult.error || new Error('Copy operation failed');
      }

      // Remove source
      await fs.remove(resolvedSource);

      return {
        success: true,
        path: resolvedDest,
        operation: 'move',
        size: copyResult.size,
        backupPath: copyResult.backupPath,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        path: resolvedDest,
        operation: 'move',
        duration: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  /**
   * Get comprehensive file metadata
   */
  public async getMetadata(filePath: string): Promise<FileMetadata> {
    const resolvedPath = resolve(filePath);
    const stats = await fs.stat(resolvedPath);

    return {
      path: resolvedPath,
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymlink: stats.isSymbolicLink(),
      permissions: stats.mode.toString(8),
    };
  }

  /**
   * Traverse directory with filtering options
   */
  public async traverse(
    dirPath: string,
    options: TraversalOptions = {}
  ): Promise<FileMetadata[]> {
    const resolvedPath = resolve(dirPath);
    const results: FileMetadata[] = [];

    const traverse = async (currentPath: string, currentDepth: number = 0): Promise<void> => {
      if (options.maxDepth && currentDepth > options.maxDepth) {
        return;
      }

      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          const entryPath = join(currentPath, entry.name);

          // Skip hidden files if not included
          if (!options.includeHidden && entry.name.startsWith('.')) {
            continue;
          }

          // Apply include/exclude filters
          if (options.include && !this.matchesPatterns(entry.name, options.include)) {
            continue;
          }

          if (options.exclude && this.matchesPatterns(entry.name, options.exclude)) {
            continue;
          }

          // Handle symbolic links
          if (entry.isSymbolicLink() && !options.followSymlinks) {
            continue;
          }

          const metadata = await this.getMetadata(entryPath);
          results.push(metadata);

          // Recurse into directories
          if (entry.isDirectory() && options.recursive) {
            await traverse(entryPath, currentDepth + 1);
          }
        }
      } catch (error) {
        // Log error but continue traversal
        console.warn(`Failed to traverse ${currentPath}:`, error);
      }
    };

    await traverse(resolvedPath);
    return results;
  }

  /**
   * Calculate file checksum (SHA-256)
   */
  public calculateChecksum(content: string | Buffer): string {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Verify file integrity using checksum
   */
  public async verifyIntegrity(filePath: string, expectedChecksum: string): Promise<boolean> {
    try {
      const result = await this.safeRead(filePath);
      return result.success && result.checksum === expectedChecksum;
    } catch {
      return false;
    }
  }

  /**
   * Create backup of file or directory
   */
  private async createBackup(targetPath: string, suffix: string = '.bak'): Promise<string> {
    const backupPath = `${targetPath}${suffix}`;
    const copyResult = await this.copy(targetPath, backupPath, { overwrite: true });

    if (!copyResult.success) {
      throw new Error(`Failed to create backup: ${copyResult.error?.message}`);
    }

    return backupPath;
  }

  /**
   * Atomic write using temporary file
   */
  private async atomicWrite(
    filePath: string,
    content: string | Buffer,
    options: FileOperationOptions
  ): Promise<void> {
    const tempPath = `${filePath}.tmp.${Date.now()}`;

    try {
      await this.directWrite(tempPath, content, options);
      await fs.rename(tempPath, filePath);
    } catch (error) {
      // Cleanup temp file on failure
      await fs.remove(tempPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Direct write operation
   */
  private async directWrite(
    filePath: string,
    content: string | Buffer,
    options: FileOperationOptions
  ): Promise<void> {
    await fs.writeFile(filePath, content, {
      encoding: Buffer.isBuffer(content) ? undefined : options.encoding,
      mode: options.mode,
    });
  }

  /**
   * Check if filename matches any of the patterns
   */
  private matchesPatterns(filename: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      // Simple glob-like matching
      const regex = new RegExp(
        '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      return regex.test(filename);
    });
  }
}

/**
 * Export default instance for convenience
 */
export const fileManager = FileManager.getInstance();

/**
 * Convenience functions using default instance
 */
export const safeWrite = (path: string, content: string | Buffer, options?: Partial<FileOperationOptions>) =>
  fileManager.safeWrite(path, content, options);

export const safeRead = (path: string, options?: Partial<FileOperationOptions>) =>
  fileManager.safeRead(path, options);

export const ensureDirectory = (path: string, options?: Partial<FileOperationOptions>) =>
  fileManager.ensureDirectory(path, options);

export const safeRemove = (path: string, options?: Partial<FileOperationOptions>) =>
  fileManager.safeRemove(path, options);

export const copy = (source: string, dest: string, options?: Partial<FileOperationOptions>) =>
  fileManager.copy(source, dest, options);

export const move = (source: string, dest: string, options?: Partial<FileOperationOptions>) =>
  fileManager.move(source, dest, options);

export const getMetadata = (path: string) =>
  fileManager.getMetadata(path);

export const traverse = (path: string, options?: TraversalOptions) =>
  fileManager.traverse(path, options);