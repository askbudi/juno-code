/**
 * MCP errors - Re-export shim
 *
 * This file has been migrated to src/core/errors.ts as part of Phase A simplification.
 * All error classes, type guards, and utilities are now in the core module.
 * This shim exists for backward compatibility with files inside src/mcp/ that
 * still reference './errors'. It will be removed when src/mcp/ is deleted in Phase B.
 *
 * @deprecated Import from '../core/errors' instead
 * @module mcp/errors
 */

export {
  // New names
  ExecutionErrorType,
  ExecutionErrorCode,
  ExecutionError,
  ConnectionError,
  ToolError,
  TimeoutError,
  RateLimitError,
  ValidationError,
  isExecutionError,

  // Deprecated aliases (used by mcp/ internal files)
  MCPErrorType,
  MCPErrorCode,
  MCPError,
  MCPConnectionError,
  MCPToolError,
  MCPTimeoutError,
  MCPRateLimitError,
  MCPValidationError,
  isMCPError,

  // Shared types and utilities (not MCP-prefixed, no rename needed)
  RATE_LIMIT_PATTERNS,
  parseRateLimitResetTime,
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
} from '../core/errors.js';

export type {
  ExecutionErrorOptions,
  MCPErrorOptions,
  RetryInfo,
  ServerInfo,
  ToolInfo,
  ToolExecutionDetails,
  ErrorRecoveryStrategy,
} from '../core/errors.js';
