/**
 * CLI Error utilities
 *
 * Re-exports error types from the CLI types module for convenience.
 */
export {
  isCLIError,
  ConfigurationError,
  ExecutionError as CLIExecutionError,
} from '../types.js';

/**
 * Format an error for CLI display
 */
export function formatError(error: Error): string {
  return `Error: ${error.message}`;
}
