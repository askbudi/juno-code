/**
 * System Error Classes
 *
 * Handles system-level errors including file system operations,
 * network connectivity, OS operations, and hardware issues.
 */

import { JunoTaskError, RecoveryAction, RecoveryActionType } from './base';
import { ErrorCategory } from './categories';
import { ErrorCode } from './codes';
import type { ErrorContext } from './context';

/**
 * Base class for all system-related errors
 */
export abstract class SystemError extends JunoTaskError {
  public readonly category = ErrorCategory.SYSTEM;
  public abstract readonly code: ErrorCode;
}

/**
 * File or directory not found error
 */
export class FileNotFoundError extends SystemError {
  public readonly code = ErrorCode.SYSTEM_FILE_NOT_FOUND;

  constructor(
    filePath: string,
    operation?: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = operation
      ? `File not found during ${operation}: ${filePath}`
      : `File not found: ${filePath}`;

    super(message, {
      code: ErrorCode.SYSTEM_FILE_NOT_FOUND,
      context: {
        ...options?.context,
        metadata: {
          filePath,
          operation,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check if the file path is correct',
          'Verify the file exists at the specified location',
          'Check file permissions',
          'Try using an absolute path instead of relative path'
        ],
        isRetriable: false
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'create_file',
          description: 'Create the missing file',
          type: RecoveryActionType.REPAIR,
          canAutomate: false,
          successProbability: 0.8
        },
        {
          id: 'use_alternative_path',
          description: 'Try alternative file paths',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.6
        }
      ]
    });
  }
}

/**
 * Permission denied error for file/directory operations
 */
export class PermissionDeniedError extends SystemError {
  public readonly code = ErrorCode.SYSTEM_PERMISSION_DENIED;

  constructor(
    resourcePath: string,
    operation: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `Permission denied for ${operation} operation on: ${resourcePath}`;

    super(message, {
      code: ErrorCode.SYSTEM_PERMISSION_DENIED,
      context: {
        ...options?.context,
        metadata: {
          filePath: resourcePath,
          operation,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check file/directory permissions',
          'Run the command with elevated privileges (sudo)',
          'Change file ownership or permissions',
          'Check if the resource is locked by another process'
        ],
        isRetriable: false
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'check_permissions',
          description: 'Check and display current permissions',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        },
        {
          id: 'request_elevated_privileges',
          description: 'Request elevated privileges',
          type: RecoveryActionType.ESCALATE,
          canAutomate: false,
          successProbability: 0.7
        }
      ]
    });
  }
}

/**
 * Disk space insufficient error
 */
export class DiskFullError extends SystemError {
  public readonly code = ErrorCode.SYSTEM_DISK_FULL;

  constructor(
    operation: string,
    requiredSpace?: number,
    availableSpace?: number,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    let message = `Insufficient disk space for ${operation}`;
    if (requiredSpace && availableSpace) {
      message += ` (required: ${requiredSpace}, available: ${availableSpace})`;
    }

    super(message, {
      code: ErrorCode.SYSTEM_DISK_FULL,
      context: {
        ...options?.context,
        metadata: {
          operation,
          requiredSpace,
          availableSpace,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Free up disk space by deleting unnecessary files',
          'Move files to external storage',
          'Clean up temporary files',
          'Check for large log files that can be archived'
        ],
        isRetriable: false
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'check_disk_usage',
          description: 'Check current disk usage',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        },
        {
          id: 'cleanup_temp_files',
          description: 'Clean up temporary files',
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.5
        }
      ]
    });
  }
}

/**
 * File or directory already exists error
 */
export class AlreadyExistsError extends SystemError {
  public readonly code = ErrorCode.SYSTEM_ALREADY_EXISTS;

  constructor(
    resourcePath: string,
    operation: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `Resource already exists for ${operation}: ${resourcePath}`;

    super(message, {
      code: ErrorCode.SYSTEM_ALREADY_EXISTS,
      context: {
        ...options?.context,
        metadata: {
          filePath: resourcePath,
          operation,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Use a different name for the resource',
          'Remove the existing resource first',
          'Use overwrite option if available',
          'Check if the existing resource can be merged'
        ],
        isRetriable: false
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'use_different_name',
          description: 'Generate unique name for the resource',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.9
        },
        {
          id: 'overwrite_existing',
          description: 'Overwrite the existing resource',
          type: RecoveryActionType.REPAIR,
          canAutomate: false,
          successProbability: 0.8
        }
      ]
    });
  }
}

