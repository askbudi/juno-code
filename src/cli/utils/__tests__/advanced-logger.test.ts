import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdvancedLogger, LogContext, LogLevel } from '../advanced-logger.js';

describe('AdvancedLogger output routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes info logs to stderr so stdout stays clean for structured output', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const logger = new AdvancedLogger({
      level: LogLevel.INFO,
      output: 'console',
      format: 'simple',
      showTimestamp: false,
      showContext: false,
      showLevel: false,
      colorize: false
    });

    logger.info('structured payload ready', LogContext.CLI);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('structured payload ready'));
    expect(logSpy).not.toHaveBeenCalled();
  });
});
