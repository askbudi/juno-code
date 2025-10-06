# Metrics and Analytics Module

The metrics and analytics module provides comprehensive performance tracking, statistics collection, and analytics reporting for juno-task-ts executions. This module enables detailed monitoring of tool calls, session performance, system resource usage, and provides actionable optimization recommendations.

## Overview

The metrics system consists of four main components:

1. **MetricsCollector**: Central metrics collection and management
2. **PerformanceTracker**: High-resolution performance timing
3. **StatisticsCalculator**: Statistical analysis and calculations
4. **MetricsReporter**: Formatted reporting and data export

## Core Features

### Performance Metrics
- Execution timing (start, end, duration) for all operations
- Memory usage tracking and optimization insights
- CPU usage monitoring during execution
- Network latency and throughput for MCP calls
- File system operation performance

### Tool Call Metrics
- Tool call success/failure rates by subagent
- Tool call duration statistics (min, max, avg, p95, p99)
- Tool call frequency and patterns
- Error categorization and frequency
- Rate limit encounters and wait times

### Session Metrics
- Session duration and completion rates
- Iteration count statistics
- Progress event frequencies
- Session success patterns
- User interaction patterns

### System Metrics
- Application startup time
- Configuration loading performance
- Template generation timing
- CLI command response times
- Resource usage patterns

### Analytics and Reporting
- Success rate trends over time
- Performance optimization recommendations
- Error pattern analysis
- Usage pattern insights
- Comparative subagent performance

## Quick Start

### Basic Usage

```typescript
import { createMetricsCollector, createMetricsReporter } from 'juno-task-ts';

// Create metrics collector
const metricsCollector = createMetricsCollector();
const metricsReporter = createMetricsReporter(metricsCollector);

// Start collection
metricsCollector.startCollection();

// Start a session
metricsCollector.startSession('session-1', 'claude', '/path/to/project');

// Record tool calls
metricsCollector.recordToolCall({
  name: 'file_read',
  duration: 150,
  success: true,
  sessionId: 'session-1',
  iteration: 1,
  subagent: 'claude'
});

// Generate report
const report = metricsReporter.generateVerboseReport();
console.log(report);

// Export metrics
await metricsReporter.exportMetrics({
  format: 'json',
  outputPath: './metrics-export.json'
});
```

### Integration with Session Management

```typescript
import {
  createSessionManager,
  createMetricsCollector,
  MetricsEnabledSessionManager
} from 'juno-task-ts';

const config = {
  defaultSubagent: 'claude',
  defaultMaxIterations: 50,
  // ... other config
};

const sessionManager = await createSessionManager(config);
const metricsCollector = createMetricsCollector();

// Create enhanced session manager
const enhancedManager = new MetricsEnabledSessionManager(
  sessionManager,
  metricsCollector
);

// Use enhanced manager for automatic metrics collection
const session = await enhancedManager.createSession({
  name: 'My Task',
  subagent: 'claude',
  config,
  tags: ['development']
});
```

## API Reference

### MetricsCollector

The central metrics collection class that coordinates all metrics gathering.

#### Constructor
```typescript
const collector = new MetricsCollector();
```

#### Methods

##### `startCollection(): void`
Starts metrics collection including system monitoring.

##### `stopCollection(): void`
Stops metrics collection.

##### `startSession(sessionId: string, subagent: SubagentType, workingDirectory: string, model?: string): void`
Begins tracking metrics for a new session.

##### `recordToolCall(metrics: ToolCallMetrics): void`
Records a tool call with comprehensive metrics.

##### `endSession(sessionId: string, status: SessionStatus): void`
Ends session tracking and calculates final metrics.

##### `getAnalyticsReport(timeRange?: { start: Date; end: Date }): AnalyticsReport`
Generates a comprehensive analytics report.

##### `getToolStatistics(): Record<string, ToolCallStatistics>`
Returns aggregated tool usage statistics.

### PerformanceTracker

High-resolution performance timing for operations.

#### Methods

##### `startTiming(operationId: string): PerformanceTiming`
Starts timing an operation.

##### `endTiming(operationId: string): PerformanceTiming | null`
Ends timing and returns performance data.

##### `getStatistics(): PerformanceStatistics`
Returns aggregated performance statistics.

### StatisticsCalculator

Statistical analysis utilities.

#### Static Methods

##### `calculatePercentiles(values: number[], percentiles: number[]): Record<string, number>`
Calculates percentiles for a dataset.

##### `calculateToolStatistics(toolCalls: ToolCallMetrics[]): Record<string, ToolCallStatistics>`
Aggregates tool call metrics into statistics.

##### `generateRecommendations(sessionMetrics, toolStats, systemMetrics): PerformanceRecommendation[]`
Generates performance optimization recommendations.

### MetricsReporter

Formatted reporting and data export.

#### Methods

##### `generateVerboseReport(sessionId?: string): string`
Generates a formatted verbose statistics report.

##### `exportMetrics(options: MetricsExportOptions): Promise<void>`
Exports metrics to file in various formats.

## Data Types

### ToolCallMetrics
```typescript
interface ToolCallMetrics {
  name: string;
  callId: string;
  timestamp: Date;
  duration: number;
  success: boolean;
  error?: string;
  parameters?: Record<string, any>;
  resultPreview?: string;
  sessionId: string;
  iteration: number;
  subagent: SubagentType;
  networkLatency?: number;
  rateLimitInfo?: {
    remaining: number;
    resetTime: Date;
    waitTime?: number;
  };
}
```

