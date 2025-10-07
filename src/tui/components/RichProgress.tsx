/**
 * RichProgress Component for juno-task-ts
 *
 * Enhanced progress display matching Python Rich library aesthetics.
 * Provides animated progress bars, real-time statistics, and multi-level progress tracking.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';

export interface SubProgress {
  name: string;
  progress: number; // 0-100
  status: 'pending' | 'running' | 'completed' | 'error' | 'paused';
  rate?: number; // items per second
  eta?: Date;
  details?: string;
}

export interface RichProgressProps {
  /** Main progress title */
  title: string;
  /** Total number of items to process */
  total: number;
  /** Current number of items completed */
  current: number;
  /** Processing rate (items per second) */
  rate?: number;
  /** Estimated time of completion */
  eta?: Date;
  /** Overall status */
  status: 'running' | 'completed' | 'error' | 'paused';
  /** Sub-task progress list */
  subtasks?: SubProgress[];
  /** Color scheme */
  colors?: {
    bar: string;
    background: string;
    text: string;
    status: string;
  };
  /** Progress bar width in characters */
  barWidth?: number;
  /** Show detailed statistics */
  showDetails?: boolean;
  /** Show ETA and rate information */
  showStats?: boolean;
  /** Animation enabled */
  animated?: boolean;
  /** Update interval for animations (ms) */
  updateInterval?: number;
}

