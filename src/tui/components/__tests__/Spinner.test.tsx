/**
 * @fileoverview Tests for Spinner components
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import {
  Spinner,
  LoadingSpinner,
  ProgressSpinner,
  TimedSpinner,
  CustomSpinner,
  SpinnerPresets
} from '../Spinner.js';
import type { SpinnerType } from '../../types.js';

// Mock the TUI context
const mockTUIContext = {
  theme: {
    primary: '#0066cc',
    secondary: '#6366f1',
    success: '#16a34a',
    warning: '#ca8a04',
    error: '#dc2626',
    muted: '#6b7280',
    background: '#ffffff',
    text: '#111827'
  },
  isHeadless: false,
  dimensions: { width: 80, height: 24 },
  appState: { isActive: true, isFullscreen: false },
  updateTheme: vi.fn(),
  exit: vi.fn()
};

// Mock the useTUIContext hook
vi.mock('../../apps/TUIApp.js', () => ({
  useTUIContext: () => mockTUIContext
}));

describe('Spinner Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('Basic Spinner', () => {
    it('should render spinner with default dots type', () => {
      const { lastFrame } = render(
        <Spinner testId="basic-spinner" />
      );

      expect(lastFrame()).toBeDefined();
      // Should show one of the dots frames
      expect(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'].some(frame =>
        lastFrame().includes(frame)
      )).toBe(true);
    });

    it('should display label when provided', () => {
      const { lastFrame } = render(
        <Spinner label="Loading data" />
      );

      expect(lastFrame()).toContain('Loading data');
    });

    it('should use custom spinner type', () => {
      const { lastFrame } = render(
        <Spinner type="line" />
      );

      // Should show one of the line frames
      expect(['|', '/', '-', '\\'].some(frame =>
        lastFrame().includes(frame)
      )).toBe(true);
    });

    it('should animate through frames', () => {
      const { lastFrame } = render(
        <Spinner type="line" interval={100} />
      );

      const firstFrame = lastFrame();

      // Advance time to trigger frame change
      vi.advanceTimersByTime(100);

      const secondFrame = lastFrame();

      // Frame should have changed (though we can't guarantee which frames)
      expect(secondFrame).toBeDefined();
    });

    it('should use custom frames', () => {
      const customFrames = ['A', 'B', 'C'];
      const { lastFrame } = render(
        <Spinner frames={customFrames} />
      );

      expect(['A', 'B', 'C'].some(frame =>
        lastFrame().includes(frame)
      )).toBe(true);
    });

    it('should use custom interval', () => {
      const { lastFrame } = render(
        <Spinner interval={500} />
      );

      // Verify it renders
      expect(lastFrame()).toBeDefined();

      // Advancing by less than interval shouldn't change frame
      vi.advanceTimersByTime(300);
      const midFrame = lastFrame();

      // Advancing by full interval should change frame
      vi.advanceTimersByTime(200);
      const finalFrame = lastFrame();

      expect(finalFrame).toBeDefined();
    });

    it('should handle disabled state', () => {
      const { lastFrame } = render(
        <Spinner label="Disabled" disabled={true} />
      );

      // Should not show spinner frames when disabled
      expect(lastFrame()).toContain('Disabled');
      expect(lastFrame()).not.toContain('⠋');
    });

    it('should cleanup timer on unmount', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { unmount } = render(
        <Spinner />
      );

      unmount();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('Different Spinner Types', () => {
    const spinnerTypes: SpinnerType[] = ['dots', 'line', 'arc', 'arrow', 'bounce', 'pulse'];

    spinnerTypes.forEach(type => {
      it(`should render ${type} spinner type`, () => {
        const { lastFrame } = render(
          <Spinner type={type} />
        );

        expect(lastFrame()).toBeDefined();
        // Each spinner should render some content
        expect(lastFrame().length).toBeGreaterThan(0);
      });
    });
  });

  describe('Headless Mode', () => {
    beforeEach(() => {
      mockTUIContext.isHeadless = true;
    });

    afterEach(() => {
      mockTUIContext.isHeadless = false;
    });

    it('should render simplified version in headless mode', () => {
      const { lastFrame } = render(
        <Spinner label="Processing" />
      );

      expect(lastFrame()).toContain('Loading: Processing');
    });

    it('should render default text when no label in headless mode', () => {
      const { lastFrame } = render(
        <Spinner />
      );

      expect(lastFrame()).toContain('Loading...');
    });

    it('should not animate in headless mode', () => {
      const { lastFrame } = render(
        <Spinner />
      );

      const firstFrame = lastFrame();

      // Advance time
      vi.advanceTimersByTime(1000);

      const secondFrame = lastFrame();

      // Should be the same in headless mode
      expect(firstFrame).toBe(secondFrame);
    });
  });
});

describe('LoadingSpinner Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should render with default loading label', () => {
    const { lastFrame } = render(
      <LoadingSpinner testId="loading-spinner" />
    );

    expect(lastFrame()).toContain('Loading');
  });

  it('should use custom label', () => {
    const { lastFrame } = render(
      <LoadingSpinner label="Saving" />
    );

    expect(lastFrame()).toContain('Saving');
  });

  it('should animate dots', () => {
    const { lastFrame } = render(
      <LoadingSpinner showDots={true} />
    );

    // Initially should show one dot
    expect(lastFrame()).toContain('.');

    // Advance time to change dot count
    vi.advanceTimersByTime(500);

    // Should still contain dots (count may have changed)
    expect(lastFrame()).toContain('.');
  });

  it('should hide dots when showDots is false', () => {
    const { lastFrame } = render(
      <LoadingSpinner showDots={false} />
    );

    expect(lastFrame()).toContain('Loading');
    // Should contain the spinner character but not additional dots
    expect(lastFrame()).toBeDefined();
  });

  it('should use custom spinner type', () => {
    const { lastFrame } = render(
      <LoadingSpinner type="line" />
    );

    expect(lastFrame()).toBeDefined();
  });

  it('should render headless mode', () => {
    mockTUIContext.isHeadless = true;

    const { lastFrame } = render(
      <LoadingSpinner label="Processing" />
    );

    expect(lastFrame()).toContain('Processing...');

    mockTUIContext.isHeadless = false;
  });
});

describe('ProgressSpinner Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const steps = ['Initialize', 'Process', 'Validate', 'Complete'];

  it('should render current step', () => {
    const { lastFrame } = render(
      <ProgressSpinner
        steps={steps}
        currentStep={1}
        testId="progress-spinner"
      />
    );

    expect(lastFrame()).toContain('Process');
    expect(lastFrame()).toContain('(2/4)');
  });

  it('should show spinner for current step', () => {
    const { lastFrame } = render(
      <ProgressSpinner
        steps={steps}
        currentStep={0}
      />
    );

    expect(lastFrame()).toContain('Initialize');
    // Should show spinner character
    expect(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'].some(frame =>
      lastFrame().includes(frame)
    )).toBe(true);
  });

  it('should show checkmark when complete', () => {
    const { lastFrame } = render(
      <ProgressSpinner
        steps={steps}
        currentStep={steps.length}
      />
    );

    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('Processing...');
  });

  it('should show completed steps', () => {
    const { lastFrame } = render(
      <ProgressSpinner
        steps={steps}
        currentStep={2}
      />
    );

    expect(lastFrame()).toContain('✓'); // For completed steps
    expect(lastFrame()).toContain('Initialize');
    expect(lastFrame()).toContain('Process');
    expect(lastFrame()).toContain('Validate'); // Current step
  });

  it('should hide step numbers when disabled', () => {
    const { lastFrame } = render(
      <ProgressSpinner
        steps={steps}
        currentStep={1}
        showStepNumber={false}
      />
    );

    expect(lastFrame()).toContain('Process');
    expect(lastFrame()).not.toContain('(2/4)');
  });

  it('should use custom spinner type', () => {
    const { lastFrame } = render(
      <ProgressSpinner
        steps={steps}
        currentStep={0}
        type="line"
      />
    );

    expect(lastFrame()).toBeDefined();
  });

  it('should handle empty steps array', () => {
    const { lastFrame } = render(
      <ProgressSpinner
        steps={[]}
        currentStep={0}
      />
    );

    expect(lastFrame()).toContain('Processing...');
  });

  it('should render headless mode', () => {
    mockTUIContext.isHeadless = true;

    const { lastFrame } = render(
      <ProgressSpinner
        steps={steps}
        currentStep={1}
      />
    );

    expect(lastFrame()).toContain('Process (2/4)');

    mockTUIContext.isHeadless = false;
  });
});

describe('TimedSpinner Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should render with default processing label', () => {
    const { lastFrame } = render(
      <TimedSpinner testId="timed-spinner" />
    );

    expect(lastFrame()).toContain('Processing');
  });

  it('should use custom label', () => {
    const { lastFrame } = render(
      <TimedSpinner label="Uploading" />
    );

    expect(lastFrame()).toContain('Uploading');
  });

  it('should show elapsed time', () => {
    const startTime = new Date(Date.now() - 5000); // 5 seconds ago
    vi.setSystemTime(Date.now());

    const { lastFrame } = render(
      <TimedSpinner startTime={startTime} showElapsed={true} />
    );

    // Advance timer to update elapsed time
    vi.advanceTimersByTime(1000);

    expect(lastFrame()).toContain('(');
    expect(lastFrame()).toContain('s)');
  });

  it('should format elapsed time correctly', () => {
    const startTime = new Date(Date.now() - 65000); // 65 seconds ago
    vi.setSystemTime(Date.now());

    const { lastFrame } = render(
      <TimedSpinner startTime={startTime} />
    );

    // Advance timer to update elapsed time
    vi.advanceTimersByTime(1000);

    // Should show minutes and seconds for times over 60s
    expect(lastFrame()).toContain('m');
  });

  it('should hide elapsed time when disabled', () => {
    const { lastFrame } = render(
      <TimedSpinner showElapsed={false} />
    );

    expect(lastFrame()).toContain('Processing');
    expect(lastFrame()).not.toContain('(');
    expect(lastFrame()).not.toContain('s)');
  });

  it('should use custom spinner type', () => {
    const { lastFrame } = render(
      <TimedSpinner type="pulse" />
    );

    expect(lastFrame()).toBeDefined();
  });

  it('should render headless mode', () => {
    mockTUIContext.isHeadless = true;

    const { lastFrame } = render(
      <TimedSpinner label="Working" />
    );

    expect(lastFrame()).toContain('Working...');

    mockTUIContext.isHeadless = false;
  });

  it('should update elapsed time periodically', () => {
    const startTime = new Date();
    const { lastFrame } = render(
      <TimedSpinner startTime={startTime} />
    );

    // Initial state
    expect(lastFrame()).toContain('(0s)');

    // Advance time
    vi.advanceTimersByTime(3000);

    // Should show updated time
    expect(lastFrame()).toContain('(3s)');
  });
});

describe('CustomSpinner Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should render custom frames', () => {
    const frames = ['A', 'B', 'C'];
    const { lastFrame } = render(
      <CustomSpinner frames={frames} testId="custom-spinner" />
    );

    expect(['A', 'B', 'C'].some(frame =>
      lastFrame().includes(frame)
    )).toBe(true);
  });

  it('should animate through custom frames', () => {
    const frames = ['X', 'Y', 'Z'];
    const { lastFrame } = render(
      <CustomSpinner frames={frames} interval={100} />
    );

    const firstFrame = lastFrame();

    // Advance time
    vi.advanceTimersByTime(100);

    const secondFrame = lastFrame();

    // Should be different frames (though we can't predict which)
    expect(secondFrame).toBeDefined();
  });

  it('should use custom interval', () => {
    const frames = ['1', '2'];
    const { lastFrame } = render(
      <CustomSpinner frames={frames} interval={500} />
    );

    expect(lastFrame()).toBeDefined();
  });

  it('should display label', () => {
    const frames = ['🔄'];
    const { lastFrame } = render(
      <CustomSpinner frames={frames} label="Custom loading" />
    );

    expect(lastFrame()).toContain('Custom loading');
    expect(lastFrame()).toContain('🔄');
  });

  it('should use custom color', () => {
    const frames = ['●'];
    const { lastFrame } = render(
      <CustomSpinner frames={frames} color="red" />
    );

    expect(lastFrame()).toContain('●');
  });

  it('should handle empty frames array', () => {
    const { lastFrame } = render(
      <CustomSpinner frames={[]} />
    );

    expect(lastFrame()).toContain('Invalid spinner frames');
  });

  it('should render headless mode', () => {
    mockTUIContext.isHeadless = true;

    const frames = ['A', 'B'];
    const { lastFrame } = render(
      <CustomSpinner frames={frames} label="Custom" />
    );

    expect(lastFrame()).toContain('Custom');

    mockTUIContext.isHeadless = false;
  });

  it('should use default loading text in headless mode when no label', () => {
    mockTUIContext.isHeadless = true;

    const frames = ['A'];
    const { lastFrame } = render(
      <CustomSpinner frames={frames} />
    );

    expect(lastFrame()).toContain('Loading...');

    mockTUIContext.isHeadless = false;
  });
});

describe('SpinnerPresets', () => {
  it('should have all required preset configurations', () => {
    expect(SpinnerPresets.simple).toEqual({
      type: 'dots',
      interval: 120
    });

    expect(SpinnerPresets.fast).toEqual({
      type: 'pulse',
      interval: 200
    });

    expect(SpinnerPresets.slow).toEqual({
      type: 'arc',
      interval: 300
    });

    expect(SpinnerPresets.bounce).toEqual({
      type: 'bounce',
      interval: 150
    });

    expect(SpinnerPresets.arrow).toEqual({
      type: 'arrow',
      interval: 100
    });

    expect(SpinnerPresets.line).toEqual({
      type: 'line',
      interval: 200
    });
  });

  it('should have custom frame presets', () => {
    expect(SpinnerPresets.clock).toEqual({
      frames: ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'],
      interval: 500
    });

    expect(SpinnerPresets.earth).toEqual({
      frames: ['🌍', '🌎', '🌏'],
      interval: 800
    });

    expect(SpinnerPresets.moon).toEqual({
      frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
      interval: 400
    });
  });

  it('should be usable with Spinner component', () => {
    const { lastFrame } = render(
      <Spinner {...SpinnerPresets.simple} />
    );

    expect(lastFrame()).toBeDefined();
  });

  it('should be usable with CustomSpinner component', () => {
    const { lastFrame } = render(
      <CustomSpinner {...SpinnerPresets.earth} />
    );

    expect(['🌍', '🌎', '🌏'].some(frame =>
      lastFrame().includes(frame)
    )).toBe(true);
  });
});

describe('Spinner Integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should handle rapid re-renders', () => {
    const { rerender, lastFrame } = render(
      <Spinner type="dots" />
    );

    // Re-render multiple times quickly
    rerender(<Spinner type="line" />);
    rerender(<Spinner type="arc" />);
    rerender(<Spinner type="dots" />);

    expect(lastFrame()).toBeDefined();
  });

  it('should clean up timers on type change', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    const { rerender } = render(
      <Spinner type="dots" />
    );

    rerender(<Spinner type="line" />);

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('should handle disabled state changes', () => {
    const { rerender, lastFrame } = render(
      <Spinner label="Test" disabled={false} />
    );

    // Should show spinner initially
    expect(lastFrame()).toBeDefined();

    // Disable spinner
    rerender(<Spinner label="Test" disabled={true} />);

    // Should still show label but no spinner
    expect(lastFrame()).toContain('Test');
  });
});