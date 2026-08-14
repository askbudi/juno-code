/**
 * Hook execution utility module for juno-task-ts
 *
 * Provides robust hook execution functionality with comprehensive logging,
 * error handling, and execution context tracking.
 *
 * @module utils/hooks
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { logger, LogContext } from '../cli/utils/advanced-logger.js';
import { buildChildProcessEnvironment } from '../core/child-process-environment.js';

/**
 * Supported hook types for lifecycle execution
 */
export type HookType = 'START_RUN' | 'START_ITERATION' | 'END_ITERATION' | 'END_RUN' | 'ON_STALE';

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
  commandTimeout?: number | undefined;
  /** Environment variables to pass to commands */
  env?: Record<string, string> | undefined;
  /** Whether to continue executing commands if one fails (default: true) */
  continueOnError?: boolean | undefined;
  /** Custom logger context (default: 'SYSTEM') */
  logContext?: LogContext | undefined;
}

/**
 * Create a context-specific logger for hook execution
 */
const hookLogger = logger.child(LogContext.SYSTEM);

const MAX_HOOK_LOG_OUTPUT_CHARS = 8000;

function truncateForHookLog(value: string): string {
  if (value.length <= MAX_HOOK_LOG_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_HOOK_LOG_OUTPUT_CHARS)}\n... [truncated ${value.length - MAX_HOOK_LOG_OUTPUT_CHARS} chars]`;
}

function appendHookOutputSection(lines: string[], label: string, value: string | undefined): void {
  if (!value) {
    return;
  }

  lines.push(`${label}:`);
  lines.push(truncateForHookLog(value.trimEnd()));
}

export interface HookWorkingDirectoryResolution {
  directory: string | null;
  diagnostic: string | null;
  surface: 'invocation' | 'integration-owner' | 'unavailable';
}

function gitConfig(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Resolve project-owned hook commands away from a sparse metadata controller. */
export function resolveHookWorkingDirectory(requested: string): HookWorkingDirectoryResolution {
  const root = path.resolve(requested);
  const role = gitConfig(root, ['config', '--worktree', '--get', 'juno.workspace.role']);
  if (role !== 'controller')
    return { directory: root, diagnostic: null, surface: 'invocation' };
  const registered = gitConfig(root, ['config', '--get', 'juno.integration.ownerPath']);
  if (!registered) {
    return {
      directory: null,
      surface: 'unavailable',
      diagnostic: 'configured project hook skipped: sparse controller has no canonical product surface; run `yy integration register /absolute/integration-owner`',
    };
  }
  const candidate = path.resolve(registered);
  const exact = existsSync(candidate) && gitConfig(candidate, ['rev-parse', '--show-toplevel']);
  const candidateRole = exact ? gitConfig(candidate, ['config', '--worktree', '--get', 'juno.workspace.role']) : null;
  const authority = exact ? gitConfig(candidate, ['config', '--worktree', '--get', 'juno.workspace.roleAuthority']) : null;
  const controllerCommon = gitConfig(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const candidateCommon = exact
    ? gitConfig(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    : null;
  let canonical: string | null = null;
  try {
    canonical = exact ? realpathSync(exact) : null;
  } catch {
    canonical = null;
  }
  let registeredCanonical: string | null = null;
  try {
    registeredCanonical = realpathSync(candidate);
  } catch {
    registeredCanonical = null;
  }
  const sameRepository = Boolean(controllerCommon && candidateCommon &&
    path.resolve(root, controllerCommon) === path.resolve(candidate, candidateCommon));
  if (canonical !== registeredCanonical || !sameRepository ||
      candidateRole !== 'integration-owner' || authority !== 'protected-integration.v1') {
    return {
      directory: null,
      surface: 'unavailable',
      diagnostic: `configured project hook skipped: canonical product surface is missing or invalid: ${candidate}; run \`yy integration status\``,
    };
  }
  return { directory: registeredCanonical, diagnostic: null, surface: 'integration-owner' };
}

