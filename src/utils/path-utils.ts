/**
 * PathUtils - Cross-platform path manipulation utilities with advanced
 * path operations, validation, and pattern matching.
 */

import {
  join,
  resolve,
  relative,
  dirname,
  basename,
  extname,
  parse,
  format,
  isAbsolute,
  normalize,
  sep,
  delimiter,
  posix,
  win32,
} from 'path';
import fs from 'fs-extra';
import { minimatch } from 'minimatch';
import { glob as globPromise } from 'glob';

/**
 * Path validation result
 */
export interface PathValidation {
  /** Whether the path is valid */
  valid: boolean;
  /** Path normalized for current platform */
  normalized?: string;
  /** Whether path exists */
  exists?: boolean;
  /** Type of path (file, directory, symlink, etc.) */
  type?: 'file' | 'directory' | 'symlink' | 'other';
  /** Error message if validation failed */
  error?: string;
  /** Additional warnings */
  warnings?: string[];
}

/**
 * Path information
 */
export interface PathInfo {
  /** Original path */
  original: string;
  /** Absolute path */
  absolute: string;
  /** Normalized path */
  normalized: string;
  /** Directory component */
  directory: string;
  /** Filename component */
  filename: string;
  /** Base name without extension */
  basename: string;
  /** File extension */
  extension: string;
  /** Whether path is absolute */
  isAbsolute: boolean;
  /** Whether path exists */
  exists: boolean;
  /** Path segments */
  segments: string[];
  /** Platform-specific information */
  platform: {
    posix: string;
    win32: string;
    current: string;
  };
}

/**
 * Path search options
 */
export interface PathSearchOptions {
  /** Search patterns (glob-style) */
  patterns: string[];
  /** Base directory for search */
  cwd?: string;
  /** Include hidden files/directories */
  includeHidden?: boolean;
  /** Follow symbolic links */
  followSymlinks?: boolean;
  /** Maximum search depth */
  maxDepth?: number;
  /** Exclude patterns */
  exclude?: string[];
  /** Case sensitive matching */
  caseSensitive?: boolean;
  /** Return absolute paths */
  absolute?: boolean;
}

/**
 * Path resolution options
 */
export interface PathResolutionOptions {
  /** Base directory for relative paths */
  base?: string;
  /** Whether to resolve symlinks */
  resolveSymlinks?: boolean;
  /** Whether to ensure path exists */
  mustExist?: boolean;
  /** Create directory if it doesn't exist */
  createIfMissing?: boolean;
  /** File permissions for created directories */
  mode?: number;
}

/**
 * Glob pattern matching options
 */
export interface GlobOptions {
  /** Case sensitive matching */
  caseSensitive?: boolean;
  /** Match dotfiles */
  dot?: boolean;
  /** Follow symbolic links */
  follow?: boolean;
  /** Ignore case */
  nocase?: boolean;
  /** Enable brace expansion */
  brace?: boolean;
  /** Enable extended glob patterns */
  extglob?: boolean;
}

/**
 * PathUtils class for comprehensive path manipulation
 */
export class PathUtils {
  private static instance: PathUtils;

  /**
   * Get singleton instance
   */
  public static getInstance(): PathUtils {
    if (!PathUtils.instance) {
      PathUtils.instance = new PathUtils();
    }
    return PathUtils.instance;
  }

  /**
   * Safely join path segments with validation
   */
  public safeJoin(...segments: string[]): string {
    // Filter out empty and null/undefined segments
    const validSegments = segments.filter(segment =>
      segment != null && typeof segment === 'string' && segment.trim() !== ''
    );

    if (validSegments.length === 0) {
      throw new Error('No valid path segments provided');
    }

    // Validate each segment for security
    for (const segment of validSegments) {
      if (this.isUnsafePath(segment)) {
        throw new Error(`Unsafe path segment detected: ${segment}`);
      }
    }

    return normalize(join(...validSegments));
  }

