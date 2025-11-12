/**
 * Advanced Log Formatting System for juno-task-ts
 *
 * Provides structured, colorized logging with Python Rich-style aesthetics.
 * Supports multiple log levels, contexts, and output formats.
 */

import chalk from 'chalk';
import { RichFormatter } from './rich-formatter.js';

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
  metadata?: Record<string, any>;
  duration?: number;
  requestId?: string;
  sessionId?: string;
}

export interface LoggerOptions {
  level: LogLevel;
  showTimestamp: boolean;
  showContext: boolean;
  showLevel: boolean;
  colorize: boolean;
  format: 'simple' | 'detailed' | 'json' | 'rich';
  output: 'console' | 'file' | 'both';
  filename?: string;
  maxFileSize?: number; // MB
  maxFiles?: number;
}

// ============================================================================
// Log Formatters
// ============================================================================

export class LogFormatter {
  private richFormatter: RichFormatter;

  constructor() {
    this.richFormatter = new RichFormatter();
  }

  /**
   * Format log entry based on specified format
   */
  format(entry: LogEntry, options: LoggerOptions): string {
    switch (options.format) {
      case 'simple':
        return this.formatSimple(entry, options);
      case 'detailed':
        return this.formatDetailed(entry, options);
      case 'json':
        return this.formatJson(entry);
      case 'rich':
        return this.formatRich(entry, options);
      default:
        return this.formatSimple(entry, options);
    }
  }

  /**
   * Simple format: [LEVEL] Message
   */
  private formatSimple(entry: LogEntry, options: LoggerOptions): string {
    const parts: string[] = [];

    if (options.showLevel) {
      const levelStr = this.formatLevel(entry.level, options.colorize);
      parts.push(`[${levelStr}]`);
    }

    if (options.showContext) {
      const contextStr = options.colorize ?
        chalk.gray(`[${entry.context}]`) :
        `[${entry.context}]`;
      parts.push(contextStr);
    }

    parts.push(entry.message);

    if (entry.duration !== undefined) {
      const durationStr = options.colorize ?
        chalk.cyan(`(${entry.duration}ms)`) :
        `(${entry.duration}ms)`;
      parts.push(durationStr);
    }

    return parts.join(' ');
  }

  /**
   * Detailed format: [TIMESTAMP] [LEVEL] [CONTEXT] Message + Data
   */
  private formatDetailed(entry: LogEntry, options: LoggerOptions): string {
    const parts: string[] = [];

    if (options.showTimestamp) {
      const timeStr = entry.timestamp.toISOString();
      const formattedTime = options.colorize ?
        chalk.gray(timeStr) :
        timeStr;
      parts.push(`[${formattedTime}]`);
    }

    if (options.showLevel) {
      const levelStr = this.formatLevel(entry.level, options.colorize);
      parts.push(`[${levelStr}]`);
    }

    if (options.showContext) {
      const contextStr = options.colorize ?
        chalk.gray(`[${entry.context}]`) :
        `[${entry.context}]`;
      parts.push(contextStr);
    }

    if (entry.requestId) {
      const reqStr = options.colorize ?
        chalk.blue(`[${entry.requestId.slice(0, 8)}]`) :
        `[${entry.requestId.slice(0, 8)}]`;
      parts.push(reqStr);
    }

    parts.push(entry.message);

    if (entry.duration !== undefined) {
      const durationStr = options.colorize ?
        chalk.cyan(`(${entry.duration}ms)`) :
        `(${entry.duration}ms)`;
      parts.push(durationStr);
    }

    let result = parts.join(' ');

    // Add data if present
    if (entry.data) {
      const dataStr = typeof entry.data === 'string' ?
        entry.data :
        JSON.stringify(entry.data, null, 2);

      if (options.colorize) {
        result += '\n' + chalk.gray(this.indent(dataStr, 2));
      } else {
        result += '\n' + this.indent(dataStr, 2);
      }
    }

    return result;
  }

