/**
 * Core metrics and analytics module for juno-task-ts
 *
 * Provides comprehensive metrics collection, performance tracking, statistics
 * calculation, and analytics reporting for AI subagent execution sessions.
 * Supports real-time monitoring, historical analysis, and performance optimization.
 *
 * @module core/metrics
 * @version 1.0.0
 */

import { EventEmitter } from 'node:events';
import { cpus, totalmem, freemem } from 'node:os';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type {
  JunoTaskConfig,
  SessionStatus,
  SubagentType,
  LogLevel,
} from '../types/index';

/**
 * Performance timing information for operations
 */
export interface PerformanceTiming {
  /** Operation start timestamp (high-resolution) */
  startTime: number;
  /** Operation end timestamp (high-resolution) */
  endTime: number;
  /** Operation duration in milliseconds */
  duration: number;
  /** Memory usage before operation (bytes) */
  memoryBefore: number;
  /** Memory usage after operation (bytes) */
  memoryAfter: number;
  /** Memory delta during operation (bytes) */
  memoryDelta: number;
}

/**
 * Tool call execution metrics
 */
export interface ToolCallMetrics {
  /** Tool name */
  name: string;
  /** Unique call identifier */
  callId: string;
  /** Call timestamp */
  timestamp: Date;
  /** Execution duration in milliseconds */
  duration: number;
  /** Whether the call was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Tool parameters (sanitized) */
  parameters?: Record<string, any>;
  /** Tool result preview */
  resultPreview?: string;
  /** Associated session ID */
  sessionId: string;
  /** Associated iteration number */
  iteration: number;
  /** Subagent that made the call */
  subagent: SubagentType;
  /** Network latency if applicable (ms) */
  networkLatency?: number;
  /** Rate limit information */
  rateLimitInfo?: {
    remaining: number;
    resetTime: Date;
    waitTime?: number;
  };
}

/**
 * Session execution metrics
 */
export interface SessionMetrics {
  /** Session identifier */
  sessionId: string;
  /** Session start timestamp */
  startTime: Date;
  /** Session end timestamp */
  endTime?: Date;
  /** Total session duration in milliseconds */
  duration: number;
  /** Current session status */
  status: SessionStatus;
  /** Number of iterations completed */
  iterations: number;
  /** Total number of tool calls */
  toolCalls: number;
  /** Number of successful operations */
  successCount: number;
  /** Number of failed operations */
  errorCount: number;
  /** Number of warnings */
  warningCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average iteration duration (ms) */
  avgIterationDuration: number;
  /** Average tool call duration (ms) */
  avgToolCallDuration: number;
  /** Total thinking/processing time (ms) */
  totalThinkingTime: number;
  /** Peak memory usage (bytes) */
  peakMemoryUsage: number;
  /** Average memory usage (bytes) */
  avgMemoryUsage: number;
  /** Current memory usage (bytes) */
  currentMemoryUsage: number;
  /** Subagent used */
  subagent: SubagentType;
  /** Model used */
  model?: string;
  /** Working directory */
  workingDirectory: string;
}

/**
 * System performance metrics
 */
export interface SystemMetrics {
  /** Timestamp when metrics were captured */
  timestamp: Date;
  /** Application startup time (ms) */
  startupTime: number;
  /** Configuration loading time (ms) */
  configLoadTime: number;
  /** Template generation time (ms) */
  templateGenerationTime: number;
  /** CLI command response time (ms) */
  cliResponseTime: number;
  /** CPU usage percentage (0-100) */
  cpuUsage: number;
  /** Memory usage information */
  memoryUsage: {
    total: number;
    free: number;
    used: number;
    percentage: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  /** Network metrics */
  networkMetrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    avgResponseTime: number;
    totalBytesTransferred: number;
  };
  /** File system metrics */
  fileSystemMetrics: {
    totalOperations: number;
    readOperations: number;
    writeOperations: number;
    avgOperationTime: number;
  };
}

/**
 * Tool call statistics aggregated over time
 */
export interface ToolCallStatistics {
  /** Tool name */
  name: string;
  /** Total number of calls */
  totalCalls: number;
  /** Number of successful calls */
  successfulCalls: number;
  /** Number of failed calls */
  failedCalls: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Minimum execution time (ms) */
  minDuration: number;
  /** Maximum execution time (ms) */
  maxDuration: number;
  /** Average execution time (ms) */
  avgDuration: number;
  /** 95th percentile execution time (ms) */
  p95Duration: number;
  /** 99th percentile execution time (ms) */
  p99Duration: number;
  /** Total execution time (ms) */
  totalDuration: number;
  /** First call timestamp */
  firstCall: Date;
  /** Last call timestamp */
  lastCall: Date;
  /** Most common error messages */
  commonErrors: Array<{ error: string; count: number }>;
  /** Usage patterns over time */
  usagePattern: Array<{ hour: number; calls: number }>;
}

/**
 * Performance optimization recommendations
 */
