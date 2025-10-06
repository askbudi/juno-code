/**
 * Stub MCP Client Implementation
 *
 * This is a minimal stub to allow the CLI to function without MCP dependencies.
 * Replace this with the full implementation when MCP SDK is available.
 */

import { ProgressEventType } from './types';
import { MCPConnectionError } from './errors';
import { promises as fsPromises } from 'node:fs';

// Stub types to match expected interface
export interface MCPClientOptions {
  serverPath?: string;
  timeout?: number;
  retries?: number;
  workingDirectory?: string;
  debug?: boolean;
}

export interface ToolCallRequest {
  toolName: string;
  parameters?: Record<string, any>;
}

export interface ToolCallResponse {
  toolId: string;
  content: string;
  success: boolean;
  duration: number;
  timestamp: Date;
}

export interface MCPClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  callTool(request: ToolCallRequest): Promise<ToolCallResponse>;
  listTools(): Promise<string[]>;
  getConnectionStatus(): 'connected' | 'disconnected' | 'connecting' | 'error';
  ping(): Promise<boolean>;
  isConnected(): boolean;
  getHealth(): any;
  getSubagentInfo(subagentType: string): Promise<any>;
  onProgress(callback: Function): () => void;
  createSession(userId?: string, metadata?: any): any;
  getSession(sessionId: string): any;
  getSessionStatistics(): any;
  getRateLimitStatus(): any;
  getSubagentMapper(): any;
  updateSessionState(sessionId: string, state: string): void;
  endSession(sessionId: string): void;
  dispose(): void;
  on(event: string, callback: Function): void;
}

/**
 * Stub MCP Client that simulates basic functionality
 */
export class StubMCPClient implements MCPClient {
  private options: MCPClientOptions;
  private connected: boolean = false;
  private sessionManager = new SessionContextManager();
  private progressCallbackManager = new ProgressCallbackManager();
  private subagentMapper = new SubagentMapperImpl();
  private rateLimitMonitor = new RateLimitMonitor({});
  private eventHandlers: Map<string, Function[]> = new Map();
  private startTime = Date.now();
  private operationCount = 0;
  private errorCount = 0;

  constructor(options: MCPClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.options.debug) {
      console.log('[MCP] Stub client connecting...');
    }
    this.connected = true;
    this.emit('connection:state', 'CONNECTED');
  }

  async disconnect(): Promise<void> {
    if (this.options.debug) {
      console.log('[MCP] Stub client disconnecting...');
    }
    this.emit('connection:state', 'CLOSING');
    this.connected = false;
    this.emit('connection:state', 'DISCONNECTED');
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }

    this.emit('tool:start', request);
    this.operationCount++;

    if (this.options.debug) {
      console.log(`[MCP] Stub tool call: ${request.toolName}`, request.parameters);
    }

    try {
      // Simulate tool execution
      const response = {
        toolId: request.toolName,
        content: `Stub response for tool: ${request.toolName}\nParameters: ${JSON.stringify(request.parameters, null, 2)}`,
        success: true,
        duration: Math.random() * 1000,
        timestamp: new Date(),
        status: 'COMPLETED',
        progressEvents: []
      };

      this.emit('tool:complete', response);
      return response;
    } catch (error) {
      this.errorCount++;
      this.emit('tool:error', error);
      throw error;
    }
  }

  async listTools(): Promise<string[]> {
    return ['claude_subagent', 'cursor_subagent', 'search_files'];
  }

  getConnectionStatus(): 'connected' | 'disconnected' | 'connecting' | 'error' {
    return this.connected ? 'connected' : 'disconnected';
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getHealth(): any {
    return {
      state: this.connected ? 'CONNECTED' : 'DISCONNECTED',
      uptime: Date.now() - this.startTime,
      successfulOperations: this.operationCount - this.errorCount,
      failedOperations: this.errorCount,
      avgResponseTime: 500, // Stub value
      errorStreak: 0,
    };
  }

  async getSubagentInfo(subagentType: string): Promise<any> {
    const models = {
      'claude': ['sonnet-4', 'sonnet-3.5', 'haiku-3', 'opus-3'],
      'cursor': ['gpt-4', 'gpt-3.5-turbo'],
      'codex': ['code-davinci-002'],
      'gemini': ['gemini-pro', 'gemini-ultra'],
    };

    return {
      id: subagentType,
      name: subagentType.charAt(0).toUpperCase() + subagentType.slice(1),
      models: models[subagentType as keyof typeof models] || ['default-model'],
      defaultModel: this.subagentMapper.getDefaultModel(subagentType),
      status: this.connected ? 'available' : 'unavailable',
      performance: {
        avgResponseTime: 500,
        successRate: 0.95,
      }
    };
  }

  onProgress(callback: Function): () => void {
    return this.progressCallbackManager.addCallback(callback);
  }

  createSession(userId?: string, metadata?: any): any {
    return this.sessionManager.createSession(undefined, userId, metadata);
  }

  getSession(sessionId: string): any {
    return this.sessionManager.getSession(sessionId);
  }

  getSessionStatistics(): any {
    return this.sessionManager.getStatistics();
  }

  getRateLimitStatus(): any {
    return this.rateLimitMonitor.getStatus();
  }

  getSubagentMapper(): any {
    return this.subagentMapper;
  }

  updateSessionState(sessionId: string, state: string): void {
    this.sessionManager.updateSessionState(sessionId, state);
  }

  endSession(sessionId: string): void {
    this.sessionManager.endSession(sessionId);
  }

  dispose(): void {
    this.connected = false;
    this.progressCallbackManager.clear();
    this.sessionManager.cleanupExpiredSessions(0);
    this.eventHandlers.clear();
  }

  on(event: string, callback: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(callback);
  }

  private emit(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => handler(data));
    }
  }
}