/**
 * General I/O error for file system operations
 */
export class IOError extends SystemError {
  public readonly code = ErrorCode.SYSTEM_IO_ERROR;

  constructor(
    operation: string,
    details?: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    let message = `I/O error during ${operation}`;
    if (details) {
      message += `: ${details}`;
    }

    super(message, {
      code: ErrorCode.SYSTEM_IO_ERROR,
      context: {
        ...options?.context,
        metadata: {
          operation,
          details,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check system resources and disk health',
          'Verify file system integrity',
          'Try the operation again',
          'Check for hardware issues'
        ],
        isRetriable: true,
        maxRetries: 3,
        retryDelay: {
          initialDelay: 1000,
          maxDelay: 5000,
          backoffMultiplier: 2,
          useJitter: true
        }
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'retry_operation',
          description: 'Retry the I/O operation',
          type: RecoveryActionType.RETRY,
          canAutomate: true,
          successProbability: 0.6
        },
        {
          id: 'check_system_health',
          description: 'Check system and disk health',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * Invalid path error
 */
export class InvalidPathError extends SystemError {
  public readonly code = ErrorCode.SYSTEM_INVALID_PATH;

  constructor(
    path: string,
    reason?: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    let message = `Invalid path: ${path}`;
    if (reason) {
      message += ` (${reason})`;
    }

    super(message, {
      code: ErrorCode.SYSTEM_INVALID_PATH,
      context: {
        ...options?.context,
        metadata: {
          filePath: path,
          reason,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Check path syntax and format',
          'Use absolute paths instead of relative paths',
          'Ensure path doesn\'t contain invalid characters',
          'Verify path length is within system limits'
        ],
        isRetriable: false
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'normalize_path',
          description: 'Normalize and validate the path',
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.8
        },
        {
          id: 'suggest_alternative_path',
          description: 'Suggest alternative valid paths',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.6
        }
      ]
    });
  }
}

/**
 * Resource busy error (file locked, process running, etc.)
 */
export class ResourceBusyError extends SystemError {
  public readonly code = ErrorCode.SYSTEM_RESOURCE_BUSY;

  constructor(
    resource: string,
    operation: string,
    lockingProcess?: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    let message = `Resource busy for ${operation}: ${resource}`;
    if (lockingProcess) {
      message += ` (locked by: ${lockingProcess})`;
    }

    super(message, {
      code: ErrorCode.SYSTEM_RESOURCE_BUSY,
      context: {
        ...options?.context,
        metadata: {
          resource,
          operation,
          lockingProcess,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          'Wait for the resource to become available',
          'Close applications that might be using the resource',
          'Check for processes that have the resource open',
          'Try again in a moment'
        ],
        isRetriable: true,
        maxRetries: 5,
        retryDelay: {
          initialDelay: 2000,
          maxDelay: 10000,
          backoffMultiplier: 1.5,
          useJitter: true
        }
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'wait_and_retry',
          description: 'Wait for resource to become available',
          type: RecoveryActionType.RETRY,
          canAutomate: true,
          successProbability: 0.7,
          estimatedTime: 5000
        },
        {
          id: 'find_locking_process',
          description: 'Find and display process using the resource',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * System resource exhausted error (memory, handles, etc.)
 */
export class ResourceExhaustedError extends SystemError {
  public readonly code = ErrorCode.SYSTEM_RESOURCE_EXHAUSTED;

  constructor(
    resourceType: string,
    operation: string,
    options?: {
      context?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `System ${resourceType} exhausted during ${operation}`;

    super(message, {
      code: ErrorCode.SYSTEM_RESOURCE_EXHAUSTED,
      context: {
        ...options?.context,
        metadata: {
          resourceType,
          operation,
          ...options?.context?.metadata
        },
        recoverySuggestions: [
          `Free up ${resourceType} by closing applications`,
          'Restart the application to reset resource usage',
          'Check for memory leaks or resource leaks',
          'Increase system resource limits if possible'
        ],
        isRetriable: true,
        maxRetries: 2,
        retryDelay: {
          initialDelay: 5000,
          maxDelay: 15000,
          backoffMultiplier: 2,
          useJitter: false
        }
      },
      cause: options?.cause,
      recoveryActions: [
        {
          id: 'garbage_collect',
          description: 'Force garbage collection',
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.5
        },
        {
          id: 'check_resource_usage',
          description: `Check current ${resourceType} usage`,
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}