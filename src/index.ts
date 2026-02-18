/**
 * juno-code - TypeScript implementation of juno-code CLI tool
 *
 * Main entry point for the library exports
 */

// Core exports
export * from './core/config';
export * from './templates/default-hooks';
export * from './core/engine';
export * from './core/session';
// Utility exports (excluding validateConfig to avoid conflicts)
export * from './utils/environment';
export * from './utils/hooks';
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

// Version information
export { version } from './version';

// Error exports (unified error hierarchy)
export * from './errors';