/**
 * Enhanced MCP Client class that the tests expect
 */
export class MCPClient extends StubMCPClient {
  constructor(options: MCPClientOptions) {
    super(options);
  }
}

/**
 * Create a stub MCP client instance
 */
export function createMCPClient(options: MCPClientOptions): MCPClient {
  return new MCPClient(options);
}

export default StubMCPClient;

/**
 * Stub Progress Event Parser
 */
export class ProgressEventParser {
  private sessionId: string;
  private eventCounter: number = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  parseProgressText(text: string): any[] {
    if (!text || text.trim() === '') {
      return [];
    }

    const lines = text.split('\n').filter(line => line.trim());
    const events: any[] = [];

    for (const line of lines) {
      // Match pattern: "Backend #1: tool_start => Starting analysis"
      const progressMatch = line.match(/^(\w+)\s+#(\d+):\s+(\w+)\s+=>\s+(.+)$/);

      if (progressMatch) {
        const [, backend, count, eventType, content] = progressMatch;
        this.eventCounter++;

        events.push({
          sessionId: this.sessionId,
          timestamp: new Date(),
          backend: backend.toLowerCase(),
          count: parseInt(count),
          type: this.mapEventType(eventType),
          content: content,
          toolId: `${backend.toLowerCase()}_${count}`,
        });
      } else {
        // Handle other patterns like "calling tool: search_files" or rate limit messages
        this.eventCounter++;
        const detectedTool = line.match(/calling tool:\s*(\w+)/)?.[1];
        const isRateLimit = line.toLowerCase().includes('rate limit');

        const event: any = {
          sessionId: this.sessionId,
          timestamp: new Date(),
          backend: 'backend',
          count: this.eventCounter,
          type: detectedTool ? ProgressEventType.TOOL_START : (isRateLimit ? ProgressEventType.ERROR : ProgressEventType.INFO),
          content: line.trim(),
          toolId: `backend_${this.eventCounter}`,
        };

        if (detectedTool) {
          event.metadata = { detectedTool };
        }

        if (isRateLimit) {
          event.metadata = { ...event.metadata, rateLimitDetected: true };
        }

        events.push(event);
      }
    }

    return events;
  }

  private mapEventType(eventType: string): string {
    const mapping: Record<string, string> = {
      'tool_start': ProgressEventType.TOOL_START,
      'start': ProgressEventType.TOOL_START,
      'tool_result': ProgressEventType.TOOL_RESULT,
      'complete': ProgressEventType.TOOL_RESULT,
      'thinking': ProgressEventType.THINKING,
      'error': ProgressEventType.ERROR,
      'debug': ProgressEventType.DEBUG,
    };

    return mapping[eventType] || ProgressEventType.INFO;
  }

  extractRateLimitInfo(content: string): Date | null {
    // Parse patterns like "resets at 3:30 PM", "try again in 60 minutes", "resets at 15:45"

    // Pattern: "try again in X minutes"
    const minutesMatch = content.match(/try again in (\d+) minutes/i);
    if (minutesMatch) {
      const minutes = parseInt(minutesMatch[1]);
      return new Date(Date.now() + minutes * 60 * 1000);
    }

    // Pattern: "resets at HH:MM" or "resets at H:MM PM/AM"
    const timeMatch = content.match(/resets at (\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
    if (timeMatch) {
      const [, hours, minutes, ampm] = timeMatch;
      let hour = parseInt(hours);
      const minute = parseInt(minutes);

      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && hour !== 12) {
          hour += 12;
        } else if (ampm.toUpperCase() === 'AM' && hour === 12) {
          hour = 0;
        }
      }

      const resetTime = new Date();
      resetTime.setHours(hour, minute, 0, 0);

      // If the time has already passed today, assume it's tomorrow
      if (resetTime.getTime() <= Date.now()) {
        resetTime.setDate(resetTime.getDate() + 1);
      }

      return resetTime;
    }

    return null;
  }

  reset(): void {
    this.eventCounter = 0;
  }
}

/**
 * Stub Server Path Discovery
 */
export class ServerPathDiscovery {
  static async discoverServerPath(preferredPath?: string): Promise<string> {
    if (preferredPath) {
      const isValid = await this.validateServerPath(preferredPath);
      if (isValid) {
        return preferredPath;
      }
      throw new MCPConnectionError(`Invalid server path: ${preferredPath}`);
    }

    // Try common server locations
    const commonPaths = [
      '/usr/local/bin/roundtable_mcp_server',
      '/usr/local/bin/roundtable_mcp_server.py',
      './roundtable_mcp_server',
      './roundtable_mcp_server.py',
    ];

    for (const path of commonPaths) {
      const isValid = await this.validateServerPath(path);
      if (isValid) {
        return path;
      }
    }

    throw new MCPConnectionError('Could not discover MCP server path');
  }

