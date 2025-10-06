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
export declare function isHeadlessEnvironment(): boolean;
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
export declare function isCIEnvironment(): boolean;
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
export declare function isInteractiveTerminal(): boolean;
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
export declare function isDevelopmentMode(): boolean;
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
export declare function getNodeEnvironment(): NodeEnvironment;
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
export declare function getEnvVar(key: string, defaultValue?: string): string | undefined;
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
export declare function getEnvVarWithDefault(key: string, defaultValue: string): string;
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
export declare function setEnvVar(key: string, value: string): void;
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
export declare function parseEnvBoolean(value: string | undefined, defaultValue?: boolean): boolean;
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
export declare function parseEnvNumber(value: string | undefined, defaultValue?: number): number;
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
export declare function parseEnvArray(value: string | undefined, delimiter?: string, defaultValue?: string[]): string[];
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
export declare function getTerminalWidth(): number;
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
export declare function getTerminalHeight(): number;
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
export declare function supportsColor(): boolean;
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
export declare function getColorSupport(): ColorSupport;
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
export declare function isInDocker(): boolean;
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
export declare function getPlatform(): Platform;
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
export declare function getArchitecture(): Architecture;
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
export declare function getShell(): ShellType;
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
export declare function getHomeDirectory(): string;
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
export declare function getTempDirectory(): string;
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
export declare function getConfigDirectory(appName?: string): string;
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
export declare function getDataDirectory(appName?: string): string;
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
export declare function getCacheDirectory(appName?: string): string;
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
export declare function createDirectoryIfNotExists(dirPath: string): Promise<void>;
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
export declare function getProcessInfo(): ProcessInfo;
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
export declare function isRunningAsRoot(): boolean;
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
export declare function getMemoryUsage(): MemoryUsage;
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
export declare function getCpuUsage(): CpuUsage;
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
export declare function findMCPServerPath(serverName?: string): Promise<string | null>;
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
export declare function validateMCPServerPath(serverPath: string): Promise<boolean>;
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
export declare function getMCPServerEnvironment(additionalEnv?: Record<string, string>): MCPServerEnvironment;