### SessionMetrics
```typescript
interface SessionMetrics {
  sessionId: string;
  startTime: Date;
  endTime?: Date;
  duration: number;
  status: SessionStatus;
  iterations: number;
  toolCalls: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  avgIterationDuration: number;
  avgToolCallDuration: number;
  totalThinkingTime: number;
  peakMemoryUsage: number;
  avgMemoryUsage: number;
  currentMemoryUsage: number;
  subagent: SubagentType;
  model?: string;
  workingDirectory: string;
}
```

### AnalyticsReport
```typescript
interface AnalyticsReport {
  timestamp: Date;
  timeRange: { start: Date; end: Date };
  summary: {
    totalSessions: number;
    totalIterations: number;
    totalToolCalls: number;
    avgSessionDuration: number;
    overallSuccessRate: number;
    totalErrors: number;
  };
  toolStatistics: Record<string, ToolCallStatistics>;
  sessionStatsBySubagent: Record<SubagentType, SessionStats>;
  performanceTrends: PerformanceTrends;
  systemPerformance: SystemMetrics;
  recommendations: PerformanceRecommendation[];
  resourceUsage: ResourceUsage;
}
```

## Performance Recommendations

The system automatically generates performance recommendations based on observed metrics:

### Types of Recommendations

1. **Performance**: Slow operations, bottlenecks
2. **Reliability**: High failure rates, error patterns
3. **Efficiency**: Resource usage optimization
4. **Cost**: Resource consumption patterns

### Severity Levels

- **Critical**: Immediate attention required
- **High**: Should be addressed soon
- **Medium**: Improvement opportunity
- **Low**: Minor optimization

### Example Recommendations

```typescript
const recommendations = [
  {
    type: 'performance',
    severity: 'high',
    title: 'Slow file_read tool calls detected',
    description: 'The file_read tool has an average execution time of 3.2 seconds',
    impact: 'Each call adds significant latency to iterations',
    action: 'Consider implementing file caching or optimizing file access patterns'
  }
];
```

## Export Formats

### JSON Export
Complete metrics data in structured JSON format.

### CSV Export
Tabular data suitable for spreadsheet analysis.

### Custom Export
Extend the `MetricsReporter` class to implement custom export formats.

## Real-time Monitoring

```typescript
import { SessionMonitor } from 'juno-task-ts/examples/metrics-integration';

const monitor = new SessionMonitor(enhancedManager);

// Start real-time monitoring with 5-second updates
monitor.startMonitoring(5000);

// Stop monitoring
monitor.stopMonitoring();
```

## Integration Patterns

### Event-Driven Metrics

The metrics system integrates with the existing session management through events:

```typescript
sessionManager.on('session_created', (event) => {
  metricsCollector.startSession(/* ... */);
});

sessionManager.on('tool_call_completed', (event) => {
  metricsCollector.recordToolCall(/* ... */);
});
```

### Middleware Pattern

Create middleware for automatic metrics collection:

```typescript
class MetricsMiddleware {
  constructor(private metricsCollector: MetricsCollector) {}

  async wrapToolCall<T>(
    toolName: string,
    sessionId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const startTime = performance.now();
    let success = false;
    let error: string | undefined;
    let result: T;

    try {
      result = await fn();
      success = true;
      return result;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const duration = performance.now() - startTime;
      this.metricsCollector.recordToolCall({
        name: toolName,
        duration,
        success,
        error,
        sessionId,
        // ... other properties
      });
    }
  }
}
```

## Best Practices

### Performance
- Use the `PerformanceTracker` for high-resolution timing
- Collect metrics asynchronously to avoid blocking operations
- Implement sampling for high-frequency events if needed

### Memory Management
- Call `dispose()` on metrics collector when done
- Clear old metrics data periodically
- Monitor memory usage of the metrics system itself

### Data Retention
- Export historical data before clearing
- Implement rotation policies for long-running applications
- Consider database storage for large-scale deployments

### Error Handling
- Metrics collection should never break application flow
- Implement fallback mechanisms for metrics failures
- Log metrics errors separately from application errors

## Troubleshooting

### Common Issues

1. **High Memory Usage**: Clear metrics data more frequently
2. **Performance Impact**: Reduce collection frequency or implement sampling
3. **Export Failures**: Check file permissions and disk space
4. **Missing Data**: Verify event listeners are properly attached

### Debug Mode

Enable verbose metrics logging:

```typescript
metricsCollector.on('tool_call_recorded', (toolCall) => {
  console.debug('Tool call recorded:', toolCall);
});

metricsCollector.on('session_started', (session) => {
  console.debug('Session started:', session);
});
```

## Examples

See the complete integration example in `/examples/metrics-integration.ts` for detailed usage patterns and advanced features.

## Migration from Python Implementation

The TypeScript metrics module maintains compatibility with the Python budi-cli metrics patterns while providing enhanced functionality:

- **Tool Call Tracking**: Maintains the same verbose tool call display patterns
- **Statistics Format**: Compatible statistics calculation methods
- **Export Formats**: Similar JSON/CSV export capabilities
- **Performance Recommendations**: Enhanced recommendation engine
- **Real-time Monitoring**: New feature for live metrics display

The metrics data can be analyzed alongside Python budi-cli metrics for comparative analysis.