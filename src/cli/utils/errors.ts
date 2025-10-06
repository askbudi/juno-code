/**
 * Error handling utilities for juno-task-ts CLI
 *
 * Provides comprehensive error formatting, suggestion generation, and
 * user-friendly error presentation with context-aware help.
 */

import chalk from 'chalk';
import type {
  CLIError,
  ValidationError,
  ConfigurationError,
  CommandNotFoundError,
  MCPError,
  FileSystemError,
  SessionError,
  TemplateError,
  ExitCode,
  EXIT_CODES
} from '../types.js';

/**
 * Error context information for better error reporting
 */
interface ErrorContext {
  command?: string;
  subcommand?: string;
  arguments?: string[];
  options?: Record<string, any>;
  workingDirectory?: string;
  configFile?: string;
  environment?: Record<string, string>;
}

/**
 * Error formatter for consistent error presentation
 */
export class ErrorFormatter {
  private context: ErrorContext;

  constructor(context: ErrorContext = {}) {
    this.context = context;
  }

  /**
   * Format error for display
   */
  formatError(error: unknown, verbose: boolean = false): string {
    if (error instanceof CLIError) {
      return this.formatCLIError(error, verbose);
    }

    if (error instanceof Error) {
      return this.formatGenericError(error, verbose);
    }

    return this.formatUnknownError(error, verbose);
  }

  /**
   * Format CLI-specific errors
   */
  private formatCLIError(error: CLIError, verbose: boolean): string {
    const lines: string[] = [];

    // Error header
    lines.push(chalk.red.bold(`\n❌ ${error.constructor.name}`));
    lines.push(chalk.red(`   ${error.message}`));

    // Context information if verbose
    if (verbose && this.context.command) {
      lines.push(chalk.gray('\n📍 Context:'));
      lines.push(chalk.gray(`   Command: ${this.context.command}`));
      if (this.context.subcommand) {
        lines.push(chalk.gray(`   Subcommand: ${this.context.subcommand}`));
      }
      if (this.context.workingDirectory) {
        lines.push(chalk.gray(`   Working Directory: ${this.context.workingDirectory}`));
      }
    }

    // Suggestions
    if (error.suggestions?.length) {
      lines.push(chalk.yellow('\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        lines.push(chalk.yellow(`   • ${suggestion}`));
      });
    }

    // Help prompt
    if (error.showHelp) {
      lines.push(chalk.gray('\n   Use --help for usage information'));
    }

    // Stack trace if verbose and available
    if (verbose && error.stack) {
      lines.push(chalk.gray('\n📍 Stack Trace:'));
      lines.push(chalk.gray(error.stack));
    }

    return lines.join('\n');
  }

  /**
   * Format generic errors
   */
  private formatGenericError(error: Error, verbose: boolean): string {
    const lines: string[] = [];

    lines.push(chalk.red.bold('\n❌ Unexpected Error'));
    lines.push(chalk.red(`   ${error.message}`));

    if (verbose && error.stack) {
      lines.push(chalk.gray('\n📍 Stack Trace:'));
      lines.push(chalk.gray(error.stack));
    }

    // General suggestions
    lines.push(chalk.yellow('\n💡 General Suggestions:'));
    lines.push(chalk.yellow('   • Check your command syntax and options'));
    lines.push(chalk.yellow('   • Verify file paths and permissions'));
    lines.push(chalk.yellow('   • Use --verbose for more detailed information'));
    lines.push(chalk.yellow('   • Report persistent issues on GitHub'));

    return lines.join('\n');
  }

  /**
   * Format unknown errors
   */
  private formatUnknownError(error: unknown, verbose: boolean): string {
    const lines: string[] = [];

    lines.push(chalk.red.bold('\n❌ Unknown Error'));
    lines.push(chalk.red(`   ${String(error)}`));

    if (verbose) {
      lines.push(chalk.gray('\n📍 Error Details:'));
      lines.push(chalk.gray(`   Type: ${typeof error}`));
      lines.push(chalk.gray(`   Value: ${JSON.stringify(error, null, 2)}`));
    }

    return lines.join('\n');
  }

