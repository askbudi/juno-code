/**
 * Utilities Module for juno-task-ts
 *
 * Provides utility functions and helpers for the juno-task-ts CLI tool.
 *
 * @module utils
 */

// Re-export all validation utilities
export * from './validation';

// Re-export all environment utilities
export * from './environment';

// Utility type definitions
export type ValidationResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: string;
  suggestions?: string[];
};

/**
 * Safe validation wrapper that returns a result object instead of throwing
 *
 * @param validator - Validation function that may throw
 * @param value - Value to validate
 * @returns ValidationResult with success/error information
 *
 * @example
 * ```typescript
 * const result = safeValidate(validateSubagent, 'claude');
 * if (result.success) {
 *   console.log('Valid subagent:', result.data);
 * } else {
 *   console.error('Validation failed:', result.error);
 * }
 * ```
 */
export function safeValidate<T>(
  validator: (value: unknown) => T,
  value: unknown
): ValidationResult<T> {
  try {
    const data = validator(value);
    return { success: true, data };
  } catch (error) {
    if (error instanceof Error) {
      const validationError = error as any;
      return {
        success: false,
        error: error.message,
        suggestions: validationError.suggestions
      };
    }
    return {
      success: false,
      error: 'Unknown validation error'
    };
  }
}

/**
 * Async safe validation wrapper for async validators
 *
 * @param validator - Async validation function that may throw
 * @param value - Value to validate
 * @returns Promise resolving to ValidationResult
 */
export async function safeValidateAsync<T>(
  validator: (value: unknown) => Promise<T>,
  value: unknown
): Promise<ValidationResult<T>> {
  try {
    const data = await validator(value);
    return { success: true, data };
  } catch (error) {
    if (error instanceof Error) {
      const validationError = error as any;
      return {
        success: false,
        error: error.message,
        suggestions: validationError.suggestions
      };
    }
    return {
      success: false,
      error: 'Unknown validation error'
    };
  }
}

/**
 * Create a composed validator from multiple validators
 *
 * @param validators - Array of validation functions
 * @returns Combined validator function
 *
 * @example
 * ```typescript
 * const validateUserInput = composeValidators([
 *   validateStringLength,
 *   sanitizePromptText,
 *   validateNotEmpty
 * ]);
 * ```
 */
export function composeValidators<T>(
  validators: Array<(value: T) => T>
): (value: T) => T {
  return (value: T) => {
    return validators.reduce((acc, validator) => validator(acc), value);
  };
}

/**
 * Debounced validation for user input
 *
 * @param validator - Validation function
 * @param delay - Debounce delay in milliseconds
 * @returns Debounced validator function
 */
export function debounceValidator<T>(
  validator: (value: T) => Promise<ValidationResult<T>>,
  delay: number = 300
): (value: T) => Promise<ValidationResult<T>> {
  let timeoutId: NodeJS.Timeout;

  return (value: T): Promise<ValidationResult<T>> => {
    return new Promise((resolve) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(async () => {
        const result = await validator(value);
        resolve(result);
      }, delay);
    });
  };
}

/**
 * Validation cache for expensive validations
 */
export class ValidationCache<T, R> {
  private cache = new Map<string, { result: R; timestamp: number }>();

  constructor(private ttl: number = 5 * 60 * 1000) {} // 5 minutes default TTL

  /**
   * Get cached validation result or compute new one
   *
   * @param key - Cache key
   * @param value - Value to validate
   * @param validator - Validation function
   * @returns Cached or computed validation result
   */
  async validate(
    key: string,
    value: T,
    validator: (value: T) => Promise<R>
  ): Promise<R> {
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.ttl) {
      return cached.result;
    }

    const result = await validator(value);
    this.cache.set(key, { result, timestamp: now });

    return result;
  }

  /**
   * Clear expired cache entries
   */
  cleanup(): void {
    const now = Date.now();
    const entriesToDelete: string[] = [];

    this.cache.forEach((entry, key) => {
      if ((now - entry.timestamp) >= this.ttl) {
        entriesToDelete.push(key);
      }
    });

    entriesToDelete.forEach(key => this.cache.delete(key));
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Batch validation for multiple values
 *
 * @param values - Array of values to validate
 * @param validator - Validation function
 * @returns Array of validation results
 */
export async function batchValidate<T, R>(
  values: T[],
  validator: (value: T) => Promise<ValidationResult<R>>
): Promise<ValidationResult<R>[]> {
  const results = await Promise.allSettled(
    values.map(value => validator(value))
  );

  return results.map(result => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      return {
        success: false,
        error: result.reason?.message || 'Validation failed'
      };
    }
  });
}

/**
 * Validation middleware for processing pipelines
 */
export type ValidationMiddleware<T> = (
  value: T,
  next: (value: T) => Promise<T>
) => Promise<T>;

/**
 * Create a validation pipeline with middleware
 *
 * @param middlewares - Array of validation middleware functions
 * @returns Pipeline processor function
 */
export function createValidationPipeline<T>(
  middlewares: ValidationMiddleware<T>[]
): (value: T) => Promise<T> {
  return async (value: T): Promise<T> => {
    let index = 0;

    const next = async (val: T): Promise<T> => {
      if (index >= middlewares.length) {
        return val;
      }

      const middleware = middlewares[index++];
      return middleware ? middleware(val, next) : val;
    };

    return next(value);
  };
}

/**
 * Common validation patterns
 */
export const ValidationPatterns = {
  /** Email validation pattern */
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,

  /** URL validation pattern */
  URL: /^https?:\/\/.+/,

  /** Semantic version pattern */
  SEMVER: /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+)?$/,

  /** UUID pattern */
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,

  /** File extension pattern */
  FILE_EXTENSION: /\.[a-zA-Z0-9]+$/,

  /** Docker image name pattern */
  DOCKER_IMAGE: /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[a-zA-Z0-9_.-]+)?$/
} as const;

// Re-export all file management utilities
export * from './file-manager';

// Re-export all command execution utilities
export * from './command-executor';

// Re-export all system information utilities
export * from './system-info';