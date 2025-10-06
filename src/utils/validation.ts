/**
 * Validation Utilities Module for juno-task-ts
 *
 * Provides comprehensive validation utilities using Zod schemas for the juno-task-ts CLI tool.
 * This module includes core validation functions, Zod schemas, type guards, input sanitization,
 * validation error handling, and configuration validation.
 *
 * @module utils/validation
 */

import { z } from 'zod';
import * as path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import type {
  SubagentType,
  SessionStatus,
  LogLevel,
  JunoTaskConfig
} from '../types/index';
import { JunoTaskConfigSchema, validateConfig as coreValidateConfig } from '../core/config';
import { SUBAGENT_ALIASES } from '../cli/types';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Validation error with detailed error messages and context
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public value?: unknown,
    public suggestions?: string[]
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for validating subagent types with alias support
 */
export const SubagentSchema = z.string()
  .transform((value) => {
    // Check if it's a direct match first
    if (['claude', 'cursor', 'codex', 'gemini'].includes(value)) {
      return value as SubagentType;
    }

    // Check aliases
    const normalized = SUBAGENT_ALIASES[value];
    if (normalized) {
      return normalized;
    }

    throw new z.ZodError([{
      code: z.ZodIssueCode.invalid_enum_value,
      options: ['claude', 'cursor', 'codex', 'gemini'],
      received: value,
      path: [],
      message: `Invalid subagent: ${value}. Valid options: claude, cursor, codex, gemini`
    }]);
  })
  .refine((value): value is SubagentType =>
    ['claude', 'cursor', 'codex', 'gemini'].includes(value), {
    message: 'Invalid subagent type'
  });

/**
 * Schema for validating log levels
 */
export const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace'], {
  errorMap: (_issue, ctx) => ({
    message: `Invalid log level: ${ctx.data}. Valid options: error, warn, info, debug, trace`
  })
});

/**
 * Schema for validating session status
 */
export const SessionStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled'], {
  errorMap: (_issue, ctx) => ({
    message: `Invalid session status: ${ctx.data}. Valid options: running, completed, failed, cancelled`
  })
});

/**
 * Schema for validating iteration counts
 */
export const IterationsSchema = z.number()
  .int('Iterations must be an integer')
  .refine(
    (value) => value === -1 || value > 0,
    'Iterations must be a positive integer or -1 for infinite'
  )
  .transform((value) => value === -1 ? Infinity : value);

/**
 * Schema for validating file paths with existence checks
 */