function formatFailedHookCommandMessage(params: {
  command: string;
  exitCode?: number | null;
  duration: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  timeout?: number;
}): string {
  const lines = [`Command failed: ${params.command}`];

  if (params.exitCode !== undefined && params.exitCode !== null) {
    lines.push(`Exit code: ${params.exitCode}`);
  }

  lines.push(`Duration: ${params.duration}ms`);

  if (params.timeout !== undefined) {
    lines.push(`Timeout: ${params.timeout}ms`);
  }

  if (params.error) {
    lines.push(`Error: ${params.error}`);
  }

  appendHookOutputSection(lines, 'stderr', params.stderr);
  appendHookOutputSection(lines, 'stdout', params.stdout);

  return lines.join('\n');
}

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
  options: HookExecutionOptions = {},
): Promise<HookExecutionResult> {
  const startTime = Date.now();
  const requestedWorkingDirectory = context.workingDirectory ?? process.cwd();
  const {
    commandTimeout = 300000, // 5 minutes default (increased from 30s to support long-running hook scripts)
    env = {},
    continueOnError = true,
    logContext = LogContext.SYSTEM,
  } = options;

  // Create context-specific logger
  const contextLogger = logger.child(logContext);

  contextLogger.debug(`Starting hook execution: ${hookType}`, {
    context,
    workingDirectory: requestedWorkingDirectory,
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

  contextLogger.debug(`Executing ${hook.commands.length} commands for hook ${hookType}`);

  const workingDirectory = resolveHookWorkingDirectory(
    requestedWorkingDirectory,
  );
  if (!workingDirectory.directory) {
    contextLogger.warn(workingDirectory.diagnostic ?? 'configured project hook skipped: product surface unavailable');
    return {
      hookType,
      totalDuration: Date.now() - startTime,
      commandResults: [],
      success: true,
      commandsExecuted: 0,
      commandsFailed: 0,
    };
  }
  if (workingDirectory.surface === 'integration-owner') {
    contextLogger.debug('Resolved configured project hook against canonical product surface', {
      workingDirectory: workingDirectory.directory,
    });
  }

  const commandResults: CommandExecutionResult[] = [];
  let commandsFailed = 0;

  // Execute each command sequentially
  for (let i = 0; i < hook.commands.length; i++) {
    const command = hook.commands[i]!;
    const commandStartTime = Date.now();

    contextLogger.debug(`Executing command ${i + 1}/${hook.commands.length}: ${command}`, {
      commandIndex: i,
      totalCommands: hook.commands.length,
    });

    try {
      // Prepare environment variables with context
      const execEnv = buildChildProcessEnvironment(process.env, {
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
          ]),
        ),
      });

      // Execute command with timeout and proper working directory
      //
      // CRITICAL: Using `input: ''` to properly close stdin
      //
      // History of stdin handling issues:
      // - Issue #40: Added stdin: 'ignore' - fixed blocking but broke internal pipes
      // - Issue #41: Removed stdin: 'ignore', used default 'pipe' - allowed internal
      //   pipes to work but caused commands to hang indefinitely when subprocess
      //   tried to read stdin (because the stdin pipe was never closed)
      // - Issue #42 (current): Commands like `juno-kanban ... | grep -q "..."` would
      //   hang for 5 minutes (timeout) because the shell's stdin pipe was never closed,
      //   causing subprocesses to block waiting for EOF on stdin.
      //
      // Solution: Use `input: ''` which:
      // 1. Provides empty input to the subprocess
      // 2. Properly closes stdin (sends EOF)
      // 3. Allows internal pipes to work (shell manages its own pipes)
      // 4. Prevents commands from hanging waiting for stdin
      //
      // The key insight: `input: ''` tells execa to write an empty string to stdin
      // and then close it, which signals EOF to the subprocess. This is different
      // from `stdin: 'pipe'` (default) which leaves the pipe open indefinitely.
      const result = await execa(command, {
        shell: true,
        timeout: commandTimeout,
        cwd: workingDirectory.directory,
        env: execEnv,
        // Capture both stdout and stderr
        all: true,
        reject: false, // Don't throw on non-zero exit codes
        // Use input: '' to provide empty stdin and properly close it (sends EOF)
        // This prevents commands from hanging waiting for stdin while still
        // allowing internal pipe operations to work correctly
        input: '',
      });

      const duration = Date.now() - commandStartTime;
      const success = result.exitCode === 0;

      const commandResult: CommandExecutionResult = {
        command,
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        duration,
        success,
      };

      commandResults.push(commandResult);

      if (success) {
        contextLogger.debug(`Command completed successfully`, {
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
        contextLogger.error(
          formatFailedHookCommandMessage({
            command,
            exitCode: result.exitCode,
            duration,
            stderr: result.stderr,
            stdout: result.stdout,
          }),
          {
            command,
            exitCode: result.exitCode,
            duration,
            stderr: result.stderr,
            stdout: result.stdout,
          },
        );

        // If we shouldn't continue on error, break the loop
        if (!continueOnError) {
          contextLogger.warn(
            `Stopping hook execution due to command failure (continueOnError=false)`,
          );
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

      const failedHookMessage = formatFailedHookCommandMessage({
        command,
        duration,
        error: errorMessage,
        ...(isTimeout && commandTimeout !== undefined ? { timeout: commandTimeout } : {}),
      });

      contextLogger.error(
        failedHookMessage,
        isTimeout
          ? {
              command,
              timeout: commandTimeout,
              duration,
              error: errorMessage,
            }
          : {
              command,
              duration,
              error: errorMessage,
            },
      );

      // If we shouldn't continue on error, break the loop
      if (!continueOnError) {
        contextLogger.warn(
          `Stopping hook execution due to command failure (continueOnError=false)`,
        );
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

  contextLogger.debug(`Hook execution completed`, {
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
  options: HookExecutionOptions = {},
): Promise<HookExecutionResult[]> {
  const results: HookExecutionResult[] = [];

  hookLogger.debug(`Starting batch hook execution`, {
    hookTypes,
    context,
  });

  for (const hookType of hookTypes) {
    const result = await executeHook(hookType, hooks, context, options);
    results.push(result);
  }

  const totalSuccess = results.every((r) => r.success);
  const totalCommands = results.reduce((sum, r) => sum + r.commandsExecuted, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.commandsFailed, 0);

  hookLogger.debug(`Batch hook execution completed`, {
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

  const validHookTypes: HookType[] = [
    'START_RUN',
    'START_ITERATION',
    'END_ITERATION',
    'END_RUN',
    'ON_STALE',
  ];

  for (const [hookType, hook] of Object.entries(hooks)) {
    // Check if hook type is valid
    if (!validHookTypes.includes(hookType as HookType)) {
      warnings.push(
        `Unknown hook type: ${hookType}. Valid types are: ${validHookTypes.join(', ')}`,
      );
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
    const dangerousPatterns = [/rm\s+-rf\s+\//, /sudo\s+rm/, /format\s+c:/i, /del\s+\/s/i];

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
