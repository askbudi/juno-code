/**
 * Tests for the metrics module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MetricsCollector,
  PerformanceTracker,
  StatisticsCalculator,
  MetricsReporter,
  createMetricsCollector,
  createMetricsReporter,
} from '../metrics';

describe('MetricsCollector', () => {
  let metricsCollector: MetricsCollector;

  beforeEach(() => {
    metricsCollector = createMetricsCollector();
  });

  afterEach(() => {
    metricsCollector.dispose();
  });

  it('should create a metrics collector instance', () => {
    expect(metricsCollector).toBeInstanceOf(MetricsCollector);
  });

  it('should start and stop collection', () => {
    expect(() => {
      metricsCollector.startCollection();
      metricsCollector.stopCollection();
    }).not.toThrow();
  });

  it('should track session metrics', () => {
    metricsCollector.startSession('test-session', 'claude', '/test/dir');

    const sessionMetrics = metricsCollector.getSessionMetrics('test-session');
    expect(sessionMetrics).toBeDefined();
    expect(sessionMetrics?.sessionId).toBe('test-session');
    expect(sessionMetrics?.subagent).toBe('claude');
    expect(sessionMetrics?.workingDirectory).toBe('/test/dir');
  });

  it('should record tool call metrics', () => {
    metricsCollector.startSession('test-session', 'claude', '/test/dir');

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

  it('should generate analytics report', () => {
    metricsCollector.startSession('test-session', 'claude', '/test/dir');

    metricsCollector.recordToolCall({
      name: 'test_tool',
      duration: 100,
      success: true,
      sessionId: 'test-session',
      iteration: 1,
      subagent: 'claude',
    });

    const report = metricsCollector.getAnalyticsReport();
    expect(report).toBeDefined();
    expect(report.summary.totalSessions).toBe(1);
    expect(report.summary.totalToolCalls).toBe(1);
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

  it('should track operation timing', () => {
    const timing = tracker.startTiming('test-operation');
    expect(timing).toBeDefined();
    expect(timing.startTime).toBeGreaterThan(0);

    // Simulate some work
    const result = tracker.endTiming('test-operation');
    expect(result).toBeDefined();
    expect(result?.duration).toBeGreaterThan(0);
  });

  it('should return null for unknown operations', () => {
    const result = tracker.endTiming('unknown-operation');
    expect(result).toBeNull();
  });

  it('should calculate statistics', () => {
    tracker.startTiming('op1');
    tracker.endTiming('op1');

    tracker.startTiming('op2');
    tracker.endTiming('op2');

    const stats = tracker.getStatistics();
    expect(stats.totalOperations).toBe(2);
    expect(stats.avgDuration).toBeGreaterThan(0);
  });
});

describe('StatisticsCalculator', () => {
  it('should calculate percentiles correctly', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const percentiles = StatisticsCalculator.calculatePercentiles(values, [50, 95, 99]);

    expect(percentiles.p50).toBeCloseTo(5.5);
    expect(percentiles.p95).toBeCloseTo(9.55);
    expect(percentiles.p99).toBeCloseTo(9.91);
  });

  it('should calculate tool statistics', () => {
    const toolCalls = [
      {
        name: 'tool1',
        callId: '1',
        timestamp: new Date(),
        duration: 100,
        success: true,
        sessionId: 'session1',
        iteration: 1,
        subagent: 'claude' as const,
      },
      {
        name: 'tool1',
        callId: '2',
        timestamp: new Date(),
        duration: 200,
        success: false,
        error: 'Test error',
        sessionId: 'session1',
        iteration: 1,
        subagent: 'claude' as const,
      },
    ];

    const stats = StatisticsCalculator.calculateToolStatistics(toolCalls);
    expect(stats.tool1).toBeDefined();
    expect(stats.tool1.totalCalls).toBe(2);
    expect(stats.tool1.successfulCalls).toBe(1);
    expect(stats.tool1.failedCalls).toBe(1);
    expect(stats.tool1.successRate).toBe(0.5);
    expect(stats.tool1.avgDuration).toBe(150);
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

  it('should generate verbose report', () => {
    metricsCollector.startSession('test-session', 'claude', '/test/dir');

    const report = reporter.generateVerboseReport();
    expect(report).toContain('COMPREHENSIVE ANALYTICS REPORT');
    expect(typeof report).toBe('string');
    expect(report.length).toBeGreaterThan(0);
  });

  it('should generate session-specific report', () => {
    metricsCollector.startSession('test-session', 'claude', '/test/dir');

    const report = reporter.generateVerboseReport('test-session');
    expect(report).toContain('SESSION PERFORMANCE REPORT');
    expect(report).toContain('test-session');
  });
});