/**
 * Validation Utilities Module for juno-code
 *
 * Provides Zod-based validation for configuration values.
 *
 * @module utils/validation
 */

import { z } from 'zod';
import type { SubagentType, LogLevel, JunoTaskConfig } from '../types/index';
import { JunoTaskConfigSchema, validateConfig as coreValidateConfig } from '../core/config';
import { SUBAGENT_ALIASES } from '../cli/types';

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for validating subagent types with alias support
 */
export const SubagentSchema = z
  .string()
  .transform((value) => {
    if (['claude', 'cursor', 'codex', 'gemini', 'pi'].includes(value)) {
      return value as SubagentType;
    }

    const normalized = SUBAGENT_ALIASES[value];
    if (normalized) {
      return normalized;
    }

    throw new z.ZodError([
      {
        code: z.ZodIssueCode.invalid_enum_value,
        options: ['claude', 'cursor', 'codex', 'gemini', 'pi'],
        received: value,
        path: [],
        message: `Invalid subagent: ${value}. Valid options: claude, cursor, codex, gemini, pi`,
      },
    ]);
  })
  .refine(
    (value): value is SubagentType => ['claude', 'cursor', 'codex', 'gemini', 'pi'].includes(value),
    {
      message: 'Invalid subagent type',
    },
  );

/**
 * Schema for validating log levels
 */
export const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace'], {
  errorMap: (_issue, ctx) => ({
    message: `Invalid log level: ${ctx.data}. Valid options: error, warn, info, debug, trace`,
  }),
});

/**
 * Schema for validating session status
 */
export const SessionStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled'], {
  errorMap: (_issue, ctx) => ({
    message: `Invalid session status: ${ctx.data}. Valid options: running, completed, failed, cancelled`,
  }),
});

/**
 * Schema for validating iteration counts
 */
export const IterationsSchema = z
  .number()
  .int('Iterations must be an integer')
  .refine(
    (value) => value === -1 || value > 0,
    'Iterations must be a positive integer or -1 for infinite',
  )
  .transform((value) => (value === -1 ? Infinity : value));

/**
 * Schema for validating model names (subagent-specific)
 */
export const ModelSchema = z
  .string()
  .min(1, 'Model name cannot be empty')
  .refine((model) => {
    return /^[a-zA-Z0-9._-]+$/.test(model);
  }, 'Model name contains invalid characters');

/**
 * Schema for runtime configuration validation
 */
export const ConfigValidationSchema = JunoTaskConfigSchema;

// ============================================================================
// Core Validation Functions
// ============================================================================

/**
 * Validate and normalize subagent names including aliases
 */
export function validateSubagent(subagent: string): SubagentType {
  return SubagentSchema.parse(subagent);
}

/**
 * Validate model names for specific subagents
 */
export function validateModel(model: string, _subagent?: SubagentType): string {
  return ModelSchema.parse(model);
}

/**
 * Validate iteration counts (positive integers or -1 for infinite)
 */
export function validateIterations(iterations: number): number {
  return IterationsSchema.parse(iterations);
}

/**
 * Validate log level strings
 */
export function validateLogLevel(logLevel: string): LogLevel {
  return LogLevelSchema.parse(logLevel);
}

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Complete configuration validation
 * Delegates to the core config validation.
 */
export function validateConfig(config: unknown): JunoTaskConfig {
  return coreValidateConfig(config);
}

/**
 * Environment variable validation
 */
export function validateEnvironmentVars(
  envVars: Record<string, string | undefined>,
): Partial<JunoTaskConfig> {
  const config: Partial<JunoTaskConfig> = {};
  const errors: string[] = [];

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
        case 'JUNO_TASK_VERBOSE': {
          const lower = value.toLowerCase();
          if (lower === 'true' || lower === 'yes') config.verbose = 1;
          else if (lower === 'false' || lower === 'no') config.verbose = 0;
          else { const n = Number(value); config.verbose = !isNaN(n) && n >= 0 && n <= 2 ? Math.floor(n) : 1; }
          break;
        }
        case 'JUNO_TASK_QUIET':
          config.quiet = value.toLowerCase() === 'true';
          break;
        case 'JUNO_TASK_INTERACTIVE':
          config.interactive = value.toLowerCase() === 'true';
          break;
        case 'JUNO_TASK_HEADLESS_MODE':
          config.headlessMode = value.toLowerCase() === 'true';
          break;
      }
    } catch (error) {
      if (error instanceof Error) {
        errors.push(`${key}: ${error.message}`);
      }
    }
  });

  if (errors.length > 0) {
    throw new Error(`Environment variable validation failed:\n${errors.join('\n')}`);
  }

  return config;
}

// ============================================================================
// Type Re-exports
// ============================================================================

export type { SubagentType, SessionStatus, LogLevel, JunoTaskConfig } from '../types/index';
