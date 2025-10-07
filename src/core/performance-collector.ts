/**
 * Performance Metrics Collection System for juno-task-ts
 *
 * Comprehensive performance analytics and metrics collection.
 * Provides real-time execution metrics, resource usage monitoring,
 * and detailed timing breakdowns for all CLI operations.
 */

import os from 'os';
import process from 'process';

// ============================================================================
// Core Interfaces
// ============================================================================

export interface PerformanceMetrics {
  executionTime: number;
  iterationsPerSecond: number;
  averageResponseTime: number;
  successRate: number;
  resourceUsage: ResourceMetrics;
  breakdown: TimingBreakdown;
  timestamp: Date;
  sessionId?: string;
}

export interface ResourceMetrics {
  memoryUsage: number; // MB
  cpuUsage: number; // Percentage
  networkIO: number; // Bytes
  diskIO: number; // Operations
  startMemory: number; // MB
  peakMemory: number; // MB
}

export interface TimingBreakdown {
  mcpConnection: number;
  toolExecution: number;
  responseProcessing: number;
  fileOperations: number;
  templateProcessing: number;
  networkRequests: number;
  initialization: number;
  cleanup: number;
}

export interface PerformanceReport {
  summary: PerformanceMetrics;
  trends: PerformanceMetrics[];
  comparison?: {
    before: PerformanceMetrics;
    after: PerformanceMetrics;
    improvement: Record<string, number>;
  };
  recommendations: string[];
}

export interface OperationTimer {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, any>;
}

// ============================================================================
// Performance Collector Class
// ============================================================================

export class PerformanceCollector {
  private startTime: number;
  private endTime?: number;
  private metrics: Map<string, number> = new Map();
  private timers: Map<string, OperationTimer> = new Map();
  private iterations: number = 0;
  private successCount: number = 0;
  private errorCount: number = 0;
  private responseTimes: number[] = [];
  private resourceBaseline?: ResourceMetrics;
  private sessionId?: string;

  constructor(sessionId?: string) {
    this.startTime = Date.now();
    this.sessionId = sessionId;
    this.resourceBaseline = this.getCurrentResourceUsage();
  }

  /**
   * Start a timer for a specific operation
   */
  startTimer(operation: string, metadata?: Record<string, any>): void {
    const timer: OperationTimer = {
      name: operation,
      startTime: performance.now(),
      metadata
    };
    this.timers.set(operation, timer);
    this.metrics.set(`${operation}_start`, Date.now());
  }

  /**
   * End a timer and record the duration
   */
  endTimer(operation: string): number {
    const timer = this.timers.get(operation);
    if (!timer) {
      console.warn(`Timer "${operation}" not found`);
      return 0;
    }

    timer.endTime = performance.now();
    timer.duration = timer.endTime - timer.startTime;

    this.metrics.set(`${operation}_duration`, timer.duration);
    return timer.duration;
  }

  /**
   * Record a generic metric
   */
  recordMetric(name: string, value: number): void {
    this.metrics.set(name, value);
  }

  /**
   * Record an iteration with success/failure
   */
  recordIteration(success: boolean, responseTime?: number): void {
    this.iterations++;
    if (success) {
      this.successCount++;
    } else {
      this.errorCount++;
    }

    if (responseTime !== undefined) {
      this.responseTimes.push(responseTime);
    }
  }

