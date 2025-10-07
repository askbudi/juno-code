/**
 * Core configuration module for juno-task-ts
 *
 * Provides comprehensive configuration management with multi-source loading,
 * validation, and environment variable support.
 *
 * @module core/config
 */

import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as yaml from 'js-yaml';
import type {
  JunoTaskConfig
} from '../types/index';

/**
 * Environment variable mapping for configuration options
 * All config options can be set via JUNO_TASK_* environment variables
 */
export const ENV_VAR_MAPPING = {
  // Core settings
  JUNO_TASK_DEFAULT_SUBAGENT: 'defaultSubagent',
  JUNO_TASK_DEFAULT_MAX_ITERATIONS: 'defaultMaxIterations',
  JUNO_TASK_DEFAULT_MODEL: 'defaultModel',

  // Logging settings
  JUNO_TASK_LOG_LEVEL: 'logLevel',
  JUNO_TASK_LOG_FILE: 'logFile',
  JUNO_TASK_VERBOSE: 'verbose',
  JUNO_TASK_QUIET: 'quiet',

  // MCP settings
  JUNO_TASK_MCP_TIMEOUT: 'mcpTimeout',
  JUNO_TASK_MCP_RETRIES: 'mcpRetries',
  JUNO_TASK_MCP_SERVER_PATH: 'mcpServerPath',

  // TUI settings
  JUNO_TASK_INTERACTIVE: 'interactive',
  JUNO_TASK_HEADLESS_MODE: 'headlessMode',

  // Paths
  JUNO_TASK_WORKING_DIRECTORY: 'workingDirectory',
  JUNO_TASK_SESSION_DIRECTORY: 'sessionDirectory',
} as const;

/**
 * Zod schema for validating subagent types
 */
const SubagentTypeSchema = z.enum(['claude', 'cursor', 'codex', 'gemini']);

/**
 * Zod schema for validating log levels
 */
const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace']);

/**
 * Zod schema for validating JunoTaskConfig
 * Provides runtime validation with detailed error messages
 */
export const JunoTaskConfigSchema = z.object({
  // Core settings
  defaultSubagent: SubagentTypeSchema
    .describe('Default subagent to use for task execution'),

  defaultMaxIterations: z.number()
    .int()
    .min(1)
    .max(1000)
    .describe('Default maximum number of iterations for task execution'),

  defaultModel: z.string()
    .optional()
    .describe('Default model to use for the subagent'),

  // Logging settings
  logLevel: LogLevelSchema
    .describe('Logging level for the application'),

  logFile: z.string()
    .optional()
    .describe('Path to log file (optional)'),

  verbose: z.boolean()
    .describe('Enable verbose output'),

  quiet: z.boolean()
    .describe('Enable quiet mode (minimal output)'),

  // MCP settings
  mcpTimeout: z.number()
    .int()
    .min(1000)
    .max(300000)
    .describe('MCP server timeout in milliseconds'),

  mcpRetries: z.number()
    .int()
    .min(0)
    .max(10)
    .describe('Number of retries for MCP operations'),

  mcpServerPath: z.string()
    .optional()
    .describe('Path to MCP server executable (auto-discovered if not specified)'),

  // TUI settings
  interactive: z.boolean()
    .describe('Enable interactive mode'),

  headlessMode: z.boolean()
    .describe('Enable headless mode (no TUI)'),

  // Paths
  workingDirectory: z.string()
    .describe('Working directory for task execution'),

  sessionDirectory: z.string()
    .describe('Directory for storing session data'),
}).strict();

/**
 * Default configuration values
 * These are used as fallbacks when no other configuration is provided
 */
export const DEFAULT_CONFIG: JunoTaskConfig = {
  // Core settings
  defaultSubagent: 'claude',
  defaultMaxIterations: 50,

  // Logging settings
  logLevel: 'info',
  verbose: false,
  quiet: false,

  // MCP settings
  mcpTimeout: 30000, // 30 seconds
  mcpRetries: 3,

  // TUI settings
  interactive: true,
  headlessMode: false,

  // Paths
  workingDirectory: process.cwd(),
  sessionDirectory: path.join(process.cwd(), '.juno-task'),
};

