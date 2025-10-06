/**
 * Core session management module for juno-task-ts
 *
 * Provides comprehensive session lifecycle management, persistence, and statistics
 * for AI subagent execution sessions. Supports session creation, tracking, archival,
 * and recovery with file-based persistence and JSON serialization.
 *
 * @module core/session
 * @version 1.0.0
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type {
  JunoTaskConfig,
  SessionStatus,
  SubagentType,
} from '../types/index';

/**
 * Session metadata interface for tracking session properties
 */
export interface SessionInfo {
  /** Unique session identifier (UUID format) */
  id: string;
  /** Human-readable session name/title */
  name?: string;
  /** Current session status */
  status: SessionStatus;
  /** Subagent type used for this session */
  subagent: SubagentType;
  /** Session creation timestamp */
  createdAt: Date;
  /** Last activity timestamp */
  updatedAt: Date;
  /** Session completion timestamp */
  completedAt?: Date;
  /** Working directory when session was created */
  workingDirectory: string;
  /** Session configuration snapshot */
  config: Partial<JunoTaskConfig>;
  /** Session tags for categorization */
  tags: string[];
  /** Custom metadata */
  metadata: Record<string, any>;
}

/**
 * Execution context captured at session start
 */
export interface SessionContext {
  /** Working directory path */
  workingDirectory: string;
  /** Environment variables snapshot */
  environment: Record<string, string>;
  /** Configuration at session start */
  config: JunoTaskConfig;
  /** Git repository information (if available) */
  gitInfo?: {
    branch: string;
    commit: string;
    isDirty: boolean;
  };
  /** Process information */
  processInfo: {
    pid: number;
    nodeVersion: string;
    platform: string;
    arch: string;
  };
}

/**
 * Tool call statistics for session tracking
 */
export interface ToolCallStats {
  /** Tool name */
  name: string;
  /** Number of calls */
  count: number;
  /** Total execution time in milliseconds */
  totalTime: number;
  /** Average execution time in milliseconds */
  averageTime: number;
  /** Success count */
  successCount: number;
  /** Error count */
  errorCount: number;
  /** Last call timestamp */
  lastCall: Date;
}

/**
 * Session statistics interface for tracking execution metrics
 */
export interface SessionStatistics {
  /** Total session duration in milliseconds */
  duration: number;
  /** Number of iterations completed */
  iterations: number;
  /** Number of tool calls made */
  toolCalls: number;
  /** Tool call statistics by tool name */
  toolStats: Record<string, ToolCallStats>;
  /** Success rate (0-1) */
  successRate: number;
  /** Error count */
  errorCount: number;
  /** Warning count */
  warningCount: number;
  /** Memory usage statistics */
  memoryUsage?: {
    peak: number;
    average: number;
    current: number;
  };
  /** Performance metrics */
  performance: {
    avgIterationTime: number;
    avgToolCallTime: number;
    totalThinkingTime: number;
  };
}

/**
 * Session data interface for complete session state
 */
export interface Session {
  /** Session metadata */
  info: SessionInfo;
  /** Execution context */
  context: SessionContext;
  /** Session statistics */
  statistics: SessionStatistics;
  /** Conversation history */
  history: SessionHistoryEntry[];
  /** Session result data */
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    finalState?: any;
  };
}

/**
 * Session history entry for conversation tracking
 */
export interface SessionHistoryEntry {
  /** Entry ID */
  id: string;
  /** Entry timestamp */
  timestamp: Date;
  /** Entry type */
  type: 'prompt' | 'response' | 'tool_call' | 'error' | 'system';
  /** Entry content */
  content: string;
  /** Additional data */
  data?: any;
  /** Duration for this entry */
  duration?: number;
  /** Associated iteration number */
  iteration?: number;
}

/**
 * Session storage interface for persistence layer abstraction
 */
export interface SessionStorage {
  /**
   * Save session data to storage
   * @param session - Session data to save
   */
  saveSession(session: Session): Promise<void>;

  /**
   * Load session data from storage
   * @param sessionId - Session ID to load
   * @returns Session data or null if not found
   */
  loadSession(sessionId: string): Promise<Session | null>;

