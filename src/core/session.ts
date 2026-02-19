/**
 * Core session management module for juno-code
 * @module core/session
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type { JunoTaskConfig, SessionStatus, SubagentType } from '../types/index';

/** Session metadata */
export interface SessionInfo {
  id: string;
  name?: string;
  status: SessionStatus;
  subagent: SubagentType;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  workingDirectory: string;
  config: Partial<JunoTaskConfig>;
  tags: string[];
  metadata: Record<string, any>;
}

/** Session statistics - essential counters only */
export interface SessionStatistics {
  duration: number;
  iterations: number;
  toolCalls: number;
  errorCount: number;
}

/** Complete session state */
export interface Session {
  info: SessionInfo;
  context: { workingDirectory: string; config: JunoTaskConfig };
  statistics: SessionStatistics;
  history: SessionHistoryEntry[];
  result?: { success: boolean; output?: string; error?: string; finalState?: any };
}

/** History entry for conversation tracking */
export interface SessionHistoryEntry {
  id: string;
  timestamp: Date;
  type: 'prompt' | 'response' | 'tool_call' | 'error' | 'system';
  content: string;
  data?: any;
  duration?: number;
  iteration?: number;
}

/** Persistence layer abstraction */
export interface SessionStorage {
  saveSession(session: Session): Promise<void>;
  loadSession(sessionId: string): Promise<Session | null>;
  listSessions(filter?: SessionListFilter): Promise<SessionInfo[]>;
  removeSession(sessionId: string): Promise<void>;
  sessionExists(sessionId: string): Promise<boolean>;
  cleanup(options: CleanupOptions): Promise<void>;
}

/** Filter criteria for listing sessions */
export interface SessionListFilter {
  status?: SessionStatus[];
  subagent?: SubagentType[];
  dateRange?: { start?: Date; end?: Date };
  tags?: string[];
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'name';
  sortOrder?: 'asc' | 'desc';
}

/** Options for storage cleanup */
export interface CleanupOptions {
  removeEmpty?: boolean;
  removeOlderThanDays?: number;
  removeStatus?: SessionStatus[];
  dryRun?: boolean;
}

