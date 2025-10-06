/**
 * ProgressBar Component for juno-task-ts TUI
 *
 * Visual progress indicator with customizable styling, labels, and
 * percentage display. Supports both determinate and indeterminate modes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import type { ProgressBarProps } from '../types.js';
import { PROGRESS_CHARS } from '../types.js';
import { useTUIContext } from '../apps/TUIApp.js';

/**
 * Progress bar component for showing completion status
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 100,
  label,
  showPercentage = true,
  width = 40,
  chars = PROGRESS_CHARS,
  disabled = false,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();

  // Normalize value to 0-100 percentage
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);
  const completedWidth = Math.floor((percentage / 100) * width);
  const remainingWidth = width - completedWidth;

  // Create progress bar visual
  const progressBar = chars.complete.repeat(completedWidth) + chars.incomplete.repeat(remainingWidth);

  // Format percentage display
  const percentageText = `${Math.round(percentage)}%`;

  // Headless mode fallback
  if (isHeadless) {
    return (
      <Box flexDirection="column">
        {label && <Text>{label}</Text>}
        <Text>
          Progress: {percentageText} ({value}/{max})
        </Text>
      </Box>
    );
  }

  // Disabled state
  if (disabled) {
    return (
      <Box flexDirection="column" data-testid={testId}>
        {label && (
          <Text color={theme.muted}>{label}</Text>
        )}
        <Box>
          <Text color={theme.muted}>{chars.incomplete.repeat(width)}</Text>
          {showPercentage && (
            <Text color={theme.muted}> {percentageText}</Text>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" data-testid={testId}>
      {/* Label */}
      {label && (
        <Box marginBottom={1}>
          <Text color={theme.text}>{label}</Text>
        </Box>
      )}

      {/* Progress bar */}
      <Box>
        <Text>
          <Text color={theme.success}>{chars.complete.repeat(completedWidth)}</Text>
          <Text color={theme.muted}>{chars.incomplete.repeat(remainingWidth)}</Text>
        </Text>
        {showPercentage && (
          <Text color={theme.text}> {percentageText}</Text>
        )}
      </Box>
    </Box>
  );
};

/**
 * Multi-step progress bar showing discrete steps
 */
