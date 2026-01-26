/**
 * Core configuration module for juno-code
 *
 * Provides comprehensive configuration management with multi-source loading,
 * validation, and environment variable support.
 *
 * @module core/config
 */

import { z } from 'zod';
import * as path from 'node:path';
import * as nodeFs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as yaml from 'js-yaml';
import fs from 'fs-extra';
import type {
  JunoTaskConfig,
  Hooks,
  HookType,
  Hook
} from '../types/index';
import type { ProfileManager } from './profiles.js';
import { getDefaultHooks } from '../templates/default-hooks.js';

/**
 * Environment variable mapping for configuration options
 * All config options can be set via JUNO_CODE_* environment variables
 * Backward compatibility maintained for JUNO_TASK_* variables
 */
export const ENV_VAR_MAPPING = {
  // Core settings
  JUNO_CODE_DEFAULT_SUBAGENT: 'defaultSubagent',
  JUNO_CODE_DEFAULT_BACKEND: 'defaultBackend',
  JUNO_CODE_DEFAULT_MAX_ITERATIONS: 'defaultMaxIterations',
  JUNO_CODE_DEFAULT_MODEL: 'defaultModel',

  // Logging settings
  JUNO_CODE_LOG_LEVEL: 'logLevel',
  JUNO_CODE_LOG_FILE: 'logFile',
  JUNO_CODE_VERBOSE: 'verbose',
  JUNO_CODE_QUIET: 'quiet',

  // MCP settings
  JUNO_CODE_MCP_TIMEOUT: 'mcpTimeout',
  JUNO_CODE_MCP_RETRIES: 'mcpRetries',
  JUNO_CODE_MCP_SERVER_PATH: 'mcpServerPath',
  JUNO_CODE_MCP_SERVER_NAME: 'mcpServerName',

  // Hook settings
  JUNO_CODE_HOOK_COMMAND_TIMEOUT: 'hookCommandTimeout',

  // Quota/hourly limit settings
  JUNO_CODE_ON_HOURLY_LIMIT: 'onHourlyLimit',

  // TUI settings
  JUNO_CODE_INTERACTIVE: 'interactive',
  JUNO_CODE_HEADLESS_MODE: 'headlessMode',

  // Paths
  JUNO_CODE_WORKING_DIRECTORY: 'workingDirectory',
  JUNO_CODE_SESSION_DIRECTORY: 'sessionDirectory',
} as const;

/**
 * Legacy environment variable mapping for backward compatibility
 * Maps old JUNO_TASK_* variables to the same config keys
 */