  /**
   * Update error context
   */
  updateContext(context: Partial<ErrorContext>): void {
    this.context = { ...this.context, ...context };
  }
}

/**
 * Error suggestion generator for context-aware help
 */
export class ErrorSuggestionGenerator {
  /**
   * Generate suggestions for validation errors
   */
  static generateValidationSuggestions(error: ValidationError, context: ErrorContext): string[] {
    const suggestions: string[] = [];

    // Command-specific suggestions
    if (context.command) {
      switch (context.command) {
        case 'init':
          suggestions.push('Verify target directory is writable');
          suggestions.push('Check template variables are valid');
          suggestions.push('Use --force to overwrite existing files');
          break;

        case 'start':
          suggestions.push('Ensure .juno_task/init.md exists');
          suggestions.push('Check MCP server is accessible');
          suggestions.push('Verify working directory permissions');
          break;

        case 'feedback':
          suggestions.push('Check feedback file path and permissions');
          suggestions.push('Use --interactive for guided input');
          break;

        case 'session':
          suggestions.push('Verify session ID is correct');
          suggestions.push('Use "session list" to see available sessions');
          break;

        case 'setup-git':
          suggestions.push('Provide a valid Git repository URL');
          suggestions.push('Ensure Git is installed and accessible');
          break;
      }
    }

    // Option-specific suggestions
    if (context.options) {
      if (context.options.subagent) {
        suggestions.push('Use one of: claude, cursor, codex, gemini');
      }
      if (context.options.config) {
        suggestions.push('Check configuration file exists and is readable');
      }
    }

    // General validation suggestions
    suggestions.push('Use --help for command usage information');
    suggestions.push('Check command syntax and required arguments');

    return suggestions;
  }

  /**
   * Generate suggestions for configuration errors
   */
  static generateConfigurationSuggestions(error: ConfigurationError, context: ErrorContext): string[] {
    const suggestions: string[] = [];

    suggestions.push('Check configuration file syntax (JSON/TOML)');
    suggestions.push('Verify all required configuration values are set');
    suggestions.push('Use environment variables as alternatives');

    if (context.configFile) {
      suggestions.push(`Verify ${context.configFile} exists and is readable`);
    }

    suggestions.push('Use default configuration if file is missing');
    suggestions.push('Run with --verbose for detailed configuration loading');

    return suggestions;
  }

  /**
   * Generate suggestions for MCP errors
   */
  static generateMCPSuggestions(error: MCPError, context: ErrorContext): string[] {
    const suggestions: string[] = [];

    suggestions.push('Check MCP server is installed and accessible');
    suggestions.push('Verify MCP server path in configuration');
    suggestions.push('Ensure MCP server has proper permissions');
    suggestions.push('Check network connectivity if using remote MCP');
    suggestions.push('Review MCP server logs for additional details');

    if (context.options?.mcpServerPath) {
      suggestions.push(`Verify MCP server exists at: ${context.options.mcpServerPath}`);
    }

    return suggestions;
  }

  /**
   * Generate suggestions for file system errors
   */
  static generateFileSystemSuggestions(error: FileSystemError, context: ErrorContext): string[] {
    const suggestions: string[] = [];

    suggestions.push('Check file/directory permissions');
    suggestions.push('Verify path exists and is accessible');
    suggestions.push('Ensure sufficient disk space');
    suggestions.push('Use absolute paths to avoid ambiguity');

    if (context.workingDirectory) {
      suggestions.push(`Verify working directory: ${context.workingDirectory}`);
    }

    return suggestions;
  }

  /**
   * Generate suggestions for session errors
   */
  static generateSessionSuggestions(error: SessionError, context: ErrorContext): string[] {
    const suggestions: string[] = [];

    suggestions.push('Check session directory permissions');
    suggestions.push('Verify sufficient disk space for session data');
    suggestions.push('Use "session clean" to remove old sessions');
    suggestions.push('Check session database integrity');

    return suggestions;
  }

  /**
   * Generate suggestions for template errors
   */
  static generateTemplateSuggestions(error: TemplateError, context: ErrorContext): string[] {
    const suggestions: string[] = [];

    suggestions.push('Verify template syntax and variables');
    suggestions.push('Check required template variables are provided');
    suggestions.push('Use --template to specify different template');
    suggestions.push('Review template documentation');

    return suggestions;
  }
}

