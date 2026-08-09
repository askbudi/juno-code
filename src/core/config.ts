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
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as yaml from 'js-yaml';
import fs from 'fs-extra';
import type { JunoTaskConfig, PromptMacroConfig } from '../types/index';
import { getDefaultHooks } from '../templates/default-hooks.js';
import { SUBAGENT_DEFAULT_MODELS } from './subagent-models.js';

/**
 * Environment variable mapping for configuration options
 * All config options can be set via JUNO_CODE_* environment variables
 * Uses JUNO_CODE_* environment variables
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
 * Zod schema for validating subagent types
 */
const SubagentTypeSchema = z.enum(['claude', 'cursor', 'codex', 'gemini', 'pi']);

/**
 * Zod schema for validating backend types
 */
const BackendTypeSchema = z.enum(['shell']);

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
const HookTypeSchema = z.enum([
  'START_RUN',
  'START_ITERATION',
  'END_ITERATION',
  'END_RUN',
  'ON_STALE',
]);

/**
 * Zod schema for validating individual hook configuration
 */
const HookSchema = z.object({
  commands: z.array(z.string()).describe('List of bash commands to execute for this hook'),
});

/**
 * Zod schema for validating hooks configuration
 * Maps hook types to their respective configurations
 */
const HooksSchema = z.record(HookTypeSchema, HookSchema).optional();

const PromptMacroOrderSchema = z.enum([
  'before_command_substitution',
  'after_command_substitution',
]);

const PromptMacroDictionarySchema = z.record(z.string(), z.string());

type RawPromptMacroValue = string | { path?: unknown; text?: unknown };
type RawPromptMacroDictionary = Record<string, RawPromptMacroValue>;

const PromptMacrosSchema = z
  .object({
    enabled: z.boolean().optional(),
    order: PromptMacroOrderSchema.optional(),
    maxDepth: z.number().int().min(1).max(100).optional(),
    global: PromptMacroDictionarySchema.optional(),
    local: PromptMacroDictionarySchema.optional(),
  })
  .strict()
  .optional();

