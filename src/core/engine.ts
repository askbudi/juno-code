/**
 * Core execution engine module for juno-task-ts
 *
 * This module provides the main execution orchestration engine that manages
 * the entire workflow for AI task execution, including session management,
 * MCP client integration, progress tracking, error handling, and cancellation.
 *
 * The implementation closely matches the Python budi-cli execution patterns,
 * including rate limit handling, iteration logic, and progress tracking.
 *
 * @module core/engine
 * @since 1.0.0
 */

import { EventEmitter } from 'node:events';
import type {
  JunoTaskConfig,
  SubagentType,
  ProgressEventType,
} from '../types/index';
import type {
  MCPClient,
  ProgressEvent,
  ProgressCallback,
  ToolCallRequest,
  ToolCallResult,
  MCPSessionContext,
} from '../mcp/types';
import { runPreflightTests, getPreflightConfig } from '../utils/preflight.js';
import {
  MCPError,
  MCPRateLimitError,
} from '../mcp/errors';
import { executeHook } from '../utils/hooks.js';
import { engineLogger } from '../cli/utils/advanced-logger.js';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Execution request interface for starting task execution
 */
export interface ExecutionRequest {
  /** Unique request identifier */
  readonly requestId: string;

  /** Task instruction or prompt text */
  readonly instruction: string;

  /** Subagent to use for execution */
  readonly subagent: SubagentType;

  /** Working directory for execution */
  readonly workingDirectory: string;

  /** Maximum number of iterations (-1 for unlimited) */
  readonly maxIterations: number;

  /** Optional specific model to use */
  readonly model?: string;

  /** Optional timeout in milliseconds (overrides config) */
  readonly timeoutMs?: number;

  /** Session metadata */
  readonly sessionMetadata?: Record<string, unknown>;

  /** Custom progress callbacks */
  readonly progressCallbacks?: ProgressCallback[];

  /** Request priority level */
  readonly priority?: 'low' | 'normal' | 'high';
}

/**
 * Execution result interface for completed executions
 */
export interface ExecutionResult {
  /** Request that generated this result */
  readonly request: ExecutionRequest;

  /** Execution status */
  readonly status: ExecutionStatus;

  /** Execution start time */
  readonly startTime: Date;

  /** Execution end time */
  readonly endTime: Date;

  /** Total execution duration in milliseconds */
  readonly duration: number;

  /** All iteration results */
  readonly iterations: readonly IterationResult[];

  /** Final execution statistics */
  readonly statistics: ExecutionStatistics;

  /** Any error that terminated execution */
  readonly error?: MCPError;

  /** Session context information */
  readonly sessionContext: MCPSessionContext;

  /** All progress events captured during execution */
  readonly progressEvents: readonly ProgressEvent[];
}

/**
 * Individual iteration result
 */
export interface IterationResult {
  /** Iteration number (1-based) */
  readonly iterationNumber: number;

  /** Iteration success status */
  readonly success: boolean;

  /** Iteration start time */
  readonly startTime: Date;

  /** Iteration end time */
  readonly endTime: Date;

  /** Iteration duration in milliseconds */
  readonly duration: number;

  /** Tool call result */
  readonly toolResult: ToolCallResult;

  /** Iteration-specific progress events */
  readonly progressEvents: readonly ProgressEvent[];

  /** Any error that occurred during iteration */
  readonly error?: MCPError;
}

/**
 * Execution status enumeration
 */
export enum ExecutionStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout',
  RATE_LIMITED = 'rate_limited',
}

/**
 * Execution statistics for performance tracking
 */
export interface ExecutionStatistics {
  /** Total iterations attempted */
  totalIterations: number;

  /** Number of successful iterations */
  successfulIterations: number;

  /** Number of failed iterations */
  failedIterations: number;

  /** Average iteration duration in milliseconds */
  averageIterationDuration: number;

  /** Total tool calls made */
  totalToolCalls: number;

  /** Total progress events processed */
  totalProgressEvents: number;

  /** Rate limit encounters */
  rateLimitEncounters: number;

  /** Total rate limit wait time in milliseconds */
  rateLimitWaitTime: number;

  /** Error breakdown by type */
  errorBreakdown: Record<string, number>;

  /** Performance metrics */
  performanceMetrics: PerformanceMetrics;
}

/**
 * Performance metrics for detailed analysis
 */
export interface PerformanceMetrics {
  /** CPU usage percentage during execution */
  cpuUsage: number;

  /** Memory usage in bytes */
  memoryUsage: number;

  /** Network requests made */
  networkRequests: number;

  /** File system operations */
  fileSystemOperations: number;

  /** Throughput metrics */
  throughput: ThroughputMetrics;
}

/**
 * Throughput metrics
 */
export interface ThroughputMetrics {
  /** Iterations per minute */
  iterationsPerMinute: number;

  /** Progress events per second */
  progressEventsPerSecond: number;

  /** Tool calls per minute */
  toolCallsPerMinute: number;
}

/**
 * Rate limit information for handling
 */
export interface RateLimitInfo {
  /** Whether currently rate limited */
  readonly isRateLimited: boolean;