export interface PerformanceRecommendation {
  /** Recommendation ID */
  id: string;
  /** Recommendation type */
  type: 'performance' | 'reliability' | 'efficiency' | 'cost';
  /** Severity level */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Title of the recommendation */
  title: string;
  /** Detailed description */
  description: string;
  /** Potential impact */
  impact: string;
  /** Suggested action */
  action: string;
  /** Metrics that triggered this recommendation */
  triggeringMetrics: Record<string, number>;
  /** Timestamp when recommendation was generated */
  timestamp: Date;
}

/**
 * Analytics report containing comprehensive insights
 */
export interface AnalyticsReport {
  /** Report generation timestamp */
  timestamp: Date;
  /** Time range covered by the report */
  timeRange: {
    start: Date;
    end: Date;
  };
  /** Overall summary statistics */
  summary: {
    totalSessions: number;
    totalIterations: number;
    totalToolCalls: number;
    avgSessionDuration: number;
    overallSuccessRate: number;
    totalErrors: number;
  };
  /** Tool usage statistics */
  toolStatistics: Record<string, ToolCallStatistics>;
  /** Session statistics by subagent */
  sessionStatsBySubagent: Record<SubagentType, {
    count: number;
    avgDuration: number;
    successRate: number;
    avgIterations: number;
  }>;
  /** Performance trends */
  performanceTrends: {
    iterationDurationTrend: Array<{ timestamp: Date; avgDuration: number }>;
    successRateTrend: Array<{ timestamp: Date; successRate: number }>;
    errorRateTrend: Array<{ timestamp: Date; errorRate: number }>;
  };
  /** System performance metrics */
  systemPerformance: SystemMetrics;
  /** Performance recommendations */
  recommendations: PerformanceRecommendation[];
  /** Resource usage patterns */
  resourceUsage: {
    peakMemory: number;
    avgMemory: number;
    cpuUtilization: number;
    networkUtilization: number;
  };
}

/**
 * Metrics export format options
 */
export type MetricsExportFormat = 'json' | 'csv' | 'yaml';

/**
 * Metrics export options
 */
export interface MetricsExportOptions {
  /** Export format */
  format: MetricsExportFormat;
  /** Output file path */
  outputPath: string;
  /** Time range to export */
  timeRange?: {
    start: Date;
    end: Date;
  };
  /** Include raw tool call data */
  includeRawData?: boolean;
  /** Include system metrics */
  includeSystemMetrics?: boolean;
  /** Compress output */
  compress?: boolean;
}

/**
 * Performance tracker for monitoring execution performance
 */
export class PerformanceTracker {
  private activeTimings: Map<string, PerformanceTiming> = new Map();
  private completedTimings: PerformanceTiming[] = [];
  private observer: PerformanceObserver;

  constructor() {
    // Set up performance observer for automatic timing collection
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'measure') {
          this.handlePerformanceEntry(entry);
        }
      }
    });
    this.observer.observe({ entryTypes: ['measure'] });
  }

  /**
   * Start timing an operation
   * @param operationId - Unique identifier for the operation
   * @returns Performance timing object
   */
  startTiming(operationId: string): PerformanceTiming {
    const startTime = performance.now();
    const memoryBefore = this.getCurrentMemoryUsage();

    const timing: PerformanceTiming = {
      startTime,
      endTime: 0,
      duration: 0,
      memoryBefore,
      memoryAfter: 0,
      memoryDelta: 0,
    };

    this.activeTimings.set(operationId, timing);
    performance.mark(`${operationId}-start`);

    return timing;
  }

  /**
   * End timing an operation
   * @param operationId - Operation identifier
   * @returns Completed timing object or null if not found
   */
  endTiming(operationId: string): PerformanceTiming | null {
    const timing = this.activeTimings.get(operationId);
    if (!timing) {
      return null;
    }

    const endTime = performance.now();
    const memoryAfter = this.getCurrentMemoryUsage();

    timing.endTime = endTime;
    timing.duration = endTime - timing.startTime;
    timing.memoryAfter = memoryAfter;
    timing.memoryDelta = memoryAfter - timing.memoryBefore;

    performance.mark(`${operationId}-end`);
    performance.measure(operationId, `${operationId}-start`, `${operationId}-end`);

    this.activeTimings.delete(operationId);
    this.completedTimings.push(timing);

    return timing;
  }

  /**
   * Get current memory usage
   * @returns Memory usage in bytes
   */
  private getCurrentMemoryUsage(): number {
    return process.memoryUsage().heapUsed;
  }

  /**
   * Handle performance entries from observer
   * @param entry - Performance entry
   */
  private handlePerformanceEntry(entry: PerformanceEntry): void {
    // Additional processing of performance entries if needed
    // This can be extended for more detailed performance analysis
  }

  /**
   * Get performance statistics
   * @returns Performance statistics
   */
  getStatistics(): {
    totalOperations: number;
    avgDuration: number;
    minDuration: number;
    maxDuration: number;
    p95Duration: number;
    p99Duration: number;
    avgMemoryDelta: number;
  } {
    if (this.completedTimings.length === 0) {
      return {
        totalOperations: 0,
        avgDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        p95Duration: 0,
        p99Duration: 0,
        avgMemoryDelta: 0,
      };
    }

    const durations = this.completedTimings.map(t => t.duration).sort((a, b) => a - b);
    const memoryDeltas = this.completedTimings.map(t => t.memoryDelta);

    return {
      totalOperations: this.completedTimings.length,
      avgDuration: durations.reduce((sum, d) => sum + d, 0) / durations.length,
      minDuration: durations[0],
      maxDuration: durations[durations.length - 1],
      p95Duration: durations[Math.floor(durations.length * 0.95)],
      p99Duration: durations[Math.floor(durations.length * 0.99)],
      avgMemoryDelta: memoryDeltas.reduce((sum, d) => sum + d, 0) / memoryDeltas.length,
    };
  }

  /**
   * Clear all timing data
   */
  clear(): void {
    this.activeTimings.clear();
    this.completedTimings = [];
    performance.clearMarks();
    performance.clearMeasures();
  }

  /**
   * Cleanup and disconnect observer
   */
  dispose(): void {
    this.observer.disconnect();
    this.clear();
  }
}

