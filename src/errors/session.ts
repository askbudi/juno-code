/**
 * Session Error Classes
 */

import { JunoTaskError, RecoveryAction, RecoveryActionType } from './base';
import { ErrorCategory } from './categories';
import { ErrorCode } from './codes';
import type { ErrorContext } from './context';

export abstract class SessionError extends JunoTaskError {
  public abstract readonly code: ErrorCode;
  public readonly category = ErrorCategory.SESSION;
}

export class SessionNotFoundError extends SessionError {
  public readonly code = ErrorCode.SESSION_NOT_FOUND;

  constructor(sessionId: string, options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`Session not found: ${sessionId}`, {
      code: ErrorCode.SESSION_NOT_FOUND,
      context: { ...options?.context, metadata: { sessionId, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'create_new_session', description: 'Create new session', type: RecoveryActionType.REPAIR, canAutomate: true, successProbability: 0.9 }
      ]
    });
  }
}

export class SessionExpiredError extends SessionError {
  public readonly code = ErrorCode.SESSION_EXPIRED;

  constructor(sessionId: string, expiredAt: Date, options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`Session expired: ${sessionId} at ${expiredAt.toISOString()}`, {
      code: ErrorCode.SESSION_EXPIRED,
      context: { ...options?.context, metadata: { sessionId, expiredAt, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'refresh_session', description: 'Refresh session', type: RecoveryActionType.REPAIR, canAutomate: true, successProbability: 0.8 }
      ]
    });
  }
}