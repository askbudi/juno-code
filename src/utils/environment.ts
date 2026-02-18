/**
 * Environment Utilities Module for juno-task-ts
 *
 * Provides comprehensive environment variable handling and detection utilities
 * for the juno-task-ts CLI tool. This module includes environment detection,
 * terminal capabilities, platform information, configuration directories,
 * and MCP server path detection.
 *
 * @module utils/environment
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { promises as fs } from 'node:fs';
// Conditional import for execSync to improve tree shaking
// import { execSync } from 'node:child_process';

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Color support levels for terminal output
 */
export type ColorSupport = 'none' | 'basic' | '256' | 'truecolor';

/**
 * Node.js environment types
 */
export type NodeEnvironment = 'development' | 'production' | 'test';

/**
 * Operating system platforms
 */
export type Platform = 'win32' | 'darwin' | 'linux' | 'freebsd' | 'openbsd' | 'sunos' | 'aix';

/**
 * System architectures
 */
export type Architecture = 'arm' | 'arm64' | 'ia32' | 'mips' | 'mipsel' | 'ppc' | 'ppc64' | 's390' | 's390x' | 'x64';

/**
 * Shell types
 */
export type ShellType = 'bash' | 'zsh' | 'fish' | 'cmd' | 'powershell' | 'unknown';

/**
 * Process information interface
 */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  platform: Platform;
  arch: Architecture;
  nodeVersion: string;
  uptime: number;
  cwd: string;
  execPath: string;
  argv: string[];
  env: Record<string, string | undefined>;
}

/**
 * Memory usage information
 */
export interface MemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

/**
 * CPU usage information
 */
export interface CpuUsage {
  user: number;
  system: number;
}

/**
 * MCP server environment configuration
 */
export interface MCPServerEnvironment {
  PATH: string;
  NODE_ENV: string;
  [key: string]: string;
}

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Detect if running in a headless/CI environment where interactive prompts should be avoided.
 * Based on the Python implementation patterns from budi-cli.
 *
 * @returns True if running in headless/CI environment
 *
 * @example
 * ```typescript
 * if (isHeadlessEnvironment()) {
 *   console.log('Using non-interactive mode');
 * }
 * ```
 */
export function isHeadlessEnvironment(): boolean {
  // Check for CI environment indicators (matches Python implementation)
  const ciIndicators = [
    'CI',
    'CONTINUOUS_INTEGRATION',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'JENKINS_URL',
    'TRAVIS',
    'CIRCLECI',
    'PYTEST_CURRENT_TEST',  // Pytest test runner
    'JUNO_TASK_HEADLESS',   // Our custom flag for headless testing
    'NODE_ENV',             // Additional Node.js specific
  ];

  for (const indicator of ciIndicators) {
    if (process.env[indicator]) {
      return true;
    }
  }

  // Check if stdin/stdout are connected to a terminal
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return true;
  }

  return false;
}

/**
 * Detect if running in a continuous integration environment.
 *
 * @returns True if running in CI environment
 *
 * @example
 * ```typescript
 * if (isCIEnvironment()) {
 *   console.log('Running in CI environment');
 * }
 * ```
 */
export function isCIEnvironment(): boolean {
  const ciIndicators = [
    'CI',
    'CONTINUOUS_INTEGRATION',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'JENKINS_URL',
    'TRAVIS',
    'CIRCLECI',
    'BUILDKITE',
    'AZURE_PIPELINES',
    'TEAMCITY_VERSION',
  ];

  return ciIndicators.some(indicator => Boolean(process.env[indicator]));
}

/**
 * Check if terminal supports interactive input/output.
 *
 * @returns True if terminal supports interaction
 *
 * @example
 * ```typescript
 * if (isInteractiveTerminal()) {
 *   // Show interactive prompts
 * }
 * ```
 */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !isHeadlessEnvironment());
}

