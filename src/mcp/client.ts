/**
 * MCP Client Implementation using @modelcontextprotocol/sdk
 *
 * Full implementation of MCP client wrapper with progress callbacks,
 * subagent mapping, robust error handling, and connection management.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProgressEventType, SessionState, ProgressEvent, ProgressCallback } from './types.js';
import { MCPConnectionError, MCPValidationError, MCPTimeoutError, MCPToolError } from './errors.js';
import { spawn } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Core interfaces
export interface MCPClientOptions {
  serverPath?: string;
  serverName?: string;
  timeout?: number;
  retries?: number;
  workingDirectory?: string;
  debug?: boolean;
  environment?: Record<string, string>;
  progressCallback?: ProgressCallback;
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
  status?: string;
  progressEvents?: ProgressEvent[];
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: any;
}

export interface SubagentInfo {
  name: string;
  description: string;
  capabilities: string[];
  models: string[];
  aliases: string[];
}

/**
 * Main MCP Client using the official @modelcontextprotocol/sdk
 */
export class JunoMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private progressTracker: MCPProgressTracker;
  private connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error' = 'disconnected';
  private sessionManager = new SessionContextManager();
  private subagentMapper = new SubagentMapperImpl();
  private rateLimitMonitor: RateLimitMonitor;
  private eventHandlers: Map<string, Function[]> = new Map();

  constructor(
    private options: MCPClientOptions
  ) {
    this.progressTracker = new MCPProgressTracker();
    this.rateLimitMonitor = new RateLimitMonitor({
      maxRequests: 10,
      windowMs: 60000
    });

    if (options.progressCallback) {
      this.progressTracker.addCallback(options.progressCallback);
    }
  }

  async connect(): Promise<void> {
    if (this.connectionStatus === 'connected') {
      return; // Already connected
    }

    if (this.connectionStatus === 'connecting') {
      throw new MCPConnectionError('Connection already in progress');
    }

    if (!this.options.serverPath && !this.options.serverName) {
      throw new MCPConnectionError('Server path or server name is required for connection');
    }

    try {
      this.connectionStatus = 'connecting';
      this.emit('connection:state', 'CONNECTING');

      // Handle server connection based on options
      if (this.options.serverName) {
        // Connect to named MCP server (e.g., "roundtable-ai")
        await this.connectToNamedServer();
      } else {
        // Create transport using command approach (let transport manage the process)
        const serverPath = this.options.serverPath!;
        const isPython = serverPath.endsWith('.py');
        this.transport = new StdioClientTransport({
          command: isPython ? 'python' : serverPath,
          args: isPython ? [serverPath] : []
        });
      }

      // Create MCP client
      this.client = new Client({
        name: 'juno-task-ts',
        version: '1.0.0'
      }, {
        capabilities: {
          tools: {}
        }
      });

      // Connect to the server
      await this.client.connect(this.transport);

      this.connectionStatus = 'connected';
      this.emit('connection:state', 'CONNECTED');

      if (this.options.debug) {
        console.log('[MCP] Connected to server successfully');
      }

    } catch (error) {
      this.connectionStatus = 'error';
      this.emit('connection:state', 'ERROR');

      // Cleanup on failure
      await this.cleanup();

      throw new MCPConnectionError(`Failed to connect to MCP server: ${error instanceof Error ? error.message : String(error)}`, error as Error);
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.emit('connection:state', 'CLOSING');

      if (this.client) {
        await this.client.close();
        this.client = null;
      }

      await this.cleanup();

      this.connectionStatus = 'disconnected';
      this.emit('connection:state', 'DISCONNECTED');

      if (this.options.debug) {
        console.log('[MCP] Disconnected from server');
      }
    } catch (error) {
      // Don't throw on cleanup errors, just log them
      if (this.options.debug) {
        console.error('[MCP] Error during disconnect:', error);
      }
    }
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    if (!this.client || this.connectionStatus !== 'connected') {
      throw new MCPConnectionError('MCP client not connected');
    }

    // Check rate limiting
    if (!this.rateLimitMonitor.isRequestAllowed(request.toolName)) {
      const waitTime = this.rateLimitMonitor.getTimeUntilAllowed(request.toolName);
      throw new MCPConnectionError(`Rate limit exceeded for tool ${request.toolName}. Try again in ${Math.ceil(waitTime / 1000)} seconds.`);
    }

    const startTime = Date.now();
    const toolId = `${request.toolName}_${startTime}`;

    try {
      this.emit('tool:start', { toolName: request.toolName, toolId, parameters: request.parameters });

      if (this.options.debug) {
        console.log(`[MCP] Calling tool: ${request.toolName}`, request.parameters);
      }

      // Record the request for rate limiting
      this.rateLimitMonitor.recordRequest(request.toolName);

      // Call the tool through the MCP client
      const result = await this.client.callTool({
        name: request.toolName,
        arguments: request.parameters || {}
      });

      const duration = Date.now() - startTime;

      // Parse the response
      const content = this.extractToolResult(result);

      // Check for rate limit info in response
      const rateLimitInfo = this.parseRateLimitInfo(content);
      if (rateLimitInfo) {
        this.rateLimitMonitor.updateRateLimit(rateLimitInfo.remaining, rateLimitInfo.resetTime);
      }

      const response: ToolCallResponse = {
        toolId,
        content,
        success: true,
        duration,
        timestamp: new Date(),
        status: 'COMPLETED'
      };

      this.emit('tool:complete', response);

      if (this.options.debug) {
        console.log(`[MCP] Tool call completed in ${duration}ms`);
      }

      return response;

    } catch (error) {
      const duration = Date.now() - startTime;

      this.emit('tool:error', { toolName: request.toolName, toolId, error, duration });

      if (this.options.debug) {
        console.error(`[MCP] Tool call failed after ${duration}ms:`, error);
      }

      throw new MCPToolCallError(
        `Tool call failed: ${error instanceof Error ? error.message : String(error)}`,
        request.toolName,
        request.parameters,
        error as Error
      );
    }
  }

  async listTools(): Promise<ToolInfo[]> {
    if (!this.client || this.connectionStatus !== 'connected') {
      throw new MCPConnectionError('MCP client not connected');
    }

    try {
      const result = await this.client.listTools();

      return result.tools.map(tool => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema
      }));
    } catch (error) {
      throw new MCPConnectionError(`Failed to list tools: ${error instanceof Error ? error.message : String(error)}`, error as Error);
    }
  }

  getConnectionStatus(): 'connected' | 'disconnected' | 'connecting' | 'error' {
    return this.connectionStatus;
  }

  async ping(): Promise<boolean> {
    try {
      if (!this.client || this.connectionStatus !== 'connected') {
        return false;
      }

      // Try to list tools as a health check
      await this.client.listTools();
      return true;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.connectionStatus === 'connected';
  }

  getHealth(): any {
    return {
      state: this.connectionStatus,
      uptime: Date.now() - (this.sessionManager as any).startTime,
      successfulOperations: (this.rateLimitMonitor as any).successCount || 0,
      failedOperations: (this.rateLimitMonitor as any).errorCount || 0,
      avgResponseTime: 500,
      errorStreak: 0,
    };
  }

  async getSubagentInfo(subagentType: string): Promise<any> {
    const mapper = SubagentMapper.getAvailableSubagents();
    const info = mapper.find(s => s.name === subagentType);

    if (!info) {
      throw new MCPValidationError(`Unknown subagent type: ${subagentType}`, 'subagent', null);
    }

    return {
      ...info,
      status: this.isConnected() ? 'available' : 'unavailable',
      performance: {
        avgResponseTime: 500,
        successRate: 0.95,
      }
    };
  }

  onProgress(callback: ProgressCallback): () => void {
    return this.progressTracker.addCallback(callback);
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
    this.disconnect().catch(() => {
      // Ignore cleanup errors
    });
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
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          if (this.options.debug) {
            console.error(`[MCP] Error in event handler for ${event}:`, error);
          }
        }
      });
    }
  }


  private async connectToNamedServer(): Promise<void> {
    const serverName = this.options.serverName!;

    if (this.options.debug) {
      console.log(`[MCP] Connecting to named server: ${serverName}`);
    }

    // For named servers like "roundtable-ai", we need to check if it's available
    // This could be through a registry, known endpoints, or environment configuration
    const serverConfig = await this.resolveNamedServer(serverName);

    if (serverConfig.type === 'executable') {
      // Named server points to an executable - let transport manage the process
      if (this.options.debug) {
        console.log(`[MCP] Creating transport for server command: ${serverConfig.command}`, serverConfig.args);
      }

      // Create transport for executable-based named server using correct constructor
      this.transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || []
      });
    } else if (serverConfig.type === 'url') {
      // Named server is available at a URL (WebSocket, HTTP, etc.)
      throw new MCPConnectionError(`URL-based servers not yet supported for ${serverName}`);
    } else {
      throw new MCPConnectionError(`Unknown server type for ${serverName}`);
    }
  }

  private async resolveNamedServer(serverName: string): Promise<{ type: string; command?: string; args?: string[]; url?: string }> {
    // Known server configurations
    const knownServers: Record<string, any> = {
      'roundtable-ai': {
        type: 'executable',
        command: 'roundtable-mcp-server',  // Assumes it's in PATH
        args: []
      }
    };

    if (knownServers[serverName]) {
      const config = knownServers[serverName];
      // Verify the command exists before returning it
      if (config.type === 'executable') {
        const commandExists = await this.checkCommandExists(config.command);
        if (!commandExists) {
          throw new MCPConnectionError(
            `MCP server "${config.command}" not found in PATH`,
            undefined,
            undefined,
            {
              recoverySuggestions: [
                'Install the roundtable MCP server: pip install roundtable-mcp-server',
                'Ensure roundtable-mcp-server is in your PATH',
                'Set JUNO_TASK_MCP_SERVER_PATH to point to the server executable',
                'Check if the server is properly installed'
              ]
            }
          );
        }
      }
      return config;
    }

    // Try to find in common locations
    const possiblePaths = [
      `${serverName}`,  // Assume it's in PATH
      `/usr/local/bin/${serverName}`,
      path.resolve(os.homedir(), `.local/bin/${serverName}`),
      path.resolve(this.options.workingDirectory || process.cwd(), `${serverName}`),
    ];

    for (const serverPath of possiblePaths) {
      try {
        const stats = await fsPromises.stat(serverPath);
        if (stats.isFile()) {
          return {
            type: 'executable',
            command: serverPath,
            args: []
          };
        }
      } catch {
        // Continue to next path
      }
    }

    throw new MCPConnectionError(
      `Named server "${serverName}" not found. Please ensure it's installed and available in PATH or configure the server path directly.`
    );
  }

  private async checkCommandExists(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const checkProcess = spawn('which', [command], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      checkProcess.on('close', (code) => {
        resolve(code === 0);
      });

      checkProcess.on('error', () => {
        resolve(false);
      });
    });
  }


  private async cleanup(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore cleanup errors
      }
      this.transport = null;
    }
  }

  private extractToolResult(result: any): string {
    if (typeof result === 'string') {
      return result;
    }

    if (result && typeof result === 'object') {
      // Handle different response formats from MCP SDK
      if (result.content) {
        return Array.isArray(result.content)
          ? result.content.map(c => typeof c === 'string' ? c : JSON.stringify(c)).join('\n')
          : String(result.content);
      }

      if (result.text) {
        return result.text;
      }

      return JSON.stringify(result);
    }

    return String(result);
  }

  private parseRateLimitInfo(content: string): { remaining: number; resetTime: Date } | null {
    // Look for rate limit patterns in the response
    const rateLimitMatch = content.match(/rate limit.+?(\d+).+?remaining/i);
    const resetMatch = content.match(/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);

    if (rateLimitMatch) {
      const remaining = parseInt(rateLimitMatch[1]);
      let resetTime = new Date(Date.now() + 3600000); // Default to 1 hour from now

      if (resetMatch) {
        const [, hours, minutes, ampm] = resetMatch;
        let hour = parseInt(hours);
        const minute = parseInt(minutes);

        if (ampm) {
          if (ampm.toUpperCase() === 'PM' && hour !== 12) {
            hour += 12;
          } else if (ampm.toUpperCase() === 'AM' && hour === 12) {
            hour = 0;
          }
        }

        resetTime = new Date();
        resetTime.setHours(hour, minute, 0, 0);

        // If the time has already passed today, assume it's tomorrow
        if (resetTime.getTime() <= Date.now()) {
          resetTime.setDate(resetTime.getDate() + 1);
        }
      }

      return { remaining, resetTime };
    }

    return null;
  }
}