  /** Rate limit reset time */
  readonly resetTime?: Date;

  /** Remaining requests in current window */
  readonly remaining: number;

  /** Time to wait before next request in milliseconds */
  readonly waitTimeMs: number;

  /** Rate limit tier/category */
  readonly tier?: string;
}

/**
 * Error recovery strategy configuration
 */
export interface ErrorRecoveryConfig {
  /** Maximum recovery attempts per error type */
  readonly maxAttempts: Record<string, number>;

  /** Retry delays by error type in milliseconds */
  readonly retryDelays: Record<string, number>;

  /** Whether to continue on specific error types */
  readonly continueOnError: Record<string, boolean>;

  /** Custom recovery strategies */
  readonly customStrategies: Record<string, (error: MCPError) => Promise<boolean>>;
}

/**
 * Execution engine configuration
 */
export interface ExecutionEngineConfig {
  /** Base configuration */
  readonly config: JunoTaskConfig;

  /** MCP client instance */
  readonly mcpClient: MCPClient;

  /** Error recovery configuration */
  readonly errorRecovery: ErrorRecoveryConfig;

  /** Rate limit handling configuration */
  readonly rateLimitConfig: RateLimitHandlingConfig;

  /** Progress tracking configuration */
  readonly progressConfig: ProgressTrackingConfig;
}

/**
 * Rate limit handling configuration
 */
export interface RateLimitHandlingConfig {
  /** Enable automatic rate limit handling */
  readonly enabled: boolean;

  /** Maximum wait time for rate limits in milliseconds */
  readonly maxWaitTimeMs: number;

  /** Rate limit detection patterns */
  readonly detectionPatterns: readonly RegExp[];

  /** Custom rate limit parsers */
  readonly customParsers: readonly RateLimitParser[];
}

/**
 * Rate limit parser interface
 */
export interface RateLimitParser {
  /** Pattern to match rate limit messages */
  readonly pattern: RegExp;

  /** Parse function to extract reset time */
  readonly parse: (message: string) => Date | null;
}

/**
 * Progress tracking configuration
 */
export interface ProgressTrackingConfig {
  /** Enable progress tracking */
  readonly enabled: boolean;

  /** Buffer size for progress events */
  readonly bufferSize: number;

  /** Progress event filters */
  readonly filters: readonly ProgressEventFilter[];

  /** Custom progress processors */
  readonly processors: readonly ProgressEventProcessor[];
}

/**
 * Progress event filter
 */
export interface ProgressEventFilter {
  /** Filter type */
  readonly type: ProgressEventType | 'custom';

  /** Filter predicate */
  readonly predicate: (event: ProgressEvent) => boolean;
}

/**
 * Progress event processor
 */
export interface ProgressEventProcessor {
  /** Processor name */
  readonly name: string;

  /** Process function */
  readonly process: (event: ProgressEvent) => Promise<void>;
}

// =============================================================================
// Default Configurations
// =============================================================================

/**
 * Default error recovery configuration
 */
export const DEFAULT_ERROR_RECOVERY_CONFIG: ErrorRecoveryConfig = {
  maxAttempts: {
    connection: 3,
    timeout: 2,
    rate_limit: 5,
    tool_execution: 2,
    validation: 1,
    server_not_found: 1,
    protocol: 2,
    authentication: 1,
  },
  retryDelays: {
    connection: 1000,
    timeout: 2000,
    rate_limit: 0, // Wait time determined by rate limit reset
    tool_execution: 1500,
    validation: 0, // No retry for validation errors
    server_not_found: 0, // No retry for server not found
    protocol: 1000,
    authentication: 0, // No retry for auth errors
  },
  continueOnError: {
    connection: true,
    timeout: true,
    rate_limit: true,
    tool_execution: false,
    validation: false,
    server_not_found: false,
    protocol: true,
    authentication: false,
  },
  customStrategies: {},
};

/**
 * Default rate limit handling configuration
 */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitHandlingConfig = {
  enabled: true,
  maxWaitTimeMs: 3600000, // 1 hour
  detectionPatterns: [
    /resets\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
    /resets\s+(\d{1,2})\s*(am|pm)/i,
    /try again in (\d+)\s*(minutes?|hours?)/i,
    /5-hour limit reached.*resets\s+(\d{1,2})\s*(am|pm)/i,
  ],
  customParsers: [],
};

/**
 * Default progress tracking configuration
 */
export const DEFAULT_PROGRESS_CONFIG: ProgressTrackingConfig = {
  enabled: true,
  bufferSize: 10000,
  filters: [],
  processors: [],
};

// =============================================================================
// Main ExecutionEngine Class
// =============================================================================

