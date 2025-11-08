/**
 * CLI Types Module for juno-code
 *
 * Comprehensive TypeScript interfaces and types for the CLI framework,
 * supporting all commands, options, error handling, and help systems.
 */

import { Command } from 'commander';
import { SubagentType, SessionStatus, LogLevel, JunoTaskConfig } from '../types/index';

// ============================================================================
// Command Structure Types
// ============================================================================

/**
 * Interface for CLI command definitions
 */
export interface CLICommand {
  /** Command name used in CLI */
  name: string;
  /** Human-readable description of the command */
  description: string;
  /** Command aliases (short forms) */
  aliases?: string[];
  /** Command arguments specification */
  arguments?: CommandArgument[];
  /** Command options specification */
  options: CommandOption[];
  /** Command handler function */
  handler: CommandHandler;
  /** Usage examples for help system */
  examples?: CommandExample[];
  /** Subcommands for grouped commands */
  subcommands?: CLICommand[];
}

/**
 * Interface for command arguments
 */
export interface CommandArgument {
  /** Argument name (with optional/required indicators) */
  name: string;
  /** Argument description */
  description: string;
  /** Whether argument is required */
  required?: boolean;
  /** Valid choices for argument */
  choices?: string[];
  /** Default value if not provided */
  defaultValue?: any;
}

/**
 * Interface for command options
 */
export interface CommandOption {
  /** Option flags (short and long forms) */
  flags: string;
  /** Option description */
  description: string;
  /** Default value */
  defaultValue?: any;
  /** Whether option is required */
  required?: boolean;
  /** Valid choices for option value */
  choices?: string[];
  /** Options that conflict with this one */
  conflicts?: string[];
  /** Options that this option implies */
  implies?: string[];
  /** Environment variable that can set this option */
  env?: string;
}

/**
 * Interface for usage examples
 */
export interface CommandExample {
  /** Full command example */
  command: string;
  /** Description of what the example does */
  description: string;
}

/**
 * Command handler function signature
 */
export type CommandHandler = (
  args: any,
  options: any,
  command: Command
) => Promise<void>;

// ============================================================================
// CLI Options Types
// ============================================================================

/**
 * Global CLI options available to all commands
 */
export interface GlobalCLIOptions {
  /** Enable verbose output with detailed progress */
  verbose?: boolean;
  /** Disable rich formatting, use plain text */
  quiet?: boolean;
  /** Configuration file path (.json, .toml, pyproject.toml) */
  config?: string;
  /** Log file path (auto-generated if not specified) */
  logFile?: string;
  /** Disable colored output */
  noColor?: boolean;
  /** Log level for output */
  logLevel?: LogLevel;
  /** Enable concurrent feedback collection during execution */
  enableFeedback?: boolean;
}

/**
 * Main execution command options
 */
export interface MainCommandOptions extends GlobalCLIOptions {
  /** Subagent to use (required) */
  subagent: SubagentType;
  /** Prompt input (file path or inline text) */
  prompt?: string;
  /** Working directory */
  cwd?: string;
  /** Maximum iterations (-1 for unlimited) */
  maxIterations?: number;
  /** Model to use (subagent-specific) */
  model?: string;
  /** Interactive mode for typing prompts */
  interactive?: boolean;
  /** Launch TUI prompt editor */
  interactivePrompt?: boolean;
}

/**
 * Init command options
 */
export interface InitCommandOptions extends GlobalCLIOptions {
  /** Target directory */
  directory?: string;
  /** Force overwrite existing files */
  force?: boolean;
  /** Main task description */
  task?: string;
  /** Preferred subagent */
  subagent?: SubagentType;
  /** Repository URL */
  gitUrl?: string;
  /** Launch interactive TUI for guided setup */
  interactive?: boolean;
  /** Template variant to use */
  template?: string;
  /** Custom template variables */
  variables?: Record<string, string>;
}

/**
 * Start command options
 */
