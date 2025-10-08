/**
 * TUI Error Classes
 */

import { JunoTaskError, RecoveryAction, RecoveryActionType } from './base';
import { ErrorCategory } from './categories';
import { ErrorCode } from './codes';
import type { ErrorContext } from './context';

export abstract class TUIError extends JunoTaskError {
  public abstract readonly code: ErrorCode;
  public readonly category = ErrorCategory.TUI;
}

export class TUIRenderError extends TUIError {
  public readonly code = ErrorCode.TUI_RENDER_ERROR;

  constructor(component: string, renderError: string, options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`TUI render error in component '${component}': ${renderError}`, {
      code: ErrorCode.TUI_RENDER_ERROR,
      context: { ...options?.context, metadata: { component, renderError, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'fallback_to_cli', description: 'Fallback to CLI mode', type: RecoveryActionType.FALLBACK, canAutomate: true, successProbability: 0.9 }
      ]
    });
  }
}

export class TUINotAvailableError extends TUIError {
  public readonly code = ErrorCode.TUI_NOT_AVAILABLE;

  constructor(reason: string, options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`TUI not available: ${reason}`, {
      code: ErrorCode.TUI_NOT_AVAILABLE,
      context: { ...options?.context, metadata: { reason, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'use_cli_mode', description: 'Use CLI mode instead', type: RecoveryActionType.FALLBACK, canAutomate: true, successProbability: 1.0 }
      ]
    });
  }
}