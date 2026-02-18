/**
 * Performance Dashboard TUI Component for juno-task-ts
 *
 * Interactive performance metrics display with real-time updates.
 * Provides comprehensive analytics view matching Python Rich aesthetics.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, Newline, useInput } from 'ink';
import { PerformanceMetrics, PerformanceReport, TimingBreakdown, ResourceMetrics } from '../../core/performance-collector.js';
import { RichFormatter } from '../../cli/utils/rich-formatter.js';

// ============================================================================
// Interfaces
// ============================================================================

export interface PerformanceDashboardProps {
  metrics?: PerformanceMetrics;
  report?: PerformanceReport;
  refreshInterval?: number; // milliseconds
  onClose?: () => void;
  showTrends?: boolean;
  showBreakdown?: boolean;
  showRecommendations?: boolean;
  interactive?: boolean;
}

interface DashboardView {
  name: string;
  component: React.FC<{ metrics?: PerformanceMetrics; report?: PerformanceReport }>;
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatPercentage(value: number, precision: number = 1): string {
  return `${value.toFixed(precision)}%`;
}

function getStatusColor(value: number, thresholds: { good: number; warning: number }): string {
  if (value >= thresholds.good) return 'green';
  if (value >= thresholds.warning) return 'yellow';
  return 'red';
}

function getPerformanceIcon(successRate: number): string {
  if (successRate >= 95) return '🚀';
  if (successRate >= 85) return '✅';
  if (successRate >= 70) return '⚠️';
  return '❌';
}

// ============================================================================
// Dashboard Components
// ============================================================================

const SummaryView: React.FC<{ metrics?: PerformanceMetrics; report?: PerformanceReport }> = ({ metrics, report }) => {
  const formatter = new RichFormatter();

  if (!metrics && !report?.summary) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No performance data available</Text>
      </Box>
    );
  }

  const data = metrics || report!.summary;
  const icon = getPerformanceIcon(data.successRate);

  return (
    <Box flexDirection="column">
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="blue">
          {icon} Performance Summary
        </Text>
        {data.sessionId && (
          <Text color="gray"> (Session: {data.sessionId.slice(0, 8)})</Text>
        )}
      </Box>

      {/* Main Metrics */}
      <Box flexDirection="row" marginBottom={1}>
        <Box width="50%" flexDirection="column">
          <Box justifyContent="space-between">
            <Text>Execution Time:</Text>
            <Text bold color="cyan">{formatDuration(data.executionTime)}</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text>Success Rate:</Text>
            <Text bold color={getStatusColor(data.successRate, { good: 90, warning: 70 })}>
              {formatPercentage(data.successRate)}
            </Text>
          </Box>
          <Box justifyContent="space-between">
            <Text>Iterations/sec:</Text>
            <Text bold color="magenta">{data.iterationsPerSecond.toFixed(2)}</Text>
          </Box>
        </Box>

        <Box width="50%" flexDirection="column">
          <Box justifyContent="space-between">
            <Text>Avg Response:</Text>
            <Text bold color="yellow">{formatDuration(data.averageResponseTime)}</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text>Memory Usage:</Text>
            <Text bold color={getStatusColor(500 - data.resourceUsage.memoryUsage, { good: 300, warning: 100 })}>
              {data.resourceUsage.memoryUsage}MB
            </Text>
          </Box>
          <Box justifyContent="space-between">
            <Text>CPU Usage:</Text>
            <Text bold color={getStatusColor(100 - data.resourceUsage.cpuUsage, { good: 70, warning: 50 })}>
              {formatPercentage(data.resourceUsage.cpuUsage)}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Progress Bar */}
      <Box marginBottom={1}>
        <Text>Overall Performance: </Text>
        <Text>
          {formatter.progressBar(data.successRate, {
            width: 30,
            colors: {
              completed: data.successRate >= 90 ? 'green' : data.successRate >= 70 ? 'yellow' : 'red',
              incomplete: 'gray',
              percentage: 'blue'
            }
          })}
        </Text>
      </Box>

      {/* Timestamp */}
      <Box>
        <Text color="gray">
          Last Updated: {data.timestamp.toLocaleTimeString()}
        </Text>
      </Box>
    </Box>
  );
};