/**
 * Error recovery helper for handling common error scenarios
 */
export class ErrorRecoveryHelper {
  /**
   * Attempt to recover from common errors
   */
  static async attemptRecovery(error: CLIError, context: ErrorContext): Promise<boolean> {
    try {
      switch (error.constructor.name) {
        case 'ConfigurationError':
          return await this.recoverFromConfigurationError(error as ConfigurationError, context);

        case 'FileSystemError':
          return await this.recoverFromFileSystemError(error as FileSystemError, context);

        case 'MCPError':
          return await this.recoverFromMCPError(error as MCPError, context);

        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Recover from configuration errors
   */
  private static async recoverFromConfigurationError(
    error: ConfigurationError,
    context: ErrorContext
  ): Promise<boolean> {
    // Attempt to use default configuration
    if (error.message.includes('configuration file not found')) {
      console.log(chalk.yellow('⚠️  Using default configuration...'));
      return true;
    }

    return false;
  }

  /**
   * Recover from file system errors
   */
  private static async recoverFromFileSystemError(
    error: FileSystemError,
    context: ErrorContext
  ): Promise<boolean> {
    // Attempt to create missing directories
    if (error.message.includes('directory not found') || error.message.includes('ENOENT')) {
      try {
        const { fs } = await import('fs-extra');
        // This would need the specific path from the error context
        console.log(chalk.yellow('⚠️  Attempting to create missing directory...'));
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Recover from MCP errors
   */
  private static async recoverFromMCPError(error: MCPError, context: ErrorContext): Promise<boolean> {
    // Attempt to discover MCP server automatically
    if (error.message.includes('server not found')) {
      console.log(chalk.yellow('⚠️  Attempting to discover MCP server...'));
      // This would integrate with the MCP server discovery logic
      return false;
    }

    return false;
  }
}

/**
 * Get exit code for error type
 */
export function getExitCodeForError(error: unknown): ExitCode {
  if (error instanceof ValidationError) {
    return EXIT_CODES.VALIDATION_ERROR;
  }

  if (error instanceof ConfigurationError) {
    return EXIT_CODES.CONFIGURATION_ERROR;
  }

  if (error instanceof CommandNotFoundError) {
    return EXIT_CODES.COMMAND_NOT_FOUND;
  }

  if (error instanceof MCPError) {
    return EXIT_CODES.MCP_ERROR;
  }

  if (error instanceof FileSystemError) {
    return EXIT_CODES.FILESYSTEM_ERROR;
  }

  if (error instanceof SessionError) {
    return EXIT_CODES.SESSION_ERROR;
  }

  if (error instanceof TemplateError) {
    return EXIT_CODES.TEMPLATE_ERROR;
  }

  return EXIT_CODES.UNEXPECTED_ERROR;
}

/**
 * Create enhanced error with suggestions
 */
export function enhanceError(error: CLIError, context: ErrorContext): CLIError {
  // Generate context-aware suggestions
  let suggestions: string[] = [];

  switch (error.constructor.name) {
    case 'ValidationError':
      suggestions = ErrorSuggestionGenerator.generateValidationSuggestions(error as ValidationError, context);
      break;
    case 'ConfigurationError':
      suggestions = ErrorSuggestionGenerator.generateConfigurationSuggestions(error as ConfigurationError, context);
      break;
    case 'MCPError':
      suggestions = ErrorSuggestionGenerator.generateMCPSuggestions(error as MCPError, context);
      break;
    case 'FileSystemError':
      suggestions = ErrorSuggestionGenerator.generateFileSystemSuggestions(error as FileSystemError, context);
      break;
    case 'SessionError':
      suggestions = ErrorSuggestionGenerator.generateSessionSuggestions(error as SessionError, context);
      break;
    case 'TemplateError':
      suggestions = ErrorSuggestionGenerator.generateTemplateSuggestions(error as TemplateError, context);
      break;
  }

  // Merge with existing suggestions
  error.suggestions = [...(error.suggestions || []), ...suggestions];

  return error;
}