/**
 * Statistics calculator for metrics analysis
 */
export class StatisticsCalculator {
  /**
   * Calculate percentiles for a dataset
   * @param values - Array of numeric values
   * @param percentiles - Array of percentiles to calculate (0-100)
   * @returns Object mapping percentiles to values
   */
  static calculatePercentiles(values: number[], percentiles: number[]): Record<string, number> {
    if (values.length === 0) {
      return {};
    }

    const sorted = [...values].sort((a, b) => a - b);
    const result: Record<string, number> = {};

    for (const p of percentiles) {
      const index = (p / 100) * (sorted.length - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index - lower;

      if (upper >= sorted.length) {
        result[`p${p}`] = sorted[sorted.length - 1];
      } else {
        result[`p${p}`] = sorted[lower] * (1 - weight) + sorted[upper] * weight;
      }
    }

    return result;
  }

  /**
   * Calculate tool call statistics from metrics
   * @param toolCalls - Array of tool call metrics
   * @returns Tool call statistics by tool name
   */
  static calculateToolStatistics(toolCalls: ToolCallMetrics[]): Record<string, ToolCallStatistics> {
    const statsByTool: Record<string, ToolCallStatistics> = {};

    for (const call of toolCalls) {
      if (!statsByTool[call.name]) {
        statsByTool[call.name] = {
          name: call.name,
          totalCalls: 0,
          successfulCalls: 0,
          failedCalls: 0,
          successRate: 0,
          minDuration: Infinity,
          maxDuration: 0,
          avgDuration: 0,
          p95Duration: 0,
          p99Duration: 0,
          totalDuration: 0,
          firstCall: call.timestamp,
          lastCall: call.timestamp,
          commonErrors: [],
          usagePattern: Array.from({ length: 24 }, (_, i) => ({ hour: i, calls: 0 })),
        };
      }

      const stats = statsByTool[call.name];
      stats.totalCalls++;
      stats.totalDuration += call.duration;

      if (call.success) {
        stats.successfulCalls++;
      } else {
        stats.failedCalls++;
        if (call.error) {
          const existingError = stats.commonErrors.find(e => e.error === call.error);
          if (existingError) {
            existingError.count++;
          } else {
            stats.commonErrors.push({ error: call.error, count: 1 });
          }
        }
      }

      stats.minDuration = Math.min(stats.minDuration, call.duration);
      stats.maxDuration = Math.max(stats.maxDuration, call.duration);
      stats.firstCall = call.timestamp < stats.firstCall ? call.timestamp : stats.firstCall;
      stats.lastCall = call.timestamp > stats.lastCall ? call.timestamp : stats.lastCall;

      // Update usage pattern
      const hour = call.timestamp.getHours();
      stats.usagePattern[hour].calls++;
    }

    // Calculate derived statistics
    for (const stats of Object.values(statsByTool)) {
      stats.successRate = stats.totalCalls > 0 ? stats.successfulCalls / stats.totalCalls : 0;
      stats.avgDuration = stats.totalCalls > 0 ? stats.totalDuration / stats.totalCalls : 0;

      // Calculate percentiles
      const durations = toolCalls
        .filter(call => call.name === stats.name)
        .map(call => call.duration);

      const percentiles = this.calculatePercentiles(durations, [95, 99]);
      stats.p95Duration = percentiles.p95 || 0;
      stats.p99Duration = percentiles.p99 || 0;

      // Sort common errors by frequency
      stats.commonErrors.sort((a, b) => b.count - a.count);
      stats.commonErrors = stats.commonErrors.slice(0, 5); // Keep top 5
    }

    return statsByTool;
  }

  /**
   * Generate performance recommendations based on metrics
   * @param sessionMetrics - Array of session metrics
   * @param toolStatistics - Tool call statistics
   * @param systemMetrics - System metrics
   * @returns Array of performance recommendations
   */
  static generateRecommendations(
    sessionMetrics: SessionMetrics[],
    toolStatistics: Record<string, ToolCallStatistics>,
    systemMetrics: SystemMetrics
  ): PerformanceRecommendation[] {
    const recommendations: PerformanceRecommendation[] = [];

    // Check for slow tool calls
    for (const [toolName, stats] of Object.entries(toolStatistics)) {
      if (stats.avgDuration > 5000) { // 5+ seconds average
        recommendations.push({
          id: uuidv4(),
          type: 'performance',
          severity: stats.avgDuration > 10000 ? 'high' : 'medium',
          title: `Slow ${toolName} tool calls detected`,
          description: `The ${toolName} tool has an average execution time of ${(stats.avgDuration / 1000).toFixed(1)} seconds, which may impact overall performance.`,
          impact: `Each call to ${toolName} adds significant latency to iterations`,
          action: `Consider optimizing ${toolName} parameters, implementing caching, or using alternative approaches for this tool`,
          triggeringMetrics: {
            avgDuration: stats.avgDuration,
            totalCalls: stats.totalCalls,
          },
          timestamp: new Date(),
        });
      }

      // Check for high failure rates
      if (stats.totalCalls > 10 && stats.successRate < 0.8) {
        recommendations.push({
          id: uuidv4(),
          type: 'reliability',
          severity: stats.successRate < 0.5 ? 'critical' : 'high',
          title: `High failure rate for ${toolName} tool`,
          description: `The ${toolName} tool has a ${(stats.successRate * 100).toFixed(1)}% success rate, indicating reliability issues.`,
          impact: `Frequent failures may cause iteration retries and extended execution times`,
          action: `Review ${toolName} error patterns and improve error handling or tool configuration`,
          triggeringMetrics: {
            successRate: stats.successRate,
            failedCalls: stats.failedCalls,
            totalCalls: stats.totalCalls,
          },
          timestamp: new Date(),
        });
      }
    }

    // Check memory usage
    if (systemMetrics.memoryUsage.percentage > 90) {
      recommendations.push({
        id: uuidv4(),
        type: 'performance',
        severity: 'critical',
        title: 'High memory usage detected',
        description: `System memory usage is at ${systemMetrics.memoryUsage.percentage.toFixed(1)}%, which may cause performance degradation.`,
        impact: 'High memory usage can lead to swapping, slower performance, and potential system instability',
        action: 'Consider increasing system memory, optimizing memory usage patterns, or implementing memory cleanup strategies',
        triggeringMetrics: {
          memoryPercentage: systemMetrics.memoryUsage.percentage,
          memoryUsed: systemMetrics.memoryUsage.used,
        },
        timestamp: new Date(),
      });
    }

    // Check session patterns
    const avgSessionDuration = sessionMetrics.length > 0
      ? sessionMetrics.reduce((sum, s) => sum + s.duration, 0) / sessionMetrics.length
      : 0;

    if (avgSessionDuration > 300000) { // 5+ minutes average
      recommendations.push({
        id: uuidv4(),
        type: 'efficiency',
        severity: 'medium',
        title: 'Long session durations detected',
        description: `Average session duration is ${(avgSessionDuration / 60000).toFixed(1)} minutes, which may indicate inefficient task execution.`,
        impact: 'Long sessions may indicate complex tasks or inefficient execution patterns',
        action: 'Review task complexity, consider breaking down large tasks, or optimize subagent configurations',
        triggeringMetrics: {
          avgSessionDuration,
          totalSessions: sessionMetrics.length,
        },
        timestamp: new Date(),
      });
    }

    return recommendations;
  }
}

/**
 * Comprehensive metrics collector for juno-task-ts
 */
export class MetricsCollector extends EventEmitter {
  private performanceTracker: PerformanceTracker;
  private toolCallMetrics: ToolCallMetrics[] = [];
  private sessionMetrics: Map<string, SessionMetrics> = new Map();
  private systemMetrics: SystemMetrics;
  private isCollecting: boolean = false;
  private startTime: number;