/**
 * Detect if running in development mode.
 *
 * @returns True if in development mode
 *
 * @example
 * ```typescript
 * if (isDevelopmentMode()) {
 *   console.log('Debug logging enabled');
 * }
 * ```
 */
export function isDevelopmentMode(): boolean {
  const nodeEnv = getNodeEnvironment();
  return nodeEnv === 'development' || Boolean(process.env.DEBUG);
}

/**
 * Get Node.js environment type.
 *
 * @returns The Node.js environment type
 *
 * @example
 * ```typescript
 * const env = getNodeEnvironment();
 * console.log(`Running in ${env} mode`);
 * ```
 */
export function getNodeEnvironment(): NodeEnvironment {
  const env = process.env.NODE_ENV?.toLowerCase();

  if (env === 'production') return 'production';
  if (env === 'test') return 'test';
  return 'development';
}

// ============================================================================
// Environment Variable Utilities
// ============================================================================

/**
 * Get environment variable with optional type conversion.
 *
 * @param key - Environment variable name
 * @param defaultValue - Default value if variable is not set
 * @returns Environment variable value or default
 *
 * @example
 * ```typescript
 * const port = getEnvVar('PORT', '3000');
 * const timeout = getEnvVar('TIMEOUT', '30');
 * ```
 */
export function getEnvVar(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}

/**
 * Get environment variable with fallback value.
 *
 * @param key - Environment variable name
 * @param defaultValue - Default value if variable is not set
 * @returns Environment variable value or default
 *
 * @example
 * ```typescript
 * const logLevel = getEnvVarWithDefault('LOG_LEVEL', 'info');
 * ```
 */
