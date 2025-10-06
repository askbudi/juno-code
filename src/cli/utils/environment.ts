/**
 * Environment Variable Utilities for juno-task-ts CLI
 *
 * Provides comprehensive environment variable mapping, validation, and processing
 * for CLI options integration with automatic type conversion and validation.
 */

import type {
  ENVIRONMENT_MAPPINGS,
  EnvironmentVariable,
  CLIOptionKey,
  AllCommandOptions
} from '../types.js';

// Re-export environment mappings
export const ENV_MAPPINGS = {
  // Core options
  JUNO_TASK_SUBAGENT: 'subagent',
  JUNO_TASK_PROMPT: 'prompt',
  JUNO_TASK_CWD: 'cwd',
  JUNO_TASK_MAX_ITERATIONS: 'maxIterations',
  JUNO_TASK_MODEL: 'model',
  JUNO_TASK_LOG_FILE: 'logFile',
  JUNO_TASK_VERBOSE: 'verbose',
  JUNO_TASK_QUIET: 'quiet',
  JUNO_TASK_INTERACTIVE: 'interactive',
  JUNO_TASK_CONFIG: 'config',

  // MCP options
  JUNO_TASK_MCP_SERVER_PATH: 'mcpServerPath',
  JUNO_TASK_MCP_TIMEOUT: 'mcpTimeout',
  JUNO_TASK_MCP_RETRIES: 'mcpRetries',

  // Session options
  JUNO_TASK_SESSION_DIR: 'sessionDir',
  JUNO_TASK_LOG_LEVEL: 'logLevel',

  // Template options
  JUNO_TASK_TEMPLATE: 'template',
  JUNO_TASK_FORCE: 'force',

  // Git options
  JUNO_TASK_GIT_URL: 'gitUrl',

  // UI options
  JUNO_TASK_NO_COLOR: 'noColor',
  JUNO_TASK_HEADLESS: 'headless'
} as const;

// ============================================================================
// Environment Variable Processing
// ============================================================================

/**
 * Main environment variable mapper class
 */