/**
 * Configuration file names to search for
 * Searched in order of preference
 */
const CONFIG_FILE_NAMES = [
  'juno-task.config.json',
  'juno-task.config.js',
  '.juno-taskrc.json',
  '.juno-taskrc.js',
  'package.json', // Will look for 'junoTask' field
] as const;

/**
 * Supported configuration file formats
 */
type ConfigFileFormat = 'json' | 'yaml' | 'toml' | 'js';

/**
 * Configuration source types for precedence handling
 */
type ConfigSource = 'defaults' | 'file' | 'env' | 'cli';

/**
 * Utility function to resolve paths (relative to absolute)
 *
 * @param inputPath - The path to resolve
 * @param basePath - Base path for relative resolution (defaults to cwd)
 * @returns Absolute path
 */
function resolvePath(inputPath: string, basePath: string = process.cwd()): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(basePath, inputPath);
}

/**
 * Utility function to parse environment variables
 * Handles type conversion for boolean and number values
 *
 * @param value - Environment variable value
 * @returns Parsed value with appropriate type
 */
function parseEnvValue(value: string): string | number | boolean {
  // Handle empty string
  if (value === '') return value;

  // Handle boolean values
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  // Handle numeric values
  const numValue = Number(value);
  if (!isNaN(numValue) && isFinite(numValue)) {
    return numValue;
  }

  // Return as string
  return value;
}

/**
 * Load configuration from environment variables
 * Maps JUNO_TASK_* environment variables to config properties
 *
 * @returns Partial configuration from environment variables
 */
function loadConfigFromEnv(): Partial<JunoTaskConfig> {
  const config: Partial<JunoTaskConfig> = {};

  for (const [envVar, configKey] of Object.entries(ENV_VAR_MAPPING)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      (config as any)[configKey] = parseEnvValue(value);
    }
  }

  return config;
}

/**
 * Load configuration from a JSON file
 *
 * @param filePath - Path to the JSON configuration file
 * @returns Parsed configuration object
 */
