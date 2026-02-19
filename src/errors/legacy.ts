/**
 * Legacy Compatibility Layer
 *
 * Provides compatibility with existing error patterns while
 * transitioning to the unified error hierarchy.
 */

// Re-export some existing patterns for backward compatibility
export * from '../core/errors';

// Migration helpers
import type { JunoTaskError } from './base';

export function migrateError(error: Error): JunoTaskError | Error {
  return error;
}