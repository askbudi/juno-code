/**
 * @fileoverview Tests for ExecutionEngine implementation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ExecutionEngine,
  type ExecutionRequest,
  type ExecutionEngineConfig,
  type ExecutionResult,
  ExecutionStatus,
  DEFAULT_ERROR_RECOVERY_CONFIG,
  DEFAULT_RATE_LIMIT_CONFIG,
  DEFAULT_PROGRESS_CONFIG
} from '../engine.js';
import {
  MCPRateLimitError,
  MCPConnectionError,
  MCPTimeoutError,
  MCPValidationError,
  MCPToolError
} from '../../mcp/errors.js';
import type {
  MCPClient,
  ProgressEvent,
  ToolCallResult,
  MCPSessionContext
} from '../../mcp/types.js';
import type { JunoTaskConfig } from '../../types/index.js';

// Mock implementations
class MockMCPClient extends EventEmitter implements MCPClient {
  connect = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn().mockResolvedValue(undefined);
  callTool = vi.fn().mockResolvedValue({ success: true, result: 'Test result' });
  isConnected = vi.fn().mockReturnValue(true);
  getConnectionState = vi.fn().mockReturnValue('connected' as const);
  getRateLimitInfo = vi.fn().mockResolvedValue({
    remaining: 100,
    resetTime: new Date(Date.now() + 60000)
  });
  onProgress = vi.fn().mockImplementation((callback) => {
    this.progressCallback = callback;
  });

  // Helper for tests
  progressCallback?: (event: ProgressEvent) => Promise<void>;

  async emitProgress(event: ProgressEvent) {
    if (this.progressCallback) {
      await this.progressCallback(event);
    }
  }
}

const createMockConfig = (): JunoTaskConfig => ({
  debug: false,
  logLevel: 'info',
  mcp: {
    serverCommand: 'test-server',
    serverArgs: [],
    timeout: 30000,
    maxConnections: 1,
    retryAttempts: 3
  },
  subagents: {
    default: 'claude',
    available: ['claude', 'cursor', 'codex', 'gemini']
  },
  execution: {
    maxIterations: 10,
    timeout: 300000,
    workingDirectory: process.cwd(),
    parallelism: 1
  },
  ai: {
    model: 'claude-3-5-sonnet-20241022',
    temperature: 0.1,
    maxTokens: 4096
  },
  templates: {
    searchPaths: ['./templates'],
    builtInEnabled: true,
    customEnabled: true
  }
});

describe('ExecutionEngine', () => {
  let engine: ExecutionEngine;
  let mockMCPClient: MockMCPClient;
  let engineConfig: ExecutionEngineConfig;

  beforeEach(() => {
    mockMCPClient = new MockMCPClient();
    mockMCPClient.setMaxListeners(20);

    engineConfig = {
      config: createMockConfig(),
      mcpClient: mockMCPClient,
      errorRecovery: DEFAULT_ERROR_RECOVERY_CONFIG,
      rateLimitConfig: DEFAULT_RATE_LIMIT_CONFIG,
      progressConfig: DEFAULT_PROGRESS_CONFIG
    };

    engine = new ExecutionEngine(engineConfig);
    engine.setMaxListeners(20);
  });

  afterEach(async () => {
    await engine.shutdown(1000);
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create an ExecutionEngine instance', () => {
      expect(engine).toBeInstanceOf(ExecutionEngine);
      expect(engine).toBeInstanceOf(EventEmitter);
    });

    it('should setup progress tracking on initialization', () => {
      expect(mockMCPClient.onProgress).toHaveBeenCalledOnce();
    });
  });

  describe('request validation', () => {
    it('should validate a proper execution request', async () => {
      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Test instruction',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 5
      };

      // Should not throw
      expect(() => engine['validateRequest'](request)).not.toThrow();
    });

    it('should reject request with empty instruction', () => {
      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: '',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 5
      };

      expect(() => engine['validateRequest'](request)).toThrow('Instruction is required');
    });

    it('should reject request with missing subagent', () => {
      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Test instruction',
        subagent: '' as any,
        workingDirectory: process.cwd(),
        maxIterations: 5
      };

      expect(() => engine['validateRequest'](request)).toThrow('Subagent is required');
    });

    it('should reject request with zero or negative iterations', () => {
      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Test instruction',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 0
      };

      expect(() => engine['validateRequest'](request)).toThrow('Max iterations must be positive or -1 for unlimited');
    });
  });

  describe('execution', () => {
    it('should execute a simple request successfully', async () => {
      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Test instruction',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      const result = await engine.execute(request);

      expect(result).toBeDefined();
      expect(result.status).toBe(ExecutionStatus.COMPLETED);
      expect(result.request).toEqual(request);
      expect(result.iterations).toHaveLength(1);
      expect(mockMCPClient.callTool).toHaveBeenCalledOnce();
    });

    it('should handle multiple iterations', async () => {
      // Mock tool call - engine will run maxIterations times
      mockMCPClient.callTool.mockResolvedValue({
        success: true,
        result: 'Iteration result'
      });

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Multi-iteration test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 2
      };

      const result = await engine.execute(request);

      expect(result.status).toBe(ExecutionStatus.COMPLETED);
      expect(result.iterations).toHaveLength(2);
      expect(mockMCPClient.callTool).toHaveBeenCalledTimes(2);
    });

    it('should respect maxIterations limit', async () => {
      // Mock tool call to always indicate continuation needed
      mockMCPClient.callTool.mockResolvedValue({
        success: true,
        result: 'Continue iteration',
        shouldContinue: true
      });

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Limited iterations test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 2
      };

      const result = await engine.execute(request);

      expect(result.status).toBe(ExecutionStatus.COMPLETED);
      expect(result.iterations).toHaveLength(2);
      expect(mockMCPClient.callTool).toHaveBeenCalledTimes(2);
    });

    it.skip('should handle execution cancellation via AbortSignal', async () => {
      const abortController = new AbortController();

      // Mock slow tool call
      mockMCPClient.callTool.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { success: true, result: 'Test result' };
      });

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Cancellation test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 5
      };

      // Start execution and cancel after 100ms
      const executionPromise = engine.execute(request, abortController.signal);
      setTimeout(() => abortController.abort(), 100);

      await expect(executionPromise).rejects.toThrow('Execution aborted');
    });
  });

  describe('error handling', () => {
    it('should handle rate limit errors with retry', async () => {
      const rateLimitError = MCPRateLimitError.hourly(new Date(Date.now() + 1000), 0);

      mockMCPClient.callTool
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ success: true, result: 'Success after retry' });

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Rate limit test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      const result = await engine.execute(request);

      expect(result.status).toBe(ExecutionStatus.COMPLETED);
      expect(mockMCPClient.callTool).toHaveBeenCalledTimes(2);
    });

    it('should handle connection errors', async () => {
      const connectionError = MCPConnectionError.serverNotFound('test-server');
      mockMCPClient.callTool.mockRejectedValue(connectionError);

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Connection error test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      const result = await engine.execute(request);

      expect(result.status).toBe(ExecutionStatus.COMPLETED);
      expect(result.iterations[0].error).toBeInstanceOf(MCPConnectionError);
      expect(result.statistics.errorBreakdown.connection).toBe(1);
    });

    it('should handle timeout errors', async () => {
      const timeoutError = MCPTimeoutError.toolExecution('test-tool', 30000);
      mockMCPClient.callTool.mockRejectedValue(timeoutError);

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Timeout error test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      const result = await engine.execute(request);

      expect(result.status).toBe(ExecutionStatus.COMPLETED);
      expect(result.iterations[0].error).toBeInstanceOf(MCPTimeoutError);
    });

    it('should handle validation errors', async () => {
      const validationError = MCPValidationError.required('instruction');
      mockMCPClient.callTool.mockRejectedValue(validationError);

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Validation error test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      const result = await engine.execute(request);

      expect(result.status).toBe(ExecutionStatus.FAILED);
      expect(result.iterations[0].error).toBeInstanceOf(MCPValidationError);
    });

    it('should wrap unknown errors as MCPError', async () => {
      const unknownError = new Error('Unknown error');
      mockMCPClient.callTool.mockRejectedValue(unknownError);

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Unknown error test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      const result = await engine.execute(request);

      expect(result.status).toBe(ExecutionStatus.FAILED);
      expect(result.iterations[0].error).toBeDefined();
    });
  });

  describe('progress tracking', () => {
    it('should emit execution events', async () => {
      const startSpy = vi.fn();
      const completeSpy = vi.fn();

      engine.on('execution:start', startSpy);
      engine.on('execution:complete', completeSpy);

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Progress test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      await engine.execute(request);

      expect(startSpy).toHaveBeenCalledOnce();
      expect(completeSpy).toHaveBeenCalledOnce();
    });

    it.skip('should process progress events from MCP client', async () => {
      const progressSpy = vi.fn();
      engine.on('progress', progressSpy);

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Progress events test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      // Start execution and simulate progress events
      const executionPromise = engine.execute(request);

      await mockMCPClient.emitProgress({
        type: 'start',
        timestamp: new Date(),
        message: 'Starting execution',
        sessionId: 'test-session',
        metadata: {}
      });

      await executionPromise;

      expect(progressSpy).toHaveBeenCalled();
    });
  });

  describe('rate limit handling', () => {
    it.skip('should provide rate limit information', async () => {
      const rateLimitInfo = await engine.getRateLimitInfo();

      expect(rateLimitInfo).toBeDefined();
      expect(rateLimitInfo.remaining).toBe(100);
      expect(rateLimitInfo.resetTime).toBeDefined();
      expect(mockMCPClient.getRateLimitInfo).toHaveBeenCalledOnce();
    });

    it('should calculate rate limit wait time correctly', () => {
      const resetTime = new Date(Date.now() + 30000); // 30 seconds from now
      const rateLimitError = MCPRateLimitError.hourly(resetTime, 0);

      const waitTime = engine['calculateRateLimitWaitTime'](rateLimitError);

      expect(waitTime).toBeGreaterThan(25000); // Should be close to 30 seconds
      expect(waitTime).toBeLessThan(35000);
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      await expect(engine.shutdown(5000)).resolves.not.toThrow();
    });

    it('should cancel active executions during shutdown', async () => {
      // Mock slow tool call
      mockMCPClient.callTool.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { success: true, result: 'Test result' };
      });

      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Shutdown test',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 1
      };

      // Start execution and shutdown immediately
      const executionPromise = engine.execute(request);
      const shutdownPromise = engine.shutdown(2000);

      await Promise.allSettled([executionPromise, shutdownPromise]);
    });
  });

  describe('utility methods', () => {
    it('should get correct tool name for subagent', () => {
      expect(engine['getToolNameForSubagent']('claude')).toBe('claude_subagent');
      expect(engine['getToolNameForSubagent']('cursor')).toBe('cursor_subagent');
      expect(engine['getToolNameForSubagent']('codex')).toBe('codex_subagent');
      expect(engine['getToolNameForSubagent']('gemini')).toBe('gemini_subagent');
    });

    it('should determine correct error status', () => {
      const connectionError = MCPConnectionError.serverNotFound('test');
      const rateLimitError = MCPRateLimitError.hourly(new Date(), 0);
      const timeoutError = MCPTimeoutError.toolExecution('test', 30000);

      expect(engine['determineErrorStatus'](connectionError)).toBe(ExecutionStatus.FAILED);
      expect(engine['determineErrorStatus'](rateLimitError)).toBe(ExecutionStatus.RATE_LIMITED);
      expect(engine['determineErrorStatus'](timeoutError)).toBe(ExecutionStatus.TIMEOUT);
    });
  });

  describe('session context creation', () => {
    it('should create proper session context', () => {
      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Test instruction',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 5
      };

      const sessionContext = engine['createSessionContext'](request);

      expect(sessionContext.sessionId).toBeDefined();
      expect(sessionContext.metadata.workingDirectory).toBe(request.workingDirectory);
      expect(sessionContext.metadata.subagent).toBe(request.subagent);
      expect(sessionContext.startTime).toBeInstanceOf(Date);
    });

    it('should include session metadata', () => {
      const request: ExecutionRequest = {
        requestId: 'test-request-123',
        instruction: 'Test instruction',
        subagent: 'claude',
        workingDirectory: process.cwd(),
        maxIterations: 5,
        sessionMetadata: { customField: 'test-value' }
      };

      const sessionContext = engine['createSessionContext'](request);

      expect(sessionContext.metadata.customField).toBe('test-value');
      expect(sessionContext.state).toBe('initializing');
      expect(sessionContext.userId).toBe('system');
    });
  });
});