/**
 * @fileoverview Comprehensive tests for Session management implementation
 * Tests for FileSessionStorage, SessionManager, and SessionUtils
 * Target: 98% coverage for src/core/session.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock the fs module completely
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      readdir: vi.fn(),
      unlink: vi.fn(),
      access: vi.fn(),
    },
  };
});

import {
  FileSessionStorage,
  SessionManager,
  SessionUtils,
  createSessionManager,
  type Session,
  type SessionInfo,
  type SessionContext,
  type SessionStatistics,
  type SessionHistoryEntry,
  type SessionListFilter,
  type ArchiveOptions,
  type CleanupOptions,
  type SessionEvent,
  type ToolCallStats,
} from '../session.js';
import type { JunoTaskConfig, SubagentType, SessionStatus } from '../../types/index.js';

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

const createMockSessionInfo = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'test-session-123',
  name: 'Test Session',
  status: 'running',
  subagent: 'claude',
  createdAt: new Date('2024-01-01T10:00:00.000Z'),
  updatedAt: new Date('2024-01-01T10:05:00.000Z'),
  completedAt: undefined,
  workingDirectory: '/test/working/dir',
  config: createMockConfig(),
  tags: ['test', 'development'],
  metadata: { testKey: 'testValue' },
  ...overrides,
});

const createMockSessionContext = (overrides: Partial<SessionContext> = {}): SessionContext => ({
  workingDirectory: '/test/working/dir',
  environment: { NODE_ENV: 'test', PATH: '/bin:/usr/bin' },
  config: createMockConfig(),
  gitInfo: {
    branch: 'main',
    commit: 'abc123',
    isDirty: false,
  },
  processInfo: {
    pid: 12345,
    nodeVersion: 'v18.17.0',
    platform: 'linux',
    arch: 'x64',
  },
  ...overrides,
});

const createMockSessionStatistics = (overrides: Partial<SessionStatistics> = {}): SessionStatistics => ({
  duration: 300000, // 5 minutes
  iterations: 5,
  toolCalls: 15,
  toolStats: {
    'test-tool': {
      name: 'test-tool',
      count: 10,
      totalTime: 2000,
      averageTime: 200,
      successCount: 9,
      errorCount: 1,
      lastCall: new Date('2024-01-01T10:05:00.000Z'),
    },
  },
  successRate: 0.9,
  errorCount: 2,
  warningCount: 1,
  memoryUsage: {
    peak: 128 * 1024 * 1024,
    average: 100 * 1024 * 1024,
    current: 110 * 1024 * 1024,
  },
  performance: {
    avgIterationTime: 60000,
    avgToolCallTime: 200,
    totalThinkingTime: 120000,
  },
  ...overrides,
});

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
  info: createMockSessionInfo(overrides.info),
  context: createMockSessionContext(overrides.context),
  statistics: createMockSessionStatistics(overrides.statistics),
  history: [
    {
      id: 'history-1',
      timestamp: new Date('2024-01-01T10:01:00.000Z'),
      type: 'prompt',
      content: 'Initial prompt',
      data: null,
      duration: 1000,
      iteration: 1,
    },
    {
      id: 'history-2',
      timestamp: new Date('2024-01-01T10:02:00.000Z'),
      type: 'response',
      content: 'AI response',
      data: null,
      duration: 2000,
      iteration: 1,
    },
  ],
  result: {
    success: true,
    output: 'Task completed successfully',
    finalState: { completed: true },
  },
  ...overrides,
});

describe('FileSessionStorage', () => {
  let storage: FileSessionStorage;
  let tempDir: string;
  let mockFs: any;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), 'test-sessions', Date.now().toString());
    storage = new FileSessionStorage(tempDir);

    // Get mocked fs module
    mockFs = await import('node:fs');

    vi.clearAllMocks();

    // Reset mock implementations
    mockFs.promises.mkdir.mockResolvedValue(undefined);
    mockFs.promises.writeFile.mockResolvedValue(undefined);
    mockFs.promises.readFile.mockResolvedValue('{}');
    mockFs.promises.readdir.mockResolvedValue([]);
    mockFs.promises.unlink.mockResolvedValue(undefined);
    mockFs.promises.access.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create FileSessionStorage instance', () => {
      expect(storage).toBeInstanceOf(FileSessionStorage);
    });

    it('should initialize directories on first use', async () => {
      await storage.initialize();

      expect(mockFs.promises.mkdir).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions'),
        { recursive: true }
      );
      expect(mockFs.promises.mkdir).toHaveBeenCalledWith(
        path.join(tempDir, 'archive'),
        { recursive: true }
      );
    });

    it('should get correct session file path', () => {
      const sessionId = 'test-session-123';
      const expectedPath = path.join(tempDir, 'sessions', `${sessionId}.json`);

      // Access private method through bracket notation
      const sessionPath = (storage as any).getSessionPath(sessionId);
      expect(sessionPath).toBe(expectedPath);
    });
  });

  describe('saveSession', () => {
    it('should save session to file with proper serialization', async () => {
      const session = createMockSession();
      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.writeFile.mockResolvedValue(undefined);

      await storage.saveSession(session);

      expect(mockFsPromises.mkdir).toHaveBeenCalled();
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions', `${session.info.id}.json`),
        expect.stringContaining('"createdAt":"2024-01-01T10:00:00.000Z"'),
        'utf-8'
      );
    });

    it('should serialize dates correctly', async () => {
      const session = createMockSession({
        info: createMockSessionInfo({
          completedAt: new Date('2024-01-01T11:00:00.000Z'),
        }),
      });
      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.writeFile.mockResolvedValue(undefined);

      await storage.saveSession(session);

      const writeCall = mockFsPromises.writeFile.mock.calls[0];
      const serializedData = writeCall[1] as string;
      const parsed = JSON.parse(serializedData);

      expect(parsed.info.createdAt).toBe('2024-01-01T10:00:00.000Z');
      expect(parsed.info.updatedAt).toBe('2024-01-01T10:05:00.000Z');
      expect(parsed.info.completedAt).toBe('2024-01-01T11:00:00.000Z');
      expect(parsed.history[0].timestamp).toBe('2024-01-01T10:01:00.000Z');
    });
  });

  describe('loadSession', () => {
    it('should load and deserialize session correctly', async () => {
      const session = createMockSession();
      const serializedSession = JSON.stringify({
        ...session,
        info: {
          ...session.info,
          createdAt: session.info.createdAt.toISOString(),
          updatedAt: session.info.updatedAt.toISOString(),
          completedAt: session.info.completedAt?.toISOString(),
        },
        history: session.history.map(entry => ({
          ...entry,
          timestamp: entry.timestamp.toISOString(),
        })),
      });

      mockFsPromises.readFile.mockResolvedValue(serializedSession);

      const result = await storage.loadSession('test-session-123');

      expect(result).toBeDefined();
      expect(result!.info.id).toBe('test-session-123');
      expect(result!.info.createdAt).toBeInstanceOf(Date);
      expect(result!.info.updatedAt).toBeInstanceOf(Date);
      expect(result!.history[0].timestamp).toBeInstanceOf(Date);
    });

    it('should return null when session file not found', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsPromises.readFile.mockRejectedValue(error);

      const result = await storage.loadSession('nonexistent-session');

      expect(result).toBeNull();
    });

    it('should throw error for other file system errors', async () => {
      const error = new Error('Permission denied');
      mockFsPromises.readFile.mockRejectedValue(error);

      await expect(storage.loadSession('test-session-123')).rejects.toThrow(
        'Failed to load session test-session-123: Error: Permission denied'
      );
    });

    it('should handle sessions without completedAt date', async () => {
      const session = createMockSession();
      const serializedSession = JSON.stringify({
        ...session,
        info: {
          ...session.info,
          createdAt: session.info.createdAt.toISOString(),
          updatedAt: session.info.updatedAt.toISOString(),
          completedAt: undefined,
        },
        history: session.history.map(entry => ({
          ...entry,
          timestamp: entry.timestamp.toISOString(),
        })),
      });

      mockFsPromises.readFile.mockResolvedValue(serializedSession);

      const result = await storage.loadSession('test-session-123');

      expect(result!.info.completedAt).toBeUndefined();
    });
  });

  describe('listSessions', () => {
    it('should list all sessions with no filter', async () => {
      const sessions = [
        createMockSession({ info: { id: 'session-1' } }),
        createMockSession({ info: { id: 'session-2', status: 'completed' } }),
      ];

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'session-2.json']);

      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[0],
          info: { ...sessions[0].info, createdAt: sessions[0].info.createdAt.toISOString(), updatedAt: sessions[0].info.updatedAt.toISOString() },
          history: sessions[0].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[1],
          info: { ...sessions[1].info, createdAt: sessions[1].info.createdAt.toISOString(), updatedAt: sessions[1].info.updatedAt.toISOString() },
          history: sessions[1].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }));

      const result = await storage.listSessions();

      expect(result).toHaveLength(2);
      expect(result.map(s => s.id)).toContain('session-1');
      expect(result.map(s => s.id)).toContain('session-2');
    });

    it('should filter sessions by status', async () => {
      const sessions = [
        createMockSession({ info: { id: 'session-1', status: 'running' } }),
        createMockSession({ info: { id: 'session-2', status: 'completed' } }),
      ];

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'session-2.json']);

      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[0],
          info: { ...sessions[0].info, createdAt: sessions[0].info.createdAt.toISOString(), updatedAt: sessions[0].info.updatedAt.toISOString() },
          history: sessions[0].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[1],
          info: { ...sessions[1].info, createdAt: sessions[1].info.createdAt.toISOString(), updatedAt: sessions[1].info.updatedAt.toISOString() },
          history: sessions[1].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }));

      const filter: SessionListFilter = { status: ['completed'] };
      const result = await storage.listSessions(filter);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('session-2');
      expect(result[0].status).toBe('completed');
    });

    it('should filter sessions by subagent', async () => {
      const sessions = [
        createMockSession({ info: { id: 'session-1', subagent: 'claude' } }),
        createMockSession({ info: { id: 'session-2', subagent: 'cursor' } }),
      ];

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'session-2.json']);

      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[0],
          info: { ...sessions[0].info, createdAt: sessions[0].info.createdAt.toISOString(), updatedAt: sessions[0].info.updatedAt.toISOString() },
          history: sessions[0].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[1],
          info: { ...sessions[1].info, createdAt: sessions[1].info.createdAt.toISOString(), updatedAt: sessions[1].info.updatedAt.toISOString() },
          history: sessions[1].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }));

      const filter: SessionListFilter = { subagent: ['cursor'] };
      const result = await storage.listSessions(filter);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('session-2');
      expect(result[0].subagent).toBe('cursor');
    });

    it('should filter sessions by date range', async () => {
      const sessions = [
        createMockSession({
          info: {
            id: 'session-1',
            createdAt: new Date('2024-01-01T10:00:00.000Z')
          }
        }),
        createMockSession({
          info: {
            id: 'session-2',
            createdAt: new Date('2024-01-02T10:00:00.000Z')
          }
        }),
      ];

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'session-2.json']);

      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[0],
          info: { ...sessions[0].info, createdAt: sessions[0].info.createdAt.toISOString(), updatedAt: sessions[0].info.updatedAt.toISOString() },
          history: sessions[0].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[1],
          info: { ...sessions[1].info, createdAt: sessions[1].info.createdAt.toISOString(), updatedAt: sessions[1].info.updatedAt.toISOString() },
          history: sessions[1].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }));

      const filter: SessionListFilter = {
        dateRange: {
          start: new Date('2024-01-01T00:00:00.000Z'),
          end: new Date('2024-01-01T23:59:59.999Z'),
        },
      };
      const result = await storage.listSessions(filter);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('session-1');
    });

    it('should filter sessions by tags', async () => {
      const sessions = [
        createMockSession({ info: { id: 'session-1', tags: ['development', 'test'] } }),
        createMockSession({ info: { id: 'session-2', tags: ['production', 'deploy'] } }),
      ];

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'session-2.json']);

      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[0],
          info: { ...sessions[0].info, createdAt: sessions[0].info.createdAt.toISOString(), updatedAt: sessions[0].info.updatedAt.toISOString() },
          history: sessions[0].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[1],
          info: { ...sessions[1].info, createdAt: sessions[1].info.createdAt.toISOString(), updatedAt: sessions[1].info.updatedAt.toISOString() },
          history: sessions[1].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }));

      const filter: SessionListFilter = { tags: ['development'] };
      const result = await storage.listSessions(filter);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('session-1');
    });

    it('should sort sessions correctly', async () => {
      const sessions = [
        createMockSession({
          info: {
            id: 'session-1',
            name: 'A Session',
            updatedAt: new Date('2024-01-01T10:00:00.000Z')
          }
        }),
        createMockSession({
          info: {
            id: 'session-2',
            name: 'B Session',
            updatedAt: new Date('2024-01-02T10:00:00.000Z')
          }
        }),
      ];

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'session-2.json']);

      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[0],
          info: { ...sessions[0].info, createdAt: sessions[0].info.createdAt.toISOString(), updatedAt: sessions[0].info.updatedAt.toISOString() },
          history: sessions[0].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[1],
          info: { ...sessions[1].info, createdAt: sessions[1].info.createdAt.toISOString(), updatedAt: sessions[1].info.updatedAt.toISOString() },
          history: sessions[1].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }));

      const filter: SessionListFilter = {
        sortBy: 'name',
        sortOrder: 'asc'
      };
      const result = await storage.listSessions(filter);

      expect(result[0].name).toBe('A Session');
      expect(result[1].name).toBe('B Session');
    });

    it('should apply limit and offset', async () => {
      const sessions = [
        createMockSession({ info: { id: 'session-1' } }),
        createMockSession({ info: { id: 'session-2' } }),
        createMockSession({ info: { id: 'session-3' } }),
      ];

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'session-2.json', 'session-3.json']);

      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[0],
          info: { ...sessions[0].info, createdAt: sessions[0].info.createdAt.toISOString(), updatedAt: sessions[0].info.updatedAt.toISOString() },
          history: sessions[0].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[1],
          info: { ...sessions[1].info, createdAt: sessions[1].info.createdAt.toISOString(), updatedAt: sessions[1].info.updatedAt.toISOString() },
          history: sessions[1].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[2],
          info: { ...sessions[2].info, createdAt: sessions[2].info.createdAt.toISOString(), updatedAt: sessions[2].info.updatedAt.toISOString() },
          history: sessions[2].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }));

      const filter: SessionListFilter = {
        offset: 1,
        limit: 1
      };
      const result = await storage.listSessions(filter);

      expect(result).toHaveLength(1);
    });

    it('should handle corrupted session files gracefully', async () => {
      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'corrupted.json']);

      const validSession = createMockSession({ info: { id: 'session-1' } });
      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...validSession,
          info: { ...validSession.info, createdAt: validSession.info.createdAt.toISOString(), updatedAt: validSession.info.updatedAt.toISOString() },
          history: validSession.history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockRejectedValueOnce(new Error('Invalid JSON'));

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await storage.listSessions();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('session-1');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load session from corrupted.json')
      );

      consoleSpy.mockRestore();
    });

    it('should return empty array when sessions directory does not exist', async () => {
      const error = new Error('Directory not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockRejectedValue(error);

      const result = await storage.listSessions();

      expect(result).toEqual([]);
    });

    it('should handle sorting with undefined values', async () => {
      const sessions = [
        createMockSession({ info: { id: 'session-1', name: undefined } }),
        createMockSession({ info: { id: 'session-2', name: 'Named Session' } }),
      ];

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['session-1.json', 'session-2.json']);

      mockFsPromises.readFile
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[0],
          info: { ...sessions[0].info, createdAt: sessions[0].info.createdAt.toISOString(), updatedAt: sessions[0].info.updatedAt.toISOString() },
          history: sessions[0].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }))
        .mockResolvedValueOnce(JSON.stringify({
          ...sessions[1],
          info: { ...sessions[1].info, createdAt: sessions[1].info.createdAt.toISOString(), updatedAt: sessions[1].info.updatedAt.toISOString() },
          history: sessions[1].history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
        }));

      const filter: SessionListFilter = { sortBy: 'name', sortOrder: 'asc' };
      const result = await storage.listSessions(filter);

      expect(result).toHaveLength(2);
      // Session with undefined name should come after named session
      expect(result[0].name).toBe('Named Session');
      expect(result[1].name).toBeUndefined();
    });
  });

  describe('removeSession', () => {
    it('should remove session file', async () => {
      mockFsPromises.unlink.mockResolvedValue(undefined);

      await storage.removeSession('test-session-123');

      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions', 'test-session-123.json')
      );
    });

    it('should handle file not found error gracefully', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsPromises.unlink.mockRejectedValue(error);

      await expect(storage.removeSession('nonexistent-session')).resolves.not.toThrow();
    });

    it('should throw error for other file system errors', async () => {
      const error = new Error('Permission denied');
      mockFsPromises.unlink.mockRejectedValue(error);

      await expect(storage.removeSession('test-session-123')).rejects.toThrow(
        'Failed to remove session test-session-123: Error: Permission denied'
      );
    });
  });

  describe('sessionExists', () => {
    it('should return true when session exists', async () => {
      mockFsPromises.access.mockResolvedValue(undefined);

      const exists = await storage.sessionExists('test-session-123');

      expect(exists).toBe(true);
      expect(mockFsPromises.access).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions', 'test-session-123.json'),
        fs.constants.F_OK
      );
    });

    it('should return false when session does not exist', async () => {
      mockFsPromises.access.mockRejectedValue(new Error('File not found'));

      const exists = await storage.sessionExists('nonexistent-session');

      expect(exists).toBe(false);
    });
  });

  describe('archiveSessions', () => {
    it('should archive sessions older than specified days', async () => {
      const session = createMockSession({
        info: createMockSessionInfo({
          createdAt: new Date('2024-01-01T10:00:00.000Z'),
        }),
      });

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['test-session-123.json']);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
        ...session,
        info: { ...session.info, createdAt: session.info.createdAt.toISOString(), updatedAt: session.info.updatedAt.toISOString() },
        history: session.history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
      }));
      mockFsPromises.writeFile.mockResolvedValue(undefined);
      mockFsPromises.unlink.mockResolvedValue(undefined);

      // Mock current date to be much later
      const mockDate = new Date('2024-12-01T10:00:00.000Z');
      vi.setSystemTime(mockDate);

      const options: ArchiveOptions = {
        olderThanDays: 30,
        includeData: true
      };

      const archivedIds = await storage.archiveSessions(options);

      expect(archivedIds).toEqual(['test-session-123']);
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        path.join(tempDir, 'archive', 'test-session-123_2024-01-01.json'),
        expect.any(String),
        'utf-8'
      );
      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions', 'test-session-123.json')
      );

      vi.useRealTimers();
    });

    it('should archive sessions with specific status', async () => {
      const session = createMockSession({
        info: createMockSessionInfo({ status: 'completed' }),
      });

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['test-session-123.json']);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
        ...session,
        info: { ...session.info, createdAt: session.info.createdAt.toISOString(), updatedAt: session.info.updatedAt.toISOString() },
        history: session.history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
      }));
      mockFsPromises.writeFile.mockResolvedValue(undefined);
      mockFsPromises.unlink.mockResolvedValue(undefined);

      const options: ArchiveOptions = {
        status: ['completed'],
        includeData: false
      };

      const archivedIds = await storage.archiveSessions(options);

      expect(archivedIds).toEqual(['test-session-123']);

      // Verify only metadata was archived (not full data)
      const writeCall = mockFsPromises.writeFile.mock.calls[0];
      const archivedData = JSON.parse(writeCall[1] as string);
      expect(archivedData.info).toBeDefined();
      expect(archivedData.context).toBeDefined();
      expect(archivedData.statistics).toBeUndefined();
      expect(archivedData.history).toBeUndefined();
    });

    it('should handle archiving errors gracefully', async () => {
      const session = createMockSession();

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['test-session-123.json']);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
        ...session,
        info: { ...session.info, createdAt: session.info.createdAt.toISOString(), updatedAt: session.info.updatedAt.toISOString() },
        history: session.history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
      }));
      mockFsPromises.writeFile.mockRejectedValue(new Error('Write failed'));

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const options: ArchiveOptions = { includeData: true };
      const archivedIds = await storage.archiveSessions(options);

      expect(archivedIds).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to archive session test-session-123')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('cleanup', () => {
    it('should remove sessions older than specified days', async () => {
      const session = createMockSession({
        info: createMockSessionInfo({
          createdAt: new Date('2024-01-01T10:00:00.000Z'),
        }),
      });

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['test-session-123.json']);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
        ...session,
        info: { ...session.info, createdAt: session.info.createdAt.toISOString(), updatedAt: session.info.updatedAt.toISOString() },
        history: session.history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
      }));
      mockFsPromises.unlink.mockResolvedValue(undefined);

      // Mock current date to be much later
      const mockDate = new Date('2024-12-01T10:00:00.000Z');
      vi.setSystemTime(mockDate);

      const options: CleanupOptions = {
        removeOlderThanDays: 30,
        dryRun: false
      };

      await storage.cleanup(options);

      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions', 'test-session-123.json')
      );

      vi.useRealTimers();
    });

    it('should remove sessions with specific status', async () => {
      const session = createMockSession({
        info: createMockSessionInfo({ status: 'failed' }),
      });

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['test-session-123.json']);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
        ...session,
        info: { ...session.info, createdAt: session.info.createdAt.toISOString(), updatedAt: session.info.updatedAt.toISOString() },
        history: session.history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
      }));
      mockFsPromises.unlink.mockResolvedValue(undefined);

      const options: CleanupOptions = {
        removeStatus: ['failed'],
        dryRun: false
      };

      await storage.cleanup(options);

      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions', 'test-session-123.json')
      );
    });

    it('should remove empty sessions', async () => {
      const session = createMockSession({
        history: [],
        result: undefined,
      });

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['test-session-123.json']);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
        ...session,
        info: { ...session.info, createdAt: session.info.createdAt.toISOString(), updatedAt: session.info.updatedAt.toISOString() },
        history: [],
      }));
      mockFsPromises.unlink.mockResolvedValue(undefined);

      const options: CleanupOptions = {
        removeEmpty: true,
        dryRun: false
      };

      await storage.cleanup(options);

      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions', 'test-session-123.json')
      );
    });

    it('should respect dry run mode', async () => {
      const session = createMockSession({
        info: createMockSessionInfo({ status: 'failed' }),
      });

      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['test-session-123.json']);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
        ...session,
        info: { ...session.info, createdAt: session.info.createdAt.toISOString(), updatedAt: session.info.updatedAt.toISOString() },
        history: session.history.map(h => ({ ...h, timestamp: h.timestamp.toISOString() })),
      }));

      const options: CleanupOptions = {
        removeStatus: ['failed'],
        dryRun: true
      };

      await storage.cleanup(options);

      expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    });

    it('should handle corrupted sessions during cleanup', async () => {
      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue(['test-session-123.json']);
      mockFsPromises.readFile.mockRejectedValue(new Error('Corrupted file'));
      mockFsPromises.unlink.mockResolvedValue(undefined);

      const options: CleanupOptions = {
        removeEmpty: true,
        dryRun: false
      };

      await storage.cleanup(options);

      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        path.join(tempDir, 'sessions', 'test-session-123.json')
      );
    });
  });
});

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let mockStorage: {
    saveSession: ReturnType<typeof vi.fn>;
    loadSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    removeSession: ReturnType<typeof vi.fn>;
    sessionExists: ReturnType<typeof vi.fn>;
    archiveSessions: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockStorage = {
      saveSession: vi.fn(),
      loadSession: vi.fn(),
      listSessions: vi.fn(),
      removeSession: vi.fn(),
      sessionExists: vi.fn(),
      archiveSessions: vi.fn(),
      cleanup: vi.fn(),
    };

    sessionManager = new SessionManager(mockStorage as any);
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
      mockStorage.saveSession.mockResolvedValue(undefined);

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
      expect(mockStorage.saveSession).toHaveBeenCalledWith(session);
    });

    it('should create session without optional parameters', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

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
      mockStorage.saveSession.mockResolvedValue(undefined);

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
      mockStorage.saveSession.mockResolvedValue(undefined);

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
  });

  describe('updateSession', () => {
    it('should update session from active sessions', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

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

      expect(mockStorage.saveSession).toHaveBeenCalledTimes(2); // Once for create, once for update
      const saveCall = mockStorage.saveSession.mock.calls[1][0];
      expect(saveCall.info.status).toBe('completed');
      expect(saveCall.info.name).toBe('Updated Session');
      expect(saveCall.info.tags).toEqual(['updated']);
      expect(saveCall.info.metadata.updated).toBe(true);
    });

    it('should load session from storage if not in active sessions', async () => {
      const session = createMockSession();
      mockStorage.loadSession.mockResolvedValue(session);
      mockStorage.saveSession.mockResolvedValue(undefined);

      const updates = {
        status: 'completed' as SessionStatus,
      };

      await sessionManager.updateSession('external-session-id', updates);

      expect(mockStorage.loadSession).toHaveBeenCalledWith('external-session-id');
      expect(mockStorage.saveSession).toHaveBeenCalledWith(
        expect.objectContaining({
          info: expect.objectContaining({
            status: 'completed',
          }),
        })
      );
    });

    it('should throw error if session not found', async () => {
      mockStorage.loadSession.mockResolvedValue(null);

      await expect(
        sessionManager.updateSession('nonexistent-session', { status: 'completed' })
      ).rejects.toThrow('Session nonexistent-session not found');
    });

    it('should emit session_updated event', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

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
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
        metadata: { existing: 'value', toUpdate: 'old' },
      });

      const updates = {
        metadata: { toUpdate: 'new', added: 'field' },
      };

      await sessionManager.updateSession(session.info.id, updates);

      const saveCall = mockStorage.saveSession.mock.calls[1][0];
      expect(saveCall.info.metadata).toEqual({
        existing: 'value',
        toUpdate: 'new',
        added: 'field',
      });
    });

    it('should update statistics correctly', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const updates = {
        statistics: {
          iterations: 5,
          toolCalls: 10,
        },
      };

      await sessionManager.updateSession(session.info.id, updates);

      const saveCall = mockStorage.saveSession.mock.calls[1][0];
      expect(saveCall.statistics.iterations).toBe(5);
      expect(saveCall.statistics.toolCalls).toBe(10);
      expect(saveCall.statistics.duration).toBe(0); // Original value preserved
    });
  });

  describe('completeSession', () => {
    it('should complete session successfully', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

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

      expect(mockStorage.saveSession).toHaveBeenCalledTimes(3); // Create, update, save with completedAt
      const finalSaveCall = mockStorage.saveSession.mock.calls[2][0];
      expect(finalSaveCall.info.status).toBe('completed');
      expect(finalSaveCall.info.completedAt).toBeInstanceOf(Date);
      expect(finalSaveCall.result).toEqual(result);
      expect(finalSaveCall.statistics.duration).toBeGreaterThan(0);
    });

    it('should complete session with failure', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const result = {
        success: false,
        error: 'Task failed',
      };

      await sessionManager.completeSession(session.info.id, result);

      const updateCall = mockStorage.saveSession.mock.calls[1][0];
      expect(updateCall.info.status).toBe('failed');
      expect(updateCall.result).toEqual(result);
    });

    it('should emit session_completed event', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

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

    it('should remove session from active sessions', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      // Verify session is in active sessions
      const activeSession = await sessionManager.getSession(session.info.id);
      expect(activeSession).toBeDefined();

      await sessionManager.completeSession(session.info.id, { success: true });

      // Verify session was removed from active sessions
      mockStorage.loadSession.mockResolvedValue(null);
      const afterCompletion = await sessionManager.getSession(session.info.id);
      expect(mockStorage.loadSession).toHaveBeenCalledWith(session.info.id);
    });
  });

  describe('cancelSession', () => {
    it('should cancel session', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      await sessionManager.cancelSession(session.info.id);

      const updateCall = mockStorage.saveSession.mock.calls[1][0];
      expect(updateCall.info.status).toBe('cancelled');
    });

    it('should emit session_cancelled event', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

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

  describe('getSession', () => {
    it('should return session from active sessions', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const retrieved = await sessionManager.getSession(session.info.id);

      expect(retrieved).toBe(session);
      expect(mockStorage.loadSession).not.toHaveBeenCalled();
    });

    it('should load session from storage if not active', async () => {
      const session = createMockSession();
      mockStorage.loadSession.mockResolvedValue(session);

      const retrieved = await sessionManager.getSession('external-session-id');

      expect(retrieved).toBe(session);
      expect(mockStorage.loadSession).toHaveBeenCalledWith('external-session-id');
    });

    it('should return null if session not found', async () => {
      mockStorage.loadSession.mockResolvedValue(null);

      const retrieved = await sessionManager.getSession('nonexistent-session');

      expect(retrieved).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should delegate to storage listSessions', async () => {
      const sessions = [createMockSessionInfo()];
      mockStorage.listSessions.mockResolvedValue(sessions);

      const filter: SessionListFilter = { status: ['running'] };
      const result = await sessionManager.listSessions(filter);

      expect(result).toBe(sessions);
      expect(mockStorage.listSessions).toHaveBeenCalledWith(filter);
    });
  });

  describe('searchSessions', () => {
    it('should search sessions by query', async () => {
      const sessions = [
        createMockSessionInfo({ id: 'session-1', name: 'Test Session' }),
        createMockSessionInfo({ id: 'session-2', name: 'Production Task' }),
        createMockSessionInfo({ id: 'session-3', tags: ['test'] }),
      ];
      mockStorage.listSessions.mockResolvedValue(sessions);

      const result = await sessionManager.searchSessions({ query: 'test' });

      expect(result).toHaveLength(2);
      expect(result.map(s => s.id)).toContain('session-1'); // Name contains "test"
      expect(result.map(s => s.id)).toContain('session-3'); // Tag contains "test"
    });

    it('should search sessions with filters', async () => {
      const sessions = [
        createMockSessionInfo({ status: 'running' }),
        createMockSessionInfo({ status: 'completed' }),
      ];
      mockStorage.listSessions.mockResolvedValue(sessions);

      const result = await sessionManager.searchSessions({
        status: ['running'],
        tags: ['development'],
      });

      expect(mockStorage.listSessions).toHaveBeenCalledWith({
        status: ['running'],
        tags: ['development'],
      });
    });

    it('should return all sessions when no query provided', async () => {
      const sessions = [createMockSessionInfo()];
      mockStorage.listSessions.mockResolvedValue(sessions);

      const result = await sessionManager.searchSessions({});

      expect(result).toBe(sessions);
    });
  });

  describe('removeSession', () => {
    it('should remove session from storage and active sessions', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);
      mockStorage.removeSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      await sessionManager.removeSession(session.info.id);

      expect(mockStorage.removeSession).toHaveBeenCalledWith(session.info.id);

      // Verify session was removed from active sessions
      mockStorage.loadSession.mockResolvedValue(null);
      const retrieved = await sessionManager.getSession(session.info.id);
      expect(mockStorage.loadSession).toHaveBeenCalledWith(session.info.id);
    });
  });

  describe('cleanupSessions', () => {
    it('should delegate to storage cleanup and emit event', async () => {
      mockStorage.cleanup.mockResolvedValue(undefined);

      const eventSpy = vi.fn();
      sessionManager.on('cleanup_completed', eventSpy);

      const options: CleanupOptions = { removeOlderThanDays: 30 };
      await sessionManager.cleanupSessions(options);

      expect(mockStorage.cleanup).toHaveBeenCalledWith(options);
      expect(eventSpy).toHaveBeenCalledWith({
        type: 'cleanup_completed',
        sessionId: 'all',
        timestamp: expect.any(Date),
        data: { options },
      });
    });
  });

  describe('archiveSessions', () => {
    it('should archive sessions and emit event', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);
      mockStorage.archiveSessions.mockResolvedValue(['session-1', 'session-2']);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const eventSpy = vi.fn();
      sessionManager.on('archive_completed', eventSpy);

      const options: ArchiveOptions = { olderThanDays: 30 };
      const archivedIds = await sessionManager.archiveSessions(options);

      expect(archivedIds).toEqual(['session-1', 'session-2']);
      expect(mockStorage.archiveSessions).toHaveBeenCalledWith(options);
      expect(eventSpy).toHaveBeenCalledWith({
        type: 'archive_completed',
        sessionId: 'multiple',
        timestamp: expect.any(Date),
        data: { archivedIds, options },
      });
    });

    it('should remove archived sessions from active sessions', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      mockStorage.archiveSessions.mockResolvedValue([session.info.id]);

      await sessionManager.archiveSessions({ olderThanDays: 30 });

      // Verify session was removed from active sessions
      mockStorage.loadSession.mockResolvedValue(null);
      const retrieved = await sessionManager.getSession(session.info.id);
      expect(mockStorage.loadSession).toHaveBeenCalledWith(session.info.id);
    });
  });

  describe('addHistoryEntry', () => {
    it('should add history entry to session', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

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

      const saveCall = mockStorage.saveSession.mock.calls[1][0];
      expect(saveCall.history).toHaveLength(1);
      expect(saveCall.history[0].id).toBeDefined();
      expect(saveCall.history[0].timestamp).toBeInstanceOf(Date);
      expect(saveCall.history[0].type).toBe('prompt');
      expect(saveCall.history[0].content).toBe('Test prompt');
    });

    it('should throw error if session not found', async () => {
      mockStorage.loadSession.mockResolvedValue(null);

      await expect(
        sessionManager.addHistoryEntry('nonexistent-session', {
          type: 'prompt',
          content: 'Test',
        })
      ).rejects.toThrow('Session nonexistent-session not found');
    });
  });

  describe('updateStatistics', () => {
    it('should update session statistics', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      const stats = { iterations: 5, toolCalls: 10 };
      await sessionManager.updateStatistics(session.info.id, stats);

      const saveCall = mockStorage.saveSession.mock.calls[1][0];
      expect(saveCall.statistics.iterations).toBe(5);
      expect(saveCall.statistics.toolCalls).toBe(10);
    });
  });

  describe('recordToolCall', () => {
    it('should record new tool call', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

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

      const saveCall = mockStorage.saveSession.mock.calls[1][0];
      expect(saveCall.statistics.toolCalls).toBe(1);
      expect(saveCall.statistics.toolStats['test-tool']).toEqual({
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
      mockStorage.saveSession.mockResolvedValue(undefined);

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

      const saveCall = mockStorage.saveSession.mock.calls[2][0];
      expect(saveCall.statistics.toolCalls).toBe(2);
      expect(saveCall.statistics.toolStats['test-tool']).toEqual({
        name: 'test-tool',
        count: 2,
        totalTime: 800,
        averageTime: 400,
        successCount: 1,
        errorCount: 1,
        lastCall: expect.any(Date),
      });
    });

    it('should do nothing if session not found', async () => {
      await sessionManager.recordToolCall('nonexistent-session', {
        name: 'test-tool',
        duration: 500,
        success: true,
      });

      expect(mockStorage.saveSession).not.toHaveBeenCalled();
    });
  });

  describe('getSessionContext', () => {
    it('should return formatted session context', async () => {
      const session = createMockSession();
      mockStorage.loadSession.mockResolvedValue(session);

      const context = await sessionManager.getSessionContext('test-session-123');

      expect(context).toContain('Session test-session-123 Context:');
      expect(context).toContain('Status: running');
      expect(context).toContain('Subagent: claude');
      expect(context).toContain('Working Directory: /test/working/dir');
      expect(context).toContain('Tags: test, development');
    });

    it('should include statistics when requested', async () => {
      const session = createMockSession();
      mockStorage.loadSession.mockResolvedValue(session);

      const context = await sessionManager.getSessionContext('test-session-123', {
        includeStats: true,
      });

      expect(context).toContain('Statistics:');
      expect(context).toContain('Iterations: 5');
      expect(context).toContain('Tool Calls: 15');
      expect(context).toContain('Duration: 300000ms');
      expect(context).toContain('Success Rate: 90.0%');
    });

    it('should include history when requested', async () => {
      const session = createMockSession();
      mockStorage.loadSession.mockResolvedValue(session);

      const context = await sessionManager.getSessionContext('test-session-123', {
        includeHistory: true,
        maxHistoryEntries: 1,
      });

      expect(context).toContain('Recent History:');
      expect(context).toContain('response: AI response');
    });

    it('should return not found message for missing session', async () => {
      mockStorage.loadSession.mockResolvedValue(null);

      const context = await sessionManager.getSessionContext('nonexistent-session');

      expect(context).toBe('Session nonexistent-session: Not found');
    });

    it('should handle session without tags', async () => {
      const session = createMockSession({
        info: createMockSessionInfo({ tags: [] }),
      });
      mockStorage.loadSession.mockResolvedValue(session);

      const context = await sessionManager.getSessionContext('test-session-123');

      expect(context).not.toContain('Tags:');
    });

    it('should handle empty history', async () => {
      const session = createMockSession({ history: [] });
      mockStorage.loadSession.mockResolvedValue(session);

      const context = await sessionManager.getSessionContext('test-session-123', {
        includeHistory: true,
      });

      expect(context).not.toContain('Recent History:');
    });

    it('should handle malformed history entries', async () => {
      const session = createMockSession({
        history: [
          {
            id: 'history-1',
            timestamp: undefined as any, // Malformed timestamp
            type: 'prompt',
            content: 'Test prompt',
          },
        ],
      });
      mockStorage.loadSession.mockResolvedValue(session);

      const context = await sessionManager.getSessionContext('test-session-123', {
        includeHistory: true,
      });

      expect(context).toContain('[unknown] prompt: Test prompt');
    });
  });

  describe('getSessionSummary', () => {
    it('should return comprehensive session summary', async () => {
      const session = createMockSession();
      mockStorage.loadSession.mockResolvedValue(session);

      const summary = await sessionManager.getSessionSummary('test-session-123');

      expect(summary).toBeDefined();
      expect(summary!.info).toBe(session.info);
      expect(summary!.statistics).toBe(session.statistics);
      expect(summary!.summary.totalDuration).toBe('5m 0s');
      expect(summary!.summary.iterationsPerMinute).toBe(1);
      expect(summary!.summary.toolCallsPerIteration).toBe(3);
      expect(summary!.summary.mostUsedTool).toBe('test-tool');
      expect(summary!.summary.errorRate).toBe(0.133);
    });

    it('should return null for missing session', async () => {
      mockStorage.loadSession.mockResolvedValue(null);

      const summary = await sessionManager.getSessionSummary('nonexistent-session');

      expect(summary).toBeNull();
    });

    it('should handle zero duration', async () => {
      const session = createMockSession({
        statistics: createMockSessionStatistics({ duration: 0, iterations: 0 }),
      });
      mockStorage.loadSession.mockResolvedValue(session);

      const summary = await sessionManager.getSessionSummary('test-session-123');

      expect(summary!.summary.iterationsPerMinute).toBe(0);
    });

    it('should handle no tool calls', async () => {
      const session = createMockSession({
        statistics: createMockSessionStatistics({
          toolCalls: 0,
          toolStats: {},
          errorCount: 0,
        }),
      });
      mockStorage.loadSession.mockResolvedValue(session);

      const summary = await sessionManager.getSessionSummary('test-session-123');

      expect(summary!.summary.mostUsedTool).toBeNull();
      expect(summary!.summary.errorRate).toBe(0);
    });
  });

  describe('formatDuration', () => {
    it('should format duration correctly', async () => {
      const config = createMockConfig();
      mockStorage.saveSession.mockResolvedValue(undefined);

      const session = await sessionManager.createSession({
        subagent: 'claude' as SubagentType,
        config,
      });

      // Access private method through bracket notation
      const formatDuration = (sessionManager as any).formatDuration;

      expect(formatDuration(1000)).toBe('1s');
      expect(formatDuration(65000)).toBe('1m 5s');
      expect(formatDuration(3665000)).toBe('1h 1m 5s');
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

    it('should handle parsing errors gracefully', () => {
      const malformedId = '20240132T250000'; // Invalid date/time
      const date = SessionUtils.parseSessionTimestamp(malformedId);

      expect(date).toBeInstanceOf(Date);
      // JavaScript Date constructor handles invalid dates by adjusting
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

describe('createSessionManager', () => {
  it('should create SessionManager with FileSessionStorage', async () => {
    const config = createMockConfig();
    mockFsPromises.mkdir.mockResolvedValue(undefined);

    const sessionManager = await createSessionManager(config);

    expect(sessionManager).toBeInstanceOf(SessionManager);
    expect(mockFsPromises.mkdir).toHaveBeenCalledWith(
      path.join(config.sessionDirectory, 'sessions'),
      { recursive: true }
    );
    expect(mockFsPromises.mkdir).toHaveBeenCalledWith(
      path.join(config.sessionDirectory, 'archive'),
      { recursive: true }
    );
  });
});