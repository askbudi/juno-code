/**
 * CLI Error Classes
 */

import { JunoTaskError, RecoveryAction, RecoveryActionType } from './base';
import { ErrorCategory } from './categories';
import { ErrorCode } from './codes';
import type { ErrorContext } from './context';

export abstract class CLIError extends JunoTaskError {
  public abstract readonly code: ErrorCode;
  public readonly category = ErrorCategory.CLI;
}

export class CommandNotFoundError extends CLIError {
  public readonly code = ErrorCode.CLI_COMMAND_NOT_FOUND;

  constructor(command: string, availableCommands?: readonly string[], options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    let message = `Command not found: ${command}`;
    if (availableCommands?.length) {
      message += `. Available commands: ${availableCommands.join(', ')}`;
    }

    super(message, {
      code: ErrorCode.CLI_COMMAND_NOT_FOUND,
      context: { ...options?.context, metadata: { command, availableCommands, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'suggest_similar_command', description: 'Suggest similar commands', type: RecoveryActionType.FALLBACK, canAutomate: true, successProbability: 0.7 }
      ]
    });
  }
}

export class InvalidArgumentsError extends CLIError {
  public readonly code = ErrorCode.CLI_INVALID_ARGUMENTS;

  constructor(command: string, invalidArgs: readonly string[], options?: { context?: Partial<ErrorContext>; cause?: Error }) {
    super(`Invalid arguments for command '${command}': ${invalidArgs.join(', ')}`, {
      code: ErrorCode.CLI_INVALID_ARGUMENTS,
      context: { ...options?.context, metadata: { command, invalidArgs, ...options?.context?.metadata }},
      cause: options?.cause,
      recoveryActions: [
        { id: 'show_command_help', description: 'Show command help', type: RecoveryActionType.MANUAL, canAutomate: true, successProbability: 1.0 }
      ]
    });
  }
}