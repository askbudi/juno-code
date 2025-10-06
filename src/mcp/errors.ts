/**
 * MCP error definitions for juno-task-ts
 *
 * Provides comprehensive error classes and utilities for MCP operations,
 * including error codes, context tracking, recovery suggestions, and
 * specialized error types for different failure scenarios.
 *
 * @module mcp/errors
 * @version 1.0.0
 */

// =============================================================================
// Error Type Enums and Constants
// =============================================================================

/**
 * MCP error categories for targeted error handling
 */
export enum MCPErrorType {
  CONNECTION = 'connection',
  TIMEOUT = 'timeout',
  RATE_LIMIT = 'rate_limit',
  TOOL_EXECUTION = 'tool_execution',
  VALIDATION = 'validation',
  SERVER_NOT_FOUND = 'server_not_found',
  PROTOCOL = 'protocol',
  AUTHENTICATION = 'authentication'
}

/**
 * Error codes for specific error conditions
 */
export enum MCPErrorCode {
  // Connection errors
  CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',
  CONNECTION_TIMEOUT = 'MCP_CONNECTION_TIMEOUT',
  CONNECTION_REFUSED = 'MCP_CONNECTION_REFUSED',
  CONNECTION_LOST = 'MCP_CONNECTION_LOST',
  RECONNECTION_FAILED = 'MCP_RECONNECTION_FAILED',

  // Tool execution errors
  TOOL_NOT_FOUND = 'MCP_TOOL_NOT_FOUND',
  TOOL_EXECUTION_FAILED = 'MCP_TOOL_EXECUTION_FAILED',
  TOOL_TIMEOUT = 'MCP_TOOL_TIMEOUT',
  TOOL_INVALID_ARGUMENTS = 'MCP_TOOL_INVALID_ARGUMENTS',

  // Rate limit errors
  RATE_LIMIT_EXCEEDED = 'MCP_RATE_LIMIT_EXCEEDED',
  RATE_LIMIT_HOURLY = 'MCP_RATE_LIMIT_HOURLY',
  RATE_LIMIT_DAILY = 'MCP_RATE_LIMIT_DAILY',

  // Validation errors
  VALIDATION_FAILED = 'MCP_VALIDATION_FAILED',
  INVALID_REQUEST = 'MCP_INVALID_REQUEST',
  MISSING_PARAMETERS = 'MCP_MISSING_PARAMETERS',
  INVALID_PARAMETERS = 'MCP_INVALID_PARAMETERS',

  // Server errors
  SERVER_NOT_FOUND = 'MCP_SERVER_NOT_FOUND',
  SERVER_NOT_EXECUTABLE = 'MCP_SERVER_NOT_EXECUTABLE',
  SERVER_STARTUP_FAILED = 'MCP_SERVER_STARTUP_FAILED',
  SERVER_CRASHED = 'MCP_SERVER_CRASHED',

  // Protocol errors
  PROTOCOL_ERROR = 'MCP_PROTOCOL_ERROR',
  INVALID_RESPONSE = 'MCP_INVALID_RESPONSE',
  VERSION_MISMATCH = 'MCP_VERSION_MISMATCH',

  // Authentication errors
  AUTHENTICATION_FAILED = 'MCP_AUTHENTICATION_FAILED',
  UNAUTHORIZED = 'MCP_UNAUTHORIZED',
  TOKEN_EXPIRED = 'MCP_TOKEN_EXPIRED'
}

/**
 * Rate limit message patterns for parsing reset times
 */
