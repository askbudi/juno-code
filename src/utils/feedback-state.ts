/**
 * Global Feedback Collection State Management
 *
 * Tracks when feedback collection is active to prevent progress output mixing.
 *
 * The Problem:
 * - TerminalProgressWriter uses ANSI escape codes (\r\x1b[K) to clear lines
 * - This works in raw/canonical TTY mode where terminals automatically restore input
 * - Feedback collector uses line-based stdin (not raw mode) for AI agent compatibility
 * - In line-based mode, terminal buffers input internally but doesn't re-display after ANSI clears
 * - Result: User's typed characters disappear when progress writes occur
 *
 * The Solution:
 * - Suppress progress output entirely when feedback collection is active
 * - Queue progress events to a buffer instead of displaying them
 * - Optionally flush queued progress after feedback submission completes
 */

export interface ProgressEvent {
  content: any;
  prefix?: string;
  timestamp: Date;
}

/**
 * Global state for feedback collection
 */
class FeedbackState {
  private _isActive: boolean = false;
  private _progressBuffer: ProgressEvent[] = [];
  private readonly _maxBufferSize: number = 100; // Prevent memory leaks
  private _inputRedisplayCallback: (() => void) | null = null;

  /**
   * Check if feedback collection is currently active
   */
  isActive(): boolean {
    return this._isActive;
  }

  /**
   * Set feedback collection active state
   */
  setActive(active: boolean): void {
    const wasActive = this._isActive;
    this._isActive = active;

    // If feedback just became inactive, optionally flush buffered progress
    if (wasActive && !active && this._progressBuffer.length > 0) {
      this.flushProgressBuffer();
    }
  }

  /**
   * Set the callback to redisplay user input after progress flush
   */
  setInputRedisplayCallback(callback: (() => void) | null): void {
    this._inputRedisplayCallback = callback;
  }

  /**
   * Add a progress event to the buffer (when feedback is active)
   */
  bufferProgress(content: any, prefix?: string): void {
    // Only buffer if feedback is active
    if (!this._isActive) {
      return;
    }

    const event: ProgressEvent = {
      content,
      prefix,
      timestamp: new Date()
    };

    this._progressBuffer.push(event);

    // Prevent memory leaks by limiting buffer size
    if (this._progressBuffer.length > this._maxBufferSize) {
      this._progressBuffer.shift(); // Remove oldest event
    }
  }

  /**
   * Get buffered progress events
   */
  getBufferedProgress(): ProgressEvent[] {
    return [...this._progressBuffer];
  }

  /**
   * Clear the progress buffer
   */
  clearProgressBuffer(): void {
    this._progressBuffer.length = 0;
  }

  /**
   * Flush buffered progress events to stderr
   * Called when feedback collection ends or periodically
   */
  private flushProgressBuffer(): void {
    if (this._progressBuffer.length === 0) {
      return;
    }

    // Display buffered progress events
    // Note: We don't add separators - just display the progress naturally
    for (const event of this._progressBuffer) {
      if (event.prefix) {
        console.error(event.prefix, event.content);
      } else {
        console.error(event.content);
      }
    }

    this.clearProgressBuffer();

    // After flushing progress to stderr, ensure output synchronization
    // before redisplaying user input to stdout
    if (this._inputRedisplayCallback) {
      // Use setImmediate to ensure stderr flushes complete before stdout writes
      setImmediate(() => {
        // Ensure we're on a new line after progress output
        // This prevents the redisplayed input from mixing with progress output
        process.stdout.write('\n');

        // Call the redisplay callback
        if (this._inputRedisplayCallback) {
          this._inputRedisplayCallback();
        }
      });
    }
  }

  /**
   * Manually flush buffered progress (can be called periodically)
   */
  flushBufferedProgress(): void {
    this.flushProgressBuffer();
  }

  /**
   * Get buffer statistics
   */
  getBufferStats(): { count: number; maxSize: number } {
    return {
      count: this._progressBuffer.length,
      maxSize: this._maxBufferSize
    };
  }
}

/**
 * Global singleton instance
 */
const globalFeedbackState = new FeedbackState();

/**
 * Check if feedback collection is currently active
 */
export function isFeedbackActive(): boolean {
  return globalFeedbackState.isActive();
}

/**
 * Set feedback collection active state
 */
export function setFeedbackActive(active: boolean): void {
  globalFeedbackState.setActive(active);
}

/**
 * Buffer a progress event during active feedback collection
 */
export function bufferProgressEvent(content: any, prefix?: string): void {
  globalFeedbackState.bufferProgress(content, prefix);
}

/**
 * Get all buffered progress events
 */
export function getBufferedProgressEvents(): ProgressEvent[] {
  return globalFeedbackState.getBufferedProgress();
}

/**
 * Clear buffered progress events
 */
export function clearBufferedProgressEvents(): void {
  globalFeedbackState.clearProgressBuffer();
}

/**
 * Get buffer statistics
 */
export function getFeedbackBufferStats(): { count: number; maxSize: number } {
  return globalFeedbackState.getBufferStats();
}

/**
 * Manually flush buffered progress events
 * Useful for periodic flushing during feedback collection
 */
export function flushBufferedProgress(): void {
  globalFeedbackState.flushBufferedProgress();
}

/**
 * Set the callback to redisplay user input after progress flush
 */
export function setInputRedisplayCallback(callback: (() => void) | null): void {
  globalFeedbackState.setInputRedisplayCallback(callback);
}

/**
 * Reset all feedback state (useful for testing)
 */
export function resetFeedbackState(): void {
  globalFeedbackState.setActive(false);
  globalFeedbackState.clearProgressBuffer();
}