  /**
   * Resolve path with comprehensive options
   */
  public async resolvePath(
    path: string,
    options: PathResolutionOptions = {}
  ): Promise<string> {
    const {
      base = process.cwd(),
      resolveSymlinks = true,
      mustExist = false,
      createIfMissing = false,
      mode = 0o755,
    } = options;

    let resolvedPath: string;

    // Resolve relative to base if not absolute
    if (isAbsolute(path)) {
      resolvedPath = normalize(path);
    } else {
      resolvedPath = resolve(base, path);
    }

    // Resolve symlinks if requested
    if (resolveSymlinks) {
      try {
        const realPath = await fs.realpath(resolvedPath);
        resolvedPath = realPath;
      } catch (error) {
        // Path might not exist yet, continue with current resolved path
        if (mustExist) {
          throw new Error(`Path does not exist: ${resolvedPath}`);
        }
      }
    }

    // Check existence
    const exists = await fs.pathExists(resolvedPath);

    if (mustExist && !exists) {
      throw new Error(`Path must exist but was not found: ${resolvedPath}`);
    }

    if (createIfMissing && !exists) {
      // Determine if we should create a directory or file
      const hasExtension = extname(resolvedPath) !== '';

      if (hasExtension) {
        // Create parent directory for file
        const parentDir = dirname(resolvedPath);
        await fs.ensureDir(parentDir);
      } else {
        // Create directory
        await fs.ensureDir(resolvedPath);
        await fs.chmod(resolvedPath, mode);
      }
    }

    return resolvedPath;
  }

  /**
   * Validate path with comprehensive checks
   */
  public async validatePath(path: string): Promise<PathValidation> {
    const validation: PathValidation = {
      valid: false,
      warnings: [],
    };

    try {
      // Basic validation
      if (!path || typeof path !== 'string') {
        validation.error = 'Path must be a non-empty string';
        return validation;
      }

      // Security validation
      if (this.isUnsafePath(path)) {
        validation.error = 'Path contains unsafe components (e.g., path traversal)';
        return validation;
      }

      // Normalize path
      const normalized = normalize(path);
      validation.normalized = normalized;

      // Check if path exists and get type
      try {
        const stats = await fs.stat(normalized);
        validation.exists = true;

        if (stats.isFile()) {
          validation.type = 'file';
        } else if (stats.isDirectory()) {
          validation.type = 'directory';
        } else if (stats.isSymbolicLink()) {
          validation.type = 'symlink';
        } else {
          validation.type = 'other';
        }
      } catch {
        validation.exists = false;
      }

      // Platform-specific warnings
      if (process.platform === 'win32') {
        if (normalized.length > 260) {
          validation.warnings?.push('Path exceeds Windows MAX_PATH limit (260 characters)');
        }
        if (normalized.includes('<') || normalized.includes('>') || normalized.includes('|')) {
          validation.warnings?.push('Path contains characters that may be invalid on Windows');
        }
      }

      // Check for potential issues
      if (normalized.includes(' ')) {
        validation.warnings?.push('Path contains spaces which may cause issues in some contexts');
      }

      if (normalized !== path) {
        validation.warnings?.push('Path was normalized (redundant separators, . or .. components removed)');
      }

      validation.valid = true;
      return validation;
    } catch (error) {
      validation.error = error instanceof Error ? error.message : String(error);
      return validation;
    }
  }