  static async validateServerPath(path: string): Promise<boolean> {
    try {
      const stats = await fsPromises.stat(path);
      if (!stats.isFile()) {
        return false;
      }
      // Check if executable
      await fsPromises.access(path, fsPromises.constants.X_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  static async getServerInfo(path: string): Promise<any> {
    try {
      const stats = await fsPromises.stat(path);
      let executable = true;
      try {
        await fsPromises.access(path, fsPromises.constants.X_OK);
      } catch {
        executable = false;
      }

      return {
        path,
        exists: true,
        executable,
        size: stats.size,
        modified: stats.mtime,
      };
    } catch {
      return {
        path,
        exists: false,
        executable: false,
        size: 0,
        modified: new Date(0),
      };
    }
  }
}

/**
 * Stub Connection Retry Manager
 */
export class ConnectionRetryManager {
  private config: any;

  constructor(config: any) {
    this.config = config;
  }

  async executeWithRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    return operation();
  }

  getRetryInfo(): any {
    return {
      currentAttempt: 0,
      maxRetries: this.config.maxRetries || 3,
      lastError: null,
    };
  }

  reset(): void {
    // Stub reset
  }
}

/**
 * Stub Rate Limit Monitor
 */
export class RateLimitMonitor {
  private config: any;

  constructor(config: any) {
    this.config = config;
  }

  isRequestAllowed(toolName: string): boolean {
    return true;
  }

  recordRequest(toolName: string): void {
    // Stub record
  }

  updateRateLimit(remaining: number, resetTime: Date): void {
    // Stub update
  }

  parseRateLimitFromText(text: string): any {
    return { remaining: 0 };
  }

  getTimeUntilAllowed(toolName: string): number {
    return 0;
  }

  cleanup(): void {
    // Stub cleanup
  }

  getStatus(): any {
    return {
      globalRemaining: -1,
      globalResetTime: undefined,
      activeWindows: 0,
    };
  }

  reset(): void {
    // Stub reset
  }
}

/**
 * Stub Subagent Mapper
 */
export class SubagentMapperImpl {
  mapToToolName(subagentType: string): string {
    const mapping: Record<string, string> = {
      'claude': 'claude_subagent',
      'claude-code': 'claude_subagent',
      'claude_code': 'claude_subagent',
      'cursor': 'cursor_subagent',
      'cursor-agent': 'cursor_subagent',
      'codex': 'codex_subagent',
      'gemini': 'gemini_subagent',
      'gemini-cli': 'gemini_subagent',
    };

    const toolName = mapping[subagentType];
    if (!toolName) {
      throw new Error(`Unknown subagent type: ${subagentType}`);
    }
    return toolName;
  }

  validateModel(subagentType: string, model: string): boolean {
    return true; // Stub validation
  }

  getDefaultModel(subagentType: string): string {
    const defaults: Record<string, string> = {
      'claude': 'sonnet-4',
      'cursor': 'gpt-4',
      'codex': 'code-davinci-002',
      'gemini': 'gemini-pro',
    };
    return defaults[subagentType] || 'default-model';
  }

  getDefaults(subagentType: string): any {
    return {
      timeout: 60000,
      model: this.getDefaultModel(subagentType),
      arguments: {},
      priority: 'normal',
    };
  }

  getAvailableSubagents(): string[] {
    return ['claude', 'cursor', 'codex', 'gemini'];
  }

  getAvailableAliases(): string[] {
    return ['claude-code', 'claude_code', 'gemini-cli', 'cursor-agent'];
  }
}

/**
 * Stub Progress Callback Manager
 */
export class ProgressCallbackManager {
  private callbacks: Function[] = [];
  private errorCallbacks: Function[] = [];

  addCallback(callback: Function): () => void {
    this.callbacks.push(callback);
    return () => {
      const index = this.callbacks.indexOf(callback);
      if (index > -1) {
        this.callbacks.splice(index, 1);
      }
    };
  }

  addErrorCallback(callback: Function): void {
    this.errorCallbacks.push(callback);
  }

  async emitProgress(event: any): Promise<void> {
    for (const callback of this.callbacks) {
      try {
        await callback(event);
      } catch (error) {
        for (const errorCallback of this.errorCallbacks) {
          errorCallback(error);
        }
      }
    }
  }

  getCallbackCount(): number {
    return this.callbacks.length;
  }

  clear(): void {
    this.callbacks = [];
    this.errorCallbacks = [];
  }
}

/**
 * Stub Session Context Manager
 */
export class SessionContextManager {
  private sessions: Map<string, any> = new Map();

  createSession(sessionId?: string, userId?: string, metadata?: any): any {
    const id = sessionId || `session-${Date.now()}`;
    const session = {
      sessionId: id,
      userId,
      metadata: metadata || {},
      activeToolCalls: [],
      state: 'INITIALIZING',
      startTime: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(sessionId: string): any {
    return this.sessions.get(sessionId);
  }

  updateSessionState(sessionId: string, state: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = state;
      session.lastActivity = new Date();
    }
  }

  addActiveToolCall(sessionId: string, toolCallId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activeToolCalls.push(toolCallId);
    }
  }

  removeActiveToolCall(sessionId: string, toolCallId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const index = session.activeToolCalls.indexOf(toolCallId);
      if (index > -1) {
        session.activeToolCalls.splice(index, 1);
      }
    }
  }

  updateSessionMetadata(sessionId: string, metadata: any): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata = { ...session.metadata, ...metadata };
    }
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = 'COMPLETED';
    }
  }

  cleanupExpiredSessions(maxAge: number): void {
    const cutoff = Date.now() - maxAge;
    for (const [sessionId, session] of this.sessions) {
      if (session.startTime.getTime() < cutoff) {
        this.sessions.delete(sessionId);
      }
    }
  }

  getActiveSessions(): any[] {
    return Array.from(this.sessions.values()).filter(s => s.state === 'ACTIVE');
  }

  getStatistics(): any {
    const sessions = Array.from(this.sessions.values());
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.state === 'ACTIVE').length,
      idleSessions: sessions.filter(s => s.state === 'IDLE').length,
      completedSessions: sessions.filter(s => s.state === 'COMPLETED').length,
      totalActiveToolCalls: sessions.reduce((sum, s) => sum + s.activeToolCalls.length, 0),
    };
  }
}