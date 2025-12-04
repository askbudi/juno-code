/**
 * Hook execution utility module for juno-task-ts
 *
 * Provides robust hook execution functionality with comprehensive logging,
 * error handling, and execution context tracking.
 *
 * @module utils/hooks
 */

import { execa } from 'execa';
import { logger, LogContext, LogLevel } from '../cli/utils/advanced-logger.js';

/**
 * Supported hook types for lifecycle execution
 */
export type HookType = 'START_RUN' | 'START_ITERATION' | 'END_ITERATION' | 'END_RUN';

/**
 * Hook configuration interface
 */
export interface Hook {
  /** List of bash commands to execute for this hook */
  commands: string[];
}

/**
 * Complete hooks configuration mapping hook types to their configurations
 */
export interface HooksConfig {
  [key: string]: Hook;
}

/**
 * Execution context for hooks - provides information about the current execution state
 */
export interface HookExecutionContext {
  /** Current iteration number (for iteration-based hooks) */
  iteration?: number;
  /** Session ID for tracking */
  sessionId?: string;
  /** Working directory for command execution */
  workingDirectory?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
  /** Run ID for tracking across hooks */
  runId?: string;
  /** Total iterations planned */
  totalIterations?: number;
}

/**
 * Result of a single command execution within a hook
 */
export interface CommandExecutionResult {
  /** The command that was executed */
  command: string;
  /** Exit code (0 for success) */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error output */
  stderr: string;
  /** Execution duration in milliseconds */
  duration: number;
  /** Whether the command succeeded */
  success: boolean;
  /** Error if execution failed */
  error?: Error;
}

/**
 * Result of executing all commands in a hook
 */
export interface HookExecutionResult {
  /** Hook type that was executed */
  hookType: HookType;
  /** Total execution duration for all commands */
  totalDuration: number;
  /** Results for each command */
  commandResults: CommandExecutionResult[];
  /** Overall success (true if all commands succeeded) */
  success: boolean;
  /** Number of commands executed */
  commandsExecuted: number;
  /** Number of commands that failed */
  commandsFailed: number;
}

/**
 * Hook execution options
 */
export interface HookExecutionOptions {
  /** Maximum timeout per command in milliseconds (default: 300000 = 5 minutes) */
  commandTimeout?: number;
  /** Environment variables to pass to commands */
  env?: Record<string, string>;
  /** Whether to continue executing commands if one fails (default: true) */
  continueOnError?: boolean;
  /** Custom logger context (default: 'SYSTEM') */
  logContext?: LogContext;
}

/**
 * Create a context-specific logger for hook execution
 */
const hookLogger = logger.child(LogContext.SYSTEM, { component: 'hooks' });

/**
 * Execute a specific hook type with the provided context
 *
 * This is the main entry point for hook execution. It handles:
 * - Hook existence validation
 * - Sequential command execution
 * - Comprehensive logging with execution context
 * - Robust error handling (log but don't throw)
 * - Performance tracking
 *
 * @param hookType - The type of hook to execute
 * @param hooks - The complete hooks configuration
 * @param context - Execution context with iteration, session info, etc.
 * @param options - Additional execution options
 * @returns Promise that resolves when all commands complete (never throws)
 *
 * @example
 * ```typescript
 * const hooks = {
 *   START_ITERATION: {
 *     commands: ['echo "Starting iteration $ITERATION"', 'npm test']
 *   }
 * };
 *
 * const context = {
 *   iteration: 1,
 *   sessionId: 'session-123',
 *   workingDirectory: '/path/to/project'
 * };
 *
 * await executeHook('START_ITERATION', hooks, context);
 * ```
 */
