/**
 * Configuration Error Classes
 */

import { JunoTaskError, RecoveryAction, RecoveryActionType } from './base';
import { ErrorCategory } from './categories';
import { ErrorCode } from './codes';
import type { ErrorContext } from './context';

export abstract class ConfigurationError extends JunoTaskError {
  public abstract readonly code: ErrorCode;
  public readonly category = ErrorCategory.CONFIGURATION;
}

export class ConfigFileNotFoundError extends ConfigurationError {
  public readonly code = ErrorCode.CONFIG_FILE_NOT_FOUND;

  constructor(filePath: string, options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`Configuration file not found: ${filePath}`, {
      code: ErrorCode.CONFIG_FILE_NOT_FOUND,
      context: { ...options?.context, metadata: { filePath, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'create_default_config', description: 'Create default configuration', type: RecoveryActionType.REPAIR, canAutomate: true, successProbability: 0.9 }
      ]
    });
  }
}

export class ConfigInvalidSyntaxError extends ConfigurationError {
  public readonly code = ErrorCode.CONFIG_INVALID_SYNTAX;

  constructor(filePath: string, syntaxError: string, options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`Invalid syntax in configuration file: ${filePath} - ${syntaxError}`, {
      code: ErrorCode.CONFIG_INVALID_SYNTAX,
      context: { ...options?.context, metadata: { filePath, syntaxError, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'fix_syntax', description: 'Fix configuration syntax', type: RecoveryActionType.REPAIR, canAutomate: false, successProbability: 0.8 }
      ]
    });
  }
}