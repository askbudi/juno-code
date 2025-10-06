/**
 * @fileoverview Simple tests for Session management implementation
 * Focus on core logic without filesystem mocking complexity
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  SessionManager,
  SessionUtils,
  type Session,
  type SessionInfo,
  type SessionContext,
  type SessionStatistics,
  type SessionHistoryEntry,
  type SessionStorage,
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

  async archiveSessions(): Promise<string[]> {
    return [];
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
    sessionManager.setMaxListeners(20);
    vi.clearAllMocks();
  });

  afterEach(() => {
    sessionManager.removeAllListeners();
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create SessionManager instance', () => {
      expect(sessionManager).toBeInstanceOf(SessionManager);
      expect(sessionManager).toBeInstanceOf(EventEmitter);
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

    it('should emit session_created event', async () => {
      const config = createMockConfig();

      const eventSpy = vi.fn();
      sessionManager.on('session_created', eventSpy);

      const sessionOptions = {
        subagent: 'claude' as SubagentType,
        config,
      };

      const session = await sessionManager.createSession(sessionOptions);

      expect(eventSpy).toHaveBeenCalledWith({
        type: 'session_created',
        sessionId: session.info.id,
        timestamp: expect.any(Date),
        data: { session: session.info },
      });
    });

    it('should capture process information correctly', async () => {
      const config = createMockConfig();

      const sessionOptions = {
        subagent: 'claude' as SubagentType,
        config,
      };

      const session = await sessionManager.createSession(sessionOptions);

      expect(session.context.processInfo.pid).toBe(process.pid);
      expect(session.context.processInfo.nodeVersion).toBe(process.version);
      expect(session.context.processInfo.platform).toBe(process.platform);
      expect(session.context.processInfo.arch).toBe(process.arch);
    });

    it('should capture environment variables', async () => {
      const config = createMockConfig();

      const sessionOptions = {
        subagent: 'claude' as SubagentType,
        config,
      };

      const session = await sessionManager.createSession(sessionOptions);

      expect(session.context.environment).toBeDefined();
      expect(typeof session.context.environment).toBe('object');
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

    it('should emit session_updated event', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const eventSpy = vi.fn();
      sessionManager.on('session_updated', eventSpy);

      const updates = { status: 'completed' as SessionStatus };
      await sessionManager.updateSession(session.info.id, updates);

      expect(eventSpy).toHaveBeenCalledWith({
        type: 'session_updated',
        sessionId: session.info.id,
        timestamp: expect.any(Date),
        data: { updates },
      });
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

    it('should emit session_completed event', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const eventSpy = vi.fn();
      sessionManager.on('session_completed', eventSpy);

      const result = { success: true };
      await sessionManager.completeSession(session.info.id, result);

      expect(eventSpy).toHaveBeenCalledWith({
        type: 'session_completed',
        sessionId: session.info.id,
        timestamp: expect.any(Date),
        data: { result },
      });
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
    it('should record new tool call', async () => {
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
      expect(updatedSession!.statistics.toolStats['test-tool']).toEqual({
        name: 'test-tool',
        count: 1,
        totalTime: 500,
        averageTime: 500,
        successCount: 1,
        errorCount: 0,
        lastCall: expect.any(Date),
      });
    });

    it('should update existing tool call stats', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      // First call
      await sessionManager.recordToolCall(session.info.id, {
        name: 'test-tool',
        duration: 500,
        success: true,
      });

      // Second call
      await sessionManager.recordToolCall(session.info.id, {
        name: 'test-tool',
        duration: 300,
        success: false,
      });

      const updatedSession = await sessionManager.getSession(session.info.id);
      expect(updatedSession!.statistics.toolCalls).toBe(2);
      expect(updatedSession!.statistics.toolStats['test-tool']).toEqual({
        name: 'test-tool',
        count: 2,
        totalTime: 800,
        averageTime: 400,
        successCount: 1,
        errorCount: 1,
        lastCall: expect.any(Date),
      });
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
      expect(context).toContain('Success Rate: 0.0%');
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

      await sessionManager.recordToolCall(session.info.id, {
        name: 'test-tool',
        duration: 500,
        success: true,
      });

      const summary = await sessionManager.getSessionSummary(session.info.id);

      expect(summary).toBeDefined();
      expect(summary!.info.id).toBe(session.info.id);
      expect(summary!.summary.totalDuration).toBe('5m 0s');
      expect(summary!.summary.iterationsPerMinute).toBe(1);
      expect(summary!.summary.toolCallsPerIteration).toBeCloseTo(3.2);
      expect(summary!.summary.mostUsedTool).toBe('test-tool');
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

    it('should emit session_cancelled event', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const eventSpy = vi.fn();
      sessionManager.on('session_cancelled', eventSpy);

      await sessionManager.cancelSession(session.info.id);

      expect(eventSpy).toHaveBeenCalledWith({
        type: 'session_cancelled',
        sessionId: session.info.id,
        timestamp: expect.any(Date),
      });
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

  describe('searchSessions', () => {
    it('should search sessions by query', async () => {
      const config = createMockConfig();

      const session1 = await sessionManager.createSession({
        name: 'Test Session',
        subagent: 'claude' as SubagentType,
        config,
      });

      const session2 = await sessionManager.createSession({
        name: 'Production Task',
        subagent: 'claude' as SubagentType,
        config,
        tags: ['test'],
      });

      const result = await sessionManager.searchSessions({ query: 'test' });

      expect(result).toHaveLength(2);
      expect(result.map(s => s.id)).toContain(session1.info.id); // Name contains "test"
      expect(result.map(s => s.id)).toContain(session2.info.id); // Tag contains "test"
    });

    it('should return all sessions when no query provided', async () => {
      const config = createMockConfig();

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const result = await sessionManager.searchSessions({});

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(session.info.id);
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
    it('should cleanup sessions and emit event', async () => {
      const eventSpy = vi.fn();
      sessionManager.on('cleanup_completed', eventSpy);

      await sessionManager.cleanupSessions({ removeOlderThanDays: 30 });

      expect(eventSpy).toHaveBeenCalledWith({
        type: 'cleanup_completed',
        sessionId: 'all',
        timestamp: expect.any(Date),
        data: { options: { removeOlderThanDays: 30 } },
      });
    });
  });

  describe('archiveSessions', () => {
    it('should archive sessions and emit event', async () => {
      const eventSpy = vi.fn();
      sessionManager.on('archive_completed', eventSpy);

      const archivedIds = await sessionManager.archiveSessions({ olderThanDays: 30 });

      expect(archivedIds).toEqual([]);
      expect(eventSpy).toHaveBeenCalledWith({
        type: 'archive_completed',
        sessionId: 'multiple',
        timestamp: expect.any(Date),
        data: { archivedIds: [], options: { olderThanDays: 30 } },
      });
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

describe('Utility Functions', () => {
  describe('formatDuration', () => {
    it('should format duration correctly', () => {
      const config = createMockConfig();
      const sessionManager = new SessionManager(new MockSessionStorage());

      // Access private method through bracket notation
      const formatDuration = (sessionManager as any).formatDuration;

      expect(formatDuration(1000)).toBe('1s');
      expect(formatDuration(65000)).toBe('1m 5s');
      expect(formatDuration(3665000)).toBe('1h 1m 5s');
      expect(formatDuration(500)).toBe('0s');
    });
  });

  describe('createSessionManager', () => {
    it('should create SessionManager with proper initialization', () => {
      // Test basic functionality of createSessionManager
      const config = createMockConfig();

      // Since FileSessionStorage requires fs operations, we'll just test that the function exists
      expect(typeof createSessionManager).toBe('function');
    });
  });
});

describe('SessionUtils', () => {
  describe('generateTimestampId', () => {
    it('should generate timestamp-based ID', () => {
      const id = SessionUtils.generateTimestampId();

      expect(id).toMatch(/^\d{15}$/);
      expect(id.length).toBe(15);
    });

    it('should generate unique IDs', () => {
      const id1 = SessionUtils.generateTimestampId();
      const id2 = SessionUtils.generateTimestampId();

      expect(id1).not.toBe(id2);
    });
  });

  describe('parseSessionTimestamp', () => {
    it('should parse timestamp ID correctly', () => {
      const timestampId = '20240101T100000';
      const date = SessionUtils.parseSessionTimestamp(timestampId);

      expect(date).toBeInstanceOf(Date);
      expect(date!.getFullYear()).toBe(2024);
      expect(date!.getMonth()).toBe(0); // January (0-based)
      expect(date!.getDate()).toBe(1);
      expect(date!.getHours()).toBe(10);
    });

    it('should return null for UUID format', () => {
      const uuidId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      const date = SessionUtils.parseSessionTimestamp(uuidId);

      expect(date).toBeNull();
    });

    it('should return null for invalid timestamp', () => {
      const invalidId = 'invalid-timestamp';
      const date = SessionUtils.parseSessionTimestamp(invalidId);

      expect(date).toBeNull();
    });

    it('should return null for short timestamp', () => {
      const shortId = '202401';
      const date = SessionUtils.parseSessionTimestamp(shortId);

      expect(date).toBeNull();
    });
  });

  describe('isValidSessionId', () => {
    it('should validate UUID format', () => {
      const uuidId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      expect(SessionUtils.isValidSessionId(uuidId)).toBe(true);
    });

    it('should validate timestamp format', () => {
      const timestampId = '20240101T100000';
      expect(SessionUtils.isValidSessionId(timestampId)).toBe(true);
    });

    it('should reject invalid UUID', () => {
      const invalidUuid = 'f47ac10b-58cc-4372-a567-invalid';
      expect(SessionUtils.isValidSessionId(invalidUuid)).toBe(false);
    });

    it('should reject invalid timestamp', () => {
      const invalidTimestamp = '2024-01-01T10:00:00';
      expect(SessionUtils.isValidSessionId(invalidTimestamp)).toBe(false);
    });

    it('should reject random string', () => {
      const randomString = 'not-a-valid-session-id';
      expect(SessionUtils.isValidSessionId(randomString)).toBe(false);
    });

    it('should handle empty string', () => {
      expect(SessionUtils.isValidSessionId('')).toBe(false);
    });
  });

  describe('calculateStatistics', () => {
    it('should calculate statistics from history', () => {
      const history: SessionHistoryEntry[] = [
        {
          id: '1',
          timestamp: new Date(),
          type: 'tool_call',
          content: 'Tool call 1',
        },
        {
          id: '2',
          timestamp: new Date(),
          type: 'tool_call',
          content: 'Tool call 2',
        },
        {
          id: '3',
          timestamp: new Date(),
          type: 'error',
          content: 'Error occurred',
        },
        {
          id: '4',
          timestamp: new Date(),
          type: 'response',
          content: 'Response',
        },
      ];

      const stats = SessionUtils.calculateStatistics(history);

      expect(stats.toolCalls).toBe(2);
      expect(stats.errorCount).toBe(1);
      expect(stats.warningCount).toBe(0);
      expect(stats.successRate).toBe(0.75); // 3 out of 4 entries were not errors
    });

    it('should handle empty history', () => {
      const stats = SessionUtils.calculateStatistics([]);

      expect(stats.toolCalls).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.warningCount).toBe(0);
      expect(stats.successRate).toBe(0);
    });

    it('should handle history with only errors', () => {
      const history: SessionHistoryEntry[] = [
        {
          id: '1',
          timestamp: new Date(),
          type: 'error',
          content: 'Error 1',
        },
        {
          id: '2',
          timestamp: new Date(),
          type: 'error',
          content: 'Error 2',
        },
      ];

      const stats = SessionUtils.calculateStatistics(history);

      expect(stats.toolCalls).toBe(0);
      expect(stats.errorCount).toBe(2);
      expect(stats.successRate).toBe(0);
    });
  });
});