export interface StartCommandOptions extends GlobalCLIOptions {
  /** Subagent to use (optional override of config default) */
  subagent?: SubagentType;
  /** Maximum iterations */
  maxIterations?: number;
  /** Model to use */
  model?: string;
  /** Project directory */
  directory?: string;
  /** Display performance metrics summary after execution */
  showMetrics?: boolean;
  /** Show interactive performance dashboard after execution */
  showDashboard?: boolean;
  /** Display performance trends from historical data */
  showTrends?: boolean;
  /** Save performance metrics to file */
  saveMetrics?: boolean | string;
  /** Custom path for metrics file */
  metricsFile?: string;
  /** Enable concurrent feedback collection during execution */
  enableFeedback?: boolean;
}

/**
 * Feedback command options
 */
export interface FeedbackCommandOptions extends GlobalCLIOptions {
  /** Custom USER_FEEDBACK.md file path */
  file?: string;
  /** Interactive multiline input */
  interactive?: boolean;
  /** Issue description */
  issue?: string;
  /** Test criteria or success factors */
  test?: string;
  /** Test criteria alias */
  testCriteria?: string;
}

/**
 * Session list command options
 */
export interface SessionListOptions extends GlobalCLIOptions {
  /** Maximum sessions to show */
  limit?: number;
  /** Filter by subagent */
  subagent?: SubagentType;
  /** Filter by status */
  status?: SessionStatus[];
}

/**
 * Session info command options
 */
export interface SessionInfoOptions extends GlobalCLIOptions {
  /** Show detailed information */
  verbose?: boolean;
}

/**
 * Session remove command options
 */
export interface SessionRemoveOptions extends GlobalCLIOptions {
  /** Skip confirmation prompt */
  force?: boolean;
}

/**
 * Session clean command options
 */
export interface SessionCleanOptions extends GlobalCLIOptions {
  /** Remove sessions older than N days */
  days?: number;
  /** Remove only empty log files */
  empty?: boolean;
  /** Skip confirmation prompt */
  force?: boolean;
}

/**
 * Setup-git command options
 */
export interface SetupGitOptions extends GlobalCLIOptions {
  /** Show current upstream URL configuration */
  show?: boolean;
  /** Remove upstream URL configuration */
  remove?: boolean;
}

/**
 * Test command options
 */
export interface TestCommandOptions extends GlobalCLIOptions {
  /** Test type to generate/run */
  type?: 'unit' | 'integration' | 'e2e' | 'performance' | 'all';
  /** AI subagent for test generation */
  subagent?: SubagentType;
  /** AI intelligence level */
  intelligence?: 'basic' | 'smart' | 'comprehensive';
  /** Generate tests using AI */
  generate?: boolean;
  /** Execute tests */
  run?: boolean;
  /** Generate coverage report */
  coverage?: boolean | string;
  /** Analyze test quality and coverage */
  analyze?: boolean;
  /** Analysis quality level */
  quality?: 'basic' | 'thorough' | 'exhaustive';
  /** Generate improvement suggestions */
  suggestions?: boolean;
  /** Generate test report */
  report?: boolean | string;
  /** Report format */
  format?: 'json' | 'html' | 'markdown' | 'console';
  /** Test template to use */
  template?: string;
  /** Testing framework */
  framework?: 'vitest' | 'jest' | 'mocha' | 'custom';
  /** Watch mode for continuous testing */
  watch?: boolean;
  /** Test reporters (comma-separated) */
  reporters?: string[];
}

// ============================================================================
// Parsed Arguments Types
// ============================================================================

/**
 * Parsed command line arguments
 */
export interface ParsedArgs {
  /** Command name */
  command: string;
  /** Subcommand name (if applicable) */
  subcommand?: string;
  /** Positional arguments */
  args: string[];
  /** Parsed options */
  options: Record<string, any>;
  /** Unknown options (for validation) */
  unknown: string[];
}

/**
 * Option validation result
 */
export interface OptionValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Validation error messages */
  errors: string[];
  /** Validation warnings */
  warnings: string[];
  /** Normalized/coerced option values */
  normalizedOptions: Record<string, any>;
}