/** File-based session storage implementation */
export class FileSessionStorage implements SessionStorage {
  private readonly baseDir: string;
  private readonly sessionsDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.sessionsDir = path.join(this.baseDir, 'sessions');
  }

  async initialize(): Promise<void> {
    await fsPromises.mkdir(this.sessionsDir, { recursive: true });
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  async saveSession(session: Session): Promise<void> {
    await this.initialize();
    const sessionPath = this.getSessionPath(session.info.id);
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
    await fsPromises.writeFile(sessionPath, JSON.stringify(serializable, null, 2), 'utf-8');
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    const sessionPath = this.getSessionPath(sessionId);
    try {
      const data = await fsPromises.readFile(sessionPath, 'utf-8');
      const parsed = JSON.parse(data);
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Failed to load session ${sessionId}: ${error}`);
    }
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionInfo[]> {
    await this.initialize();
    try {
      const files = await fsPromises.readdir(this.sessionsDir);
      const sessionFiles = files.filter(file => file.endsWith('.json'));
      const sessions: SessionInfo[] = [];
      for (const file of sessionFiles) {
        try {
          const session = await this.loadSession(path.basename(file, '.json'));
          if (session) sessions.push(session.info);
        } catch (error) {
          console.warn(`Failed to load session from ${file}: ${error}`);
        }
      }

      let filtered = sessions;
      if (filter) {
        if (filter.status)
          filtered = filtered.filter(s => filter.status!.includes(s.status));
        if (filter.subagent)
          filtered = filtered.filter(s => filter.subagent!.includes(s.subagent));
        if (filter.dateRange) {
          if (filter.dateRange.start)
            filtered = filtered.filter(s => s.createdAt >= filter.dateRange!.start!);
          if (filter.dateRange.end)
            filtered = filtered.filter(s => s.createdAt <= filter.dateRange!.end!);
        }
        if (filter.tags && filter.tags.length > 0)
          filtered = filtered.filter(s => filter.tags!.some(tag => s.tags.includes(tag)));

        const sortBy = filter.sortBy || 'updatedAt';
        const sortOrder = filter.sortOrder || 'desc';
        filtered.sort((a, b) => {
          const aVal = a[sortBy], bVal = b[sortBy];
          if (aVal === undefined && bVal === undefined) return 0;
          if (aVal === undefined) return 1;
          if (bVal === undefined) return -1;
          if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
          if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
          return 0;
        });
        if (filter.offset) filtered = filtered.slice(filter.offset);
        if (filter.limit) filtered = filtered.slice(0, filter.limit);
      }
      return filtered;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    try {
      await fsPromises.unlink(this.getSessionPath(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`Failed to remove session ${sessionId}: ${error}`);
    }
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      await fsPromises.access(this.getSessionPath(sessionId), fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async cleanup(options: CleanupOptions): Promise<void> {
    await this.initialize();
    const sessions = await this.listSessions();
    for (const info of sessions) {
      let shouldRemove = false;
      if (options.removeOlderThanDays) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - options.removeOlderThanDays);
        if (info.createdAt < cutoff) shouldRemove = true;
      }
      if (options.removeStatus && options.removeStatus.includes(info.status))
        shouldRemove = true;
      if (options.removeEmpty) {
        try {
          const session = await this.loadSession(info.id);
          if (session && session.history.length === 0 && !session.result) shouldRemove = true;
        } catch { shouldRemove = true; }
      }
      if (shouldRemove && !options.dryRun) await this.removeSession(info.id);
    }
  }
}

/** Session manager - plain class for session lifecycle management */
export class SessionManager {
  private storage: SessionStorage;
  private activeSessions: Map<string, Session> = new Map();

  constructor(storage: SessionStorage) {
    this.storage = storage;
  }

  async createSession(options: {
    name?: string;
    subagent: SubagentType;
    config: JunoTaskConfig;
    tags?: string[];
    metadata?: Record<string, any>;
  }): Promise<Session> {
    const sessionId = uuidv4();
    const now = new Date();
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
      context: {
        workingDirectory: options.config.workingDirectory,
        config: { ...options.config },
      },
      statistics: { duration: 0, iterations: 0, toolCalls: 0, errorCount: 0 },
      history: [],
    };
    this.activeSessions.set(sessionId, session);
    await this.storage.saveSession(session);
    return session;
  }

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
      const loaded = await this.storage.loadSession(sessionId);
      session = loaded || undefined;
      if (!session) throw new Error(`Session ${sessionId} not found`);
    }
    if (updates.status) session.info.status = updates.status;
    if (updates.name) session.info.name = updates.name;
    if (updates.tags) session.info.tags = updates.tags;
    if (updates.metadata)
      session.info.metadata = { ...session.info.metadata, ...updates.metadata };
    if (updates.statistics)
      session.statistics = { ...session.statistics, ...updates.statistics };
    if (updates.result) session.result = updates.result;
    session.info.updatedAt = new Date();
    this.activeSessions.set(sessionId, session);
    await this.storage.saveSession(session);
  }

  async completeSession(sessionId: string, result: {
    success: boolean; output?: string; error?: string; finalState?: any;
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
      this.activeSessions.delete(sessionId);
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, { status: 'cancelled' });
    this.activeSessions.delete(sessionId);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.activeSessions.get(sessionId) || await this.storage.loadSession(sessionId);
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionInfo[]> {
    return await this.storage.listSessions(filter);
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.storage.removeSession(sessionId);
    this.activeSessions.delete(sessionId);
  }

  async cleanupSessions(options: CleanupOptions): Promise<void> {
    await this.storage.cleanup(options);
  }

  async addHistoryEntry(sessionId: string, entry: Omit<SessionHistoryEntry, 'id' | 'timestamp'>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.history.push({ id: uuidv4(), timestamp: new Date(), ...entry });
    await this.storage.saveSession(session);
  }

  async updateStatistics(sessionId: string, stats: Partial<SessionStatistics>): Promise<void> {
    await this.updateSession(sessionId, { statistics: stats });
  }

  async recordToolCall(sessionId: string, toolCall: {
    name: string; duration: number; success: boolean;
  }): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;
    session.statistics.toolCalls++;
    if (!toolCall.success) session.statistics.errorCount++;
    await this.storage.saveSession(session);
  }

  async getSessionContext(sessionId: string, options: {
    includeHistory?: boolean; includeStats?: boolean; maxHistoryEntries?: number;
  } = {}): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) return `Session ${sessionId}: Not found`;

    const lines = [
      `Session ${sessionId} Context:`,
      `Status: ${session.info.status}`,
      `Subagent: ${session.info.subagent}`,
      `Created: ${session.info.createdAt.toISOString()}`,
      `Working Directory: ${session.context.workingDirectory}`,
    ];
    if (session.info.tags.length > 0)
      lines.push(`Tags: ${session.info.tags.join(', ')}`);
    if (options.includeStats) {
      lines.push('', 'Statistics:');
      lines.push(`  Iterations: ${session.statistics.iterations}`);
      lines.push(`  Tool Calls: ${session.statistics.toolCalls}`);
      lines.push(`  Duration: ${session.statistics.duration}ms`);
    }
    if (options.includeHistory && session.history?.length > 0) {
      lines.push('', 'Recent History:');
      const recent = session.history.slice(-(options.maxHistoryEntries || 5));
      for (const e of recent) {
        const time = e.timestamp?.toISOString()?.split('T')[1]?.split('.')[0] || 'unknown';
        lines.push(`  [${time}] ${e.type}: ${e.content.substring(0, 100)}...`);
      }
    }
    return lines.join('\n');
  }

  async getSessionSummary(sessionId: string): Promise<{
    info: SessionInfo;
    statistics: SessionStatistics;
    summary: { totalDuration: string; iterationsPerMinute: number; toolCallsPerIteration: number; errorRate: number };
  } | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    const mins = session.statistics.duration / 60_000;
    const ipm = mins > 0 ? session.statistics.iterations / mins : 0;
    const tcpi = session.statistics.iterations > 0 ? session.statistics.toolCalls / session.statistics.iterations : 0;
    const er = session.statistics.toolCalls > 0 ? session.statistics.errorCount / session.statistics.toolCalls : 0;
    return {
      info: session.info,
      statistics: session.statistics,
      summary: {
        totalDuration: this.formatDuration(session.statistics.duration),
        iterationsPerMinute: Number(ipm.toFixed(2)),
        toolCallsPerIteration: Number(tcpi.toFixed(2)),
        errorRate: Number(er.toFixed(3)),
      },
    };
  }

  private formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }
}

/** Create a session manager with file storage */
export async function createSessionManager(config: JunoTaskConfig): Promise<SessionManager> {
  const storage = new FileSessionStorage(config.sessionDirectory);
  await storage.initialize();
  return new SessionManager(storage);
}