export class EnvironmentVariableMapper {
  private static instance: EnvironmentVariableMapper;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): EnvironmentVariableMapper {
    if (!EnvironmentVariableMapper.instance) {
      EnvironmentVariableMapper.instance = new EnvironmentVariableMapper();
    }
    return EnvironmentVariableMapper.instance;
  }

  /**
   * Map all environment variables to CLI options
   */
  mapEnvironmentVariables(): Partial<AllCommandOptions> {
    const options: Partial<AllCommandOptions> = {};

    for (const [envVar, optionKey] of Object.entries(ENV_MAPPINGS)) {
      const envValue = process.env[envVar];

      if (envValue !== undefined && envValue !== '') {
        const parsedValue = this.parseEnvironmentValue(envValue, optionKey);
        if (parsedValue !== undefined) {
          (options as any)[optionKey] = parsedValue;
        }
      }
    }

    return options;
  }

  /**
   * Parse environment variable value with proper type conversion
   */
  private parseEnvironmentValue(value: string, key: string): any {
    // Handle empty strings
    if (value.trim() === '') {
      return undefined;
    }

    // Boolean values
    if (this.isBooleanOption(key)) {
      return this.parseBoolean(value);
    }

    // Number values
    if (this.isNumberOption(key)) {
      return this.parseNumber(value, key);
    }

    // Array values (comma-separated)
    if (this.isArrayOption(key)) {
      return this.parseArray(value);
    }

    // JSON values
    if (this.isJsonOption(key)) {
      return this.parseJson(value, key);
    }

    // String values (default)
    return value.trim();
  }

  /**
   * Check if option is boolean type
   */
  private isBooleanOption(key: string): boolean {
    const booleanOptions = [
      'verbose', 'quiet', 'interactive', 'force', 'noColor',
      'headless', 'showHelp', 'interactivePrompt'
    ];
    return booleanOptions.includes(key);
  }

  /**
   * Check if option is number type
   */
  private isNumberOption(key: string): boolean {
    const numberOptions = [
      'maxIterations', 'mcpTimeout', 'mcpRetries', 'limit', 'days'
    ];
    return numberOptions.includes(key);
  }

  /**
   * Check if option is array type
   */
  private isArrayOption(key: string): boolean {
    const arrayOptions = ['status', 'choices'];
    return arrayOptions.includes(key);
  }

  /**
   * Check if option is JSON type
   */
  private isJsonOption(key: string): boolean {
    const jsonOptions = ['variables', 'metadata'];
    return jsonOptions.includes(key);
  }

  /**
   * Parse boolean value from string
   */
  private parseBoolean(value: string): boolean {
    const truthyValues = ['true', '1', 'yes', 'on', 'y'];
    const falsyValues = ['false', '0', 'no', 'off', 'n'];

    const normalized = value.toLowerCase().trim();

    if (truthyValues.includes(normalized)) {
      return true;
    }

    if (falsyValues.includes(normalized)) {
      return false;
    }

    // Default to true for any non-empty string not explicitly false
    return Boolean(value.trim());
  }

  /**
   * Parse number value from string
   */
  private parseNumber(value: string, key: string): number | undefined {
    const trimmed = value.trim();

    // Handle special values
    if (key === 'maxIterations' && (trimmed === '-1' || trimmed === 'unlimited')) {
      return -1;
    }

    const num = parseInt(trimmed, 10);

    if (isNaN(num)) {
      console.warn(`Warning: Invalid number value for ${key}: ${value}`);
      return undefined;
    }

    // Validate positive numbers for most options
    if (key !== 'maxIterations' && num < 0) {
      console.warn(`Warning: Negative value not allowed for ${key}: ${value}`);
      return undefined;
    }

    return num;
  }

  /**
   * Parse array value from comma-separated string
   */
  private parseArray(value: string): string[] {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0);
  }

  /**
   * Parse JSON value from string
   */
  private parseJson(value: string, key: string): any {
    try {
      return JSON.parse(value);
    } catch (error) {
      console.warn(`Warning: Invalid JSON value for ${key}: ${value}`);
      return undefined;
    }
  }

  /**
   * Get specific environment variable value with type conversion
   */
  getEnvironmentValue<T = any>(envVar: keyof typeof ENV_MAPPINGS): T | undefined {
    const value = process.env[envVar];
    if (value === undefined) {
      return undefined;
    }

    const optionKey = ENV_MAPPINGS[envVar];
    return this.parseEnvironmentValue(value, optionKey) as T;
  }

  /**
   * Check if environment variable is set
   */
  hasEnvironmentVariable(envVar: keyof typeof ENV_MAPPINGS): boolean {
    return process.env[envVar] !== undefined;
  }

  /**
   * Get all set environment variables for debugging
   */
  getSetEnvironmentVariables(): Record<string, string> {
    const setVars: Record<string, string> = {};

    for (const envVar of Object.keys(ENV_MAPPINGS)) {
      const value = process.env[envVar];
      if (value !== undefined) {
        setVars[envVar] = value;
      }
    }

    return setVars;
  }
}

// ============================================================================
// Standard Environment Variables Support
// ============================================================================

/**
 * Handle standard environment variables (NO_COLOR, CI, etc.)
 */
export class StandardEnvironmentHandler {
  /**
   * Check if NO_COLOR is set (https://no-color.org/)
   */
  static shouldDisableColor(): boolean {
    return process.env.NO_COLOR !== undefined;
  }

  /**
   * Check if running in CI environment
   */
  static isCI(): boolean {
    return Boolean(process.env.CI);
  }

  /**
   * Check if running in debug mode
   */
  static isDebug(): boolean {
    return Boolean(process.env.DEBUG);
  }

  /**
   * Get terminal width
   */
  static getTerminalWidth(): number {
    return process.stdout.columns || 80;
  }

  /**
   * Check if TTY is available
   */
  static isTTY(): boolean {
    return Boolean(process.stdout.isTTY);
  }

