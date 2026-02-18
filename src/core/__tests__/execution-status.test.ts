/**
 * Tests for execution status determination when iterations fail.
 *
 * When all iterations fail (e.g., subagent crashes with non-zero exit code),
 * the execution status should be FAILED, not COMPLETED.
 * This prevents misleading "Execution completed successfully!" messages
 * and ensures the process exit code is 1 (not 0).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ExecutionEngine,
  ExecutionStatus,
  type ExecutionRequest,
  type ExecutionEngineConfig,
  DEFAULT_ERROR_RECOVERY_CONFIG,
  DEFAULT_RATE_LIMIT_CONFIG,
  DEFAULT_PROGRESS_CONFIG,
} from '../engine.js';
import type {
  ToolCallResult,
  MCPClient,
  ProgressEvent,
  SessionContext,
} from '../../types/execution.js';
import type { JunoTaskConfig } from '../../types/index.js';

// Minimal mock MCP client
class MockMCPClient extends EventEmitter implements MCPClient {
  connect = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn().mockResolvedValue(undefined);
  callTool = vi.fn();
  isConnected = vi.fn().mockReturnValue(true);
  getConnectionState = vi.fn().mockReturnValue('connected' as const);
  getRateLimitInfo = vi.fn().mockResolvedValue({
    remaining: 100,
    resetTime: new Date(Date.now() + 60000),
  });
  onProgress = vi.fn();
}

// Minimal mock backend that selectBackend returns
class MockBackend {
  onProgress = vi.fn().mockReturnValue(() => {});
  configure = vi.fn();
  initialize = vi.fn().mockResolvedValue(undefined);
}

// Mock backend manager that returns configurable results
class MockBackendManager {
  private _executeResult: ToolCallResult;
  private _backend = new MockBackend();

  constructor(result: Partial<ToolCallResult> = {}) {
    this._executeResult = {
      content: result.content ?? '{"type":"result","result":"ok"}',
      status: result.status ?? 'completed',
      startTime: new Date(),
      endTime: new Date(),
      duration: 100,
      progressEvents: [],
      request: {} as any,
      ...result,
    };
  }

  selectBackend = vi.fn().mockImplementation(async () => this._backend);
  execute = vi.fn().mockImplementation(async () => this._executeResult);
  cleanup = vi.fn().mockResolvedValue(undefined);
  getAvailableBackends = vi.fn().mockReturnValue(['shell']);
  getActiveBackend = vi.fn().mockReturnValue('shell');
}

const createConfig = (): JunoTaskConfig => ({
  debug: false,
  logLevel: 'info',
  mcp: {
    serverCommand: 'test',
    serverArgs: [],
    timeout: 30000,
    maxConnections: 1,
    retryAttempts: 1,
  },
  subagents: { default: 'claude', available: ['claude', 'pi'] },
  execution: {
    maxIterations: 10,
    timeout: 300000,
    workingDirectory: process.cwd(),
    parallelism: 1,
  },
  ai: { model: 'test', temperature: 0.1, maxTokens: 4096 },
  templates: { searchPaths: ['./templates'], builtInEnabled: true, customEnabled: true },
});

const createRequest = (overrides: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  requestId: 'test-req-1',
  instruction: 'Test instruction',
  subagent: 'pi',
  workingDirectory: process.cwd(),
  maxIterations: 1,
  ...overrides,
});

describe('Execution status determination', () => {
  let engine: ExecutionEngine;
  let mockClient: MockMCPClient;

  const createEngine = (backendManager: MockBackendManager) => {
    mockClient = new MockMCPClient();
    const config: ExecutionEngineConfig = {
      client: mockClient as unknown as MCPClient,
      config: createConfig(),
      backendManager: backendManager as any,
      errorRecovery: DEFAULT_ERROR_RECOVERY_CONFIG,
      rateLimit: DEFAULT_RATE_LIMIT_CONFIG,
      progress: DEFAULT_PROGRESS_CONFIG,
    };
    return new ExecutionEngine(config);
  };

  it('should set status to FAILED when all iterations fail', async () => {
    const backendManager = new MockBackendManager({
      status: 'failed',
      content: JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Error: No API key found',
        error: 'Error: No API key found',
        exit_code: 1,
      }),
      error: { type: 'shell_execution', message: 'Error: No API key found', timestamp: new Date() },
    });
    engine = createEngine(backendManager);
    const result = await engine.execute(createRequest({ maxIterations: 1 }));

    expect(result.status).toBe(ExecutionStatus.FAILED);
    expect(result.statistics.failedIterations).toBe(1);
    expect(result.statistics.successfulIterations).toBe(0);
  });

  it('should set status to COMPLETED when at least one iteration succeeds', async () => {
    let callCount = 0;
    const backendManager = new MockBackendManager();
    backendManager.execute = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First iteration fails
        return {
          content: '{"is_error":true}',
          status: 'failed',
          startTime: new Date(),
          endTime: new Date(),
          duration: 100,
          progressEvents: [],
          request: {} as any,
          error: { type: 'shell_execution', message: 'fail', timestamp: new Date() },
        };
      }
      // Second iteration succeeds
      return {
        content: '{"result":"ok"}',
        status: 'completed',
        startTime: new Date(),
        endTime: new Date(),
        duration: 100,
        progressEvents: [],
        request: {} as any,
      };
    });
    engine = createEngine(backendManager);
    const result = await engine.execute(createRequest({ maxIterations: 2 }));

    expect(result.status).toBe(ExecutionStatus.COMPLETED);
    expect(result.statistics.successfulIterations).toBe(1);
    expect(result.statistics.failedIterations).toBe(1);
  });

  it('should set status to COMPLETED when all iterations succeed', async () => {
    const backendManager = new MockBackendManager({
      status: 'completed',
      content: '{"result":"ok"}',
    });
    engine = createEngine(backendManager);
    const result = await engine.execute(createRequest({ maxIterations: 1 }));

    expect(result.status).toBe(ExecutionStatus.COMPLETED);
    expect(result.statistics.successfulIterations).toBe(1);
    expect(result.statistics.failedIterations).toBe(0);
  });

  it('should set status to FAILED when multiple iterations all fail', async () => {
    const backendManager = new MockBackendManager({
      status: 'failed',
      content: '{"is_error":true,"error":"crash"}',
      error: { type: 'shell_execution', message: 'crash', timestamp: new Date() },
    });
    engine = createEngine(backendManager);
    const result = await engine.execute(createRequest({ maxIterations: 3 }));

    expect(result.status).toBe(ExecutionStatus.FAILED);
    expect(result.statistics.failedIterations).toBe(3);
    expect(result.statistics.successfulIterations).toBe(0);
  });

  it('should use exit code 1 when execution status is FAILED', async () => {
    const backendManager = new MockBackendManager({
      status: 'failed',
      content: '{"is_error":true}',
      error: { type: 'shell_execution', message: 'fail', timestamp: new Date() },
    });
    engine = createEngine(backendManager);
    const result = await engine.execute(createRequest());

    // The exit code logic in main.ts: result.status === COMPLETED ? 0 : 1
    const exitCode = result.status === ExecutionStatus.COMPLETED ? 0 : 1;
    expect(exitCode).toBe(1);
  });
});
