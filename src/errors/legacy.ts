/**
 * Legacy Compatibility Layer
 *
 * Provides compatibility with existing error patterns while
 * transitioning to the unified error hierarchy.
 */

// Re-export some existing patterns for backward compatibility
export * from '../mcp/errors';

// Legacy error type aliases
export type { ValidationError as LegacyValidationError } from '../utils/validation';

// Migration helpers
import type { JunoTaskError } from './base';

export function migrateError(error: Error): JunoTaskError | Error {
  // For now, return the original error
  // In the future, this would convert legacy errors to unified errors
  return error;
}