  /**
   * List all sessions with optional filtering
   * @param filter - Optional filter criteria
   * @returns Array of session info objects
   */
  listSessions(filter?: SessionListFilter): Promise<SessionInfo[]>;

  /**
   * Remove session from storage
   * @param sessionId - Session ID to remove
   */
  removeSession(sessionId: string): Promise<void>;

  /**
   * Check if session exists in storage
   * @param sessionId - Session ID to check
   */
  sessionExists(sessionId: string): Promise<boolean>;

  /**
   * Archive old sessions
   * @param options - Archive options
   */
  archiveSessions(options: ArchiveOptions): Promise<string[]>;

  /**
   * Clean up storage (remove empty files, etc.)
   * @param options - Cleanup options
   */
  cleanup(options: CleanupOptions): Promise<void>;
}

/**
 * Session list filter criteria
 */
export interface SessionListFilter {
  /** Filter by status */
  status?: SessionStatus[];
  /** Filter by subagent */
  subagent?: SubagentType[];
  /** Filter by date range */
  dateRange?: {
    start?: Date;
    end?: Date;
  };
  /** Filter by tags */
  tags?: string[];
  /** Limit number of results */
  limit?: number;
  /** Skip number of results */
  offset?: number;
  /** Sort order */
  sortBy?: 'createdAt' | 'updatedAt' | 'name';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Archive options for session archival
 */
export interface ArchiveOptions {
  /** Archive sessions older than this many days */
  olderThanDays?: number;
  /** Archive sessions with specific status */
  status?: SessionStatus[];
  /** Include session data in archive */
  includeData?: boolean;
  /** Archive directory path */
  archiveDir?: string;
}

/**
 * Cleanup options for storage maintenance
 */
export interface CleanupOptions {
  /** Remove empty session files */
  removeEmpty?: boolean;
  /** Remove sessions older than days */
  removeOlderThanDays?: number;
  /** Remove sessions with specific status */
  removeStatus?: SessionStatus[];
  /** Dry run mode (don't actually delete) */
  dryRun?: boolean;
}

/**
 * Session event types for event emission
 */
export type SessionEventType =
  | 'session_created'
  | 'session_updated'
  | 'session_completed'
  | 'session_cancelled'
  | 'session_error'
  | 'iteration_started'
  | 'iteration_completed'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'cleanup_completed'
  | 'archive_completed';

/**
 * Session event data interface
 */
export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  timestamp: Date;
  data?: any;
}

/**
 * File-based session storage implementation
 * Stores sessions as JSON files in a directory structure
 */
export class FileSessionStorage implements SessionStorage {
  private readonly baseDir: string;
  private readonly sessionsDir: string;
  private readonly archiveDir: string;