/**
 * Main execution engine class for orchestrating AI task execution
 *
 * This class manages the complete execution lifecycle including:
 * - Session creation and management
 * - Iteration loop with rate limit handling
 * - Progress tracking and statistics collection
 * - Error handling with recovery strategies
 * - Cancellation and cleanup
 *
 * @example
 * ```typescript
 * const engine = new ExecutionEngine({
 *   config: await loadConfig(),
 *   mcpClient: new MCPClientImpl(mcpConfig),
 *   errorRecovery: DEFAULT_ERROR_RECOVERY_CONFIG,
 *   rateLimitConfig: DEFAULT_RATE_LIMIT_CONFIG,
 *   progressConfig: DEFAULT_PROGRESS_CONFIG,
 * });
 *
 * const request: ExecutionRequest = {
 *   requestId: 'req-123',
 *   instruction: 'Implement a new feature',
 *   subagent: 'claude',
 *   workingDirectory: '/path/to/project',
 *   maxIterations: 10,
 * };
 *
 * const result = await engine.execute(request);
 * ```
 */
export class ExecutionEngine extends EventEmitter {
  private readonly engineConfig: ExecutionEngineConfig;
  private readonly activeExecutions = new Map<string, ExecutionContext>();
  private readonly progressCallbacks: ProgressCallback[] = [];
  private readonly cleanupTasks: (() => Promise<void>)[] = [];
  private isShuttingDown = false;

  /**
   * Create a new ExecutionEngine instance
   *
   * @param config - Engine configuration
   */
  constructor(config: ExecutionEngineConfig) {
    super();
    this.engineConfig = config;
    this.setupErrorHandling();
    this.setupProgressTracking();
  }

  // =============================================================================
  // Public API Methods
  // =============================================================================

  /**
   * Execute a task request with comprehensive orchestration
   *
   * @param request - Execution request parameters
   * @param abortSignal - Optional abort signal for cancellation
   * @returns Promise resolving to execution result
   */
  async execute(
    request: ExecutionRequest,
    abortSignal?: AbortSignal
  ): Promise<ExecutionResult> {
    this.validateRequest(request);

    const context = this.createExecutionContext(request, abortSignal);
    this.activeExecutions.set(request.requestId, context);

    try {
      this.emit('execution:start', { request, context });

      const result = await this.executeInternal(context);

      this.emit('execution:complete', { request, result });
      return result;
    } catch (error) {
      const mcpError = this.wrapError(error);
      this.emit('execution:error', { request, error: mcpError });
      throw mcpError;
    } finally {
      this.activeExecutions.delete(request.requestId);
      await this.cleanupExecution(context);
    }
  }

  /**
   * Add a progress callback for all executions
   *
   * @param callback - Progress callback function
   * @returns Cleanup function to remove the callback
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.push(callback);
    return () => {
      const index = this.progressCallbacks.indexOf(callback);
      if (index !== -1) {
        this.progressCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Get current rate limit information
   *
   * @returns Current rate limit status
   */
  async getRateLimitInfo(): Promise<RateLimitInfo> {
    // Implementation would query MCP client for rate limit status
    return {
      isRateLimited: false,
      remaining: 100,
      resetTime: new Date(Date.now() + 60000), // 1 minute from now
      waitTimeMs: 0,
    };
  }

  /**
   * Cancel all active executions and shutdown gracefully
   *
   * @param timeoutMs - Maximum time to wait for cleanup
   */
  async shutdown(timeoutMs: number = 30000): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.emit('engine:shutdown:start');

    try {
      // Cancel all active executions
      const cancellationPromises = Array.from(this.activeExecutions.values()).map(
        context => this.cancelExecution(context)
      );

      // Wait for cancellations with timeout
      await Promise.race([
        Promise.all(cancellationPromises),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Shutdown timeout')), timeoutMs)
        ),
      ]);

      // Run cleanup tasks
      await Promise.all(this.cleanupTasks.map(task => task()));