export const FilePathSchema = z.string()
  .min(1, 'File path cannot be empty')
  .transform((value) => path.resolve(value))
  .refine(async (filePath) => {
    try {
      const stats = await fsPromises.stat(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }, 'File does not exist or is not accessible');

/**
 * Schema for validating directory paths with existence checks
 */
export const DirectoryPathSchema = z.string()
  .min(1, 'Directory path cannot be empty')
  .transform((value) => path.resolve(value))
  .refine(async (dirPath) => {
    try {
      const stats = await fsPromises.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }, 'Directory does not exist or is not accessible');

/**
 * Schema for validating Git URLs
 */
export const GitUrlSchema = z.string()
  .min(1, 'Git URL cannot be empty')
  .refine((url) => {
    // Support various Git URL formats
    const patterns = [
      /^https?:\/\/.+\.git$/,
      /^git@.+:.+\.git$/,
      /^ssh:\/\/git@.+\/.+\.git$/,
      /^https?:\/\/github\.com\/.+\/.+$/,
      /^https?:\/\/gitlab\.com\/.+\/.+$/,
      /^https?:\/\/bitbucket\.org\/.+\/.+$/
    ];

    return patterns.some(pattern => pattern.test(url));
  }, 'Invalid Git URL format');

/**
 * Schema for validating session IDs
 */
export const SessionIdSchema = z.string()
  .regex(
    /^[a-zA-Z0-9_-]{8,}$/,
    'Session ID must be at least 8 characters and contain only alphanumeric characters, underscores, and hyphens'
  );

/**
 * Schema for validating model names (subagent-specific)
 */
export const ModelSchema = z.string()
  .min(1, 'Model name cannot be empty')
  .refine((model) => {
    // Basic validation - specific models would be validated by subagents
    return /^[a-zA-Z0-9._-]+$/.test(model);
  }, 'Model name contains invalid characters');

/**
 * Schema for CLI options validation
 */
export const CLIOptionsSchema = z.object({
  subagent: SubagentSchema.optional(),
  prompt: z.string().optional(),
  cwd: z.string().optional(),
  maxIterations: IterationsSchema.optional(),
  model: ModelSchema.optional(),
  interactive: z.boolean().optional(),
  verbose: z.boolean().optional(),
  quiet: z.boolean().optional(),
  logLevel: LogLevelSchema.optional(),
  logFile: z.string().optional(),
  config: z.string().optional(),
  noColor: z.boolean().optional()
}).strict();

/**
 * Schema for runtime configuration validation
 */
export const ConfigValidationSchema = JunoTaskConfigSchema;

// ============================================================================
// Core Validation Functions
// ============================================================================

/**
 * Validate and normalize subagent names including aliases
 *
 * @param subagent - The subagent name to validate
 * @returns Normalized subagent name
 * @throws ValidationError if invalid
 *
 * @example
 * ```typescript
 * const subagent = validateSubagent('claude-code'); // Returns 'claude'
 * const subagent2 = validateSubagent('gemini'); // Returns 'gemini'
 * ```
 */
export function validateSubagent(subagent: string): SubagentType {
  try {
    return SubagentSchema.parse(subagent);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const suggestions = [
        'Valid subagents: claude, cursor, codex, gemini',
        'Valid aliases: claude-code, claude_code, gemini-cli, cursor-agent'
      ];
      throw new ValidationError(
        error.errors[0]?.message || 'Invalid subagent',
        'subagent',
        subagent,
        suggestions
      );
    }
    throw error;
  }
}

/**
 * Validate model names for specific subagents
 *
 * @param model - The model name to validate
 * @param subagent - The subagent the model is for (optional, for context)
 * @returns Validated model name
 * @throws ValidationError if invalid
 */
export function validateModel(model: string, subagent?: SubagentType): string {
  try {
    const validated = ModelSchema.parse(model);

    // Additional subagent-specific validation could be added here
    if (subagent === 'claude' && !model.includes('claude') && !model.includes('sonnet') && !model.includes('haiku')) {
      console.warn(`Warning: Model '${model}' may not be valid for Claude subagent`);
    }

    return validated;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const suggestions = [
        'Model names should contain only alphanumeric characters, dots, underscores, and hyphens',
        'Check the subagent documentation for valid model names'
      ];
      throw new ValidationError(
        error.errors[0]?.message || 'Invalid model name',
        'model',
        model,
        suggestions
      );
    }
    throw error;
  }
}

/**
 * Validate iteration counts (positive integers or -1 for infinite)
 *
 * @param iterations - The iteration count to validate
 * @returns Validated iteration count (Infinity for -1)
 * @throws ValidationError if invalid
 */
export function validateIterations(iterations: number): number {
  try {
    return IterationsSchema.parse(iterations);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const suggestions = [
        'Use a positive integer (1, 2, 3, etc.)',
        'Use -1 for unlimited iterations'
      ];
      throw new ValidationError(
        error.errors[0]?.message || 'Invalid iteration count',
        'iterations',
        iterations,
        suggestions
      );
    }
    throw error;
  }
}

/**
 * Validate log level strings
 *
 * @param logLevel - The log level to validate
 * @returns Validated log level
 * @throws ValidationError if invalid
 */
export function validateLogLevel(logLevel: string): LogLevel {
  try {
    return LogLevelSchema.parse(logLevel);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const suggestions = [
        'Valid log levels: error, warn, info, debug, trace',
        'Use "info" for normal operation, "debug" for troubleshooting'
      ];
      throw new ValidationError(
        error.errors[0]?.message || 'Invalid log level',
        'logLevel',
        logLevel,
        suggestions
      );
    }
    throw error;
  }
}

