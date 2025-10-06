/**
 * juno-task-ts - TypeScript implementation of juno-task CLI tool
 *
 * Main entry point for the library exports
 */

// Core exports
export * from './core/config';
export * from './core/engine';
export * from './core/session';
export * from './core/metrics';

// Utility exports (excluding validateConfig to avoid conflicts)
export * from './utils/environment';
export {
  ValidationError,
  SubagentSchema,
  LogLevelSchema,
  SessionStatusSchema,
  IterationsSchema,
  FilePathSchema,
  DirectoryPathSchema,
  GitUrlSchema,
  SessionIdSchema,
  ModelSchema,
  CLIOptionsSchema,
  ConfigValidationSchema,
  validateSubagent,
  validateModel,
  validateIterations,
  validateLogLevel,
  validatePaths,
  isValidSubagent,
  isValidSessionStatus,
  isValidLogLevel,
  isValidPath,
  sanitizePromptText,
  sanitizeFilePath,
  sanitizeGitUrl,
  sanitizeSessionId,
  formatValidationError,
  validateWithFallback,
  validateEnvironmentVars,
  validateCommandOptions,
  isDefined,
  validateJson,
  validateUniqueArray,
  validateNumberRange,
  validateStringLength
} from './utils/validation';

// Type exports (consolidated to avoid conflicts)
export * from './types';

// TUI exports
export * from './tui';

// Version information
export { version } from './version';

// Selective re-exports to avoid conflicts (using type-only exports)
export type { MCPClient } from './mcp/client';
export type { MCPError, MCPConnectionError, MCPTimeoutError } from './mcp/errors';
export type { TemplateEngine } from './templates/engine';