export const LEGACY_ENV_VAR_MAPPING = {
  // Core settings
  JUNO_TASK_DEFAULT_SUBAGENT: 'defaultSubagent',
  JUNO_TASK_DEFAULT_BACKEND: 'defaultBackend',
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
  JUNO_TASK_MCP_SERVER_NAME: 'mcpServerName',

  // Hook settings
  JUNO_TASK_HOOK_COMMAND_TIMEOUT: 'hookCommandTimeout',

  // Quota/hourly limit settings
  JUNO_TASK_ON_HOURLY_LIMIT: 'onHourlyLimit',

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
 * Zod schema for validating backend types
 */
const BackendTypeSchema = z.enum(['mcp', 'shell']);

/**
 * Zod schema for validating log levels
 */
const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace']);

/**
 * Zod schema for validating on-hourly-limit behavior
 */
const OnHourlyLimitSchema = z.enum(['wait', 'raise']);

/**
 * Zod schema for validating hook types
 */
const HookTypeSchema = z.enum(['START_RUN', 'START_ITERATION', 'END_ITERATION', 'END_RUN']);

/**
 * Zod schema for validating individual hook configuration
 */
const HookSchema = z.object({
  commands: z.array(z.string()).describe('List of bash commands to execute for this hook')
});

/**
 * Zod schema for validating hooks configuration
 * Maps hook types to their respective configurations
 */
const HooksSchema = z.record(HookTypeSchema, HookSchema).optional();

/**
 * Zod schema for validating JunoTaskConfig
 * Provides runtime validation with detailed error messages
 */
export const JunoTaskConfigSchema = z.object({
  // Core settings
  defaultSubagent: SubagentTypeSchema
    .describe('Default subagent to use for task execution'),

  defaultBackend: BackendTypeSchema
    .describe('Default backend to use for task execution'),

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
    // Allow very large timeouts to satisfy real-world workflows and user tests
    // User feedback requires accepting values like 6,000,000 ms (100 minutes)
    .max(86400000) // up to 24 hours
    .describe('MCP server timeout in milliseconds'),

  mcpRetries: z.number()
    .int()
    .min(0)
    .max(10)
    .describe('Number of retries for MCP operations'),

  mcpServerPath: z.string()
    .optional()
    .describe('Path to MCP server executable (auto-discovered if not specified)'),

  mcpServerName: z.string()
    .optional()
    .describe('Named MCP server to connect to (e.g., "roundtable-ai")'),

  // Hook settings
  hookCommandTimeout: z.number()
    .int()
    .min(1000)
    .max(3600000) // up to 1 hour
    .optional()
    .describe('Timeout for individual hook commands in milliseconds (default: 300000 = 5 minutes)'),

  // Quota/hourly limit settings
  onHourlyLimit: OnHourlyLimitSchema
    .describe('Behavior when Claude hourly quota limit is reached: "wait" to sleep until reset, "raise" to exit immediately'),

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

  // Hooks configuration
  hooks: HooksSchema
    .describe('Hook system configuration for executing commands at specific lifecycle events'),
}).strict();

/**
 * Default configuration values
 * These are used as fallbacks when no other configuration is provided
 */
export const DEFAULT_CONFIG: JunoTaskConfig = {
  // Core settings
  defaultSubagent: 'claude',
  defaultBackend: 'shell',
  defaultMaxIterations: 50,

  // Logging settings
  logLevel: 'info',
  verbose: false,
  quiet: false,

  // MCP settings (also used by shell backend)
  mcpTimeout: 43200000, // 43200 seconds (12 hours) - default for long-running shell backend operations
  mcpRetries: 3,
  mcpServerName: 'roundtable-ai', // Default to roundtable-ai server

  // Quota/hourly limit settings
  onHourlyLimit: 'raise', // Default to exit immediately when hourly limit is reached

  // TUI settings
  interactive: true,
  headlessMode: false,

  // Paths
  workingDirectory: process.cwd(),
  sessionDirectory: path.join(process.cwd(), '.juno_task'),

  // Hooks configuration - populated with default hooks template
  hooks: getDefaultHooks(),
};

/**
 * Global configuration file names to search for
 * Searched in order of preference (after project-specific config)
 */
const GLOBAL_CONFIG_FILE_NAMES = [
  'juno-code.config.json',
  'juno-code.config.js',
  '.juno-coderc.json',
  '.juno-coderc.js',
  'package.json', // Will look for 'junoCode' field
] as const;

/**
 * Project-specific configuration file (highest precedence for project settings)
 */
const PROJECT_CONFIG_FILE = '.juno_task/config.json';

/**
 * Supported configuration file formats
 */
type ConfigFileFormat = 'json' | 'yaml' | 'toml' | 'js';

/**
 * Configuration source types for precedence handling
 * Precedence order: cli > env > projectFile > file > profile > defaults
 */
type ConfigSource = 'defaults' | 'profile' | 'file' | 'projectFile' | 'env' | 'cli';

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
 * Maps JUNO_CODE_* environment variables to config properties with backward compatibility for JUNO_TASK_*
 * Prioritizes new JUNO_CODE_* variables over legacy JUNO_TASK_* variables
 *
 * @returns Partial configuration from environment variables
 */
function loadConfigFromEnv(): Partial<JunoTaskConfig> {
  const config: Partial<JunoTaskConfig> = {};

  // First, load from new JUNO_CODE_* environment variables
  for (const [envVar, configKey] of Object.entries(ENV_VAR_MAPPING)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      (config as any)[configKey] = parseEnvValue(value);
    }
  }

  // Then, load from legacy JUNO_TASK_* environment variables (only if not already set by new variables)
  for (const [envVar, configKey] of Object.entries(LEGACY_ENV_VAR_MAPPING)) {
    const value = process.env[envVar];
    if (value !== undefined && (config as any)[configKey] === undefined) {
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
 * Looks for configuration in the 'junoCode' field
 *
 * @param filePath - Path to package.json
 * @returns Parsed configuration object
 */
async function loadPackageJsonConfig(filePath: string): Promise<Partial<JunoTaskConfig>> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const packageJson = JSON.parse(content);
    return packageJson.junoCode || {};
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
      // For files like .juno-coderc (no extension), assume JSON
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
    await fsPromises.access(resolvedPath, nodeFs.constants.R_OK);
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
 * Find project-specific configuration file
 * Looks for .juno_task/config.json in the specified directory
 *
 * @param searchDir - Directory to search for project configuration file
 * @returns Path to found project config file, or null if none found
 */
async function findProjectConfigFile(searchDir: string = process.cwd()): Promise<string | null> {
  const filePath = path.join(searchDir, PROJECT_CONFIG_FILE);

  try {
    await fsPromises.access(filePath, nodeFs.constants.R_OK);
    return filePath;
  } catch {
    // File doesn't exist or isn't readable
    return null;
  }
}

/**
 * Find global configuration file in the specified directory
 * Searches for global config files in order of preference
 *
 * @param searchDir - Directory to search for global configuration files
 * @returns Path to found global config file, or null if none found
 */
async function findGlobalConfigFile(searchDir: string = process.cwd()): Promise<string | null> {
  for (const fileName of GLOBAL_CONFIG_FILE_NAMES) {
    const filePath = path.join(searchDir, fileName);

    try {
      await fsPromises.access(filePath, nodeFs.constants.R_OK);
      return filePath;
    } catch {
      // File doesn't exist or isn't readable, continue searching
      continue;
    }
  }

  return null;
}

/**
 * Find configuration file in the specified directory (legacy function for backward compatibility)
 * Searches for config files in order of preference
 *
 * @param searchDir - Directory to search for configuration files
 * @returns Path to found configuration file, or null if none found
 * @deprecated Use findProjectConfigFile and findGlobalConfigFile for proper precedence handling
 */
async function findConfigFile(searchDir: string = process.cwd()): Promise<string | null> {
  for (const fileName of GLOBAL_CONFIG_FILE_NAMES) {
    const filePath = path.join(searchDir, fileName);

    try {
      await fsPromises.access(filePath, nodeFs.constants.R_OK);
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
 * Implements configuration precedence: CLI args > Environment Variables > Project Config > Global Config Files > Profile > Defaults
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
   * Load configuration from project-specific config file
   * Loads from .juno_task/config.json with highest precedence for project settings
   *
   * @returns This ConfigLoader instance for method chaining
   */
  async fromProjectConfig(): Promise<this> {
    try {
      const projectConfigFile = await findProjectConfigFile(this.baseDir);
      if (projectConfigFile) {
        const fileConfig = await loadConfigFromFile(projectConfigFile);
        this.configSources.set('projectFile', fileConfig);
      }
    } catch (error) {
      throw new Error(`Failed to load project configuration file: ${error}`);
    }
    return this;
  }

  /**
   * Automatically discover and load configuration files
   * Searches for both project-specific and global config files in the base directory
   * Project-specific config (.juno_task/config.json) takes precedence over global configs
   *
   * @returns This ConfigLoader instance for method chaining
   */
  async autoDiscoverFile(): Promise<this> {
    // First, try to load project-specific config
    const projectConfigFile = await findProjectConfigFile(this.baseDir);
    if (projectConfigFile) {
      const fileConfig = await loadConfigFromFile(projectConfigFile);
      this.configSources.set('projectFile', fileConfig);
    }

    // Then, try to load global config file
    const globalConfigFile = await findGlobalConfigFile(this.baseDir);
    if (globalConfigFile) {
      const fileConfig = await loadConfigFromFile(globalConfigFile);
      this.configSources.set('file', fileConfig);
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
   * Load configuration from active profile
   *
   * @param profileManager - ProfileManager instance to load active profile from
   * @returns This ConfigLoader instance for method chaining
   */
  async fromProfile(profileManager: ProfileManager): Promise<this> {
    try {
      const profileConfig = await profileManager.getActiveProfile();
      this.configSources.set('profile', profileConfig);
    } catch (error) {
      // If profile loading fails, we continue without profile config
      // This allows the system to work even if profiles are misconfigured
      console.warn(`Warning: Failed to load active profile: ${error}`);
    }
    return this;
  }

  /**
   * Merge all configuration sources according to precedence
   * CLI args > Environment Variables > Project Config > Global Config Files > Profile > Defaults
   *
   * @returns Merged configuration object
   */
  merge(): JunoTaskConfig {
    // Start with defaults to ensure all required properties are present
    const mergedConfig = { ...DEFAULT_CONFIG };

    // Apply sources in order of precedence (lowest to highest)
    const sourcePrecedence: ConfigSource[] = ['profile', 'file', 'projectFile', 'env', 'cli'];

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
   * @param profileManager - Optional ProfileManager for profile support
   * @returns Promise resolving to validated configuration
   */
  async loadAll(cliConfig?: Partial<JunoTaskConfig>, profileManager?: ProfileManager): Promise<JunoTaskConfig> {
    // Load from environment
    this.fromEnvironment();

    // Load from active profile if available
    if (profileManager) {
      await this.fromProfile(profileManager);
    }

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
 * Ensure hooks configuration exists in project config file
 *
 * This function handles auto-migration for the hooks configuration:
 * - If .juno_task/config.json doesn't exist: create it with default config including empty hooks section
 * - If it exists but has no "hooks" field: add hooks: {} to the file
 * - Preserve all existing configuration
 *
 * @param baseDir - Base directory where .juno_task directory should be located
 * @returns Promise that resolves when migration is complete
 */
async function ensureHooksConfig(baseDir: string): Promise<void> {
  try {
    const configDir = path.join(baseDir, '.juno_task');
    const configPath = path.join(configDir, 'config.json');

    // Ensure the .juno_task directory exists
    await fs.ensureDir(configDir);

    // Check if config file exists
    const configExists = await fs.pathExists(configPath);

    // Use default hooks template with file size monitoring commands
    const allHookTypes = getDefaultHooks();

    if (!configExists) {
      // Create new config file with default config including all hook types
      const defaultConfig = {
        ...DEFAULT_CONFIG,
        hooks: allHookTypes
      };
      await fs.writeJson(configPath, defaultConfig, { spaces: 2 });
    } else {
      // Read existing config and ensure hooks field exists with all hook types
      const existingConfig = await fs.readJson(configPath);
      let needsUpdate = false;

      // If hooks field doesn't exist, add it with all hook types
      if (!existingConfig.hooks) {
        existingConfig.hooks = allHookTypes;
        needsUpdate = true;
      }

      // Migration: Add defaultModel if missing (for configs created before this feature)
      if (!existingConfig.defaultModel) {
        // Determine default model based on defaultSubagent
        const subagent = existingConfig.defaultSubagent || 'claude';
        const modelDefaults: Record<string, string> = {
          claude: ':sonnet',
          codex: 'gpt-5',
          gemini: 'gemini-2.5-pro',
          cursor: 'auto'
        };
        existingConfig.defaultModel = modelDefaults[subagent] || ':sonnet';
        needsUpdate = true;
      }

      if (needsUpdate) {
        await fs.writeJson(configPath, existingConfig, { spaces: 2 });
      }
    }
  } catch (error) {
    // Log warning but don't block app startup
    console.warn(`Warning: Failed to ensure hooks configuration: ${error}`);
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
 * @param options.profileManager - ProfileManager for profile support
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
 *
 * // Load with profile support
 * const config = await loadConfig({
 *   profileManager: profileManagerInstance
 * });
 * ```
 */
export async function loadConfig(options: {
  baseDir?: string;
  configFile?: string;
  cliConfig?: Partial<JunoTaskConfig>;
  profileManager?: ProfileManager;
} = {}): Promise<JunoTaskConfig> {
  const {
    baseDir = process.cwd(),
    configFile,
    cliConfig,
    profileManager
  } = options;

  // Ensure hooks configuration exists in project config (auto-migration)
  await ensureHooksConfig(baseDir);

  const loader = new ConfigLoader(baseDir);

  // Load from environment
  loader.fromEnvironment();

  // Load from active profile if available
  if (profileManager) {
    await loader.fromProfile(profileManager);
  }

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

/**
 * Re-export ProfileManager and related types for convenience
 */
export type { ProfileManager, ProfileConfig, ProfileMetadata } from './profiles.js';
export { createProfileManager, ProfileError, ProfileNotFoundError, ProfileExistsError, CircularInheritanceError } from './profiles.js';