      this.emit('engine:shutdown:complete');
    } catch (error) {
      this.emit('engine:shutdown:error', error);
      throw error;
    } finally {
      this.removeAllListeners();
    }
  }

  /**
   * Get statistics for all executions
   *
   * @returns Aggregate execution statistics
   */
  getExecutionStatistics(): ExecutionStatistics {
    const contexts = Array.from(this.activeExecutions.values());

    return {
      totalIterations: contexts.reduce((sum, ctx) => sum + ctx.statistics.totalIterations, 0),
      successfulIterations: contexts.reduce((sum, ctx) => sum + ctx.statistics.successfulIterations, 0),
      failedIterations: contexts.reduce((sum, ctx) => sum + ctx.statistics.failedIterations, 0),
      averageIterationDuration: this.calculateAverageIterationDuration(contexts),
      totalToolCalls: contexts.reduce((sum, ctx) => sum + ctx.statistics.totalToolCalls, 0),
      totalProgressEvents: contexts.reduce((sum, ctx) => sum + ctx.statistics.totalProgressEvents, 0),
      rateLimitEncounters: contexts.reduce((sum, ctx) => sum + ctx.statistics.rateLimitEncounters, 0),
      rateLimitWaitTime: contexts.reduce((sum, ctx) => sum + ctx.statistics.rateLimitWaitTime, 0),
      errorBreakdown: this.aggregateErrorBreakdown(contexts),
      performanceMetrics: this.calculatePerformanceMetrics(contexts),
    };
  }

  // =============================================================================
  // Private Implementation Methods
  // =============================================================================

  /**
   * Setup error handling for the engine
   */
  private setupErrorHandling(): void {
    this.engineConfig.mcpClient.on('connection:error', (error: Error) => {
      this.emit('engine:error', error);
    });

    process.on('uncaughtException', (error) => {
      this.emit('engine:uncaught-exception', error);
    });

    process.on('unhandledRejection', (reason) => {
      this.emit('engine:unhandled-rejection', reason);
    });
  }

  /**
   * Setup progress tracking for the engine
   */
  private setupProgressTracking(): void {
    this.engineConfig.mcpClient.onProgress(async (event: ProgressEvent) => {
      try {
        // Process through configured processors
        for (const processor of this.engineConfig.progressConfig.processors) {
          await processor.process(event);
        }

        // Notify all registered callbacks
        await Promise.all([
          ...this.progressCallbacks.map(callback => callback(event)),
        ]);

        this.emit('progress:event', event);
      } catch (error) {
        this.emit('progress:error', { event, error });
      }
    });
  }

  /**
   * Validate execution request parameters
   */
  private validateRequest(request: ExecutionRequest): void {
    if (!request.requestId?.trim()) {
      throw new Error('Request ID is required');
    }

    if (!request.instruction?.trim()) {
      throw new Error('Instruction is required');
    }

    if (!request.subagent?.trim()) {
      throw new Error('Subagent is required');
    }

    if (!request.workingDirectory?.trim()) {
      throw new Error('Working directory is required');
    }

    if (request.maxIterations < -1 || request.maxIterations === 0) {
      throw new Error('Max iterations must be positive or -1 for unlimited');
    }
  }

  /**
   * Create execution context for a request
   */
  private createExecutionContext(
    request: ExecutionRequest,
    abortSignal?: AbortSignal
  ): ExecutionContext {
    const abortController = new AbortController();

    // Chain external abort signal if provided
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        abortController.abort();
      });
    }

    return {
      request,
      status: ExecutionStatus.PENDING,
      startTime: new Date(),
      endTime: null,
      iterations: [],
      statistics: this.createInitialStatistics(),
      progressEvents: [],
      error: null,
      abortController,
      sessionContext: this.createSessionContext(request),
      rateLimitInfo: {
        isRateLimited: false,
        remaining: 100,
        waitTimeMs: 0,
      },
    };
  }

  /**
   * Create initial statistics object
   */
  private createInitialStatistics(): ExecutionStatistics {
    return {
      totalIterations: 0,
      successfulIterations: 0,
      failedIterations: 0,
      averageIterationDuration: 0,
      totalToolCalls: 0,
      totalProgressEvents: 0,
      rateLimitEncounters: 0,
      rateLimitWaitTime: 0,
      errorBreakdown: {},
      performanceMetrics: {
        cpuUsage: 0,
        memoryUsage: 0,
        networkRequests: 0,
        fileSystemOperations: 0,
        throughput: {
          iterationsPerMinute: 0,
          progressEventsPerSecond: 0,
          toolCallsPerMinute: 0,
        },
      },
    };
  }

  /**
   * Create session context for execution
   */
  private createSessionContext(request: ExecutionRequest): MCPSessionContext {
    return {
      sessionId: `session-${request.requestId}`,
      startTime: new Date(),
      userId: 'system',
      metadata: {
        ...request.sessionMetadata,
        subagent: request.subagent,
        workingDirectory: request.workingDirectory,
      },
      activeToolCalls: [],
      state: 'initializing' as any,
      lastActivity: new Date(),
    };
  }

  /**
   * Internal execution implementation
   */
  private async executeInternal(context: ExecutionContext): Promise<ExecutionResult> {
    context.status = ExecutionStatus.RUNNING;
    context.sessionContext = { ...context.sessionContext, state: 'active' as any };

    // Execute START_RUN hook
    try {
      if (this.engineConfig.config.hooks) {
        await executeHook('START_RUN', this.engineConfig.config.hooks, {
          workingDirectory: context.request.workingDirectory,
          sessionId: context.sessionContext.sessionId,
          runId: context.request.requestId,
          metadata: {
            sessionId: context.sessionContext.sessionId,
            requestId: context.request.requestId,
            subagent: context.request.subagent,
            maxIterations: context.request.maxIterations,
            instruction: context.request.instruction,
          }
        });
      }
    } catch (error) {
      engineLogger.warn('Hook START_RUN failed', { error });
      // Continue execution despite hook failure
    }

    try {
      await this.runIterationLoop(context);

      context.status = ExecutionStatus.COMPLETED;
      context.sessionContext = { ...context.sessionContext, state: 'completed' as any };
    } catch (error) {
      context.error = this.wrapError(error);
      context.status = this.determineErrorStatus(context.error);
      context.sessionContext = { ...context.sessionContext, state: 'failed' as any };
    } finally {
      context.endTime = new Date();
    }

    // Execute END_RUN hook
    try {
      if (this.engineConfig.config.hooks) {
        await executeHook('END_RUN', this.engineConfig.config.hooks, {
          workingDirectory: context.request.workingDirectory,
          sessionId: context.sessionContext.sessionId,
          runId: context.request.requestId,
          metadata: {
            sessionId: context.sessionContext.sessionId,
            requestId: context.request.requestId,
            status: context.status,
            totalIterations: context.statistics.totalIterations,
            successfulIterations: context.statistics.successfulIterations,
            failedIterations: context.statistics.failedIterations,
            duration: context.endTime ? context.endTime.getTime() - context.startTime.getTime() : 0,
            success: context.status === ExecutionStatus.COMPLETED,
          }
        });
      }
    } catch (error) {
      engineLogger.warn('Hook END_RUN failed', { error });
      // Continue execution despite hook failure
    }

    return this.createExecutionResult(context);
  }

  /**
   * Run the main iteration loop
   */
  private async runIterationLoop(context: ExecutionContext): Promise<void> {
    let iterationNumber = 1;

    while (!this.shouldStopIterating(context, iterationNumber)) {
      this.checkAbortSignal(context);

      try {
        await this.executeIteration(context, iterationNumber);
        iterationNumber++;
      } catch (error) {
        if (error instanceof MCPRateLimitError) {
          await this.handleRateLimit(context, error);
          // Don't increment iteration number, retry same iteration
          continue;
        }

        const shouldContinue = await this.handleIterationError(context, error, iterationNumber);
        if (!shouldContinue) {
          throw error;
        }

        iterationNumber++;
      }

      // Brief delay between iterations
      await this.sleep(2000);
    }
  }

  /**
   * Execute a single iteration
   */
  private async executeIteration(context: ExecutionContext, iterationNumber: number): Promise<void> {
    const iterationStart = new Date();

    // Execute START_ITERATION hook
    try {
      if (this.engineConfig.config.hooks) {
        await executeHook('START_ITERATION', this.engineConfig.config.hooks, {
          workingDirectory: context.request.workingDirectory,
          sessionId: context.sessionContext.sessionId,
          runId: context.request.requestId,
          iteration: iterationNumber,
          totalIterations: context.request.maxIterations,
          metadata: {
            sessionId: context.sessionContext.sessionId,
            requestId: context.request.requestId,
            iterationNumber,
            maxIterations: context.request.maxIterations,
            subagent: context.request.subagent,
          }
        });
      }
    } catch (error) {
      engineLogger.warn('Hook START_ITERATION failed', { error, iterationNumber });
      // Continue execution despite hook failure
    }

    // Run preflight tests before each iteration to detect large files during execution
    const preflightConfig = getPreflightConfig(context.request.workingDirectory, context.request.subagent);
    const preflightResult = await runPreflightTests(preflightConfig);
    if (preflightResult.triggered) {
      // Emit preflight test results for progress tracking
      this.emit('progress', {
        toolName: 'preflight',
        progress: 100,
        message: `Completed ${preflightResult.actions.length} preflight action(s)`,
        timestamp: new Date(),
        data: preflightResult
      });
    }

    this.emit('iteration:start', { context, iterationNumber });

    const toolRequest: ToolCallRequest = {
        toolName: this.getToolNameForSubagent(context.request.subagent),
        arguments: {
          instruction: context.request.instruction,
          project_path: context.request.workingDirectory,
          ...(context.request.model !== undefined && { model: context.request.model }),
          iteration: iterationNumber,
        },
        timeout: context.request.timeoutMs || this.engineConfig.config.mcpTimeout,
        priority: context.request.priority || 'normal',
        metadata: {
          sessionId: context.sessionContext.sessionId,
          iterationNumber,
        },
        progressCallback: async (event: ProgressEvent) => {
          context.progressEvents.push(event);
          context.statistics.totalProgressEvents++;
          await this.processProgressEvent(context, event);
        },
      };

    try {
      const toolResult = await this.engineConfig.mcpClient.callTool(toolRequest);

      const iterationEnd = new Date();
      const duration = iterationEnd.getTime() - iterationStart.getTime();

      const iterationResult: IterationResult = {
        iterationNumber,
        success: toolResult.status?.toLowerCase() === 'completed',
        startTime: iterationStart,
        endTime: iterationEnd,
        duration,
        toolResult,
        progressEvents: toolResult.progressEvents,
        ...(toolResult.error !== undefined && toolResult.error !== null && { error: toolResult.error }),
      };

      context.iterations.push(iterationResult);
      this.updateStatistics(context, iterationResult);

      this.emit('iteration:complete', { context, iterationResult });

      // Execute END_ITERATION hook for successful iteration
      try {
        if (this.engineConfig.config.hooks) {
          await executeHook('END_ITERATION', this.engineConfig.config.hooks, {
            workingDirectory: context.request.workingDirectory,
            sessionId: context.sessionContext.sessionId,
            runId: context.request.requestId,
            iteration: iterationNumber,
            totalIterations: context.request.maxIterations,
            metadata: {
              sessionId: context.sessionContext.sessionId,
              requestId: context.request.requestId,
              iterationNumber,
              success: iterationResult.success,
              duration: iterationResult.duration,
              toolCallStatus: iterationResult.toolResult.status,
            }
          });
        }
      } catch (error) {
        engineLogger.warn('Hook END_ITERATION failed', { error, iterationNumber });
        // Continue execution despite hook failure
      }
    } catch (error) {
      const iterationEnd = new Date();
      const duration = iterationEnd.getTime() - iterationStart.getTime();
      const mcpError = this.wrapError(error);

      const iterationResult: IterationResult = {
        iterationNumber,
        success: false,
        startTime: iterationStart,
        endTime: iterationEnd,
        duration,
        toolResult: {
          content: '',
          status: 'failed' as any,
          startTime: iterationStart,
          endTime: iterationEnd,
          duration,
          error: mcpError,
          progressEvents: [],
          request: toolRequest,
        },
        progressEvents: [],
        error: mcpError,
      };

      context.iterations.push(iterationResult);
      this.updateStatistics(context, iterationResult);

      this.emit('iteration:error', { context, iterationResult });

      // Execute END_ITERATION hook for failed iteration
      try {
        if (this.engineConfig.config.hooks) {
          await executeHook('END_ITERATION', this.engineConfig.config.hooks, {
            workingDirectory: context.request.workingDirectory,
            sessionId: context.sessionContext.sessionId,
            runId: context.request.requestId,
            iteration: iterationNumber,
            totalIterations: context.request.maxIterations,
            metadata: {
              sessionId: context.sessionContext.sessionId,
              requestId: context.request.requestId,
              iterationNumber,
              success: false,
              duration: iterationResult.duration,
              error: mcpError.message,
              errorType: mcpError.type,
            }
          });
        }
      } catch (hookError) {
        engineLogger.warn('Hook END_ITERATION failed', { error: hookError, iterationNumber });
        // Continue execution despite hook failure
      }

      throw error;
    }
  }

  /**
   * Handle rate limit errors with automatic retry
   */
  private async handleRateLimit(context: ExecutionContext, error: MCPRateLimitError): Promise<void> {
    if (!this.engineConfig.rateLimitConfig.enabled) {
      throw error;
    }

    context.statistics.rateLimitEncounters++;

    const waitTimeMs = this.calculateRateLimitWaitTime(error);
    if (waitTimeMs > this.engineConfig.rateLimitConfig.maxWaitTimeMs) {
      throw new Error(`Rate limit wait time (${waitTimeMs}ms) exceeds maximum allowed (${this.engineConfig.rateLimitConfig.maxWaitTimeMs}ms)`);
    }

    context.statistics.rateLimitWaitTime += waitTimeMs;
    context.rateLimitInfo = {
      isRateLimited: true,
      ...(error.resetTime !== undefined && { resetTime: error.resetTime }),
      remaining: error.remaining || 0,
      waitTimeMs,
      ...(error.tier !== undefined && { tier: error.tier }),
    };

    this.emit('rate-limit:start', { context, error, waitTimeMs });

    await this.sleep(waitTimeMs);

    context.rateLimitInfo = {
      isRateLimited: false,
      remaining: 100,
      waitTimeMs: 0,
    };

    this.emit('rate-limit:end', { context });
  }

  /**
   * Calculate wait time for rate limit reset
   */
  private calculateRateLimitWaitTime(error: MCPRateLimitError): number {
    if (error.resetTime) {
      const now = new Date();
      const waitTime = error.resetTime.getTime() - now.getTime();
      return Math.max(0, waitTime);
    }

    // Default wait time if no reset time provided
    return 60000; // 1 minute
  }

  /**
   * Handle iteration errors with recovery strategies
   */
  private async handleIterationError(
    context: ExecutionContext,
    error: unknown,
    iterationNumber: number
  ): Promise<boolean> {
    const mcpError = this.wrapError(error);
    const errorType = mcpError.type;

    context.statistics.errorBreakdown[errorType] = (context.statistics.errorBreakdown[errorType] || 0) + 1;

    // Check if we should continue on this error type
    const shouldContinue = this.engineConfig.errorRecovery.continueOnError[errorType] ?? false;
    if (!shouldContinue) {
      return false;
    }

    // Attempt recovery if strategy exists
    const customStrategy = this.engineConfig.errorRecovery.customStrategies[errorType];
    if (customStrategy) {
      try {
        const recovered = await customStrategy(mcpError);
        if (recovered) {
          this.emit('error:recovered', { context, error: mcpError, iterationNumber });
          return true;
        }
      } catch (recoveryError) {
        this.emit('error:recovery-failed', { context, error: mcpError, recoveryError, iterationNumber });
      }
    }

    // Apply retry delay if configured
    const retryDelay = this.engineConfig.errorRecovery.retryDelays[errorType] || 0;
    if (retryDelay > 0) {
      await this.sleep(retryDelay);
    }

    this.emit('error:continuing', { context, error: mcpError, iterationNumber });
    return true;
  }

  /**
   * Process individual progress events
   */
  private async processProgressEvent(context: ExecutionContext, event: ProgressEvent): Promise<void> {
    // Apply filters
    for (const filter of this.engineConfig.progressConfig.filters) {
      if (!filter.predicate(event)) {
        return;
      }
    }

    // Update session activity
    context.sessionContext = {
      ...context.sessionContext,
      lastActivity: new Date(),
    };

    this.emit('progress:processed', { context, event });
  }

  /**
   * Update execution statistics
   */
  private updateStatistics(context: ExecutionContext, iteration: IterationResult): void {
    const stats = context.statistics;

    stats.totalIterations++;
    stats.totalToolCalls++;

    if (iteration.success) {
      stats.successfulIterations++;
    } else {
      stats.failedIterations++;
    }

    // Update average iteration duration
    const totalDuration = stats.averageIterationDuration * (stats.totalIterations - 1) + iteration.duration;
    stats.averageIterationDuration = totalDuration / stats.totalIterations;

    // Update performance metrics
    this.updatePerformanceMetrics(context);
  }

  /**
   * Update performance metrics
   */
  private updatePerformanceMetrics(context: ExecutionContext): void {
    const metrics = context.statistics.performanceMetrics;

    // Get current resource usage
    const memUsage = process.memoryUsage();
    metrics.memoryUsage = memUsage.heapUsed;

    // Calculate throughput
    const duration = Date.now() - context.startTime.getTime();
    const durationMinutes = duration / (1000 * 60);

    if (durationMinutes > 0) {
      metrics.throughput.iterationsPerMinute = context.statistics.totalIterations / durationMinutes;
      metrics.throughput.toolCallsPerMinute = context.statistics.totalToolCalls / durationMinutes;
      metrics.throughput.progressEventsPerSecond = context.statistics.totalProgressEvents / (duration / 1000);
    }
  }

  /**
   * Check if iteration loop should stop
   */
  private shouldStopIterating(context: ExecutionContext, iterationNumber: number): boolean {
    // Check abort signal
    if (context.abortController.signal.aborted) {
      return true;
    }

    // Check max iterations
    if (context.request.maxIterations !== -1 && iterationNumber > context.request.maxIterations) {
      return true;
    }

    // Check for shutdown
    if (this.isShuttingDown) {
      return true;
    }

    return false;
  }

  /**
   * Check abort signal and throw if aborted
   */
  private checkAbortSignal(context: ExecutionContext): void {
    if (context.abortController.signal.aborted) {
      throw new Error('Execution aborted');
    }
  }

  /**
   * Get tool name for subagent
   */
  private getToolNameForSubagent(subagent: SubagentType): string {
    const mapping: Record<SubagentType, string> = {
      claude: 'claude_subagent',
      cursor: 'cursor_subagent',
      codex: 'codex_subagent',
      gemini: 'gemini_subagent',
    };

    return mapping[subagent] || 'claude_subagent';
  }

  /**
   * Wrap unknown errors as MCP errors
   */
  private wrapError(error: unknown): MCPError {
    if (error instanceof MCPError) {
      return error;
    }

    // Classify common transport/socket failures as connection errors so the loop can continue
    const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const lower = msg.toLowerCase();
    const isConnectionLike = [
      'epipe',
      'broken pipe',
      'econnreset',
      'socket hang up',
      'err_socket_closed',
      'connection reset by peer',
    ].some(token => lower.includes(token));

    if (isConnectionLike) {
      return {
        type: 'connection',
        message: msg,
        timestamp: new Date(),
        code: 'MCP_CONNECTION_LOST' as any,
      } as any;
    }

    // Fallback: treat as tool execution error
    return {
      type: 'tool_execution',
      message: msg,
      timestamp: new Date(),
    } as any;
  }

  /**
   * Determine execution status from error
   */
  private determineErrorStatus(error: MCPError): ExecutionStatus {
    switch (error.type) {
      case 'rate_limit':
        return ExecutionStatus.RATE_LIMITED;
      case 'timeout':
        return ExecutionStatus.TIMEOUT;
      default:
        return ExecutionStatus.FAILED;
    }
  }

  /**
   * Create final execution result
   */
  private createExecutionResult(context: ExecutionContext): ExecutionResult {
    const endTime = context.endTime || new Date();
    return {
      request: context.request,
      status: context.status,
      startTime: context.startTime,
      endTime,
      duration: endTime.getTime() - context.startTime.getTime(),
      iterations: context.iterations,
      statistics: context.statistics,
      ...(context.error !== undefined && context.error !== null && { error: context.error }),
      sessionContext: context.sessionContext,
      progressEvents: context.progressEvents,
    };
  }

  /**
   * Cancel an execution
   */
  private async cancelExecution(context: ExecutionContext): Promise<void> {
    context.abortController.abort();
    context.status = ExecutionStatus.CANCELLED;
    this.emit('execution:cancelled', { context });
  }

  /**
   * Cleanup execution resources
   */
  private async cleanupExecution(context: ExecutionContext): Promise<void> {
    // Cleanup would happen here
    this.emit('execution:cleanup', { context });
  }

  /**
   * Calculate average iteration duration across contexts
   */
  private calculateAverageIterationDuration(contexts: ExecutionContext[]): number {
    if (contexts.length === 0) return 0;

    const totalDuration = contexts.reduce((sum, ctx) =>
      sum + ctx.statistics.averageIterationDuration * ctx.statistics.totalIterations, 0
    );
    const totalIterations = contexts.reduce((sum, ctx) => sum + ctx.statistics.totalIterations, 0);

    return totalIterations > 0 ? totalDuration / totalIterations : 0;
  }

  /**
   * Aggregate error breakdown across contexts
   */
  private aggregateErrorBreakdown(contexts: ExecutionContext[]): Record<string, number> {
    const breakdown: Record<string, number> = {};

    for (const context of contexts) {
      for (const [errorType, count] of Object.entries(context.statistics.errorBreakdown)) {
        breakdown[errorType] = (breakdown[errorType] || 0) + count;
      }
    }

    return breakdown;
  }

  /**
   * Calculate performance metrics across contexts
   */
  private calculatePerformanceMetrics(contexts: ExecutionContext[]): PerformanceMetrics {
    if (contexts.length === 0) {
      return {
        cpuUsage: 0,
        memoryUsage: 0,
        networkRequests: 0,
        fileSystemOperations: 0,
        throughput: {
          iterationsPerMinute: 0,
          progressEventsPerSecond: 0,
          toolCallsPerMinute: 0,
        },
      };
    }

    // Aggregate metrics from all contexts
    const avgMetrics = contexts.reduce((acc, ctx) => ({
      cpuUsage: acc.cpuUsage + ctx.statistics.performanceMetrics.cpuUsage,
      memoryUsage: acc.memoryUsage + ctx.statistics.performanceMetrics.memoryUsage,
      networkRequests: acc.networkRequests + ctx.statistics.performanceMetrics.networkRequests,
      fileSystemOperations: acc.fileSystemOperations + ctx.statistics.performanceMetrics.fileSystemOperations,
      throughput: {
        iterationsPerMinute: acc.throughput.iterationsPerMinute + ctx.statistics.performanceMetrics.throughput.iterationsPerMinute,
        progressEventsPerSecond: acc.throughput.progressEventsPerSecond + ctx.statistics.performanceMetrics.throughput.progressEventsPerSecond,
        toolCallsPerMinute: acc.throughput.toolCallsPerMinute + ctx.statistics.performanceMetrics.throughput.toolCallsPerMinute,
      },
    }), {
      cpuUsage: 0,
      memoryUsage: 0,
      networkRequests: 0,
      fileSystemOperations: 0,
      throughput: {
        iterationsPerMinute: 0,
        progressEventsPerSecond: 0,
        toolCallsPerMinute: 0,
      },
    });

    // Average the metrics
    const count = contexts.length;
    return {
      cpuUsage: avgMetrics.cpuUsage / count,
      memoryUsage: avgMetrics.memoryUsage / count,
      networkRequests: avgMetrics.networkRequests / count,
      fileSystemOperations: avgMetrics.fileSystemOperations / count,
      throughput: {
        iterationsPerMinute: avgMetrics.throughput.iterationsPerMinute / count,
        progressEventsPerSecond: avgMetrics.throughput.progressEventsPerSecond / count,
        toolCallsPerMinute: avgMetrics.throughput.toolCallsPerMinute / count,
      },
    };
  }

  /**
   * Sleep utility for delays
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal execution context
 */