  /**
   * Create a new file-based session storage
   * @param baseDir - Base directory for session storage
   */
  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.sessionsDir = path.join(this.baseDir, 'sessions');
    this.archiveDir = path.join(this.baseDir, 'archive');
  }

  /**
   * Initialize storage directories
   */
  async initialize(): Promise<void> {
    await fsPromises.mkdir(this.sessionsDir, { recursive: true });
    await fsPromises.mkdir(this.archiveDir, { recursive: true });
  }

  /**
   * Get session file path
   * @param sessionId - Session ID
   * @returns Full path to session file
   */
  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  /**
   * Save session data to storage
   */
  async saveSession(session: Session): Promise<void> {
    await this.initialize();
    const sessionPath = this.getSessionPath(session.info.id);

    // Create a serializable copy
    const serializable = {
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
    };

    await fsPromises.writeFile(
      sessionPath,
      JSON.stringify(serializable, null, 2),
      'utf-8'
    );
  }

  /**
   * Load session data from storage
   */
  async loadSession(sessionId: string): Promise<Session | null> {
    const sessionPath = this.getSessionPath(sessionId);

    try {
      const data = await fsPromises.readFile(sessionPath, 'utf-8');
      const parsed = JSON.parse(data);

      // Deserialize dates
      return {
        ...parsed,
        info: {
          ...parsed.info,
          createdAt: new Date(parsed.info.createdAt),
          updatedAt: new Date(parsed.info.updatedAt),
          completedAt: parsed.info.completedAt ? new Date(parsed.info.completedAt) : undefined,
        },
        history: parsed.history.map((entry: any) => ({
          ...entry,
          timestamp: new Date(entry.timestamp),
        })),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new Error(`Failed to load session ${sessionId}: ${error}`);
    }
  }

  /**
   * List all sessions with optional filtering
   */
  async listSessions(filter?: SessionListFilter): Promise<SessionInfo[]> {
    await this.initialize();

    try {
      const files = await fsPromises.readdir(this.sessionsDir);
      const sessionFiles = files.filter(file => file.endsWith('.json'));

      const sessions: SessionInfo[] = [];

      for (const file of sessionFiles) {
        try {
          const sessionId = path.basename(file, '.json');
          const session = await this.loadSession(sessionId);
          if (session) {
            sessions.push(session.info);
          }
        } catch (error) {
          // Skip corrupted session files
          console.warn(`Failed to load session from ${file}: ${error}`);
        }
      }

      // Apply filters
      let filtered = sessions;

      if (filter) {
        if (filter.status) {
          filtered = filtered.filter(s => filter.status!.includes(s.status));
        }

        if (filter.subagent) {
          filtered = filtered.filter(s => filter.subagent!.includes(s.subagent));
        }

        if (filter.dateRange) {
          if (filter.dateRange.start) {
            filtered = filtered.filter(s => s.createdAt >= filter.dateRange!.start!);
          }
          if (filter.dateRange.end) {
            filtered = filtered.filter(s => s.createdAt <= filter.dateRange!.end!);
          }
        }

        if (filter.tags && filter.tags.length > 0) {
          filtered = filtered.filter(s =>
            filter.tags!.some(tag => s.tags.includes(tag))
          );
        }

        // Sort
        const sortBy = filter.sortBy || 'updatedAt';
        const sortOrder = filter.sortOrder || 'desc';

        filtered.sort((a, b) => {
          const aVal = a[sortBy];
          const bVal = b[sortBy];

          if (aVal === undefined && bVal === undefined) return 0;
          if (aVal === undefined) return 1;
          if (bVal === undefined) return -1;

          if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
          if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
          return 0;
        });

        // Apply limit and offset
        if (filter.offset) {
          filtered = filtered.slice(filter.offset);
        }
        if (filter.limit) {
          filtered = filtered.slice(0, filter.limit);
        }
      }

      return filtered;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Remove session from storage
   */
  async removeSession(sessionId: string): Promise<void> {
    const sessionPath = this.getSessionPath(sessionId);

    try {
      await fsPromises.unlink(sessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to remove session ${sessionId}: ${error}`);
      }
    }
  }

  /**
   * Check if session exists in storage
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    const sessionPath = this.getSessionPath(sessionId);

    try {
      await fsPromises.access(sessionPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Archive old sessions
   */
  async archiveSessions(options: ArchiveOptions): Promise<string[]> {
    await this.initialize();

    const filter: SessionListFilter = {};

    if (options.olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - options.olderThanDays);
      filter.dateRange = { end: cutoffDate };
    }

    if (options.status) {
      filter.status = options.status;
    }

    const sessionsToArchive = await this.listSessions(filter);
    const archivedIds: string[] = [];

    for (const sessionInfo of sessionsToArchive) {
      try {
        const session = await this.loadSession(sessionInfo.id);
        if (!session) continue;

        // Create archive file
        const archiveFileName = `${sessionInfo.id}_${sessionInfo.createdAt.toISOString().split('T')[0]}.json`;
        const archivePath = path.join(this.archiveDir, archiveFileName);

        if (options.includeData) {
          await fsPromises.writeFile(
            archivePath,
            JSON.stringify(session, null, 2),
            'utf-8'
          );
        } else {
          // Archive only metadata
          await fsPromises.writeFile(
            archivePath,
            JSON.stringify({ info: session.info, context: session.context }, null, 2),
            'utf-8'
          );
        }

        // Remove from active sessions
        await this.removeSession(sessionInfo.id);
        archivedIds.push(sessionInfo.id);
      } catch (error) {
        console.warn(`Failed to archive session ${sessionInfo.id}: ${error}`);
      }
    }

    return archivedIds;
  }

  /**
   * Clean up storage
   */
  async cleanup(options: CleanupOptions): Promise<void> {
    await this.initialize();

    const sessions = await this.listSessions();

    for (const sessionInfo of sessions) {
      let shouldRemove = false;

      if (options.removeOlderThanDays) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - options.removeOlderThanDays);
        if (sessionInfo.createdAt < cutoffDate) {
          shouldRemove = true;
        }
      }

      if (options.removeStatus && options.removeStatus.includes(sessionInfo.status)) {
        shouldRemove = true;
      }

      if (options.removeEmpty) {
        try {
          const session = await this.loadSession(sessionInfo.id);
          if (session && session.history.length === 0 && !session.result) {
            shouldRemove = true;
          }
        } catch {
          // If we can't load it, consider it for removal
          shouldRemove = true;
        }
      }

      if (shouldRemove && !options.dryRun) {
        await this.removeSession(sessionInfo.id);
      }
    }
  }
}

/**
 * Session manager class for comprehensive session lifecycle management
 * Provides high-level API for session operations with event emission
 */
export class SessionManager extends EventEmitter {
  private storage: SessionStorage;
  private activeSessions: Map<string, Session> = new Map();

  /**
   * Create a new session manager
   * @param storage - Session storage implementation
   */
  constructor(storage: SessionStorage) {
    super();
    this.storage = storage;
  }

  /**
   * Create a new session
   * @param options - Session creation options
   * @returns Created session data
   */
  async createSession(options: {
    name?: string;
    subagent: SubagentType;
    config: JunoTaskConfig;
    tags?: string[];
    metadata?: Record<string, any>;
  }): Promise<Session> {
    const sessionId = uuidv4();
    const now = new Date();

    // Capture execution context
    const context: SessionContext = {
      workingDirectory: options.config.workingDirectory,
      environment: { ...process.env } as Record<string, string>,
      config: { ...options.config },
      processInfo: {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    };

    // Initialize session
    const session: Session = {
      info: {
        id: sessionId,
        ...(options.name !== undefined && { name: options.name }),
        status: 'running',
        subagent: options.subagent,
        createdAt: now,
        updatedAt: now,
        workingDirectory: options.config.workingDirectory,
        config: { ...options.config },
        tags: options.tags || [],
        metadata: options.metadata || {},
      },
      context,
      statistics: {
        duration: 0,
        iterations: 0,
        toolCalls: 0,
        toolStats: {},
        successRate: 0,
        errorCount: 0,
        warningCount: 0,
        performance: {
          avgIterationTime: 0,
          avgToolCallTime: 0,
          totalThinkingTime: 0,
        },
      },
      history: [],
    };

    // Store in active sessions and save to storage
    this.activeSessions.set(sessionId, session);
    await this.storage.saveSession(session);

    // Emit event
    this.emit('session_created', {
      type: 'session_created',
      sessionId,
      timestamp: now,
      data: { session: session.info },
    } as SessionEvent);

    return session;
  }

  /**
   * Update session data
   * @param sessionId - Session ID to update
   * @param updates - Updates to apply
   */
  async updateSession(sessionId: string, updates: {
    status?: SessionStatus;
    name?: string;
    tags?: string[];
    metadata?: Record<string, any>;
    statistics?: Partial<SessionStatistics>;
    result?: Session['result'];
  }): Promise<void> {
    let session = this.activeSessions.get(sessionId);

    if (!session) {
      const loadedSession = await this.storage.loadSession(sessionId);
      session = loadedSession || undefined;
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
    }

    // Apply updates
    if (updates.status) session.info.status = updates.status;
    if (updates.name) session.info.name = updates.name;
    if (updates.tags) session.info.tags = updates.tags;
    if (updates.metadata) {
      session.info.metadata = { ...session.info.metadata, ...updates.metadata };
    }
    if (updates.statistics) {
      session.statistics = { ...session.statistics, ...updates.statistics };
    }
    if (updates.result) {
      session.result = updates.result;
    }

    session.info.updatedAt = new Date();

    // Update active session and save
    this.activeSessions.set(sessionId, session);
    await this.storage.saveSession(session);

    // Emit event
    this.emit('session_updated', {
      type: 'session_updated',
      sessionId,
      timestamp: new Date(),
      data: { updates },
    } as SessionEvent);
  }

  /**
   * Complete a session
   * @param sessionId - Session ID to complete
   * @param result - Final session result
   */
  async completeSession(sessionId: string, result: {
    success: boolean;
    output?: string;
    error?: string;
    finalState?: any;
  }): Promise<void> {
    const now = new Date();

    await this.updateSession(sessionId, {
      status: result.success ? 'completed' : 'failed',
      result,
    });

    const session = await this.getSession(sessionId);
    if (session) {
      session.info.completedAt = now;
      session.statistics.duration = now.getTime() - session.info.createdAt.getTime();

      await this.storage.saveSession(session);

      // Remove from active sessions
      this.activeSessions.delete(sessionId);
    }

    // Emit event
    this.emit('session_completed', {
      type: 'session_completed',
      sessionId,
      timestamp: now,
      data: { result },
    } as SessionEvent);
  }

  /**
   * Cancel a session
   * @param sessionId - Session ID to cancel
   */
  async cancelSession(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, {
      status: 'cancelled',
    });

    // Remove from active sessions
    this.activeSessions.delete(sessionId);

    // Emit event
    this.emit('session_cancelled', {
      type: 'session_cancelled',
      sessionId,
      timestamp: new Date(),
    } as SessionEvent);
  }

  /**
   * Get session by ID
   * @param sessionId - Session ID to retrieve
   * @returns Session data or null if not found
   */
  async getSession(sessionId: string): Promise<Session | null> {
    // Check active sessions first
    const activeSession = this.activeSessions.get(sessionId);
    if (activeSession) {
      return activeSession;
    }

    // Load from storage
    return await this.storage.loadSession(sessionId);
  }

  /**
   * List sessions with optional filtering
   * @param filter - Optional filter criteria
   * @returns Array of session info objects
   */
  async listSessions(filter?: SessionListFilter): Promise<SessionInfo[]> {
    return await this.storage.listSessions(filter);
  }

  /**
   * Search sessions by criteria
   * @param criteria - Search criteria
   * @returns Array of matching session info objects
   */
  async searchSessions(criteria: {
    query?: string;
    tags?: string[];
    status?: SessionStatus[];
    dateRange?: { start?: Date; end?: Date };
  }): Promise<SessionInfo[]> {
    const filter: SessionListFilter = {};
    if (criteria.status) filter.status = criteria.status;
    if (criteria.tags) filter.tags = criteria.tags;
    if (criteria.dateRange) filter.dateRange = criteria.dateRange;

    const sessions = await this.listSessions(filter);

    if (criteria.query) {
      const query = criteria.query.toLowerCase();
      return sessions.filter(session =>
        session.name?.toLowerCase().includes(query) ||
        session.id.toLowerCase().includes(query) ||
        session.tags.some(tag => tag.toLowerCase().includes(query))
      );
    }

    return sessions;
  }

  /**
   * Remove session
   * @param sessionId - Session ID to remove
   */
  async removeSession(sessionId: string): Promise<void> {
    await this.storage.removeSession(sessionId);
    this.activeSessions.delete(sessionId);
  }

  /**
   * Clean up old sessions
   * @param options - Cleanup options
   */
  async cleanupSessions(options: CleanupOptions): Promise<void> {
    await this.storage.cleanup(options);

    this.emit('cleanup_completed', {
      type: 'cleanup_completed',
      sessionId: 'all',
      timestamp: new Date(),
      data: { options },
    } as SessionEvent);
  }

  /**
   * Archive sessions
   * @param options - Archive options
   * @returns Array of archived session IDs
   */
  async archiveSessions(options: ArchiveOptions): Promise<string[]> {
    const archivedIds = await this.storage.archiveSessions(options);

    // Remove archived sessions from active sessions
    for (const sessionId of archivedIds) {
      this.activeSessions.delete(sessionId);
    }

    this.emit('archive_completed', {
      type: 'archive_completed',
      sessionId: 'multiple',
      timestamp: new Date(),
      data: { archivedIds, options },
    } as SessionEvent);

    return archivedIds;
  }

  /**
   * Add history entry to session
   * @param sessionId - Session ID
   * @param entry - History entry to add
   */
  async addHistoryEntry(sessionId: string, entry: Omit<SessionHistoryEntry, 'id' | 'timestamp'>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const historyEntry: SessionHistoryEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      ...entry,
    };

    session.history.push(historyEntry);
    await this.storage.saveSession(session);
  }

  /**
   * Update session statistics
   * @param sessionId - Session ID
   * @param stats - Statistics to update
   */
  async updateStatistics(sessionId: string, stats: Partial<SessionStatistics>): Promise<void> {
    await this.updateSession(sessionId, { statistics: stats });
  }

  /**
   * Record tool call in session
   * @param sessionId - Session ID
   * @param toolCall - Tool call information
   */
  async recordToolCall(sessionId: string, toolCall: {
    name: string;
    duration: number;
    success: boolean;
  }): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    // Update tool statistics
    const existing = session.statistics.toolStats[toolCall.name] || {
      name: toolCall.name,
      count: 0,
      totalTime: 0,
      averageTime: 0,
      successCount: 0,
      errorCount: 0,
      lastCall: new Date(),
    };

    existing.count++;
    existing.totalTime += toolCall.duration;
    existing.averageTime = existing.totalTime / existing.count;
    existing.lastCall = new Date();

    if (toolCall.success) {
      existing.successCount++;
    } else {
      existing.errorCount++;
    }

    session.statistics.toolStats[toolCall.name] = existing;
    session.statistics.toolCalls++;

    await this.storage.saveSession(session);
  }

  /**
   * Get session context for prompt generation
   * @param sessionId - Session ID
   * @param options - Context generation options
   * @returns Formatted context string
   */
  async getSessionContext(sessionId: string, options: {
    includeHistory?: boolean;
    includeStats?: boolean;
    maxHistoryEntries?: number;
  } = {}): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return `Session ${sessionId}: Not found`;
    }

    const contextLines = [
      `Session ${sessionId} Context:`,
      `Status: ${session.info.status}`,
      `Subagent: ${session.info.subagent}`,
      `Created: ${session.info.createdAt.toISOString()}`,
      `Working Directory: ${session.context.workingDirectory}`,
    ];

    if (session.info.tags.length > 0) {
      contextLines.push(`Tags: ${session.info.tags.join(', ')}`);
    }

    if (options.includeStats) {
      contextLines.push('', 'Statistics:');
      contextLines.push(`  Iterations: ${session.statistics.iterations}`);
      contextLines.push(`  Tool Calls: ${session.statistics.toolCalls}`);
      contextLines.push(`  Duration: ${session.statistics.duration}ms`);
      contextLines.push(`  Success Rate: ${(session.statistics.successRate * 100).toFixed(1)}%`);
    }

    if (options.includeHistory && session.history && session.history.length > 0) {
      contextLines.push('', 'Recent History:');
      const maxEntries = options.maxHistoryEntries || 5;
      const recentEntries = session.history.slice(-maxEntries);

      for (const entry of recentEntries) {
        const time = entry.timestamp?.toISOString().split('T')[1].split('.')[0] || 'unknown';
        contextLines.push(`  [${time}] ${entry.type}: ${entry.content.substring(0, 100)}...`);
      }
    }

    return contextLines.join('\n');
  }

  /**
   * Get comprehensive session summary
   * @param sessionId - Session ID
   * @returns Session summary object
   */
  async getSessionSummary(sessionId: string): Promise<{
    info: SessionInfo;
    statistics: SessionStatistics;
    summary: {
      totalDuration: string;
      iterationsPerMinute: number;
      toolCallsPerIteration: number;
      mostUsedTool: string | null;
      errorRate: number;
    };
  } | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    const durationMinutes = session.statistics.duration / (1000 * 60);
    const iterationsPerMinute = durationMinutes > 0 ? session.statistics.iterations / durationMinutes : 0;
    const toolCallsPerIteration = session.statistics.iterations > 0 ? session.statistics.toolCalls / session.statistics.iterations : 0;

    let mostUsedTool: string | null = null;
    let maxCalls = 0;
    for (const [toolName, stats] of Object.entries(session.statistics.toolStats)) {
      if (stats.count > maxCalls) {
        maxCalls = stats.count;
        mostUsedTool = toolName;
      }
    }

    const totalCalls = session.statistics.toolCalls;
    const errorRate = totalCalls > 0 ? session.statistics.errorCount / totalCalls : 0;

    return {
      info: session.info,
      statistics: session.statistics,
      summary: {
        totalDuration: this.formatDuration(session.statistics.duration),
        iterationsPerMinute: Number(iterationsPerMinute.toFixed(2)),
        toolCallsPerIteration: Number(toolCallsPerIteration.toFixed(2)),
        mostUsedTool,
        errorRate: Number(errorRate.toFixed(3)),
      },
    };
  }

  /**
   * Format duration in human-readable format
   * @param milliseconds - Duration in milliseconds
   * @returns Formatted duration string
   */
  private formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

/**
 * Create a session manager with file storage
 * Convenience function for creating a session manager with file-based storage
 *
 * @param config - Juno task configuration
 * @returns Configured session manager instance
 *
 * @example
 * ```typescript
 * const sessionManager = await createSessionManager(config);
 * const session = await sessionManager.createSession({
 *   name: 'My Task',
 *   subagent: 'claude',
 *   config: config,
 *   tags: ['development', 'feature'],
 * });
 * ```
 */
export async function createSessionManager(config: JunoTaskConfig): Promise<SessionManager> {
  const storage = new FileSessionStorage(config.sessionDirectory);
  await storage.initialize();
  return new SessionManager(storage);
}

/**
 * Session utilities for common operations
 */
// Simple counter for ID uniqueness
let sessionIdCounter = 0;

export const SessionUtils = {
  /**
   * Generate session ID compatible with Python implementation
   * Uses timestamp-based format for compatibility
   *
   * @returns Timestamp-based session ID
   */
  generateTimestampId(): string {
    const now = new Date();
    // Use timestamp without milliseconds to ensure we have room for counter
    const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 12); // YYYYMMDDHHMM
    // Add a simple incrementing counter for uniqueness
    sessionIdCounter = (sessionIdCounter + 1) % 1000;
    const suffix = sessionIdCounter.toString().padStart(3, '0');
    return timestamp + suffix; // 12 + 3 = 15 digits
  },

  /**
   * Parse session timestamp from ID
   * @param sessionId - Session ID to parse
   * @returns Date object or null if invalid
   */
  parseSessionTimestamp(sessionId: string): Date | null {
    try {
      // Try UUID format first
      if (sessionId.includes('-')) {
        return null; // UUIDs don't contain timestamps
      }

      // Try timestamp format (YYYYMMDDTHHMMSS)
      if (sessionId.length >= 15) {
        const year = parseInt(sessionId.slice(0, 4));
        const month = parseInt(sessionId.slice(4, 6)) - 1; // JS months are 0-based
        const day = parseInt(sessionId.slice(6, 8));
        const hour = parseInt(sessionId.slice(9, 11));
        const minute = parseInt(sessionId.slice(11, 13));
        const second = parseInt(sessionId.slice(13, 15));

        return new Date(year, month, day, hour, minute, second);
      }

      return null;
    } catch {
      return null;
    }
  },

  /**
   * Validate session ID format
   * @param sessionId - Session ID to validate
   * @returns True if valid format
   */
  isValidSessionId(sessionId: string): boolean {
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    // Timestamp format: YYYYMMDDTHHMMSS or similar
    const timestampRegex = /^[0-9]{8}T[0-9]{6}$/;

    return uuidRegex.test(sessionId) || timestampRegex.test(sessionId);
  },

  /**
   * Calculate session statistics from history
   * @param history - Session history entries
   * @returns Calculated statistics
   */
  calculateStatistics(history: SessionHistoryEntry[]): Partial<SessionStatistics> {
    const stats: Partial<SessionStatistics> = {
      toolCalls: 0,
      errorCount: 0,
      warningCount: 0,
      toolStats: {},
    };

    for (const entry of history) {
      if (entry.type === 'tool_call') {
        stats.toolCalls = (stats.toolCalls || 0) + 1;
      } else if (entry.type === 'error') {
        stats.errorCount = (stats.errorCount || 0) + 1;
      }
    }

    const totalEntries = history.length;
    stats.successRate = totalEntries > 0 ? 1 - ((stats.errorCount || 0) / totalEntries) : 0;

    return stats;
  },
};

// Types are already exported above via export interface/export type declarations