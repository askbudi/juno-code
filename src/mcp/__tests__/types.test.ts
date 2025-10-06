/**
 * Test file for MCP types to ensure they compile correctly
 * and provide proper type safety
 */

import { describe, it, expect } from 'vitest';
import {
  type ProgressEvent,
  type MCPServerConfig,
  type ToolCallRequest,
  type SubagentInfo,
  ProgressEventType,
  MCPConnectionState,
  SubagentType,
  isProgressEvent,
  isMCPError,
  isSubagentType,
  isConnectionState,
  SUBAGENT_TOOL_MAPPING,
  SUBAGENT_ALIASES,
  MCP_DEFAULTS,
} from '../types';
import {
  MCPError,
  MCPConnectionError,
  MCPToolError,
  MCPTimeoutError,
  MCPRateLimitError,
  MCPValidationError,
} from '../errors';

describe('MCP Types', () => {
  describe('Type Guards', () => {
    it('should correctly identify progress events', () => {
      const validEvent: ProgressEvent = {
        sessionId: 'test-session',
        timestamp: new Date(),
        backend: 'claude',
        count: 1,
        type: ProgressEventType.TOOL_START,
        content: 'Starting test',
        toolId: 'claude_1',
      };

      expect(isProgressEvent(validEvent)).toBe(true);
      expect(isProgressEvent({})).toBe(false);
      expect(isProgressEvent(null)).toBe(false);
      expect(isProgressEvent('string')).toBe(false);
    });

    it('should correctly identify MCP errors', () => {
      const mcpError = new MCPConnectionError('Test error');
      const regularError = new Error('Regular error');

      expect(isMCPError(mcpError)).toBe(true);
      expect(isMCPError(regularError)).toBe(false);
      expect(isMCPError('string')).toBe(false);
    });

    it('should correctly identify subagent types', () => {
      expect(isSubagentType('claude')).toBe(true);
      expect(isSubagentType('cursor')).toBe(true);
      expect(isSubagentType('codex')).toBe(true);
      expect(isSubagentType('gemini')).toBe(true);
      expect(isSubagentType('invalid')).toBe(false);
    });

    it('should correctly identify connection states', () => {
      expect(isConnectionState('connected')).toBe(true);
      expect(isConnectionState('disconnected')).toBe(true);
      expect(isConnectionState('invalid')).toBe(false);
    });
  });

  describe('Error Classes', () => {
    it('should create MCPConnectionError with proper inheritance', () => {
      const error = new MCPConnectionError('Connection failed', 'test-context');

      expect(error).toBeInstanceOf(MCPError);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Connection failed');
      expect(error.context).toBe('test-context');
      expect(error.timestamp).toBeInstanceOf(Date);
    });

    it('should create MCPToolError with tool info', () => {
      const toolInfo = {
        name: 'claude_subagent',
        subagent: 'claude' as SubagentType,
      };

      const error = new MCPToolError('Tool failed', toolInfo);

      expect(error.toolInfo).toEqual(toolInfo);
      expect(error.message).toBe('Tool failed');
    });

    it('should create MCPTimeoutError with timeout info', () => {
      const error = new MCPTimeoutError('Operation timed out', 30000, 'tool_call');

      expect(error.timeoutMs).toBe(30000);
      expect(error.operationType).toBe('tool_call');
    });

    it('should create MCPRateLimitError with rate limit info', () => {
      const resetTime = new Date();
      const error = new MCPRateLimitError('Rate limited', 0, resetTime, 'free');

      expect(error.remaining).toBe(0);
      expect(error.resetTime).toBe(resetTime);
      expect(error.tier).toBe('free');
    });

    it('should create MCPValidationError with validation info', () => {
      const error = new MCPValidationError('Invalid value', 'required', null, 'string');

      expect(error.rule).toBe('required');
      expect(error.value).toBe(null);
      expect(error.expected).toBe('string');
    });
  });

  describe('Constants', () => {
    it('should have correct subagent tool mapping', () => {
      expect(SUBAGENT_TOOL_MAPPING.claude).toBe('claude_subagent');
      expect(SUBAGENT_TOOL_MAPPING.cursor).toBe('cursor_subagent');
      expect(SUBAGENT_TOOL_MAPPING.codex).toBe('codex_subagent');
      expect(SUBAGENT_TOOL_MAPPING.gemini).toBe('gemini_subagent');
    });

    it('should have correct subagent aliases', () => {
      expect(SUBAGENT_ALIASES['claude-code']).toBe('claude');
      expect(SUBAGENT_ALIASES['claude_code']).toBe('claude');
      expect(SUBAGENT_ALIASES['gemini-cli']).toBe('gemini');
      expect(SUBAGENT_ALIASES['cursor-agent']).toBe('cursor');
    });

    it('should have sensible default values', () => {
      expect(MCP_DEFAULTS.TIMEOUT).toBe(3600000); // 1 hour
      expect(MCP_DEFAULTS.RETRIES).toBe(3);
      expect(MCP_DEFAULTS.RETRY_DELAY).toBe(1000);
      expect(typeof MCP_DEFAULTS.MAX_MEMORY_MB).toBe('number');
    });
  });

  describe('Type Safety', () => {
    it('should enforce readonly properties on config', () => {
      const config: MCPServerConfig = {
        timeout: 30000,
        retries: 3,
        retryDelay: 1000,
        workingDirectory: '/test',
      };

      // These should cause TypeScript errors if readonly is not enforced:
      // config.timeout = 60000; // Should not be allowed
      // config.retries = 5; // Should not be allowed

      expect(config.timeout).toBe(30000);
    });

    it('should enforce proper progress event structure', () => {
      const event: ProgressEvent = {
        sessionId: 'test',
        timestamp: new Date(),
        backend: 'claude',
        count: 1,
        type: ProgressEventType.THINKING,
        content: 'Processing...',
        toolId: 'claude_1',
      };

      expect(event.type).toBe(ProgressEventType.THINKING);
    });

    it('should enforce proper tool call request structure', () => {
      const request: ToolCallRequest = {
        toolName: 'claude_subagent',
        arguments: {
          instruction: 'Test instruction',
          model: 'sonnet-4',
        },
        timeout: 30000,
        priority: 'high',
      };

      expect(request.priority).toBe('high');
      expect(request.arguments.instruction).toBe('Test instruction');
    });
  });

  describe('Enums', () => {
    it('should have correct progress event types', () => {
      expect(ProgressEventType.TOOL_START).toBe('tool_start');
      expect(ProgressEventType.TOOL_RESULT).toBe('tool_result');
      expect(ProgressEventType.THINKING).toBe('thinking');
      expect(ProgressEventType.ERROR).toBe('error');
      expect(ProgressEventType.INFO).toBe('info');
    });

    it('should have correct connection states', () => {
      expect(MCPConnectionState.CONNECTED).toBe('connected');
      expect(MCPConnectionState.DISCONNECTED).toBe('disconnected');
      expect(MCPConnectionState.CONNECTING).toBe('connecting');
      expect(MCPConnectionState.FAILED).toBe('failed');
    });
  });
});