/**
 * Error Categories for Unified Error Hierarchy
 *
 * Defines the main error categories used throughout juno-task-ts
 * for organizing and handling different types of errors.
 */

/**
 * Primary error categories in the juno-task-ts system
 */
export enum ErrorCategory {
  /** System-level errors (file system, network, OS operations) */
  SYSTEM = 'system',

  /** Input validation and schema errors */
  VALIDATION = 'validation',

  /** Configuration file and setup errors */
  CONFIGURATION = 'configuration',

  /** MCP server interaction errors */
  MCP = 'mcp',

  /** Template processing and generation errors */
  TEMPLATE = 'template',

  /** Session management and state errors */
  SESSION = 'session',

  /** Command-line interface errors */
  CLI = 'cli',

  /** Terminal user interface errors */
  TUI = 'tui',

  /** Internal application errors */
  INTERNAL = 'internal',

  /** Network and connectivity errors */
  NETWORK = 'network',

  /** Security and permission errors */
  SECURITY = 'security'
}

/**
 * Error severity levels for prioritizing and handling errors
 */
export enum ErrorSeverity {
  /** Low impact errors that don't affect functionality */
  LOW = 'low',

  /** Medium impact errors that may degrade functionality */
  MEDIUM = 'medium',

  /** High impact errors that significantly affect functionality */
  HIGH = 'high',

  /** Critical errors that prevent normal operation */
  CRITICAL = 'critical',

  /** Fatal errors that require immediate termination */
  FATAL = 'fatal'
}

/**
 * Error priority for handling and recovery order
 */
export enum ErrorPriority {
  /** Lowest priority - handle when convenient */
  LOWEST = 0,

  /** Low priority - handle in background */
  LOW = 1,

  /** Normal priority - handle in normal flow */
  NORMAL = 2,

  /** High priority - handle immediately */
  HIGH = 3,

  /** Highest priority - handle before all others */
  HIGHEST = 4
}

/**
 * Error handling strategy types
 */
export enum ErrorHandlingStrategy {
  /** Fail fast - throw error immediately */
  FAIL_FAST = 'fail_fast',

  /** Retry - attempt operation again */
  RETRY = 'retry',

  /** Fallback - use alternative approach */
  FALLBACK = 'fallback',

  /** Graceful degradation - continue with reduced functionality */
  GRACEFUL_DEGRADATION = 'graceful_degradation',

  /** User intervention - require user action */
  USER_INTERVENTION = 'user_intervention',

  /** Ignore - log and continue */
  IGNORE = 'ignore'
}

/**
 * Mapping of error categories to default severity levels
 */
export const DEFAULT_CATEGORY_SEVERITY: Record<ErrorCategory, ErrorSeverity> = {
  [ErrorCategory.SYSTEM]: ErrorSeverity.HIGH,
  [ErrorCategory.VALIDATION]: ErrorSeverity.MEDIUM,
  [ErrorCategory.CONFIGURATION]: ErrorSeverity.HIGH,
  [ErrorCategory.MCP]: ErrorSeverity.HIGH,
  [ErrorCategory.TEMPLATE]: ErrorSeverity.MEDIUM,
  [ErrorCategory.SESSION]: ErrorSeverity.MEDIUM,
  [ErrorCategory.CLI]: ErrorSeverity.LOW,
  [ErrorCategory.TUI]: ErrorSeverity.LOW,
  [ErrorCategory.INTERNAL]: ErrorSeverity.CRITICAL,
  [ErrorCategory.NETWORK]: ErrorSeverity.HIGH,
  [ErrorCategory.SECURITY]: ErrorSeverity.CRITICAL
};

/**
 * Mapping of error categories to default handling strategies
 */
export const DEFAULT_CATEGORY_STRATEGY: Record<ErrorCategory, ErrorHandlingStrategy> = {
  [ErrorCategory.SYSTEM]: ErrorHandlingStrategy.RETRY,
  [ErrorCategory.VALIDATION]: ErrorHandlingStrategy.USER_INTERVENTION,
  [ErrorCategory.CONFIGURATION]: ErrorHandlingStrategy.USER_INTERVENTION,
  [ErrorCategory.MCP]: ErrorHandlingStrategy.RETRY,
  [ErrorCategory.TEMPLATE]: ErrorHandlingStrategy.FALLBACK,
  [ErrorCategory.SESSION]: ErrorHandlingStrategy.RETRY,
  [ErrorCategory.CLI]: ErrorHandlingStrategy.USER_INTERVENTION,
  [ErrorCategory.TUI]: ErrorHandlingStrategy.FALLBACK,
  [ErrorCategory.INTERNAL]: ErrorHandlingStrategy.FAIL_FAST,
  [ErrorCategory.NETWORK]: ErrorHandlingStrategy.RETRY,
  [ErrorCategory.SECURITY]: ErrorHandlingStrategy.FAIL_FAST
};

/**
 * Check if an error category is retriable by default
 */
export function isCategoryRetriable(category: ErrorCategory): boolean {
  const strategy = DEFAULT_CATEGORY_STRATEGY[category];
  return strategy === ErrorHandlingStrategy.RETRY || strategy === ErrorHandlingStrategy.FALLBACK;
}

/**
 * Get the default priority for an error category
 */
export function getCategoryPriority(category: ErrorCategory): ErrorPriority {
  const severity = DEFAULT_CATEGORY_SEVERITY[category];

  switch (severity) {
    case ErrorSeverity.FATAL:
      return ErrorPriority.HIGHEST;
    case ErrorSeverity.CRITICAL:
      return ErrorPriority.HIGH;
    case ErrorSeverity.HIGH:
      return ErrorPriority.HIGH;
    case ErrorSeverity.MEDIUM:
      return ErrorPriority.NORMAL;
    case ErrorSeverity.LOW:
    default:
      return ErrorPriority.LOW;
  }
}