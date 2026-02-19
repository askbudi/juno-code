/**
 * @fileoverview Simple tests for Session management implementation
 * Focus on core logic without filesystem mocking complexity
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SessionManager,
  createSessionManager,
  type Session,
  type SessionInfo,
  type SessionStatistics,
  type SessionHistoryEntry,
  type SessionStorage,
  type SessionListFilter,
  type CleanupOptions,
} from '../session.js';
import type { JunoTaskConfig, SubagentType, SessionStatus } from '../../types/index.js';

// Create mock storage implementation
class MockSessionStorage implements SessionStorage {
  private sessions: Map<string, Session> = new Map();

  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.info.id, JSON.parse(JSON.stringify(session)));
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Properly deserialize dates like FileSessionStorage does
    const serialized = JSON.parse(JSON.stringify(session));
    return {
      ...serialized,
      info: {
        ...serialized.info,
        createdAt: new Date(serialized.info.createdAt),
        updatedAt: new Date(serialized.info.updatedAt),
        completedAt: serialized.info.completedAt ? new Date(serialized.info.completedAt) : undefined,
      },
      history: serialized.history.map((entry: any) => ({
        ...entry,
        timestamp: new Date(entry.timestamp),
      })),
    };
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values()).map(s => s.info);
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async cleanup(): Promise<void> {
    // Mock cleanup
  }
}

// Helper functions for creating test data
const createMockConfig = (): JunoTaskConfig => ({
  defaultSubagent: 'claude',
  defaultMaxIterations: 10,
  defaultModel: 'claude-3-5-sonnet-20241022',
  logLevel: 'info',
  verbose: false,
  quiet: false,
  mcpTimeout: 30000,
  mcpRetries: 3,
  interactive: false,
  headlessMode: false,
  workingDirectory: '/test/working/dir',
  sessionDirectory: '/test/sessions',
});

describe('SessionManager (Core Logic)', () => {
  let sessionManager: SessionManager;
  let mockStorage: MockSessionStorage;

  beforeEach(() => {
    mockStorage = new MockSessionStorage();
    sessionManager = new SessionManager(mockStorage);
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create SessionManager instance', () => {
      expect(sessionManager).toBeInstanceOf(SessionManager);
    });

    it('should NOT be an EventEmitter', () => {
      // SessionManager is a plain class, not an EventEmitter
      expect(typeof (sessionManager as any).on).not.toBe('function');
      expect(typeof (sessionManager as any).emit).not.toBe('function');
    });
  });

  describe('createSession', () => {
    it('should create a new session with required options', async () => {
      const config = createMockConfig();

      const sessionOptions = {
        name: 'Test Session',
        subagent: 'claude' as SubagentType,
        config,
        tags: ['test', 'development'],
        metadata: { testKey: 'testValue' },
      };

      const session = await sessionManager.createSession(sessionOptions);

      expect(session).toBeDefined();
      expect(session.info.id).toBeDefined();
      expect(session.info.name).toBe('Test Session');
      expect(session.info.status).toBe('running');
      expect(session.info.subagent).toBe('claude');
      expect(session.info.tags).toEqual(['test', 'development']);
      expect(session.info.metadata).toEqual({ testKey: 'testValue' });
      expect(session.context.workingDirectory).toBe(config.workingDirectory);
      expect(session.statistics.duration).toBe(0);
      expect(session.history).toEqual([]);
    });

    it('should create session without optional parameters', async () => {
      const config = createMockConfig();

      const sessionOptions = {
        subagent: 'claude' as SubagentType,
        config,
      };

      const session = await sessionManager.createSession(sessionOptions);

      expect(session.info.name).toBeUndefined();
      expect(session.info.tags).toEqual([]);
      expect(session.info.metadata).toEqual({});
    });

    it('should have simplified context with workingDirectory and config', async () => {
      const config = createMockConfig();

      const sessionOptions = {
        subagent: 'claude' as SubagentType,
        config,
      };

      const session = await sessionManager.createSession(sessionOptions);

      // Simplified context: just workingDirectory and config
      expect(session.context.workingDirectory).toBe(config.workingDirectory);
      expect(session.context.config).toBeDefined();
      // No environment, gitInfo, or processInfo
      expect((session.context as any).environment).toBeUndefined();
      expect((session.context as any).gitInfo).toBeUndefined();
      expect((session.context as any).processInfo).toBeUndefined();
    });

    it('should have simplified statistics with only essential counters', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      expect(session.statistics).toEqual({
        duration: 0,
        iterations: 0,
        toolCalls: 0,
        errorCount: 0,
      });

      // No toolStats, successRate, warningCount, memoryUsage, performance
      expect((session.statistics as any).toolStats).toBeUndefined();
      expect((session.statistics as any).successRate).toBeUndefined();
      expect((session.statistics as any).warningCount).toBeUndefined();
      expect((session.statistics as any).memoryUsage).toBeUndefined();
      expect((session.statistics as any).performance).toBeUndefined();
    });
  });

  describe('updateSession', () => {
    it('should update session from active sessions', async () => {
      const config = createMockConfig();

      // Create initial session
      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const updates = {
        status: 'completed' as SessionStatus,
        name: 'Updated Session',
        tags: ['updated'],
        metadata: { updated: true },
      };

      await sessionManager.updateSession(session.info.id, updates);

      const updatedSession = await sessionManager.getSession(session.info.id);
      expect(updatedSession!.info.status).toBe('completed');
      expect(updatedSession!.info.name).toBe('Updated Session');
      expect(updatedSession!.info.tags).toEqual(['updated']);
      expect(updatedSession!.info.metadata.updated).toBe(true);
    });

    it('should throw error if session not found', async () => {
      await expect(
        sessionManager.updateSession('nonexistent-session', { status: 'completed' })
      ).rejects.toThrow('Session nonexistent-session not found');
    });

    it('should merge metadata correctly', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
        metadata: { existing: 'value', toUpdate: 'old' },
      });

      const updates = {
        metadata: { toUpdate: 'new', added: 'field' },
      };

      await sessionManager.updateSession(session.info.id, updates);

      const updatedSession = await sessionManager.getSession(session.info.id);
      expect(updatedSession!.info.metadata).toEqual({
        existing: 'value',
        toUpdate: 'new',
        added: 'field',
      });
    });
  });

  describe('completeSession', () => {
    it('should complete session successfully', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const result = {
        success: true,
        output: 'Task completed',
        finalState: { status: 'done' },
      };

      await sessionManager.completeSession(session.info.id, result);

      const completedSession = await sessionManager.getSession(session.info.id);
      expect(completedSession!.info.status).toBe('completed');
      expect(completedSession!.info.completedAt).toBeInstanceOf(Date);
      expect(completedSession!.result).toEqual(result);
      expect(completedSession!.statistics.duration).toBeGreaterThanOrEqual(0);
    });

    it('should complete session with failure', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const result = {
        success: false,
        error: 'Task failed',
      };

      await sessionManager.completeSession(session.info.id, result);

      const completedSession = await sessionManager.getSession(session.info.id);
      expect(completedSession!.info.status).toBe('failed');
      expect(completedSession!.result).toEqual(result);
    });
  });

  describe('addHistoryEntry', () => {
    it('should add history entry to session', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const entry = {
        type: 'prompt' as const,
        content: 'Test prompt',
        data: { test: true },
        duration: 1000,
        iteration: 1,
      };

      await sessionManager.addHistoryEntry(session.info.id, entry);

      const updatedSession = await sessionManager.getSession(session.info.id);
      expect(updatedSession!.history).toHaveLength(1);
      expect(updatedSession!.history[0].id).toBeDefined();
      expect(updatedSession!.history[0].timestamp).toBeInstanceOf(Date);
      expect(updatedSession!.history[0].type).toBe('prompt');
      expect(updatedSession!.history[0].content).toBe('Test prompt');
    });

    it('should throw error if session not found', async () => {
      await expect(
        sessionManager.addHistoryEntry('nonexistent-session', {
          type: 'prompt',
          content: 'Test',
        })
      ).rejects.toThrow('Session nonexistent-session not found');
    });
  });

  describe('recordToolCall', () => {
    it('should increment toolCalls counter', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const toolCall = {
        name: 'test-tool',
        duration: 500,
        success: true,
      };

      await sessionManager.recordToolCall(session.info.id, toolCall);

      const updatedSession = await sessionManager.getSession(session.info.id);
      expect(updatedSession!.statistics.toolCalls).toBe(1);
      expect(updatedSession!.statistics.errorCount).toBe(0);
      // No toolStats tracking in simplified version
      expect((updatedSession!.statistics as any).toolStats).toBeUndefined();
    });

    it('should increment errorCount for failed tool calls', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      await sessionManager.recordToolCall(session.info.id, {
        name: 'test-tool',
        duration: 500,
        success: false,
      });

      const updatedSession = await sessionManager.getSession(session.info.id);
      expect(updatedSession!.statistics.toolCalls).toBe(1);
      expect(updatedSession!.statistics.errorCount).toBe(1);
    });

    it('should accumulate multiple tool calls', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      // First call - success
      await sessionManager.recordToolCall(session.info.id, {
        name: 'test-tool',
        duration: 500,
        success: true,
      });

      // Second call - failure
      await sessionManager.recordToolCall(session.info.id, {
        name: 'test-tool',
        duration: 300,
        success: false,
      });

      // Third call - success with different tool
      await sessionManager.recordToolCall(session.info.id, {
        name: 'other-tool',
        duration: 200,
        success: true,
      });

      const updatedSession = await sessionManager.getSession(session.info.id);
      expect(updatedSession!.statistics.toolCalls).toBe(3);
      expect(updatedSession!.statistics.errorCount).toBe(1);
    });
  });

  describe('getSessionContext', () => {
    it('should return formatted session context', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        name: 'Test Session',
        subagent: 'claude' as SubagentType,
        config,
        tags: ['test', 'development'],
      });

      const context = await sessionManager.getSessionContext(session.info.id);

      expect(context).toContain(`Session ${session.info.id} Context:`);
      expect(context).toContain('Status: running');
      expect(context).toContain('Subagent: claude');
      expect(context).toContain('Working Directory: /test/working/dir');
      expect(context).toContain('Tags: test, development');
    });

    it('should include statistics when requested', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const context = await sessionManager.getSessionContext(session.info.id, {
        includeStats: true,
      });

      expect(context).toContain('Statistics:');
      expect(context).toContain('Iterations: 0');
      expect(context).toContain('Tool Calls: 0');
      expect(context).toContain('Duration: 0ms');
      // No Success Rate in simplified version
      expect(context).not.toContain('Success Rate');
    });

    it('should return not found message for missing session', async () => {
      const context = await sessionManager.getSessionContext('nonexistent-session');

      expect(context).toBe('Session nonexistent-session: Not found');
    });
  });

  describe('getSessionSummary', () => {
    it('should return comprehensive session summary', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      // Add some test data
      await sessionManager.updateStatistics(session.info.id, {
        duration: 300000, // 5 minutes
        iterations: 5,
        toolCalls: 15,
        errorCount: 2,
      });

      const summary = await sessionManager.getSessionSummary(session.info.id);

      expect(summary).toBeDefined();
      expect(summary!.info.id).toBe(session.info.id);
      expect(summary!.summary.totalDuration).toBe('5m 0s');
      expect(summary!.summary.iterationsPerMinute).toBe(1);
      expect(summary!.summary.toolCallsPerIteration).toBe(3);
      expect(summary!.summary.errorRate).toBeCloseTo(0.133, 2);
      // No mostUsedTool in simplified version
      expect((summary!.summary as any).mostUsedTool).toBeUndefined();
    });

    it('should return null for missing session', async () => {
      const summary = await sessionManager.getSessionSummary('nonexistent-session');

      expect(summary).toBeNull();
    });

    it('should handle zero duration', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const summary = await sessionManager.getSessionSummary(session.info.id);

      expect(summary!.summary.iterationsPerMinute).toBe(0);
    });

    it('should handle zero iterations for toolCallsPerIteration', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      await sessionManager.updateStatistics(session.info.id, {
        duration: 60000,
        iterations: 0,
        toolCalls: 5,
        errorCount: 0,
      });

      const summary = await sessionManager.getSessionSummary(session.info.id);

      expect(summary!.summary.toolCallsPerIteration).toBe(0);
    });

    it('should calculate errorRate as errorCount / toolCalls', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      await sessionManager.updateStatistics(session.info.id, {
        duration: 60000,
        iterations: 2,
        toolCalls: 10,
        errorCount: 3,
      });

      const summary = await sessionManager.getSessionSummary(session.info.id);

      expect(summary!.summary.errorRate).toBe(0.3);
    });
  });

  describe('cancelSession', () => {
    it('should cancel session', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      await sessionManager.cancelSession(session.info.id);

      const cancelledSession = await sessionManager.getSession(session.info.id);
      expect(cancelledSession!.info.status).toBe('cancelled');
    });
  });

  describe('listSessions', () => {
    it('should list all sessions', async () => {
      const config = createMockConfig();

      const session1 = await sessionManager.createSession({
        name: 'Session 1',
        subagent: 'claude' as SubagentType,
        config,
      });

      const session2 = await sessionManager.createSession({
        name: 'Session 2',
        subagent: 'cursor' as SubagentType,
        config,
      });

      const sessions = await sessionManager.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id)).toContain(session1.info.id);
      expect(sessions.map(s => s.id)).toContain(session2.info.id);
    });
  });

  describe('removeSession', () => {
    it('should remove session', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      await sessionManager.removeSession(session.info.id);

      const removedSession = await sessionManager.getSession(session.info.id);
      expect(removedSession).toBeNull();
    });
  });

  describe('cleanupSessions', () => {
    it('should cleanup sessions without emitting events', async () => {
      // cleanupSessions is a plain method call, no events
      await sessionManager.cleanupSessions({ removeOlderThanDays: 30 });
      // No event assertions - SessionManager is not an EventEmitter
    });
  });

  describe('updateStatistics', () => {
    it('should update session statistics', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const stats = { iterations: 5, toolCalls: 10 };
      await sessionManager.updateStatistics(session.info.id, stats);

      const updatedSession = await sessionManager.getSession(session.info.id);
      expect(updatedSession!.statistics.iterations).toBe(5);
      expect(updatedSession!.statistics.toolCalls).toBe(10);
    });
  });

  describe('getSession', () => {
    it('should return session from active sessions', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const retrieved = await sessionManager.getSession(session.info.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.info.id).toBe(session.info.id);
    });

    it('should return null if session not found', async () => {
      const retrieved = await sessionManager.getSession('nonexistent-session');

      expect(retrieved).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle recordToolCall for nonexistent session gracefully', async () => {
      // This should not throw
      await sessionManager.recordToolCall('nonexistent-session', {
        name: 'test-tool',
        duration: 500,
        success: true,
      });

      // No assertions needed, just ensuring it doesn't throw
    });

    it('should handle session with no name in context', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
        // No name provided
      });

      const context = await sessionManager.getSessionContext(session.info.id);

      expect(context).toContain(`Session ${session.info.id} Context:`);
      expect(context).not.toContain('Tags:'); // No tags section when empty
    });

    it('should handle session with empty history in context', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const context = await sessionManager.getSessionContext(session.info.id, {
        includeHistory: true,
      });

      expect(context).not.toContain('Recent History:');
    });

    it('should handle session with history in context', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      // Add history entry
      await sessionManager.addHistoryEntry(session.info.id, {
        type: 'prompt',
        content: 'Test prompt with a very long content that should be truncated in the context view',
      });

      const context = await sessionManager.getSessionContext(session.info.id, {
        includeHistory: true,
      });

      expect(context).toContain('Recent History:');
      expect(context).toContain('prompt: Test prompt with a very long content that should be truncated in the context view');
    });

    it('should handle malformed history timestamp in context', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      // Manually add malformed history entry
      const sessionData = await sessionManager.getSession(session.info.id);
      sessionData!.history.push({
        id: 'test-id',
        timestamp: undefined as any,
        type: 'prompt',
        content: 'Test with bad timestamp',
      });

      await mockStorage.saveSession(sessionData!);

      const context = await sessionManager.getSessionContext(session.info.id, {
        includeHistory: true,
      });

      expect(context).toContain('[unknown] prompt: Test with bad timestamp');
    });
  });
});

describe('createSessionManager', () => {
  it('should be a function', () => {
    expect(typeof createSessionManager).toBe('function');
  });
});