  constructor() {
    super();
    this.performanceTracker = new PerformanceTracker();
    this.startTime = performance.now();
    this.systemMetrics = this.initializeSystemMetrics();
  }

  /**
   * Initialize system metrics
   * @returns Initial system metrics
   */
  private initializeSystemMetrics(): SystemMetrics {
    const memoryUsage = process.memoryUsage();
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;

    return {
      timestamp: new Date(),
      startupTime: 0, // Will be set when collection starts
      configLoadTime: 0,
      templateGenerationTime: 0,
      cliResponseTime: 0,
      cpuUsage: 0,
      memoryUsage: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        percentage: (usedMem / totalMem) * 100,
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
      },
      networkMetrics: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        avgResponseTime: 0,
        totalBytesTransferred: 0,
      },
      fileSystemMetrics: {
        totalOperations: 0,
        readOperations: 0,
        writeOperations: 0,
        avgOperationTime: 0,
      },
    };
  }

  /**
   * Start metrics collection
   */
  startCollection(): void {
    if (this.isCollecting) {
      return;
    }

    this.isCollecting = true;
    this.systemMetrics.startupTime = performance.now() - this.startTime;

    // Set up periodic system metrics collection
    this.startSystemMetricsCollection();

    this.emit('collection_started', { timestamp: new Date() });
  }

  /**
   * Stop metrics collection
   */
  stopCollection(): void {
    if (!this.isCollecting) {
      return;
    }

    this.isCollecting = false;
    this.emit('collection_stopped', { timestamp: new Date() });
  }

  /**
   * Start system metrics collection interval
   */
  private startSystemMetricsCollection(): void {
    const collectSystemMetrics = () => {
      if (!this.isCollecting) {
        return;
      }

      this.updateSystemMetrics();

      // Collect every 30 seconds
      setTimeout(collectSystemMetrics, 30000);
    };

    // Start collection after initial delay
    setTimeout(collectSystemMetrics, 1000);
  }

  /**
   * Update system metrics
   */
  private updateSystemMetrics(): void {
    const memoryUsage = process.memoryUsage();
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;

    this.systemMetrics = {
      ...this.systemMetrics,
      timestamp: new Date(),
      memoryUsage: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        percentage: (usedMem / totalMem) * 100,
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
      },
    };

    this.emit('system_metrics_updated', this.systemMetrics);
  }

  /**
   * Record tool call metrics
   * @param metrics - Tool call metrics to record
   */
  recordToolCall(metrics: Omit<ToolCallMetrics, 'callId' | 'timestamp'>): void {
    const toolCallMetrics: ToolCallMetrics = {
      ...metrics,
      callId: uuidv4(),
      timestamp: new Date(),
    };

    this.toolCallMetrics.push(toolCallMetrics);

    // Update network metrics if this was a network call
    if (toolCallMetrics.networkLatency !== undefined) {
      this.systemMetrics.networkMetrics.totalRequests++;
      if (toolCallMetrics.success) {
        this.systemMetrics.networkMetrics.successfulRequests++;
      } else {
        this.systemMetrics.networkMetrics.failedRequests++;
      }
    }

    this.emit('tool_call_recorded', toolCallMetrics);
  }

  /**
   * Start session metrics tracking
   * @param sessionId - Session identifier
   * @param subagent - Subagent type
   * @param workingDirectory - Working directory
   * @param model - Model name (optional)
   */
  startSession(sessionId: string, subagent: SubagentType, workingDirectory: string, model?: string): void {
    const sessionMetrics: SessionMetrics = {
      sessionId,
      startTime: new Date(),
      duration: 0,
      status: 'running',
      iterations: 0,
      toolCalls: 0,
      successCount: 0,
      errorCount: 0,
      warningCount: 0,
      successRate: 0,
      avgIterationDuration: 0,
      avgToolCallDuration: 0,
      totalThinkingTime: 0,
      peakMemoryUsage: process.memoryUsage().heapUsed,
      avgMemoryUsage: process.memoryUsage().heapUsed,
      currentMemoryUsage: process.memoryUsage().heapUsed,
      subagent,
      model,
      workingDirectory,
    };

    this.sessionMetrics.set(sessionId, sessionMetrics);
    this.emit('session_started', sessionMetrics);
  }

  /**
   * Update session metrics
   * @param sessionId - Session identifier
   * @param updates - Metrics updates
   */
  updateSession(sessionId: string, updates: Partial<SessionMetrics>): void {
    const session = this.sessionMetrics.get(sessionId);
    if (!session) {
      return;
    }

    Object.assign(session, updates);

    // Update derived metrics
    if (session.endTime) {
      session.duration = session.endTime.getTime() - session.startTime.getTime();
    }

    // Update memory usage
    const currentMemory = process.memoryUsage().heapUsed;
    session.currentMemoryUsage = currentMemory;
    session.peakMemoryUsage = Math.max(session.peakMemoryUsage, currentMemory);

    this.emit('session_updated', session);
  }

  /**
   * End session metrics tracking
   * @param sessionId - Session identifier
   * @param status - Final session status
   */
  endSession(sessionId: string, status: SessionStatus): void {
    const session = this.sessionMetrics.get(sessionId);
    if (!session) {
      return;
    }

    session.endTime = new Date();
    session.status = status;
    session.duration = session.endTime.getTime() - session.startTime.getTime();

    // Calculate session-specific tool call metrics
    const sessionToolCalls = this.toolCallMetrics.filter(tc => tc.sessionId === sessionId);
    session.toolCalls = sessionToolCalls.length;

    if (sessionToolCalls.length > 0) {
      session.avgToolCallDuration = sessionToolCalls.reduce((sum, tc) => sum + tc.duration, 0) / sessionToolCalls.length;
      session.successCount = sessionToolCalls.filter(tc => tc.success).length;
      session.errorCount = sessionToolCalls.filter(tc => !tc.success).length;
      session.successRate = session.successCount / sessionToolCalls.length;
    }

    this.emit('session_ended', session);
  }

  /**
   * Record performance timing
   * @param operationName - Name of the operation
   * @param duration - Duration in milliseconds
   * @param metadata - Additional metadata
   */
  recordPerformanceTiming(operationName: string, duration: number, metadata?: Record<string, any>): void {
    // Update system metrics based on operation type
    switch (operationName) {
      case 'config_load':
        this.systemMetrics.configLoadTime = duration;
        break;
      case 'template_generation':
        this.systemMetrics.templateGenerationTime = duration;
        break;
      case 'cli_response':
        this.systemMetrics.cliResponseTime = duration;
        break;
    }

    this.emit('performance_recorded', {
      operationName,
      duration,
      metadata,
      timestamp: new Date(),
    });
  }

  /**
   * Get comprehensive analytics report
   * @param timeRange - Optional time range for the report
   * @returns Analytics report
   */
  getAnalyticsReport(timeRange?: { start: Date; end: Date }): AnalyticsReport {
    let filteredToolCalls = this.toolCallMetrics;
    let filteredSessions = Array.from(this.sessionMetrics.values());

    // Apply time range filter if provided
    if (timeRange) {
      filteredToolCalls = this.toolCallMetrics.filter(
        tc => tc.timestamp >= timeRange.start && tc.timestamp <= timeRange.end
      );
      filteredSessions = filteredSessions.filter(
        s => s.startTime >= timeRange.start && s.startTime <= timeRange.end
      );
    }

    // Calculate tool statistics
    const toolStatistics = StatisticsCalculator.calculateToolStatistics(filteredToolCalls);

    // Calculate session statistics by subagent
    const sessionStatsBySubagent: Record<SubagentType, any> = {} as any;
    for (const session of filteredSessions) {
      if (!sessionStatsBySubagent[session.subagent]) {
        sessionStatsBySubagent[session.subagent] = {
          count: 0,
          totalDuration: 0,
          totalIterations: 0,
          successfulSessions: 0,
        };
      }

      const stats = sessionStatsBySubagent[session.subagent];
      stats.count++;
      stats.totalDuration += session.duration;
      stats.totalIterations += session.iterations;
      if (session.status === 'completed') {
        stats.successfulSessions++;
      }
    }

    // Calculate derived statistics
    for (const stats of Object.values(sessionStatsBySubagent)) {
      stats.avgDuration = stats.count > 0 ? stats.totalDuration / stats.count : 0;
      stats.avgIterations = stats.count > 0 ? stats.totalIterations / stats.count : 0;
      stats.successRate = stats.count > 0 ? stats.successfulSessions / stats.count : 0;
      delete stats.totalDuration;
      delete stats.totalIterations;
      delete stats.successfulSessions;
    }

    // Generate performance trends (simplified for now)
    const performanceTrends = {
      iterationDurationTrend: [],
      successRateTrend: [],
      errorRateTrend: [],
    };

    // Generate recommendations
    const recommendations = StatisticsCalculator.generateRecommendations(
      filteredSessions,
      toolStatistics,
      this.systemMetrics
    );

    return {
      timestamp: new Date(),
      timeRange: timeRange || {
        start: new Date(0),
        end: new Date(),
      },
      summary: {
        totalSessions: filteredSessions.length,
        totalIterations: filteredSessions.reduce((sum, s) => sum + s.iterations, 0),
        totalToolCalls: filteredToolCalls.length,
        avgSessionDuration: filteredSessions.length > 0
          ? filteredSessions.reduce((sum, s) => sum + s.duration, 0) / filteredSessions.length
          : 0,
        overallSuccessRate: filteredToolCalls.length > 0
          ? filteredToolCalls.filter(tc => tc.success).length / filteredToolCalls.length
          : 0,
        totalErrors: filteredToolCalls.filter(tc => !tc.success).length,
      },
      toolStatistics,
      sessionStatsBySubagent,
      performanceTrends,
      systemPerformance: this.systemMetrics,
      recommendations,
      resourceUsage: {
        peakMemory: Math.max(...filteredSessions.map(s => s.peakMemoryUsage)),
        avgMemory: filteredSessions.length > 0
          ? filteredSessions.reduce((sum, s) => sum + s.avgMemoryUsage, 0) / filteredSessions.length
          : 0,
        cpuUtilization: this.systemMetrics.cpuUsage,
        networkUtilization: this.systemMetrics.networkMetrics.totalRequests,
      },
    };
  }

  /**
   * Get tool call statistics
   * @returns Tool call statistics by tool name
   */
  getToolStatistics(): Record<string, ToolCallStatistics> {
    return StatisticsCalculator.calculateToolStatistics(this.toolCallMetrics);
  }

  /**
   * Get session metrics by ID
   * @param sessionId - Session identifier
   * @returns Session metrics or undefined
   */
  getSessionMetrics(sessionId: string): SessionMetrics | undefined {
    return this.sessionMetrics.get(sessionId);
  }

  /**
   * Get all session metrics
   * @returns Array of all session metrics
   */
  getAllSessionMetrics(): SessionMetrics[] {
    return Array.from(this.sessionMetrics.values());
  }

  /**
   * Get current system metrics
   * @returns Current system metrics
   */
  getSystemMetrics(): SystemMetrics {
    this.updateSystemMetrics();
    return this.systemMetrics;
  }

  /**
   * Clear all metrics data
   */
  clearMetrics(): void {
    this.toolCallMetrics = [];
    this.sessionMetrics.clear();
    this.performanceTracker.clear();
    this.systemMetrics = this.initializeSystemMetrics();
    this.emit('metrics_cleared', { timestamp: new Date() });
  }

  /**
   * Dispose of the metrics collector
   */
  dispose(): void {
    this.stopCollection();
    this.performanceTracker.dispose();
    this.removeAllListeners();
  }
}