async function loadJsonConfig(filePath: string): Promise<Partial<JunoTaskConfig>> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load JSON config from ${filePath}: ${error}`);
  }
}

/**
 * Load configuration from a YAML file
 *
 * @param filePath - Path to the YAML configuration file
 * @returns Parsed configuration object
 */
async function loadYamlConfig(filePath: string): Promise<Partial<JunoTaskConfig>> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const parsed = yaml.load(content);
    return parsed as Partial<JunoTaskConfig>;
  } catch (error) {
    throw new Error(`Failed to load YAML config from ${filePath}: ${error}`);
  }
}

/**
 * Load configuration from package.json
 * Looks for configuration in the 'junoTask' field
 *
 * @param filePath - Path to package.json
 * @returns Parsed configuration object
 */
async function loadPackageJsonConfig(filePath: string): Promise<Partial<JunoTaskConfig>> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const packageJson = JSON.parse(content);
    return packageJson.junoTask || {};
  } catch (error) {
    throw new Error(`Failed to load package.json config from ${filePath}: ${error}`);
  }
}

/**
 * Determine configuration file format based on file extension
 *
 * @param filePath - Path to the configuration file
 * @returns Configuration file format
 */
function getConfigFileFormat(filePath: string): ConfigFileFormat {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.toml':
      return 'toml';
    case '.js':
    case '.mjs':
      return 'js';
    default:
      // For files like .juno-taskrc (no extension), assume JSON
      return 'json';
  }
}

/**
 * Load configuration from a file
 * Automatically detects file format and uses appropriate parser
 *
 * @param filePath - Path to the configuration file
 * @returns Parsed configuration object
 */
async function loadConfigFromFile(filePath: string): Promise<Partial<JunoTaskConfig>> {
  const format = getConfigFileFormat(filePath);
  const resolvedPath = resolvePath(filePath);

  // Check if file exists
  try {
    await fsPromises.access(resolvedPath, fs.constants.R_OK);
  } catch {
    throw new Error(`Configuration file not readable: ${resolvedPath}`);
  }

  switch (format) {
    case 'json':
      if (path.basename(filePath) === 'package.json') {
        return loadPackageJsonConfig(resolvedPath);
      }
      return loadJsonConfig(resolvedPath);

    case 'yaml':
      return loadYamlConfig(resolvedPath);

    case 'toml':
      // TOML support would require additional dependency
      throw new Error('TOML configuration files are not yet supported');

    case 'js':
      // JavaScript config files would require dynamic import
      throw new Error('JavaScript configuration files are not yet supported');

    default:
      throw new Error(`Unsupported configuration file format: ${format}`);
  }
}

/**
 * Find configuration file in the specified directory
 * Searches for config files in order of preference
 *
 * @param searchDir - Directory to search for configuration files
 * @returns Path to found configuration file, or null if none found
 */
async function findConfigFile(searchDir: string = process.cwd()): Promise<string | null> {
  for (const fileName of CONFIG_FILE_NAMES) {
    const filePath = path.join(searchDir, fileName);

    try {
      await fsPromises.access(filePath, fs.constants.R_OK);
      return filePath;
    } catch {
      // File doesn't exist or isn't readable, continue searching
      continue;
    }
  }

  return null;
}

/**
 * ConfigLoader class for multi-source configuration loading
 *
 * Implements configuration precedence: CLI args > Environment Variables > Config Files > Defaults
 */
export class ConfigLoader {
  private configSources: Map<ConfigSource, Partial<JunoTaskConfig>> = new Map();

  /**
   * Create a new ConfigLoader instance
   *
   * @param baseDir - Base directory for relative path resolution
   */
  constructor(private baseDir: string = process.cwd()) {
    // Initialize with defaults
    this.configSources.set('defaults', DEFAULT_CONFIG);
  }

  /**
   * Load configuration from environment variables
   *
   * @returns This ConfigLoader instance for method chaining
   */
  fromEnvironment(): this {
    const envConfig = loadConfigFromEnv();
    this.configSources.set('env', envConfig);
    return this;
  }

  /**
   * Load configuration from a specific file
   *
   * @param filePath - Path to configuration file
   * @returns This ConfigLoader instance for method chaining
   */
  async fromFile(filePath: string): Promise<this> {
    try {
      const fileConfig = await loadConfigFromFile(filePath);
      this.configSources.set('file', fileConfig);
    } catch (error) {
      throw new Error(`Failed to load configuration file: ${error}`);
    }
    return this;
  }

  /**
   * Automatically discover and load configuration file
   * Searches for config files in the base directory
   *
   * @returns This ConfigLoader instance for method chaining
   */
  async autoDiscoverFile(): Promise<this> {
    const configFile = await findConfigFile(this.baseDir);
    if (configFile) {
      await this.fromFile(configFile);
    }
    return this;
  }

  /**
   * Load configuration from CLI arguments
   *
   * @param cliConfig - Configuration object from CLI argument parsing
   * @returns This ConfigLoader instance for method chaining
   */
  fromCli(cliConfig: Partial<JunoTaskConfig>): this {
    this.configSources.set('cli', cliConfig);
    return this;
  }

  /**
   * Merge all configuration sources according to precedence
   * CLI args > Environment Variables > Config Files > Defaults
   *
   * @returns Merged configuration object
   */
  merge(): JunoTaskConfig {
    // Start with defaults to ensure all required properties are present
    const mergedConfig = { ...DEFAULT_CONFIG };

    // Apply sources in order of precedence (lowest to highest)
    const sourcePrecedence: ConfigSource[] = ['file', 'env', 'cli'];

    for (const source of sourcePrecedence) {
      const sourceConfig = this.configSources.get(source);
      if (sourceConfig) {
        Object.assign(mergedConfig, sourceConfig);
      }
    }

    // Resolve paths to absolute paths
    if (mergedConfig.workingDirectory) {
      mergedConfig.workingDirectory = resolvePath(mergedConfig.workingDirectory, this.baseDir);
    }

    if (mergedConfig.sessionDirectory) {
      mergedConfig.sessionDirectory = resolvePath(mergedConfig.sessionDirectory, this.baseDir);
    }

    if (mergedConfig.logFile) {
      mergedConfig.logFile = resolvePath(mergedConfig.logFile, this.baseDir);
    }

    if (mergedConfig.mcpServerPath) {
      mergedConfig.mcpServerPath = resolvePath(mergedConfig.mcpServerPath, this.baseDir);
    }

    return mergedConfig;
  }

  /**
   * Load and merge configuration from all sources
   * Convenience method that performs auto-discovery and returns validated config
   *
   * @param cliConfig - Optional CLI configuration
   * @returns Promise resolving to validated configuration
   */
  async loadAll(cliConfig?: Partial<JunoTaskConfig>): Promise<JunoTaskConfig> {
    // Load from environment
    this.fromEnvironment();

    // Auto-discover configuration file
    await this.autoDiscoverFile();

    // Add CLI config if provided
    if (cliConfig) {
      this.fromCli(cliConfig);
    }

    // Merge and return
    return this.merge();
  }
}

/**
 * Validate configuration object against schema
 *
 * @param config - Configuration object to validate
 * @returns Validated configuration object
 * @throws Error if validation fails
 */
export function validateConfig(config: unknown): JunoTaskConfig {
  try {
    const parsed = JunoTaskConfigSchema.parse(config);
    return parsed as JunoTaskConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map(err =>
        `${err.path.join('.')}: ${err.message}`
      ).join('; ');
      throw new Error(`Configuration validation failed: ${errorMessages}`);
    }
    throw error;
  }
}

/**
 * Load and validate configuration from all sources
 *
 * This is the main entry point for configuration loading.
 * It performs auto-discovery, merging, and validation.
 *
 * @param options - Configuration loading options
 * @param options.baseDir - Base directory for relative path resolution
 * @param options.configFile - Specific configuration file to load
 * @param options.cliConfig - CLI configuration override
 * @returns Promise resolving to validated configuration
 *
 * @example
 * ```typescript
 * // Load with auto-discovery
 * const config = await loadConfig();
 *
 * // Load with specific file
 * const config = await loadConfig({
 *   configFile: './my-config.json'
 * });
 *
 * // Load with CLI overrides
 * const config = await loadConfig({
 *   cliConfig: { verbose: true, logLevel: 'debug' }
 * });
 * ```
 */
export async function loadConfig(options: {
  baseDir?: string;
  configFile?: string;
  cliConfig?: Partial<JunoTaskConfig>;
} = {}): Promise<JunoTaskConfig> {
  const {
    baseDir = process.cwd(),
    configFile,
    cliConfig
  } = options;

  const loader = new ConfigLoader(baseDir);

  // Load from environment
  loader.fromEnvironment();

  // Load from specific file or auto-discover
  if (configFile) {
    await loader.fromFile(configFile);
  } else {
    await loader.autoDiscoverFile();
  }

  // Add CLI config if provided
  if (cliConfig) {
    loader.fromCli(cliConfig);
  }

  // Merge and validate
  const mergedConfig = loader.merge();
  return validateConfig(mergedConfig);
}

/**
 * Type export for configuration loading options
 */
export type ConfigLoadOptions = Parameters<typeof loadConfig>[0];

/**
 * Type export for environment variable mapping
 */
export type EnvVarMapping = typeof ENV_VAR_MAPPING;