export const RichProgress: React.FC<RichProgressProps> = ({
  title,
  total,
  current,
  rate,
  eta,
  status,
  subtasks = [],
  colors = {
    bar: 'blue',
    background: 'gray',
    text: 'white',
    status: 'green'
  },
  barWidth = 40,
  showDetails = true,
  showStats = true,
  animated = true,
  updateInterval = 100
}) => {
  const [animationFrame, setAnimationFrame] = useState(0);
  const [startTime] = useState(Date.now());

  // Animation loop for smooth progress updates
  useEffect(() => {
    if (!animated) return;

    const interval = setInterval(() => {
      setAnimationFrame(prev => (prev + 1) % 4);
    }, updateInterval);

    return () => clearInterval(interval);
  }, [animated, updateInterval]);

  // Calculate percentage
  const percentage = useMemo(() => {
    if (total === 0) return 0;
    return Math.min(100, Math.max(0, (current / total) * 100));
  }, [current, total]);

  // Calculate filled portion of progress bar
  const filledWidth = useMemo(() => {
    return Math.round((percentage / 100) * barWidth);
  }, [percentage, barWidth]);

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

  // Calculate elapsed time
  const elapsedTime = useMemo(() => {
    return Date.now() - startTime;
  }, [startTime, animationFrame]);

  // Format rate
  const formatRate = useCallback((rate: number): string => {
    if (rate >= 1000) {
      return `${(rate / 1000).toFixed(1)}k/s`;
    } else if (rate >= 1) {
      return `${rate.toFixed(1)}/s`;
    } else {
      return `${(rate * 60).toFixed(1)}/min`;
    }
  }, []);

  // Format ETA
  const formatETA = useCallback((eta: Date): string => {
    const now = new Date();
    const diff = eta.getTime() - now.getTime();

    if (diff <= 0) return 'Now';

    return formatDuration(diff);
  }, [formatDuration]);

  // Get status icon and color
  const getStatusDisplay = useCallback((status: string) => {
    switch (status) {
      case 'running':
        // Animated spinner
        const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        return {
          icon: animated ? spinners[animationFrame % spinners.length] : '▶',
          color: 'blue'
        };
      case 'completed':
        return { icon: '✅', color: 'green' };
      case 'error':
        return { icon: '❌', color: 'red' };
      case 'paused':
        return { icon: '⏸️', color: 'yellow' };
      default:
        return { icon: '⏳', color: 'gray' };
    }
  }, [animated, animationFrame]);

  // Create progress bar with animation
  const createProgressBar = useCallback((percent: number, width: number, status: string) => {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;

    let filledChar = '█';
    let emptyChar = '░';

    // Add animation effects for running status
    if (animated && status === 'running') {
      const gradientChars = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
      const animOffset = animationFrame % gradientChars.length;

      // Create gradient effect at the progress edge
      if (filled > 0 && filled < width) {
        const gradientChar = gradientChars[animOffset];
        return (
          <Text>
            <Text color={colors.bar}>{filledChar.repeat(Math.max(0, filled - 1))}</Text>
            <Text color={colors.bar}>{gradientChar}</Text>
            <Text color={colors.background}>{emptyChar.repeat(empty)}</Text>
          </Text>
        );
      }
    }

    return (
      <Text>
        <Text color={colors.bar}>{filledChar.repeat(filled)}</Text>
        <Text color={colors.background}>{emptyChar.repeat(empty)}</Text>
      </Text>
    );
  }, [animated, animationFrame, colors]);

  const mainStatusDisplay = getStatusDisplay(status);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
      {/* Main progress header */}
      <Box flexDirection="row" marginBottom={1}>
        <Text color={mainStatusDisplay.color} bold>
          {mainStatusDisplay.icon} {title}
        </Text>
        {showStats && (
          <Text color="dim" marginLeft={2}>
            {current}/{total} ({percentage.toFixed(1)}%)
          </Text>
        )}
      </Box>

      {/* Main progress bar */}
      <Box flexDirection="row" marginBottom={1}>
        <Box marginRight={1}>
          {createProgressBar(percentage, barWidth, status)}
        </Box>
        <Text color={colors.text}>
          {percentage.toFixed(1)}%
        </Text>
      </Box>

      {/* Statistics */}
      {showStats && (showDetails || rate || eta) && (
        <Box flexDirection="row" marginBottom={1}>
          <Text color="dim">
            Elapsed: {formatDuration(elapsedTime)}
          </Text>
          {rate && (
            <Text color="dim" marginLeft={2}>
              Rate: {formatRate(rate)}
            </Text>
          )}
          {eta && (
            <Text color="dim" marginLeft={2}>
              ETA: {formatETA(eta)}
            </Text>
          )}
        </Box>
      )}

      {/* Subtasks */}
      {subtasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="dim" bold>Subtasks:</Text>
          {subtasks.map((subtask, index) => {
            const subtaskStatus = getStatusDisplay(subtask.status);
            const subtaskBar = createProgressBar(subtask.progress, Math.max(20, barWidth - 15), subtask.status);

            return (
              <Box key={index} flexDirection="column" marginLeft={2} marginTop={1}>
                <Box flexDirection="row">
                  <Text color={subtaskStatus.color}>
                    {subtaskStatus.icon} {subtask.name}
                  </Text>
                  {showDetails && (
                    <Text color="dim" marginLeft={1}>
                      ({subtask.progress.toFixed(1)}%)
                    </Text>
                  )}
                </Box>

                <Box flexDirection="row" marginTop={0.5}>
                  {subtaskBar}
                  {subtask.details && (
                    <Text color="dim" marginLeft={1}>
                      {subtask.details}
                    </Text>
                  )}
                </Box>

                {showStats && (subtask.rate || subtask.eta) && (
                  <Box flexDirection="row" marginTop={0.5}>
                    {subtask.rate && (
                      <Text color="dim">
                        {formatRate(subtask.rate)}
                      </Text>
                    )}
                    {subtask.eta && (
                      <Text color="dim" marginLeft={2}>
                        ETA: {formatETA(subtask.eta)}
                      </Text>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Summary stats */}
      {showDetails && subtasks.length > 0 && (
        <Box marginTop={1} borderTopStyle="single" paddingTop={1}>
          <Text color="dim">
            Total: {subtasks.filter(s => s.status === 'completed').length}/{subtasks.length} subtasks completed
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default RichProgress;