  /**
   * Detect shell type from environment
   */
  static detectShell(): string {
    const shell = process.env.SHELL;
    if (shell) {
      return shell.split('/').pop() || 'bash';
    }
    return 'bash';
  }

  /**
   * Get user's home directory
   */
  static getHomeDirectory(): string {
    return process.env.HOME || process.env.USERPROFILE || '';
  }

  /**
   * Apply standard environment variable processing
   */
  static applyStandardEnvironment(options: any): any {
    const processed = { ...options };

    // Apply NO_COLOR
    if (StandardEnvironmentHandler.shouldDisableColor()) {
      processed.noColor = true;
    }

    // Apply CI environment
    if (StandardEnvironmentHandler.isCI()) {
      processed.quiet = true;
      processed.noColor = true;
    }

    // Apply DEBUG
    if (StandardEnvironmentHandler.isDebug()) {
      processed.verbose = true;
      processed.logLevel = 'debug';
    }

    return processed;
  }
}

// ============================================================================
// Validation and Utilities
// ============================================================================

/**
 * Validate environment variable values
 */
export class EnvironmentValidator {
  /**
   * Validate subagent environment variable
   */
  static validateSubagent(value?: string): boolean {
    if (!value) return true;

    const validSubagents = ['claude', 'cursor', 'codex', 'gemini', 'claude-code', 'claude_code', 'gemini-cli', 'cursor-agent'];
    return validSubagents.includes(value.toLowerCase());
  }

  /**
   * Validate log level environment variable
   */
  static validateLogLevel(value?: string): boolean {
    if (!value) return true;

    const validLevels = ['error', 'warn', 'info', 'debug', 'trace'];
    return validLevels.includes(value.toLowerCase());
  }

  /**
   * Validate max iterations environment variable
   */
  static validateMaxIterations(value?: string): boolean {
    if (!value) return true;

    if (value === '-1' || value === 'unlimited') return true;

    const num = parseInt(value, 10);
    return !isNaN(num) && num > 0;
  }

  /**
   * Validate file path environment variable
   */
  static validateFilePath(value?: string): boolean {
    if (!value) return true;

    // Basic path validation - more thorough validation done at runtime
    return value.length > 0 && !value.includes('\0');
  }