export function getEnvVarWithDefault(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

/**
 * Set environment variable safely.
 *
 * @param key - Environment variable name
 * @param value - Value to set
 *
 * @example
 * ```typescript
 * setEnvVar('DEBUG', 'true');
 * ```
 */
export function setEnvVar(key: string, value: string): void {
  process.env[key] = value;
}

/**
 * Parse boolean value from environment variable string.
 *
 * @param value - Environment variable value
 * @param defaultValue - Default boolean value
 * @returns Parsed boolean value
 *
 * @example
 * ```typescript
 * const isVerbose = parseEnvBoolean(process.env.VERBOSE, false);
 * const isEnabled = parseEnvBoolean('true'); // returns true
 * ```
 */
export function parseEnvBoolean(value: string | undefined, defaultValue: boolean = false): boolean {
  if (!value) return defaultValue;

  const normalized = value.toLowerCase().trim();
  return ['true', '1', 'yes', 'on', 'enabled'].includes(normalized);
}

/**
 * Parse number value from environment variable string.
 *
 * @param value - Environment variable value
 * @param defaultValue - Default number value
 * @returns Parsed number value
 *
 * @example
 * ```typescript
 * const port = parseEnvNumber(process.env.PORT, 3000);
 * const timeout = parseEnvNumber('30'); // returns 30
 * ```
 */
export function parseEnvNumber(value: string | undefined, defaultValue: number = 0): number {
  if (!value) return defaultValue;

  const parsed = Number(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse array from delimited environment variable string.
 *
 * @param value - Environment variable value
 * @param delimiter - Delimiter to split on
 * @param defaultValue - Default array value
 * @returns Parsed array
 *
 * @example
 * ```typescript
 * const paths = parseEnvArray(process.env.SEARCH_PATHS, ':', []);
 * const hosts = parseEnvArray('host1,host2,host3', ','); // returns ['host1', 'host2', 'host3']
 * ```
 */
export function parseEnvArray(
  value: string | undefined,
  delimiter: string = ',',
  defaultValue: string[] = []
): string[] {
  if (!value) return defaultValue;

  return value.split(delimiter).map(item => item.trim()).filter(Boolean);
}

// ============================================================================
// Terminal Detection
// ============================================================================

/**
 * Get terminal width for formatting output.
 *
 * @returns Terminal width in columns
 *
 * @example
 * ```typescript
 * const width = getTerminalWidth();
 * console.log(`Terminal width: ${width} columns`);
 * ```
 */
export function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Get terminal height for formatting output.
 *
 * @returns Terminal height in rows
 *
 * @example
 * ```typescript
 * const height = getTerminalHeight();
 * console.log(`Terminal height: ${height} rows`);
 * ```
 */
export function getTerminalHeight(): number {
  return process.stdout.rows || 24;
}

/**
 * Check if terminal supports color output.
 *
 * @returns True if terminal supports colors
 *
 * @example
 * ```typescript
 * if (supportsColor()) {
 *   console.log('\x1b[32mGreen text\x1b[0m');
 * }
 * ```
 */
export function supportsColor(): boolean {
  // Check for explicit color support flags
  if (process.env.FORCE_COLOR) {
    return true;
  }

  if (process.env.NO_COLOR || process.env.NODE_DISABLE_COLORS) {
    return false;
  }

  // Check if we're in a TTY
  if (!process.stdout.isTTY) {
    return false;
  }

  // Check TERM environment variable
  const term = process.env.TERM;
  if (!term || term === 'dumb') {
    return false;
  }

  // Check for common color-supporting terminals
  const colorTerms = ['color', 'ansi', 'truecolor', '256color', 'xterm'];
  return colorTerms.some(colorTerm => term.includes(colorTerm));
}

/**
 * Get color capability level of the terminal.
 *
 * @returns Color support level
 *
 * @example
 * ```typescript
 * const colorSupport = getColorSupport();
 * if (colorSupport === 'truecolor') {
 *   // Use RGB colors
 * }
 * ```
 */
export function getColorSupport(): ColorSupport {
  if (!supportsColor()) {
    return 'none';
  }

  const term = process.env.TERM || '';
  const colorTerm = process.env.COLORTERM || '';

  // Check for truecolor support
  if (colorTerm === 'truecolor' || term.includes('truecolor')) {
    return 'truecolor';
  }

  // Check for 256 color support
  if (term.includes('256') || term.includes('256color')) {
    return '256';
  }

  // Default to basic color support
  return 'basic';
}

/**
 * Detect if running inside a Docker container.
 *
 * @returns True if running in Docker
 *
 * @example
 * ```typescript
 * if (isInDocker()) {
 *   console.log('Running in Docker container');
 * }
 * ```
 */
export function isInDocker(): boolean {
  try {
    // Check for .dockerenv file
    require('node:fs').accessSync('/.dockerenv');
    return true;
  } catch {
    // Check cgroup for docker
    try {
      const cgroup = require('node:fs').readFileSync('/proc/1/cgroup', 'utf8');
      return cgroup.includes('docker') || cgroup.includes('containerd');
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Platform Detection
// ============================================================================

/**
 * Get operating system platform information.
 *
 * @returns Platform information
 *
 * @example
 * ```typescript
 * const platform = getPlatform();
 * console.log(`Running on ${platform}`);
 * ```
 */
export function getPlatform(): Platform {
  return os.platform() as Platform;
}

/**
 * Get system architecture information.
 *
 * @returns System architecture
 *
 * @example
 * ```typescript
 * const arch = getArchitecture();
 * console.log(`System architecture: ${arch}`);
 * ```
 */
export function getArchitecture(): Architecture {
  return os.arch() as Architecture;
}

/**
 * Detect user's shell (bash, zsh, fish, etc.).
 *
 * @returns Detected shell type
 *
 * @example
 * ```typescript
 * const shell = getShell();
 * console.log(`User shell: ${shell}`);
 * ```
 */
export function getShell(): ShellType {
  const shell = process.env.SHELL || process.env.ComSpec || '';
  const shellName = path.basename(shell).toLowerCase();

  if (shellName.includes('bash')) return 'bash';
  if (shellName.includes('zsh')) return 'zsh';
  if (shellName.includes('fish')) return 'fish';
  if (shellName.includes('cmd')) return 'cmd';
  if (shellName.includes('powershell') || shellName.includes('pwsh')) return 'powershell';

  return 'unknown';
}

/**
 * Get user home directory path.
 *
 * @returns User home directory path
 *
 * @example
 * ```typescript
 * const home = getHomeDirectory();
 * console.log(`Home directory: ${home}`);
 * ```
 */
export function getHomeDirectory(): string {
  return os.homedir();
}

/**
 * Get system temporary directory path.
 *
 * @returns System temp directory path
 *
 * @example
 * ```typescript
 * const temp = getTempDirectory();
 * console.log(`Temp directory: ${temp}`);
 * ```
 */
export function getTempDirectory(): string {
  return os.tmpdir();
}

// ============================================================================
// Configuration Directories
// ============================================================================

/**
 * Get user configuration directory path.
 * Follows XDG Base Directory specification on Unix systems.
 *
 * @param appName - Application name for subdirectory
 * @returns Configuration directory path
 *
 * @example
 * ```typescript
 * const configDir = getConfigDirectory('juno-task');
 * // Returns: ~/.config/juno-task (Linux), ~/Library/Application Support/juno-task (macOS), etc.
 * ```
 */
export function getConfigDirectory(appName: string = 'juno-task'): string {
  const platform = getPlatform();
  const home = getHomeDirectory();

  switch (platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', appName);
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), appName);
  }
}

/**
 * Get user data directory path.
 *
 * @param appName - Application name for subdirectory
 * @returns Data directory path
 *
 * @example
 * ```typescript
 * const dataDir = getDataDirectory('juno-task');
 * ```
 */
export function getDataDirectory(appName: string = 'juno-task'): string {
  const platform = getPlatform();
  const home = getHomeDirectory();

  switch (platform) {
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), appName);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', appName);
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), appName);
  }
}

