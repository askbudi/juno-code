/**
 * MCP Error Classes for Unified Error Hierarchy
 *
 * Migrates and enhances existing MCP error classes to work with
 * the unified error hierarchy while preserving existing functionality.
 */

import { JunoTaskError, RecoveryAction, RecoveryActionType } from './base';
import { ErrorCategory } from './categories';
import { ErrorCode } from './codes';
import type { ErrorContext } from './context';

/**
 * Base class for all MCP-related errors
 */
export abstract class MCPError extends JunoTaskError {
  public readonly category = ErrorCategory.MCP;
  public abstract readonly code: ErrorCode;
}

/**
 * MCP connection error
 */
export class MCPConnectionError extends MCPError {
  public readonly code = ErrorCode.MCP_CONNECTION_FAILED;

  constructor(
    serverName: string,
    details?: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
      serverConfig?: Record<string, unknown>;
    }
  ) {
    let message = `Failed to connect to MCP server: ${serverName}`;
    if (details) {
      message += ` (${details})`;
    }

    super(message, {
      code: ErrorCode.MCP_CONNECTION_FAILED,
      context: {
        ...options?.context,
        metadata: {
          serverName,
          details,
          serverConfig: options?.serverConfig,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check if MCP server is running',
          'Verify server configuration and connection details',
          'Check network connectivity',
          'Try reconnecting after a brief delay'
        ],
        isRetriable: true,
        maxRetries: 3,
        retryDelay: {
          initialDelay: 2000,
          maxDelay: 10000,
          backoffMultiplier: 2,
          useJitter: true
        }
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'retry_connection',
          description: 'Retry MCP server connection',
          type: RecoveryActionType.RETRY,
          canAutomate: true,
          successProbability: 0.7,
          estimatedTime: 3000
        },
        {
          id: 'check_server_status',
          description: 'Check MCP server status and configuration',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        },
        {
          id: 'fallback_server',
          description: 'Try alternative MCP server if available',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.5
        }
      ]
    });
  }
}

/**
 * MCP tool execution error
 */
export class MCPToolError extends MCPError {
  public readonly code = ErrorCode.MCP_TOOL_EXECUTION_FAILED;

  constructor(
    toolName: string,
    errorMessage: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
      toolArgs?: Record<string, unknown>;
      serverResponse?: unknown;
    }
  ) {
    const message = `MCP tool execution failed: ${toolName} - ${errorMessage}`;

    super(message, {
      code: ErrorCode.MCP_TOOL_EXECUTION_FAILED,
      context: {
        ...options?.context,
        metadata: {
          toolName,
          errorMessage,
          toolArgs: options?.toolArgs,
          serverResponse: options?.serverResponse,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check tool arguments and parameters',
          'Verify tool is available on MCP server',
          'Check MCP server logs for detailed error information',
          'Try the operation with different parameters'
        ],
        isRetriable: true,
        maxRetries: 2,
        retryDelay: {
          initialDelay: 1000,
          maxDelay: 5000,
          backoffMultiplier: 2,
          useJitter: false
        }
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'retry_tool_execution',
          description: `Retry execution of tool '${toolName}'`,
          type: RecoveryActionType.RETRY,
          canAutomate: true,
          successProbability: 0.6
        },
        {
          id: 'validate_tool_args',
          description: 'Validate and fix tool arguments',
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.7
        },
        {
          id: 'use_alternative_tool',
          description: 'Use alternative tool if available',
          type: RecoveryActionType.FALLBACK,
          canAutomate: false,
          successProbability: 0.4
        }
      ]
    });
  }
}

/**
 * MCP timeout error
 */
export class MCPTimeoutError extends MCPError {
  public readonly code = ErrorCode.MCP_OPERATION_TIMEOUT;

