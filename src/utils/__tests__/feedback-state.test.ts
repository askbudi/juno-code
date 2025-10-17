/**
 * Tests for feedback state management
 */

import { vi } from 'vitest';
import {
  isFeedbackActive,
  setFeedbackActive,
  bufferProgressEvent,
  getBufferedProgressEvents,
  clearBufferedProgressEvents,
  getFeedbackBufferStats,
  resetFeedbackState
} from '../feedback-state';

describe('FeedbackState', () => {
  beforeEach(() => {
    resetFeedbackState();
  });

  afterEach(() => {
    resetFeedbackState();
  });

  describe('feedback active state', () => {
    it('should start with feedback inactive', () => {
      expect(isFeedbackActive()).toBe(false);
    });

    it('should allow setting feedback active', () => {
      setFeedbackActive(true);
      expect(isFeedbackActive()).toBe(true);
    });

    it('should allow setting feedback inactive', () => {
      setFeedbackActive(true);
      setFeedbackActive(false);
      expect(isFeedbackActive()).toBe(false);
    });
  });

  describe('progress buffering', () => {
    it('should not buffer when feedback is inactive', () => {
      bufferProgressEvent('test message');
      expect(getBufferedProgressEvents()).toHaveLength(0);
    });

    it('should buffer events when feedback is active', () => {
      setFeedbackActive(true);
      bufferProgressEvent('test message');

      const events = getBufferedProgressEvents();
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('test message');
      expect(events[0].timestamp).toBeInstanceOf(Date);
    });

    it('should buffer events with prefix', () => {
      setFeedbackActive(true);
      bufferProgressEvent('test message', '[TEST]');

      const events = getBufferedProgressEvents();
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('test message');
      expect(events[0].prefix).toBe('[TEST]');
    });

    it('should buffer multiple events', () => {
      setFeedbackActive(true);
      bufferProgressEvent('message 1');
      bufferProgressEvent('message 2', '[PREFIX]');

      const events = getBufferedProgressEvents();
      expect(events).toHaveLength(2);
      expect(events[0].content).toBe('message 1');
      expect(events[1].content).toBe('message 2');
      expect(events[1].prefix).toBe('[PREFIX]');
    });

    it('should clear buffered events', () => {
      setFeedbackActive(true);
      bufferProgressEvent('test message');
      expect(getBufferedProgressEvents()).toHaveLength(1);

      clearBufferedProgressEvents();
      expect(getBufferedProgressEvents()).toHaveLength(0);
    });

    it('should limit buffer size to prevent memory leaks', () => {
      setFeedbackActive(true);

      // Buffer more than the max size (100)
      for (let i = 0; i < 150; i++) {
        bufferProgressEvent(`message ${i}`);
      }

      const events = getBufferedProgressEvents();
      const stats = getFeedbackBufferStats();

      expect(events).toHaveLength(100); // Max buffer size
      expect(stats.count).toBe(100);
      expect(stats.maxSize).toBe(100);

      // Should contain the latest messages
      expect(events[0].content).toBe('message 50'); // Oldest kept
      expect(events[99].content).toBe('message 149'); // Newest
    });
  });

  describe('buffer statistics', () => {
    it('should provide accurate buffer stats', () => {
      const initialStats = getFeedbackBufferStats();
      expect(initialStats.count).toBe(0);
      expect(initialStats.maxSize).toBe(100);

      setFeedbackActive(true);
      bufferProgressEvent('test 1');
      bufferProgressEvent('test 2');

      const stats = getFeedbackBufferStats();
      expect(stats.count).toBe(2);
      expect(stats.maxSize).toBe(100);
    });
  });

  describe('state transitions', () => {
    it('should flush buffer when transitioning from active to inactive', () => {
      // Mock console.error to capture output
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation();
      const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation();

      setFeedbackActive(true);
      bufferProgressEvent('test message 1');
      bufferProgressEvent('test message 2', '[PREFIX]');

      // Should have buffered events
      expect(getBufferedProgressEvents()).toHaveLength(2);

      // Transition to inactive should flush buffer
      setFeedbackActive(false);

      // Buffer should be cleared
      expect(getBufferedProgressEvents()).toHaveLength(0);

      // Should have written flush header and events
      expect(stderrWriteSpy).toHaveBeenCalledWith('\n--- Buffered progress events during feedback ---\n');
      expect(consoleErrorSpy).toHaveBeenCalledWith('test message 1');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[PREFIX]', 'test message 2');
      expect(stderrWriteSpy).toHaveBeenCalledWith('--- End buffered events ---\n\n');

      consoleErrorSpy.mockRestore();
      stderrWriteSpy.mockRestore();
    });

    it('should not flush empty buffer', () => {
      const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation();

      setFeedbackActive(true);
      setFeedbackActive(false); // No buffered events

      // Should not write flush headers for empty buffer
      expect(stderrWriteSpy).not.toHaveBeenCalledWith('\n--- Buffered progress events during feedback ---\n');

      stderrWriteSpy.mockRestore();
    });
  });

  describe('reset functionality', () => {
    it('should reset all state', () => {
      setFeedbackActive(true);
      bufferProgressEvent('test message');

      expect(isFeedbackActive()).toBe(true);
      expect(getBufferedProgressEvents()).toHaveLength(1);

      resetFeedbackState();

      expect(isFeedbackActive()).toBe(false);
      expect(getBufferedProgressEvents()).toHaveLength(0);
    });
  });
});