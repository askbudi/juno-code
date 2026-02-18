/**
 * Tests for Claude quota limit detection and handling
 *
 * These tests verify that the system correctly:
 * 1. Detects Claude quota limit errors from response messages
 * 2. Parses reset times from various timezone formats
 * 3. Calculates correct sleep durations
 * 4. Handles edge cases and malformed messages
 * 5. Respects onHourlyLimit configuration (wait vs raise)
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

  describe('Codex quota limit detection', () => {
    it('should detect Codex quota limit message with standard format', () => {
      const message = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Feb 4th, 2026 1:50 AM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.source).toBe('codex');
      expect(result.originalMessage).toBe(message);
      expect(result.resetTime).toBeDefined();
      expect(result.sleepDurationMs).toBeDefined();
    });

    it('should identify source as codex for codex messages', () => {
      const message = "You've hit your usage limit. try again at Jan 15th, 2026 11:30 PM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.source).toBe('codex');
    });

    it('should identify source as claude for claude messages', () => {
      const message = "You've hit your limit · resets 8pm (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.source).toBe('claude');
    });

    it('should parse Codex reset time with ordinal suffixes (st, nd, rd, th)', () => {
      const cases = [
        "You've hit your usage limit. try again at Jan 1st, 2026 5:00 AM.",
        "You've hit your usage limit. try again at Feb 2nd, 2026 5:00 AM.",
        "You've hit your usage limit. try again at Mar 3rd, 2026 5:00 AM.",
        "You've hit your usage limit. try again at Apr 4th, 2026 5:00 AM.",
      ];

      for (const message of cases) {
        const result = detectQuotaLimit(message);
        expect(result.detected).toBe(true);
        expect(result.resetTime).toBeDefined();
        expect(result.source).toBe('codex');
      }
    });

    it('should parse Codex reset time with PM hours correctly', () => {
      // Set current time so the reset time is in the future
      vi.setSystemTime(new Date('2026-02-03T20:00:00.000Z'));

      const message = "You've hit your usage limit. try again at Feb 4th, 2026 1:50 AM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.resetTime).toBeDefined();
      // Reset is at Feb 4th 1:50 AM local time
      expect(result.resetTime!.getMonth()).toBe(1); // February = month 1
      expect(result.resetTime!.getDate()).toBe(4);
      expect(result.resetTime!.getHours()).toBe(1);
      expect(result.resetTime!.getMinutes()).toBe(50);
    });

    it('should handle Codex message with full month name', () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const message = "You've hit your usage limit. try again at February 4, 2026 1:50 AM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.resetTime).toBeDefined();
      expect(result.source).toBe('codex');
    });

    it('should set timezone to local for Codex messages', () => {
      const message = "You've hit your usage limit. try again at Feb 4th, 2026 1:50 AM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.timezone).toBe('local');
    });

    it('should provide default sleep duration when Codex reset time cannot be parsed', () => {
      const message = "You've hit your usage limit. Please wait.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBe(5 * 60 * 1000); // 5 minutes default
      expect(result.source).toBe('codex');
    });

    it('should handle Codex apostrophe variant', () => {
      const message = "Youve hit your usage limit. try again at Feb 4th, 2026 1:50 AM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.source).toBe('codex');
    });

    it('should detect Codex quota limit case-insensitively', () => {
      const message = "YOU'VE HIT YOUR USAGE LIMIT. try again at Feb 4th, 2026 1:50 AM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.source).toBe('codex');
    });

    it('should handle Codex 12 PM correctly', () => {
      vi.setSystemTime(new Date('2026-02-03T10:00:00.000Z'));

      const message = "You've hit your usage limit. try again at Feb 4th, 2026 12:00 PM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.resetTime).toBeDefined();
      expect(result.resetTime!.getHours()).toBe(12);
      expect(result.resetTime!.getMinutes()).toBe(0);
    });

    it('should handle Codex 12 AM (midnight) correctly', () => {
      vi.setSystemTime(new Date('2026-02-03T10:00:00.000Z'));

      const message = "You've hit your usage limit. try again at Feb 4th, 2026 12:30 AM.";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.resetTime).toBeDefined();
      expect(result.resetTime!.getHours()).toBe(0);
      expect(result.resetTime!.getMinutes()).toBe(30);
    });

    it('should detect from full Codex error event JSON', () => {
      const codexErrorEvent = {
        type: "error",
        message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Feb 4th, 2026 1:50 AM."
      };

      const result = detectQuotaLimit(codexErrorEvent.message);

      expect(result.detected).toBe(true);
      expect(result.source).toBe('codex');
      expect(result.resetTime).toBeDefined();
    });

    it('should detect from Codex turn.failed event', () => {
      const turnFailedEvent = {
        type: "turn.failed",
        error: {
          message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Feb 4th, 2026 1:50 AM."
        }
      };

      const result = detectQuotaLimit(turnFailedEvent.error.message);

      expect(result.detected).toBe(true);
      expect(result.source).toBe('codex');
    });
  });
});

describe('Codex Sleep Duration Calculation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should calculate correct sleep duration for Codex reset time in the future', () => {
    // Set current time to Feb 3, 2026 11:00 PM local time
    vi.setSystemTime(new Date(2026, 1, 3, 23, 0, 0, 0));

    const message = "You've hit your usage limit. try again at Feb 4th, 2026 1:50 AM.";
    const result = detectQuotaLimit(message);

    expect(result.detected).toBe(true);
    expect(result.sleepDurationMs).toBeDefined();

    // From 11:00 PM to 1:50 AM = 2h 50m = 170 minutes = 10200000ms
    const expectedMs = 2 * 60 * 60 * 1000 + 50 * 60 * 1000;
    expect(result.sleepDurationMs!).toBeGreaterThan(expectedMs - 60000);
    expect(result.sleepDurationMs!).toBeLessThan(expectedMs + 60000);
  });

  it('should wrap to next day when Codex reset time is in the past', () => {
    // Set current time to Feb 4, 2026 3:00 AM (past the 1:50 AM reset)
    vi.setSystemTime(new Date(2026, 1, 4, 3, 0, 0, 0));

    const message = "You've hit your usage limit. try again at Feb 4th, 2026 1:50 AM.";
    const result = detectQuotaLimit(message);

    expect(result.detected).toBe(true);
    expect(result.sleepDurationMs).toBeDefined();

    // Since 1:50 AM already passed, it should wrap to next day
    // From 3:00 AM to 1:50 AM next day = 22h 50m
    const expectedMs = 22 * 60 * 60 * 1000 + 50 * 60 * 1000;
    expect(result.sleepDurationMs!).toBeGreaterThan(expectedMs - 60000);
    expect(result.sleepDurationMs!).toBeLessThan(expectedMs + 60000);
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

  // Tests for specific scenarios from Task z4u46R (YV1DYV follow-up)
  // Verifies that reset times work correctly for both 5AM and 10PM cases

  describe('5AM and 10PM Reset Time Scenarios', () => {
    it('should correctly calculate sleep duration when reset is 10PM and current time is daytime', () => {
      // Current time: 2:00 PM EST (7:00 PM UTC)
      // Reset time: 10:00 PM EST (3:00 AM UTC next day)
      vi.setSystemTime(new Date('2026-01-25T19:00:00.000Z'));

      const message = "You've hit your limit · resets 10pm (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBeDefined();

      // From 2pm EST to 10pm EST = 8 hours
      const eightHoursMs = 8 * 60 * 60 * 1000;
      expect(result.sleepDurationMs!).toBeGreaterThan(eightHoursMs - 60000);
      expect(result.sleepDurationMs!).toBeLessThan(eightHoursMs + 60000);
    });

    it('should correctly calculate sleep duration when reset is 5AM tomorrow (current time evening)', () => {
      // Current time: 10:00 PM EST (3:00 AM UTC next day)
      // Reset time: 5:00 AM EST next day (10:00 AM UTC next day)
      vi.setSystemTime(new Date('2026-01-26T03:00:00.000Z'));

      const message = "You've hit your limit · resets 5am (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBeDefined();

      // From 10pm EST to 5am EST next day = 7 hours
      const sevenHoursMs = 7 * 60 * 60 * 1000;
      expect(result.sleepDurationMs!).toBeGreaterThan(sevenHoursMs - 60000);
      expect(result.sleepDurationMs!).toBeLessThan(sevenHoursMs + 60000);
    });

    it('should correctly calculate sleep duration when reset is 5AM and current time is 1AM', () => {
      // Current time: 1:00 AM EST (6:00 AM UTC)
      // Reset time: 5:00 AM EST (10:00 AM UTC)
      vi.setSystemTime(new Date('2026-01-25T06:00:00.000Z'));

      const message = "You've hit your limit · resets 5am (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBeDefined();

      // From 1am EST to 5am EST = 4 hours
      const fourHoursMs = 4 * 60 * 60 * 1000;
      expect(result.sleepDurationMs!).toBeGreaterThan(fourHoursMs - 60000);
      expect(result.sleepDurationMs!).toBeLessThan(fourHoursMs + 60000);
    });

    it('should wrap to next day when reset is 5AM and current time is 6AM', () => {
      // Current time: 6:00 AM EST (11:00 AM UTC)
      // Reset time: 5:00 AM EST next day (should wrap since 5am already passed)
      vi.setSystemTime(new Date('2026-01-25T11:00:00.000Z'));

      const message = "You've hit your limit · resets 5am (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBeDefined();

      // From 6am EST to 5am EST next day = 23 hours
      const twentyThreeHoursMs = 23 * 60 * 60 * 1000;
      expect(result.sleepDurationMs!).toBeGreaterThan(twentyThreeHoursMs - 60000);
      expect(result.sleepDurationMs!).toBeLessThan(twentyThreeHoursMs + 60000);
    });

    it('should wrap to next day when reset is 10PM and current time is 11PM', () => {
      // Current time: 11:00 PM EST (4:00 AM UTC next day)
      // Reset time: 10:00 PM EST next day (should wrap since 10pm already passed)
      vi.setSystemTime(new Date('2026-01-26T04:00:00.000Z'));

      const message = "You've hit your limit · resets 10pm (America/Toronto)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBeDefined();

      // From 11pm EST to 10pm EST next day = 23 hours
      const twentyThreeHoursMs = 23 * 60 * 60 * 1000;
      expect(result.sleepDurationMs!).toBeGreaterThan(twentyThreeHoursMs - 60000);
      expect(result.sleepDurationMs!).toBeLessThan(twentyThreeHoursMs + 60000);
    });

    it('should handle 5AM in UTC timezone', () => {
      // Current time: 1:00 AM UTC
      // Reset time: 5:00 AM UTC
      vi.setSystemTime(new Date('2026-01-25T01:00:00.000Z'));

      const message = "You've hit your limit · resets 5am (UTC)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBeDefined();

      // From 1am UTC to 5am UTC = 4 hours
      const fourHoursMs = 4 * 60 * 60 * 1000;
      expect(result.sleepDurationMs!).toBeGreaterThan(fourHoursMs - 60000);
      expect(result.sleepDurationMs!).toBeLessThan(fourHoursMs + 60000);
    });

    it('should handle 10PM in UTC timezone', () => {
      // Current time: 6:00 PM UTC
      // Reset time: 10:00 PM UTC
      vi.setSystemTime(new Date('2026-01-25T18:00:00.000Z'));

      const message = "You've hit your limit · resets 10pm (UTC)";
      const result = detectQuotaLimit(message);

      expect(result.detected).toBe(true);
      expect(result.sleepDurationMs).toBeDefined();

      // From 6pm UTC to 10pm UTC = 4 hours
      const fourHoursMs = 4 * 60 * 60 * 1000;
      expect(result.sleepDurationMs!).toBeGreaterThan(fourHoursMs - 60000);
      expect(result.sleepDurationMs!).toBeLessThan(fourHoursMs + 60000);
    });
  });
});

describe('onHourlyLimit Configuration', () => {
  it('should default to "raise" in DEFAULT_CONFIG', async () => {
    // Import config to check the default
    const { DEFAULT_CONFIG } = await import('../config.js');
    expect(DEFAULT_CONFIG.onHourlyLimit).toBe('raise');
  });

  it('should accept "wait" as valid onHourlyLimit value', async () => {
    const { validateConfig, DEFAULT_CONFIG } = await import('../config.js');

    const config = {
      ...DEFAULT_CONFIG,
      onHourlyLimit: 'wait',
    };

    const result = validateConfig(config);
    expect(result.onHourlyLimit).toBe('wait');
  });

  it('should accept "raise" as valid onHourlyLimit value', async () => {
    const { validateConfig, DEFAULT_CONFIG } = await import('../config.js');

    const config = {
      ...DEFAULT_CONFIG,
      onHourlyLimit: 'raise',
    };

    const result = validateConfig(config);
    expect(result.onHourlyLimit).toBe('raise');
  });

  it('should reject invalid onHourlyLimit values', async () => {
    const { validateConfig, DEFAULT_CONFIG } = await import('../config.js');

    const config = {
      ...DEFAULT_CONFIG,
      onHourlyLimit: 'invalid',
    };

    expect(() => validateConfig(config)).toThrow();
  });

  it('should load onHourlyLimit from JUNO_CODE_ON_HOURLY_LIMIT environment variable', async () => {
    // Set the environment variable
    const originalEnv = process.env.JUNO_CODE_ON_HOURLY_LIMIT;
    process.env.JUNO_CODE_ON_HOURLY_LIMIT = 'wait';

    try {
      // Need to re-import to pick up the new env value
      const { ConfigLoader } = await import('../config.js');

      const loader = new ConfigLoader();
      loader.fromEnvironment();
      const config = loader.merge();

      expect(config.onHourlyLimit).toBe('wait');
    } finally {
      // Restore original env
      if (originalEnv === undefined) {
        delete process.env.JUNO_CODE_ON_HOURLY_LIMIT;
      } else {
        process.env.JUNO_CODE_ON_HOURLY_LIMIT = originalEnv;
      }
    }
  });

  it('should load onHourlyLimit from JUNO_TASK_ON_HOURLY_LIMIT for backward compatibility', async () => {
    // Set the legacy environment variable
    const originalEnv = process.env.JUNO_TASK_ON_HOURLY_LIMIT;
    const originalCodeEnv = process.env.JUNO_CODE_ON_HOURLY_LIMIT;

    // Clear the new env var to test legacy fallback
    delete process.env.JUNO_CODE_ON_HOURLY_LIMIT;
    process.env.JUNO_TASK_ON_HOURLY_LIMIT = 'wait';

    try {
      const { ConfigLoader } = await import('../config.js');

      const loader = new ConfigLoader();
      loader.fromEnvironment();
      const config = loader.merge();

      expect(config.onHourlyLimit).toBe('wait');
    } finally {
      // Restore original env
      if (originalEnv === undefined) {
        delete process.env.JUNO_TASK_ON_HOURLY_LIMIT;
      } else {
        process.env.JUNO_TASK_ON_HOURLY_LIMIT = originalEnv;
      }
      if (originalCodeEnv === undefined) {
        delete process.env.JUNO_CODE_ON_HOURLY_LIMIT;
      } else {
        process.env.JUNO_CODE_ON_HOURLY_LIMIT = originalCodeEnv;
      }
    }
  });

  it('should prioritize CLI option over environment variable', async () => {
    // Set the environment variable to 'raise'
    const originalEnv = process.env.JUNO_CODE_ON_HOURLY_LIMIT;
    process.env.JUNO_CODE_ON_HOURLY_LIMIT = 'raise';

    try {
      const { ConfigLoader } = await import('../config.js');

      const loader = new ConfigLoader();
      loader.fromEnvironment();
      // CLI option should override env
      loader.fromCli({ onHourlyLimit: 'wait' } as any);
      const config = loader.merge();

      expect(config.onHourlyLimit).toBe('wait');
    } finally {
      // Restore original env
      if (originalEnv === undefined) {
        delete process.env.JUNO_CODE_ON_HOURLY_LIMIT;
      } else {
        process.env.JUNO_CODE_ON_HOURLY_LIMIT = originalEnv;
      }
    }
  });
});
