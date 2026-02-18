/**
 * Error Recovery Framework
 *
 * Provides comprehensive error recovery mechanisms including
 * retry strategies, fallback handling, and recovery orchestration.
 */

import type { JunoTaskError, RecoveryAction, RecoveryResult } from './base';
import type { ErrorCategory, ErrorHandlingStrategy } from './categories';
import type { ErrorCode } from './codes';

/**
 * Recovery strategy configuration
 */
export interface RecoveryStrategy {
  /** Strategy identifier */
  readonly id: string;

  /** Strategy name */
  readonly name: string;

  /** Strategy description */
  readonly description: string;

  /** Error categories this strategy applies to */
  readonly applicableCategories: readonly ErrorCategory[];

  /** Error codes this strategy applies to */
  readonly applicableCodes?: readonly ErrorCode[];

  /** Error handling strategy type */
  readonly handlingStrategy: ErrorHandlingStrategy;

  /** Priority of this strategy (higher = preferred) */
  readonly priority: number;

  /** Whether this strategy can be automated */
  readonly canAutomate: boolean;

  /** Maximum number of attempts */
  readonly maxAttempts: number;

  /** Timeout for recovery attempt in milliseconds */
  readonly timeout?: number;

  /** Prerequisites for using this strategy */
  readonly prerequisites?: readonly string[];

  /** Strategy configuration */
  readonly config?: Record<string, unknown>;
}

/**
 * Recovery context for strategy execution
 */
export interface RecoveryContext {
  /** Error being recovered from */
  readonly error: JunoTaskError;

  /** Previous recovery attempts */
  readonly previousAttempts: readonly RecoveryAttempt[];

  /** Current attempt number */
  readonly attemptNumber: number;

  /** Operation context */
  readonly operationContext?: Record<string, unknown>;

  /** User preferences for recovery */
  readonly userPreferences?: RecoveryPreferences;

  /** Time budget for recovery */
  readonly timeBudget?: number;

  /** Available resources for recovery */
  readonly availableResources?: Record<string, unknown>;
}

/**
 * User preferences for error recovery
 */
export interface RecoveryPreferences {
  /** Whether to attempt automatic recovery */
  readonly allowAutomaticRecovery: boolean;

  /** Whether to ask for user confirmation */
  readonly requireUserConfirmation: boolean;

  /** Maximum time to spend on recovery */
  readonly maxRecoveryTime?: number;

  /** Preferred recovery strategies */
  readonly preferredStrategies?: readonly string[];

  /** Strategies to avoid */
  readonly avoidedStrategies?: readonly string[];
}

/**
 * Record of a recovery attempt
 */
export interface RecoveryAttempt {
  /** Attempt identifier */
  readonly id: string;

  /** Strategy used */
  readonly strategy: RecoveryStrategy;

  /** Recovery action executed */
  readonly action?: RecoveryAction;

  /** Timestamp of attempt */
  readonly timestamp: Date;

  /** Duration of attempt in milliseconds */
  readonly duration: number;

  /** Result of the attempt */
  readonly result: RecoveryResult;

  /** Context during attempt */
  readonly context: Record<string, unknown>;
}

/**
 * Recovery plan containing multiple strategies
 */
export interface RecoveryPlan {
  /** Plan identifier */
  readonly id: string;

  /** Error this plan applies to */
  readonly error: JunoTaskError;

  /** Ordered list of recovery strategies to try */
  readonly strategies: readonly RecoveryStrategy[];

  /** Plan metadata */
  readonly metadata: {
    readonly createdAt: Date;
    readonly estimatedTime: number;
    readonly successProbability: number;
    readonly requiresUserIntervention: boolean;
  };
}

/**
 * Interface for implementing recovery strategies
 */
export interface RecoveryStrategyExecutor {
  /** Execute the recovery strategy */
  execute(context: RecoveryContext): Promise<RecoveryResult>;

  /** Check if strategy can be applied to error */
  canApply(error: JunoTaskError, context: RecoveryContext): boolean;

  /** Estimate success probability for this error */
  estimateSuccessProbability(error: JunoTaskError, context: RecoveryContext): number;

  /** Estimate time required for recovery */
  estimateTime(error: JunoTaskError, context: RecoveryContext): number;
}