  /**
   * Get comprehensive path information
   */
  public async getPathInfo(path: string): Promise<PathInfo> {
    const absolutePath = resolve(path);
    const normalizedPath = normalize(path);
    const parsedPath = parse(absolutePath);
    const exists = await fs.pathExists(absolutePath);

    // Split path into segments
    const segments = absolutePath.split(sep).filter(segment => segment !== '');

    return {
      original: path,
      absolute: absolutePath,
      normalized: normalizedPath,
      directory: parsedPath.dir,
      filename: parsedPath.base,
      basename: parsedPath.name,
      extension: parsedPath.ext,
      isAbsolute: isAbsolute(path),
      exists,
      segments,
      platform: {
        posix: posix.normalize(path.replace(/\\/g, '/')),
        win32: win32.normalize(path.replace(/\//g, '\\')),
        current: normalizedPath,
      },
    };
  }

  /**
   * Find files and directories using glob patterns
   */
  public async findPaths(
    patterns: string | string[],
    options: PathSearchOptions = {}
  ): Promise<string[]> {
    const {
      cwd = process.cwd(),
      includeHidden = false,
      followSymlinks = false,
      maxDepth,
      exclude = [],
      caseSensitive = true,
      absolute = false,
    } = options;

    const searchPatterns = Array.isArray(patterns) ? patterns : [patterns];
    const results = new Set<string>();

    for (const pattern of searchPatterns) {
      try {
        const globOptions = {
          cwd,
          dot: includeHidden,
          follow: followSymlinks,
          nocase: !caseSensitive,
          absolute,
          ignore: exclude,
          maxDepth,
        };

        const matches = await globPromise(pattern, globOptions);
        matches.forEach(match => results.add(match));
      } catch (error) {
        console.warn(`Glob pattern failed: ${pattern}`, error);
      }
    }

    return Array.from(results).sort();
  }

  /**
   * Check if path matches any of the given patterns
   */
  public matchesPattern(
    path: string,
    patterns: string | string[],
    options: GlobOptions = {}
  ): boolean {
    const testPatterns = Array.isArray(patterns) ? patterns : [patterns];
    const minimatchOptions = {
      nocase: !options.caseSensitive,
      dot: options.dot,
      ...options,
    };

    return testPatterns.some(pattern =>
      minimatch(path, pattern, minimatchOptions)
    );
  }

  /**
   * Get relative path between two paths
   */
  public getRelativePath(from: string, to: string): string {
    const fromAbs = resolve(from);
    const toAbs = resolve(to);
    return relative(fromAbs, toAbs);
  }

  /**
   * Get common path prefix of multiple paths
   */
  public getCommonPath(...paths: string[]): string {
    if (paths.length === 0) return '';
    if (paths.length === 1) return dirname(resolve(paths[0]));

    const resolvedPaths = paths.map(p => resolve(p));
    const segments = resolvedPaths.map(p => p.split(sep));

    let commonLength = 0;
    const minLength = Math.min(...segments.map(s => s.length));

    for (let i = 0; i < minLength; i++) {
      const segment = segments[0][i];
      if (segments.every(s => s[i] === segment)) {
        commonLength = i + 1;
      } else {
        break;
      }
    }

    if (commonLength === 0) {
      return sep; // Root directory
    }

    return segments[0].slice(0, commonLength).join(sep) || sep;
  }

  /**
   * Safely navigate up directory levels
   */
  public navigateUp(path: string, levels: number = 1): string {
    if (levels < 0) {
      throw new Error('Levels must be non-negative');
    }

    let currentPath = resolve(path);

    for (let i = 0; i < levels; i++) {
      const parentPath = dirname(currentPath);

      // Prevent navigating above root
      if (parentPath === currentPath) {
        break; // Already at root
      }

      currentPath = parentPath;
    }

    return currentPath;
  }

  /**
   * Split path into directory and filename components
   */
  public splitPath(path: string): { directory: string; filename: string } {
    const absolutePath = resolve(path);
    return {
      directory: dirname(absolutePath),
      filename: basename(absolutePath),
    };
  }

  /**
   * Change file extension
   */
  public changeExtension(path: string, newExtension: string): string {
    const parsed = parse(path);

    // Ensure extension starts with dot
    const ext = newExtension.startsWith('.') ? newExtension : `.${newExtension}`;

    return format({
      ...parsed,
      base: undefined, // Clear base to use name + ext
      ext,
    });
  }

  /**
   * Get all possible extensions for a path
   */
  public getAllExtensions(path: string): string[] {
    const filename = basename(path);
    const extensions: string[] = [];

    let currentName = filename;
    while (true) {
      const ext = extname(currentName);
      if (!ext) break;

      extensions.unshift(ext);
      currentName = basename(currentName, ext);
    }

    return extensions;
  }

  /**
   * Ensure path is within a specific directory (security check)
   */
  public isWithinDirectory(path: string, directory: string): boolean {
    const resolvedPath = resolve(path);
    const resolvedDir = resolve(directory);

    return resolvedPath.startsWith(resolvedDir + sep) || resolvedPath === resolvedDir;
  }

  /**
   * Convert path to use forward slashes (Unix-style)
   */
  public toUnixPath(path: string): string {
    return path.replace(/\\/g, '/');
  }

  /**
   * Convert path to use backslashes (Windows-style)
   */
  public toWindowsPath(path: string): string {
    return path.replace(/\//g, '\\');
  }

  /**
   * Get path suitable for current platform
   */
  public toPlatformPath(path: string): string {
    return normalize(path);
  }

  /**
   * Check if path contains unsafe components
   */
  private isUnsafePath(path: string): boolean {
    // Check for path traversal attempts
    const normalized = normalize(path);

    // Check for attempts to escape intended directory
    if (normalized.includes('..')) {
      return true;
    }

    // Check for null bytes (can be used to bypass security checks)
    if (path.includes('\0')) {
      return true;
    }

    // Check for Windows device names
    if (process.platform === 'win32') {
      const windowsDevices = [
        'CON', 'PRN', 'AUX', 'NUL',
        'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
        'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
      ];

      const pathUpper = path.toUpperCase();
      if (windowsDevices.some(device => pathUpper.includes(device))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get temporary file path with unique name
   */
  public getTempPath(prefix: string = 'tmp', extension: string = '.tmp'): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const filename = `${prefix}-${timestamp}-${random}${extension}`;

    return join(require('os').tmpdir(), filename);
  }

  /**
   * Ensure path uses correct separators for current platform
   */
  public normalizeSeparators(path: string): string {
    if (process.platform === 'win32') {
      return path.replace(/\//g, '\\');
    } else {
      return path.replace(/\\/g, '/');
    }
  }

  /**
   * Get file extension without dot
   */
  public getExtensionWithoutDot(path: string): string {
    const ext = extname(path);
    return ext.startsWith('.') ? ext.substring(1) : ext;
  }

  /**
   * Check if two paths are equal (considering platform differences)
   */
  public arePathsEqual(path1: string, path2: string): boolean {
    const resolved1 = resolve(path1);
    const resolved2 = resolve(path2);

    // Case-insensitive comparison on Windows
    if (process.platform === 'win32') {
      return resolved1.toLowerCase() === resolved2.toLowerCase();
    }

    return resolved1 === resolved2;
  }

  /**
   * Get the deepest common directory of multiple paths
   */
  public getDeepestCommonDirectory(...paths: string[]): string {
    if (paths.length === 0) return '';

    const commonPath = this.getCommonPath(...paths);

    // Ensure we return a directory, not a file
    try {
      if (fs.statSync(commonPath).isDirectory()) {
        return commonPath;
      } else {
        return dirname(commonPath);
      }
    } catch {
      // Path might not exist, assume it's a directory
      return commonPath;
    }
  }
}

/**
 * Export default instance for convenience
 */
export const pathUtils = PathUtils.getInstance();

/**
 * Convenience functions using default instance
 */
export const safeJoin = (...segments: string[]) => pathUtils.safeJoin(...segments);
export const resolvePath = (path: string, options?: PathResolutionOptions) => pathUtils.resolvePath(path, options);
export const validatePath = (path: string) => pathUtils.validatePath(path);
export const getPathInfo = (path: string) => pathUtils.getPathInfo(path);
export const findPaths = (patterns: string | string[], options?: PathSearchOptions) => pathUtils.findPaths(patterns, options);
export const matchesPattern = (path: string, patterns: string | string[], options?: GlobOptions) => pathUtils.matchesPattern(path, patterns, options);
export const getRelativePath = (from: string, to: string) => pathUtils.getRelativePath(from, to);
export const getCommonPath = (...paths: string[]) => pathUtils.getCommonPath(...paths);
export const navigateUp = (path: string, levels?: number) => pathUtils.navigateUp(path, levels);
export const changeExtension = (path: string, newExtension: string) => pathUtils.changeExtension(path, newExtension);
export const isWithinDirectory = (path: string, directory: string) => pathUtils.isWithinDirectory(path, directory);
export const toUnixPath = (path: string) => pathUtils.toUnixPath(path);
export const toWindowsPath = (path: string) => pathUtils.toWindowsPath(path);
export const toPlatformPath = (path: string) => pathUtils.toPlatformPath(path);
export const arePathsEqual = (path1: string, path2: string) => pathUtils.arePathsEqual(path1, path2);