/**
 * Get user cache directory path.
 *
 * @param appName - Application name for subdirectory
 * @returns Cache directory path
 *
 * @example
 * ```typescript
 * const cacheDir = getCacheDirectory('juno-task');
 * ```
 */
export function getCacheDirectory(appName: string = 'juno-task'): string {
  const platform = getPlatform();
  const home = getHomeDirectory();

  switch (platform) {
    case 'win32':
      return path.join(process.env.TEMP || path.join(home, 'AppData', 'Local', 'Temp'), appName);
    case 'darwin':
      return path.join(home, 'Library', 'Caches', appName);
    default:
      return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), appName);
  }
}

/**
 * Create directory if it doesn't exist.
 *
 * @param dirPath - Directory path to create
 * @returns Promise that resolves when directory is created
 *
 * @example
 * ```typescript
 * await createDirectoryIfNotExists('/path/to/config');
 * ```
 */
export async function createDirectoryIfNotExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

// ============================================================================
// Process Information
// ============================================================================

/**
 * Get current process information.
 *
 * @returns Process information object
 *
 * @example
 * ```typescript
 * const info = getProcessInfo();
 * console.log(`Process ID: ${info.pid}`);
 * ```
 */
export function getProcessInfo(): ProcessInfo {
  return {
    pid: process.pid,
    ppid: process.ppid || 0,
    platform: getPlatform(),
    arch: getArchitecture(),
    nodeVersion: process.version,
    uptime: process.uptime(),
    cwd: process.cwd(),
    execPath: process.execPath,
    argv: process.argv,
    env: process.env as Record<string, string | undefined>,
  };
}

/**
 * Check if running with root/administrator privileges.
 *
 * @returns True if running as root
 *
 * @example
 * ```typescript
 * if (isRunningAsRoot()) {
 *   console.warn('Running with elevated privileges');
 * }
 * ```
 */
