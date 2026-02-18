/**
 * Base Error Classes for Unified Error Hierarchy
 *
 * Provides the foundational error classes that all juno-task-ts errors inherit from,
 * with comprehensive context, recovery capabilities, and standardized interfaces.
 */

import type { ErrorCategory, ErrorSeverity, ErrorPriority, ErrorHandlingStrategy } from './categories';
import type { ErrorCode } from './codes';
import type { ErrorContext, ErrorMetadata, ErrorCorrelation, ErrorImpact } from './context';
import { createContextFromCode, createErrorCorrelation } from './context';

/**
 * Recovery action that can be suggested for an error
 */
export interface RecoveryAction {
  /** Unique identifier for the recovery action */
  readonly id: string;

  /** Human-readable description of the action */
  readonly description: string;

  /** Type of recovery action */
  readonly type: RecoveryActionType;

  /** Whether this action can be automated */
  readonly canAutomate: boolean;

  /** Estimated success probability (0-1) */
  readonly successProbability?: number;

  /** Time estimate for recovery in milliseconds */
  readonly estimatedTime?: number;

  /** Prerequisites for this recovery action */
  readonly prerequisites?: readonly string[];

  /** Function to execute this recovery action */
  readonly execute?: () => Promise<RecoveryResult>;
}

/**
 * Types of recovery actions
 */
export enum RecoveryActionType {
  /** Retry the operation */
  RETRY = 'retry',

  /** Use fallback approach */
  FALLBACK = 'fallback',

  /** Repair or fix the issue */
  REPAIR = 'repair',

  /** Reset to known good state */
  RESET = 'reset',

  /** Manual user intervention required */
  MANUAL = 'manual',

  /** Escalate to higher level handler */
  ESCALATE = 'escalate',

  /** Ignore and continue */
  IGNORE = 'ignore'
}

/**
 * Result of a recovery attempt
 */
export interface RecoveryResult {
  /** Whether recovery was successful */
  readonly success: boolean;

  /** Description of what was done */
  readonly description: string;

  /** New error if recovery failed */
  readonly error?: Error;

  /** Additional context from recovery */
  readonly context?: Record<string, unknown>;

  /** Whether to retry original operation */
  readonly shouldRetry: boolean;

  /** Delay before retry in milliseconds */
  readonly retryDelay?: number;
}

/**
 * Interface for errors that support recovery
 */
export interface Recoverable {
  /** Check if this error is recoverable */
  isRecoverable(): boolean;

  /** Get available recovery actions */
  getRecoveryActions(): readonly RecoveryAction[];

  /** Attempt recovery using specified action */
  attemptRecovery(actionId: string): Promise<RecoveryResult>;

  /** Get default recovery action */
  getDefaultRecoveryAction(): RecoveryAction | null;
}

/**
 * Interface for errors that support retry logic
 */
export interface Retryable {
  /** Check if this error is retryable */
  isRetryable(): boolean;

  /** Get maximum number of retry attempts */
  getMaxRetries(): number;

  /** Get retry delay for attempt number */
  getRetryDelay(attempt: number): number;

  /** Check if should retry based on attempt history */
  shouldRetry(attempts: number): boolean;

  /** Get backoff strategy */
  getBackoffStrategy(): BackoffStrategy;
}

/**
 * Backoff strategy for retries
 */
export interface BackoffStrategy {
  /** Calculate delay for given attempt number */
  calculateDelay(attempt: number): number;

  /** Maximum delay in milliseconds */
  readonly maxDelay: number;

  /** Whether to use jitter */
  readonly useJitter: boolean;
}

/**
 * Base error class for all juno-task-ts errors
 */
export abstract class JunoTaskError extends Error implements Recoverable, Retryable {
  /** Unique error identifier */
  public readonly id: string;

  /** Error code */
  public abstract readonly code: ErrorCode;

  /** Error category */
  public abstract readonly category: ErrorCategory;

  /** Rich error context */
  public readonly context: ErrorContext;

  /** Error correlation information */
  public readonly correlation: ErrorCorrelation;

  /** Original cause of this error */
  public readonly cause?: Error;

  /** Error impact assessment */
  public readonly impact?: ErrorImpact;

  /** When this error was created */
  public readonly timestamp: Date;