/**
 * Metrics reporter for formatted output and exports
 */
export class MetricsReporter {
  private metricsCollector: MetricsCollector;

  constructor(metricsCollector: MetricsCollector) {
    this.metricsCollector = metricsCollector;
  }

  /**
   * Generate a formatted verbose statistics report
   * @param sessionId - Optional specific session ID
   * @returns Formatted statistics string
   */
  generateVerboseReport(sessionId?: string): string {
    const report: string[] = [];

    if (sessionId) {
      const sessionMetrics = this.metricsCollector.getSessionMetrics(sessionId);
      if (sessionMetrics) {
        report.push(this.formatSessionReport(sessionMetrics));
      }
    } else {
      const analyticsReport = this.metricsCollector.getAnalyticsReport();
      report.push(this.formatAnalyticsReport(analyticsReport));
    }

    return report.join('\n');
  }

  /**
   * Format session-specific report
   * @param session - Session metrics
   * @returns Formatted session report
   */
  private formatSessionReport(session: SessionMetrics): string {
    const lines = [
      '═══════════════════════════════════════════════════════════════════════════════',
      '                            SESSION PERFORMANCE REPORT                            ',
      '═══════════════════════════════════════════════════════════════════════════════',
      '',
      `Session ID: ${session.sessionId}`,
      `Subagent: ${session.subagent}${session.model ? ` (${session.model})` : ''}`,
      `Status: ${session.status.toUpperCase()}`,
      `Duration: ${this.formatDuration(session.duration)}`,
      `Working Directory: ${session.workingDirectory}`,
      '',
      '─── EXECUTION METRICS ─────────────────────────────────────────────────────────',
      `Iterations: ${session.iterations}`,
      `Tool Calls: ${session.toolCalls}`,
      `Success Rate: ${(session.successRate * 100).toFixed(1)}%`,
      `Avg Iteration Duration: ${this.formatDuration(session.avgIterationDuration)}`,
      `Avg Tool Call Duration: ${this.formatDuration(session.avgToolCallDuration)}`,
      '',
      '─── MEMORY USAGE ──────────────────────────────────────────────────────────────',
      `Peak Memory: ${this.formatBytes(session.peakMemoryUsage)}`,
      `Average Memory: ${this.formatBytes(session.avgMemoryUsage)}`,
      `Current Memory: ${this.formatBytes(session.currentMemoryUsage)}`,
      '',
      '─── ERROR ANALYSIS ───────────────────────────────────────────────────────────',
      `Total Errors: ${session.errorCount}`,
      `Total Warnings: ${session.warningCount}`,
      `Error Rate: ${session.toolCalls > 0 ? ((session.errorCount / session.toolCalls) * 100).toFixed(1) : 0}%`,
    ];

    return lines.join('\n');
  }