// ============================================================================
// Help System Types
// ============================================================================

/**
 * Help content structure
 */
export interface HelpContent {
  /** Command name */
  command: string;
  /** Command description */
  description: string;
  /** Usage syntax */
  usage: string;
  /** Available options */
  options: HelpOption[];
  /** Available subcommands */
  subcommands?: HelpSubcommand[];
  /** Usage examples */
  examples: CommandExample[];
  /** Additional notes */
  notes?: string[];
}

/**
 * Help option representation
 */
export interface HelpOption {
  /** Option flags */
  flags: string;
  /** Option description */
  description: string;
  /** Default value (if any) */
  defaultValue?: any;
  /** Valid choices (if any) */
  choices?: string[];
}

/**
 * Help subcommand representation
 */
export interface HelpSubcommand {
  /** Subcommand name */
  name: string;
  /** Subcommand description */
  description: string;
  /** Subcommand aliases */
  aliases?: string[];
}

/**
 * Shell completion types
 */
export type ShellType = 'bash' | 'zsh' | 'fish';

/**
 * Shell completion configuration
 */
export interface CompletionConfig {
  /** Shell type */
  shell: ShellType;
  /** Command name for completion */
  commandName: string;
  /** Available commands for completion */
  commands: string[];
  /** Available options for completion */
  options: string[];
  /** Custom completion handlers */
  customHandlers?: Record<string, CompletionHandler>;
}

/**
 * Completion handler function
 */
export type CompletionHandler = (
  partial: string,
  context: CompletionContext
) => string[];

/**
 * Completion context
 */
export interface CompletionContext {
  /** Current command being completed */
  command?: string;
  /** Current subcommand being completed */
  subcommand?: string;
  /** Previous arguments */
  previousArgs: string[];
  /** Current word being completed */
  currentWord: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base CLI error class
 */
export abstract class CLIError extends Error {
  /** Error code for programmatic handling */
  abstract code: string;
  /** Whether error should show help */
  showHelp: boolean = false;
  /** Suggested solutions */
  suggestions: string[] = [];

  constructor(message: string, showHelp: boolean = false) {
    super(message);
    this.name = this.constructor.name;
    this.showHelp = showHelp;
  }
}

/**
 * Validation error (user input issues)
 */
export class ValidationError extends CLIError {
  code = 'VALIDATION_ERROR';

  constructor(message: string, suggestions: string[] = []) {
    super(message, true);
    this.suggestions = suggestions;
  }
}

/**
 * Configuration error (config file/setup issues)
 */
export class ConfigurationError extends CLIError {
  code = 'CONFIGURATION_ERROR';

  constructor(message: string, suggestions: string[] = []) {
    super(message, false);
    this.suggestions = suggestions;
  }
}

/**
 * Command not found error
 */
export class CommandNotFoundError extends CLIError {
  code = 'COMMAND_NOT_FOUND';

  constructor(command: string, availableCommands: string[] = []) {
    super(`Unknown command: ${command}`);
    this.showHelp = true;

    if (availableCommands.length > 0) {
      this.suggestions = [
        `Available commands: ${availableCommands.join(', ')}`,
        `Use 'juno-code --help' for usage information`
      ];
    }
  }
}

/**
 * MCP-related error
 */
export class MCPError extends CLIError {
  code = 'MCP_ERROR';

  constructor(message: string, operation?: string) {
    super(operation ? `MCP ${operation}: ${message}` : message);
    this.suggestions = [
      'Check MCP server configuration',
      'Verify MCP server is running',
      'Use --verbose for detailed error information'
    ];
  }
}

/**
 * File system error
 */
export class FileSystemError extends CLIError {
  code = 'FILESYSTEM_ERROR';

  constructor(message: string, path?: string) {
    super(path ? `${message}: ${path}` : message);
    this.suggestions = [
      'Check file/directory permissions',
      'Verify path exists and is accessible',
      'Use absolute paths to avoid ambiguity'
    ];
  }
}

/**
 * Session error
 */
export class SessionError extends CLIError {
  code = 'SESSION_ERROR';