/**
 * Central error recovery manager
 */
export class ErrorRecoveryManager {
  private strategies = new Map<string, RecoveryStrategy>();
  private executors = new Map<string, RecoveryStrategyExecutor>();
  private recoveryHistory = new Map<string, readonly RecoveryAttempt[]>();

  /**
   * Register a recovery strategy
   */
  public registerStrategy(strategy: RecoveryStrategy, executor: RecoveryStrategyExecutor): void {
    this.strategies.set(strategy.id, strategy);
    this.executors.set(strategy.id, executor);
  }

  /**
   * Create recovery plan for an error
   */
  public createRecoveryPlan(
    error: JunoTaskError,
    preferences?: RecoveryPreferences
  ): RecoveryPlan {
    const applicableStrategies = this.findApplicableStrategies(error, preferences);
    const sortedStrategies = this.prioritizeStrategies(applicableStrategies, error, preferences);

    const estimatedTime = sortedStrategies.reduce((total, strategy) => {
      const executor = this.executors.get(strategy.id);
      if (executor) {
        return total + executor.estimateTime(error, this.createContext(error));
      }
      return total;
    }, 0);

    const successProbability = this.calculatePlanSuccessProbability(sortedStrategies, error);
    const requiresUserIntervention = sortedStrategies.some(s => !s.canAutomate);

    return {
      id: this.generatePlanId(error),
      error,
      strategies: sortedStrategies,
      metadata: {
        createdAt: new Date(),
        estimatedTime,
        successProbability,
        requiresUserIntervention
      }
    };
  }

  /**
   * Execute recovery plan
   */
  public async executeRecoveryPlan(
    plan: RecoveryPlan,
    preferences?: RecoveryPreferences
  ): Promise<RecoveryResult> {
    const context = this.createContext(plan.error, preferences);
    let lastResult: RecoveryResult = {
      success: false,
      description: 'No recovery strategies available',
      shouldRetry: false
    };

    for (const strategy of plan.strategies) {
      if (context.timeBudget && context.timeBudget <= 0) {
        break;
      }

      const executor = this.executors.get(strategy.id);
      if (!executor || !executor.canApply(plan.error, context)) {
        continue;
      }

      const attempt = await this.executeStrategy(strategy, executor, context);
      this.recordAttempt(plan.error, attempt);

      if (attempt.result.success) {
        return attempt.result;
      }

      lastResult = attempt.result;

      // Update context for next attempt
      context.attemptNumber++;
      if (context.timeBudget) {
        context.timeBudget -= attempt.duration;
      }
    }

    return lastResult;
  }

  /**
   * Get recovery suggestions for an error
   */
  public getRecoverySuggestions(error: JunoTaskError): readonly string[] {
    const suggestions: string[] = [];
    const applicableStrategies = this.findApplicableStrategies(error);

    for (const strategy of applicableStrategies) {
      if (strategy.canAutomate) {
        suggestions.push(`Try ${strategy.name}: ${strategy.description}`);
      } else {
        suggestions.push(`Manual intervention: ${strategy.description}`);
      }
    }

    // Add error-specific suggestions
    if (error.context.recoverySuggestions) {
      suggestions.push(...error.context.recoverySuggestions);
    }

    return suggestions;
  }

  /**
   * Get recovery history for an error
   */
  public getRecoveryHistory(error: JunoTaskError): readonly RecoveryAttempt[] {
    return this.recoveryHistory.get(error.id) || [];
  }

  /**
   * Find applicable strategies for an error
   */
  private findApplicableStrategies(
    error: JunoTaskError,
    preferences?: RecoveryPreferences
  ): readonly RecoveryStrategy[] {
    const strategies: RecoveryStrategy[] = [];

    for (const strategy of this.strategies.values()) {
      // Check category match
      if (!strategy.applicableCategories.includes(error.category)) {
        continue;
      }

      // Check code match if specified
      if (strategy.applicableCodes && !strategy.applicableCodes.includes(error.code)) {
        continue;
      }

      // Check user preferences
      if (preferences?.avoidedStrategies?.includes(strategy.id)) {
        continue;
      }

      if (preferences?.preferredStrategies) {
        if (!preferences.preferredStrategies.includes(strategy.id)) {
          continue;
        }
      }

      // Check automation preference
      if (!preferences?.allowAutomaticRecovery && strategy.canAutomate) {
        continue;
      }

      strategies.push(strategy);
    }

    return strategies;
  }

