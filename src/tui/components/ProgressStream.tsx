/**
 * ProgressStream Component for juno-task-ts
 *
 * Real-time progress streaming display that integrates with MCP progress updates.
 * Shows live tool execution progress, metrics, and interactive controls.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { RichProgress, type SubProgress } from './RichProgress.js';
import type {
  ProgressStreamUpdate,
  ExecutionMetrics,
  ProgressStreamManager
} from '../../mcp/advanced/progress-stream.js';

export interface ProgressStreamProps {
  /** Progress stream manager instance */
  streamManager: ProgressStreamManager;
  /** Session ID to monitor */
  sessionId: string;
  /** Show detailed metrics */
  showMetrics?: boolean;
  /** Show individual tool progress */
  showToolProgress?: boolean;
  /** Allow cancellation via Escape key */
  allowCancellation?: boolean;
  /** Callback when user requests cancellation */
  onCancel?: () => Promise<boolean>;
  /** Callback for stream completion */
  onComplete?: (metrics: ExecutionMetrics) => void;
  /** Maximum number of recent updates to display */
  maxRecentUpdates?: number;
}

interface ToolProgress {
  name: string;
  progress: number;
  status: 'pending' | 'running' | 'completed' | 'error';
  duration?: number;
  message?: string;
  error?: string;
}