  constructor(message: string) {
    super(message);
    this.suggestions = [
      'Check session directory permissions',
      'Verify sufficient disk space',
      'Use juno-code session clean to remove old sessions'
    ];
  }
}

/**
 * Template error
 */
export class TemplateError extends CLIError {
  code = 'TEMPLATE_ERROR';

  constructor(message: string) {
    super(message);
    this.suggestions = [
      'Verify template syntax',
      'Check required template variables',
      'Use --template to specify different template'
    ];
  }
}

// ============================================================================
// Environment Variables
// ============================================================================

/**
 * Environment variable mappings for CLI options
 * Updated to use JUNO_CODE_* prefix with backward compatibility for JUNO_TASK_*
 */
export const ENVIRONMENT_MAPPINGS = {
  // Core options (new JUNO_CODE_* names)
  JUNO_CODE_SUBAGENT: 'subagent',
  JUNO_CODE_PROMPT: 'prompt',
  JUNO_CODE_CWD: 'cwd',
  JUNO_CODE_MAX_ITERATIONS: 'maxIterations',
  JUNO_CODE_MODEL: 'model',
  JUNO_CODE_LOG_FILE: 'logFile',
  JUNO_CODE_VERBOSE: 'verbose',
  JUNO_CODE_QUIET: 'quiet',
  JUNO_CODE_INTERACTIVE: 'interactive',
  JUNO_CODE_CONFIG: 'config',

  // MCP options (new JUNO_CODE_* names)
  JUNO_CODE_MCP_SERVER_PATH: 'mcpServerPath',
  JUNO_CODE_MCP_TIMEOUT: 'mcpTimeout',
  JUNO_CODE_MCP_RETRIES: 'mcpRetries',

  // Session options (new JUNO_CODE_* names)
  JUNO_CODE_SESSION_DIR: 'sessionDir',
  JUNO_CODE_LOG_LEVEL: 'logLevel',

  // Template options (new JUNO_CODE_* names)
  JUNO_CODE_TEMPLATE: 'template',
  JUNO_CODE_FORCE: 'force',

  // Git options (new JUNO_CODE_* names)
  JUNO_CODE_GIT_URL: 'gitUrl',

  // UI options (new JUNO_CODE_* names)
  JUNO_CODE_NO_COLOR: 'noColor',
  JUNO_CODE_HEADLESS: 'headless',

  // Feedback options (new JUNO_CODE_* names)
  JUNO_CODE_ENABLE_FEEDBACK: 'enableFeedback',

  // Legacy JUNO_TASK_* names for backward compatibility
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
  JUNO_TASK_MCP_SERVER_PATH: 'mcpServerPath',
  JUNO_TASK_MCP_TIMEOUT: 'mcpTimeout',
  JUNO_TASK_MCP_RETRIES: 'mcpRetries',
  JUNO_TASK_SESSION_DIR: 'sessionDir',
  JUNO_TASK_LOG_LEVEL: 'logLevel',
  JUNO_TASK_TEMPLATE: 'template',
  JUNO_TASK_FORCE: 'force',
  JUNO_TASK_GIT_URL: 'gitUrl',
  JUNO_TASK_NO_COLOR: 'noColor',
  JUNO_TASK_HEADLESS: 'headless',
  JUNO_TASK_ENABLE_FEEDBACK: 'enableFeedback',

  // Special aliases
  JUNO_INTERACTIVE_FEEDBACK_MODE: 'enableFeedback'  // Alias for enableFeedback
} as const;

/**
 * Type for environment variable keys
 */
export type EnvironmentVariable = keyof typeof ENVIRONMENT_MAPPINGS;

/**
 * Type for CLI option keys
 */
export type CLIOptionKey = typeof ENVIRONMENT_MAPPINGS[EnvironmentVariable];

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * CLI configuration structure
 */
export interface CLIConfig extends JunoTaskConfig {
  /** Command completion settings */
  completion: {
    enabled: boolean;
    installedShells: ShellType[];
  };

