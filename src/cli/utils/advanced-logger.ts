/**
 * Advanced Log Formatting System for juno-code
 *
 * Provides structured, colorized logging with multiple log levels and contexts.
 * All output goes to stderr to keep stdout clean for structured results.
 */

import chalk from 'chalk';

// ============================================================================
// Log Level and Context Types
// ============================================================================

export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  FATAL = 5
}

export enum LogContext {
  CLI = 'CLI',
  MCP = 'MCP',
  ENGINE = 'ENGINE',
  SESSION = 'SESSION',
  TEMPLATE = 'TEMPLATE',
  CONFIG = 'CONFIG',
  PERFORMANCE = 'PERFORMANCE',
  SYSTEM = 'SYSTEM'
}

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  context: LogContext;
  message: string;
  data?: any;
  duration?: number;
}

export interface LoggerOptions {
  level: LogLevel;
  showTimestamp: boolean;
  showContext: boolean;
  showLevel: boolean;
  colorize: boolean;
  output: 'console';
}

// ============================================================================
// Advanced Logger Class
// ============================================================================

export class AdvancedLogger {
  private options: LoggerOptions;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = {
      level: LogLevel.INFO,
      showTimestamp: true,
      showContext: true,
      showLevel: true,
      colorize: true,
      output: 'console',
      ...options
    };
  }

  trace(message: string, context: LogContext = LogContext.SYSTEM, data?: any): void {
    this.log(LogLevel.TRACE, message, context, data);
  }

  debug(message: string, context: LogContext = LogContext.SYSTEM, data?: any): void {
    this.log(LogLevel.DEBUG, message, context, data);
  }

  info(message: string, context: LogContext = LogContext.SYSTEM, data?: any): void {
    this.log(LogLevel.INFO, message, context, data);
  }

  warn(message: string, context: LogContext = LogContext.SYSTEM, data?: any): void {
    this.log(LogLevel.WARN, message, context, data);
  }

  error(message: string, context: LogContext = LogContext.SYSTEM, data?: any): void {
    this.log(LogLevel.ERROR, message, context, data);
  }

  fatal(message: string, context: LogContext = LogContext.SYSTEM, data?: any): void {
    this.log(LogLevel.FATAL, message, context, data);
  }

  /**
   * Change log level
   */
  setLevel(level: LogLevel): void {
    this.options.level = level;
  }

  /**
   * Create a child logger with specific context
   */
  child(context: LogContext): ContextLogger {
    return new ContextLogger(this, context);
  }

  /**
   * Core logging method
   */
  private log(level: LogLevel, message: string, context: LogContext, data?: any): void {
    if (level < this.options.level) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      context,
      message,
      data
    };

    const formatted = this.formatSimple(entry);
    this.output(formatted);
  }

  /**
   * Simple format: [LEVEL] [CONTEXT] Message (duration)
   */
  private formatSimple(entry: LogEntry): string {
    const parts: string[] = [];

    if (this.options.showLevel) {
      const levelStr = this.formatLevel(entry.level);
      parts.push(`[${levelStr}]`);
    }

    if (this.options.showContext) {
      const contextStr = this.options.colorize
        ? chalk.gray(`[${entry.context}]`)
        : `[${entry.context}]`;
      parts.push(contextStr);
    }

    parts.push(entry.message);

    if (entry.duration !== undefined) {
      const durationStr = this.options.colorize
        ? chalk.cyan(`(${entry.duration}ms)`)
        : `(${entry.duration}ms)`;
      parts.push(durationStr);
    }

    return parts.join(' ');
  }

  /**
   * Format log level with appropriate color
   */
  private formatLevel(level: LogLevel): string {
    const levelName = LogLevel[level].padEnd(5);

    if (!this.options.colorize) return levelName;

    switch (level) {
      case LogLevel.TRACE:
        return chalk.gray(levelName);
      case LogLevel.DEBUG:
        return chalk.blue(levelName);
      case LogLevel.INFO:
        return chalk.green(levelName);
      case LogLevel.WARN:
        return chalk.yellow(levelName);
      case LogLevel.ERROR:
        return chalk.red(levelName);
      case LogLevel.FATAL:
        return chalk.redBright.bold(levelName);
      default:
        return levelName;
    }
  }

  /**
   * Output formatted log to stderr
   */
  private output(formatted: string): void {
    console.error(formatted);
  }
}

// ============================================================================
// Context Logger Class
// ============================================================================

export class ContextLogger {
  constructor(
    private parent: AdvancedLogger,
    private context: LogContext
  ) {}

  trace(message: string, data?: any): void {
    this.parent.trace(message, this.context, data);
  }

  debug(message: string, data?: any): void {
    this.parent.debug(message, this.context, data);
  }

  info(message: string, data?: any): void {
    this.parent.info(message, this.context, data);
  }

  warn(message: string, data?: any): void {
    this.parent.warn(message, this.context, data);
  }

  error(message: string, data?: any): void {
    this.parent.error(message, this.context, data);
  }

  fatal(message: string, data?: any): void {
    this.parent.fatal(message, this.context, data);
  }
}

// ============================================================================
// Global Logger Instance
// ============================================================================

export const logger = new AdvancedLogger({
  level: LogLevel.INFO,
  colorize: true,
  output: 'console'
});

// Export context-specific loggers
export const cliLogger = logger.child(LogContext.CLI);
export const mcpLogger = logger.child(LogContext.MCP);
export const engineLogger = logger.child(LogContext.ENGINE);
export const sessionLogger = logger.child(LogContext.SESSION);
export const templateLogger = logger.child(LogContext.TEMPLATE);
export const configLogger = logger.child(LogContext.CONFIG);
export const performanceLogger = logger.child(LogContext.PERFORMANCE);

export default AdvancedLogger;
