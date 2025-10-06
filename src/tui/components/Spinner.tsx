/**
 * Spinner Component for juno-task-ts TUI
 *
 * Animated loading spinner component with multiple styles and customizable
 * frames. Supports both predefined and custom spinner animations.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import type { SpinnerProps, SpinnerType } from '../types.js';
import { SPINNER_FRAMES } from '../types.js';
import { useTUIContext } from '../apps/TUIApp.js';

/**
 * Animated spinner component for loading states
 */
export const Spinner: React.FC<SpinnerProps> = ({
  label,
  type = 'dots',
  frames: customFrames,
  interval = 100,
  disabled = false,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);

  // Get spinner frames based on type or custom frames
  const frames = customFrames || SPINNER_FRAMES[type] || SPINNER_FRAMES.dots;

  // Animate spinner frames
  useEffect(() => {
    if (disabled || isHeadless) return;

    const timer = setInterval(() => {
      setCurrentFrameIndex((prevIndex) => (prevIndex + 1) % frames.length);
    }, interval);

    return () => clearInterval(timer);
  }, [frames.length, interval, disabled, isHeadless]);

  // Headless mode fallback
  if (isHeadless) {
    return (
      <Box>
        <Text color={theme.muted}>Loading{label ? `: ${label}` : '...'}</Text>
      </Box>
    );
  }

  // Disabled state
  if (disabled) {
    return (
      <Box data-testid={testId}>
        {label && (
          <Text color={theme.muted}>{label}</Text>
        )}
      </Box>
    );
  }

  const currentFrame = frames[currentFrameIndex];

  return (
    <Box data-testid={testId}>
      <Text color={theme.primary}>{currentFrame}</Text>
      {label && (
        <Text color={theme.text}> {label}</Text>
      )}
    </Box>
  );
};

/**
 * Spinner with progress text that cycles through dots
 */
export const LoadingSpinner: React.FC<{
  label?: string;
  type?: SpinnerType;
  showDots?: boolean;
  testId?: string;
}> = ({
  label = 'Loading',
  type = 'dots',
  showDots = true,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (!showDots || isHeadless) return;

    const timer = setInterval(() => {
      setDotCount((count) => (count % 3) + 1);
    }, 500);

    return () => clearInterval(timer);
  }, [showDots, isHeadless]);

  if (isHeadless) {
    return <Text color={theme.muted}>{label}...</Text>;
  }

  return (
    <Box data-testid={testId}>
      <Spinner type={type} />
      <Text color={theme.text}> {label}</Text>
      {showDots && (
        <Text color={theme.primary}>{'.'.repeat(dotCount)}</Text>
      )}
    </Box>
  );
};

/**
 * Multi-step progress spinner
 */
export const ProgressSpinner: React.FC<{
  steps: string[];
  currentStep: number;
  type?: SpinnerType;
  showStepNumber?: boolean;
  testId?: string;
}> = ({
  steps,
  currentStep,
  type = 'dots',
  showStepNumber = true,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();

  if (isHeadless) {
    const currentStepText = steps[currentStep] || 'Processing...';
    const stepInfo = showStepNumber ? `(${currentStep + 1}/${steps.length})` : '';
    return (
      <Text color={theme.muted}>
        {currentStepText} {stepInfo}
      </Text>
    );
  }

  const currentStepText = steps[currentStep] || 'Processing...';
  const isComplete = currentStep >= steps.length;

  return (
    <Box flexDirection="column" data-testid={testId}>
      <Box>
        {!isComplete && <Spinner type={type} />}
        {isComplete && <Text color={theme.success}>✓</Text>}
        <Text color={theme.text}> {currentStepText}</Text>
        {showStepNumber && (
          <Text color={theme.muted}> ({Math.min(currentStep + 1, steps.length)}/{steps.length})</Text>
        )}
      </Box>

      {/* Show previous steps */}
      {currentStep > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {steps.slice(0, currentStep).map((step, index) => (
            <Box key={index}>
              <Text color={theme.success}>✓</Text>
              <Text color={theme.muted}> {step}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

/**
 * Spinner with elapsed time
 */
export const TimedSpinner: React.FC<{
  label?: string;
  type?: SpinnerType;
  startTime?: Date;
  showElapsed?: boolean;
  testId?: string;
}> = ({
  label = 'Processing',
  type = 'dots',
  startTime = new Date(),
  showElapsed = true,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!showElapsed) return;

    const timer = setInterval(() => {
      setElapsed(Date.now() - startTime.getTime());
    }, 1000);

    return () => clearInterval(timer);
  }, [startTime, showElapsed]);

  const formatElapsed = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  if (isHeadless) {
    const elapsedText = showElapsed ? ` (${formatElapsed(elapsed)})` : '';
    return (
      <Text color={theme.muted}>
        {label}...{elapsedText}
      </Text>
    );
  }

  return (
    <Box data-testid={testId}>
      <Spinner type={type} />
      <Text color={theme.text}> {label}</Text>
      {showElapsed && (
        <Text color={theme.muted}> ({formatElapsed(elapsed)})</Text>
      )}
    </Box>
  );
};

/**
 * Custom frame spinner with specific animation sequence
 */
export const CustomSpinner: React.FC<{
  frames: string[];
  interval?: number;
  label?: string;
  color?: string;
  testId?: string;
}> = ({
  frames,
  interval = 100,
  label,
  color,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);

  useEffect(() => {
    if (isHeadless || frames.length === 0) return;

    const timer = setInterval(() => {
      setCurrentFrameIndex((prevIndex) => (prevIndex + 1) % frames.length);
    }, interval);

    return () => clearInterval(timer);
  }, [frames.length, interval, isHeadless]);

  if (isHeadless) {
    return (
      <Text color={theme.muted}>
        {label || 'Loading...'}
      </Text>
    );
  }

  if (frames.length === 0) {
    return (
      <Text color={theme.error}>
        Invalid spinner frames
      </Text>
    );
  }

  const currentFrame = frames[currentFrameIndex];
  const frameColor = color || theme.primary;

  return (
    <Box data-testid={testId}>
      <Text color={frameColor}>{currentFrame}</Text>
      {label && (
        <Text color={theme.text}> {label}</Text>
      )}
    </Box>
  );
};

// ============================================================================
// Predefined Spinner Configurations
// ============================================================================

/**
 * Common spinner presets
 */
export const SpinnerPresets = {
  /** Simple dots spinner */
  simple: { type: 'dots' as SpinnerType, interval: 120 },

  /** Fast pulse spinner */
  fast: { type: 'pulse' as SpinnerType, interval: 200 },

  /** Slow loading spinner */
  slow: { type: 'arc' as SpinnerType, interval: 300 },

  /** Bouncing spinner */
  bounce: { type: 'bounce' as SpinnerType, interval: 150 },

  /** Arrow spinner for direction indication */
  arrow: { type: 'arrow' as SpinnerType, interval: 100 },

  /** Line spinner for terminal compatibility */
  line: { type: 'line' as SpinnerType, interval: 200 },

  /** Custom clock spinner */
  clock: {
    frames: ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'],
    interval: 500
  },

  /** Custom earth spinner */
  earth: {
    frames: ['🌍', '🌎', '🌏'],
    interval: 800
  },

  /** Custom moon phases */
  moon: {
    frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
    interval: 400
  }
};

export default Spinner;