  /** Available recovery actions */
  protected recoveryActions: readonly RecoveryAction[] = [];

  /**
   * Create a new JunoTaskError
   */
  constructor(
    message: string,
    options: {
      code: ErrorCode;
      category?: ErrorCategory;
      context?: Partial<ErrorContext>;
      cause?: Error;
      correlation?: Partial<ErrorCorrelation>;
      impact?: ErrorImpact;
      recoveryActions?: readonly RecoveryAction[];
    }
  ) {
    super(message);

    this.name = this.constructor.name;
    this.timestamp = new Date();
    this.id = this.generateErrorId();
    this.cause = options.cause;
    this.impact = options.impact;
    this.recoveryActions = options.recoveryActions || [];

    // Create rich context
    this.context = options.context
      ? createContextFromCode(options.code, options.context)
      : createContextFromCode(options.code);

    // Create correlation information
    this.correlation = {
      ...createErrorCorrelation(options.cause),
      ...options.correlation
    };

    // Ensure the error stack includes the cause chain
    if (this.cause && this.cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${this.cause.stack}`;
    }

    // Ensure non-enumerable properties for clean serialization
    Object.defineProperty(this, 'cause', { enumerable: false });
    Object.defineProperty(this, 'correlation', { enumerable: false });
  }

  // ============================================================================
  // Error Identification
  // ============================================================================

  /**
   * Get error severity
   */
  get severity(): ErrorSeverity {
    return this.context.severity;
  }

  /**
   * Get error priority
   */
  get priority(): ErrorPriority {
    return this.context.priority;
  }

  /**
   * Get error handling strategy
   */
  get strategy(): ErrorHandlingStrategy {
    return this.context.strategy;
  }

  /**
   * Check if this is a specific error code
   */
  public isCode(code: ErrorCode): boolean {
    return this.code === code;
  }

  /**
   * Check if this is a specific error category
   */
  public isCategory(category: ErrorCategory): boolean {
    return this.category === category;
  }

  // ============================================================================
  // Recoverable Interface Implementation
  // ============================================================================

  /**
   * Check if this error is recoverable
   */
  public isRecoverable(): boolean {
    return this.recoveryActions.length > 0;
  }

  /**
   * Get available recovery actions
   */
  public getRecoveryActions(): readonly RecoveryAction[] {
    return this.recoveryActions;
  }

  /**
   * Attempt recovery using specified action
   */
  public async attemptRecovery(actionId: string): Promise<RecoveryResult> {
    const action = this.recoveryActions.find(a => a.id === actionId);
    if (!action) {
      return {
        success: false,
        description: `Recovery action '${actionId}' not found`,
        shouldRetry: false
      };
    }

    if (!action.execute) {
      return {
        success: false,
        description: `Recovery action '${actionId}' has no execution handler`,
        shouldRetry: false
      };
    }

    try {
      return await action.execute();
    } catch (error) {
      return {
        success: false,
        description: `Recovery action '${actionId}' failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error : new Error(String(error)),
        shouldRetry: false
      };
    }
  }

  /**
   * Get default recovery action
   */
  public getDefaultRecoveryAction(): RecoveryAction | null {
    // Prefer automated actions
    const automated = this.recoveryActions.find(a => a.canAutomate);
    if (automated) return automated;

    // Fall back to highest probability action
    return this.recoveryActions.reduce((best, current) => {
      if (!best) return current;
      const bestProb = best.successProbability || 0;
      const currentProb = current.successProbability || 0;
      return currentProb > bestProb ? current : best;
    }, null as RecoveryAction | null);
  }

  // ============================================================================
  // Retryable Interface Implementation
  // ============================================================================

  /**
   * Check if this error is retryable
   */
  public isRetryable(): boolean {
    return this.context.isRetriable;
  }

  /**
   * Get maximum number of retry attempts
   */
  public getMaxRetries(): number {
    return this.context.maxRetries || 3;
  }

  /**
   * Get retry delay for attempt number
   */
  public getRetryDelay(attempt: number): number {
    const config = this.context.retryDelay;
    if (!config) return 1000; // Default 1 second

    return this.getBackoffStrategy().calculateDelay(attempt);
  }

  /**
   * Check if should retry based on attempt history
   */
  public shouldRetry(attempts: number): boolean {
    return this.isRetryable() && attempts < this.getMaxRetries();
  }

  /**
   * Get backoff strategy
   */
  public getBackoffStrategy(): BackoffStrategy {
    const config = this.context.retryDelay;
    if (!config) {
      return new ExponentialBackoffStrategy(1000, 30000, 2, true);
    }

    return new ExponentialBackoffStrategy(
      config.initialDelay,
      config.maxDelay,
      config.backoffMultiplier,
      config.useJitter
    );
  }

  // ============================================================================
  // Context and Metadata
  // ============================================================================

  /**
   * Add metadata to this error
   */
  public addMetadata(metadata: Partial<ErrorMetadata>): this {
    const newContext = {
      ...this.context,
      metadata: {
        ...this.context.metadata,
        ...metadata
      }
    };

    // Create new instance with updated context (errors should be immutable)
    Object.defineProperty(this, 'context', {
      value: newContext,
      writable: false,
      enumerable: true
    });

    return this;
  }

  /**
   * Add recovery action to this error
   */
  public addRecoveryAction(action: RecoveryAction): this {
    this.recoveryActions = [...this.recoveryActions, action];
    return this;
  }

  // ============================================================================
  // Serialization and Display
  // ============================================================================

  /**
   * Convert error to JSON for logging/transmission
   */
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      context: this.context,
      correlation: this.correlation,
      impact: this.impact,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
      cause: this.cause ? {
        name: this.cause.name,
        message: this.cause.message,
        stack: this.cause.stack
      } : undefined
    };
  }

  /**
   * Get user-friendly error message with suggestions
   */
  public getUserMessage(): string {
    let message = this.message;

    if (this.context.recoverySuggestions && this.context.recoverySuggestions.length > 0) {
      message += '\n\nSuggestions:';
      this.context.recoverySuggestions.forEach((suggestion, index) => {
        message += `\n  ${index + 1}. ${suggestion}`;
      });
    }

    if (this.context.documentationLinks && this.context.documentationLinks.length > 0) {
      message += '\n\nDocumentation:';
      this.context.documentationLinks.forEach(link => {
        message += `\n  - ${link}`;
      });
    }

    return message;
  }

  /**
   * Generate unique error ID
   */
  private generateErrorId(): string {
    const timestamp = this.timestamp.getTime();
    const random = Math.random().toString(36).substr(2, 9);
    return `juno_${timestamp}_${random}`;
  }
}