  /**
   * Get current resource usage
   */
  private getCurrentResourceUsage(): ResourceMetrics {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
      memoryUsage: Math.round(memoryUsage.rss / 1024 / 1024), // Convert to MB
      cpuUsage: 0, // Will be calculated over time
      networkIO: 0, // Placeholder - would need network monitoring
      diskIO: 0, // Placeholder - would need disk monitoring
      startMemory: Math.round(memoryUsage.rss / 1024 / 1024),
      peakMemory: Math.round(memoryUsage.rss / 1024 / 1024)
    };
  }

  /**
   * Calculate CPU usage percentage
   */
  private calculateCpuUsage(): number {
    try {
      const loadAvg = os.loadavg();
      const cpuCount = os.cpus().length;
      return Math.round((loadAvg[0] / cpuCount) * 100);
    } catch {
      return 0;
    }
  }

  /**
   * Calculate iterations per second
   */
  private calculateIterationsPerSecond(): number {
    if (this.iterations === 0) return 0;

    const duration = this.endTime ?
      (this.endTime - this.startTime) / 1000 :
      (Date.now() - this.startTime) / 1000;

    return duration > 0 ? Math.round(this.iterations / duration) : 0;
  }

  /**
   * Calculate average response time
   */
  private calculateAverageResponseTime(): number {
    if (this.responseTimes.length === 0) return 0;

    const sum = this.responseTimes.reduce((acc, time) => acc + time, 0);
    return Math.round(sum / this.responseTimes.length);
  }

  /**
   * Calculate success rate percentage
   */
  private calculateSuccessRate(): number {
    if (this.iterations === 0) return 100;
    return Math.round((this.successCount / this.iterations) * 100);
  }

  /**
   * Get timing breakdown from recorded timers
   */
  private getTimingBreakdown(): TimingBreakdown {
    return {
      mcpConnection: this.metrics.get('mcp_connection_duration') || 0,
      toolExecution: this.metrics.get('tool_execution_duration') || 0,
      responseProcessing: this.metrics.get('response_processing_duration') || 0,
      fileOperations: this.metrics.get('file_operations_duration') || 0,
      templateProcessing: this.metrics.get('template_processing_duration') || 0,
      networkRequests: this.metrics.get('network_requests_duration') || 0,
      initialization: this.metrics.get('initialization_duration') || 0,
      cleanup: this.metrics.get('cleanup_duration') || 0
    };
  }

  /**
   * Complete the collection and get final metrics
   */
  complete(): PerformanceMetrics {
    this.endTime = Date.now();
    const currentResource = this.getCurrentResourceUsage();

    const metrics: PerformanceMetrics = {
      executionTime: this.endTime - this.startTime,
      iterationsPerSecond: this.calculateIterationsPerSecond(),
      averageResponseTime: this.calculateAverageResponseTime(),
      successRate: this.calculateSuccessRate(),
      resourceUsage: {
        ...currentResource,
        cpuUsage: this.calculateCpuUsage(),
        startMemory: this.resourceBaseline?.startMemory || 0,
        peakMemory: Math.max(
          currentResource.memoryUsage,
          this.resourceBaseline?.peakMemory || 0
        )
      },
      breakdown: this.getTimingBreakdown(),
      timestamp: new Date(),
      sessionId: this.sessionId
    };

    return metrics;
  }

  /**
   * Get current metrics without completing collection
   */
  getMetrics(): PerformanceMetrics {
    const currentResource = this.getCurrentResourceUsage();
    const currentTime = Date.now();

    return {
      executionTime: currentTime - this.startTime,
      iterationsPerSecond: this.calculateIterationsPerSecond(),
      averageResponseTime: this.calculateAverageResponseTime(),
      successRate: this.calculateSuccessRate(),
      resourceUsage: {
        ...currentResource,
        cpuUsage: this.calculateCpuUsage(),
        startMemory: this.resourceBaseline?.startMemory || 0,
        peakMemory: Math.max(
          currentResource.memoryUsage,
          this.resourceBaseline?.peakMemory || 0
        )
      },
      breakdown: this.getTimingBreakdown(),
      timestamp: new Date(),
      sessionId: this.sessionId
    };
  }

  /**
   * Reset all metrics and timers
   */
  reset(): void {
    this.startTime = Date.now();
    this.endTime = undefined;
    this.metrics.clear();
    this.timers.clear();
    this.iterations = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.responseTimes = [];
    this.resourceBaseline = this.getCurrentResourceUsage();
  }

  /**
   * Get all timer details
   */
  getTimerDetails(): OperationTimer[] {
    return Array.from(this.timers.values());
  }

  /**
   * Export metrics for persistence
   */
  export(): string {
    const data = {
      metrics: Object.fromEntries(this.metrics),
      timers: Object.fromEntries(this.timers),
      iterations: this.iterations,
      successCount: this.successCount,
      errorCount: this.errorCount,
      responseTimes: this.responseTimes,
      startTime: this.startTime,
      endTime: this.endTime,
      sessionId: this.sessionId
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * Import metrics from persistence
   */
  import(data: string): void {
    try {
      const parsed = JSON.parse(data);

      this.metrics = new Map(Object.entries(parsed.metrics || {}));
      this.timers = new Map(Object.entries(parsed.timers || {}));
      this.iterations = parsed.iterations || 0;
      this.successCount = parsed.successCount || 0;
      this.errorCount = parsed.errorCount || 0;
      this.responseTimes = parsed.responseTimes || [];
      this.startTime = parsed.startTime || Date.now();
      this.endTime = parsed.endTime;
      this.sessionId = parsed.sessionId;
    } catch (error) {
      console.warn('Failed to import performance metrics:', error);
    }
  }
}

// ============================================================================
// Performance Manager Class
// ============================================================================

export class PerformanceManager {
  private static instance: PerformanceManager;
  private collectors: Map<string, PerformanceCollector> = new Map();
  private historicalMetrics: PerformanceMetrics[] = [];
  private maxHistorySize: number = 100;

  private constructor() {}

  static getInstance(): PerformanceManager {
    if (!PerformanceManager.instance) {
      PerformanceManager.instance = new PerformanceManager();
    }
    return PerformanceManager.instance;
  }

  /**
   * Create a new performance collector
   */
  createCollector(sessionId: string): PerformanceCollector {
    const collector = new PerformanceCollector(sessionId);
    this.collectors.set(sessionId, collector);
    return collector;
  }

  /**
   * Get an existing collector
   */
  getCollector(sessionId: string): PerformanceCollector | undefined {
    return this.collectors.get(sessionId);
  }

  /**
   * Complete a collection and store metrics
   */
  completeCollection(sessionId: string): PerformanceMetrics | undefined {
    const collector = this.collectors.get(sessionId);
    if (!collector) return undefined;

    const metrics = collector.complete();
    this.addToHistory(metrics);
    this.collectors.delete(sessionId);

    return metrics;
  }

  /**
   * Add metrics to historical data
   */
  private addToHistory(metrics: PerformanceMetrics): void {
    this.historicalMetrics.push(metrics);

    // Keep only the most recent metrics
    if (this.historicalMetrics.length > this.maxHistorySize) {
      this.historicalMetrics = this.historicalMetrics.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get historical metrics
   */
  getHistoricalMetrics(limit?: number): PerformanceMetrics[] {
    const metrics = [...this.historicalMetrics].reverse(); // Most recent first
    return limit ? metrics.slice(0, limit) : metrics;
  }

  /**
   * Generate performance report
   */
  generateReport(currentMetrics?: PerformanceMetrics): PerformanceReport {
    const recent = this.getHistoricalMetrics(10);
    const recommendations: string[] = [];

    // Add recommendations based on metrics
    if (currentMetrics) {
      if (currentMetrics.successRate < 90) {
        recommendations.push('Consider reviewing error handling and retry logic');
      }
      if (currentMetrics.averageResponseTime > 5000) {
        recommendations.push('Response times are high - consider optimizing tool execution');
      }
      if (currentMetrics.resourceUsage.memoryUsage > 500) {
        recommendations.push('Memory usage is high - consider memory optimization');
      }
      if (currentMetrics.iterationsPerSecond < 0.5) {
        recommendations.push('Low iteration rate - consider parallelization or optimization');
      }
    }

    const report: PerformanceReport = {
      summary: currentMetrics || (recent[0] ?? this.getDefaultMetrics()),
      trends: recent,
      recommendations
    };

    // Add comparison if we have historical data
    if (recent.length >= 2 && currentMetrics) {
      const previous = recent[1];
      report.comparison = {
        before: previous,
        after: currentMetrics,
        improvement: {
          executionTime: ((previous.executionTime - currentMetrics.executionTime) / previous.executionTime) * 100,
          successRate: currentMetrics.successRate - previous.successRate,
          responseTime: ((previous.averageResponseTime - currentMetrics.averageResponseTime) / previous.averageResponseTime) * 100,
          memoryUsage: ((previous.resourceUsage.memoryUsage - currentMetrics.resourceUsage.memoryUsage) / previous.resourceUsage.memoryUsage) * 100
        }
      };
    }

    return report;
  }

  /**
   * Get default metrics for empty states
   */
  private getDefaultMetrics(): PerformanceMetrics {
    return {
      executionTime: 0,
      iterationsPerSecond: 0,
      averageResponseTime: 0,
      successRate: 100,
      resourceUsage: {
        memoryUsage: 0,
        cpuUsage: 0,
        networkIO: 0,
        diskIO: 0,
        startMemory: 0,
        peakMemory: 0
      },
      breakdown: {
        mcpConnection: 0,
        toolExecution: 0,
        responseProcessing: 0,
        fileOperations: 0,
        templateProcessing: 0,
        networkRequests: 0,
        initialization: 0,
        cleanup: 0
      },
      timestamp: new Date()
    };
  }

  /**
   * Clear all historical data
   */
  clearHistory(): void {
    this.historicalMetrics = [];
  }

  /**
   * Get summary statistics
   */
  getSummaryStats(): {
    totalSessions: number;
    averageExecutionTime: number;
    averageSuccessRate: number;
    averageResponseTime: number;
  } {
    if (this.historicalMetrics.length === 0) {
      return {
        totalSessions: 0,
        averageExecutionTime: 0,
        averageSuccessRate: 0,
        averageResponseTime: 0
      };
    }

    const totals = this.historicalMetrics.reduce(
      (acc, metrics) => ({
        executionTime: acc.executionTime + metrics.executionTime,
        successRate: acc.successRate + metrics.successRate,
        responseTime: acc.responseTime + metrics.averageResponseTime
      }),
      { executionTime: 0, successRate: 0, responseTime: 0 }
    );

    const count = this.historicalMetrics.length;

    return {
      totalSessions: count,
      averageExecutionTime: Math.round(totals.executionTime / count),
      averageSuccessRate: Math.round(totals.successRate / count),
      averageResponseTime: Math.round(totals.responseTime / count)
    };
  }
}

export default PerformanceCollector;