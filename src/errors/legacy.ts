/**
 * Legacy Compatibility Layer
 *
 * Provides compatibility with existing error patterns while
 * transitioning to the unified error hierarchy.
 */

// Re-export core error patterns for backward compatibility.
// Excludes ValidationError to avoid conflict with unified errors/validation.ts.
export {
  // Enums
  ExecutionErrorType,
  ExecutionErrorCode,
  // Constants
  RATE_LIMIT_PATTERNS,
  // Error classes
  ExecutionError,
  ConnectionError,
  ToolError,
  TimeoutError,
  RateLimitError,
  // ValidationError excluded (conflicts with unified errors/validation.ts)
  // Utility functions
  parseRateLimitResetTime,
  isExecutionError,
  isConnectionError,
  isToolError,
  isTimeoutError,
  isRateLimitError,
  isValidationError,
  isRetryableError,
  getErrorCategory,
  formatErrorForUser,
  formatErrorForLogging,
  getRecoverySuggestions,
  createErrorChain,
  getRecoveryStrategy,
  calculateRetryDelay,
  // MCP backward-compat aliases (value exports carry their types)
  MCPErrorType,
  MCPErrorCode,
  MCPError,
  MCPConnectionError,
  MCPToolError,
  MCPTimeoutError,
  MCPRateLimitError,
  MCPValidationError,
  isMCPError,
} from '../core/errors';

// Re-export types that are only type aliases (no value counterpart)
export type {
  ExecutionErrorOptions,
  RetryInfo,
  ServerInfo,
  ToolInfo,
  ToolExecutionDetails,
  ErrorRecoveryStrategy,
  MCPErrorOptions,
} from '../core/errors';

// Migration helpers
import type { JunoTaskError } from './base';

export function migrateError(error: Error): JunoTaskError | Error {
  return error;
}