/**
 * Validate file and directory paths with existence checks
 *
 * @param filePath - The path to validate
 * @param type - Whether to check for 'file' or 'directory'
 * @returns Promise resolving to validated absolute path
 * @throws ValidationError if invalid or not accessible
 */
export async function validatePaths(
  filePath: string,
  type: 'file' | 'directory' = 'file'
): Promise<string> {
  try {
    if (type === 'file') {
      return await FilePathSchema.parseAsync(filePath);
    } else {
      return await DirectoryPathSchema.parseAsync(filePath);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      const suggestions = [
        'Check that the path exists and is accessible',
        'Use absolute paths to avoid ambiguity',
        `Ensure the path points to a ${type}`
      ];
      throw new ValidationError(
        error.errors[0]?.message || `Invalid ${type} path`,
        'path',
        filePath,
        suggestions
      );
    }
    throw error;
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for SubagentType
 *
 * @param value - Value to check
 * @returns True if value is a valid SubagentType
 */
export function isValidSubagent(value: unknown): value is SubagentType {
  return typeof value === 'string' &&
         ['claude', 'cursor', 'codex', 'gemini'].includes(value);
}

/**
 * Type guard for SessionStatus
 *
 * @param value - Value to check
 * @returns True if value is a valid SessionStatus
 */
export function isValidSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' &&
         ['running', 'completed', 'failed', 'cancelled'].includes(value);
}

/**
 * Type guard for LogLevel
 *
 * @param value - Value to check
 * @returns True if value is a valid LogLevel
 */
export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' &&
         ['error', 'warn', 'info', 'debug', 'trace'].includes(value);
}

/**
 * File/directory existence validation
 *
 * @param filePath - Path to check
 * @param type - Type of path to check for
 * @returns Promise resolving to true if path exists and is of correct type
 */
export async function isValidPath(
  filePath: string,
  type: 'file' | 'directory' = 'file'
): Promise<boolean> {
  try {
    const resolvedPath = path.resolve(filePath);
    const stats = await fsPromises.stat(resolvedPath);
    return type === 'file' ? stats.isFile() : stats.isDirectory();
  } catch {
    return false;
  }
}

// ============================================================================
// Input Sanitization Functions
// ============================================================================

/**
 * Clean user input for prompts
 *
 * @param text - Raw prompt text
 * @returns Sanitized prompt text
 */
export function sanitizePromptText(text: string): string {
  if (typeof text !== 'string') {
    throw new ValidationError('Prompt text must be a string', 'prompt', text);
  }

  // Remove potentially dangerous characters but preserve formatting
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters except \n, \r, \t
    .replace(/\r\n/g, '\n') // Normalize line endings
    .trim();
}

/**
 * Normalize and validate file paths
 *
 * @param filePath - Raw file path
 * @returns Sanitized absolute file path
 */
export function sanitizeFilePath(filePath: string): string {
  if (typeof filePath !== 'string') {
    throw new ValidationError('File path must be a string', 'filePath', filePath);
  }

  // Remove dangerous characters and normalize
  const cleaned = filePath
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .replace(/[<>:"|?*]/g, '') // Remove invalid filename characters
    .trim();

  if (!cleaned) {
    throw new ValidationError('File path cannot be empty after sanitization', 'filePath', filePath);
  }

  return path.resolve(cleaned);
}

/**
 * Validate and normalize git repository URLs
 *
 * @param url - Raw git URL
 * @returns Sanitized git URL
 */
export function sanitizeGitUrl(url: string): string {
  if (typeof url !== 'string') {
    throw new ValidationError('Git URL must be a string', 'gitUrl', url);
  }

  const cleaned = url.trim();

  try {
    GitUrlSchema.parse(cleaned);
    return cleaned;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const suggestions = [
        'Use HTTPS format: https://github.com/user/repo.git',
        'Use SSH format: git@github.com:user/repo.git',
        'Ensure the URL ends with .git for most Git providers'
      ];
      throw new ValidationError(
        'Invalid Git URL format',
        'gitUrl',
        url,
        suggestions
      );
    }
    throw error;
  }
}

/**
 * Validate session ID format
 *
 * @param sessionId - Raw session ID
 * @returns Sanitized session ID
 */
export function sanitizeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string') {
    throw new ValidationError('Session ID must be a string', 'sessionId', sessionId);
  }

  try {
    return SessionIdSchema.parse(sessionId.trim());
  } catch (error) {
    if (error instanceof z.ZodError) {
      const suggestions = [
        'Session IDs must be at least 8 characters long',
        'Use only letters, numbers, underscores, and hyphens',
        'Generate a new session ID if needed'
      ];
      throw new ValidationError(
        error.errors[0]?.message || 'Invalid session ID format',
        'sessionId',
        sessionId,
        suggestions
      );
    }
    throw error;
  }
}

