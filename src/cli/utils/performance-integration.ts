/**
 * Performance Integration Utilities for juno-task-ts CLI
 *
 * Integrates performance collection and dashboard display with CLI commands.
 * Provides utilities for measuring command execution and displaying results.
 */

import React from 'react';
import { render } from 'ink';
import { PerformanceCollector, PerformanceManager, PerformanceMetrics, PerformanceReport } from '../../core/performance-collector.js';
import { PerformanceDashboard } from '../../tui/components/PerformanceDashboard.js';
import { RichFormatter } from './rich-formatter.js';

// ============================================================================
// Integration Interfaces
// ============================================================================

export interface PerformanceOptions {
  verbose?: boolean;
  showMetrics?: boolean;
  showDashboard?: boolean;
  saveMetrics?: boolean;
  metricsFile?: string;
}

export interface CommandExecutionContext {
  sessionId: string;
  command: string;
  arguments: string[];
  options: Record<string, any>;
  startTime: number;
}

// ============================================================================
// Performance Integration Class
// ============================================================================

export class PerformanceIntegration {
  private manager: PerformanceManager;
  private formatter: RichFormatter;

  constructor() {
    this.manager = PerformanceManager.getInstance();
    this.formatter = new RichFormatter();
  }

  /**
   * Start performance monitoring for a command execution
   */
  startMonitoring(context: CommandExecutionContext): PerformanceCollector {
    const collector = this.manager.createCollector(context.sessionId);

    // Start timing for overall execution
    collector.startTimer('total', {
      command: context.command,
      arguments: context.arguments,
      options: context.options
    });

    // Start timing for initialization
    collector.startTimer('initialization');

    return collector;
  }

  /**
   * Complete performance monitoring and display results
   */
  async completeMonitoring(
    sessionId: string,
    options: PerformanceOptions = {}
  ): Promise<PerformanceMetrics | undefined> {
    const collector = this.manager.getCollector(sessionId);
    if (!collector) return undefined;

    // End total timer
    collector.endTimer('total');

    // Complete collection and get final metrics
    const metrics = this.manager.completeCollection(sessionId);
    if (!metrics) return undefined;

    // Display results based on options
    if (options.showMetrics || options.verbose) {
      this.displayMetricsSummary(metrics);
    }

    if (options.showDashboard) {
      await this.showDashboard(metrics, this.manager.generateReport(metrics));
    }

    // Save metrics if requested
    if (options.saveMetrics && options.metricsFile) {
      await this.saveMetrics(metrics, options.metricsFile);
    }

    return metrics;
  }

  /**
   * Display metrics summary in console
   */
  displayMetricsSummary(metrics: PerformanceMetrics): void {
    const icon = this.getPerformanceIcon(metrics.successRate);

    console.log(this.formatter.panel(
      this.formatMetricsSummary(metrics),
      {
        title: `${icon} Performance Summary`,
        border: 'rounded',
        style: metrics.successRate >= 90 ? 'success' : metrics.successRate >= 70 ? 'warning' : 'error',
        padding: 1
      }
    ));
  }

  /**
   * Format metrics summary for display
   */
  private formatMetricsSummary(metrics: PerformanceMetrics): string {
    const lines = [
      `📊 Execution Time: ${this.formatDuration(metrics.executionTime)}`,
      `✅ Success Rate: ${metrics.successRate.toFixed(1)}%`,
      `⚡ Iterations/sec: ${metrics.iterationsPerSecond.toFixed(2)}`,
      `⏱️  Avg Response: ${this.formatDuration(metrics.averageResponseTime)}`,
      `💾 Memory Usage: ${metrics.resourceUsage.memoryUsage}MB`,
      `🔄 CPU Usage: ${metrics.resourceUsage.cpuUsage.toFixed(1)}%`
    ];

    // Add timing breakdown if available
    const breakdown = metrics.breakdown;
    const totalBreakdown = Object.values(breakdown).reduce((sum, time) => sum + time, 0);

    if (totalBreakdown > 0) {
      lines.push('', '🔍 Timing Breakdown:');

      Object.entries(breakdown)
        .filter(([_, time]) => time > 0)
        .sort(([_, a], [__, b]) => b - a)
        .forEach(([operation, time]) => {
          const percentage = ((time / totalBreakdown) * 100).toFixed(1);
          const operationName = operation.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
          lines.push(`   • ${operationName}: ${this.formatDuration(time)} (${percentage}%)`);
        });
    }

    return lines.join('\n');
  }

  /**
   * Show interactive performance dashboard
   */
  async showDashboard(metrics: PerformanceMetrics, report: PerformanceReport): Promise<void> {
    return new Promise((resolve) => {
      const { unmount } = render(
        React.createElement(PerformanceDashboard, {
          metrics,
          report,
          interactive: true,
          onClose: () => {
            unmount();
            resolve();
          }
        })
      );
    });
  }

  /**
   * Save metrics to file
   */
  private async saveMetrics(metrics: PerformanceMetrics, filePath: string): Promise<void> {
    try {
      const fs = await import('fs-extra');
      const data = {
        timestamp: new Date().toISOString(),
        metrics,
        report: this.manager.generateReport(metrics)
      };
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      console.log(`📊 Performance metrics saved to: ${filePath}`);
    } catch (error) {
      console.warn(`⚠️  Failed to save metrics: ${error}`);
    }
  }

  /**
   * Record timing for specific operations
   */
  recordTiming(sessionId: string, operation: string, duration: number): void {
    const collector = this.manager.getCollector(sessionId);
    if (collector) {
      collector.recordMetric(`${operation}_duration`, duration);
    }
  }