  /** Help system settings */
  help: {
    showExamples: boolean;
    showEnvironmentVars: boolean;
    colorOutput: boolean;
  };

  /** Error handling settings */
  errorHandling: {
    showStackTrace: boolean;
    suggestSolutions: boolean;
    exitOnError: boolean;
  };
}

/**
 * Initialization data for project setup
 */
export interface InitializationData {
  /** Main task description */
  task: string;
  /** Preferred subagent */
  subagent: SubagentType;
  /** Repository URL (optional) */
  gitUrl?: string;
  /** Template variables */
  variables: Record<string, string>;
  /** Template variant */
  template: string;
  /** Additional metadata */
  metadata?: {
    author?: string;
    description?: string;
    tags?: string[];
  };
}

/**
 * Template generation result
 */
export interface TemplateGenerationResult {
  /** Generated file name */
  fileName: string;
  /** Generated file path */
  filePath: string;
  /** Whether file was created or updated */
  action: 'created' | 'updated' | 'skipped';
  /** File size in bytes */
  size: number;
}

/**
 * Command execution result
 */
export interface CommandExecutionResult {
  /** Whether command succeeded */
  success: boolean;
  /** Exit code */
  exitCode: number;
  /** Execution time in milliseconds */
  duration: number;
  /** Output messages */
  output: string[];
  /** Error messages */
  errors: string[];
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Make specific properties required
 */
export type WithRequired<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Make specific properties optional
 */
export type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Extract option types from command options interface
 */
export type ExtractOptions<T> = T extends { options: infer O } ? O : never;

/**
 * Union of all command option types
 */
export type AllCommandOptions =
  | MainCommandOptions
  | InitCommandOptions
  | StartCommandOptions
  | FeedbackCommandOptions
  | SessionListOptions
  | SessionInfoOptions
  | SessionRemoveOptions
  | SessionCleanOptions
  | SetupGitOptions
  | TestCommandOptions;

/**
 * Union of all CLI error types
 */
export type AllCLIErrors =
  | ValidationError
  | ConfigurationError
  | CommandNotFoundError
  | MCPError
  | FileSystemError
  | SessionError
  | TemplateError;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for CLI errors
 */
export function isCLIError(error: unknown): error is CLIError {
  return error instanceof CLIError;
}

/**
 * Type guard for validation errors
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

/**
 * Type guard for configuration errors
 */
export function isConfigurationError(error: unknown): error is ConfigurationError {
  return error instanceof ConfigurationError;
}

/**
 * Type guard for MCP errors
 */
export function isMCPError(error: unknown): error is MCPError {
  return error instanceof MCPError;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default CLI configuration values
 */
export const DEFAULT_CLI_CONFIG: Partial<CLIConfig> = {
  completion: {
    enabled: true,
    installedShells: []
  },
  help: {
    showExamples: true,
    showEnvironmentVars: true,
    colorOutput: true
  },
  errorHandling: {
    showStackTrace: false,
    suggestSolutions: true,
    exitOnError: true
  }
};

/**
 * Supported subagent aliases
 */
export const SUBAGENT_ALIASES: Record<string, SubagentType> = {
  'claude-code': 'claude',
  'claude_code': 'claude',
  'gemini-cli': 'gemini',
  'cursor-agent': 'cursor'
};

/**
 * Command categories for help organization
 */
export const COMMAND_CATEGORIES = {
  EXECUTION: ['juno-code', 'start'],
  PROJECT: ['init', 'setup-git'],
  TESTING: ['test'],
  SESSION: ['session'],
  FEEDBACK: ['feedback']
} as const;

/**
 * Exit codes for different error types
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  VALIDATION_ERROR: 1,
  CONFIGURATION_ERROR: 2,
  COMMAND_NOT_FOUND: 3,
  MCP_ERROR: 4,
  FILESYSTEM_ERROR: 5,
  SESSION_ERROR: 6,
  TEMPLATE_ERROR: 7,
  UNEXPECTED_ERROR: 99
} as const;

export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];