// ============================================================================
// Validation Error Handling
// ============================================================================

/**
 * Format validation error for user-friendly display
 *
 * @param error - ValidationError to format
 * @returns Formatted error message
 */
export function formatValidationError(error: ValidationError): string {
  let message = error.message;

  if (error.field && error.value !== undefined) {
    message += `\nField: ${error.field}`;
    message += `\nValue: ${JSON.stringify(error.value)}`;
  }

  if (error.suggestions && error.suggestions.length > 0) {
    message += '\n\nSuggestions:';
    error.suggestions.forEach((suggestion, index) => {
      message += `\n  ${index + 1}. ${suggestion}`;
    });
  }

  return message;
}

/**
 * Validation with default value fallback
 *
 * @param validator - Validation function
 * @param value - Value to validate
 * @param defaultValue - Default value if validation fails
 * @param silent - Whether to suppress validation errors
 * @returns Validated value or default
 */
export function validateWithFallback<T>(
  validator: (value: unknown) => T,
  value: unknown,
  defaultValue: T,
  silent: boolean = false
): T {
  try {
    return validator(value);
  } catch (error) {
    if (!silent && error instanceof ValidationError) {
      console.warn(`Validation warning: ${error.message}. Using default value.`);
    }
    return defaultValue;
  }
}

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Complete configuration validation
 * Re-exports the core config validation with enhanced error handling
 *
 * @param config - Configuration object to validate
 * @returns Validated configuration
 * @throws ValidationError if validation fails
 */
export function validateConfig(config: unknown): JunoTaskConfig {
  try {
    return coreValidateConfig(config);
  } catch (error) {
    if (error instanceof Error) {
      const suggestions = [
        'Check the configuration file syntax',
        'Ensure all required fields are present',
        'Verify data types match the expected format',
        'Use the default configuration as a template'
      ];

      throw new ValidationError(
        `Configuration validation failed: ${error.message}`,
        'config',
        config,
        suggestions
      );
    }
    throw error;
  }
}

/**
 * Environment variable validation
 *
 * @param envVars - Environment variables object
 * @returns Validated environment configuration
 */
export function validateEnvironmentVars(
  envVars: Record<string, string | undefined>
): Partial<JunoTaskConfig> {
  const config: Partial<JunoTaskConfig> = {};
  const errors: string[] = [];

  // Validate each environment variable
  Object.entries(envVars).forEach(([key, value]) => {
    if (!key.startsWith('JUNO_TASK_') || value === undefined) {
      return;
    }

    try {
      switch (key) {
        case 'JUNO_TASK_DEFAULT_SUBAGENT':
          config.defaultSubagent = validateSubagent(value);
          break;
        case 'JUNO_TASK_LOG_LEVEL':
          config.logLevel = validateLogLevel(value);
          break;
        case 'JUNO_TASK_DEFAULT_MAX_ITERATIONS':
          config.defaultMaxIterations = validateIterations(parseInt(value, 10));
          break;
        case 'JUNO_TASK_VERBOSE':
          config.verbose = value.toLowerCase() === 'true';
          break;
        case 'JUNO_TASK_QUIET':
          config.quiet = value.toLowerCase() === 'true';
          break;
        case 'JUNO_TASK_INTERACTIVE':
          config.interactive = value.toLowerCase() === 'true';
          break;
        case 'JUNO_TASK_HEADLESS_MODE':
          config.headlessMode = value.toLowerCase() === 'true';
          break;
        // Add more environment variable validations as needed
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        errors.push(`${key}: ${error.message}`);
      }
    }
  });

  if (errors.length > 0) {
    throw new ValidationError(
      `Environment variable validation failed:\n${errors.join('\n')}`,
      'environment',
      envVars,
      ['Check environment variable values', 'Refer to documentation for valid values']
    );
  }

  return config;
}