const BreakdownView: React.FC<{ metrics?: PerformanceMetrics; report?: PerformanceReport }> = ({ metrics, report }) => {
  const formatter = new RichFormatter();

  if (!metrics && !report?.summary) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No breakdown data available</Text>
      </Box>
    );
  }

  const data = metrics || report!.summary;
  const breakdown = data.breakdown;
  const total = Object.values(breakdown).reduce((sum, time) => sum + time, 0);

  const breakdownData = Object.entries(breakdown)
    .filter(([_, time]) => time > 0)
    .sort(([_, a], [__, b]) => b - a)
    .map(([operation, time]) => ({
      operation: operation.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()),
      time: formatDuration(time),
      percentage: total > 0 ? (time / total) * 100 : 0,
      rawTime: time
    }));

  return (
    <Box flexDirection="column">
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="blue">⏱️  Timing Breakdown</Text>
      </Box>

      {/* Total Time */}
      <Box marginBottom={1}>
        <Text>Total Time: </Text>
        <Text bold color="cyan">{formatDuration(total)}</Text>
      </Box>

      {/* Breakdown Items */}
      {breakdownData.length > 0 ? (
        <Box flexDirection="column">
          {breakdownData.map(({ operation, time, percentage, rawTime }) => (
            <Box key={operation} marginBottom={0}>
              <Box width="20%">
                <Text>{operation}:</Text>
              </Box>
              <Box width="15%">
                <Text bold color="yellow">{time}</Text>
              </Box>
              <Box width="65%">
                <Text>
                  {formatter.progressBar(percentage, {
                    width: 20,
                    showPercentage: true,
                    colors: {
                      completed: rawTime > total * 0.3 ? 'red' : rawTime > total * 0.1 ? 'yellow' : 'green',
                      incomplete: 'gray',
                      percentage: 'blue'
                    }
                  })}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        <Text color="gray">No timing data recorded</Text>
      )}
    </Box>
  );
};

const TrendsView: React.FC<{ metrics?: PerformanceMetrics; report?: PerformanceReport }> = ({ metrics, report }) => {
  const formatter = new RichFormatter();

  if (!report?.trends || report.trends.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No trend data available</Text>
      </Box>
    );
  }

  const trends = report.trends.slice(0, 10); // Show last 10 sessions

  return (
    <Box flexDirection="column">
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="blue">📈 Performance Trends</Text>
      </Box>

      {/* Trend Table */}
      <Box flexDirection="column">
        {/* Header */}
        <Box marginBottom={1}>
          <Box width="15%"><Text bold color="gray">Time</Text></Box>
          <Box width="15%"><Text bold color="gray">Duration</Text></Box>
          <Box width="15%"><Text bold color="gray">Success</Text></Box>
          <Box width="15%"><Text bold color="gray">Response</Text></Box>
          <Box width="15%"><Text bold color="gray">Memory</Text></Box>
          <Box width="25%"><Text bold color="gray">Status</Text></Box>
        </Box>

        {/* Data Rows */}
        {trends.map((trend, index) => (
          <Box key={index} marginBottom={0}>
            <Box width="15%">
              <Text color="cyan">{trend.timestamp.toLocaleTimeString().slice(0, 5)}</Text>
            </Box>
            <Box width="15%">
              <Text>{formatDuration(trend.executionTime)}</Text>
            </Box>
            <Box width="15%">
              <Text color={getStatusColor(trend.successRate, { good: 90, warning: 70 })}>
                {formatPercentage(trend.successRate, 0)}
              </Text>
            </Box>
            <Box width="15%">
              <Text>{formatDuration(trend.averageResponseTime)}</Text>
            </Box>
            <Box width="15%">
              <Text>{trend.resourceUsage.memoryUsage}MB</Text>
            </Box>
            <Box width="25%">
              <Text>{getPerformanceIcon(trend.successRate)}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      {/* Comparison */}
      {report.comparison && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="blue">📊 Performance Comparison</Text>
          <Box marginTop={1}>
            <Text>Execution Time: </Text>
            <Text color={report.comparison.improvement.executionTime > 0 ? 'green' : 'red'}>
              {report.comparison.improvement.executionTime > 0 ? '↓' : '↑'}
              {Math.abs(report.comparison.improvement.executionTime).toFixed(1)}%
            </Text>
          </Box>
          <Box>
            <Text>Success Rate: </Text>
            <Text color={report.comparison.improvement.successRate > 0 ? 'green' : 'red'}>
              {report.comparison.improvement.successRate > 0 ? '↑' : '↓'}
              {Math.abs(report.comparison.improvement.successRate).toFixed(1)}%
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

const RecommendationsView: React.FC<{ metrics?: PerformanceMetrics; report?: PerformanceReport }> = ({ metrics, report }) => {
  if (!report?.recommendations || report.recommendations.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="green">✅ No performance issues detected</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="blue">💡 Performance Recommendations</Text>
      </Box>

      {/* Recommendations */}
      <Box flexDirection="column">
        {report.recommendations.map((recommendation, index) => (
          <Box key={index} marginBottom={1}>
            <Text color="yellow">• </Text>
            <Text>{recommendation}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

// ============================================================================
// Main Dashboard Component
// ============================================================================

export const PerformanceDashboard: React.FC<PerformanceDashboardProps> = ({
  metrics,
  report,
  refreshInterval = 1000,
  onClose,
  showTrends = true,
  showBreakdown = true,
  showRecommendations = true,
  interactive = true
}) => {
  const [currentView, setCurrentView] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  // Available views
  const views: DashboardView[] = [
    { name: 'Summary', component: SummaryView },
    ...(showBreakdown ? [{ name: 'Breakdown', component: BreakdownView }] : []),
    ...(showTrends ? [{ name: 'Trends', component: TrendsView }] : []),
    ...(showRecommendations ? [{ name: 'Recommendations', component: RecommendationsView }] : [])
  ];

  const CurrentComponent = views[currentView]?.component || SummaryView;

  // Handle keyboard input for navigation
  useInput((input, key) => {
    if (!interactive) return;

    if (key.escape || input === 'q') {
      onClose?.();
    } else if (key.leftArrow || input === 'h') {
      setCurrentView(prev => (prev > 0 ? prev - 1 : views.length - 1));
    } else if (key.rightArrow || input === 'l') {
      setCurrentView(prev => (prev < views.length - 1 ? prev + 1 : 0));
    } else if (input >= '1' && input <= views.length.toString()) {
      setCurrentView(parseInt(input) - 1);
    } else if (input === 'r') {
      setLastUpdate(new Date());
    }
  });

  // Auto-refresh
  useEffect(() => {
    if (!refreshInterval) return;

    const interval = setInterval(() => {
      setLastUpdate(new Date());
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [refreshInterval]);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="blue">🎯 Juno Task Performance Dashboard</Text>
        <Text color="gray">Updated: {lastUpdate.toLocaleTimeString()}</Text>
      </Box>

      {/* Navigation */}
      {interactive && views.length > 1 && (
        <Box marginBottom={1}>
          <Text color="gray">Views: </Text>
          {views.map((view, index) => (
            <React.Fragment key={view.name}>
              <Text color={index === currentView ? 'blue' : 'gray'} bold={index === currentView}>
                {index + 1}. {view.name}
              </Text>
              {index < views.length - 1 && <Text color="gray"> | </Text>}
            </React.Fragment>
          ))}
        </Box>
      )}

      {/* Current View */}
      <Box flexGrow={1}>
        <CurrentComponent metrics={metrics} report={report} />
      </Box>

      {/* Footer */}
      {interactive && (
        <Box marginTop={1}>
          <Text color="gray">
            Navigation: ←→ (or h/l) to switch views | 1-{views.length} for direct access | r to refresh | q to quit
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default PerformanceDashboard;