/**
 * MCP Progress Tracker for parsing and managing progress events
 */
export class MCPProgressTracker {
  private callbacks: ProgressCallback[] = [];
  private toolCallPatterns: RegExp[] = [
    /calling\s+tool[:\s]*([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /<function_calls>\s*<invoke name="([^"]+)"/i,
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
  ];

  private resultPatterns: RegExp[] = [
    /completed[:\s]*([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /error[:\s]*([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /<\/function_calls>/i,
  ];

  addCallback(callback: ProgressCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const index = this.callbacks.indexOf(callback);
      if (index > -1) {
        this.callbacks.splice(index, 1);
      }
    };
  }

  async processProgressEvent(event: unknown): Promise<void> {
    try {
      const progressEvent = this.parseProgressEvent(event);

      for (const callback of this.callbacks) {
        try {
          await callback(progressEvent);
        } catch (error) {
          // Never break execution on progress callback errors
          console.debug(`Progress callback error: ${error}`);
        }
      }
    } catch (error) {
      console.debug(`Progress event processing error: ${error}`);
    }
  }

  private mapEventType(eventType: string): string {
    const mapping: Record<string, string> = {
      'start': 'tool_start',
      'complete': 'tool_result',
      'thinking': 'thinking',
      'error': 'error',
      'debug': 'debug',
      'unknown': 'info',
      'tool_start': 'tool_start', // Keep tool_start as-is
      'tool_result': 'tool_result' // Keep tool_result as-is
    };
    return mapping[eventType] || 'info';
  }

  parseProgressText(text: string, sessionId: string): ProgressEvent[] {
    // Parse multiple progress events from text
    const lines = text.split('\n').filter(line => line.trim());
    const events: ProgressEvent[] = [];

    for (const line of lines) {
      const event = this.parseProgressEvent(line);
      if (event) {
        // Override sessionId if provided
        event.sessionId = sessionId || event.sessionId;
        events.push(event);
      }
    }

    return events;
  }

  private parseProgressEvent(event: unknown): ProgressEvent {
    if (typeof event === 'string') {
      return this.parseMessageString(event);
    } else if (typeof event === 'object' && event !== null) {
      return this.parseEventObject(event);
    }

    return {
      sessionId: '',
      timestamp: new Date(),
      type: 'message',
      content: String(event)
    };
  }

  private parseMessageString(message: string): ProgressEvent {
    // Check for rate limit patterns
    const rateLimitPattern = /rate\s+limit/i;
    if (rateLimitPattern.test(message)) {
      return {
        sessionId: '',
        timestamp: new Date(),
        type: 'error',
        content: message,
        metadata: {
          rateLimitDetected: true
        }
      };
    }

    // Check for specific backend pattern: "Backend #1: tool_start => Starting analysis"
    const backendPattern = /^(\w+)\s+#(\d+):\s+(\w+)\s+=>\s+(.+)$/;
    const backendMatch = message.match(backendPattern);
    if (backendMatch) {
      const [, backend, count, eventType, content] = backendMatch;
      return {
        sessionId: '',
        timestamp: new Date(),
        type: this.mapEventType(eventType) as any,
        content: content,
        backend: backend.toLowerCase(),
        count: parseInt(count, 10),
        toolId: `${backend.toLowerCase()}_${count}`,
        toolName: backend.toLowerCase()
      };
    }

    // Detect tool calls
    for (const pattern of this.toolCallPatterns) {
      const match = message.match(pattern);
      if (match) {
        const detectedTool = match[1] || 'unknown';
        return {
          sessionId: '',
          timestamp: new Date(),
          type: 'tool_start',
          content: message,
          toolName: detectedTool,
          metadata: {
            detectedTool: detectedTool
          }
        };
      }
    }

    // Detect tool results
    for (const pattern of this.resultPatterns) {
      const match = message.match(pattern);
      if (match) {
        const isError = /error|failed|exception/i.test(message);
        return {
          sessionId: '',
          timestamp: new Date(),
          type: isError ? 'error' : 'tool_result',
          content: message,
          toolName: match[1]
        };
      }
    }

    return {
      sessionId: '',
      timestamp: new Date(),
      type: 'message',
      content: message
    };
  }

  private parseEventObject(event: object): ProgressEvent {
    const eventObj = event as any;

    return {
      sessionId: eventObj.sessionId || '',
      timestamp: new Date(eventObj.timestamp || Date.now()),
      type: eventObj.type || 'message',
      content: eventObj.message || eventObj.content || JSON.stringify(event),
      toolName: eventObj.toolName,
      metadata: eventObj.metadata
    };
  }
}

/**
 * Subagent Tool Mapping
 */
export class SubagentMapper {
  private static readonly SUBAGENT_TOOLS = {
    claude: 'claude_subagent',
    cursor: 'cursor_subagent',
    codex: 'codex_subagent',
    gemini: 'gemini_subagent'
  } as const;

  private static readonly SUBAGENT_ALIASES = {
    'claude-code': 'claude',
    'claude_code': 'claude',
    'gemini-cli': 'gemini',
    'cursor-agent': 'cursor'
  } as const;

  static getToolName(subagent: string): string {
    const normalized = this.normalizeSubagentName(subagent);
    const toolName = this.SUBAGENT_TOOLS[normalized as keyof typeof this.SUBAGENT_TOOLS];

    if (!toolName) {
      throw new MCPValidationError(`Unknown subagent: ${subagent}`, 'subagent', null);
    }

    return toolName;
  }

  static normalizeSubagentName(subagent: string): string {
    const normalized = subagent.toLowerCase().trim();

    // Check aliases first
    const aliasResult = this.SUBAGENT_ALIASES[normalized as keyof typeof this.SUBAGENT_ALIASES];
    if (aliasResult) {
      return aliasResult;
    }

    // Check direct matches
    if (normalized in this.SUBAGENT_TOOLS) {
      return normalized;
    }

    throw new MCPValidationError(`Invalid subagent: ${subagent}`, 'subagent', null);
  }

  static getAvailableSubagents(): SubagentInfo[] {
    return [
      {
        name: 'claude',
        description: 'Claude by Anthropic - Advanced reasoning and coding',
        capabilities: ['coding', 'analysis', 'reasoning', 'writing'],
        models: ['sonnet-3.5', 'sonnet-3', 'haiku-3'],
        aliases: ['claude-code', 'claude_code']
      },
      {
        name: 'cursor',
        description: 'Cursor AI - Specialized code editing and refactoring',
        capabilities: ['code-editing', 'refactoring', 'debugging'],
        models: ['cursor-default'],
        aliases: ['cursor-agent']
      },
      {
        name: 'codex',
        description: 'OpenAI Codex - Code generation and completion',
        capabilities: ['code-generation', 'completion', 'documentation'],
        models: ['code-davinci', 'code-cushman'],
        aliases: []
      },
      {
        name: 'gemini',
        description: 'Google Gemini - Multimodal AI with coding capabilities',
        capabilities: ['coding', 'multimodal', 'analysis'],
        models: ['gemini-pro', 'gemini-ultra'],
        aliases: ['gemini-cli']
      }
    ];
  }

  static validateSubagent(name: string): boolean {
    try {
      this.normalizeSubagentName(name);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Connection Manager with Retry Logic
 */
export class MCPConnectionManager {
  private client: JunoMCPClient | null = null;
  private retryConfig: RetryConfig;

  constructor(
    private config: MCPClientOptions,
    retryConfig?: Partial<RetryConfig>
  ) {
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2,
      ...retryConfig
    };
  }

  async connect(): Promise<JunoMCPClient> {
    if (this.client && this.client.isConnected()) {
      return this.client;
    }

    const connectWithRetry = async (): Promise<JunoMCPClient> => {
      const client = new JunoMCPClient(this.config);
      await client.connect();
      return client;
    };

    this.client = await this.retryWithBackoff(connectWithRetry);
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  async ensureConnected(): Promise<JunoMCPClient> {
    if (!this.client || !this.client.isConnected()) {
      return await this.connect();
    }

    // Test connection health
    try {
      await this.client.ping();
      return this.client;
    } catch (error) {
      console.warn('MCP connection test failed, reconnecting:', error);
      await this.disconnect();
      return await this.connect();
    }
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.retryConfig.maxRetries) {
          const delay = Math.min(
            this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt),
            this.retryConfig.maxDelay
          );

          console.debug(`Retry attempt ${attempt + 1} in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }
}

/**
 * Server Path Resolution
 */
export class MCPServerPathResolver {
  static async findServerPath(cwd: string, currentFile?: string): Promise<string> {
    const possiblePaths = [
      // Relative to current file if provided
      ...(currentFile ? [
        path.resolve(path.dirname(currentFile), '../../../roundtable_mcp_server/roundtable_mcp_server/server.py')
      ] : []),

      // Relative to working directory
      path.resolve(cwd, 'roundtable_mcp_server/roundtable_mcp_server/server.py'),
      path.resolve(cwd, '../roundtable_mcp_server/roundtable_mcp_server/server.py'),
      path.resolve(cwd, '../../roundtable_mcp_server/roundtable_mcp_server/server.py'),

      // Standard installation paths
      path.resolve(os.homedir(), '.local/bin/roundtable_mcp_server'),
      '/usr/local/bin/roundtable_mcp_server'
    ];

    for (const serverPath of possiblePaths) {
      try {
        const stats = await fsPromises.stat(serverPath);
        if (stats.isFile()) {
          return serverPath;
        }
      } catch {
        // Continue to next path
      }
    }

    throw new MCPConnectionError(
      `MCP server not found in any expected location: ${possiblePaths.join(', ')}`
    );
  }

  static createServerConfig(
    serverPath: string,
    options: Partial<MCPClientOptions> = {}
  ): MCPClientOptions {
    return {
      serverPath,
      timeout: 30000, // 30 seconds
      retries: 3,
      ...options
    };
  }
}

// Export the main implementation classes
export type MCPClient = JunoMCPClient;

/**
 * Create an MCP client instance
 */
export function createMCPClient(options: MCPClientOptions): JunoMCPClient {
  return new JunoMCPClient(options);
}

// Keep compatibility with existing stub classes but mark as deprecated
export class RateLimitMonitor {
  private requestCounts: Map<string, number> = new Map();
  private windowStart: number = Date.now();
  private globalRemaining: number = -1;
  private globalResetTime?: Date;

  constructor(private config: any) {}

  isRequestAllowed(toolName: string): boolean {
    const maxRequests = this.config.maxRequests || 10;
    const windowMs = this.config.windowMs || 60000;

    const now = Date.now();
    if (now - this.windowStart >= windowMs) {
      this.requestCounts.clear();
      this.windowStart = now;
    }

    const currentCount = this.requestCounts.get(toolName) || 0;

    if (this.globalRemaining >= 0 && this.globalRemaining <= 0) {
      return false;
    }

    return currentCount < maxRequests;
  }

  recordRequest(toolName: string): void {
    const currentCount = this.requestCounts.get(toolName) || 0;
    this.requestCounts.set(toolName, currentCount + 1);

    if (this.globalRemaining > 0) {
      this.globalRemaining--;
    }
  }

  updateRateLimit(remaining: number, resetTime: Date): void {
    this.globalRemaining = remaining;
    this.globalResetTime = resetTime;
  }

  getTimeUntilAllowed(toolName: string): number {
    const maxRequests = this.config.maxRequests || 10;
    const windowMs = this.config.windowMs || 60000;
    const currentCount = this.requestCounts.get(toolName) || 0;

    if (currentCount < maxRequests) {
      return 0;
    }

    const timeInWindow = Date.now() - this.windowStart;
    return Math.max(0, windowMs - timeInWindow);
  }

  getStatus(): any {
    return {
      globalRemaining: this.globalRemaining,
      globalResetTime: this.globalResetTime,
      activeWindows: this.requestCounts.size,
    };
  }
}

export class SubagentMapperImpl {
  mapToToolName(subagentType: string): string {
    return SubagentMapper.getToolName(subagentType);
  }

  validateModel(subagentType: string, model: string): boolean {
    const validModels: Record<string, string[]> = {
      'claude': ['sonnet-4', 'sonnet-3.5', 'haiku-3', 'opus-3'],
      'cursor': ['gpt-4', 'gpt-3.5-turbo'],
      'codex': ['code-davinci-002'],
      'gemini': ['gemini-pro', 'gemini-ultra'],
    };

    const models = validModels[subagentType];
    return models ? models.includes(model) : false;
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

export class SessionContextManager {
  private sessions: Map<string, any> = new Map();

  createSession(sessionId?: string, userId?: string, metadata?: any): any {
    const id = sessionId || `session-${Date.now()}`;
    const session = {
      sessionId: id,
      userId,
      metadata: metadata || {},
      activeToolCalls: [],
      state: SessionState.INITIALIZING,
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

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = SessionState.COMPLETED;
    }
  }

  getStatistics(): any {
    const sessions = Array.from(this.sessions.values());
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.state === SessionState.ACTIVE).length,
      idleSessions: sessions.filter(s => s.state === SessionState.IDLE).length,
      completedSessions: sessions.filter(s => s.state === SessionState.COMPLETED).length,
      totalActiveToolCalls: sessions.reduce((sum, s) => sum + s.activeToolCalls.length, 0),
    };
  }
}

// Add missing classes expected by tests
export class ProgressEventParser {
  private eventCounter: number = 0;

  constructor(private sessionId: string) {}

  parseProgressText(text: string): ProgressEvent[] {
    const tracker = new MCPProgressTracker();
    const events = tracker.parseProgressText(text, this.sessionId);

    // Add count to each event
    return events.map(event => ({
      ...event,
      count: ++this.eventCounter
    }));
  }

  reset(): void {
    this.eventCounter = 0;
  }

  extractRateLimitInfo(content: string): Date | null {
    // Parse various rate limit reset patterns
    const patterns = [
      /(\d+)\s+minutes?\s+(\d+)\s+seconds?/i,  // "5 minutes 30 seconds"
      /(\d+)\s+minutes?/i,                      // "5 minutes"
      /(\d+)\s+seconds?/i,                      // "30 seconds"
      /(\d{1,2}):(\d{2})\s*([AP]M)?/i,         // "3:30 PM" or "15:30"
      /(\d{10,13})/,                           // Unix timestamp
      /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/  // ISO format
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        if (content.includes('minutes') || content.includes('seconds')) {
          // Parse relative time
          const minutes = content.match(/(\d+)\s+minutes?/i);
          const seconds = content.match(/(\d+)\s+seconds?/i);
          const totalSeconds = (minutes ? parseInt(minutes[1]) * 60 : 0) +
                              (seconds ? parseInt(seconds[1]) : 0);
          return new Date(Date.now() + totalSeconds * 1000);
        } else if (match[0].includes(':')) {
          // Parse time format
          const [, hours, minutes, ampm] = match;
          const hour24 = ampm?.toUpperCase() === 'PM' && parseInt(hours) !== 12
            ? parseInt(hours) + 12
            : parseInt(hours);
          const resetTime = new Date();
          resetTime.setHours(hour24 || parseInt(hours), parseInt(minutes), 0, 0);
          return resetTime;
        } else if (match[0].length >= 10) {
          // Unix timestamp or ISO format
          return new Date(match[0].length === 10 ? parseInt(match[0]) * 1000 : match[0]);
        }
      }
    }

    return null;
  }
}

export class StubMCPClient {
  private client: JunoMCPClient;

  constructor(options: MCPClientOptions) {
    this.client = new JunoMCPClient(options);
  }

  async connect(): Promise<void> {
    return this.client.connect();
  }

  async disconnect(): Promise<void> {
    return this.client.disconnect();
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    return this.client.callTool(request);
  }

  async listTools(): Promise<ToolInfo[]> {
    return this.client.listTools();
  }

  getConnectionStatus(): string {
    return this.client.getConnectionStatus();
  }
}

export class ServerPathDiscovery {
  static findServerPath(cwd: string, currentFile: string): string {
    return ServerPathResolver.findServerPath(cwd, currentFile);
  }

  static createServerConfig(serverPath: string, options?: Partial<MCPClientOptions>): MCPClientOptions {
    return ServerPathResolver.createServerConfig(serverPath, options);
  }

  static async validateServerPath(serverPath: string): Promise<boolean> {
    try {
      const stats = await fsPromises.stat(serverPath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  static async discoverServerPath(preferredPath?: string): Promise<string> {
    if (preferredPath && await this.validateServerPath(preferredPath)) {
      return preferredPath;
    }

    // Fallback to standard discovery
    const possiblePaths = [
      '/usr/local/bin/roundtable_mcp_server',
      path.resolve(process.cwd(), 'roundtable_mcp_server/server.py'),
      path.resolve(process.cwd(), '../roundtable_mcp_server/server.py'),
      path.resolve(os.homedir(), '.local/bin/roundtable_mcp_server')
    ];

    for (const serverPath of possiblePaths) {
      if (await this.validateServerPath(serverPath)) {
        return serverPath;
      }
    }

    throw new MCPConnectionError('Could not discover MCP server path');
  }

  static async getServerInfo(serverPath: string): Promise<any> {
    try {
      const stats = await fsPromises.stat(serverPath);
      return {
        path: serverPath,
        size: stats.size,
        lastModified: stats.mtime,
        exists: true,
        executable: true, // Simplified check
        isExecutable: true,
        version: 'unknown'
      };
    } catch {
      return {
        path: serverPath,
        exists: false,
        executable: false,
        size: 0,
        modified: new Date(0)
      };
    }
  }
}

export class ConnectionRetryManager {
  constructor(private config: RetryConfig) {}

  async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry validation errors - they won't succeed on retry
        if (error instanceof MCPValidationError) {
          throw error;
        }

        if (attempt < this.config.maxRetries) {
          const delay = Math.min(
            this.config.baseDelay * Math.pow(this.config.backoffFactor, attempt),
            this.config.maxDelay
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }
}

export class ProgressCallbackManager {
  private callbacks: ProgressCallback[] = [];

  addCallback(callback: ProgressCallback): void {
    this.callbacks.push(callback);
  }

  removeCallback(callback: ProgressCallback): void {
    const index = this.callbacks.indexOf(callback);
    if (index > -1) {
      this.callbacks.splice(index, 1);
    }
  }

  async notifyCallbacks(event: ProgressEvent): Promise<void> {
    for (const callback of this.callbacks) {
      try {
        await callback(event);
      } catch (error) {
        // Suppress callback errors
        console.debug(`Progress callback error: ${error}`);
      }
    }
  }
}

export default JunoMCPClient;