export const ProgressStream: React.FC<ProgressStreamProps> = ({
  streamManager,
  sessionId,
  showMetrics = true,
  showToolProgress = true,
  allowCancellation = true,
  onCancel,
  onComplete,
  maxRecentUpdates = 10
}) => {
  const [metrics, setMetrics] = useState<ExecutionMetrics | null>(null);
  const [recentUpdates, setRecentUpdates] = useState<ProgressStreamUpdate[]>([]);
  const [toolProgress, setToolProgress] = useState<Map<string, ToolProgress>>(new Map());
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStartTime] = useState(Date.now());

  // Handle keyboard input
  useInput((input, key) => {
    if (allowCancellation && key.escape && onCancel) {
      onCancel();
    }
  });

  // Subscribe to progress updates
  useEffect(() => {
    if (!streamManager) return;

    const handleProgressUpdate = (update: ProgressStreamUpdate) => {
      if (update.sessionId !== sessionId) return;

      // Update recent updates list
      setRecentUpdates(prev => {
        const newUpdates = [...prev, update].slice(-maxRecentUpdates);
        return newUpdates;
      });

      // Handle different update types
      switch (update.type) {
        case 'stream_start':
          setIsStreaming(true);
          break;

        case 'stream_end':
          setIsStreaming(false);
          if (onComplete && metrics) {
            onComplete(metrics);
          }
          break;

        case 'tool_start':
          if (update.data.toolName) {
            setToolProgress(prev => new Map(prev.set(update.data.toolName!, {
              name: update.data.toolName!,
              progress: 0,
              status: 'running',
              message: update.data.message
            })));
          }
          break;

        case 'tool_progress':
          if (update.data.toolName && update.data.progress !== undefined) {
            setToolProgress(prev => {
              const current = prev.get(update.data.toolName!) || {
                name: update.data.toolName!,
                progress: 0,
                status: 'running'
              };
              return new Map(prev.set(update.data.toolName!, {
                ...current,
                progress: update.data.progress!,
                message: update.data.message
              }));
            });
          }
          break;

        case 'tool_complete':
          if (update.data.toolName) {
            setToolProgress(prev => {
              const current = prev.get(update.data.toolName!) || {
                name: update.data.toolName!,
                progress: 0,
                status: 'running'
              };
              return new Map(prev.set(update.data.toolName!, {
                ...current,
                progress: 100,
                status: update.data.error ? 'error' : 'completed',
                duration: update.data.duration,
                error: update.data.error
              }));
            });
          }
          break;

        case 'iteration_start':
        case 'iteration_complete':
          // These are handled by the metrics updates
          break;
      }
    };

    const handleMetricsUpdate = (updatedSessionId: string, newMetrics: ExecutionMetrics) => {
      if (updatedSessionId === sessionId) {
        setMetrics(newMetrics);
      }
    };

    // Add listeners
    streamManager.onProgressUpdate(handleProgressUpdate);
    streamManager.on('metricsUpdate', handleMetricsUpdate);

    // Get initial metrics
    const initialMetrics = streamManager.getMetrics(sessionId);
    if (initialMetrics) {
      setMetrics(initialMetrics);
    }

    // Check if already streaming
    setIsStreaming(streamManager.isStreaming(sessionId));

    // Cleanup
    return () => {
      streamManager.removeProgressCallback(handleProgressUpdate);
      streamManager.removeListener('metricsUpdate', handleMetricsUpdate);
    };
  }, [streamManager, sessionId, maxRecentUpdates, onComplete, metrics]);

  // Calculate overall progress
  const overallProgress = useMemo(() => {
    if (!metrics) return 0;

    if (metrics.totalIterations && metrics.currentIteration) {
      return (metrics.currentIteration / metrics.totalIterations) * 100;
    }

    // Fallback to tool completion rate
    if (metrics.toolCalls > 0) {
      return (metrics.successfulCalls / metrics.toolCalls) * 100;
    }

    return 0;
  }, [metrics]);

  // Calculate estimated completion time
  const estimatedCompletion = useMemo(() => {
    if (!metrics || !metrics.totalIterations || !metrics.currentIteration) return null;

    const remaining = metrics.totalIterations - metrics.currentIteration;
    if (remaining <= 0 || metrics.operationsPerSecond <= 0) return null;

    const estimatedSeconds = remaining / metrics.operationsPerSecond;
    return new Date(Date.now() + estimatedSeconds * 1000);
  }, [metrics]);

  // Format duration
  const formatDuration = useCallback((ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }, []);

  // Convert tool progress to SubProgress format
  const subtasks: SubProgress[] = useMemo(() => {
    return Array.from(toolProgress.values()).map(tool => ({
      name: tool.name,
      progress: tool.progress,
      status: tool.status === 'running' ? 'running' :
               tool.status === 'completed' ? 'completed' :
               tool.status === 'error' ? 'error' : 'pending',
      details: tool.message || (tool.error ? `Error: ${tool.error}` : undefined)
    }));
  }, [toolProgress]);

  // Main progress display
  const mainStatus = isStreaming ? 'running' : 'completed';
  const elapsedTime = Date.now() - streamStartTime;

  return (
    <Box flexDirection="column">
      {/* Main Progress Display */}
      <RichProgress
        title={`Session ${sessionId}`}
        total={metrics?.totalIterations || 100}
        current={metrics?.currentIteration || Math.floor(overallProgress)}
        rate={metrics?.operationsPerSecond}
        eta={estimatedCompletion}
        status={mainStatus}
        subtasks={showToolProgress ? subtasks : undefined}
        showDetails={showMetrics}
        showStats={showMetrics}
        animated={isStreaming}
      />

      {/* Detailed Metrics */}
      {showMetrics && metrics && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" padding={1}>
          <Text color="gray" bold>📊 Execution Metrics</Text>

          <Box flexDirection="row" marginTop={1}>
            <Box flexDirection="column" marginRight={3}>
              <Text color="white">Tool Calls: {metrics.toolCalls}</Text>
              <Text color="green">Successful: {metrics.successfulCalls}</Text>
              <Text color="red">Failed: {metrics.failedCalls}</Text>
            </Box>

            <Box flexDirection="column" marginRight={3}>
              <Text color="white">Avg Response: {metrics.averageResponseTime.toFixed(0)}ms</Text>
              <Text color="white">Rate: {metrics.operationsPerSecond.toFixed(1)}/s</Text>
              <Text color="white">Elapsed: {formatDuration(elapsedTime)}</Text>
            </Box>

            {metrics.totalIterations && (
              <Box flexDirection="column">
                <Text color="white">Iterations: {metrics.currentIteration || 0}/{metrics.totalIterations}</Text>
                <Text color="white">Success Rate: {metrics.toolCalls > 0 ? ((metrics.successfulCalls / metrics.toolCalls) * 100).toFixed(1) : 0}%</Text>
                {estimatedCompletion && (
                  <Text color="blue">ETA: {estimatedCompletion.toLocaleTimeString()}</Text>
                )}
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Recent Updates */}
      {recentUpdates.length > 0 && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="blue" padding={1}>
          <Text color="blue" bold>📝 Recent Updates</Text>
          {recentUpdates.slice(-5).map((update, index) => (
            <Box key={index} flexDirection="row" marginTop={0.5}>
              <Text color="dim">[{update.timestamp.toLocaleTimeString()}]</Text>
              <Text marginLeft={1} color={
                update.type.includes('error') ? 'red' :
                update.type.includes('complete') ? 'green' :
                update.type.includes('start') ? 'blue' : 'white'
              }>
                {update.data.message || `${update.type.replace('_', ' ')}`}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Controls */}
      {allowCancellation && isStreaming && (
        <Box marginTop={1} borderTopStyle="single" paddingTop={1}>
          <Text color="dim">
            Press Esc to cancel execution
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default ProgressStream;