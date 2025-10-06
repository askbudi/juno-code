/**
 * Enhanced Error Handling Utilities for juno-task-ts CLI
 *
 * Provides comprehensive error handling, user-friendly error messages,
 * solution suggestions, and debugging support for CLI operations.
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
  EXIT_CODES
} from '../types.js';

// ============================================================================
// Error Classification and Handling
// ============================================================================

/**
 * Comprehensive CLI error handler
 */
export class CLIErrorHandler {
  private static instance: CLIErrorHandler;
  private verbose: boolean = false;
  private quiet: boolean = false;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): CLIErrorHandler {
    if (!CLIErrorHandler.instance) {
      CLIErrorHandler.instance = new CLIErrorHandler();
    }
    return CLIErrorHandler.instance;
  }

  /**
   * Configure error handler options
   */
  configure(options: { verbose?: boolean; quiet?: boolean }): void {
    this.verbose = options.verbose || false;
    this.quiet = options.quiet || false;
  }

  /**
   * Handle CLI error with comprehensive formatting and suggestions
   */
  async handleError(error: unknown, command?: string, options?: any): Promise<void> {
    // Override handler config with specific options
    const verbose = options?.verbose || this.verbose;
    const quiet = options?.quiet || this.quiet;

    if (quiet) {
      // In quiet mode, only show essential error information
      this.handleQuietError(error);
      return;
    }

    // Log full error in verbose mode
    if (verbose) {
      console.error(chalk.red('Full error details:'));
      console.error(error);
      console.error();
    }

    // Handle specific error types
    if (this.isCLIError(error)) {
      await this.handleKnownError(error, command, verbose);
    } else {
      await this.handleUnknownError(error, command, verbose);
    }
  }

  /**
   * Handle quiet mode errors
   */
  private handleQuietError(error: unknown): void {
    if (this.isCLIError(error)) {
      console.error(`Error: ${error.message}`);
      process.exit(this.getExitCodeForError(error));
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(99);
    }
  }

  /**
   * Handle known CLI errors
   */
  private async handleKnownError(error: CLIError, command?: string, verbose?: boolean): Promise<void> {
    if (error instanceof ValidationError) {
      await this.handleValidationError(error, command);
    } else if (error instanceof ConfigurationError) {
      await this.handleConfigurationError(error, command);
    } else if (error instanceof CommandNotFoundError) {
      await this.handleCommandNotFoundError(error, command);
    } else if (error instanceof MCPError) {
      await this.handleMCPError(error, command);
    } else if (error instanceof FileSystemError) {
      await this.handleFileSystemError(error, command);
    } else if (error instanceof SessionError) {
      await this.handleSessionError(error, command);
    } else if (error instanceof TemplateError) {
      await this.handleTemplateError(error, command);
    } else {
      await this.handleGenericCLIError(error, command);
    }

    process.exit(this.getExitCodeForError(error));
  }

  /**
   * Handle unknown/unexpected errors
   */
  private async handleUnknownError(error: unknown, command?: string, verbose?: boolean): Promise<void> {
    console.error(chalk.red.bold('❌ Unexpected Error'));
    console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));

    if (verbose && error instanceof Error) {
      console.error(chalk.gray('\\n📍 Stack Trace:'));
      console.error(error.stack);
    }

    await this.suggestGeneralSolutions(command);
    process.exit(99);
  }

  /**
   * Handle validation errors
   */
  private async handleValidationError(error: ValidationError, command?: string): Promise<void> {
    console.error(chalk.red.bold('❌ Validation Error'));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    } else {
      await this.suggestValidationSolutions(error, command);
    }

    if (error.showHelp && command) {
      console.error(chalk.gray(`\\n   Use 'juno-task ${command} --help' for usage information`));
    }
  }

  /**
   * Handle configuration errors
   */
  private async handleConfigurationError(error: ConfigurationError, command?: string): Promise<void> {
    console.error(chalk.red.bold('❌ Configuration Error'));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    } else {
      await this.suggestConfigurationSolutions(error);
    }
  }

  /**
   * Handle command not found errors
   */
  private async handleCommandNotFoundError(error: CommandNotFoundError, command?: string): Promise<void> {
    console.error(chalk.red.bold('❌ Command Not Found'));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\\n💡 Available Commands:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    }

    console.error(chalk.gray(`\\n   Use 'juno-task --help' for a list of available commands`));
  }

  /**
   * Handle MCP errors
   */
  private async handleMCPError(error: MCPError, command?: string): Promise<void> {
    console.error(chalk.red.bold('❌ MCP Communication Error'));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    } else {
      await this.suggestMCPSolutions(error);
    }
  }

  /**
   * Handle file system errors
   */
  private async handleFileSystemError(error: FileSystemError, command?: string): Promise<void> {
    console.error(chalk.red.bold('❌ File System Error'));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    } else {
      await this.suggestFileSystemSolutions(error);
    }
  }

  /**
   * Handle session errors
   */
  private async handleSessionError(error: SessionError, command?: string): Promise<void> {
    console.error(chalk.red.bold('❌ Session Error'));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    } else {
      await this.suggestSessionSolutions(error);
    }
  }

  /**
   * Handle template errors
   */
  private async handleTemplateError(error: TemplateError, command?: string): Promise<void> {
    console.error(chalk.red.bold('❌ Template Error'));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    } else {
      await this.suggestTemplateSolutions(error);
    }
  }

  /**
   * Handle generic CLI errors
   */
  private async handleGenericCLIError(error: CLIError, command?: string): Promise<void> {
    console.error(chalk.red.bold(`❌ ${error.constructor.name}`));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\\n💡 Suggestions:'));
      error.suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    }
  }

  // ============================================================================
  // Solution Suggestion Methods
  // ============================================================================

  /**
   * Suggest validation solutions
   */
  private async suggestValidationSolutions(error: ValidationError, command?: string): Promise<void> {
    const suggestions = [];

    if (error.message.includes('Prompt is required')) {
      suggestions.push(
        'Use --prompt "your prompt text" for inline prompts',
        'Use --prompt ./prompt.md for file prompts',
        'Use --interactive for interactive input',
        'Use --interactive-prompt for enhanced editor'
      );
    } else if (error.message.includes('Invalid subagent')) {
      suggestions.push(
        'Valid subagents: claude, cursor, codex, gemini',
        'Use aliases: claude-code, gemini-cli, cursor-agent',
        'Example: juno-task -s claude -p "your prompt"'
      );
    } else if (error.message.includes('Working directory')) {
      suggestions.push(
        'Check if the directory exists',
        'Use absolute paths to avoid ambiguity',
        'Verify directory permissions'
      );
    } else if (error.message.includes('Max iterations')) {
      suggestions.push(
        'Use -1 for unlimited iterations',
        'Use positive numbers for limited iterations',
        'Example: --max-iterations 5'
      );
    }

    if (suggestions.length > 0) {
      console.error(chalk.yellow('\\n💡 Suggestions:'));
      suggestions.forEach(suggestion => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    }
  }

  /**
   * Suggest configuration solutions
   */
  private async suggestConfigurationSolutions(error: ConfigurationError): Promise<void> {
    const suggestions = [
      'Check configuration file syntax (.json, .toml)',
      'Verify configuration file permissions',
      'Use --config to specify config file path',
      'Check environment variables (JUNO_TASK_*)',
      'Try running with --verbose for detailed error info'
    ];

    console.error(chalk.yellow('\\n💡 Suggestions:'));
    suggestions.forEach(suggestion => {
      console.error(chalk.yellow(`   • ${suggestion}`));
    });
  }

  /**
   * Suggest MCP solutions
   */
  private async suggestMCPSolutions(error: MCPError): Promise<void> {
    const suggestions = [
      'Check MCP server configuration',
      'Verify MCP server is running and accessible',
      'Check network connectivity',
      'Try increasing timeout with JUNO_TASK_MCP_TIMEOUT',
      'Use --verbose for detailed MCP communication logs'
    ];

    console.error(chalk.yellow('\\n💡 Suggestions:'));
    suggestions.forEach(suggestion => {
      console.error(chalk.yellow(`   • ${suggestion}`));
    });
  }

  /**
   * Suggest file system solutions
   */
  private async suggestFileSystemSolutions(error: FileSystemError): Promise<void> {
    const suggestions = [
      'Check file/directory permissions',
      'Verify path exists and is accessible',
      'Use absolute paths to avoid ambiguity',
      'Check available disk space',
      'Verify parent directory exists'
    ];

    console.error(chalk.yellow('\\n💡 Suggestions:'));
    suggestions.forEach(suggestion => {
      console.error(chalk.yellow(`   • ${suggestion}`));
    });
  }

  /**
   * Suggest session solutions
   */
  private async suggestSessionSolutions(error: SessionError): Promise<void> {
    const suggestions = [
      'Check session directory permissions',
      'Verify sufficient disk space',
      'Use juno-task session clean to remove old sessions',
      'Check session ID format',
      'Try running with --verbose for session details'
    ];

    console.error(chalk.yellow('\\n💡 Suggestions:'));
    suggestions.forEach(suggestion => {
      console.error(chalk.yellow(`   • ${suggestion}`));
    });
  }

  /**
   * Suggest template solutions
   */
  private async suggestTemplateSolutions(error: TemplateError): Promise<void> {
    const suggestions = [
      'Verify template syntax (Handlebars)',
      'Check required template variables',
      'Use --template to specify different template',
      'Verify template files are accessible',
      'Check template variable types and values'
    ];

    console.error(chalk.yellow('\\n💡 Suggestions:'));
    suggestions.forEach(suggestion => {
      console.error(chalk.yellow(`   • ${suggestion}`));
    });
  }

  /**
   * Suggest general solutions
   */
  private async suggestGeneralSolutions(command?: string): Promise<void> {
    const suggestions = [
      'Try running with --verbose for detailed error information',
      'Check system requirements and dependencies',
      'Verify configuration and environment variables',
      'Report this issue if it persists'
    ];

    if (command) {
      suggestions.unshift(`Use 'juno-task ${command} --help' for usage information`);
    } else {
      suggestions.unshift('Use \'juno-task --help\' for available commands');
    }

    console.error(chalk.yellow('\\n💡 Suggestions:'));
    suggestions.forEach(suggestion => {
      console.error(chalk.yellow(`   • ${suggestion}`));
    });
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Check if error is a CLI error
   */
  private isCLIError(error: unknown): error is CLIError {
    return error instanceof Error && 'code' in error && typeof (error as any).code === 'string';
  }

  /**
   * Get exit code for error
   */
  private getExitCodeForError(error: CLIError): number {
    const codeMap: Record<string, number> = {
      'VALIDATION_ERROR': 1,
      'CONFIGURATION_ERROR': 2,
      'COMMAND_NOT_FOUND': 3,
      'MCP_ERROR': 4,
      'FILESYSTEM_ERROR': 5,
      'SESSION_ERROR': 6,
      'TEMPLATE_ERROR': 7
    };

    return codeMap[error.code] || 99;
  }
}

// ============================================================================
// Error Recovery and Suggestions
// ============================================================================

/**
 * Error recovery manager for suggesting fixes
 */
export class ErrorRecoveryManager {
  /**
   * Suggest recovery actions based on error type and context
   */
  static suggestRecovery(error: CLIError, context: {
    command?: string;
    args?: string[];
    options?: any;
  }): string[] {
    const suggestions: string[] = [];

    // Context-aware suggestions
    if (context.command === 'init' && error instanceof ValidationError) {
      if (error.message.includes('task description')) {
        suggestions.push(
          'Try: juno-task init --task "Describe your project goals"',
          'Use --interactive for guided setup'
        );
      }
    }

    if (context.command === 'start' && error instanceof FileSystemError) {
      if (error.message.includes('init.md')) {
        suggestions.push(
          'Run juno-task init first to create project structure',
          'Check if .juno_task directory exists'
        );
      }
    }

    if (error instanceof MCPError) {
      suggestions.push(
        'Check if MCP server is installed and running',
        'Verify JUNO_TASK_MCP_SERVER_PATH environment variable',
        'Try restarting the MCP server'
      );
    }

    return suggestions;
  }

  /**
   * Check if error is recoverable
   */
  static isRecoverable(error: CLIError): boolean {
    // Some errors can be recovered from with user intervention
    const recoverableTypes = [
      'VALIDATION_ERROR',
      'CONFIGURATION_ERROR',
      'FILESYSTEM_ERROR'
    ];

    return recoverableTypes.includes(error.code);
  }

  /**
   * Suggest automatic recovery actions
   */
  static suggestAutoRecovery(error: CLIError, context: any): string[] {
    const actions: string[] = [];

    if (error instanceof ConfigurationError) {
      actions.push('Generate default configuration file');
    }

    if (error instanceof FileSystemError && error.message.includes('not exist')) {
      actions.push('Create missing directories');
    }

    return actions;
  }
}

// ============================================================================
// Debugging Utilities
// ============================================================================

/**
 * Debug information collector
 */
export class DebugInfoCollector {
  /**
   * Collect system information for debugging
   */
  static collectSystemInfo(): Record<string, any> {
    return {
      node: {
        version: process.version,
        platform: process.platform,
        arch: process.arch
      },
      environment: {
        home: process.env.HOME || process.env.USERPROFILE,
        shell: process.env.SHELL,
        term: process.env.TERM,
        ci: Boolean(process.env.CI)
      },
      process: {
        cwd: process.cwd(),
        argv: process.argv,
        pid: process.pid
      },
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };
  }

  /**
   * Collect juno-task specific debug information
   */
  static collectJunoTaskInfo(): Record<string, any> {
    const envVars: Record<string, string> = {};

    // Collect juno-task environment variables
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('JUNO_TASK_')) {
        envVars[key] = process.env[key] || '';
      }
    }

    return {
      version: '1.0.0', // TODO: Get from package.json
      environment: envVars,
      config: {
        // TODO: Get current config
      }
    };
  }

  /**
   * Format debug information for display
   */
  static formatDebugInfo(info: Record<string, any>): string {
    const lines: string[] = [];

    lines.push(chalk.blue.bold('Debug Information:'));
    lines.push('='.repeat(50));

    for (const [section, data] of Object.entries(info)) {
      lines.push(chalk.cyan(`\\n${section.charAt(0).toUpperCase() + section.slice(1)}:`));

      if (typeof data === 'object' && data !== null) {
        for (const [key, value] of Object.entries(data)) {
          lines.push(`  ${key}: ${JSON.stringify(value)}`);
        }
      } else {
        lines.push(`  ${JSON.stringify(data)}`);
      }
    }

    return lines.join('\\n');
  }
}

// Export singleton instance
export const cliErrorHandler = CLIErrorHandler.getInstance();