/**
 * Error Utilities
 */

import type { JunoTaskError } from './base';
import type { ErrorCategory } from './categories';
import type { ErrorCode } from './codes';

export function isJunoTaskError(error: unknown): error is JunoTaskError {
  return error instanceof Error && 'category' in error && 'code' in error;
}

export function hasErrorCode(error: unknown, code: ErrorCode): boolean {
  return isJunoTaskError(error) && error.code === code;
}

export function hasErrorCategory(error: unknown, category: ErrorCategory): boolean {
  return isJunoTaskError(error) && error.category === category;
}

export function formatError(error: unknown): string {
  if (isJunoTaskError(error)) {
    return error.getUserMessage();
  }
  return error instanceof Error ? error.message : String(error);
}