  /**
   * Format comprehensive analytics report
   * @param analytics - Analytics report
   * @returns Formatted analytics report
   */
  private formatAnalyticsReport(analytics: AnalyticsReport): string {
    const lines = [
      '═══════════════════════════════════════════════════════════════════════════════',
      '                          COMPREHENSIVE ANALYTICS REPORT                          ',
      '═══════════════════════════════════════════════════════════════════════════════',
      '',
      `Report Generated: ${analytics.timestamp.toISOString()}`,
      `Time Range: ${analytics.timeRange.start.toISOString()} to ${analytics.timeRange.end.toISOString()}`,
      '',
      '─── SUMMARY STATISTICS ────────────────────────────────────────────────────────',
      `Total Sessions: ${analytics.summary.totalSessions}`,
      `Total Iterations: ${analytics.summary.totalIterations}`,
      `Total Tool Calls: ${analytics.summary.totalToolCalls}`,
      `Average Session Duration: ${this.formatDuration(analytics.summary.avgSessionDuration)}`,
      `Overall Success Rate: ${(analytics.summary.overallSuccessRate * 100).toFixed(1)}%`,
      `Total Errors: ${analytics.summary.totalErrors}`,
      '',
      '─── TOOL USAGE STATISTICS ─────────────────────────────────────────────────────',
    ];

    // Add tool statistics
    const sortedTools = Object.values(analytics.toolStatistics)
      .sort((a, b) => b.totalCalls - a.totalCalls);

    for (const tool of sortedTools.slice(0, 10)) { // Top 10 tools
      lines.push(
        `${tool.name}:`,
        `  Calls: ${tool.totalCalls} | Success Rate: ${(tool.successRate * 100).toFixed(1)}%`,
        `  Avg Duration: ${this.formatDuration(tool.avgDuration)} | P95: ${this.formatDuration(tool.p95Duration)}`,
        ''
      );
    }

    lines.push(
      '─── SYSTEM PERFORMANCE ────────────────────────────────────────────────────────',
      `Memory Usage: ${analytics.systemPerformance.memoryUsage.percentage.toFixed(1)}% (${this.formatBytes(analytics.systemPerformance.memoryUsage.used)})`,
      `CPU Usage: ${analytics.systemPerformance.cpuUsage.toFixed(1)}%`,
      `Network Requests: ${analytics.systemPerformance.networkMetrics.totalRequests}`,
      `File System Operations: ${analytics.systemPerformance.fileSystemMetrics.totalOperations}`,
      ''
    );

    // Add recommendations
    if (analytics.recommendations.length > 0) {
      lines.push('─── PERFORMANCE RECOMMENDATIONS ───────────────────────────────────────────────');
      for (const rec of analytics.recommendations) {
        lines.push(
          `[${rec.severity.toUpperCase()}] ${rec.title}`,
          `  ${rec.description}`,
          `  Action: ${rec.action}`,
          ''
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * Export metrics to file
   * @param options - Export options
   */
  async exportMetrics(options: MetricsExportOptions): Promise<void> {
    const analyticsReport = this.metricsCollector.getAnalyticsReport(options.timeRange);

    let exportData: string;

    switch (options.format) {
      case 'json':
        exportData = JSON.stringify(analyticsReport, null, 2);
        break;

      case 'csv':
        exportData = this.convertToCSV(analyticsReport);
        break;

      case 'yaml':
        // Would require yaml library
        throw new Error('YAML export not yet implemented');

      default:
        throw new Error(`Unsupported export format: ${options.format}`);
    }

    // Ensure directory exists
    await fsPromises.mkdir(path.dirname(options.outputPath), { recursive: true });

    // Write file
    await fsPromises.writeFile(options.outputPath, exportData, 'utf-8');
  }

  /**
   * Convert analytics report to CSV format
   * @param report - Analytics report
   * @returns CSV string
   */
  private convertToCSV(report: AnalyticsReport): string {
    const lines = [];

    // Tool statistics CSV
    lines.push('Tool Name,Total Calls,Success Rate,Avg Duration,P95 Duration,P99 Duration');
    for (const [name, stats] of Object.entries(report.toolStatistics)) {
      lines.push(
        `${name},${stats.totalCalls},${stats.successRate},${stats.avgDuration},${stats.p95Duration},${stats.p99Duration}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Format duration in human-readable format
   * @param milliseconds - Duration in milliseconds
   * @returns Formatted duration string
   */
  private formatDuration(milliseconds: number): string {
    if (milliseconds < 1000) {
      return `${milliseconds.toFixed(0)}ms`;
    } else if (milliseconds < 60000) {
      return `${(milliseconds / 1000).toFixed(1)}s`;
    } else if (milliseconds < 3600000) {
      const minutes = Math.floor(milliseconds / 60000);
      const seconds = Math.floor((milliseconds % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    } else {
      const hours = Math.floor(milliseconds / 3600000);
      const minutes = Math.floor((milliseconds % 3600000) / 60000);
      return `${hours}h ${minutes}m`;
    }
  }

  /**
   * Format bytes in human-readable format
   * @param bytes - Number of bytes
   * @returns Formatted bytes string
   */
  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}

/**
 * Create a metrics collector instance
 * Convenience function for creating a metrics collector
 *
 * @returns Configured metrics collector instance
 *
 * @example
 * ```typescript
 * const metricsCollector = createMetricsCollector();
 * metricsCollector.startCollection();
 *
 * // Record session
 * metricsCollector.startSession('session1', 'claude', '/path/to/project');
 *
 * // Record tool call
 * metricsCollector.recordToolCall({
 *   name: 'file_read',
 *   duration: 150,
 *   success: true,
 *   sessionId: 'session1',
 *   iteration: 1,
 *   subagent: 'claude'
 * });
 * ```
 */
export function createMetricsCollector(): MetricsCollector {
  return new MetricsCollector();
}

/**
 * Create a metrics reporter instance
 * Convenience function for creating a metrics reporter
 *
 * @param metricsCollector - Metrics collector instance
 * @returns Configured metrics reporter instance
 */
export function createMetricsReporter(metricsCollector: MetricsCollector): MetricsReporter {
  return new MetricsReporter(metricsCollector);
}

// Export all types and interfaces for external use
export type {
  PerformanceTiming,
  ToolCallMetrics,
  SessionMetrics,
  SystemMetrics,
  ToolCallStatistics,
  PerformanceRecommendation,
  AnalyticsReport,
  MetricsExportFormat,
  MetricsExportOptions,
};