export async function executeHook(
  hookType: HookType,
  hooks: HooksConfig,
  context: HookExecutionContext = {},
  options: HookExecutionOptions = {}
): Promise<HookExecutionResult> {
  const startTime = Date.now();
  const {
    commandTimeout = 300000, // 5 minutes default (increased from 30s to support long-running hook scripts)
    env = {},
    continueOnError = true,
    logContext = LogContext.SYSTEM,
  } = options;

  // Create context-specific logger
  const contextLogger = logger.child(logContext, {
    hookType,
    iteration: context.iteration,
    sessionId: context.sessionId,
    runId: context.runId,
  });

  contextLogger.info(`Starting hook execution: ${hookType}`, {
    context,
    workingDirectory: context.workingDirectory || process.cwd(),
    commandTimeout,
    continueOnError,
  });

  // Check if hook exists
  const hook = hooks[hookType];
  if (!hook) {
    contextLogger.debug(`Hook ${hookType} not defined - skipping execution`);
    return {
      hookType,
      totalDuration: Date.now() - startTime,
      commandResults: [],
      success: true,
      commandsExecuted: 0,
      commandsFailed: 0,
    };
  }

  // Check if hook has commands
  if (!hook.commands || hook.commands.length === 0) {
    contextLogger.debug(`Hook ${hookType} has no commands - skipping execution`);
    return {
      hookType,
      totalDuration: Date.now() - startTime,
      commandResults: [],
      success: true,
      commandsExecuted: 0,
      commandsFailed: 0,
    };
  }

  contextLogger.info(`Executing ${hook.commands.length} commands for hook ${hookType}`);

  const commandResults: CommandExecutionResult[] = [];
  let commandsFailed = 0;

  // Execute each command sequentially
  for (let i = 0; i < hook.commands.length; i++) {
    const command = hook.commands[i];
    const commandStartTime = Date.now();

    contextLogger.info(`Executing command ${i + 1}/${hook.commands.length}: ${command}`, {
      commandIndex: i,
      totalCommands: hook.commands.length,
    });

    try {
      // Prepare environment variables with context
      const execEnv = {
        ...process.env,
        ...env,
        // Add context as environment variables
        HOOK_TYPE: hookType,
        ITERATION: context.iteration?.toString() || '',
        SESSION_ID: context.sessionId || '',
        RUN_ID: context.runId || '',
        TOTAL_ITERATIONS: context.totalIterations?.toString() || '',
        // Add any metadata as prefixed environment variables
        ...Object.fromEntries(
          Object.entries(context.metadata || {}).map(([key, value]) => [
            `JUNO_${key.toUpperCase()}`,
            String(value),
          ])
        ),
      };

      // Execute command with timeout and proper working directory
      // IMPORTANT: stdin is set to 'ignore' to prevent blocking when juno-code
      // is invoked with piped input (e.g., `echo "data" | juno-code start`).
      // Without this, hook subprocesses inherit parent's stdin and may block
      // indefinitely waiting for EOF on the inherited stdin stream.
      const result = await execa(command, {
        shell: true,
        timeout: commandTimeout,
        cwd: context.workingDirectory || process.cwd(),
        env: execEnv,
        // Capture both stdout and stderr
        all: true,
        reject: false, // Don't throw on non-zero exit codes
        stdin: 'ignore', // Prevent stdin inheritance to avoid blocking on piped input
      });

      const duration = Date.now() - commandStartTime;
      const success = result.exitCode === 0;

      const commandResult: CommandExecutionResult = {
        command,
        exitCode: result.exitCode,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        duration,
        success,
      };

      commandResults.push(commandResult);

      if (success) {
        contextLogger.info(`Command completed successfully`, {
          command,
          exitCode: result.exitCode,
          duration,
          stdout: result.stdout ? result.stdout.substring(0, 500) : undefined, // Truncate for logging
        });

        // Log stdout if present
        if (result.stdout) {
          contextLogger.debug(`Command stdout:`, { stdout: result.stdout });
        }
      } else {
        commandsFailed++;
        contextLogger.error(`Command failed`, {
          command,
          exitCode: result.exitCode,
          duration,
          stderr: result.stderr,
          stdout: result.stdout,
        });

        // Log stderr if present
        if (result.stderr) {
          contextLogger.error(`Command stderr:`, { stderr: result.stderr });
        }

        // If we shouldn't continue on error, break the loop
        if (!continueOnError) {
          contextLogger.warn(`Stopping hook execution due to command failure (continueOnError=false)`);
          break;
        }
      }
    } catch (error) {
      const duration = Date.now() - commandStartTime;
      commandsFailed++;

      let errorMessage = 'Unknown error';
      let isTimeout = false;

      if (error instanceof Error) {
        errorMessage = error.message;
        // Check for execa-specific timeout property
        isTimeout = 'timedOut' in error ? Boolean((error as any).timedOut) : false;
      }

      const commandResult: CommandExecutionResult = {
        command,
        exitCode: -1,
        stdout: '',
        stderr: errorMessage,
        duration,
        success: false,
        error: error as Error,
      };

      commandResults.push(commandResult);

      if (isTimeout) {
        contextLogger.error(`Command timed out after ${commandTimeout}ms`, {
          command,
          timeout: commandTimeout,
          duration,
          error: errorMessage,
        });
      } else {
        contextLogger.error(`Command execution failed`, {
          command,
          duration,
          error: errorMessage,
        });
      }

      // If we shouldn't continue on error, break the loop
      if (!continueOnError) {
        contextLogger.warn(`Stopping hook execution due to command failure (continueOnError=false)`);
        break;
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  const success = commandsFailed === 0;
  const commandsExecuted = commandResults.length;

  const result: HookExecutionResult = {
    hookType,
    totalDuration,
    commandResults,
    success,
    commandsExecuted,
    commandsFailed,
  };

  contextLogger.info(`Hook execution completed`, {
    hookType,
    totalDuration,
    commandsExecuted,
    commandsFailed,
    success,
  });

  return result;
}

/**
 * Execute multiple hooks in sequence
 *
 * Convenience function for executing multiple hooks with the same context.
 * Each hook is executed independently - failure of one hook does not stop
 * execution of subsequent hooks.
 *
 * @param hookTypes - Array of hook types to execute
 * @param hooks - The complete hooks configuration
 * @param context - Execution context
 * @param options - Execution options
 * @returns Promise resolving to array of hook execution results
 */
export async function executeHooks(
  hookTypes: HookType[],
  hooks: HooksConfig,
  context: HookExecutionContext = {},
  options: HookExecutionOptions = {}
): Promise<HookExecutionResult[]> {
  const results: HookExecutionResult[] = [];

  hookLogger.info(`Starting batch hook execution`, {
    hookTypes,
    context,
  });

  for (const hookType of hookTypes) {
    const result = await executeHook(hookType, hooks, context, options);
    results.push(result);
  }

  const totalSuccess = results.every(r => r.success);
  const totalCommands = results.reduce((sum, r) => sum + r.commandsExecuted, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.commandsFailed, 0);

  hookLogger.info(`Batch hook execution completed`, {
    hookTypes,
    totalHooks: results.length,
    totalCommands,
    totalFailed,
    success: totalSuccess,
  });

  return results;
}

/**
 * Validate hooks configuration
 *
 * Checks that all hook configurations are valid and provides warnings
 * for common issues.
 *
 * @param hooks - Hooks configuration to validate
 * @returns Validation result with any issues found
 */
export function validateHooksConfig(hooks: HooksConfig): {
  valid: boolean;
  issues: string[];
  warnings: string[];
} {
  const issues: string[] = [];
  const warnings: string[] = [];

  const validHookTypes: HookType[] = ['START_RUN', 'START_ITERATION', 'END_ITERATION', 'END_RUN'];

  for (const [hookType, hook] of Object.entries(hooks)) {
    // Check if hook type is valid
    if (!validHookTypes.includes(hookType as HookType)) {
      warnings.push(`Unknown hook type: ${hookType}. Valid types are: ${validHookTypes.join(', ')}`);
    }

    // Check if hook has commands array
    if (!hook.commands) {
      issues.push(`Hook ${hookType} is missing 'commands' array`);
      continue;
    }

    if (!Array.isArray(hook.commands)) {
      issues.push(`Hook ${hookType} 'commands' must be an array`);
      continue;
    }

    // Check if commands are strings
    for (let i = 0; i < hook.commands.length; i++) {
      const command = hook.commands[i];
      if (typeof command !== 'string') {
        issues.push(`Hook ${hookType} command ${i} must be a string, got ${typeof command}`);
      } else if (command.trim() === '') {
        warnings.push(`Hook ${hookType} command ${i} is empty`);
      }
    }

    // Warn about potentially dangerous commands
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      /sudo\s+rm/,
      /format\s+c:/i,
      /del\s+\/s/i,
    ];

    for (const command of hook.commands) {
      if (typeof command === 'string') {
        for (const pattern of dangerousPatterns) {
          if (pattern.test(command)) {
            warnings.push(`Hook ${hookType} contains potentially dangerous command: ${command}`);
          }
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
  };
}

/**
 * Default export for convenience
 */
export default {
  executeHook,
  executeHooks,
  validateHooksConfig,
};