export function isRunningAsRoot(): boolean {
  const platform = getPlatform();

  if (platform === 'win32') {
    // On Windows, check if user is in Administrators group
    try {
      // Dynamic import to improve tree shaking
      const { execSync } = require('node:child_process');
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  } else {
    // On Unix-like systems, check UID
    return process.getuid?.() === 0;
  }
}

/**
 * Get process memory usage information.
 *
 * @returns Memory usage information
 *
 * @example
 * ```typescript
 * const memory = getMemoryUsage();
 * console.log(`Heap used: ${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`);
 * ```
 */
export function getMemoryUsage(): MemoryUsage {
  return process.memoryUsage();
}

/**
 * Get CPU usage information.
 *
 * @returns CPU usage information
 *
 * @example
 * ```typescript
 * const cpu = getCpuUsage();
 * console.log(`User CPU time: ${cpu.user}μs`);
 * ```
 */
export function getCpuUsage(): CpuUsage {
  return process.cpuUsage();
}

// ============================================================================
// MCP Server Path Detection
// ============================================================================

/**
 * Auto-discover MCP server location.
 * Searches common installation paths and PATH environment variable.
 *
 * @param serverName - MCP server executable name
 * @returns Promise that resolves to server path or null if not found
 *
 * @example
 * ```typescript
 * const serverPath = await findMCPServerPath('mcp-server');
 * if (serverPath) {
 *   console.log(`Found MCP server at: ${serverPath}`);
 * }
 * ```
 */
export async function findMCPServerPath(serverName: string = 'mcp-server'): Promise<string | null> {
  const platform = getPlatform();
  const searchPaths: string[] = [];

  // Add PATH directories
  const pathEnv = process.env.PATH || '';
  searchPaths.push(...pathEnv.split(path.delimiter));

  // Add platform-specific common paths
  if (platform === 'win32') {
    searchPaths.push(
      'C:\\Program Files\\MCP\\bin',
      'C:\\Program Files (x86)\\MCP\\bin',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MCP', 'bin')
    );
  } else {
    searchPaths.push(
      '/usr/local/bin',
      '/usr/bin',
      '/opt/mcp/bin',
      path.join(getHomeDirectory(), '.local', 'bin'),
      path.join(getHomeDirectory(), 'bin')
    );
  }

  // Add executable extension on Windows
  const executable = platform === 'win32' ? `${serverName}.exe` : serverName;

  // Search for the executable
  for (const searchPath of searchPaths) {
    if (!searchPath) continue;

    const fullPath = path.join(searchPath, executable);
    try {
      await fs.access(fullPath, fs.constants.F_OK | fs.constants.X_OK);
      return fullPath;
    } catch {
      // Continue searching
    }
  }

  return null;
}

/**
 * Verify MCP server path is executable.
 *
 * @param serverPath - Path to MCP server executable
 * @returns Promise that resolves to true if valid and executable
 *
 * @example
 * ```typescript
 * const isValid = await validateMCPServerPath('/usr/local/bin/mcp-server');
 * if (isValid) {
 *   console.log('MCP server is valid and executable');
 * }
 * ```
 */
export async function validateMCPServerPath(serverPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(serverPath);
    if (!stats.isFile()) {
      return false;
    }

    // Check if file is executable
    await fs.access(serverPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get environment configuration for MCP server.
 *
 * @param additionalEnv - Additional environment variables
 * @returns MCP server environment configuration
 *
 * @example
 * ```typescript
 * const env = getMCPServerEnvironment({ DEBUG: 'true' });
 * console.log('MCP server environment:', env);
 * ```
 */
export function getMCPServerEnvironment(additionalEnv: Record<string, string> = {}): MCPServerEnvironment {
  const baseEnv = {
    PATH: process.env.PATH || '',
    NODE_ENV: getNodeEnvironment(),
    HOME: getHomeDirectory(),
    TMPDIR: getTempDirectory(),
  };

  return {
    ...baseEnv,
    ...additionalEnv,
  };
}