/**
 * Exponential backoff strategy implementation
 */
export class ExponentialBackoffStrategy implements BackoffStrategy {
  constructor(
    private readonly initialDelay: number,
    public readonly maxDelay: number,
    private readonly multiplier: number,
    public readonly useJitter: boolean
  ) {}

  calculateDelay(attempt: number): number {
    const exponential = this.initialDelay * Math.pow(this.multiplier, attempt);
    const delay = Math.min(exponential, this.maxDelay);

    if (this.useJitter) {
      // Add up to 10% jitter to prevent thundering herd
      const jitter = delay * 0.1 * Math.random();
      return Math.floor(delay + jitter);
    }

    return delay;
  }
}

/**
 * Linear backoff strategy implementation
 */
export class LinearBackoffStrategy implements BackoffStrategy {
  constructor(
    private readonly baseDelay: number,
    public readonly maxDelay: number,
    public readonly useJitter: boolean = false
  ) {}

  calculateDelay(attempt: number): number {
    const linear = this.baseDelay * (attempt + 1);
    const delay = Math.min(linear, this.maxDelay);

    if (this.useJitter) {
      const jitter = delay * 0.1 * Math.random();
      return Math.floor(delay + jitter);
    }

    return delay;
  }
}

/**
 * Fixed backoff strategy implementation
 */
export class FixedBackoffStrategy implements BackoffStrategy {
  constructor(
    private readonly fixedDelay: number,
    public readonly maxDelay: number = fixedDelay,
    public readonly useJitter: boolean = false
  ) {}

  calculateDelay(_attempt: number): number {
    if (this.useJitter) {
      const jitter = this.fixedDelay * 0.1 * Math.random();
      return Math.floor(this.fixedDelay + jitter);
    }

    return this.fixedDelay;
  }
}