  /**
   * JSON format for structured logging
   */
  private formatJson(entry: LogEntry): string {
    return JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      level: LogLevel[entry.level],
      context: entry.context,
      message: entry.message,
      data: entry.data,
      metadata: entry.metadata,
      duration: entry.duration,
      requestId: entry.requestId,
      sessionId: entry.sessionId
    });
  }

  /**
   * Rich format with panels and styling
   */
  private formatRich(entry: LogEntry, options: LoggerOptions): string {
    const icon = this.getLevelIcon(entry.level);
    const color = this.getLevelColor(entry.level);

    let content = `${icon} ${entry.message}`;

    if (entry.duration !== undefined) {
      content += ` ${chalk.cyan(`(${entry.duration}ms)`)}`;
    }

    if (entry.data) {
      const dataStr = typeof entry.data === 'string' ?
        entry.data :
        JSON.stringify(entry.data, null, 2);
      content += '\n\n' + chalk.gray(dataStr);
    }

    const title = `${LogLevel[entry.level]} - ${entry.context}`;

    return this.richFormatter.panel(content, {
      title,
      border: 'rounded',
      style: this.getLevelPanelStyle(entry.level),
      padding: 1
    });
  }

  /**
   * Format log level with appropriate styling
   */
  private formatLevel(level: LogLevel, colorize: boolean): string {
    const levelName = LogLevel[level].padEnd(5);

    if (!colorize) return levelName;

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
   * Get icon for log level
   */
  private getLevelIcon(level: LogLevel): string {
    switch (level) {
      case LogLevel.TRACE: return '🔍';
      case LogLevel.DEBUG: return '🐛';
      case LogLevel.INFO: return 'ℹ️';
      case LogLevel.WARN: return '⚠️';
      case LogLevel.ERROR: return '❌';
      case LogLevel.FATAL: return '💀';
      default: return '📝';
    }
  }

  /**
   * Get color for log level
   */
  private getLevelColor(level: LogLevel): string {
    switch (level) {
      case LogLevel.TRACE: return 'gray';
      case LogLevel.DEBUG: return 'blue';
      case LogLevel.INFO: return 'green';
      case LogLevel.WARN: return 'yellow';
      case LogLevel.ERROR: return 'red';
      case LogLevel.FATAL: return 'redBright';
      default: return 'white';
    }
  }

  /**
   * Get panel style for log level
   */
  private getLevelPanelStyle(level: LogLevel): string {
    switch (level) {
      case LogLevel.TRACE: return 'muted';
      case LogLevel.DEBUG: return 'info';
      case LogLevel.INFO: return 'success';
      case LogLevel.WARN: return 'warning';
      case LogLevel.ERROR: return 'error';
      case LogLevel.FATAL: return 'critical';
      default: return 'default';
    }
  }

  /**
   * Indent text by specified spaces
   */
  private indent(text: string, spaces: number): string {
    const prefix = ' '.repeat(spaces);
    return text.split('\n').map(line => prefix + line).join('\n');
  }
}

// ============================================================================
// Advanced Logger Class
// ============================================================================

export class AdvancedLogger {
  private options: LoggerOptions;
  private formatter: LogFormatter;
  private entries: LogEntry[] = [];
  private maxEntries: number = 1000;
  private timers: Map<string, number> = new Map();

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = {
      level: LogLevel.INFO,
      showTimestamp: true,
      showContext: true,
      showLevel: true,
      colorize: true,
      format: 'detailed',
      output: 'console',
      maxFileSize: 10, // MB
      maxFiles: 5,
      ...options
    };