export const RATE_LIMIT_PATTERNS = [
  // Unix timestamp patterns (must come first to avoid conflicts)
  /resets?\s+(?:at\s+)?(\d{10,13})/i,

  // ISO date patterns
  /resets?\s+(?:at\s+)?([\d-]+T[\d:.]+Z?)/i,

  // Standard patterns
  /resets\s+(?:at\s+)?(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
  /resets\s+(?:at\s+)?(\d{1,2})\s*(am|pm)/i,

  // Duration-based patterns
  /try again in (\d+)\s*(minutes?|hours?|seconds?)/i,
  /wait\s+(\d+)\s*(minutes?|hours?|seconds?)/i,

  // Specific service patterns
  /5-hour limit reached.*resets\s+(?:at\s+)?(\d{1,2})\s*(am|pm)/i,
  /hourly limit.*resets\s+(?:at\s+)?(\d{1,2}):(\d{2})/i
] as const;

// =============================================================================
// Error Context Interfaces
// =============================================================================

/**
 * Base error options for MCP errors
 */
export interface MCPErrorOptions {
  /** Error code for programmatic handling */
  readonly code?: MCPErrorCode;

  /** Operation context when error occurred */
  readonly context?: string;

  /** Retry information */
  readonly retryInfo?: RetryInfo;

  /** Recovery suggestions for the user */
  readonly recoverySuggestions?: readonly string[];

  /** Cause error for error chaining */
  readonly cause?: Error;

  /** Additional metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Retry information for error context
 */
export interface RetryInfo {
  /** Current attempt number */
  readonly attempt: number;

  /** Maximum attempts allowed */
  readonly maxAttempts: number;

  /** Next retry time */
  readonly nextRetryTime?: Date;

  /** Retry strategy used */
  readonly strategy: string;

  /** Backoff delay in milliseconds */
  readonly backoffDelay?: number;
}

/**
 * Server information for connection errors
 */
export interface ServerInfo {
  /** Server executable path */
  readonly path: string;

  /** Server version */
  readonly version?: string;

  /** Process ID */
  readonly pid?: number;

  /** Server status */
  readonly status: string;

  /** Server arguments */
  readonly args?: readonly string[];

  /** Working directory */
  readonly workingDirectory?: string;
}

/**
 * Tool information for tool errors
 */
export interface ToolInfo {
  /** Tool name */
  readonly name: string;

  /** Tool version */
  readonly version?: string;

  /** Subagent type */
  readonly subagent: string;

  /** Model used */
  readonly model?: string;

  /** Tool capabilities */
  readonly capabilities?: readonly string[];
}

/**
 * Tool execution details for error context
 */
export interface ToolExecutionDetails {
  /** Execution start time */
  readonly startTime: Date;

  /** Execution duration in milliseconds */
  readonly duration: number;

  /** Arguments used */
  readonly arguments: Readonly<Record<string, unknown>>;

  /** Progress events captured */
  readonly progressEvents?: readonly unknown[];

  /** Execution timeout */
  readonly timeout?: number;

  /** Session ID */
  readonly sessionId?: string;
}

// =============================================================================
// Base MCP Error Class
// =============================================================================

/**
 * Base MCP error class with enhanced context and recovery information
 */
export abstract class MCPError extends Error {
  /** Error type classification */
  public readonly type: MCPErrorType;

  /** Error code for programmatic handling */
  public readonly code: MCPErrorCode;

  /** Error timestamp */
  public readonly timestamp: Date;

  /** Operation context */
  public readonly context?: string;

  /** Retry information */
  public readonly retryInfo?: RetryInfo;

  /** Recovery suggestions */
  public readonly recoverySuggestions?: readonly string[];

  /** Additional metadata */
  public readonly metadata?: Readonly<Record<string, unknown>>;

  /** Cause error for error chaining */
  public readonly cause?: Error;

  constructor(
    message: string,
    type: MCPErrorType,
    code: MCPErrorCode,
    options?: MCPErrorOptions
  ) {
    super(message);
    this.name = this.constructor.name;
    this.type = type;
    this.code = options?.code ?? code;
    this.timestamp = new Date();
    this.context = options?.context;
    this.retryInfo = options?.retryInfo;
    this.recoverySuggestions = options?.recoverySuggestions;
    this.metadata = options?.metadata;
    this.cause = options?.cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Get user-friendly error message
   */
  getUserMessage(): string {
    return this.message;
  }

  /**
   * Get technical error details
   */
  getTechnicalDetails(): string {
    const details = [
      `Error: ${this.name}`,
      `Type: ${this.type}`,
      `Code: ${this.code}`,
      `Message: ${this.message}`,
      `Timestamp: ${this.timestamp.toISOString()}`,
    ];

    if (this.context) {
      details.push(`Context: ${this.context}`);
    }

    if (this.retryInfo) {
      details.push(`Retry: ${this.retryInfo.attempt}/${this.retryInfo.maxAttempts}`);
    }

    if (this.cause) {
      details.push(`Cause: ${this.cause.message}`);
    }

    return details.join('\n');
  }

  /**
   * Check if error is retryable
   */
  isRetryable(): boolean {
    if (!this.retryInfo) {
      return false;
    }
    return this.retryInfo.attempt < this.retryInfo.maxAttempts;
  }

  /**
   * Get time until next retry
   */
  getRetryDelay(): number {
    if (!this.retryInfo?.nextRetryTime) {
      return 0;
    }
    return Math.max(0, this.retryInfo.nextRetryTime.getTime() - Date.now());
  }

  /**
   * Serialize error to JSON
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      type: this.type,
      code: this.code,
      message: this.message,
      timestamp: this.timestamp.toISOString(),
      context: this.context,
      retryInfo: this.retryInfo,
      recoverySuggestions: this.recoverySuggestions,
      metadata: this.metadata,
      stack: this.stack,
    };
  }
}

// =============================================================================
// Connection Error Classes
// =============================================================================

/**
 * MCP connection error for server connection failures
 */
export class MCPConnectionError extends MCPError {
  /** Server information */
  public readonly serverInfo?: ServerInfo;

  constructor(
    message: string,
    context?: string,
    serverInfo?: ServerInfo,
    options?: MCPErrorOptions
  ) {
    const code = options?.code ?? MCPErrorCode.CONNECTION_FAILED;
    const suggestions = options?.recoverySuggestions ?? [
      'Check if the MCP server is running',
      'Verify server path and permissions',
      'Check network connectivity',
      'Review server configuration',
    ];

    super(message, MCPErrorType.CONNECTION, code, {
      ...options,
      context,
      recoverySuggestions: suggestions,
    });

    this.serverInfo = serverInfo;
  }

  /**
   * Create connection timeout error
   */
  static timeout(timeoutMs: number, serverPath?: string): MCPConnectionError {
    return new MCPConnectionError(
      `Connection timeout after ${timeoutMs}ms`,
      'connection_timeout',
      serverPath ? { path: serverPath, status: 'timeout' } : undefined,
      {
        code: MCPErrorCode.CONNECTION_TIMEOUT,
        recoverySuggestions: [
          'Increase connection timeout value',
          'Check server responsiveness',
          'Verify network latency',
        ],
      }
    );
  }

  /**
   * Create connection refused error
   */
  static refused(serverPath: string, port?: number): MCPConnectionError {
    return new MCPConnectionError(
      `Connection refused to ${serverPath}${port ? `:${port}` : ''}`,
      'connection_refused',
      { path: serverPath, status: 'refused' },
      {
        code: MCPErrorCode.CONNECTION_REFUSED,
        recoverySuggestions: [
          'Verify server is running and listening',
          'Check server address and port',
          'Review firewall settings',
        ],
      }
    );
  }

  /**
   * Create server not found error
   */
  static serverNotFound(serverPath: string): MCPConnectionError {
    return new MCPConnectionError(
      `MCP server not found at path: ${serverPath}`,
      'server_discovery',
      { path: serverPath, status: 'not_found' },
      {
        code: MCPErrorCode.SERVER_NOT_FOUND,
        recoverySuggestions: [
          'Check server installation path',
          'Verify executable permissions',
          'Install the MCP server package',
          'Update PATH environment variable',
        ],
      }
    );
  }
}

// =============================================================================
// Tool Error Classes
// =============================================================================

/**
 * MCP tool execution error
 */
export class MCPToolError extends MCPError {
  /** Tool information */
  public readonly toolInfo: ToolInfo;

  /** Execution details */
  public readonly executionDetails?: ToolExecutionDetails;

  constructor(
    message: string,
    toolInfo: ToolInfo,
    context?: string,
    options?: MCPErrorOptions & { executionDetails?: ToolExecutionDetails }
  ) {
    const code = options?.code ?? MCPErrorCode.TOOL_EXECUTION_FAILED;
    const suggestions = options?.recoverySuggestions ?? [
      'Check tool arguments and parameters',
      'Verify tool is available and accessible',
      'Review tool documentation',
      'Check server logs for details',
    ];

    super(message, MCPErrorType.TOOL_EXECUTION, code, {
      ...options,
      context,
      recoverySuggestions: suggestions,
    });

    this.toolInfo = toolInfo;
    this.executionDetails = options?.executionDetails;
  }

  /**
   * Create tool not found error
   */
  static notFound(toolName: string): MCPToolError {
    return new MCPToolError(
      `Tool not found: ${toolName}`,
      { name: toolName, subagent: 'unknown' },
      'tool_discovery',
      {
        code: MCPErrorCode.TOOL_NOT_FOUND,
        recoverySuggestions: [
          'Check available tools with listTools()',
          'Verify tool name spelling',
          'Ensure MCP server supports this tool',
        ],
      }
    );
  }

  /**
   * Create tool timeout error
   */
  static timeout(
    toolName: string,
    timeoutMs: number,
    executionDetails?: ToolExecutionDetails
  ): MCPToolError {
    return new MCPToolError(
      `Tool execution timeout: ${toolName} (${timeoutMs}ms)`,
      { name: toolName, subagent: 'unknown' },
      'tool_timeout',
      {
        code: MCPErrorCode.TOOL_TIMEOUT,
        executionDetails,
        recoverySuggestions: [
          'Increase tool execution timeout',
          'Check tool complexity and resource usage',
          'Consider breaking task into smaller parts',
        ],
      }
    );
  }

  /**
   * Create invalid arguments error
   */
  static invalidArguments(
    toolName: string,
    invalidArgs: Record<string, unknown>,
    expectedFormat?: string
  ): MCPToolError {
    return new MCPToolError(
      `Invalid arguments for tool: ${toolName}`,
      { name: toolName, subagent: 'unknown' },
      'argument_validation',
      {
        code: MCPErrorCode.TOOL_INVALID_ARGUMENTS,
        metadata: { invalidArgs, expectedFormat },
        recoverySuggestions: [
          'Check tool documentation for required arguments',
          'Verify argument types and formats',
          'Review tool schema definition',
        ],
      }
    );
  }
}

// =============================================================================
// Timeout Error Classes
// =============================================================================

/**
 * MCP timeout error for operation timeouts
 */
export class MCPTimeoutError extends MCPError {
  /** Timeout duration in milliseconds */
  public readonly timeoutMs: number;

  /** Operation type that timed out */
  public readonly operationType: string;

  constructor(
    message: string,
    timeoutMs: number,
    operationType: string,
    context?: string,
    options?: MCPErrorOptions
  ) {
    const code = options?.code ?? MCPErrorCode.CONNECTION_TIMEOUT;
    const suggestions = options?.recoverySuggestions ?? [
      'Increase timeout value',
      'Check operation complexity',
      'Verify network connectivity',
      'Consider breaking operation into smaller parts',
    ];

    super(message, MCPErrorType.TIMEOUT, code, {
      ...options,
      context,
      recoverySuggestions: suggestions,
    });

    this.timeoutMs = timeoutMs;
    this.operationType = operationType;
  }

  /**
   * Create connection timeout error
   */
  static connection(timeoutMs: number): MCPTimeoutError {
    return new MCPTimeoutError(
      `Connection timeout after ${timeoutMs}ms`,
      timeoutMs,
      'connection',
      'mcp_connection',
      {
        code: MCPErrorCode.CONNECTION_TIMEOUT,
        recoverySuggestions: [
          'Increase connection timeout',
          'Check server startup time',
          'Verify network latency',
        ],
      }
    );
  }

  /**
   * Create tool execution timeout error
   */
  static toolExecution(toolName: string, timeoutMs: number): MCPTimeoutError {
    return new MCPTimeoutError(
      `Tool execution timeout: ${toolName} (${timeoutMs}ms)`,
      timeoutMs,
      'tool_execution',
      `tool_${toolName}`,
      {
        code: MCPErrorCode.TOOL_TIMEOUT,
        recoverySuggestions: [
          'Increase tool execution timeout',
          'Optimize tool parameters',
          'Check tool resource usage',
        ],
      }
    );
  }
}

// =============================================================================
// Rate Limit Error Classes
// =============================================================================

/**
 * MCP rate limit error with reset time parsing
 */
export class MCPRateLimitError extends MCPError {
  /** Rate limit reset time */
  public readonly resetTime?: Date;

  /** Current rate limit tier */
  public readonly tier?: string;

  /** Requests remaining */
  public readonly remaining: number;

  /** Rate limit window */
  public readonly window?: string;

  constructor(
    message: string,
    remaining: number = 0,
    resetTime?: Date,
    tier?: string,
    context?: string,
    options?: MCPErrorOptions
  ) {
    const code = options?.code ?? MCPErrorCode.RATE_LIMIT_EXCEEDED;
    const waitTime = resetTime ? Math.ceil((resetTime.getTime() - Date.now()) / 1000) : 0;
    const suggestions = options?.recoverySuggestions ?? [
      `Wait ${waitTime > 0 ? waitTime + ' seconds' : 'for rate limit reset'}`,
      'Reduce request frequency',
      'Implement request queuing',
      'Consider upgrading service tier',
    ];

    super(message, MCPErrorType.RATE_LIMIT, code, {
      ...options,
      context,
      recoverySuggestions: suggestions,
      retryInfo: resetTime ? {
        attempt: 1,
        maxAttempts: 1,
        nextRetryTime: resetTime,
        strategy: 'rate_limit_wait',
      } : options?.retryInfo,
    });

    this.resetTime = resetTime;
    this.tier = tier;
    this.remaining = remaining;
  }

  /**
   * Parse rate limit error from message text
   */
  static fromMessage(message: string, context?: string): MCPRateLimitError {
    const resetTime = parseRateLimitResetTime(message);

    // Extract remaining requests if available
    const remainingMatch = message.match(/(\d+)\s*(?:requests?|calls?)\s*remaining/i);
    const remaining = remainingMatch ? parseInt(remainingMatch[1], 10) : 0;

    // Extract tier information if available
    const tierMatch = message.match(/tier[:\s]*([a-zA-Z0-9_-]+)/i);
    const tier = tierMatch ? tierMatch[1] : undefined;

    return new MCPRateLimitError(
      message,
      remaining,
      resetTime,
      tier,
      context,
      {
        code: MCPErrorCode.RATE_LIMIT_EXCEEDED,
        metadata: { originalMessage: message },
      }
    );
  }

  /**
   * Create hourly rate limit error
   */
  static hourly(resetTime: Date, remaining: number = 0): MCPRateLimitError {
    return new MCPRateLimitError(
      `Hourly rate limit exceeded. Resets at ${resetTime.toLocaleTimeString()}`,
      remaining,
      resetTime,
      'hourly',
      'hourly_limit',
      {
        code: MCPErrorCode.RATE_LIMIT_HOURLY,
      }
    );
  }

  /**
   * Create daily rate limit error
   */
  static daily(resetTime: Date, remaining: number = 0): MCPRateLimitError {
    return new MCPRateLimitError(
      `Daily rate limit exceeded. Resets at ${resetTime.toLocaleDateString()} ${resetTime.toLocaleTimeString()}`,
      remaining,
      resetTime,
      'daily',
      'daily_limit',
      {
        code: MCPErrorCode.RATE_LIMIT_DAILY,
      }
    );
  }

  /**
   * Get wait time in milliseconds
   */
  getWaitTimeMs(): number {
    if (!this.resetTime) {
      return 0;
    }
    return Math.max(0, this.resetTime.getTime() - Date.now());
  }

  /**
   * Get wait time in seconds
   */
  getWaitTimeSeconds(): number {
    return Math.ceil(this.getWaitTimeMs() / 1000);
  }
}

// =============================================================================
// Validation Error Classes
// =============================================================================

/**
 * MCP validation error for input validation failures
 */
export class MCPValidationError extends MCPError {
  /** Validation rule that failed */
  public readonly rule: string;

  /** Invalid value */
  public readonly value: unknown;

  /** Expected format/value */
  public readonly expected?: string;

  /** Field path for nested validation */
  public readonly field?: string;

  constructor(
    message: string,
    rule: string,
    value: unknown,
    expected?: string,
    field?: string,
    context?: string,
    options?: MCPErrorOptions
  ) {
    const code = options?.code ?? MCPErrorCode.VALIDATION_FAILED;
    const suggestions = options?.recoverySuggestions ?? [
      'Check parameter types and formats',
      'Refer to API documentation',
      'Validate input before sending',
    ];

    super(message, MCPErrorType.VALIDATION, code, {
      ...options,
      context,
      recoverySuggestions: suggestions,
    });

    this.rule = rule;
    this.value = value;
    this.expected = expected;
    this.field = field;
  }

  /**
   * Create required field error
   */
  static required(field: string): MCPValidationError {
    return new MCPValidationError(
      `Required field missing: ${field}`,
      'required',
      undefined,
      'non-empty value',
      field,
      'parameter_validation',
      {
        code: MCPErrorCode.MISSING_PARAMETERS,
      }
    );
  }

  /**
   * Create type mismatch error
   */
  static typeMismatch(
    field: string,
    value: unknown,
    expectedType: string
  ): MCPValidationError {
    return new MCPValidationError(
      `Invalid type for field '${field}': expected ${expectedType}, got ${typeof value}`,
      'type_mismatch',
      value,
      expectedType,
      field,
      'type_validation',
      {
        code: MCPErrorCode.INVALID_PARAMETERS,
      }
    );
  }

  /**
   * Create format error
   */
  static format(
    field: string,
    value: unknown,
    expectedFormat: string
  ): MCPValidationError {
    return new MCPValidationError(
      `Invalid format for field '${field}': expected ${expectedFormat}`,
      'format',
      value,
      expectedFormat,
      field,
      'format_validation',
      {
        code: MCPErrorCode.INVALID_PARAMETERS,
      }
    );
  }

  /**
   * Create range error
   */
  static range(
    field: string,
    value: unknown,
    min?: number,
    max?: number
  ): MCPValidationError {
    const range = min !== undefined && max !== undefined
      ? `${min}-${max}`
      : min !== undefined
        ? `>= ${min}`
        : `<= ${max}`;

    return new MCPValidationError(
      `Value out of range for field '${field}': expected ${range}`,
      'range',
      value,
      range,
      field,
      'range_validation',
      {
        code: MCPErrorCode.INVALID_PARAMETERS,
      }
    );
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse rate limit reset time from various message formats
 */
export function parseRateLimitResetTime(message: string): Date | undefined {
  for (const pattern of RATE_LIMIT_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      try {
        return parseTimeFromMatch(match);
      } catch {
        // Continue to next pattern
      }
    }
  }
  return undefined;
}

/**
 * Parse time information from regex match
 */
function parseTimeFromMatch(match: RegExpMatchArray): Date | undefined {
  const [, time1, time2, period] = match;

  // Handle ISO date string (check before Unix timestamp to avoid conflicts)
  if (time1 && time1.includes('T')) {
    return new Date(time1);
  }

  // Handle Unix timestamp
  if (time1 && time1.length >= 10) {
    const timestamp = parseInt(time1, 10);
    return new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
  }

  // Handle duration-based patterns
  if (time2 && (time2.includes('minute') || time2.includes('hour') || time2.includes('second'))) {
    const duration = parseInt(time1, 10);
    const unit = time2.toLowerCase();
    const now = new Date();

    if (unit.includes('minute')) {
      return new Date(now.getTime() + duration * 60 * 1000);
    } else if (unit.includes('hour')) {
      return new Date(now.getTime() + duration * 60 * 60 * 1000);
    } else if (unit.includes('second')) {
      return new Date(now.getTime() + duration * 1000);
    }
  }

  // Handle time-based patterns (e.g., "3:30 PM", "15:30")
  if (time1) {
    const hour = parseInt(time1, 10);
    const minute = time2 ? parseInt(time2, 10) : 0;
    let adjustedHour = hour;

    if (period) {
      const isPM = period.toLowerCase().includes('pm');
      if (isPM && hour < 12) {
        adjustedHour += 12;
      } else if (!isPM && hour === 12) {
        adjustedHour = 0;
      }
    }

    const resetTime = new Date();
    resetTime.setHours(adjustedHour, minute, 0, 0);

    // If the time has passed today, set it for tomorrow
    if (resetTime <= new Date()) {
      resetTime.setDate(resetTime.getDate() + 1);
    }

    return resetTime;
  }

  return undefined;
}

/**
 * Type guards for error checking
 */

/**
 * Check if error is an MCP error
 */
export function isMCPError(error: unknown): error is MCPError {
  return error instanceof MCPError;
}

/**
 * Check if error is a connection error
 */
export function isConnectionError(error: unknown): error is MCPConnectionError {
  return error instanceof MCPConnectionError;
}

/**
 * Check if error is a tool error
 */
export function isToolError(error: unknown): error is MCPToolError {
  return error instanceof MCPToolError;
}

/**
 * Check if error is a timeout error
 */
export function isTimeoutError(error: unknown): error is MCPTimeoutError {
  return error instanceof MCPTimeoutError;
}

/**
 * Check if error is a rate limit error
 */
export function isRateLimitError(error: unknown): error is MCPRateLimitError {
  return error instanceof MCPRateLimitError;
}

/**
 * Check if error is a validation error
 */
export function isValidationError(error: unknown): error is MCPValidationError {
  return error instanceof MCPValidationError;
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!isMCPError(error)) {
    return false;
  }

  // Rate limits are retryable after the reset time
  if (isRateLimitError(error)) {
    return true;
  }

  // Connection errors are usually retryable
  if (isConnectionError(error)) {
    return true;
  }

  // Some timeout errors are retryable
  if (isTimeoutError(error)) {
    return true;
  }

  // Validation errors are not retryable
  if (isValidationError(error)) {
    return false;
  }

  return error.isRetryable();
}

/**
 * Get error category for recovery strategy
 */
export function getErrorCategory(error: unknown): MCPErrorType | 'unknown' {
  if (isMCPError(error)) {
    return error.type;
  }
  return 'unknown';
}

/**
 * Format error for user display
 */
export function formatErrorForUser(error: unknown): string {
  if (isMCPError(error)) {
    return error.getUserMessage();
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Format error for logging
 */
export function formatErrorForLogging(error: unknown): string {
  if (isMCPError(error)) {
    return error.getTechnicalDetails();
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack || 'No stack trace'}`;
  }

  return `Unknown error: ${JSON.stringify(error)}`;
}

/**
 * Extract recovery suggestions from error
 */
export function getRecoverySuggestions(error: unknown): string[] {
  if (isMCPError(error) && error.recoverySuggestions) {
    return Array.from(error.recoverySuggestions);
  }

  // Default suggestions based on error type
  if (isConnectionError(error)) {
    return [
      'Check network connectivity',
      'Verify server is running',
      'Check server configuration',
    ];
  }

  if (isRateLimitError(error)) {
    return [
      'Wait for rate limit reset',
      'Reduce request frequency',
      'Implement request queuing',
    ];
  }

  if (isValidationError(error)) {
    return [
      'Check input parameters',
      'Refer to API documentation',
      'Validate data before sending',
    ];
  }

  return [
    'Check error message for details',
    'Review configuration',
    'Contact support if problem persists',
  ];
}

/**
 * Create error chain from multiple errors
 */
export function createErrorChain(errors: Error[]): MCPError {
  if (errors.length === 0) {
    return new MCPConnectionError('Unknown error occurred', 'error_chain');
  }

  if (errors.length === 1) {
    const error = errors[0];
    if (isMCPError(error)) {
      return error;
    }
    return new MCPConnectionError(error.message, 'wrapped_error', undefined, {
      cause: error,
    });
  }

  const primaryError = errors[0];
  const additionalErrors = errors.slice(1);

  return new MCPConnectionError(
    `Multiple errors occurred: ${primaryError.message}`,
    'error_chain',
    undefined,
    {
      cause: primaryError,
      metadata: {
        additionalErrors: additionalErrors.map(e => ({
          name: e.name,
          message: e.message,
        })),
      },
      recoverySuggestions: [
        'Address the primary error first',
        'Check for cascading failures',
        'Review system configuration',
      ],
    }
  );
}

// =============================================================================
// Error Recovery Utilities
// =============================================================================

/**
 * Error recovery strategy type
 */
export type ErrorRecoveryStrategy =
  | 'retry'
  | 'wait'
  | 'reconnect'
  | 'fallback'
  | 'abort'
  | 'manual';

/**
 * Get recommended recovery strategy for error
 */
export function getRecoveryStrategy(error: unknown): ErrorRecoveryStrategy {
  if (isRateLimitError(error)) {
    return 'wait';
  }

  if (isConnectionError(error)) {
    return 'reconnect';
  }

  if (isTimeoutError(error)) {
    return 'retry';
  }

  if (isValidationError(error)) {
    return 'manual';
  }

  if (isToolError(error)) {
    return 'fallback';
  }

  return 'abort';
}

/**
 * Calculate retry delay based on error and attempt
 */
export function calculateRetryDelay(
  error: unknown,
  attempt: number,
  baseDelay: number = 1000,
  maxDelay: number = 30000
): number {
  if (isRateLimitError(error)) {
    return error.getWaitTimeMs();
  }

  // Exponential backoff with jitter
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
  const jitter = exponentialDelay * 0.1 * (Math.random() - 0.5);

  return Math.max(0, exponentialDelay + jitter);
}

// All exports are already declared above with their class definitions