/**
 * Template Error Classes
 */

import { JunoTaskError, RecoveryAction, RecoveryActionType } from './base';
import { ErrorCategory } from './categories';
import { ErrorCode } from './codes';
import type { ErrorContext } from './context';

export abstract class TemplateError extends JunoTaskError {
  public abstract readonly code: ErrorCode;
  public readonly category = ErrorCategory.TEMPLATE;
}

export class TemplateNotFoundError extends TemplateError {
  public readonly code = ErrorCode.TEMPLATE_NOT_FOUND;

  constructor(templateId: string, options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`Template not found: ${templateId}`, {
      code: ErrorCode.TEMPLATE_NOT_FOUND,
      context: { ...options?.context, metadata: { templateId, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'use_default_template', description: 'Use default template', type: RecoveryActionType.FALLBACK, canAutomate: true, successProbability: 0.7 }
      ]
    });
  }
}

export class TemplateSyntaxError extends TemplateError {
  public readonly code = ErrorCode.TEMPLATE_SYNTAX_ERROR;

  constructor(templateId: string, syntaxError: string, options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`Template syntax error in ${templateId}: ${syntaxError}`, {
      code: ErrorCode.TEMPLATE_SYNTAX_ERROR,
      context: { ...options?.context, metadata: { templateId, syntaxError, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'fix_template_syntax', description: 'Fix template syntax', type: RecoveryActionType.REPAIR, canAutomate: false, successProbability: 0.6 }
      ]
    });
  }
}