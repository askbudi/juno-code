/**
 * Comprehensive test suite for MCP error handling
 * Tests all error classes, utilities, and integration patterns
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MCPError,
  MCPConnectionError,
  MCPToolError,
  MCPTimeoutError,
  MCPRateLimitError,
  MCPValidationError,
  MCPErrorType,
  MCPErrorCode,
  RATE_LIMIT_PATTERNS,
  parseRateLimitResetTime,
  isMCPError,
  isConnectionError,
  isToolError,
  isTimeoutError,
  isRateLimitError,
  isValidationError,
  isRetryableError,
  getErrorCategory,
  formatErrorForUser,
  formatErrorForLogging,
  getRecoverySuggestions,
  createErrorChain,
  getRecoveryStrategy,
  calculateRetryDelay,
  type ErrorRecoveryStrategy,
  type MCPErrorOptions,
  type RetryInfo,
  type ServerInfo,
  type ToolInfo,
  type ToolExecutionDetails,
} from '../errors';

describe('MCP Error System', () => {
  describe('Error Types and Codes', () => {
    it('should have correct error type enum values', () => {
      expect(MCPErrorType.CONNECTION).toBe('connection');
      expect(MCPErrorType.TIMEOUT).toBe('timeout');
      expect(MCPErrorType.RATE_LIMIT).toBe('rate_limit');
      expect(MCPErrorType.TOOL_EXECUTION).toBe('tool_execution');
      expect(MCPErrorType.VALIDATION).toBe('validation');
      expect(MCPErrorType.SERVER_NOT_FOUND).toBe('server_not_found');
      expect(MCPErrorType.PROTOCOL).toBe('protocol');
      expect(MCPErrorType.AUTHENTICATION).toBe('authentication');
    });

    it('should have correct error code enum values', () => {
      expect(MCPErrorCode.CONNECTION_FAILED).toBe('MCP_CONNECTION_FAILED');
      expect(MCPErrorCode.TOOL_NOT_FOUND).toBe('MCP_TOOL_NOT_FOUND');
      expect(MCPErrorCode.RATE_LIMIT_EXCEEDED).toBe('MCP_RATE_LIMIT_EXCEEDED');
      expect(MCPErrorCode.VALIDATION_FAILED).toBe('MCP_VALIDATION_FAILED');
      expect(MCPErrorCode.SERVER_NOT_FOUND).toBe('MCP_SERVER_NOT_FOUND');
    });
  });

  describe('Base MCPError Class', () => {
    it('should not be directly instantiable (abstract)', () => {
      // MCPError is abstract, so this test verifies inheritance structure
      expect(() => {
        // This should fail compilation, but we test through concrete classes
        const error = new MCPConnectionError('Test error');
        expect(error).toBeInstanceOf(MCPError);
      }).not.toThrow();
    });
  });

  describe('MCPConnectionError', () => {
    it('should create basic connection error', () => {
      const error = new MCPConnectionError('Connection failed');

      expect(error.name).toBe('MCPConnectionError');
      expect(error.message).toBe('Connection failed');
      expect(error.type).toBe(MCPErrorType.CONNECTION);
      expect(error.code).toBe(MCPErrorCode.CONNECTION_FAILED);
      expect(error.timestamp).toBeInstanceOf(Date);
      expect(error.recoverySuggestions).toContain('Check if the MCP server is running');
    });

    it('should create connection error with server info', () => {
      const serverInfo: ServerInfo = {
        path: '/path/to/server',
        version: '1.0.0',
        pid: 12345,
        status: 'running',
      };

      const error = new MCPConnectionError(
        'Connection failed',
        'test_context',
        serverInfo
      );

      expect(error.serverInfo).toEqual(serverInfo);
      expect(error.context).toBe('test_context');
    });

    it('should create timeout error using static method', () => {
      const error = MCPConnectionError.timeout(5000, '/server/path');

      expect(error.message).toBe('Connection timeout after 5000ms');
      expect(error.code).toBe(MCPErrorCode.CONNECTION_TIMEOUT);
      expect(error.serverInfo?.path).toBe('/server/path');
      expect(error.serverInfo?.status).toBe('timeout');
    });

    it('should create refused error using static method', () => {
      const error = MCPConnectionError.refused('/server/path', 8080);

      expect(error.message).toBe('Connection refused to /server/path:8080');
      expect(error.code).toBe(MCPErrorCode.CONNECTION_REFUSED);
      expect(error.recoverySuggestions).toContain('Verify server is running and listening');
    });

    it('should create server not found error using static method', () => {
      const error = MCPConnectionError.serverNotFound('/missing/server');

      expect(error.message).toBe('MCP server not found at path: /missing/server');
      expect(error.code).toBe(MCPErrorCode.SERVER_NOT_FOUND);
      expect(error.recoverySuggestions).toContain('Install the MCP server package');
    });
  });

  describe('MCPToolError', () => {
    const toolInfo: ToolInfo = {
      name: 'claude_subagent',
      subagent: 'claude',
      model: 'sonnet-4',
    };

    it('should create basic tool error', () => {
      const error = new MCPToolError('Tool execution failed', toolInfo);

      expect(error.name).toBe('MCPToolError');
      expect(error.type).toBe(MCPErrorType.TOOL_EXECUTION);
      expect(error.toolInfo).toEqual(toolInfo);
      expect(error.recoverySuggestions).toContain('Check tool arguments and parameters');
    });

    it('should create tool error with execution details', () => {
      const executionDetails: ToolExecutionDetails = {
        startTime: new Date(),
        duration: 5000,
        arguments: { instruction: 'test', model: 'sonnet-4' },
        timeout: 30000,
        sessionId: 'session-123',
      };

      const error = new MCPToolError(
        'Tool failed',
        toolInfo,
        'tool_context',
        { executionDetails }
      );

      expect(error.executionDetails).toEqual(executionDetails);
      expect(error.context).toBe('tool_context');
    });

    it('should create not found error using static method', () => {
      const error = MCPToolError.notFound('missing_tool');

      expect(error.message).toBe('Tool not found: missing_tool');
      expect(error.code).toBe(MCPErrorCode.TOOL_NOT_FOUND);
      expect(error.toolInfo.name).toBe('missing_tool');
    });

    it('should create timeout error using static method', () => {
      const executionDetails: ToolExecutionDetails = {
        startTime: new Date(),
        duration: 30000,
        arguments: {},
      };

      const error = MCPToolError.timeout('slow_tool', 30000, executionDetails);

      expect(error.message).toBe('Tool execution timeout: slow_tool (30000ms)');
      expect(error.code).toBe(MCPErrorCode.TOOL_TIMEOUT);
      expect(error.executionDetails).toEqual(executionDetails);
    });

    it('should create invalid arguments error using static method', () => {
      const invalidArgs = { invalid: 'args' };
      const error = MCPToolError.invalidArguments('test_tool', invalidArgs, 'object with required fields');

      expect(error.message).toBe('Invalid arguments for tool: test_tool');
      expect(error.code).toBe(MCPErrorCode.TOOL_INVALID_ARGUMENTS);
      expect(error.metadata?.invalidArgs).toEqual(invalidArgs);
      expect(error.metadata?.expectedFormat).toBe('object with required fields');
    });
  });

  describe('MCPTimeoutError', () => {
    it('should create basic timeout error', () => {
      const error = new MCPTimeoutError('Operation timed out', 5000, 'connection');

      expect(error.name).toBe('MCPTimeoutError');
      expect(error.type).toBe(MCPErrorType.TIMEOUT);
      expect(error.timeoutMs).toBe(5000);
      expect(error.operationType).toBe('connection');
    });

    it('should create connection timeout using static method', () => {
      const error = MCPTimeoutError.connection(10000);

      expect(error.message).toBe('Connection timeout after 10000ms');
      expect(error.operationType).toBe('connection');
      expect(error.context).toBe('mcp_connection');
    });

    it('should create tool execution timeout using static method', () => {
      const error = MCPTimeoutError.toolExecution('claude_tool', 60000);

      expect(error.message).toBe('Tool execution timeout: claude_tool (60000ms)');
      expect(error.operationType).toBe('tool_execution');
      expect(error.context).toBe('tool_claude_tool');
    });
  });

  describe('MCPRateLimitError', () => {
    it('should create basic rate limit error', () => {
      const resetTime = new Date(Date.now() + 3600000); // 1 hour from now
      const error = new MCPRateLimitError('Rate limit exceeded', 5, resetTime, 'premium');

      expect(error.name).toBe('MCPRateLimitError');
      expect(error.type).toBe(MCPErrorType.RATE_LIMIT);
      expect(error.remaining).toBe(5);
      expect(error.resetTime).toBe(resetTime);
      expect(error.tier).toBe('premium');
    });

    it('should parse rate limit from message using static method', () => {
      const message = 'Rate limit exceeded. Resets at 3:30 PM. 10 requests remaining.';
      const error = MCPRateLimitError.fromMessage(message, 'api_call');

      expect(error.message).toBe(message);
      expect(error.remaining).toBe(10);
      expect(error.context).toBe('api_call');
      expect(error.metadata?.originalMessage).toBe(message);
    });

    it('should create hourly rate limit using static method', () => {
      const resetTime = new Date();
      const error = MCPRateLimitError.hourly(resetTime, 0);

      expect(error.tier).toBe('hourly');
      expect(error.code).toBe(MCPErrorCode.RATE_LIMIT_HOURLY);
      expect(error.context).toBe('hourly_limit');
    });

    it('should create daily rate limit using static method', () => {
      const resetTime = new Date();
      const error = MCPRateLimitError.daily(resetTime, 0);

      expect(error.tier).toBe('daily');
      expect(error.code).toBe(MCPErrorCode.RATE_LIMIT_DAILY);
      expect(error.context).toBe('daily_limit');
    });

    it('should calculate wait times correctly', () => {
      const resetTime = new Date(Date.now() + 5000); // 5 seconds from now
      const error = new MCPRateLimitError('Rate limited', 0, resetTime);

      expect(error.getWaitTimeMs()).toBeGreaterThan(4000);
      expect(error.getWaitTimeMs()).toBeLessThan(6000);
      expect(error.getWaitTimeSeconds()).toBeGreaterThan(4);
      expect(error.getWaitTimeSeconds()).toBeLessThan(7);
    });

    it('should handle missing reset time', () => {
      const error = new MCPRateLimitError('Rate limited', 0);

      expect(error.getWaitTimeMs()).toBe(0);
      expect(error.getWaitTimeSeconds()).toBe(0);
    });
  });

  describe('MCPValidationError', () => {
    it('should create basic validation error', () => {
      const error = new MCPValidationError('Invalid value', 'type_check', 'string', 'number');

      expect(error.name).toBe('MCPValidationError');
      expect(error.type).toBe(MCPErrorType.VALIDATION);
      expect(error.rule).toBe('type_check');
      expect(error.value).toBe('string');
      expect(error.expected).toBe('number');
    });

    it('should create required field error using static method', () => {
      const error = MCPValidationError.required('username');

      expect(error.message).toBe('Required field missing: username');
      expect(error.rule).toBe('required');
      expect(error.field).toBe('username');
      expect(error.code).toBe(MCPErrorCode.MISSING_PARAMETERS);
    });

    it('should create type mismatch error using static method', () => {
      const error = MCPValidationError.typeMismatch('age', 'twenty', 'number');

      expect(error.message).toBe("Invalid type for field 'age': expected number, got string");
      expect(error.rule).toBe('type_mismatch');
      expect(error.value).toBe('twenty');
      expect(error.expected).toBe('number');
    });

    it('should create format error using static method', () => {
      const error = MCPValidationError.format('email', 'invalid-email', 'user@domain.com');

      expect(error.message).toBe("Invalid format for field 'email': expected user@domain.com");
      expect(error.rule).toBe('format');
    });

    it('should create range error using static method', () => {
      const error = MCPValidationError.range('score', 150, 0, 100);

      expect(error.message).toBe("Value out of range for field 'score': expected 0-100");
      expect(error.rule).toBe('range');
      expect(error.value).toBe(150);
      expect(error.expected).toBe('0-100');
    });
  });

  describe('Error Base Class Methods', () => {
    let error: MCPConnectionError;

    beforeEach(() => {
      error = new MCPConnectionError('Test error', 'test_context');
    });

    it('should provide user-friendly messages', () => {
      expect(error.getUserMessage()).toBe('Test error');
    });

    it('should provide technical details', () => {
      const details = error.getTechnicalDetails();
      expect(details).toContain('Error: MCPConnectionError');
      expect(details).toContain('Type: connection');
      expect(details).toContain('Message: Test error');
      expect(details).toContain('Context: test_context');
    });

    it('should check retryability without retry info', () => {
      expect(error.isRetryable()).toBe(false);
    });

    it('should check retryability with retry info', () => {
      const retryInfo: RetryInfo = {
        attempt: 1,
        maxAttempts: 3,
        strategy: 'exponential_backoff',
      };

      const retryableError = new MCPConnectionError('Test', 'test', undefined, { retryInfo });
      expect(retryableError.isRetryable()).toBe(true);
    });

    it('should calculate retry delay', () => {
      expect(error.getRetryDelay()).toBe(0);

      const futureTime = new Date(Date.now() + 5000);
      const retryInfo: RetryInfo = {
        attempt: 1,
        maxAttempts: 3,
        nextRetryTime: futureTime,
        strategy: 'exponential_backoff',
      };

      const retryableError = new MCPConnectionError('Test', 'test', undefined, { retryInfo });
      expect(retryableError.getRetryDelay()).toBeGreaterThan(4000);
    });

    it('should serialize to JSON', () => {
      const json = error.toJSON();
      expect(json.name).toBe('MCPConnectionError');
      expect(json.type).toBe('connection');
      expect(json.message).toBe('Test error');
      expect(json.context).toBe('test_context');
      expect(typeof json.timestamp).toBe('string');
    });
  });

  describe('Rate Limit Parsing', () => {
    it('should have correct rate limit patterns', () => {
      expect(RATE_LIMIT_PATTERNS).toHaveLength(8);
      expect(RATE_LIMIT_PATTERNS[0]).toBeInstanceOf(RegExp);
    });

    it('should parse time-based reset messages', () => {
      const testCases = [
        'Rate limit resets at 3:30 PM',
        'Limit exceeded, resets 15:45',
        'Try again in 5 minutes',
        'Wait 2 hours before retry',
        '5-hour limit reached, resets at 6 PM',
        'Hourly limit exceeded, resets at 14:30',
      ];

      testCases.forEach(message => {
        const result = parseRateLimitResetTime(message);
        if (message.includes('minutes') || message.includes('hours')) {
          expect(result).toBeInstanceOf(Date);
          expect(result!.getTime()).toBeGreaterThan(Date.now());
        } else if (message.includes(':')) {
          expect(result).toBeInstanceOf(Date);
        }
      });
    });

    it('should handle Unix timestamp patterns', () => {
      const fixedTimestamp = 1699999999; // Fixed Unix timestamp
      const message = `Rate limit resets at ${fixedTimestamp}`;
      const result = parseRateLimitResetTime(message);

      expect(result).toBeInstanceOf(Date);
      expect(result!.getTime()).toBe(fixedTimestamp * 1000);
    });

    it('should handle ISO date patterns', () => {
      const fixedDate = new Date('2023-11-15T12:00:00.000Z');
      const isoDate = fixedDate.toISOString();
      const message = `Rate limit resets at ${isoDate}`;
      const result = parseRateLimitResetTime(message);

      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toBe(isoDate);
    });

    it('should return undefined for unrecognized patterns', () => {
      const result = parseRateLimitResetTime('No rate limit info here');
      expect(result).toBeUndefined();
    });
  });

  describe('Type Guards', () => {
    const connectionError = new MCPConnectionError('Connection failed');
    const toolError = new MCPToolError('Tool failed', { name: 'test', subagent: 'claude' });
    const timeoutError = new MCPTimeoutError('Timeout', 5000, 'connection');
    const rateLimitError = new MCPRateLimitError('Rate limited', 0);
    const validationError = new MCPValidationError('Invalid', 'required', null);
    const regularError = new Error('Regular error');

    it('should identify MCP errors correctly', () => {
      expect(isMCPError(connectionError)).toBe(true);
      expect(isMCPError(toolError)).toBe(true);
      expect(isMCPError(regularError)).toBe(false);
      expect(isMCPError('string')).toBe(false);
      expect(isMCPError(null)).toBe(false);
    });

    it('should identify connection errors correctly', () => {
      expect(isConnectionError(connectionError)).toBe(true);
      expect(isConnectionError(toolError)).toBe(false);
      expect(isConnectionError(regularError)).toBe(false);
    });

    it('should identify tool errors correctly', () => {
      expect(isToolError(toolError)).toBe(true);
      expect(isToolError(connectionError)).toBe(false);
      expect(isToolError(regularError)).toBe(false);
    });

    it('should identify timeout errors correctly', () => {
      expect(isTimeoutError(timeoutError)).toBe(true);
      expect(isTimeoutError(connectionError)).toBe(false);
      expect(isTimeoutError(regularError)).toBe(false);
    });

    it('should identify rate limit errors correctly', () => {
      expect(isRateLimitError(rateLimitError)).toBe(true);
      expect(isRateLimitError(connectionError)).toBe(false);
      expect(isRateLimitError(regularError)).toBe(false);
    });

    it('should identify validation errors correctly', () => {
      expect(isValidationError(validationError)).toBe(true);
      expect(isValidationError(connectionError)).toBe(false);
      expect(isValidationError(regularError)).toBe(false);
    });

    it('should identify retryable errors correctly', () => {
      expect(isRetryableError(connectionError)).toBe(true);
      expect(isRetryableError(rateLimitError)).toBe(true);
      expect(isRetryableError(timeoutError)).toBe(true);
      expect(isRetryableError(validationError)).toBe(false);
      expect(isRetryableError(regularError)).toBe(false);
    });
  });

  describe('Error Utilities', () => {
    it('should get error categories correctly', () => {
      expect(getErrorCategory(new MCPConnectionError('test'))).toBe(MCPErrorType.CONNECTION);
      expect(getErrorCategory(new MCPToolError('test', { name: 'test', subagent: 'claude' }))).toBe(MCPErrorType.TOOL_EXECUTION);
      expect(getErrorCategory(new Error('regular'))).toBe('unknown');
    });

    it('should format errors for users', () => {
      const error = new MCPConnectionError('Connection failed');
      expect(formatErrorForUser(error)).toBe('Connection failed');
      expect(formatErrorForUser(new Error('Regular error'))).toBe('Regular error');
      expect(formatErrorForUser('string error')).toBe('string error');
    });

    it('should format errors for logging', () => {
      const error = new MCPConnectionError('Connection failed');
      const formatted = formatErrorForLogging(error);
      expect(formatted).toContain('Error: MCPConnectionError');
      expect(formatted).toContain('Type: connection');
      expect(formatted).toContain('Message: Connection failed');
    });

    it('should get recovery suggestions', () => {
      const connectionError = new MCPConnectionError('Connection failed');
      const suggestions = getRecoverySuggestions(connectionError);
      expect(suggestions).toContain('Check if the MCP server is running');

      const regularError = new Error('Regular error');
      const defaultSuggestions = getRecoverySuggestions(regularError);
      expect(defaultSuggestions).toContain('Check error message for details');
    });

    it('should create error chains', () => {
      const errors = [
        new Error('Primary error'),
        new Error('Secondary error'),
        new Error('Tertiary error'),
      ];

      const chain = createErrorChain(errors);
      expect(chain.message).toBe('Multiple errors occurred: Primary error');
      expect(chain.cause).toBe(errors[0]);
      expect(chain.metadata?.additionalErrors).toHaveLength(2);
    });

    it('should handle empty error chains', () => {
      const chain = createErrorChain([]);
      expect(chain.message).toBe('Unknown error occurred');
    });

    it('should handle single error chains', () => {
      const error = new MCPConnectionError('Single error');
      const chain = createErrorChain([error]);
      expect(chain).toBe(error);
    });
  });

  describe('Recovery Strategies', () => {
    it('should recommend correct recovery strategies', () => {
      expect(getRecoveryStrategy(new MCPRateLimitError('Rate limited', 0))).toBe('wait');
      expect(getRecoveryStrategy(new MCPConnectionError('Connection failed'))).toBe('reconnect');
      expect(getRecoveryStrategy(new MCPTimeoutError('Timeout', 5000, 'operation'))).toBe('retry');
      expect(getRecoveryStrategy(new MCPValidationError('Invalid', 'rule', null))).toBe('manual');
      expect(getRecoveryStrategy(new MCPToolError('Tool failed', { name: 'test', subagent: 'claude' }))).toBe('fallback');
      expect(getRecoveryStrategy(new Error('Unknown'))).toBe('abort');
    });

    it('should calculate retry delays correctly', () => {
      // Rate limit error should return exact wait time
      const resetTime = new Date(Date.now() + 5000);
      const rateLimitError = new MCPRateLimitError('Rate limited', 0, resetTime);
      const rateLimitDelay = calculateRetryDelay(rateLimitError, 1);
      expect(rateLimitDelay).toBeGreaterThan(4000);
      expect(rateLimitDelay).toBeLessThan(6000);

      // Regular error should use exponential backoff
      const regularError = new Error('Regular error');
      const delay1 = calculateRetryDelay(regularError, 1);
      const delay2 = calculateRetryDelay(regularError, 2);
      const delay3 = calculateRetryDelay(regularError, 3);

      expect(delay1).toBeGreaterThan(900); // ~1000ms with jitter
      expect(delay1).toBeLessThan(1100);
      expect(delay2).toBeGreaterThan(1800); // ~2000ms with jitter
      expect(delay2).toBeLessThan(2200);
      expect(delay3).toBeGreaterThan(3600); // ~4000ms with jitter
      expect(delay3).toBeLessThan(4400);
    });

    it('should respect maximum delay limits', () => {
      const error = new Error('Test error');
      const delay = calculateRetryDelay(error, 10, 1000, 5000);
      expect(delay).toBeLessThan(5500); // Max delay + jitter tolerance
    });
  });

  describe('Error Integration', () => {
    it('should work with error chaining', () => {
      const cause = new Error('Root cause');
      const options: MCPErrorOptions = {
        cause,
        metadata: { extra: 'data' },
        recoverySuggestions: ['Custom suggestion'],
      };

      const error = new MCPConnectionError('Wrapper error', 'test', undefined, options);

      expect(error.cause).toBe(cause);
      expect(error.metadata?.extra).toBe('data');
      expect(error.recoverySuggestions).toContain('Custom suggestion');
    });

    it('should maintain proper inheritance hierarchy', () => {
      const error = new MCPConnectionError('Test');

      expect(error).toBeInstanceOf(MCPError);
      expect(error).toBeInstanceOf(Error);
      expect(error.constructor.name).toBe('MCPConnectionError');
    });

    it('should preserve stack traces', () => {
      const error = new MCPConnectionError('Test');
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('MCPConnectionError');
    });
  });
});