  /**
   * Record iteration result
   */
  recordIteration(sessionId: string, success: boolean, responseTime?: number): void {
    const collector = this.manager.getCollector(sessionId);
    if (collector) {
      collector.recordIteration(success, responseTime);
    }
  }

  /**
   * Start timing for an operation
   */
  startTiming(sessionId: string, operation: string, metadata?: Record<string, any>): void {
    const collector = this.manager.getCollector(sessionId);
    if (collector) {
      collector.startTimer(operation, metadata);
    }
  }

  /**
   * End timing for an operation
   */
  endTiming(sessionId: string, operation: string): number {
    const collector = this.manager.getCollector(sessionId);
    return collector ? collector.endTimer(operation) : 0;
  }

  /**
   * Get current metrics without completing collection
   */
  getCurrentMetrics(sessionId: string): PerformanceMetrics | undefined {
    const collector = this.manager.getCollector(sessionId);
    return collector ? collector.getMetrics() : undefined;
  }

  /**
   * Get historical performance data
   */
  getHistoricalMetrics(limit?: number): PerformanceMetrics[] {
    return this.manager.getHistoricalMetrics(limit);
  }

  /**
   * Generate performance report
   */
  generateReport(metrics?: PerformanceMetrics): PerformanceReport {
    return this.manager.generateReport(metrics);
  }

  /**
   * Display performance trends
   */
  displayTrends(limit: number = 10): void {
    const trends = this.getHistoricalMetrics(limit);

    if (trends.length === 0) {
      console.log('📈 No historical performance data available');
      return;
    }

    const tableData = {
      headers: ['Time', 'Duration', 'Success', 'Iterations/s', 'Memory'],
      rows: trends.map(trend => [
        trend.timestamp.toLocaleTimeString(),
        this.formatDuration(trend.executionTime),
        `${trend.successRate.toFixed(1)}%`,
        trend.iterationsPerSecond.toFixed(2),
        `${trend.resourceUsage.memoryUsage}MB`
      ])
    };

    console.log(this.formatter.table(tableData, {
      title: '📈 Performance Trends',
      borders: 'rounded',
      colors: {
        title: 'blue',
        headers: 'cyan',
        border: 'gray'
      }
    }));
  }

  /**
   * Display performance comparison
   */
  displayComparison(before: PerformanceMetrics, after: PerformanceMetrics): void {
    const improvements = {
      executionTime: ((before.executionTime - after.executionTime) / before.executionTime) * 100,
      successRate: after.successRate - before.successRate,
      responseTime: ((before.averageResponseTime - after.averageResponseTime) / before.averageResponseTime) * 100,
      memoryUsage: ((before.resourceUsage.memoryUsage - after.resourceUsage.memoryUsage) / before.resourceUsage.memoryUsage) * 100
    };

    const comparisonData = [
      ['Metric', 'Before', 'After', 'Change'],
      [
        'Execution Time',
        this.formatDuration(before.executionTime),
        this.formatDuration(after.executionTime),
        `${improvements.executionTime >= 0 ? '↓' : '↑'}${Math.abs(improvements.executionTime).toFixed(1)}%`
      ],
      [
        'Success Rate',
        `${before.successRate.toFixed(1)}%`,
        `${after.successRate.toFixed(1)}%`,
        `${improvements.successRate >= 0 ? '↑' : '↓'}${Math.abs(improvements.successRate).toFixed(1)}%`
      ],
      [
        'Response Time',
        this.formatDuration(before.averageResponseTime),
        this.formatDuration(after.averageResponseTime),
        `${improvements.responseTime >= 0 ? '↓' : '↑'}${Math.abs(improvements.responseTime).toFixed(1)}%`
      ],
      [
        'Memory Usage',
        `${before.resourceUsage.memoryUsage}MB`,
        `${after.resourceUsage.memoryUsage}MB`,
        `${improvements.memoryUsage >= 0 ? '↓' : '↑'}${Math.abs(improvements.memoryUsage).toFixed(1)}%`
      ]
    ];

    console.log(this.formatter.table(
      { headers: comparisonData[0], rows: comparisonData.slice(1) },
      {
        title: '📊 Performance Comparison',
        borders: 'rounded',
        colors: {
          title: 'blue',
          headers: 'cyan',
          border: 'gray'
        }
      }
    ));
  }

  /**
   * Utility methods
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  private getPerformanceIcon(successRate: number): string {
    if (successRate >= 95) return '🚀';
    if (successRate >= 85) return '✅';
    if (successRate >= 70) return '⚠️';
    return '❌';
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Decorator for measuring function execution time
 */
export function measurePerformance(
  sessionId: string,
  operation: string,
  integration?: PerformanceIntegration
) {
  const perf = integration || new PerformanceIntegration();

  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      perf.startTiming(sessionId, operation);

      try {
        const result = await originalMethod.apply(this, args);
        perf.recordIteration(sessionId, true, perf.endTiming(sessionId, operation));
        return result;
      } catch (error) {
        perf.recordIteration(sessionId, false, perf.endTiming(sessionId, operation));
        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Higher-order function for wrapping async operations with performance monitoring
 */
export function withPerformanceMonitoring<T extends (...args: any[]) => Promise<any>>(
  sessionId: string,
  operation: string,
  fn: T,
  integration?: PerformanceIntegration
): T {
  const perf = integration || new PerformanceIntegration();

  return (async (...args: any[]) => {
    perf.startTiming(sessionId, operation);

    try {
      const result = await fn(...args);
      perf.recordIteration(sessionId, true, perf.endTiming(sessionId, operation));
      return result;
    } catch (error) {
      perf.recordIteration(sessionId, false, perf.endTiming(sessionId, operation));
      throw error;
    }
  }) as T;
}

export default PerformanceIntegration;