export const StepProgressBar: React.FC<{
  steps: string[];
  currentStep: number;
  showLabels?: boolean;
  showStepNumbers?: boolean;
  testId?: string;
}> = ({
  steps,
  currentStep,
  showLabels = true,
  showStepNumbers = false,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();

  if (isHeadless) {
    return (
      <Box flexDirection="column">
        <Text>Progress: Step {currentStep + 1} of {steps.length}</Text>
        {showLabels && steps[currentStep] && (
          <Text>Current: {steps[currentStep]}</Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" data-testid={testId}>
      {/* Step indicators */}
      <Box>
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          const isPending = index > currentStep;

          let stepChar = '';
          let stepColor = theme.muted;

          if (isCompleted) {
            stepChar = '●';
            stepColor = theme.success;
          } else if (isCurrent) {
            stepChar = '◐';
            stepColor = theme.primary;
          } else {
            stepChar = '○';
            stepColor = theme.muted;
          }

          return (
            <Box key={index}>
              <Text color={stepColor}>{stepChar}</Text>
              {index < steps.length - 1 && (
                <Text color={theme.muted}>─</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Step labels */}
      {showLabels && (
        <Box marginTop={1}>
          <Text color={theme.text}>
            {showStepNumbers && `${currentStep + 1}. `}
            {steps[currentStep] || 'Complete'}
          </Text>
        </Box>
      )}

      {/* Progress summary */}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {currentStep} of {steps.length} completed
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Indeterminate progress bar with moving indicator
 */
export const IndeterminateProgressBar: React.FC<{
  label?: string;
  width?: number;
  speed?: number;
  testId?: string;
}> = ({
  label,
  width = 40,
  speed = 200,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();
  const [position, setPosition] = React.useState(0);
  const [direction, setDirection] = React.useState(1);

  React.useEffect(() => {
    if (isHeadless) return;

    const timer = setInterval(() => {
      setPosition((prev) => {
        const next = prev + direction;
        if (next >= width - 5) {
          setDirection(-1);
          return width - 5;
        }
        if (next <= 0) {
          setDirection(1);
          return 0;
        }
        return next;
      });
    }, speed);

    return () => clearInterval(timer);
  }, [direction, width, speed, isHeadless]);

  if (isHeadless) {
    return (
      <Box flexDirection="column">
        {label && <Text>{label}</Text>}
        <Text>Processing...</Text>
      </Box>
    );
  }

  const before = PROGRESS_CHARS.incomplete.repeat(position);
  const indicator = PROGRESS_CHARS.complete.repeat(5);
  const after = PROGRESS_CHARS.incomplete.repeat(width - position - 5);

  return (
    <Box flexDirection="column" data-testid={testId}>
      {label && (
        <Box marginBottom={1}>
          <Text color={theme.text}>{label}</Text>
        </Box>
      )}
      <Box>
        <Text color={theme.muted}>{before}</Text>
        <Text color={theme.primary}>{indicator}</Text>
        <Text color={theme.muted}>{after}</Text>
      </Box>
    </Box>
  );
};

/**
 * Circular progress indicator (text-based approximation)
 */
export const CircularProgress: React.FC<{
  value: number;
  max?: number;
  label?: string;
  size?: 'small' | 'medium' | 'large';
  testId?: string;
}> = ({
  value,
  max = 100,
  label,
  size = 'medium',
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

  const sizeConfig = {
    small: { frames: ['○', '◔', '◐', '◕', '●'], width: 1 },
    medium: { frames: ['○○○', '●○○', '●●○', '●●●'], width: 3 },
    large: { frames: ['○○○○○', '●○○○○', '●●○○○', '●●●○○', '●●●●○', '●●●●●'], width: 5 }
  };

  const config = sizeConfig[size];
  const frameIndex = Math.floor((percentage / 100) * (config.frames.length - 1));
  const currentFrame = config.frames[frameIndex];

  if (isHeadless) {
    return (
      <Box flexDirection="column">
        {label && <Text>{label}</Text>}
        <Text>Progress: {Math.round(percentage)}%</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center" data-testid={testId}>
      <Text color={theme.primary}>{currentFrame}</Text>
      <Text color={theme.text}>{Math.round(percentage)}%</Text>
      {label && (
        <Text color={theme.muted}>{label}</Text>
      )}
    </Box>
  );
};

/**
 * File transfer progress bar with speed indicator
 */
export const FileProgressBar: React.FC<{
  bytesTransferred: number;
  totalBytes: number;
  filename?: string;
  speed?: number; // bytes per second
  estimatedTimeRemaining?: number; // seconds
  testId?: string;
}> = ({
  bytesTransferred,
  totalBytes,
  filename,
  speed,
  estimatedTimeRemaining,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();

  const formatBytes = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const formatSpeed = (bytesPerSecond: number): string => {
    return `${formatBytes(bytesPerSecond)}/s`;
  };

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
  };

  const percentage = totalBytes > 0 ? (bytesTransferred / totalBytes) * 100 : 0;

  if (isHeadless) {
    return (
      <Box flexDirection="column">
        {filename && <Text>File: {filename}</Text>}
        <Text>
          {formatBytes(bytesTransferred)} / {formatBytes(totalBytes)} ({Math.round(percentage)}%)
        </Text>
        {speed && <Text>Speed: {formatSpeed(speed)}</Text>}
        {estimatedTimeRemaining && <Text>ETA: {formatTime(estimatedTimeRemaining)}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" data-testid={testId}>
      {filename && (
        <Box marginBottom={1}>
          <Text color={theme.text}>{filename}</Text>
        </Box>
      )}

      <ProgressBar
        value={bytesTransferred}
        max={totalBytes}
        showPercentage={true}
        width={50}
      />

      <Box marginTop={1} justifyContent="space-between">
        <Text color={theme.muted}>
          {formatBytes(bytesTransferred)} / {formatBytes(totalBytes)}
        </Text>
        {speed && (
          <Text color={theme.muted}>
            {formatSpeed(speed)}
          </Text>
        )}
      </Box>

      {estimatedTimeRemaining && estimatedTimeRemaining > 0 && (
        <Box marginTop={1}>
          <Text color={theme.muted}>
            ETA: {formatTime(estimatedTimeRemaining)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

// ============================================================================
// Progress Bar Utilities
// ============================================================================

/**
 * Create a smooth progress animation
 */
export const useProgressAnimation = (
  targetValue: number,
  duration: number = 1000
) => {
  const [currentValue, setCurrentValue] = React.useState(0);

  React.useEffect(() => {
    const startValue = currentValue;
    const difference = targetValue - startValue;
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Easing function (ease-out)
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const newValue = startValue + (difference * easeOut);

      setCurrentValue(newValue);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }, [targetValue, duration]);

  return currentValue;
};

export default ProgressBar;