    this.formatter = new LogFormatter();
  }

  /**
   * Log at TRACE level
   */
  trace(message: string, context: LogContext = LogContext.SYSTEM, data?: any, metadata?: Record<string, any>): void {
    this.log(LogLevel.TRACE, message, context, data, metadata);
  }

  /**
   * Log at DEBUG level
   */
  debug(message: string, context: LogContext = LogContext.SYSTEM, data?: any, metadata?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, context, data, metadata);
  }

  /**
   * Log at INFO level
   */
  info(message: string, context: LogContext = LogContext.SYSTEM, data?: any, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, context, data, metadata);
  }

  /**
   * Log at WARN level
   */
  warn(message: string, context: LogContext = LogContext.SYSTEM, data?: any, metadata?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, context, data, metadata);
  }

  /**
   * Log at ERROR level
   */
  error(message: string, context: LogContext = LogContext.SYSTEM, data?: any, metadata?: Record<string, any>): void {
    this.log(LogLevel.ERROR, message, context, data, metadata);
  }

  /**
   * Log at FATAL level
   */
  fatal(message: string, context: LogContext = LogContext.SYSTEM, data?: any, metadata?: Record<string, any>): void {
    this.log(LogLevel.FATAL, message, context, data, metadata);
  }

  /**
   * Core logging method
   */
  private log(
    level: LogLevel,
    message: string,
    context: LogContext,
    data?: any,
    metadata?: Record<string, any>
  ): void {
    // Check if level should be logged
    if (level < this.options.level) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      context,
      message,
      data,
      metadata
    };

    // Add to entries
    this.addEntry(entry);

    // Format and output
    const formatted = this.formatter.format(entry, this.options);
    this.output(formatted, level);
  }

  /**
   * Start a timer for performance logging
   */
  startTimer(key: string): void {
    this.timers.set(key, Date.now());
  }

  /**
   * End a timer and log the duration
   */
  endTimer(
    key: string,
    message: string,
    context: LogContext = LogContext.PERFORMANCE,
    level: LogLevel = LogLevel.INFO
  ): number {
    const startTime = this.timers.get(key);
    if (!startTime) {
      this.warn(`Timer "${key}" not found`, LogContext.SYSTEM);
      return 0;
    }

    const duration = Date.now() - startTime;
    this.timers.delete(key);

    // Log with duration
    if (level >= this.options.level) {
      const entry: LogEntry = {
        timestamp: new Date(),
        level,
        context,
        message,
        duration
      };

      this.addEntry(entry);
      const formatted = this.formatter.format(entry, this.options);
      this.output(formatted, level);
    }

    return duration;
  }

  /**
   * Log with specific request ID
   */
  logWithRequest(
    level: LogLevel,
    message: string,
    requestId: string,
    context: LogContext = LogContext.SYSTEM,
    data?: any
  ): void {
    if (level < this.options.level) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      context,
      message,
      data,
      requestId
    };

    this.addEntry(entry);
    const formatted = this.formatter.format(entry, this.options);
    this.output(formatted, level);
  }

  /**
   * Log with specific session ID
   */
  logWithSession(
    level: LogLevel,
    message: string,
    sessionId: string,
    context: LogContext = LogContext.SESSION,
    data?: any
  ): void {
    if (level < this.options.level) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      context,
      message,
      data,
      sessionId
    };

    this.addEntry(entry);
    const formatted = this.formatter.format(entry, this.options);
    this.output(formatted, level);
  }

  /**
   * Create a child logger with specific context
   */
  child(context: LogContext, metadata?: Record<string, any>): ContextLogger {
    return new ContextLogger(this, context, metadata);
  }

  /**
   * Change log level
   */
  setLevel(level: LogLevel): void {
    this.options.level = level;
  }

  /**
   * Change format
   */
  setFormat(format: 'simple' | 'detailed' | 'json' | 'rich'): void {
    this.options.format = format;
  }

  /**
   * Enable/disable colors
   */
  setColorize(colorize: boolean): void {
    this.options.colorize = colorize;
  }

  /**
   * Get recent log entries
   */
  getRecentEntries(count: number = 50): LogEntry[] {
    return this.entries.slice(-count);
  }

  /**
   * Get entries by level
   */
  getEntriesByLevel(level: LogLevel): LogEntry[] {
    return this.entries.filter(entry => entry.level === level);
  }

  /**
   * Get entries by context
   */
  getEntriesByContext(context: LogContext): LogEntry[] {
    return this.entries.filter(entry => entry.context === context);
  }

  /**
   * Clear all entries
   */
  clearEntries(): void {
    this.entries = [];
  }

  /**
   * Export entries as JSON
   */
  exportEntries(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  /**
   * Add entry to collection
   */
  private addEntry(entry: LogEntry): void {
    this.entries.push(entry);

    // Maintain max entries
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /**
   * Output formatted log
   */
  private output(formatted: string, level: LogLevel): void {
    if (this.options.output === 'console' || this.options.output === 'both') {
      // Use console.log for INFO level and below, console.error for WARN and above
      if (level >= LogLevel.WARN) {
        console.error(formatted);
      } else {
        console.log(formatted);
      }
    }

    if (this.options.output === 'file' || this.options.output === 'both') {
      this.writeToFile(formatted);
    }
  }

  /**
   * Write to file (placeholder - could implement file rotation)
   */
  private writeToFile(content: string): void {
    // File writing implementation would go here
    // Could use fs.appendFile with rotation logic
  }
}

// ============================================================================
// Context Logger Class
// ============================================================================

export class ContextLogger {
  constructor(
    private parent: AdvancedLogger,
    private context: LogContext,
    private metadata?: Record<string, any>
  ) {}

  trace(message: string, data?: any): void {
    this.parent.trace(message, this.context, data, this.metadata);
  }

  debug(message: string, data?: any): void {
    this.parent.debug(message, this.context, data, this.metadata);
  }

  info(message: string, data?: any): void {
    this.parent.info(message, this.context, data, this.metadata);
  }

  warn(message: string, data?: any): void {
    this.parent.warn(message, this.context, data, this.metadata);
  }

  error(message: string, data?: any): void {
    this.parent.error(message, this.context, data, this.metadata);
  }

  fatal(message: string, data?: any): void {
    this.parent.fatal(message, this.context, data, this.metadata);
  }

  startTimer(key: string): void {
    this.parent.startTimer(key);
  }

  endTimer(key: string, message: string, level: LogLevel = LogLevel.INFO): number {
    return this.parent.endTimer(key, message, this.context, level);
  }
}

// ============================================================================
// Global Logger Instance
// ============================================================================

export const logger = new AdvancedLogger({
  level: LogLevel.INFO,
  format: 'detailed',
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