interface ExecutionContext {
  request: ExecutionRequest;
  status: ExecutionStatus;
  startTime: Date;
  endTime: Date | null;
  iterations: IterationResult[];
  statistics: ExecutionStatistics;
  progressEvents: ProgressEvent[];
  error: MCPError | null;
  abortController: AbortController;
  sessionContext: MCPSessionContext;
  rateLimitInfo: RateLimitInfo;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an execution engine with default configuration
 *
 * @param config - Base juno-task configuration
 * @param mcpClient - MCP client instance
 * @returns Configured execution engine
 */
export function createExecutionEngine(
  config: JunoTaskConfig,
  mcpClient: MCPClient
): ExecutionEngine {
  return new ExecutionEngine({
    config,
    mcpClient,
    errorRecovery: DEFAULT_ERROR_RECOVERY_CONFIG,
    rateLimitConfig: DEFAULT_RATE_LIMIT_CONFIG,
    progressConfig: DEFAULT_PROGRESS_CONFIG,
  });
}

/**
 * Create an execution request with defaults
 *
 * @param options - Request options
 * @returns Execution request
 */
export function createExecutionRequest(options: {
  instruction: string;
  subagent?: SubagentType;
  workingDirectory?: string;
  maxIterations?: number;
  model?: string;
  requestId?: string;
}): ExecutionRequest {
  const result: ExecutionRequest = {
    requestId: options.requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    instruction: options.instruction,
    subagent: options.subagent || 'claude',
    workingDirectory: options.workingDirectory || process.cwd(),
    maxIterations: options.maxIterations || 50,
  };

  if (options.model !== undefined) {
    (result as any).model = options.model;
  }

  return result;
}
