/**
 * Tests for Claude quota limit detection and handling
 *
 * These tests verify that the system correctly:
 * 1. Detects Claude quota limit errors from response messages
 * 2. Parses reset times from various timezone formats
 * 3. Calculates correct sleep durations
 * 4. Handles edge cases and malformed messages
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  detectQuotaLimit,
  formatDuration,
  type QuotaLimitInfo
} from '../backends/shell-backend.js';

describe('Quota Limit Detection', () => {
  beforeEach(() => {
    // Use a fixed date for consistent testing
    vi.useFakeTimers();
    // Set current time to 2:00 PM EST (7:00 PM UTC) on a test day
    vi.setSystemTime(new Date('2026-01-25T19:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('detectQuotaLimit', () => {
    it('should detect quota limit message with standard format', () => {
      const message = "You've hit your limit · resets 8pm (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.originalMessage).toBe(message);
      expect(result.timezone).toBe('America/Toronto');
      expect(result.resetTime).toBeDefined();
      expect(result.sleepDurationMs).toBeGreaterThan(0);
    });

    it('should detect quota limit message with apostrophe variant', () => {
      const message = "Youve hit your limit · resets 10am (UTC)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
    });

    it('should detect quota limit message case-insensitively', () => {
      const message = "YOU'VE HIT YOUR LIMIT · resets 8pm (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
    });

    it('should return false for non-quota-limit messages', () => {
      const messages = [
        "Task completed successfully",
        "Rate limit exceeded",
        "Error: connection timeout",
        "",
        null,
        undefined
      ];

      for (const message of messages) {
        const result = detectQuotaLimit(message as any);
        expect(result.detected).toBe(false);
      }
    });

    it('should handle message with minutes in reset time', () => {
      const message = "You've hit your limit · resets 8:30pm (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.resetTime).toBeDefined();
    });

    it('should handle AM reset times', () => {
      const message = "You've hit your limit · resets 6am (America/New_York)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.timezone).toBe('America/New_York');
    });

    it('should handle 12am (midnight) correctly', () => {
      const message = "You've hit your limit · resets 12am (UTC)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      // 12am should convert to hour 0
      expect(result.resetTime).toBeDefined();
    });

    it('should handle 12pm (noon) correctly', () => {
      const message = "You've hit your limit · resets 12pm (UTC)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      // 12pm should stay as hour 12
      expect(result.resetTime).toBeDefined();
    });

    it('should provide default sleep duration when reset time cannot be parsed', () => {
      // Message without valid reset time format
      const message = "You've hit your limit · please wait";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBe(5 * 60 * 1000); // 5 minutes default
    });

    it('should handle various timezone formats', () => {
      const testCases = [
        { message: "You've hit your limit · resets 8pm (America/Toronto)", timezone: 'America/Toronto' },
        { message: "You've hit your limit · resets 8pm (US/Eastern)", timezone: 'US/Eastern' },
        { message: "You've hit your limit · resets 8pm (Europe/London)", timezone: 'Europe/London' },
        { message: "You've hit your limit · resets 8pm (UTC)", timezone: 'UTC' },
        { message: "You've hit your limit · resets 8pm (GMT)", timezone: 'GMT' },
        { message: "You've hit your limit · resets 8pm (Asia/Tokyo)", timezone: 'Asia/Tokyo' },
      ];

      for (const { message, timezone } of testCases) {
        const result = detectQuotaLimit(message);
        expect(result.detected).toBe(true);
        expect(result.timezone).toBe(timezone);
      }
    });

    it('should handle unknown timezone by falling back to local time', () => {
      const message = "You've hit your limit · resets 8pm (Unknown/Timezone)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.timezone).toBe('Unknown/Timezone');
      expect(result.sleepDurationMs).toBeGreaterThan(0);
    });
  });

  describe('formatDuration', () => {
    it('should format seconds correctly', () => {
      expect(formatDuration(30 * 1000)).toBe('30s');
      expect(formatDuration(1 * 1000)).toBe('1s');
    });

    it('should format minutes correctly', () => {
      expect(formatDuration(5 * 60 * 1000)).toBe('5m');
      expect(formatDuration(90 * 1000)).toBe('1m 30s');
    });

    it('should format hours correctly', () => {
      expect(formatDuration(2 * 60 * 60 * 1000)).toBe('2h');
      expect(formatDuration(2 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe('2h 30m');
    });

    it('should format combined durations correctly', () => {
      // 1 hour, 30 minutes, 45 seconds
      const duration = 1 * 60 * 60 * 1000 + 30 * 60 * 1000 + 45 * 1000;
      expect(formatDuration(duration)).toBe('1h 30m 45s');
    });

    it('should handle zero duration', () => {
      expect(formatDuration(0)).toBe('0s');
    });

    it('should round up partial seconds', () => {
      expect(formatDuration(500)).toBe('1s');
      expect(formatDuration(1500)).toBe('2s');
    });
  });

  describe('Integration with Claude response parsing', () => {
    it('should detect quota limit from full Claude response result field', () => {
      const claudeResponse = {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: "You've hit your limit · resets 8pm (America/Toronto)",
        session_id: '983210ce-9eaf-4f77-85b8-00eedc54e1d6',
        num_turns: 1,
        duration_ms: 647,
        exit_code: 1,
        total_cost_usd: 0,
      };

      const result = detectQuotaLimit(claudeResponse.result);

      expect(result.detected).toBe(true);
      expect(result.timezone).toBe('America/Toronto');
    });

    it('should handle nested sub_agent_response format', () => {
      const response = {
        sub_agent_response: {
          result: "You've hit your limit · resets 10am (UTC)"
        }
      };

      const result = detectQuotaLimit(response.sub_agent_response.result);

      expect(result.detected).toBe(true);
      expect(result.timezone).toBe('UTC');
    });
  });
});

describe('Sleep Duration Calculation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should calculate correct sleep duration for same-day reset', () => {
    // Set current time to 2:00 PM EST (7:00 PM UTC)
    vi.setSystemTime(new Date('2026-01-25T19:00:00.000Z'));

    const message = "You've hit your limit · resets 8pm (America/Toronto)";
    const result = detectQuotaLimit(message);

    // Reset is at 8pm EST = 1:00 AM UTC next day
    // From 7:00 PM UTC to 1:00 AM UTC next day = 6 hours
    expect(result.detected).toBe(true);
    expect(result.sleepDurationMs).toBeDefined();

    // Should be approximately 6 hours (with some tolerance for calculation)
    const sixHoursMs = 6 * 60 * 60 * 1000;
    expect(result.sleepDurationMs!).toBeGreaterThan(sixHoursMs - 60000);
    expect(result.sleepDurationMs!).toBeLessThan(sixHoursMs + 60000);
  });

  it('should add 24 hours if reset time appears to be in the past', () => {
    // Set current time to 10:00 PM EST (3:00 AM UTC next day)
    vi.setSystemTime(new Date('2026-01-26T03:00:00.000Z'));

    const message = "You've hit your limit · resets 8pm (America/Toronto)";
    const result = detectQuotaLimit(message);

    expect(result.detected).toBe(true);
    // Since 8pm EST has already passed (we're at 10pm EST), it should calculate
    // the duration until 8pm EST the NEXT day
    expect(result.sleepDurationMs).toBeDefined();
    expect(result.sleepDurationMs!).toBeGreaterThan(20 * 60 * 60 * 1000); // Should be > 20 hours
  });
});