  constructor(
    operation: string,
    timeoutMs: number,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
      serverName?: string;
    }
  ) {
    const message = `MCP operation timed out: ${operation} (${timeoutMs}ms)`;

    super(message, {
      code: ErrorCode.MCP_OPERATION_TIMEOUT,
      context: {
        ...options?.context,
        metadata: {
          operation,
          timeoutMs,
          serverName: options?.serverName,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Increase timeout duration for complex operations',
          'Check MCP server performance and load',
          'Try the operation during off-peak hours',
          'Break down complex operations into smaller parts'
        ],
        isRetriable: true,
        maxRetries: 2,
        retryDelay: {
          initialDelay: 5000,
          maxDelay: 15000,
          backoffMultiplier: 2,
          useJitter: true
        }
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'retry_with_longer_timeout',
          description: 'Retry operation with increased timeout',
          type: RecoveryActionType.RETRY,
          canAutomate: true,
          successProbability: 0.8,
          estimatedTime: timeoutMs * 2
        },
        {
          id: 'check_server_performance',
          description: 'Check MCP server performance metrics',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * MCP rate limit error
 */
export class MCPRateLimitError extends MCPError {
  public readonly code = ErrorCode.MCP_RATE_LIMIT_EXCEEDED;

  constructor(
    resetTime?: Date,
    remainingRequests?: number,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
      serverName?: string;
      limitType?: string;
    }
  ) {
    let message = 'MCP rate limit exceeded';
    if (resetTime) {
      message += ` (resets at ${resetTime.toISOString()})`;
    }
    if (remainingRequests !== undefined) {
      message += ` (${remainingRequests} requests remaining)`;
    }

    const retryAfter = resetTime ? Math.max(0, resetTime.getTime() - Date.now()) : 60000;

    super(message, {
      code: ErrorCode.MCP_RATE_LIMIT_EXCEEDED,
      context: {
        ...options?.context,
        metadata: {
          resetTime,
          remainingRequests,
          serverName: options?.serverName,
          limitType: options?.limitType,
          retryAfter,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          resetTime ? `Wait until ${resetTime.toISOString()} before retrying` : 'Wait before retrying',
          'Reduce request frequency',
          'Implement request batching if possible',
          'Consider using multiple MCP servers to distribute load'
        ],
        isRetriable: true,
        maxRetries: 5,
        retryDelay: {
          initialDelay: retryAfter,
          maxDelay: retryAfter * 2,
          backoffMultiplier: 1,
          useJitter: false
        }
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'wait_for_reset',
          description: 'Wait for rate limit reset',
          type: RecoveryActionType.RETRY,
          canAutomate: true,
          successProbability: 1.0,
          estimatedTime: retryAfter
        },
        {
          id: 'use_alternative_server',
          description: 'Switch to alternative MCP server',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.6
        },
        {
          id: 'implement_backoff',
          description: 'Implement exponential backoff strategy',
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.9
        }
      ]
    });
  }
}

/**
 * MCP authentication error
 */
export class MCPAuthError extends MCPError {
  public readonly code = ErrorCode.MCP_AUTH_FAILED;

  constructor(
    serverName: string,
    authType: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
      credentials?: Record<string, unknown>;
    }
  ) {
    const message = `MCP authentication failed for server '${serverName}' using ${authType}`;

    super(message, {
      code: ErrorCode.MCP_AUTH_FAILED,
      context: {
        ...options?.context,
        metadata: {
          serverName,
          authType,
          credentials: options?.credentials,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check authentication credentials',
          'Verify API keys or tokens are valid',
          'Check if credentials have expired',
          'Contact server administrator for access'
        ],
        isRetriable: false
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'refresh_credentials',
          description: 'Refresh authentication credentials',
          type: RecoveryActionType.REPAIR,
          canAutomate: false,
          successProbability: 0.8
        },
        {
          id: 'check_credential_validity',
          description: 'Check credential validity and expiration',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        },
        {
          id: 'use_alternative_auth',
          description: 'Try alternative authentication method',
          type: RecoveryActionType.FALLBACK,
          canAutomate: false,
          successProbability: 0.5
        }
      ]
    });
  }
}

/**
 * MCP configuration error
 */
export class MCPConfigError extends MCPError {
  public readonly code = ErrorCode.MCP_CONFIG_INVALID;

  constructor(
    configPath: string,
    validationErrors: readonly string[],
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
      configData?: Record<string, unknown>;
    }
  ) {
    const message = `Invalid MCP configuration at ${configPath}: ${validationErrors.join(', ')}`;

    super(message, {
      code: ErrorCode.MCP_CONFIG_INVALID,
      context: {
        ...options?.context,
        metadata: {
          configPath,
          validationErrors,
          configData: options?.configData,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check MCP configuration file syntax',
          'Verify all required configuration fields are present',
          'Check configuration values against schema',
          'Run juno-task init to generate a new configuration'
        ],
        isRetriable: false
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'regenerate_config',
          description: 'Generate new MCP configuration file',
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.9
        },
        {
          id: 'validate_config',
          description: 'Validate and show configuration errors',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        },
        {
          id: 'use_default_config',
          description: 'Use default MCP configuration',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.7
        }
      ]
    });
  }
}

/**
 * MCP server unresponsive error
 */
export class MCPServerUnresponsiveError extends MCPError {
  public readonly code = ErrorCode.MCP_SERVER_UNRESPONSIVE;

  constructor(
    serverName: string,
    lastResponseTime?: Date,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
      healthCheckFailed?: boolean;
    }
  ) {
    let message = `MCP server '${serverName}' is unresponsive`;
    if (lastResponseTime) {
      message += ` (last response: ${lastResponseTime.toISOString()})`;
    }

    super(message, {
      code: ErrorCode.MCP_SERVER_UNRESPONSIVE,
      context: {
        ...options?.context,
        metadata: {
          serverName,
          lastResponseTime,
          healthCheckFailed: options?.healthCheckFailed,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check if MCP server process is running',
          'Verify server health and resources',
          'Try restarting the MCP server',
          'Check server logs for errors'
        ],
        isRetriable: true,
        maxRetries: 3,
        retryDelay: {
          initialDelay: 5000,
          maxDelay: 20000,
          backoffMultiplier: 2,
          useJitter: true
        }
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'health_check',
          description: 'Perform MCP server health check',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        },
        {
          id: 'restart_server',
          description: 'Restart MCP server',
          type: RecoveryActionType.REPAIR,
          canAutomate: false,
          successProbability: 0.8
        },
        {
          id: 'use_backup_server',
          description: 'Switch to backup MCP server',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.6
        }
      ]
    });
  }
}

/**
 * MCP tool not found error
 */
export class MCPToolNotFoundError extends MCPError {
  public readonly code = ErrorCode.MCP_TOOL_NOT_FOUND;

  constructor(
    toolName: string,
    serverName: string,
    availableTools?: readonly string[],
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    let message = `MCP tool '${toolName}' not found on server '${serverName}'`;
    if (availableTools && availableTools.length > 0) {
      message += `. Available tools: ${availableTools.join(', ')}`;
    }

    super(message, {
      code: ErrorCode.MCP_TOOL_NOT_FOUND,
      context: {
        ...options?.context,
        metadata: {
          toolName,
          serverName,
          availableTools,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check tool name spelling and case',
          'Verify tool is available on the MCP server',
          'Check if server supports the required tool version',
          'Use list-tools command to see available tools'
        ],
        isRetriable: false
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'suggest_similar_tools',
          description: 'Suggest similar available tools',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.6
        },
        {
          id: 'list_available_tools',
          description: 'List all available tools on server',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        },
        {
          id: 'check_alternative_servers',
          description: 'Check if tool is available on other servers',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.4
        }
      ]
    });
  }
}