const GitCheckpointAgentSchema = z
  .object({
    enabled: z.boolean().optional(),
    service: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export const DEFAULT_GIT_CHECKPOINT_INCLUDE = [
  '.juno_task/tasks',
  '.juno_task/ledger',
  '.juno_task/wiki',
  '.juno_task/specs',
  '.juno_task/workflows',
  '.juno_task/plan.md',
  '.juno_task/tasks.md',
  '.juno_task/managed-assets.json',
] as const;

export const PROJECT_CONFIG_VERSION = 1;

const GitCheckpointSchema = z
  .object({
    include: z.array(z.string().min(1)).optional(),
    agent: GitCheckpointAgentSchema.optional(),
  })
  .strict()
  .optional();

const GitFlowSchema = z
  .object({
    enabled: z.boolean(),
    policy: z.literal('.juno_task/config/git-flow.json'),
  })
  .strict()
  .optional();

const ControllerWorkspaceSchema = z
  .object({
    mode: z.literal('metadata-only'),
    policy: z.literal('.juno_task/config/metadata-controller.json'),
  })
  .strict()
  .optional();

const KanbanProjectAliasSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'must be a lowercase project alias');

const KanbanRegistrySchema = z
  .object({
    enabled: z.boolean(),
    allowedProjects: z.array(KanbanProjectAliasSchema).refine(
      (aliases) => new Set(aliases).size === aliases.length,
      'must not contain duplicate project aliases',
    ),
  })
  .strict()
  .optional();

/**
 * Zod schema for validating JunoTaskConfig
 * Provides runtime validation with detailed error messages
 */
export const JunoTaskConfigSchema = z
  .object({
    configVersion: z.number().int().min(1).optional().describe('Persisted project config generation'),

    // Core settings
    defaultSubagent: SubagentTypeSchema.describe('Default subagent to use for task execution'),

    defaultBackend: BackendTypeSchema.describe('Default backend to use for task execution'),

    defaultMaxIterations: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .describe('Default maximum number of iterations for task execution'),

    defaultModel: z.string().optional().describe('Default model to use for the subagent'),

    defaultModels: z
      .record(SubagentTypeSchema, z.string())
      .optional()
      .describe('Optional per-subagent default model overrides'),

    workflowModels: z
      .array(z.string().min(1).refine((value) => value === value.trim(), 'workflow model selectors must be trimmed'))
      .refine((values) => new Set(values).size === values.length, 'workflow model selectors must be unique')
      .optional()
      .describe('Exact provider/model selectors approved for explicit managed workflow use'),

    // Project metadata
    mainTask: z.string().optional().describe('Main task objective for the project'),

    // Logging settings
    logLevel: LogLevelSchema.describe('Logging level for the application'),

    logFile: z.string().optional().describe('Path to log file (optional)'),

    verbose: z.preprocess(
      (val) => {
        if (val === true) return 1;
        if (val === false) return 0;
        if (typeof val === 'string') {
          const lower = val.toLowerCase().trim();
          if (lower === 'true' || lower === 'yes') return 1;
          if (lower === 'false' || lower === 'no') return 0;
        }
        return val;
      },
      z.number().int().min(0).max(2),
    ).describe('Verbosity level: 0=quiet, 1=normal+helping texts (default), 2=debug+hooks'),

    quiet: z.boolean().describe('Enable quiet mode (minimal output)'),

    // MCP settings
    mcpTimeout: z
      .number()
      .int()
      .min(1000)
      // Allow very large timeouts to satisfy real-world workflows and user tests
      // User feedback requires accepting values like 6,000,000 ms (100 minutes)
      .max(86400000) // up to 24 hours
      .describe('MCP server timeout in milliseconds'),

    mcpRetries: z.number().int().min(0).max(10).describe('Number of retries for MCP operations'),

    mcpServerPath: z
      .string()
      .optional()
      .describe('Path to MCP server executable (auto-discovered if not specified)'),

    mcpServerName: z
      .string()
      .optional()
      .describe('Named MCP server to connect to'),

    // Hook settings
    hookCommandTimeout: z
      .number()
      .int()
      .min(1000)
      .max(3600000) // up to 1 hour
      .optional()
      .describe(
        'Timeout for individual hook commands in milliseconds (default: 300000 = 5 minutes)',
      ),

    autoDependencyUpdate: z
      .boolean()
      .optional()
      .describe(
        'Opt-out flag for automatic START_RUN dependency updates. Set false to prevent install_requirements.sh hook migration/injection.',
      ),

    // Quota/hourly limit settings
    onHourlyLimit: OnHourlyLimitSchema.describe(
      'Behavior when Claude hourly quota limit is reached: "wait" to sleep until reset, "raise" to exit immediately',
    ),

    // TUI settings
    interactive: z.boolean().describe('Enable interactive mode'),

    headlessMode: z.boolean().describe('Enable headless mode (no TUI)'),

    // Paths
    workingDirectory: z.string().describe('Working directory for task execution'),

    sessionDirectory: z.string().describe('Directory for storing session data'),

    // Controller-owned Git checkpoint configuration
    gitCheckpoint: GitCheckpointSchema.describe(
      'Allowlisted controller paths and optional read-only commit-planning agent settings',
    ),

    gitFlow: GitFlowSchema.describe(
      'Enablement and canonical policy pointer for the Python-owned Git-flow engine',
    ),

    controllerWorkspace: ControllerWorkspaceSchema.describe(
      'Canonical metadata-only controller ownership and boundary policy pointer',
    ),

    kanbanRegistry: KanbanRegistrySchema.describe(
      'Disabled-by-default cross-project Kanban routing and explicit alias allowlist',
    ),

    // Project environment bootstrap
    envFilePath: z
      .string()
      .optional()
      .describe(
        'Path to the project env file loaded before execution (relative to project root or absolute)',
      ),

    envFileCopied: z
      .boolean()
      .optional()
      .describe('Tracks whether configured env file has been initialized from .env.juno'),

    // Hooks configuration
    hooks: HooksSchema.describe(
      'Hook system configuration for executing commands at specific lifecycle events',
    ),

    // Skip hooks execution
    skipHooks: z.boolean().optional().describe('Skip execution of all lifecycle hooks when true'),

    // Prompt macro dictionary expansion
    promptMacros: PromptMacrosSchema.describe(
      'Prompt macro dictionary expansion config (@@key). Use global/local dictionaries, local overrides global, and maxDepth controls recursive expansion safety.',
    ),
  })
  .strict();

/**
 * Default configuration values
 * These are used as fallbacks when no other configuration is provided
 */
const DEFAULT_PROMPT_MACROS: PromptMacroConfig = {
  enabled: true,
  order: 'before_command_substitution',
  maxDepth: 10,
  global: {},
  local: {},
};

/** User-visible defaults persisted into fresh and upgraded project configs. */
export function createPersistedProjectConfigDefaults(baseDir: string): Record<string, unknown> {
  return {
    configVersion: PROJECT_CONFIG_VERSION,
    defaultSubagent: 'claude',
    defaultBackend: 'shell',
    defaultMaxIterations: 1,
    defaultModels: { ...SUBAGENT_DEFAULT_MODELS },
    workflowModels: [],
    logLevel: 'info',
    verbose: 1,
    quiet: false,
    mcpTimeout: 43200000,
    mcpRetries: 3,
    onHourlyLimit: 'raise',
    interactive: true,
    headlessMode: false,
    workingDirectory: baseDir,
    sessionDirectory: path.join(baseDir, '.juno_task'),
    kanbanRegistry: { enabled: false, allowedProjects: [] },
    gitCheckpoint: { include: [...DEFAULT_GIT_CHECKPOINT_INCLUDE] },
    envFilePath: '.env.juno',
    envFileCopied: false,
    hooks: getDefaultHooks(),
    autoDependencyUpdate: true,
    promptMacros: { ...DEFAULT_PROMPT_MACROS, global: {}, local: {} },
  };
}

export const DEFAULT_CONFIG = createPersistedProjectConfigDefaults(
  process.cwd(),
) as unknown as JunoTaskConfig;

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
 * Default project env file created and loaded on startup
 */
const DEFAULT_PROJECT_ENV_FILE = '.env.juno';

/**
 * Supported configuration file formats
 */
type ConfigFileFormat = 'json' | 'yaml' | 'toml' | 'js';

/**
 * Configuration source types for precedence handling
 * Precedence order: cli > env > projectFile > file > defaults
 */
type ConfigSource = 'defaults' | 'file' | 'projectFile' | 'env' | 'cli';

function normalizePromptMacrosConfig(
  value: JunoTaskConfig['promptMacros'] | undefined,
): PromptMacroConfig {
  return {
    enabled: value?.enabled ?? DEFAULT_PROMPT_MACROS.enabled,
    order: value?.order ?? DEFAULT_PROMPT_MACROS.order,
    maxDepth: value?.maxDepth ?? DEFAULT_PROMPT_MACROS.maxDepth,
    global: { ...(value?.global ?? {}) },
    local: { ...(value?.local ?? {}) },
  };
}

function mergePromptMacrosConfig(
  base: JunoTaskConfig['promptMacros'] | undefined,
  override: JunoTaskConfig['promptMacros'] | undefined,
): PromptMacroConfig {
  const baseNormalized = normalizePromptMacrosConfig(base);
  const overrideNormalized = normalizePromptMacrosConfig(override);

  return {
    enabled: override?.enabled ?? baseNormalized.enabled,
    order: override?.order ?? baseNormalized.order,
    maxDepth: override?.maxDepth ?? baseNormalized.maxDepth,
    global: {
      ...baseNormalized.global,
      ...overrideNormalized.global,
    },
    local: {
      ...baseNormalized.local,
      ...overrideNormalized.local,
    },
  };
}

export function getPromptMacroDictionary(config: Pick<JunoTaskConfig, 'promptMacros'>): Record<string, string> {
  const normalized = normalizePromptMacrosConfig(config.promptMacros);
  return {
    ...normalized.global,
    ...normalized.local,
  };
}

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
 * Maps JUNO_CODE_* environment variables to config properties
 *
 * @returns Partial configuration from environment variables
 */
function loadConfigFromEnv(): Partial<JunoTaskConfig> {
  const config: Partial<JunoTaskConfig> = {};

  for (const [envVar, configKey] of Object.entries(ENV_VAR_MAPPING) as [string, string][]) {
    const value = process.env[envVar];
    if (value !== undefined) {
      let parsed = parseEnvValue(value);
      // Normalize verbose: convert boolean to numeric level (0-2)
      if (configKey === 'verbose') {
        if (parsed === true) parsed = 1;
        else if (parsed === false) parsed = 0;
      }
      (config as any)[configKey] = parsed;
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

function isPromptMacroObject(value: unknown): value is { path?: unknown; text?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function resolvePromptMacroValue(
  keyPath: string,
  value: unknown,
  baseDir: string,
): Promise<string> {
  if (typeof value === 'string') {
    return value;
  }

  if (!isPromptMacroObject(value)) {
    throw new Error(`${keyPath} must be a string or an object with exactly one of { path, text }`);
  }

  const pathValue = value.path;
  const textValue = value.text;
  const hasPath = nonEmptyString(pathValue);
  const hasText = nonEmptyString(textValue);

  if (hasPath === hasText) {
    throw new Error(`${keyPath} must define exactly one non-empty field: path or text`);
  }

  if (hasText) {
    return textValue;
  }

  const macroPath = pathValue as string;
  const resolvedPath = path.isAbsolute(macroPath) ? macroPath : path.resolve(baseDir, macroPath);
  try {
    return await fsPromises.readFile(resolvedPath, 'utf-8');
  } catch (error) {
    throw new Error(`${keyPath} failed to read path ${resolvedPath}: ${error}`);
  }
}

async function resolvePromptMacroDictionary(
  dictionary: unknown,
  baseDir: string,
  keyPath: string,
): Promise<Record<string, string> | undefined> {
  if (dictionary === undefined) {
    return undefined;
  }
  if (!isPromptMacroObject(dictionary)) {
    throw new Error(`${keyPath} must be an object`);
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(dictionary as RawPromptMacroDictionary)) {
    resolved[key] = await resolvePromptMacroValue(`${keyPath}.${key}`, value, baseDir);
  }
  return resolved;
}

async function resolvePromptMacroFileEntries(
  config: Partial<JunoTaskConfig>,
  baseDir: string,
): Promise<Partial<JunoTaskConfig>> {
  const rawPromptMacros = config.promptMacros as unknown as
    | (Omit<PromptMacroConfig, 'global' | 'local'> & {
      global?: unknown;
      local?: unknown;
    })
    | undefined;

  if (!rawPromptMacros) {
    return config;
  }

  return {
    ...config,
    promptMacros: {
      ...rawPromptMacros,
      global: await resolvePromptMacroDictionary(rawPromptMacros.global, baseDir, 'promptMacros.global'),
      local: await resolvePromptMacroDictionary(rawPromptMacros.local, baseDir, 'promptMacros.local'),
    } as PromptMacroConfig,
  };
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
async function loadConfigFromFile(
  filePath: string,
  promptMacroPathBaseDir: string = process.cwd(),
): Promise<Partial<JunoTaskConfig>> {
  const format = getConfigFileFormat(filePath);
  const resolvedPath = resolvePath(filePath);
  const macroPathBaseDir = resolvePath(promptMacroPathBaseDir);

  // Check if file exists
  try {
    await fsPromises.access(resolvedPath, nodeFs.constants.R_OK);
  } catch {
    throw new Error(`Configuration file not readable: ${resolvedPath}`);
  }

  switch (format) {
    case 'json':
      if (path.basename(filePath) === 'package.json') {
        return resolvePromptMacroFileEntries(await loadPackageJsonConfig(resolvedPath), macroPathBaseDir);
      }
      return resolvePromptMacroFileEntries(await loadJsonConfig(resolvedPath), macroPathBaseDir);

    case 'yaml':
      return resolvePromptMacroFileEntries(await loadYamlConfig(resolvedPath), macroPathBaseDir);

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
      const fileConfig = await loadConfigFromFile(filePath, this.baseDir);
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
        const fileConfig = await loadConfigFromFile(projectConfigFile, this.baseDir);
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
      const fileConfig = await loadConfigFromFile(projectConfigFile, this.baseDir);
      this.configSources.set('projectFile', fileConfig);
    }

    // Then, try to load global config file
    const globalConfigFile = await findGlobalConfigFile(this.baseDir);
    if (globalConfigFile) {
      const fileConfig = await loadConfigFromFile(globalConfigFile, this.baseDir);
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
   * Merge all configuration sources according to precedence
   * CLI args > Environment Variables > Project Config > Global Config Files > Defaults
   *
   * @returns Merged configuration object
   */
  merge(): JunoTaskConfig {
    // Start with defaults to ensure all required properties are present
    const mergedConfig = { ...DEFAULT_CONFIG };

    // Apply sources in order of precedence (lowest to highest)
    const sourcePrecedence: ConfigSource[] = ['file', 'projectFile', 'env', 'cli'];

    for (const source of sourcePrecedence) {
      const sourceConfig = this.configSources.get(source);
      if (sourceConfig) {
        const nextPromptMacros = mergePromptMacrosConfig(
          mergedConfig.promptMacros,
          sourceConfig.promptMacros,
        );
        Object.assign(mergedConfig, sourceConfig);
        mergedConfig.promptMacros = nextPromptMacros;
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
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.') || '<root>'}: ${err.message}`)
        .join('; ');

      const hasPromptMacroSnakeCaseHint = error.errors.some((err) => {
        const typedErr = err as z.ZodIssue & { keys?: string[] };
        if (typedErr.path.join('.') === 'prompt_macros') return true;
        if (typedErr.code === 'unrecognized_keys' && Array.isArray(typedErr.keys)) {
          return typedErr.keys.some((key) =>
            ['prompt_macros', 'max_depth', 'before_command_substitution'].includes(key),
          );
        }
        return false;
      });

      const configRecord = config && typeof config === 'object' && !Array.isArray(config)
        ? config as Record<string, unknown>
        : undefined;
      const controllerWorkspace = configRecord?.controllerWorkspace;
      const hasRetiredControllerConfig = Object.prototype.hasOwnProperty.call(configRecord ?? {}, 'lifecycle') || (
        controllerWorkspace !== undefined && (
          typeof controllerWorkspace !== 'object' ||
          controllerWorkspace === null ||
          Array.isArray(controllerWorkspace) ||
          (controllerWorkspace as Record<string, unknown>).mode !== 'metadata-only' ||
          (controllerWorkspace as Record<string, unknown>).policy !== '.juno_task/config/metadata-controller.json'
        )
      );

      const hint = hasPromptMacroSnakeCaseHint
        ? ' Hint: use config.promptMacros with keys { enabled, order, maxDepth, global, local }.'
        : hasRetiredControllerConfig
          ? ' Migration required: persisted lifecycle and sparse controllerWorkspace configuration were removed; prepare a metadata-only controller using { mode: "metadata-only", policy: ".juno_task/config/metadata-controller.json" }.'
        : '';

      throw new Error(`Configuration validation failed: ${errorMessages}${hint}`);
    }
    throw error;
  }
}

/**
 * Parse dotenv-style content into key/value pairs.
 * Supports comments (#), `export KEY=VALUE`, and quoted values.
 */
function parseEnvFileContent(content: string): Record<string, string> {
  const envVars: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const line = trimmedLine.startsWith('export ') ? trimmedLine.slice(7).trim() : trimmedLine;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();

    // Handle quoted values
    if (
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) &&
      value.length >= 2
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      // Strip inline comments from unquoted values (`KEY=value # comment`)
      const inlineCommentIndex = value.indexOf(' #');
      if (inlineCommentIndex >= 0) {
        value = value.slice(0, inlineCommentIndex).trimEnd();
      }
    }

    envVars[key] = value;
  }

  return envVars;
}

/**
 * Load environment variables from a dotenv-style file into process.env.
 * Variables from the file override existing process.env values.
 */
async function loadEnvFileIntoProcess(envFilePath: string): Promise<void> {
  try {
    const content = await fsPromises.readFile(envFilePath, 'utf-8');
    const parsed = parseEnvFileContent(content);

    for (const [key, value] of Object.entries(parsed)) {
      process.env[key] = value;
    }
  } catch (error) {
    console.warn(`Warning: Failed to load env file ${envFilePath}: ${error}`);
  }
}

/**
 * Ensure project env files exist and load them before config/env precedence is evaluated.
 *
 * Behavior:
 * - Always ensure `.env.juno` exists in project root.
 * - Read `.juno_task/config.json` for optional `envFilePath` and `envFileCopied`.
 * - If a custom env path is configured and not initialized yet, copy `.env.juno` once.
 * - Load `.env.juno`, then custom env file (if different) so custom values can override defaults.
 */
async function ensureAndLoadProjectEnv(
  baseDir: string,
  allowWritesOverride?: boolean,
): Promise<void> {
  const configPath = path.join(baseDir, PROJECT_CONFIG_FILE);
  const defaultEnvPath = resolvePath(DEFAULT_PROJECT_ENV_FILE, baseDir);

  const allowProjectWrites =
    allowWritesOverride ?? process.env.JUNO_CODE_PROJECT_BOOTSTRAP_WRITES !== '0';

  // Agent startup in task/candidate worktrees is read-only. Controller startup
  // and direct loadConfig callers retain normal initialization by default.
  if (allowProjectWrites) {
    await fs.ensureFile(defaultEnvPath);
  }

  let existingConfig: Record<string, unknown> | null = null;

  if (await fs.pathExists(configPath)) {
    try {
      existingConfig = await fs.readJson(configPath);
    } catch (error) {
      console.warn(`Warning: Failed to read ${configPath} for env bootstrap: ${error}`);
    }
  }

  const configuredEnvPathRaw =
    existingConfig && typeof existingConfig.envFilePath === 'string' && existingConfig.envFilePath
      ? existingConfig.envFilePath
      : DEFAULT_PROJECT_ENV_FILE;

  const configuredEnvPath = resolvePath(configuredEnvPathRaw, baseDir);

  let envFileCopied =
    existingConfig && typeof existingConfig.envFileCopied === 'boolean'
      ? existingConfig.envFileCopied
      : false;

  let needsConfigUpdate = false;

  if (configuredEnvPath !== defaultEnvPath) {
    const configuredExists = await fs.pathExists(configuredEnvPath);

    if (!configuredExists && allowProjectWrites) {
      await fs.ensureDir(path.dirname(configuredEnvPath));
      if (!envFileCopied) {
        await fsPromises.copyFile(defaultEnvPath, configuredEnvPath);
      } else {
        await fs.ensureFile(configuredEnvPath);
      }
    }

    if (allowProjectWrites && !envFileCopied) {
      envFileCopied = true;
      needsConfigUpdate = true;
    }
  }

  if (
    allowProjectWrites &&
    existingConfig &&
    (needsConfigUpdate ||
      typeof existingConfig.envFilePath !== 'string' ||
      typeof existingConfig.envFileCopied !== 'boolean')
  ) {
    const lockPath = path.join(path.dirname(configPath), '.config.json.migration.lock');
    const lock = await acquireProjectConfigMigrationLock(lockPath);
    if (lock) {
      try {
        const originalConfigBytes = await fs.readFile(configPath);
        const currentConfig = JSON.parse(originalConfigBytes.toString('utf8')) as Record<string, unknown>;
        const updatedConfig = {
          ...currentConfig,
          envFilePath: configuredEnvPathRaw,
          envFileCopied,
        };
        await writeProjectConfigAtomic(configPath, updatedConfig, fs.rename, originalConfigBytes);
      } finally {
        await lock.close().catch(() => undefined);
        await fs.remove(lockPath).catch(() => undefined);
      }
    }
  }

  // Load existing env files in both modes; read-only startup merely refuses to
  // manufacture or migrate them.
  if (await fs.pathExists(defaultEnvPath)) {
    await loadEnvFileIntoProcess(defaultEnvPath);
  }
  if (configuredEnvPath !== defaultEnvPath && (await fs.pathExists(configuredEnvPath))) {
    await loadEnvFileIntoProcess(configuredEnvPath);
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
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Add only absent persisted defaults; scalar and array values remain user-owned. */
export function mergePersistedProjectDefaults(
  existing: Record<string, unknown>,
  defaults: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(existing, key)) {
      existing[key] = cloneJsonValue(defaultValue);
      changed = true;
      continue;
    }
    const currentValue = existing[key];
    if (
      key !== 'hooks' &&
      key !== 'defaultModels' &&
      isPlainObject(currentValue) &&
      isPlainObject(defaultValue)
    ) {
      changed = mergePersistedProjectDefaults(currentValue, defaultValue) || changed;
    }
  }
  return changed;
}

export async function writeProjectConfigAtomic(
  configPath: string,
  payload: Record<string, unknown>,
  replace: (source: string, destination: string) => Promise<void> = fs.rename,
  expectedOriginal?: Buffer,
): Promise<void> {
  const mode = (await fs.stat(configPath)).mode & 0o777;
  const tempPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode });
    if (expectedOriginal && !(await fs.readFile(configPath)).equals(expectedOriginal)) {
      throw new Error('project config changed during migration');
    }
    await replace(tempPath, configPath);
  } finally {
    await fs.remove(tempPath).catch(() => undefined);
  }
}

async function validateProjectConfigBeforeWrites(
  configPath: string,
  baseDir: string,
): Promise<void> {
  if (!(await fs.pathExists(configPath))) return;
  const projectConfig = await loadConfigFromFile(configPath, baseDir);
  validateConfig({ ...DEFAULT_CONFIG, ...projectConfig });
}

async function acquireProjectConfigMigrationLock(
  lockPath: string,
): Promise<fsPromises.FileHandle | undefined> {
  try {
    const handle = await fsPromises.open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
    return handle;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return undefined;
    throw error;
  }
}

async function ensureHooksConfig(baseDir: string): Promise<void> {
  const configDir = path.join(baseDir, '.juno_task');
  const configPath = path.join(configDir, 'config.json');
  const lockPath = path.join(configDir, '.config.json.migration.lock');
  let lock: fsPromises.FileHandle | undefined;
  try {
    await fs.ensureDir(configDir);
    lock = await acquireProjectConfigMigrationLock(lockPath);
    if (!lock) return;

    await validateProjectConfigBeforeWrites(configPath, baseDir);

    // Check if config file exists
    const configExists = await fs.pathExists(configPath);

    // Use default hooks template with file size monitoring commands
    const allHookTypes = getDefaultHooks();

    if (!configExists) {
      // Create a complete project config from the same persisted defaults used by migration.
      const defaultConfig = createPersistedProjectConfigDefaults(baseDir);
      await fs.writeJson(configPath, defaultConfig, { spaces: 2 });
    } else {
      // Read existing config and add only newly introduced persisted defaults.
      const originalConfigBytes = await fs.readFile(configPath);
      const existingConfig = JSON.parse(originalConfigBytes.toString('utf8')) as Record<string, any>;
      const persistedDefaults = createPersistedProjectConfigDefaults(baseDir);
      // A legacy single-model choice is user intent; seed the new map with it before additive merge.
      if (
        !isPlainObject(existingConfig.defaultModels) &&
        typeof existingConfig.defaultModel === 'string'
      ) {
        const selected =
          typeof existingConfig.defaultSubagent === 'string' ? existingConfig.defaultSubagent : 'claude';
        (persistedDefaults.defaultModels as Record<string, string>)[selected] =
          existingConfig.defaultModel;
      }
      let needsUpdate = mergePersistedProjectDefaults(existingConfig, persistedDefaults);
      if (
        typeof existingConfig.configVersion === 'number' &&
        existingConfig.configVersion < PROJECT_CONFIG_VERSION
      ) {
        existingConfig.configVersion = PROJECT_CONFIG_VERSION;
        needsUpdate = true;
      }

      // Hooks are user-owned and opaque. Only a wholly absent hooks section receives defaults.
      if (!existingConfig.hooks) {
        existingConfig.hooks = allHookTypes;
        needsUpdate = true;
      }

      // Migration: Add defaultModel if missing (for configs created before this feature)
      if (!Object.prototype.hasOwnProperty.call(existingConfig, 'defaultModel')) {
        const subagent = existingConfig.defaultSubagent || 'claude';
        existingConfig.defaultModel =
          SUBAGENT_DEFAULT_MODELS[subagent as keyof typeof SUBAGENT_DEFAULT_MODELS] ||
          SUBAGENT_DEFAULT_MODELS.claude;
        needsUpdate = true;
      }

      // Migration: add per-subagent default model map when absent
      if (
        !existingConfig.defaultModels ||
        typeof existingConfig.defaultModels !== 'object' ||
        Array.isArray(existingConfig.defaultModels)
      ) {
        const baseDefaults = { ...SUBAGENT_DEFAULT_MODELS } as Record<string, string>;
        const subagent = existingConfig.defaultSubagent || 'claude';
        if (typeof existingConfig.defaultModel === 'string') {
          baseDefaults[subagent] = existingConfig.defaultModel;
        }
        existingConfig.defaultModels = baseDefaults;
        needsUpdate = true;
      }

      // Existing model and iteration scalars are explicit project values and are never rewritten.

      // Ensure env bootstrap keys exist in project config
      if (!Object.prototype.hasOwnProperty.call(existingConfig, 'envFilePath')) {
        existingConfig.envFilePath = DEFAULT_PROJECT_ENV_FILE;
        needsUpdate = true;
      }

      if (typeof existingConfig.envFileCopied !== 'boolean') {
        existingConfig.envFileCopied = false;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await writeProjectConfigAtomic(configPath, existingConfig, fs.rename, originalConfigBytes);
      }
    }
  } catch (error) {
    // Invalid config or migration failures remain visible; the original file is not replaced.
    console.warn(`Warning: Failed to ensure project configuration: ${error}`);
    throw error;
  } finally {
    if (lock) {
      await lock.close().catch(() => undefined);
      await fs.remove(lockPath).catch(() => undefined);
    }
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
export async function loadConfig(
  options: {
    baseDir?: string;
    configFile?: string;
    cliConfig?: Partial<JunoTaskConfig>;
  } = {},
): Promise<JunoTaskConfig> {
  const { baseDir = process.cwd(), configFile, cliConfig } = options;

  const allowProjectWrites = process.env.JUNO_CODE_PROJECT_BOOTSTRAP_WRITES !== '0';

  const resolveConfig = async (): Promise<JunoTaskConfig> => {
    const loader = new ConfigLoader(baseDir);
    loader.fromEnvironment();
    if (configFile) {
      await loader.fromFile(configFile);
    } else {
      await loader.autoDiscoverFile();
    }
    if (cliConfig) loader.fromCli(cliConfig);
    return validateConfig(loader.merge());
  };

  // Validate every effective source before any project mutation.
  await ensureAndLoadProjectEnv(baseDir, false);
  let resolved = await resolveConfig();

  if (allowProjectWrites) {
    await ensureHooksConfig(baseDir);
    await ensureAndLoadProjectEnv(baseDir, true);
    resolved = await resolveConfig();
  }

  return resolved;
}

/**
 * Type export for configuration loading options
 */
export type ConfigLoadOptions = Parameters<typeof loadConfig>[0];

/**
 * Type export for environment variable mapping
 */
export type EnvVarMapping = typeof ENV_VAR_MAPPING;
