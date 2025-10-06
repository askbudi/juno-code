/**
 * @fileoverview Comprehensive tests for the metrics module
 * Tests for MetricsCollector, PerformanceTracker, StatisticsCalculator, and MetricsReporter
 * Target: 98% coverage for src/core/metrics.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  MetricsCollector,
  PerformanceTracker,
  StatisticsCalculator,
  MetricsReporter,
  createMetricsCollector,
  createMetricsReporter,
  type ToolCallMetrics,
  type SessionMetrics,
  type SystemMetrics,
  type PerformanceRecommendation,
  type MetricsExportOptions,
} from '../metrics.js';

// Mock filesystem for export tests
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

describe('MetricsCollector', () => {
  let metricsCollector: MetricsCollector;

  beforeEach(() => {
    metricsCollector = createMetricsCollector();
  });

  afterEach(() => {
    metricsCollector.dispose();
  });

  describe('initialization', () => {
    it('should create a metrics collector instance', () => {
      expect(metricsCollector).toBeInstanceOf(MetricsCollector);
    });

    it('should initialize with default system metrics', () => {
      const systemMetrics = metricsCollector.getSystemMetrics();
      expect(systemMetrics).toBeDefined();
      expect(systemMetrics.memoryUsage).toBeDefined();
      expect(systemMetrics.networkMetrics).toBeDefined();
      expect(systemMetrics.fileSystemMetrics).toBeDefined();
    });

    it('should emit events on startup', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('collection_started', eventSpy);

      metricsCollector.startCollection();

      expect(eventSpy).toHaveBeenCalledWith({
        timestamp: expect.any(Date)
      });
    });
  });

  describe('collection control', () => {
    it('should start and stop collection', () => {
      expect(() => {
        metricsCollector.startCollection();
        metricsCollector.stopCollection();
      }).not.toThrow();
    });

    it('should not start collection if already collecting', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('collection_started', eventSpy);

      metricsCollector.startCollection();
      metricsCollector.startCollection(); // Second call should be ignored

      expect(eventSpy).toHaveBeenCalledTimes(1);
    });

    it('should not stop collection if not collecting', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('collection_stopped', eventSpy);

      metricsCollector.stopCollection(); // Should not emit event

      expect(eventSpy).not.toHaveBeenCalled();
    });

    it('should emit stop event when stopping collection', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('collection_stopped', eventSpy);

      metricsCollector.startCollection();
      metricsCollector.stopCollection();

      expect(eventSpy).toHaveBeenCalledWith({
        timestamp: expect.any(Date)
      });
    });
  });

  describe('session management', () => {
    it('should track session metrics', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      const sessionMetrics = metricsCollector.getSessionMetrics('test-session');
      expect(sessionMetrics).toBeDefined();
      expect(sessionMetrics?.sessionId).toBe('test-session');
      expect(sessionMetrics?.subagent).toBe('claude');
      expect(sessionMetrics?.workingDirectory).toBe('/test/dir');
      expect(sessionMetrics?.status).toBe('running');
      expect(sessionMetrics?.iterations).toBe(0);
      expect(sessionMetrics?.toolCalls).toBe(0);
    });

    it('should track session with model', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir', 'gpt-4');

      const sessionMetrics = metricsCollector.getSessionMetrics('test-session');
      expect(sessionMetrics?.model).toBe('gpt-4');
    });

    it('should emit session started event', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('session_started', eventSpy);

      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session',
          subagent: 'claude',
          workingDirectory: '/test/dir'
        })
      );
    });

    it('should update session metrics', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      metricsCollector.updateSession('test-session', {
        iterations: 5,
        toolCalls: 10,
        successCount: 8,
        errorCount: 2
      });

      const sessionMetrics = metricsCollector.getSessionMetrics('test-session');
      expect(sessionMetrics?.iterations).toBe(5);
      expect(sessionMetrics?.toolCalls).toBe(10);
      expect(sessionMetrics?.successCount).toBe(8);
      expect(sessionMetrics?.errorCount).toBe(2);
    });

    it('should ignore updates for non-existent sessions', () => {
      expect(() => {
        metricsCollector.updateSession('non-existent', { iterations: 1 });
      }).not.toThrow();
    });

    it('should calculate duration when session has end time', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      const endTime = new Date(Date.now() + 5000);
      metricsCollector.updateSession('test-session', { endTime });

      const sessionMetrics = metricsCollector.getSessionMetrics('test-session');
      expect(sessionMetrics?.duration).toBeGreaterThan(0);
    });

    it('should track peak memory usage', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      const initialMetrics = metricsCollector.getSessionMetrics('test-session');
      const initialPeak = initialMetrics?.peakMemoryUsage || 0;

      // Trigger memory update
      metricsCollector.updateSession('test-session', { iterations: 1 });

      const updatedMetrics = metricsCollector.getSessionMetrics('test-session');
      expect(updatedMetrics?.peakMemoryUsage).toBeGreaterThanOrEqual(initialPeak);
    });

    it('should emit session updated event', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('session_updated', eventSpy);

      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.updateSession('test-session', { iterations: 1 });

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session',
          iterations: 1
        })
      );
    });

    it('should end session and calculate final metrics', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      // Add some tool calls
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 200,
        success: false,
        error: 'Test error',
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      metricsCollector.endSession('test-session', 'completed');

      const sessionMetrics = metricsCollector.getSessionMetrics('test-session');
      expect(sessionMetrics?.status).toBe('completed');
      expect(sessionMetrics?.endTime).toBeDefined();
      expect(sessionMetrics?.duration).toBeGreaterThan(0);
      expect(sessionMetrics?.toolCalls).toBe(2);
      expect(sessionMetrics?.avgToolCallDuration).toBe(150);
      expect(sessionMetrics?.successCount).toBe(1);
      expect(sessionMetrics?.errorCount).toBe(1);
      expect(sessionMetrics?.successRate).toBe(0.5);
    });

    it('should handle ending non-existent session', () => {
      expect(() => {
        metricsCollector.endSession('non-existent', 'completed');
      }).not.toThrow();
    });

    it('should emit session ended event', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('session_ended', eventSpy);

      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.endSession('test-session', 'completed');

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session',
          status: 'completed'
        })
      );
    });

    it('should handle session with no tool calls', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.endSession('test-session', 'completed');

      const sessionMetrics = metricsCollector.getSessionMetrics('test-session');
      expect(sessionMetrics?.toolCalls).toBe(0);
      expect(sessionMetrics?.avgToolCallDuration).toBe(0);
      expect(sessionMetrics?.successRate).toBe(0);
    });

    it('should get all session metrics', () => {
      metricsCollector.startSession('session-1', 'claude', '/test/dir1');
      metricsCollector.startSession('session-2', 'cursor', '/test/dir2');

      const allSessions = metricsCollector.getAllSessionMetrics();
      expect(allSessions).toHaveLength(2);
      expect(allSessions.map(s => s.sessionId)).toContain('session-1');
      expect(allSessions.map(s => s.sessionId)).toContain('session-2');
    });
  });

  describe('tool call recording', () => {
    beforeEach(() => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');
    });

    it('should record tool call metrics', () => {
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      const toolStats = metricsCollector.getToolStatistics();
      expect(toolStats['test_tool']).toBeDefined();
      expect(toolStats['test_tool'].totalCalls).toBe(1);
      expect(toolStats['test_tool'].successfulCalls).toBe(1);
    });

    it('should generate unique call IDs and timestamps', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('tool_call_recorded', eventSpy);

      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: expect.any(String),
          timestamp: expect.any(Date),
          name: 'test_tool'
        })
      );
    });

    it('should update network metrics for network calls', () => {
      metricsCollector.recordToolCall({
        name: 'network_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
        networkLatency: 50,
      });

      const systemMetrics = metricsCollector.getSystemMetrics();
      expect(systemMetrics.networkMetrics.totalRequests).toBe(1);
      expect(systemMetrics.networkMetrics.successfulRequests).toBe(1);
    });

    it('should track failed network calls', () => {
      metricsCollector.recordToolCall({
        name: 'network_tool',
        duration: 100,
        success: false,
        error: 'Network error',
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
        networkLatency: 50,
      });

      const systemMetrics = metricsCollector.getSystemMetrics();
      expect(systemMetrics.networkMetrics.totalRequests).toBe(1);
      expect(systemMetrics.networkMetrics.failedRequests).toBe(1);
    });

    it('should record tool calls with all optional fields', () => {
      metricsCollector.recordToolCall({
        name: 'complex_tool',
        duration: 150,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
        parameters: { param1: 'value1' },
        resultPreview: 'Success result',
        networkLatency: 25,
        rateLimitInfo: {
          remaining: 100,
          resetTime: new Date(),
          waitTime: 0
        }
      });

      const toolStats = metricsCollector.getToolStatistics();
      expect(toolStats['complex_tool'].totalCalls).toBe(1);
    });

    it('should emit tool call recorded event', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('tool_call_recorded', eventSpy);

      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test_tool',
          duration: 100,
          success: true
        })
      );
    });
  });

  describe('performance timing', () => {
    it('should record performance timing for config load', () => {
      metricsCollector.recordPerformanceTiming('config_load', 150);

      const systemMetrics = metricsCollector.getSystemMetrics();
      expect(systemMetrics.configLoadTime).toBe(150);
    });

    it('should record performance timing for template generation', () => {
      metricsCollector.recordPerformanceTiming('template_generation', 200);

      const systemMetrics = metricsCollector.getSystemMetrics();
      expect(systemMetrics.templateGenerationTime).toBe(200);
    });

    it('should record performance timing for CLI response', () => {
      metricsCollector.recordPerformanceTiming('cli_response', 50);

      const systemMetrics = metricsCollector.getSystemMetrics();
      expect(systemMetrics.cliResponseTime).toBe(50);
    });

    it('should emit performance recorded event', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('performance_recorded', eventSpy);

      const metadata = { operation: 'test' };
      metricsCollector.recordPerformanceTiming('custom_op', 100, metadata);

      expect(eventSpy).toHaveBeenCalledWith({
        operationName: 'custom_op',
        duration: 100,
        metadata,
        timestamp: expect.any(Date)
      });
    });

    it('should handle unknown operation types', () => {
      expect(() => {
        metricsCollector.recordPerformanceTiming('unknown_op', 100);
      }).not.toThrow();
    });
  });

  describe('analytics reporting', () => {
    beforeEach(() => {
      // Set up test data
      metricsCollector.startSession('session-1', 'claude', '/test/dir1');
      metricsCollector.startSession('session-2', 'cursor', '/test/dir2');

      metricsCollector.recordToolCall({
        name: 'tool_a',
        duration: 100,
        success: true,
        sessionId: 'session-1',
        iteration: 1,
        subagent: 'claude',
      });

      metricsCollector.recordToolCall({
        name: 'tool_b',
        duration: 200,
        success: false,
        error: 'Test error',
        sessionId: 'session-2',
        iteration: 1,
        subagent: 'cursor',
      });

      metricsCollector.endSession('session-1', 'completed');
      metricsCollector.endSession('session-2', 'failed');
    });

    it('should generate comprehensive analytics report', () => {
      const report = metricsCollector.getAnalyticsReport();

      expect(report).toBeDefined();
      expect(report.summary.totalSessions).toBe(2);
      expect(report.summary.totalToolCalls).toBe(2);
      expect(report.summary.totalIterations).toBe(0); // No iterations set
      expect(report.summary.overallSuccessRate).toBe(0.5);
      expect(report.summary.totalErrors).toBe(1);
    });

    it('should generate analytics report with time range filter', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);

      const report = metricsCollector.getAnalyticsReport({
        start: oneHourAgo,
        end: now
      });

      expect(report.timeRange.start).toEqual(oneHourAgo);
      expect(report.timeRange.end).toEqual(now);
    });

    it('should calculate session statistics by subagent', () => {
      const report = metricsCollector.getAnalyticsReport();

      expect(report.sessionStatsBySubagent.claude).toBeDefined();
      expect(report.sessionStatsBySubagent.cursor).toBeDefined();
      expect(report.sessionStatsBySubagent.claude.count).toBe(1);
      expect(report.sessionStatsBySubagent.cursor.count).toBe(1);
    });

    it('should include tool statistics in report', () => {
      const report = metricsCollector.getAnalyticsReport();

      expect(report.toolStatistics.tool_a).toBeDefined();
      expect(report.toolStatistics.tool_b).toBeDefined();
      expect(report.toolStatistics.tool_a.successRate).toBe(1);
      expect(report.toolStatistics.tool_b.successRate).toBe(0);
    });

    it('should include system performance in report', () => {
      const report = metricsCollector.getAnalyticsReport();

      expect(report.systemPerformance).toBeDefined();
      expect(report.systemPerformance.memoryUsage).toBeDefined();
      expect(report.systemPerformance.networkMetrics).toBeDefined();
    });

    it('should include performance recommendations', () => {
      const report = metricsCollector.getAnalyticsReport();

      expect(report.recommendations).toBeDefined();
      expect(Array.isArray(report.recommendations)).toBe(true);
    });

    it('should calculate resource usage correctly', () => {
      const report = metricsCollector.getAnalyticsReport();

      expect(report.resourceUsage.peakMemory).toBeGreaterThan(0);
      expect(report.resourceUsage.avgMemory).toBeGreaterThan(0);
      expect(typeof report.resourceUsage.cpuUtilization).toBe('number');
      expect(typeof report.resourceUsage.networkUtilization).toBe('number');
    });

    it('should handle empty data gracefully', () => {
      const emptyCollector = createMetricsCollector();
      const report = emptyCollector.getAnalyticsReport();

      expect(report.summary.totalSessions).toBe(0);
      expect(report.summary.totalToolCalls).toBe(0);
      expect(report.summary.overallSuccessRate).toBe(0);

      emptyCollector.dispose();
    });
  });

  describe('system metrics', () => {
    it('should emit system metrics updated event', () => {
      const eventSpy = vi.fn();
      metricsCollector.on('system_metrics_updated', eventSpy);

      metricsCollector.startCollection();

      // Wait for at least one system metrics update
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(eventSpy).toHaveBeenCalled();
          resolve();
        }, 1100); // Wait slightly longer than the 1s initial delay
      });
    });

    it('should get current system metrics', () => {
      const systemMetrics = metricsCollector.getSystemMetrics();

      expect(systemMetrics.timestamp).toBeInstanceOf(Date);
      expect(systemMetrics.memoryUsage.total).toBeGreaterThan(0);
      expect(systemMetrics.memoryUsage.percentage).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cleanup', () => {
    it('should clear all metrics data', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      const eventSpy = vi.fn();
      metricsCollector.on('metrics_cleared', eventSpy);

      metricsCollector.clearMetrics();

      expect(metricsCollector.getAllSessionMetrics()).toHaveLength(0);
      expect(Object.keys(metricsCollector.getToolStatistics())).toHaveLength(0);
      expect(eventSpy).toHaveBeenCalledWith({
        timestamp: expect.any(Date)
      });
    });

    it('should dispose properly', () => {
      expect(() => {
        metricsCollector.dispose();
      }).not.toThrow();

      // Verify that the collector is no longer collecting after disposal
      const eventSpy = vi.fn();
      metricsCollector.on('collection_started', eventSpy);

      // This should not start collection since disposed
      metricsCollector.startCollection();
      expect(eventSpy).not.toHaveBeenCalled();
    });
  });
});

describe('PerformanceTracker', () => {
  let tracker: PerformanceTracker;

  beforeEach(() => {
    tracker = new PerformanceTracker();
  });

  afterEach(() => {
    tracker.dispose();
  });

  describe('timing operations', () => {
    it('should track operation timing', () => {
      const timing = tracker.startTiming('test-operation');
      expect(timing).toBeDefined();
      expect(timing.startTime).toBeGreaterThan(0);
      expect(timing.memoryBefore).toBeGreaterThan(0);

      // Simulate some work
      const result = tracker.endTiming('test-operation');
      expect(result).toBeDefined();
      expect(result?.duration).toBeGreaterThan(0);
      expect(result?.endTime).toBeGreaterThan(result?.startTime || 0);
      expect(typeof result?.memoryDelta).toBe('number');
    });

    it('should return null for unknown operations', () => {
      const result = tracker.endTiming('unknown-operation');
      expect(result).toBeNull();
    });

    it('should handle multiple concurrent operations', () => {
      const timing1 = tracker.startTiming('op1');
      const timing2 = tracker.startTiming('op2');

      expect(timing1).toBeDefined();
      expect(timing2).toBeDefined();

      const result1 = tracker.endTiming('op1');
      const result2 = tracker.endTiming('op2');

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result1?.duration).toBeGreaterThan(0);
      expect(result2?.duration).toBeGreaterThan(0);
    });

    it('should create performance marks and measures', () => {
      const marksSpy = vi.spyOn(performance, 'mark');
      const measureSpy = vi.spyOn(performance, 'measure');

      tracker.startTiming('test-op');
      tracker.endTiming('test-op');

      expect(marksSpy).toHaveBeenCalledWith('test-op-start');
      expect(marksSpy).toHaveBeenCalledWith('test-op-end');
      expect(measureSpy).toHaveBeenCalledWith('test-op', 'test-op-start', 'test-op-end');

      marksSpy.mockRestore();
      measureSpy.mockRestore();
    });
  });

  describe('statistics calculation', () => {
    it('should calculate statistics for completed operations', () => {
      tracker.startTiming('op1');
      tracker.endTiming('op1');

      tracker.startTiming('op2');
      tracker.endTiming('op2');

      const stats = tracker.getStatistics();
      expect(stats.totalOperations).toBe(2);
      expect(stats.avgDuration).toBeGreaterThan(0);
      expect(stats.minDuration).toBeGreaterThan(0);
      expect(stats.maxDuration).toBeGreaterThan(0);
      expect(stats.p95Duration).toBeGreaterThan(0);
      expect(stats.p99Duration).toBeGreaterThan(0);
      expect(typeof stats.avgMemoryDelta).toBe('number');
    });

    it('should return zero statistics when no operations completed', () => {
      const stats = tracker.getStatistics();
      expect(stats.totalOperations).toBe(0);
      expect(stats.avgDuration).toBe(0);
      expect(stats.minDuration).toBe(0);
      expect(stats.maxDuration).toBe(0);
      expect(stats.p95Duration).toBe(0);
      expect(stats.p99Duration).toBe(0);
      expect(stats.avgMemoryDelta).toBe(0);
    });

    it('should calculate percentiles correctly', () => {
      // Add multiple operations to test percentile calculation
      for (let i = 0; i < 10; i++) {
        tracker.startTiming(`op${i}`);
        tracker.endTiming(`op${i}`);
      }

      const stats = tracker.getStatistics();
      expect(stats.totalOperations).toBe(10);
      expect(stats.p95Duration).toBeGreaterThanOrEqual(stats.avgDuration);
      expect(stats.p99Duration).toBeGreaterThanOrEqual(stats.p95Duration);
    });
  });

  describe('cleanup', () => {
    it('should clear timing data', () => {
      tracker.startTiming('op1');
      tracker.endTiming('op1');

      tracker.clear();

      const stats = tracker.getStatistics();
      expect(stats.totalOperations).toBe(0);
    });

    it('should clear performance marks and measures', () => {
      const clearMarksSpy = vi.spyOn(performance, 'clearMarks');
      const clearMeasuresSpy = vi.spyOn(performance, 'clearMeasures');

      tracker.clear();

      expect(clearMarksSpy).toHaveBeenCalled();
      expect(clearMeasuresSpy).toHaveBeenCalled();

      clearMarksSpy.mockRestore();
      clearMeasuresSpy.mockRestore();
    });

    it('should dispose properly', () => {
      const clearSpy = vi.spyOn(tracker, 'clear');

      tracker.dispose();

      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });
  });
});

describe('StatisticsCalculator', () => {
  describe('percentile calculation', () => {
    it('should calculate percentiles correctly', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const percentiles = StatisticsCalculator.calculatePercentiles(values, [50, 95, 99]);

      expect(percentiles.p50).toBeCloseTo(5.5);
      expect(percentiles.p95).toBeCloseTo(9.55);
      expect(percentiles.p99).toBeCloseTo(9.91);
    });

    it('should handle empty values array', () => {
      const percentiles = StatisticsCalculator.calculatePercentiles([], [50, 95, 99]);
      expect(percentiles).toEqual({});
    });

    it('should handle single value', () => {
      const percentiles = StatisticsCalculator.calculatePercentiles([5], [50, 95, 99]);
      expect(percentiles.p50).toBe(5);
      expect(percentiles.p95).toBe(5);
      expect(percentiles.p99).toBe(5);
    });

    it('should handle edge case percentiles', () => {
      const values = [1, 2, 3];
      const percentiles = StatisticsCalculator.calculatePercentiles(values, [0, 100]);
      expect(percentiles.p0).toBe(1);
      expect(percentiles.p100).toBe(3);
    });

    it('should handle percentiles beyond array bounds', () => {
      const values = [1, 2];
      const percentiles = StatisticsCalculator.calculatePercentiles(values, [99]);
      expect(percentiles.p99).toBe(2);
    });
  });

  describe('tool statistics calculation', () => {
    it('should calculate comprehensive tool statistics', () => {
      const toolCalls: ToolCallMetrics[] = [
        {
          name: 'tool1',
          callId: '1',
          timestamp: new Date('2024-01-01T10:00:00Z'),
          duration: 100,
          success: true,
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
        {
          name: 'tool1',
          callId: '2',
          timestamp: new Date('2024-01-01T11:00:00Z'),
          duration: 200,
          success: false,
          error: 'Test error',
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
        {
          name: 'tool1',
          callId: '3',
          timestamp: new Date('2024-01-01T12:00:00Z'),
          duration: 150,
          success: true,
          sessionId: 'session1',
          iteration: 2,
          subagent: 'claude',
        },
      ];

      const stats = StatisticsCalculator.calculateToolStatistics(toolCalls);

      expect(stats.tool1).toBeDefined();
      expect(stats.tool1.totalCalls).toBe(3);
      expect(stats.tool1.successfulCalls).toBe(2);
      expect(stats.tool1.failedCalls).toBe(1);
      expect(stats.tool1.successRate).toBeCloseTo(2/3);
      expect(stats.tool1.avgDuration).toBeCloseTo(150);
      expect(stats.tool1.minDuration).toBe(100);
      expect(stats.tool1.maxDuration).toBe(200);
      expect(stats.tool1.totalDuration).toBe(450);
    });

    it('should track usage patterns by hour', () => {
      const toolCalls: ToolCallMetrics[] = [
        {
          name: 'tool1',
          callId: '1',
          timestamp: new Date('2024-01-01T10:00:00Z'), // Hour 10
          duration: 100,
          success: true,
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
        {
          name: 'tool1',
          callId: '2',
          timestamp: new Date('2024-01-01T10:30:00Z'), // Hour 10
          duration: 150,
          success: true,
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
      ];

      const stats = StatisticsCalculator.calculateToolStatistics(toolCalls);

      expect(stats.tool1.usagePattern).toHaveLength(24);
      expect(stats.tool1.usagePattern[10].calls).toBe(2);
      expect(stats.tool1.usagePattern[0].calls).toBe(0);
    });

    it('should track common errors', () => {
      const toolCalls: ToolCallMetrics[] = [
        {
          name: 'tool1',
          callId: '1',
          timestamp: new Date(),
          duration: 100,
          success: false,
          error: 'Error A',
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
        {
          name: 'tool1',
          callId: '2',
          timestamp: new Date(),
          duration: 100,
          success: false,
          error: 'Error A',
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
        {
          name: 'tool1',
          callId: '3',
          timestamp: new Date(),
          duration: 100,
          success: false,
          error: 'Error B',
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
      ];

      const stats = StatisticsCalculator.calculateToolStatistics(toolCalls);

      expect(stats.tool1.commonErrors).toHaveLength(2);
      expect(stats.tool1.commonErrors[0].error).toBe('Error A');
      expect(stats.tool1.commonErrors[0].count).toBe(2);
      expect(stats.tool1.commonErrors[1].error).toBe('Error B');
      expect(stats.tool1.commonErrors[1].count).toBe(1);
    });

    it('should limit common errors to top 5', () => {
      const toolCalls: ToolCallMetrics[] = [];

      // Create 10 different errors
      for (let i = 0; i < 10; i++) {
        toolCalls.push({
          name: 'tool1',
          callId: `${i}`,
          timestamp: new Date(),
          duration: 100,
          success: false,
          error: `Error ${i}`,
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        });
      }

      const stats = StatisticsCalculator.calculateToolStatistics(toolCalls);

      expect(stats.tool1.commonErrors).toHaveLength(5);
    });

    it('should calculate percentiles for tool durations', () => {
      const toolCalls: ToolCallMetrics[] = [];

      // Create calls with known durations
      for (let i = 1; i <= 100; i++) {
        toolCalls.push({
          name: 'tool1',
          callId: `${i}`,
          timestamp: new Date(),
          duration: i,
          success: true,
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        });
      }

      const stats = StatisticsCalculator.calculateToolStatistics(toolCalls);

      expect(stats.tool1.p95Duration).toBeCloseTo(95, 1);
      expect(stats.tool1.p99Duration).toBeCloseTo(99, 1);
    });

    it('should handle multiple tools', () => {
      const toolCalls: ToolCallMetrics[] = [
        {
          name: 'tool1',
          callId: '1',
          timestamp: new Date(),
          duration: 100,
          success: true,
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
        {
          name: 'tool2',
          callId: '2',
          timestamp: new Date(),
          duration: 200,
          success: true,
          sessionId: 'session1',
          iteration: 1,
          subagent: 'claude',
        },
      ];

      const stats = StatisticsCalculator.calculateToolStatistics(toolCalls);

      expect(Object.keys(stats)).toHaveLength(2);
      expect(stats.tool1.totalCalls).toBe(1);
      expect(stats.tool2.totalCalls).toBe(1);
    });

    it('should handle empty tool calls array', () => {
      const stats = StatisticsCalculator.calculateToolStatistics([]);
      expect(stats).toEqual({});
    });
  });

  describe('performance recommendations', () => {
    it('should generate slow tool call recommendations', () => {
      const sessionMetrics: SessionMetrics[] = [];
      const toolStatistics = {
        'slow_tool': {
          name: 'slow_tool',
          totalCalls: 10,
          successfulCalls: 10,
          failedCalls: 0,
          successRate: 1,
          minDuration: 5000,
          maxDuration: 8000,
          avgDuration: 6000, // 6 seconds - should trigger recommendation
          p95Duration: 7500,
          p99Duration: 8000,
          totalDuration: 60000,
          firstCall: new Date(),
          lastCall: new Date(),
          commonErrors: [],
          usagePattern: Array.from({ length: 24 }, (_, i) => ({ hour: i, calls: 0 })),
        }
      };
      const systemMetrics: SystemMetrics = {
        timestamp: new Date(),
        startupTime: 0,
        configLoadTime: 0,
        templateGenerationTime: 0,
        cliResponseTime: 0,
        cpuUsage: 50,
        memoryUsage: {
          total: 8000000000,
          free: 4000000000,
          used: 4000000000,
          percentage: 50,
          heapUsed: 100000000,
          heapTotal: 200000000,
          external: 50000000,
        },
        networkMetrics: {
          totalRequests: 10,
          successfulRequests: 10,
          failedRequests: 0,
          avgResponseTime: 100,
          totalBytesTransferred: 10000,
        },
        fileSystemMetrics: {
          totalOperations: 5,
          readOperations: 3,
          writeOperations: 2,
          avgOperationTime: 50,
        },
      };

      const recommendations = StatisticsCalculator.generateRecommendations(
        sessionMetrics,
        toolStatistics,
        systemMetrics
      );

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].type).toBe('performance');
      expect(recommendations[0].title).toContain('slow_tool');
      expect(recommendations[0].severity).toBe('medium');
    });

    it('should generate high failure rate recommendations', () => {
      const sessionMetrics: SessionMetrics[] = [];
      const toolStatistics = {
        'unreliable_tool': {
          name: 'unreliable_tool',
          totalCalls: 20,
          successfulCalls: 10,
          failedCalls: 10,
          successRate: 0.5, // 50% success rate - should trigger recommendation
          minDuration: 100,
          maxDuration: 200,
          avgDuration: 150,
          p95Duration: 190,
          p99Duration: 200,
          totalDuration: 3000,
          firstCall: new Date(),
          lastCall: new Date(),
          commonErrors: [],
          usagePattern: Array.from({ length: 24 }, (_, i) => ({ hour: i, calls: 0 })),
        }
      };
      const systemMetrics: SystemMetrics = {
        timestamp: new Date(),
        startupTime: 0,
        configLoadTime: 0,
        templateGenerationTime: 0,
        cliResponseTime: 0,
        cpuUsage: 50,
        memoryUsage: {
          total: 8000000000,
          free: 4000000000,
          used: 4000000000,
          percentage: 50,
          heapUsed: 100000000,
          heapTotal: 200000000,
          external: 50000000,
        },
        networkMetrics: {
          totalRequests: 10,
          successfulRequests: 10,
          failedRequests: 0,
          avgResponseTime: 100,
          totalBytesTransferred: 10000,
        },
        fileSystemMetrics: {
          totalOperations: 5,
          readOperations: 3,
          writeOperations: 2,
          avgOperationTime: 50,
        },
      };

      const recommendations = StatisticsCalculator.generateRecommendations(
        sessionMetrics,
        toolStatistics,
        systemMetrics
      );

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].type).toBe('reliability');
      expect(recommendations[0].title).toContain('unreliable_tool');
      expect(recommendations[0].severity).toBe('high');
    });

    it('should generate memory usage recommendations', () => {
      const sessionMetrics: SessionMetrics[] = [];
      const toolStatistics = {};
      const systemMetrics: SystemMetrics = {
        timestamp: new Date(),
        startupTime: 0,
        configLoadTime: 0,
        templateGenerationTime: 0,
        cliResponseTime: 0,
        cpuUsage: 50,
        memoryUsage: {
          total: 8000000000,
          free: 400000000,
          used: 7600000000,
          percentage: 95, // 95% memory usage - should trigger recommendation
          heapUsed: 100000000,
          heapTotal: 200000000,
          external: 50000000,
        },
        networkMetrics: {
          totalRequests: 10,
          successfulRequests: 10,
          failedRequests: 0,
          avgResponseTime: 100,
          totalBytesTransferred: 10000,
        },
        fileSystemMetrics: {
          totalOperations: 5,
          readOperations: 3,
          writeOperations: 2,
          avgOperationTime: 50,
        },
      };

      const recommendations = StatisticsCalculator.generateRecommendations(
        sessionMetrics,
        toolStatistics,
        systemMetrics
      );

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].type).toBe('performance');
      expect(recommendations[0].severity).toBe('critical');
      expect(recommendations[0].title).toContain('memory usage');
    });

    it('should generate long session duration recommendations', () => {
      const sessionMetrics: SessionMetrics[] = [
        {
          sessionId: 'long-session',
          startTime: new Date(),
          duration: 600000, // 10 minutes - should trigger recommendation
          status: 'completed',
          iterations: 5,
          toolCalls: 10,
          successCount: 8,
          errorCount: 2,
          warningCount: 0,
          successRate: 0.8,
          avgIterationDuration: 120000,
          avgToolCallDuration: 60000,
          totalThinkingTime: 300000,
          peakMemoryUsage: 100000000,
          avgMemoryUsage: 80000000,
          currentMemoryUsage: 90000000,
          subagent: 'claude',
          workingDirectory: '/test',
        }
      ];
      const toolStatistics = {};
      const systemMetrics: SystemMetrics = {
        timestamp: new Date(),
        startupTime: 0,
        configLoadTime: 0,
        templateGenerationTime: 0,
        cliResponseTime: 0,
        cpuUsage: 50,
        memoryUsage: {
          total: 8000000000,
          free: 4000000000,
          used: 4000000000,
          percentage: 50,
          heapUsed: 100000000,
          heapTotal: 200000000,
          external: 50000000,
        },
        networkMetrics: {
          totalRequests: 10,
          successfulRequests: 10,
          failedRequests: 0,
          avgResponseTime: 100,
          totalBytesTransferred: 10000,
        },
        fileSystemMetrics: {
          totalOperations: 5,
          readOperations: 3,
          writeOperations: 2,
          avgOperationTime: 50,
        },
      };

      const recommendations = StatisticsCalculator.generateRecommendations(
        sessionMetrics,
        toolStatistics,
        systemMetrics
      );

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].type).toBe('efficiency');
      expect(recommendations[0].title).toContain('Long session durations');
    });

    it('should generate multiple recommendations', () => {
      const sessionMetrics: SessionMetrics[] = [
        {
          sessionId: 'session',
          startTime: new Date(),
          duration: 600000, // Long duration
          status: 'completed',
          iterations: 5,
          toolCalls: 10,
          successCount: 8,
          errorCount: 2,
          warningCount: 0,
          successRate: 0.8,
          avgIterationDuration: 120000,
          avgToolCallDuration: 60000,
          totalThinkingTime: 300000,
          peakMemoryUsage: 100000000,
          avgMemoryUsage: 80000000,
          currentMemoryUsage: 90000000,
          subagent: 'claude',
          workingDirectory: '/test',
        }
      ];
      const toolStatistics = {
        'problematic_tool': {
          name: 'problematic_tool',
          totalCalls: 20,
          successfulCalls: 10,
          failedCalls: 10,
          successRate: 0.5, // High failure rate
          minDuration: 100,
          maxDuration: 200,
          avgDuration: 8000, // Also slow
          p95Duration: 190,
          p99Duration: 200,
          totalDuration: 3000,
          firstCall: new Date(),
          lastCall: new Date(),
          commonErrors: [],
          usagePattern: Array.from({ length: 24 }, (_, i) => ({ hour: i, calls: 0 })),
        }
      };
      const systemMetrics: SystemMetrics = {
        timestamp: new Date(),
        startupTime: 0,
        configLoadTime: 0,
        templateGenerationTime: 0,
        cliResponseTime: 0,
        cpuUsage: 50,
        memoryUsage: {
          total: 8000000000,
          free: 400000000,
          used: 7600000000,
          percentage: 95, // High memory usage
          heapUsed: 100000000,
          heapTotal: 200000000,
          external: 50000000,
        },
        networkMetrics: {
          totalRequests: 10,
          successfulRequests: 10,
          failedRequests: 0,
          avgResponseTime: 100,
          totalBytesTransferred: 10000,
        },
        fileSystemMetrics: {
          totalOperations: 5,
          readOperations: 3,
          writeOperations: 2,
          avgOperationTime: 50,
        },
      };

      const recommendations = StatisticsCalculator.generateRecommendations(
        sessionMetrics,
        toolStatistics,
        systemMetrics
      );

      expect(recommendations.length).toBeGreaterThan(1);

      // Should have performance, reliability, and efficiency recommendations
      const types = recommendations.map(r => r.type);
      expect(types).toContain('performance');
      expect(types).toContain('reliability');
      expect(types).toContain('efficiency');
    });

    it('should not generate recommendations for good performance', () => {
      const sessionMetrics: SessionMetrics[] = [
        {
          sessionId: 'good-session',
          startTime: new Date(),
          duration: 60000, // 1 minute - acceptable
          status: 'completed',
          iterations: 5,
          toolCalls: 10,
          successCount: 10,
          errorCount: 0,
          warningCount: 0,
          successRate: 1.0,
          avgIterationDuration: 12000,
          avgToolCallDuration: 6000,
          totalThinkingTime: 30000,
          peakMemoryUsage: 100000000,
          avgMemoryUsage: 80000000,
          currentMemoryUsage: 90000000,
          subagent: 'claude',
          workingDirectory: '/test',
        }
      ];
      const toolStatistics = {
        'good_tool': {
          name: 'good_tool',
          totalCalls: 20,
          successfulCalls: 20,
          failedCalls: 0,
          successRate: 1.0, // Perfect success rate
          minDuration: 100,
          maxDuration: 200,
          avgDuration: 150, // Fast
          p95Duration: 190,
          p99Duration: 200,
          totalDuration: 3000,
          firstCall: new Date(),
          lastCall: new Date(),
          commonErrors: [],
          usagePattern: Array.from({ length: 24 }, (_, i) => ({ hour: i, calls: 0 })),
        }
      };
      const systemMetrics: SystemMetrics = {
        timestamp: new Date(),
        startupTime: 0,
        configLoadTime: 0,
        templateGenerationTime: 0,
        cliResponseTime: 0,
        cpuUsage: 50,
        memoryUsage: {
          total: 8000000000,
          free: 4000000000,
          used: 4000000000,
          percentage: 50, // Good memory usage
          heapUsed: 100000000,
          heapTotal: 200000000,
          external: 50000000,
        },
        networkMetrics: {
          totalRequests: 10,
          successfulRequests: 10,
          failedRequests: 0,
          avgResponseTime: 100,
          totalBytesTransferred: 10000,
        },
        fileSystemMetrics: {
          totalOperations: 5,
          readOperations: 3,
          writeOperations: 2,
          avgOperationTime: 50,
        },
      };

      const recommendations = StatisticsCalculator.generateRecommendations(
        sessionMetrics,
        toolStatistics,
        systemMetrics
      );

      expect(recommendations).toHaveLength(0);
    });
  });
});

describe('MetricsReporter', () => {
  let metricsCollector: MetricsCollector;
  let reporter: MetricsReporter;

  beforeEach(() => {
    metricsCollector = createMetricsCollector();
    reporter = createMetricsReporter(metricsCollector);
  });

  afterEach(() => {
    metricsCollector.dispose();
  });

  describe('report generation', () => {
    it('should generate comprehensive analytics report', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      const report = reporter.generateVerboseReport();
      expect(report).toContain('COMPREHENSIVE ANALYTICS REPORT');
      expect(report).toContain('SUMMARY STATISTICS');
      expect(report).toContain('TOOL USAGE STATISTICS');
      expect(report).toContain('SYSTEM PERFORMANCE');
      expect(typeof report).toBe('string');
      expect(report.length).toBeGreaterThan(0);
    });

    it('should generate session-specific report', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir', 'gpt-4');
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });
      metricsCollector.endSession('test-session', 'completed');

      const report = reporter.generateVerboseReport('test-session');
      expect(report).toContain('SESSION PERFORMANCE REPORT');
      expect(report).toContain('test-session');
      expect(report).toContain('claude (gpt-4)');
      expect(report).toContain('EXECUTION METRICS');
      expect(report).toContain('MEMORY USAGE');
      expect(report).toContain('ERROR ANALYSIS');
    });

    it('should handle session-specific report for non-existent session', () => {
      const report = reporter.generateVerboseReport('non-existent-session');
      expect(report).toBe('');
    });

    it('should format duration correctly', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 75000, // 1m 15s
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      const report = reporter.generateVerboseReport();
      expect(report).toContain('1m 15s'); // Duration formatting
    });

    it('should format bytes correctly', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      const report = reporter.generateVerboseReport('test-session');
      expect(report).toMatch(/\d+\.\d+ [KMGT]?B/); // Byte formatting
    });

    it('should include tool statistics in comprehensive report', () => {
      metricsCollector.startSession('session-1', 'claude', '/test/dir');
      metricsCollector.startSession('session-2', 'cursor', '/test/dir');

      // Add multiple tool calls
      for (let i = 0; i < 5; i++) {
        metricsCollector.recordToolCall({
          name: 'popular_tool',
          duration: 100 + i * 10,
          success: true,
          sessionId: 'session-1',
          iteration: i + 1,
          subagent: 'claude',
        });
      }

      metricsCollector.recordToolCall({
        name: 'another_tool',
        duration: 200,
        success: false,
        error: 'Test error',
        sessionId: 'session-2',
        iteration: 1,
        subagent: 'cursor',
      });

      const report = reporter.generateVerboseReport();
      expect(report).toContain('popular_tool');
      expect(report).toContain('Success Rate: 100.0%');
      expect(report).toContain('another_tool');
      expect(report).toContain('Success Rate: 0.0%');
    });

    it('should include performance recommendations', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      // Add a slow tool to trigger recommendations
      for (let i = 0; i < 10; i++) {
        metricsCollector.recordToolCall({
          name: 'slow_tool',
          duration: 6000, // 6 seconds - should trigger recommendation
          success: true,
          sessionId: 'test-session',
          iteration: i + 1,
          subagent: 'claude',
        });
      }

      const report = reporter.generateVerboseReport();
      expect(report).toContain('PERFORMANCE RECOMMENDATIONS');
    });
  });

  describe('metrics export', () => {
    const mockFs = fs as any;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should export metrics to JSON format', async () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      const exportOptions: MetricsExportOptions = {
        format: 'json',
        outputPath: '/test/metrics.json',
        includeRawData: true,
        includeSystemMetrics: true,
      };

      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await reporter.exportMetrics(exportOptions);

      expect(mockFs.mkdir).toHaveBeenCalledWith('/test', { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/metrics.json',
        expect.any(String),
        'utf-8'
      );

      // Verify JSON format
      const writeCall = mockFs.writeFile.mock.calls[0];
      expect(() => JSON.parse(writeCall[1])).not.toThrow();
    });

    it('should export metrics to CSV format', async () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      const exportOptions: MetricsExportOptions = {
        format: 'csv',
        outputPath: '/test/metrics.csv',
      };

      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await reporter.exportMetrics(exportOptions);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/metrics.csv',
        expect.stringContaining('Tool Name,Total Calls,Success Rate'),
        'utf-8'
      );
    });

    it('should export metrics with time range filter', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);

      metricsCollector.startSession('test-session', 'claude', '/test/dir');

      const exportOptions: MetricsExportOptions = {
        format: 'json',
        outputPath: '/test/metrics.json',
        timeRange: {
          start: oneHourAgo,
          end: now,
        },
      };

      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await reporter.exportMetrics(exportOptions);

      // Verify that export completed successfully
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should throw error for unsupported YAML format', async () => {
      const exportOptions: MetricsExportOptions = {
        format: 'yaml',
        outputPath: '/test/metrics.yaml',
      };

      await expect(reporter.exportMetrics(exportOptions)).rejects.toThrow(
        'YAML export not yet implemented'
      );
    });

    it('should throw error for unsupported format', async () => {
      const exportOptions: MetricsExportOptions = {
        format: 'xml' as any,
        outputPath: '/test/metrics.xml',
      };

      await expect(reporter.exportMetrics(exportOptions)).rejects.toThrow(
        'Unsupported export format: xml'
      );
    });
  });

  describe('formatting utilities', () => {
    it('should format durations correctly', () => {
      // Access private method for testing
      const formatDuration = (reporter as any).formatDuration;

      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(1500)).toBe('1.5s');
      expect(formatDuration(65000)).toBe('1m 5s');
      expect(formatDuration(3665000)).toBe('1h 1m');
    });

    it('should format bytes correctly', () => {
      // Access private method for testing
      const formatBytes = (reporter as any).formatBytes;

      expect(formatBytes(500)).toBe('500.0 B');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(1572864)).toBe('1.5 MB');
      expect(formatBytes(1610612736)).toBe('1.5 GB');
    });

    it('should convert analytics to CSV correctly', () => {
      metricsCollector.startSession('test-session', 'claude', '/test/dir');
      metricsCollector.recordToolCall({
        name: 'test_tool',
        duration: 100,
        success: true,
        sessionId: 'test-session',
        iteration: 1,
        subagent: 'claude',
      });

      const analyticsReport = metricsCollector.getAnalyticsReport();

      // Access private method for testing
      const convertToCSV = (reporter as any).convertToCSV;
      const csvData = convertToCSV(analyticsReport);

      expect(csvData).toContain('Tool Name,Total Calls,Success Rate');
      expect(csvData).toContain('test_tool,1,1');
    });
  });
});

describe('Convenience Functions', () => {
  describe('createMetricsCollector', () => {
    it('should create a MetricsCollector instance', () => {
      const collector = createMetricsCollector();
      expect(collector).toBeInstanceOf(MetricsCollector);
      collector.dispose();
    });
  });

  describe('createMetricsReporter', () => {
    it('should create a MetricsReporter instance', () => {
      const collector = createMetricsCollector();
      const reporter = createMetricsReporter(collector);
      expect(reporter).toBeInstanceOf(MetricsReporter);
      collector.dispose();
    });
  });
});