  /**
   * Validate all environment variables
   */
  static validateAll(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    const subagent = process.env.JUNO_TASK_SUBAGENT;
    if (subagent && !EnvironmentValidator.validateSubagent(subagent)) {
      errors.push(`Invalid JUNO_TASK_SUBAGENT: ${subagent}`);
    }

    const logLevel = process.env.JUNO_TASK_LOG_LEVEL;
    if (logLevel && !EnvironmentValidator.validateLogLevel(logLevel)) {
      errors.push(`Invalid JUNO_TASK_LOG_LEVEL: ${logLevel}`);
    }

    const maxIterations = process.env.JUNO_TASK_MAX_ITERATIONS;
    if (maxIterations && !EnvironmentValidator.validateMaxIterations(maxIterations)) {
      errors.push(`Invalid JUNO_TASK_MAX_ITERATIONS: ${maxIterations}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Main convenience function to get all environment options
 */
export function getEnvironmentOptions(): Partial<AllCommandOptions> {
  const mapper = EnvironmentVariableMapper.getInstance();
  const envOptions = mapper.mapEnvironmentVariables();
  return StandardEnvironmentHandler.applyStandardEnvironment(envOptions);
}

/**
 * Get specific environment option with type safety
 */
export function getEnvironmentOption<T = any>(envVar: keyof typeof ENV_MAPPINGS): T | undefined {
  const mapper = EnvironmentVariableMapper.getInstance();
  return mapper.getEnvironmentValue<T>(envVar);
}

/**
 * Check if any juno-task environment variables are set
 */
export function hasJunoTaskEnvironmentVariables(): boolean {
  return Object.keys(ENV_MAPPINGS).some(envVar => process.env[envVar] !== undefined);
}

/**
 * Print environment variable help
 */
export function printEnvironmentHelp(): void {
  console.log('Environment Variables:');
  console.log('');

  const categories = {
    'Core Options': [
      'JUNO_TASK_SUBAGENT         Default subagent (claude, cursor, codex, gemini)',
      'JUNO_TASK_PROMPT           Default prompt text or file path',
      'JUNO_TASK_CWD              Default working directory',
      'JUNO_TASK_MAX_ITERATIONS   Default maximum iterations (-1 for unlimited)',
      'JUNO_TASK_MODEL            Default model to use',
      'JUNO_TASK_CONFIG           Configuration file path'
    ],
    'Output Options': [
      'JUNO_TASK_VERBOSE          Enable verbose output (true/false)',
      'JUNO_TASK_QUIET            Enable quiet mode (true/false)',
      'JUNO_TASK_LOG_FILE         Log file path',
      'JUNO_TASK_LOG_LEVEL        Log level (error, warn, info, debug, trace)',
      'JUNO_TASK_NO_COLOR         Disable colored output (true/false)',
      'NO_COLOR                   Standard no-color flag'
    ],
    'MCP Options': [
      'JUNO_TASK_MCP_SERVER_PATH  Path to MCP server executable',
      'JUNO_TASK_MCP_TIMEOUT      MCP operation timeout (milliseconds)',
      'JUNO_TASK_MCP_RETRIES      Number of MCP retry attempts'
    ],
    'System Options': [
      'JUNO_TASK_SESSION_DIR      Session storage directory',
      'JUNO_TASK_HEADLESS         Force headless mode (true/false)',
      'CI                         CI environment flag (auto-detected)',
      'DEBUG                      Debug mode flag'
    ]
  };

  for (const [category, vars] of Object.entries(categories)) {
    console.log(`${category}:`);
    for (const varDesc of vars) {
      console.log(`  ${varDesc}`);
    }
    console.log('');
  }

  console.log('Examples:');
  console.log('  export JUNO_TASK_SUBAGENT=claude');
  console.log('  export JUNO_TASK_VERBOSE=true');
  console.log('  export JUNO_TASK_MAX_ITERATIONS=5');
  console.log('  export NO_COLOR=1');
  console.log('');
}

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Environment detection utilities
 */
export class EnvironmentDetector {
  /**
   * Check if running in headless environment
   */
  static isHeadless(): boolean {
    // Check explicit headless flag
    if (process.env.JUNO_TASK_HEADLESS === 'true' || process.env.JUNO_TASK_HEADLESS === '1') {
      return true;
    }

    // Check if running in CI
    if (StandardEnvironmentHandler.isCI()) {
      return true;
    }

    // Check if no TTY available
    if (!StandardEnvironmentHandler.isTTY()) {
      return true;
    }

    // Check if TERM is not set or is dumb
    const term = process.env.TERM;
    if (!term || term === 'dumb') {
      return true;
    }

    return false;
  }

  /**
   * Check if interactive features are available
   */
  static isInteractiveCapable(): boolean {
    return !EnvironmentDetector.isHeadless() && StandardEnvironmentHandler.isTTY();
  }

  /**
   * Get environment summary for debugging
   */
  static getEnvironmentSummary(): {
    isHeadless: boolean;
    isCI: boolean;
    isTTY: boolean;
    hasColor: boolean;
    shell: string;
    platform: string;
    nodeVersion: string;
  } {
    return {
      isHeadless: EnvironmentDetector.isHeadless(),
      isCI: StandardEnvironmentHandler.isCI(),
      isTTY: StandardEnvironmentHandler.isTTY(),
      hasColor: !StandardEnvironmentHandler.shouldDisableColor(),
      shell: StandardEnvironmentHandler.detectShell(),
      platform: process.platform,
      nodeVersion: process.version
    };
  }
}

// Export singleton instance
export const environmentMapper = EnvironmentVariableMapper.getInstance();