  /**
   * Prioritize strategies based on success probability and preferences
   */
  private prioritizeStrategies(
    strategies: readonly RecoveryStrategy[],
    error: JunoTaskError,
    preferences?: RecoveryPreferences
  ): readonly RecoveryStrategy[] {
    const context = this.createContext(error, preferences);

    return [...strategies].sort((a, b) => {
      // First, sort by user preference order
      if (preferences?.preferredStrategies) {
        const aIndex = preferences.preferredStrategies.indexOf(a.id);
        const bIndex = preferences.preferredStrategies.indexOf(b.id);

        if (aIndex !== -1 && bIndex !== -1) {
          return aIndex - bIndex;
        }
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
      }

      // Then by strategy priority
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }

      // Then by estimated success probability
      const aExecutor = this.executors.get(a.id);
      const bExecutor = this.executors.get(b.id);

      if (aExecutor && bExecutor) {
        const aProb = aExecutor.estimateSuccessProbability(error, context);
        const bProb = bExecutor.estimateSuccessProbability(error, context);

        if (aProb !== bProb) {
          return bProb - aProb;
        }
      }

      // Finally by estimated time (prefer faster)
      if (aExecutor && bExecutor) {
        const aTime = aExecutor.estimateTime(error, context);
        const bTime = bExecutor.estimateTime(error, context);

        return aTime - bTime;
      }

      return 0;
    });
  }

  /**
   * Calculate overall success probability for a plan
   */
  private calculatePlanSuccessProbability(
    strategies: readonly RecoveryStrategy[],
    error: JunoTaskError
  ): number {
    if (strategies.length === 0) return 0;

    const context = this.createContext(error);
    let combinedFailureProb = 1;

    for (const strategy of strategies) {
      const executor = this.executors.get(strategy.id);
      if (executor) {
        const successProb = executor.estimateSuccessProbability(error, context);
        combinedFailureProb *= (1 - successProb);
      }
    }

    return 1 - combinedFailureProb;
  }

  /**
   * Execute a single recovery strategy
   */
  private async executeStrategy(
    strategy: RecoveryStrategy,
    executor: RecoveryStrategyExecutor,
    context: RecoveryContext
  ): Promise<RecoveryAttempt> {
    const startTime = Date.now();
    const attemptId = this.generateAttemptId();

    try {
      const result = await this.executeWithTimeout(
        () => executor.execute(context),
        strategy.timeout || 30000
      );

      const duration = Date.now() - startTime;

      return {
        id: attemptId,
        strategy,
        timestamp: new Date(startTime),
        duration,
        result,
        context: { ...context.operationContext }
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      return {
        id: attemptId,
        strategy,
        timestamp: new Date(startTime),
        duration,
        result: {
          success: false,
          description: `Strategy execution failed: ${error instanceof Error ? error.message : String(error)}`,
          error: error instanceof Error ? error : new Error(String(error)),
          shouldRetry: false
        },
        context: { ...context.operationContext }
      };
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Recovery strategy timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then(result => {
          clearTimeout(timeout);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  /**
   * Create recovery context
   */
  private createContext(
    error: JunoTaskError,
    preferences?: RecoveryPreferences
  ): RecoveryContext {
    const previousAttempts = this.getRecoveryHistory(error);

    return {
      error,
      previousAttempts,
      attemptNumber: previousAttempts.length + 1,
      userPreferences: preferences,
      timeBudget: preferences?.maxRecoveryTime
    };
  }

  /**
   * Record recovery attempt
   */
  private recordAttempt(error: JunoTaskError, attempt: RecoveryAttempt): void {
    const history = this.recoveryHistory.get(error.id) || [];
    this.recoveryHistory.set(error.id, [...history, attempt]);
  }

  /**
   * Generate unique plan ID
   */
  private generatePlanId(error: JunoTaskError): string {
    return `plan_${error.id}_${Date.now()}`;
  }

  /**
   * Generate unique attempt ID
   */
  private generateAttemptId(): string {
    return `attempt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Export singleton instance
export const errorRecoveryManager = new ErrorRecoveryManager();