/**
 * CLI option validation
 *
 * @param options - CLI options object
 * @returns Validated CLI options
 */
export function validateCommandOptions(options: Record<string, unknown>): Record<string, unknown> {
  try {
    return CLIOptionsSchema.parse(options);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map(err => {
        const path = err.path.length > 0 ? err.path.join('.') : 'option';
        return `--${path}: ${err.message}`;
      });

      const suggestions = [
        'Check command line option syntax',
        'Use --help to see valid options',
        'Verify option values match expected types'
      ];

      throw new ValidationError(
        `CLI option validation failed:\n${errors.join('\n')}`,
        'options',
        options,
        suggestions
      );
    }
    throw error;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a value is defined and not null
 *
 * @param value - Value to check
 * @returns True if value is defined and not null
 */
export function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

/**
 * Validate and parse JSON string safely
 *
 * @param jsonString - JSON string to parse
 * @returns Parsed object
 * @throws ValidationError if parsing fails
 */
export function validateJson(jsonString: string): unknown {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    throw new ValidationError(
      'Invalid JSON format',
      'json',
      jsonString,
      ['Check for syntax errors', 'Validate quotes and brackets', 'Use a JSON validator']
    );
  }
}

/**
 * Validate array contains only unique values
 *
 * @param array - Array to validate
 * @param field - Field name for error context
 * @returns Validated array
 */
export function validateUniqueArray<T>(array: T[], field: string = 'array'): T[] {
  const seen = new Set();
  const duplicates: T[] = [];

  for (const item of array) {
    if (seen.has(item)) {
      duplicates.push(item);
    } else {
      seen.add(item);
    }
  }

  if (duplicates.length > 0) {
    throw new ValidationError(
      `Duplicate values found in ${field}`,
      field,
      duplicates,
      ['Remove duplicate entries', 'Ensure all values are unique']
    );
  }

  return array;
}

/**
 * Validate that a number is within a specified range
 *
 * @param value - Number to validate
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @param field - Field name for error context
 * @returns Validated number
 */
export function validateNumberRange(
  value: number,
  min: number,
  max: number,
  field: string = 'value'
): number {
  if (value < min || value > max) {
    throw new ValidationError(
      `${field} must be between ${min} and ${max}`,
      field,
      value,
      [`Use a value between ${min} and ${max}`, `Current value: ${value}`]
    );
  }

  return value;
}

/**
 * Validate string length
 *
 * @param value - String to validate
 * @param minLength - Minimum length
 * @param maxLength - Maximum length
 * @param field - Field name for error context
 * @returns Validated string
 */
export function validateStringLength(
  value: string,
  minLength: number,
  maxLength: number,
  field: string = 'value'
): string {
  if (value.length < minLength || value.length > maxLength) {
    throw new ValidationError(
      `${field} must be between ${minLength} and ${maxLength} characters`,
      field,
      value,
      [
        `Current length: ${value.length}`,
        `Required length: ${minLength}-${maxLength} characters`
      ]
    );
  }

  return value;
}

// ============================================================================
// Additional Type Exports
// ============================================================================

export type {
  SubagentType,
  SessionStatus,
  LogLevel,
  JunoTaskConfig
} from '../types/index';