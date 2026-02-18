/**
 * MCP client implementation for juno-task-ts
 *
 * Provides comprehensive client-side MCP (Model Context Protocol) functionality
 * for communicating with subagents and external services. Integrates with the
 * @modelcontextprotocol/sdk and provides advanced features like connection
 * management, retry logic, progress callbacks, session tracking, and error recovery.
 *
 * @module mcp/client
 * @version 1.0.0
 */

import { EventEmitter } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { v4 as uuidv4 } from 'uuid';

// MCP SDK imports
import {
  Client,
} from '@modelcontextprotocol/sdk/client';
import {
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio';
import { Transport } from '@modelcontextprotocol/sdk/shared';
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
  GetPromptRequest,
  GetPromptResult,
} from '@modelcontextprotocol/sdk/types';

// Internal imports
import type {
  MCPServerConfig,
  ProgressEvent,
  ProgressCallback,
  ToolCallRequest,
  ToolCallResult,
  MCPSessionContext,
  ConnectionHealth,
  ConnectionEvent,
  RecoveryStrategy,
  RecoveryStrategyType,
  RetryConfig,
  RateLimitConfig,
  SubagentType,
  SubagentMapper,
  SubagentInfo,
  MCPEventMap,
  MCPEventEmitter,
} from './types';
import {
  MCPConnectionState,
  ProgressEventType,
  ToolExecutionStatus,
  SessionState,
  ConnectionEventType,
  SUBAGENT_TOOL_MAPPING,
  SUBAGENT_ALIASES,
  PROGRESS_PATTERNS,
  MCP_DEFAULTS,
} from './types';
import {
  MCPError,
  MCPConnectionError,
  MCPTimeoutError,
  MCPToolError,
  MCPRateLimitError,
  MCPValidationError,
  MCPErrorType,
} from './errors';
import type { MetricsCollector } from '../core/metrics';

/**
 * Progress event parser for handling Roundtable MCP server output
 * Parses progress messages in the format: "Backend #count: event_type => content"
 */
export class ProgressEventParser {
  private sessionId: string;
  private eventCount: number = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Parse progress text and extract events
   * @param text - Raw text output from MCP server
   * @returns Array of parsed progress events
   */
  parseProgressText(text: string): ProgressEvent[] {
    const events: ProgressEvent[] = [];
    const lines = text.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const event = this.parseProgressLine(line);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Parse a single progress line
   * @param line - Single line of progress output
   * @returns Parsed progress event or null
   */
  private parseProgressLine(line: string): ProgressEvent | null {
    const trimmedLine = line.trim();
    if (!trimmedLine) return null;

    // Try to match the main progress pattern: "Backend #count: event_type => content"
    const mainMatch = trimmedLine.match(PROGRESS_PATTERNS.MAIN);
    if (mainMatch) {
      const [, backend, countStr, eventType, content] = mainMatch;
      const count = parseInt(countStr, 10);

      // Generate tool ID based on backend and count
      const toolId = `${backend.toLowerCase()}_${count}`;

      return {
        sessionId: this.sessionId,
        timestamp: new Date(),
        backend: backend.toLowerCase(),
        count,
        type: this.mapEventType(eventType),
        content: content.trim(),
        toolId,
        metadata: {
          rawLine: trimmedLine,
          parsedAt: new Date().toISOString(),
        },
      };
    }

    // Check for tool call patterns
    for (const pattern of PROGRESS_PATTERNS.TOOL_CALLS) {
      const match = trimmedLine.match(pattern);
      if (match) {
        this.eventCount++;
        return {
          sessionId: this.sessionId,
          timestamp: new Date(),
          backend: 'unknown',
          count: this.eventCount,
          type: ProgressEventType.TOOL_START,
          content: trimmedLine,
          toolId: `tool_${this.eventCount}`,
          metadata: {
            rawLine: trimmedLine,
            detectedTool: match[1],
            parsedAt: new Date().toISOString(),
          },
        };
      }
    }

    // Check for rate limit patterns
    for (const pattern of PROGRESS_PATTERNS.RATE_LIMITS) {
      const match = trimmedLine.match(pattern);
      if (match) {
        this.eventCount++;
        return {
          sessionId: this.sessionId,
          timestamp: new Date(),
          backend: 'system',
          count: this.eventCount,
          type: ProgressEventType.ERROR,
          content: trimmedLine,
          toolId: `rate_limit_${this.eventCount}`,
          metadata: {
            rawLine: trimmedLine,
            rateLimitDetected: true,
            parsedAt: new Date().toISOString(),
          },
        };
      }
    }

    // Default event for unrecognized patterns
    this.eventCount++;
    return {
      sessionId: this.sessionId,
      timestamp: new Date(),
      backend: 'unknown',
      count: this.eventCount,
      type: ProgressEventType.INFO,
      content: trimmedLine,
      toolId: `unknown_${this.eventCount}`,
      metadata: {
        rawLine: trimmedLine,
        unrecognizedPattern: true,
        parsedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Map event type string to ProgressEventType enum
   * @param eventTypeStr - Event type string from output
   * @returns Mapped ProgressEventType
   */
  private mapEventType(eventTypeStr: string): ProgressEventType {
    const normalized = eventTypeStr.toLowerCase();

    switch (normalized) {
      case 'tool_start':
      case 'start':
      case 'calling':
        return ProgressEventType.TOOL_START;

      case 'tool_result':
      case 'result':
      case 'complete':
      case 'completed':
        return ProgressEventType.TOOL_RESULT;

      case 'thinking':
      case 'processing':
      case 'analyzing':
        return ProgressEventType.THINKING;

      case 'error':
      case 'failed':
      case 'failure':
        return ProgressEventType.ERROR;

      case 'debug':
        return ProgressEventType.DEBUG;

      case 'info':
      case 'information':
      default:
        return ProgressEventType.INFO;
    }
  }

  /**
   * Extract rate limit information from content
   * @param content - Event content
   * @returns Rate limit reset time or null
   */
  extractRateLimitInfo(content: string): Date | null {
    for (const pattern of PROGRESS_PATTERNS.RATE_LIMITS) {
      const match = content.match(pattern);
      if (match) {
        // Pattern 1: /resets\s+(at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i     -> match[1]=at, match[2]=hour, match[3]=minutes, match[4]=am/pm
        // Pattern 2: /resets\s+(at\s+)?(\d{1,2})\s*(am|pm)/i              -> match[1]=at, match[2]=hour, match[3]=am/pm
        // Pattern 3: /try again in (\d+)\s*(minutes?|hours?)/i             -> match[1]=amount, match[2]=unit
        // Pattern 4: /5-hour limit reached.*resets\s+(at\s+)?(\d{1,2})\s*(am|pm)/i -> match[1]=at, match[2]=hour, match[3]=am/pm

        if (pattern.source.includes('try again in')) {
          // Handle "try again in X minutes/hours" pattern
          const amount = parseInt(match[1], 10);
          const unit = match[2]?.toLowerCase();

          if (!isNaN(amount) && unit) {
            const resetTime = new Date();
            if (unit.includes('minute')) {
              resetTime.setMinutes(resetTime.getMinutes() + amount);
            } else if (unit.includes('hour')) {
              resetTime.setHours(resetTime.getHours() + amount);
            }
            return resetTime;
          }
        } else {
          // Handle time-based patterns (e.g., "resets at 3:30 PM")
          // The patterns now have "at" as an optional group, so indices shift
          const hour = parseInt(match[2], 10); // Hour is now in match[2]

          if (!isNaN(hour)) {
            const resetTime = new Date();

            // Check if this is pattern 1 (has minutes) - if match[3] is a number
            let minutes = 0;
            let ampm = null;

            if (match[3] && !isNaN(parseInt(match[3], 10))) {
              // Pattern 1: has minutes
              minutes = parseInt(match[3], 10);
              ampm = match[4]; // am/pm is in match[4]
            } else {
              // Pattern 2 or 4: no minutes
              ampm = match[3]; // am/pm is in match[3]
            }

            // Convert 12-hour to 24-hour format if am/pm is specified
            let finalHour = hour;
            if (ampm) {
              const period = ampm.toLowerCase();
              if (period.includes('pm') && hour !== 12) {
                finalHour = hour + 12;
              } else if (period.includes('am') && hour === 12) {
                finalHour = 0;
              }
            }

            resetTime.setHours(finalHour, minutes, 0, 0);

            // If the time is in the past, assume it's tomorrow
            if (resetTime <= new Date()) {
              resetTime.setDate(resetTime.getDate() + 1);
            }

            return resetTime;
          }
        }
      }
    }
    return null;
  }

  /**
   * Reset event counter
   */
  reset(): void {
    this.eventCount = 0;
  }
}

/**
 * Server path discovery utility
 * Handles automatic discovery of MCP server executables
 */
export class ServerPathDiscovery {
  private static readonly COMMON_SERVER_NAMES = [
    'roundtable_mcp_server',
    'mcp_server',
    'claude_mcp_server',
    'roundtable-mcp-server',
    'mcp-server',
  ];

  private static readonly SEARCH_PATHS = [
    process.cwd(),
    path.join(process.cwd(), 'bin'),
    path.join(process.cwd(), 'scripts'),
    path.join(process.cwd(), 'tools'),
    '/usr/local/bin',
    '/usr/bin',
    process.env.PATH?.split(path.delimiter) || [],
  ].flat();

  /**
   * Discover MCP server path automatically
   * @param preferredPath - Preferred server path (if provided)
   * @returns Promise resolving to discovered server path
   */
  static async discoverServerPath(preferredPath?: string): Promise<string> {
    // If preferred path is provided, validate it first
    if (preferredPath) {
      const isValid = await this.validateServerPath(preferredPath);
      if (isValid) {
        return preferredPath;
      }
      throw new MCPConnectionError(
        `Preferred server path is not valid: ${preferredPath}`,
        'server_discovery',
        { path: preferredPath, status: 'invalid' }
      );
    }

    // Search for servers in common locations
    for (const searchPath of this.SEARCH_PATHS) {
      for (const serverName of this.COMMON_SERVER_NAMES) {
        const fullPath = path.resolve(searchPath, serverName);
        const isValid = await this.validateServerPath(fullPath);
        if (isValid) {
          return fullPath;
        }

        // Also try with .py extension
        const pyPath = `${fullPath}.py`;
        const isPyValid = await this.validateServerPath(pyPath);
        if (isPyValid) {
          return pyPath;
        }
      }
    }

    throw new MCPConnectionError(
      'Could not discover MCP server path. Please provide serverPath in configuration.',
      'server_discovery',
      undefined,
      {
        recoverySuggestions: [
          'Set mcpServerPath in configuration',
          'Ensure MCP server is installed and accessible',
          'Check PATH environment variable',
          'Verify server executable permissions',
        ],
      }
    );
  }

  /**
   * Validate server path exists and is executable
   * @param serverPath - Path to validate
   * @returns Promise resolving to validation result
   */
  static async validateServerPath(serverPath: string): Promise<boolean> {
    try {
      const stats = await fsPromises.stat(serverPath);
      if (!stats.isFile()) {
        return false;
      }

      // Check if file is executable (basic check)
      await fsPromises.access(serverPath, fsPromises.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get server information
   * @param serverPath - Server executable path
   * @returns Server information
   */
  static async getServerInfo(serverPath: string): Promise<{
    path: string;
    exists: boolean;
    executable: boolean;
    size: number;
    modified: Date;
  }> {
    try {
      const stats = await fsPromises.stat(serverPath);
      const executable = await this.validateServerPath(serverPath);

      return {
        path: serverPath,
        exists: true,
        executable,
        size: stats.size,
        modified: stats.mtime,
      };
    } catch {
      return {
        path: serverPath,
        exists: false,
        executable: false,
        size: 0,
        modified: new Date(0),
      };
    }
  }
}

/**
 * Connection retry manager with exponential backoff
 */
export class ConnectionRetryManager {
  private retryConfig: RetryConfig;
  private currentAttempt: number = 0;
  private lastError: Error | null = null;

  constructor(retryConfig: Partial<RetryConfig> = {}) {
    this.retryConfig = {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitterFactor: 0.1,
      ...retryConfig,
    };
  }

  /**
   * Execute operation with retry logic
   * @param operation - Operation to execute
   * @param operationName - Name for logging
   * @returns Promise resolving to operation result
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<T> {
    this.currentAttempt = 0;
    this.lastError = null;

    while (this.currentAttempt <= this.retryConfig.maxRetries) {
      try {
        const result = await operation();
        return result;
      } catch (error) {
        this.lastError = error as Error;
        this.currentAttempt++;

        // Check if we should retry
        if (!this.shouldRetry(error as Error)) {
          throw error;
        }

        // If this was the last attempt, throw the error
        if (this.currentAttempt > this.retryConfig.maxRetries) {
          throw new MCPConnectionError(
            `${operationName} failed after ${this.retryConfig.maxRetries} retries: ${this.lastError.message}`,
            'retry_exhausted',
            undefined,
            {
              retryInfo: {
                attempt: this.currentAttempt,
                maxAttempts: this.retryConfig.maxRetries,
                strategy: 'exponential_backoff',
              },
            }
          );
        }

        // Calculate delay and wait
        const delay = this.calculateDelay();
        await this.delay(delay);
      }
    }

    // This should never be reached, but TypeScript requires it
    throw this.lastError || new Error('Unknown retry error');
  }

  /**
   * Check if operation should be retried
   * @param error - Error that occurred
   * @returns True if should retry
   */
  private shouldRetry(error: Error): boolean {
    // Use custom retry condition if provided
    if (this.retryConfig.shouldRetry) {
      return this.retryConfig.shouldRetry(error, this.currentAttempt);
    }

    // Default retry logic
    if (error instanceof MCPRateLimitError) {
      return true; // Always retry rate limits
    }

    if (error instanceof MCPTimeoutError) {
      return this.currentAttempt <= 2; // Retry timeouts up to 2 times
    }

    if (error instanceof MCPConnectionError) {
      return true; // Retry connection errors
    }

    if (error instanceof MCPValidationError) {
      return false; // Don't retry validation errors
    }

    // For unknown errors, retry if we have attempts left
    return this.currentAttempt < this.retryConfig.maxRetries;
  }

  /**
   * Calculate delay for next retry with exponential backoff and jitter
   * @returns Delay in milliseconds
   */
  private calculateDelay(): number {
    const baseDelay = Math.min(
      this.retryConfig.initialDelay * Math.pow(this.retryConfig.backoffMultiplier, this.currentAttempt - 1),
      this.retryConfig.maxDelay
    );

    // Add jitter to prevent thundering herd
    const jitter = baseDelay * this.retryConfig.jitterFactor * (Math.random() - 0.5) * 2;
    return Math.max(0, baseDelay + jitter);
  }

  /**
   * Wait for specified delay
   * @param ms - Milliseconds to wait
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current retry information
   * @returns Retry information
   */
  getRetryInfo(): {
    currentAttempt: number;
    maxRetries: number;
    lastError: Error | null;
  } {
    return {
      currentAttempt: this.currentAttempt,
      maxRetries: this.retryConfig.maxRetries,
      lastError: this.lastError,
    };
  }

  /**
   * Reset retry state
   */
  reset(): void {
    this.currentAttempt = 0;
    this.lastError = null;
  }
}

/**
 * Rate limit monitor for tracking and handling rate limits
 */
export class RateLimitMonitor {
  private rateLimitConfig: RateLimitConfig;
  private requestCounts: Map<string, { count: number; resetTime: Date }> = new Map();
  private globalRateLimit: { remaining: number; resetTime?: Date } | null = null;

  constructor(rateLimitConfig: Partial<RateLimitConfig> = {}) {
    this.rateLimitConfig = {
      maxRequests: 100,
      windowMs: 60000, // 1 minute
      burstAllowance: 10,
      adaptive: true,
      ...rateLimitConfig,
    };
  }

  /**
   * Check if request is allowed
   * @param identifier - Request identifier (tool name, etc.)
   * @returns True if request is allowed
   */
  isRequestAllowed(identifier: string = 'global'): boolean {
    const now = new Date();
    const windowKey = this.getWindowKey(now);
    const requestKey = `${identifier}:${windowKey}`;

    const requestData = this.requestCounts.get(requestKey);
    if (!requestData) {
      return true;
    }

    // Check if window has expired
    if (now >= requestData.resetTime) {
      this.requestCounts.delete(requestKey);
      return true;
    }

    // Check against limits
    if (requestData.count >= this.rateLimitConfig.maxRequests) {
      return false;
    }

    // Check global rate limit if set
    if (this.globalRateLimit && this.globalRateLimit.remaining <= 0) {
      if (this.globalRateLimit.resetTime && now < this.globalRateLimit.resetTime) {
        return false;
      }
    }

    return true;
  }

  /**
   * Record a request
   * @param identifier - Request identifier
   */
  recordRequest(identifier: string = 'global'): void {
    const now = new Date();
    const windowKey = this.getWindowKey(now);
    const requestKey = `${identifier}:${windowKey}`;

    const existingData = this.requestCounts.get(requestKey);
    if (existingData) {
      existingData.count++;
    } else {
      this.requestCounts.set(requestKey, {
        count: 1,
        resetTime: new Date(now.getTime() + this.rateLimitConfig.windowMs),
      });
    }

    // Update global rate limit if tracking
    if (this.globalRateLimit) {
      this.globalRateLimit.remaining = Math.max(0, this.globalRateLimit.remaining - 1);
    }
  }

  /**
   * Update rate limit information from server response
   * @param remaining - Requests remaining
   * @param resetTime - Reset time
   */
  updateRateLimit(remaining: number, resetTime?: Date): void {
    this.globalRateLimit = {
      remaining,
      resetTime,
    };
  }

  /**
   * Parse rate limit from error or response
   * @param text - Text to parse
   * @returns Rate limit information or null
   */
  parseRateLimitFromText(text: string): { remaining: number; resetTime?: Date } | null {
    for (const pattern of PROGRESS_PATTERNS.RATE_LIMITS) {
      const match = text.match(pattern);
      if (match) {
        // Extract time information
        const timeInfo = this.extractTimeFromMatch(match);
        return {
          remaining: 0, // Assume rate limited
          resetTime: timeInfo,
        };
      }
    }
    return null;
  }

  /**
   * Get time until next request is allowed
   * @param identifier - Request identifier
   * @returns Milliseconds until next request allowed
   */
  getTimeUntilAllowed(identifier: string = 'global'): number {
    const now = new Date();

    // Check global rate limit
    if (this.globalRateLimit?.resetTime && this.globalRateLimit.remaining <= 0) {
      return Math.max(0, this.globalRateLimit.resetTime.getTime() - now.getTime());
    }

    // Check per-identifier limits
    const windowKey = this.getWindowKey(now);
    const requestKey = `${identifier}:${windowKey}`;
    const requestData = this.requestCounts.get(requestKey);

    if (requestData && requestData.count >= this.rateLimitConfig.maxRequests) {
      return Math.max(0, requestData.resetTime.getTime() - now.getTime());
    }

    return 0;
  }

  /**
   * Get window key for time-based bucketing
   * @param date - Date to get window for
   * @returns Window key string
   */
  private getWindowKey(date: Date): string {
    const windowStart = Math.floor(date.getTime() / this.rateLimitConfig.windowMs) * this.rateLimitConfig.windowMs;
    return windowStart.toString();
  }

  /**
   * Extract time information from regex match
   * @param match - Regex match array
   * @returns Parsed Date or undefined
   */
  private extractTimeFromMatch(match: RegExpMatchArray): Date | undefined {
    try {
      // This is a simplified parser - could be enhanced based on actual patterns
      const timeStr = match[1];
      const period = match[2];

      if (timeStr && period) {
        const hour = parseInt(timeStr, 10);
        if (!isNaN(hour)) {
          const resetTime = new Date();
          let adjustedHour = hour;

          if (period.toLowerCase().includes('pm') && hour < 12) {
            adjustedHour += 12;
          } else if (period.toLowerCase().includes('am') && hour === 12) {
            adjustedHour = 0;
          }

          resetTime.setHours(adjustedHour, 0, 0, 0);
          if (resetTime <= new Date()) {
            resetTime.setDate(resetTime.getDate() + 1);
          }

          return resetTime;
        }
      }
    } catch {
      // Ignore parsing errors
    }
    return undefined;
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): void {
    const now = new Date();
    for (const [key, data] of this.requestCounts.entries()) {
      if (now >= data.resetTime) {
        this.requestCounts.delete(key);
      }
    }
  }

  /**
   * Get current rate limit status
   * @returns Rate limit status
   */
  getStatus(): {
    globalRemaining: number;
    globalResetTime?: Date;
    activeWindows: number;
  } {
    this.cleanup();
    return {
      globalRemaining: this.globalRateLimit?.remaining ?? -1,
      globalResetTime: this.globalRateLimit?.resetTime,
      activeWindows: this.requestCounts.size,
    };
  }

  /**
   * Reset all rate limit data
   */
  reset(): void {
    this.requestCounts.clear();
    this.globalRateLimit = null;
  }
}

/**
 * Subagent mapper for handling tool name mapping and validation
 */
export class SubagentMapperImpl implements SubagentMapper {
  readonly mapping: Readonly<Record<SubagentType, string>>;
  readonly aliases: Readonly<Record<string, SubagentType>>;
  readonly modelValidation: Readonly<Record<SubagentType, any>>;
  readonly defaults: Readonly<Record<SubagentType, any>>;

  constructor() {
    this.mapping = SUBAGENT_TOOL_MAPPING;
    this.aliases = SUBAGENT_ALIASES;

    // Define model validation rules
    this.modelValidation = {
      claude: {
        allowedModels: ['sonnet-4', 'sonnet-3.5', 'haiku-3', 'opus-3'],
        defaultModel: 'sonnet-4',
      },
      cursor: {
        allowedModels: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
        defaultModel: 'gpt-4',
      },
      codex: {
        allowedModels: ['code-davinci-002', 'code-cushman-001'],
        defaultModel: 'code-davinci-002',
      },
      gemini: {
        allowedModels: ['gemini-pro', 'gemini-pro-vision', 'gemini-ultra'],
        defaultModel: 'gemini-pro',
      },
    } as const;

    // Define default configurations
    this.defaults = {
      claude: {
        timeout: 60000,
        model: 'sonnet-4',
        arguments: {},
        priority: 'normal' as const,
      },
      cursor: {
        timeout: 45000,
        model: 'gpt-4',
        arguments: {},
        priority: 'normal' as const,
      },
      codex: {
        timeout: 30000,
        model: 'code-davinci-002',
        arguments: {},
        priority: 'normal' as const,
      },
      gemini: {
        timeout: 45000,
        model: 'gemini-pro',
        arguments: {},
        priority: 'normal' as const,
      },
    } as const;
  }

  /**
   * Map subagent name to MCP tool name
   * @param subagent - Subagent type or alias
   * @returns MCP tool name
   */
  mapToToolName(subagent: string): string {
    // Check if it's a direct subagent type
    if (subagent in this.mapping) {
      return this.mapping[subagent as SubagentType];
    }

    // Check aliases
    const mappedSubagent = this.aliases[subagent];
    if (mappedSubagent) {
      return this.mapping[mappedSubagent];
    }

    throw new MCPValidationError(
      `Unknown subagent: ${subagent}`,
      'subagent_mapping',
      subagent,
      `One of: ${Object.keys(this.mapping).concat(Object.keys(this.aliases)).join(', ')}`
    );
  }

  /**
   * Validate model for subagent
   * @param subagent - Subagent type
   * @param model - Model name
   * @returns True if valid
   */
  validateModel(subagent: SubagentType, model: string): boolean {
    const validation = this.modelValidation[subagent];
    if (!validation) {
      return false;
    }

    if (validation.customValidator) {
      return validation.customValidator(model);
    }

    return validation.allowedModels.includes(model);
  }

  /**
   * Get default model for subagent
   * @param subagent - Subagent type
   * @returns Default model name
   */
  getDefaultModel(subagent: SubagentType): string {
    return this.modelValidation[subagent]?.defaultModel || 'default';
  }

  /**
   * Get default configuration for subagent
   * @param subagent - Subagent type
   * @returns Default configuration
   */
  getDefaults(subagent: SubagentType): any {
    return this.defaults[subagent] || {};
  }

  /**
   * Get all available subagent types
   * @returns Array of subagent types
   */
  getAvailableSubagents(): SubagentType[] {
    return Object.keys(this.mapping) as SubagentType[];
  }

  /**
   * Get all available aliases
   * @returns Array of alias names
   */
  getAvailableAliases(): string[] {
    return Object.keys(this.aliases);
  }
}

/**
 * Progress callback manager for handling multiple progress callbacks
 */
export class ProgressCallbackManager {
  private callbacks: Set<ProgressCallback> = new Set();
  private errorCallbacks: Set<(error: Error) => void> = new Set();

  /**
   * Add a progress callback
   * @param callback - Progress callback function
   * @returns Unsubscribe function
   */
  addCallback(callback: ProgressCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /**
   * Add an error callback for callback execution errors
   * @param callback - Error callback function
   * @returns Unsubscribe function
   */
  addErrorCallback(callback: (error: Error) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  /**
   * Emit progress event to all callbacks
   * @param event - Progress event to emit
   */
  async emitProgress(event: ProgressEvent): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const callback of this.callbacks) {
      promises.push(this.safeExecuteCallback(callback, event));
    }

    // Wait for all callbacks to complete (or fail safely)
    await Promise.allSettled(promises);
  }

  /**
   * Safely execute a callback, catching and reporting errors
   * @param callback - Callback to execute
   * @param event - Progress event
   */
  private async safeExecuteCallback(callback: ProgressCallback, event: ProgressEvent): Promise<void> {
    try {
      const result = callback(event);
      if (result instanceof Promise) {
        await result;
      }
    } catch (error) {
      // Emit error to error callbacks
      for (const errorCallback of this.errorCallbacks) {
        try {
          errorCallback(error as Error);
        } catch {
          // Ignore errors in error callbacks to prevent infinite loops
        }
      }
    }
  }

  /**
   * Get number of registered callbacks
   * @returns Number of callbacks
   */
  getCallbackCount(): number {
    return this.callbacks.size;
  }

  /**
   * Clear all callbacks
   */
  clear(): void {
    this.callbacks.clear();
    this.errorCallbacks.clear();
  }
}

/**
 * Session context manager for tracking session state and context
 */
export class SessionContextManager {
  private sessions: Map<string, MCPSessionContext> = new Map();
  private activeToolCalls: Map<string, Set<string>> = new Map();

  /**
   * Create a new session context
   * @param sessionId - Session identifier
   * @param userId - User identifier (optional)
   * @param metadata - Session metadata
   * @returns Created session context
   */
  createSession(
    sessionId: string,
    userId?: string,
    metadata: Record<string, unknown> = {}
  ): MCPSessionContext {
    const context: MCPSessionContext = {
      sessionId,
      startTime: new Date(),
      userId,
      metadata,
      activeToolCalls: [],
      state: SessionState.INITIALIZING,
      lastActivity: new Date(),
    };

    this.sessions.set(sessionId, context);
    this.activeToolCalls.set(sessionId, new Set());

    return context;
  }

  /**
   * Update session state
   * @param sessionId - Session identifier
   * @param state - New session state
   */
  updateSessionState(sessionId: string, state: SessionState): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = state;
      session.lastActivity = new Date();
    }
  }

  /**
   * Add active tool call to session
   * @param sessionId - Session identifier
   * @param toolCallId - Tool call identifier
   */
  addActiveToolCall(sessionId: string, toolCallId: string): void {
    const session = this.sessions.get(sessionId);
    const activeSet = this.activeToolCalls.get(sessionId);

    if (session && activeSet) {
      activeSet.add(toolCallId);
      session.activeToolCalls = Array.from(activeSet);
      session.lastActivity = new Date();
    }
  }

  /**
   * Remove active tool call from session
   * @param sessionId - Session identifier
   * @param toolCallId - Tool call identifier
   */
  removeActiveToolCall(sessionId: string, toolCallId: string): void {
    const session = this.sessions.get(sessionId);
    const activeSet = this.activeToolCalls.get(sessionId);

    if (session && activeSet) {
      activeSet.delete(toolCallId);
      session.activeToolCalls = Array.from(activeSet);
      session.lastActivity = new Date();
    }
  }

  /**
   * Get session context
   * @param sessionId - Session identifier
   * @returns Session context or undefined
   */
  getSession(sessionId: string): MCPSessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update session metadata
   * @param sessionId - Session identifier
   * @param metadata - Metadata to merge
   */
  updateSessionMetadata(sessionId: string, metadata: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata = { ...session.metadata, ...metadata };
      session.lastActivity = new Date();
    }
  }

  /**
   * End session
   * @param sessionId - Session identifier
   */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = SessionState.COMPLETED;
      session.lastActivity = new Date();
    }
  }

  /**
   * Cleanup expired sessions
   * @param maxAge - Maximum age in milliseconds
   */
  cleanupExpiredSessions(maxAge: number = 24 * 60 * 60 * 1000): void {
    const cutoff = new Date(Date.now() - maxAge);

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.lastActivity < cutoff) {
        this.sessions.delete(sessionId);
        this.activeToolCalls.delete(sessionId);
      }
    }
  }

  /**
   * Get all active sessions
   * @returns Array of active session contexts
   */
  getActiveSessions(): MCPSessionContext[] {
    return Array.from(this.sessions.values()).filter(
      session => session.state === SessionState.ACTIVE
    );
  }

  /**
   * Get session statistics
   * @returns Session statistics
   */
  getStatistics(): {
    totalSessions: number;
    activeSessions: number;
    idleSessions: number;
    completedSessions: number;
    totalActiveToolCalls: number;
  } {
    const sessions = Array.from(this.sessions.values());

    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.state === SessionState.ACTIVE).length,
      idleSessions: sessions.filter(s => s.state === SessionState.IDLE).length,
      completedSessions: sessions.filter(s => s.state === SessionState.COMPLETED).length,
      totalActiveToolCalls: Array.from(this.activeToolCalls.values())
        .reduce((sum, set) => sum + set.size, 0),
    };
  }
}

/**
 * Comprehensive MCP Client implementation for juno-task-ts
 *
 * This is the main MCP client class that integrates all the supporting components
 * to provide a complete MCP client solution with connection management, retry logic,
 * progress callbacks, session tracking, error handling, and metrics integration.
 */
export class MCPClient extends EventEmitter implements MCPEventEmitter {
  private config: MCPServerConfig;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private serverProcess: ChildProcess | null = null;
  private connectionState: MCPConnectionState = MCPConnectionState.DISCONNECTED;
  private connectionHealth: ConnectionHealth;
  private retryManager: ConnectionRetryManager;
  private rateLimitMonitor: RateLimitMonitor;
  private subagentMapper: SubagentMapperImpl;
  private progressCallbackManager: ProgressCallbackManager;
  private sessionContextManager: SessionContextManager;
  private metricsCollector?: MetricsCollector;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isDisposed: boolean = false;

  constructor(
    config: MCPServerConfig,
    metricsCollector?: MetricsCollector
  ) {
    super();

    this.config = {
      timeout: MCP_DEFAULTS.TIMEOUT,
      retries: MCP_DEFAULTS.RETRIES,
      retryDelay: MCP_DEFAULTS.RETRY_DELAY,
      workingDirectory: process.cwd(),
      ...config,
    };

    this.metricsCollector = metricsCollector;

    // Initialize supporting components
    this.retryManager = new ConnectionRetryManager({
      maxRetries: this.config.retries,
      initialDelay: this.config.retryDelay,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitterFactor: 0.1,
    });

    this.rateLimitMonitor = new RateLimitMonitor({
      maxRequests: 100,
      windowMs: 60000,
      adaptive: true,
      burstAllowance: 10,
    });

    this.subagentMapper = new SubagentMapperImpl();
    this.progressCallbackManager = new ProgressCallbackManager();
    this.sessionContextManager = new SessionContextManager();

    // Initialize connection health
    this.connectionHealth = {
      state: MCPConnectionState.DISCONNECTED,
      uptime: 0,
      successfulOperations: 0,
      failedOperations: 0,
      avgResponseTime: 0,
      errorStreak: 0,
    };

    // Set up error handling for progress callbacks
    this.progressCallbackManager.addErrorCallback((error) => {
      this.emit('progress:error', error);
    });
  }

  /**
   * Connect to MCP server
   * @returns Promise that resolves when connection is established
   */
  async connect(): Promise<void> {
    if (this.isDisposed) {
      throw new MCPConnectionError('Client has been disposed', 'client_disposed');
    }

    if (this.connectionState === MCPConnectionState.CONNECTED) {
      return; // Already connected
    }

    if (this.connectionState === MCPConnectionState.CONNECTING) {
      throw new MCPConnectionError('Connection already in progress', 'connection_in_progress');
    }

    await this.retryManager.executeWithRetry(
      async () => this.performConnection(),
      'MCP connection'
    );
  }

  /**
   * Perform the actual connection to MCP server
   * @private
   */
  private async performConnection(): Promise<void> {
    this.updateConnectionState(MCPConnectionState.CONNECTING);
    const startTime = performance.now();

    try {
      // Discover server path if not provided
      const serverPath = await ServerPathDiscovery.discoverServerPath(this.config.serverPath);

      // Validate server path
      const serverInfo = await ServerPathDiscovery.getServerInfo(serverPath);
      if (!serverInfo.exists || !serverInfo.executable) {
        throw new MCPConnectionError(
          `Server at ${serverPath} is not executable`,
          'server_not_executable',
          { path: serverPath, status: 'invalid' }
        );
      }

      // Start server process
      await this.startServerProcess(serverPath);

      // Create MCP client and transport
      await this.createMCPClient();

      // Initialize connection
      await this.initializeConnection();

      // Update connection state and health
      this.updateConnectionState(MCPConnectionState.CONNECTED);
      const connectionTime = performance.now() - startTime;

      this.connectionHealth = {
        ...this.connectionHealth,
        state: MCPConnectionState.CONNECTED,
        uptime: 0,
        errorStreak: 0,
      };

      // Record connection success
      this.metricsCollector?.recordPerformanceTiming('mcp_connection', connectionTime, {
        serverPath,
        success: true,
      });

      // Start health monitoring
      this.startHealthMonitoring();

      this.emit('connection:state', MCPConnectionState.CONNECTED);

    } catch (error) {
      this.updateConnectionState(MCPConnectionState.FAILED);
      this.connectionHealth.errorStreak++;
      this.connectionHealth.failedOperations++;

      const connectionError = error instanceof MCPError
        ? error
        : new MCPConnectionError(
            `Failed to connect to MCP server: ${error}`,
            'connection_failed'
          );

      this.emit('connection:error', connectionError);
      throw connectionError;
    }
  }

  /**
   * Start MCP server process
   * @param serverPath - Path to server executable
   * @private
   */
  private async startServerProcess(serverPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const serverArgs = this.config.serverArgs || [];
      const processOptions = {
        cwd: this.config.workingDirectory,
        env: {
          ...process.env,
          ...this.config.environment,
        },
        stdio: ['pipe', 'pipe', 'pipe'] as const,
      };

      // Determine command based on file extension
      let command = serverPath;
      let args = serverArgs;

      if (serverPath.endsWith('.py')) {
        command = 'python';
        args = [serverPath, ...serverArgs];
      }

      this.serverProcess = spawn(command, args, processOptions);

      // Handle process events
      this.serverProcess.on('error', (error) => {
        reject(new MCPConnectionError(
          `Failed to start server process: ${error.message}`,
          'process_start_failed',
          undefined,
          { cause: error }
        ));
      });

      this.serverProcess.on('exit', (code, signal) => {
        if (this.connectionState === MCPConnectionState.CONNECTED) {
          this.handleUnexpectedDisconnection(code, signal);
        }
      });

      // Set up stderr monitoring for errors
      if (this.serverProcess.stderr) {
        this.serverProcess.stderr.on('data', (data) => {
          const errorText = data.toString();
          if (this.config.debug) {
            console.error('MCP Server stderr:', errorText);
          }

          // Check for rate limit information
          const rateLimitInfo = this.rateLimitMonitor.parseRateLimitFromText(errorText);
          if (rateLimitInfo) {
            this.rateLimitMonitor.updateRateLimit(
              rateLimitInfo.remaining,
              rateLimitInfo.resetTime
            );
          }
        });
      }

      // Wait a moment for process to start
      setTimeout(() => {
        if (this.serverProcess && !this.serverProcess.killed) {
          resolve();
        } else {
          reject(new MCPConnectionError(
            'Server process failed to start',
            'process_failed'
          ));
        }
      }, 1000);
    });
  }

  /**
   * Create MCP client and transport
   * @private
   */
  private async createMCPClient(): Promise<void> {
    if (!this.serverProcess) {
      throw new MCPConnectionError('Server process not started', 'no_process');
    }

    // Create stdio transport
    this.transport = new StdioClientTransport({
      spawn: () => this.serverProcess!,
      stderr: this.config.debug ? 'inherit' : 'pipe',
    });

    // Create MCP client
    this.client = new Client(
      {
        name: 'juno-task-ts',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
      }
    );
  }

  /**
   * Initialize MCP connection
   * @private
   */
  private async initializeConnection(): Promise<void> {
    if (!this.client || !this.transport) {
      throw new MCPConnectionError('Client or transport not created', 'initialization_failed');
    }

    // Connect with timeout
    const connectPromise = this.client.connect(this.transport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new MCPTimeoutError(
          'Connection timeout',
          this.config.timeout,
          'connection'
        ));
      }, this.config.timeout);
    });

    await Promise.race([connectPromise, timeoutPromise]);
  }

  /**
   * Update connection state and emit events
   * @param newState - New connection state
   * @private
   */
  private updateConnectionState(newState: MCPConnectionState): void {
    const oldState = this.connectionState;
    this.connectionState = newState;
    this.connectionHealth.state = newState;

    const event: ConnectionEvent = {
      type: this.mapStateToEventType(newState),
      timestamp: new Date(),
      state: newState,
    };

    this.emit('connection:state', newState);

    if (this.config.debug) {
      console.log(`MCP connection state: ${oldState} -> ${newState}`);
    }
  }

  /**
   * Map connection state to event type
   * @param state - Connection state
   * @returns Connection event type
   * @private
   */
  private mapStateToEventType(state: MCPConnectionState): ConnectionEventType {
    switch (state) {
      case MCPConnectionState.CONNECTING:
        return ConnectionEventType.CONNECTING;
      case MCPConnectionState.CONNECTED:
        return ConnectionEventType.CONNECTED;
      case MCPConnectionState.DISCONNECTED:
        return ConnectionEventType.DISCONNECTED;
      case MCPConnectionState.RECONNECTING:
        return ConnectionEventType.RECONNECTING;
      case MCPConnectionState.FAILED:
        return ConnectionEventType.ERROR;
      default:
        return ConnectionEventType.ERROR;
    }
  }

  /**
   * Handle unexpected disconnection
   * @param code - Exit code
   * @param signal - Exit signal
   * @private
   */
  private handleUnexpectedDisconnection(code: number | null, signal: NodeJS.Signals | null): void {
    this.updateConnectionState(MCPConnectionState.DISCONNECTED);

    const error = new MCPConnectionError(
      `Server process exited unexpectedly (code: ${code}, signal: ${signal})`,
      'unexpected_disconnection'
    );

    this.emit('connection:error', error);

    // Attempt reconnection if not disposed
    if (!this.isDisposed) {
      this.scheduleReconnection();
    }
  }

  /**
   * Schedule reconnection attempt
   * @private
   */
  private scheduleReconnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = this.retryManager.getRetryInfo().currentAttempt * 5000; // Progressive delay

    this.reconnectTimer = setTimeout(async () => {
      try {
        this.updateConnectionState(MCPConnectionState.RECONNECTING);
        await this.connect();
      } catch (error) {
        if (this.config.debug) {
          console.error('Reconnection failed:', error);
        }
      }
    }, delay);
  }

  /**
   * Start health monitoring
   * @private
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      this.updateHealthMetrics();
    }, 60000); // Check every minute
  }

  /**
   * Update health metrics
   * @private
   */
  private updateHealthMetrics(): void {
    if (this.connectionState === MCPConnectionState.CONNECTED) {
      this.connectionHealth.uptime += 60000; // Add 1 minute
    }

    // Cleanup expired sessions
    this.sessionContextManager.cleanupExpiredSessions();

    // Cleanup rate limit data
    this.rateLimitMonitor.cleanup();
  }

  /**
   * Disconnect from MCP server
   * @returns Promise that resolves when disconnected
   */
  async disconnect(): Promise<void> {
    if (this.connectionState === MCPConnectionState.DISCONNECTED) {
      return; // Already disconnected
    }

    this.updateConnectionState(MCPConnectionState.CLOSING);

    try {
      // Stop health monitoring
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }

      // Cancel reconnection timer
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Close MCP client
      if (this.client) {
        await this.client.close();
        this.client = null;
      }

      // Close transport
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }

      // Terminate server process
      if (this.serverProcess && !this.serverProcess.killed) {
        this.serverProcess.kill('SIGTERM');

        // Force kill after timeout
        setTimeout(() => {
          if (this.serverProcess && !this.serverProcess.killed) {
            this.serverProcess.kill('SIGKILL');
          }
        }, 5000);

        this.serverProcess = null;
      }

      this.updateConnectionState(MCPConnectionState.DISCONNECTED);

    } catch (error) {
      const disconnectError = new MCPConnectionError(
        `Error during disconnection: ${error}`,
        'disconnection_error'
      );

      this.emit('connection:error', disconnectError);
      throw disconnectError;
    }
  }

  /**
   * Check if client is connected
   * @returns True if connected
   */
  isConnected(): boolean {
    return this.connectionState === MCPConnectionState.CONNECTED;
  }

  /**
   * Call a tool with comprehensive error handling and progress tracking
   * @param request - Tool call request
   * @returns Promise resolving to tool call result
   */
  async callTool(request: ToolCallRequest): Promise<ToolCallResult> {
    if (!this.isConnected()) {
      throw new MCPConnectionError('Not connected to MCP server', 'not_connected');
    }

    if (!this.client) {
      throw new MCPConnectionError('MCP client not initialized', 'client_not_initialized');
    }

    // Generate unique request ID
    const requestId = request.requestId || uuidv4();
    const startTime = new Date();
    const performanceStart = performance.now();

    // Validate request
    this.validateToolCallRequest(request);

    // Check rate limits
    if (!this.rateLimitMonitor.isRequestAllowed(request.toolName)) {
      const waitTime = this.rateLimitMonitor.getTimeUntilAllowed(request.toolName);
      throw new MCPRateLimitError(
        `Rate limit exceeded for ${request.toolName}. Wait ${Math.ceil(waitTime / 1000)} seconds.`,
        0,
        new Date(Date.now() + waitTime),
        'tool_rate_limit'
      );
    }

    // Record rate limit usage
    this.rateLimitMonitor.recordRequest(request.toolName);

    // Create progress parser
    const sessionId = (request.metadata?.sessionId as string) || uuidv4();
    const progressParser = new ProgressEventParser(sessionId);
    const progressEvents: ProgressEvent[] = [];

    // Add to session context
    this.sessionContextManager.addActiveToolCall(sessionId, requestId);

    try {
      // Emit tool start event
      this.emit('tool:start', request);

      // Execute tool call with timeout
      const mcpRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: request.toolName,
          arguments: request.arguments,
        },
      };

      const timeout = request.timeout || this.config.timeout;
      const resultPromise = this.client.request(mcpRequest);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new MCPTimeoutError(
            `Tool call timeout after ${timeout}ms`,
            timeout,
            'tool_call'
          ));
        }, timeout);
      });

      const mcpResult = await Promise.race([resultPromise, timeoutPromise]) as CallToolResult;

      // Process result
      const endTime = new Date();
      const duration = performance.now() - performanceStart;

      // Parse progress from result content if it contains progress text
      if (mcpResult.content && Array.isArray(mcpResult.content)) {
        for (const contentItem of mcpResult.content) {
          if (contentItem.type === 'text' && contentItem.text) {
            const events = progressParser.parseProgressText(contentItem.text);
            progressEvents.push(...events);

            // Emit progress events
            for (const event of events) {
              this.progressCallbackManager.emitProgress(event);
              this.emit('progress:event', event);
            }
          }
        }
      }

      // Create tool call result
      const result: ToolCallResult = {
        content: this.extractContentFromMCPResult(mcpResult),
        status: ToolExecutionStatus.COMPLETED,
        startTime,
        endTime,
        duration,
        progressEvents,
        request,
        metadata: {
          requestId,
          sessionId,
          performanceMetrics: {
            cpuUsage: 0, // Would need OS-specific implementation
            memoryUsage: process.memoryUsage().heapUsed,
            networkUsage: 0,
            timingBreakdown: {
              total: duration,
              network: 0,
              processing: duration,
            },
          },
        },
      };

      // Update connection health
      this.connectionHealth.successfulOperations++;
      this.connectionHealth.errorStreak = 0;
      this.updateAverageResponseTime(duration);

      // Record metrics
      this.recordToolCallMetrics(request, result, true);

      // Emit completion event
      this.emit('tool:complete', result);

      return result;

    } catch (error) {
      const endTime = new Date();
      const duration = performance.now() - performanceStart;

      // Update connection health
      this.connectionHealth.failedOperations++;
      this.connectionHealth.errorStreak++;

      // Handle specific error types
      let toolError: MCPToolError;

      if (error instanceof MCPError) {
        toolError = error instanceof MCPToolError
          ? error
          : new MCPToolError(
              error.message,
              {
                name: request.toolName,
                subagent: this.getSubagentFromToolName(request.toolName),
              },
              error.context,
              { executionDetails: {
                startTime,
                duration,
                arguments: request.arguments,
                progressEvents,
              }}
            );
      } else {
        toolError = new MCPToolError(
          `Tool execution failed: ${error}`,
          {
            name: request.toolName,
            subagent: this.getSubagentFromToolName(request.toolName),
          },
          'tool_execution',
          {
            cause: error as Error,
            executionDetails: {
              startTime,
              duration,
              arguments: request.arguments,
              progressEvents,
            },
          }
        );
      }

      // Create error result
      const errorResult: ToolCallResult = {
        content: '',
        status: ToolExecutionStatus.FAILED,
        startTime,
        endTime,
        duration,
        error: toolError,
        progressEvents,
        request,
        metadata: {
          requestId,
          sessionId,
        },
      };

      // Record error metrics
      this.recordToolCallMetrics(request, errorResult, false);

      // Emit error event
      this.emit('tool:error', toolError);

      throw toolError;

    } finally {
      // Remove from session context
      this.sessionContextManager.removeActiveToolCall(sessionId, requestId);
    }
  }

  /**
   * Extract content from MCP result
   * @param mcpResult - MCP call tool result
   * @returns Extracted content string
   * @private
   */
  private extractContentFromMCPResult(mcpResult: CallToolResult): string {
    if (!mcpResult.content || !Array.isArray(mcpResult.content)) {
      return '';
    }

    return mcpResult.content
      .map(item => {
        if (item.type === 'text') {
          return item.text || '';
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  /**
   * Get subagent type from tool name
   * @param toolName - MCP tool name
   * @returns Subagent type
   * @private
   */
  private getSubagentFromToolName(toolName: string): SubagentType {
    for (const [subagent, mappedToolName] of Object.entries(SUBAGENT_TOOL_MAPPING)) {
      if (mappedToolName === toolName) {
        return subagent as SubagentType;
      }
    }
    return 'claude'; // Default fallback
  }

  /**
   * Validate tool call request
   * @param request - Tool call request to validate
   * @private
   */
  private validateToolCallRequest(request: ToolCallRequest): void {
    if (!request.toolName) {
      throw new MCPValidationError(
        'Tool name is required',
        'missing_tool_name',
        request.toolName,
        'non-empty string'
      );
    }

    if (!request.arguments || typeof request.arguments !== 'object') {
      throw new MCPValidationError(
        'Tool arguments must be an object',
        'invalid_arguments',
        request.arguments,
        'object'
      );
    }

    if (request.timeout !== undefined && (request.timeout < 1000 || request.timeout > 3600000)) {
      throw new MCPValidationError(
        'Timeout must be between 1000ms and 3600000ms',
        'invalid_timeout',
        request.timeout,
        '1000-3600000'
      );
    }
  }

  /**
   * Record tool call metrics
   * @param request - Tool call request
   * @param result - Tool call result
   * @param success - Whether call was successful
   * @private
   */
  private recordToolCallMetrics(
    request: ToolCallRequest,
    result: ToolCallResult,
    success: boolean
  ): void {
    if (!this.metricsCollector) {
      return;
    }

    const sessionId = (request.metadata?.sessionId as string) || 'unknown';
    const subagent = this.getSubagentFromToolName(request.toolName);

    this.metricsCollector.recordToolCall({
      name: request.toolName,
      duration: result.duration,
      success,
      error: result.error?.message,
      parameters: request.arguments,
      resultPreview: success ? result.content.substring(0, 100) : undefined,
      sessionId,
      iteration: 1, // Would need to be tracked separately
      subagent,
    });
  }

  /**
   * Update average response time
   * @param duration - Response duration
   * @private
   */
  private updateAverageResponseTime(duration: number): void {
    const totalOps = this.connectionHealth.successfulOperations + this.connectionHealth.failedOperations;
    this.connectionHealth.avgResponseTime =
      (this.connectionHealth.avgResponseTime * (totalOps - 1) + duration) / totalOps;
  }

  /**
   * List available tools from MCP server
   * @returns Promise resolving to array of tool names
   */
  async listTools(): Promise<readonly string[]> {
    if (!this.isConnected() || !this.client) {
      throw new MCPConnectionError('Not connected to MCP server', 'not_connected');
    }

    try {
      const request: ListToolsRequest = {
        method: 'tools/list',
        params: {},
      };

      const result = await this.client.request(request) as ListToolsResult;

      return result.tools?.map(tool => tool.name) || [];

    } catch (error) {
      throw new MCPToolError(
        `Failed to list tools: ${error}`,
        { name: 'list_tools', subagent: 'claude' },
        'tool_list_failed',
        { cause: error as Error }
      );
    }
  }

  /**
   * Get subagent information
   * @param subagent - Subagent type
   * @returns Promise resolving to subagent information
   */
  async getSubagentInfo(subagent: SubagentType): Promise<SubagentInfo> {
    const toolName = this.subagentMapper.mapToToolName(subagent);
    const defaults = this.subagentMapper.getDefaults(subagent);
    const validation = this.subagentMapper.modelValidation[subagent];

    return {
      id: subagent,
      name: subagent.charAt(0).toUpperCase() + subagent.slice(1),
      capabilities: [], // Would be populated from actual server capabilities
      models: validation?.allowedModels || [],
      defaultModel: validation?.defaultModel || 'default',
      status: this.isConnected() ? 'available' : 'unavailable',
      performance: {
        avgResponseTime: this.connectionHealth.avgResponseTime,
        successRate: this.calculateSuccessRate(),
        loadLevel: 'low', // Would be calculated based on metrics
        qualityScore: 85, // Would be calculated based on metrics
      },
    };
  }

  /**
   * Calculate success rate from connection health
   * @returns Success rate (0-1)
   * @private
   */
  private calculateSuccessRate(): number {
    const total = this.connectionHealth.successfulOperations + this.connectionHealth.failedOperations;
    if (total === 0) return 1;
    return this.connectionHealth.successfulOperations / total;
  }

  /**
   * Add progress callback
   * @param callback - Progress callback function
   * @returns Unsubscribe function
   */
  onProgress(callback: ProgressCallback): () => void {
    return this.progressCallbackManager.addCallback(callback);
  }

  /**
   * Get connection health information
   * @returns Current connection health
   */
  getHealth(): ConnectionHealth {
    return { ...this.connectionHealth };
  }

  /**
   * Create a new session context
   * @param userId - User identifier (optional)
   * @param metadata - Session metadata
   * @returns Created session context
   */
  createSession(userId?: string, metadata: Record<string, unknown> = {}): MCPSessionContext {
    const sessionId = uuidv4();
    return this.sessionContextManager.createSession(sessionId, userId, metadata);
  }

  /**
   * Get session context
   * @param sessionId - Session identifier
   * @returns Session context or undefined
   */
  getSession(sessionId: string): MCPSessionContext | undefined {
    return this.sessionContextManager.getSession(sessionId);
  }

  /**
   * Update session state
   * @param sessionId - Session identifier
   * @param state - New session state
   */
  updateSessionState(sessionId: string, state: SessionState): void {
    this.sessionContextManager.updateSessionState(sessionId, state);
  }

  /**
   * End session
   * @param sessionId - Session identifier
   */
  endSession(sessionId: string): void {
    this.sessionContextManager.endSession(sessionId);
  }

  /**
   * Get rate limit status
   * @returns Current rate limit status
   */
  getRateLimitStatus(): {
    globalRemaining: number;
    globalResetTime?: Date;
    activeWindows: number;
  } {
    return this.rateLimitMonitor.getStatus();
  }

  /**
   * Get subagent mapper
   * @returns Subagent mapper instance
   */
  getSubagentMapper(): SubagentMapperImpl {
    return this.subagentMapper;
  }

  /**
   * Get session statistics
   * @returns Session statistics
   */
  getSessionStatistics(): {
    totalSessions: number;
    activeSessions: number;
    idleSessions: number;
    completedSessions: number;
    totalActiveToolCalls: number;
  } {
    return this.sessionContextManager.getStatistics();
  }

  /**
   * Dispose of client and cleanup resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;

    // Disconnect if connected
    if (this.isConnected()) {
      this.disconnect().catch(error => {
        if (this.config.debug) {
          console.error('Error during disposal disconnect:', error);
        }
      });
    }

    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Clear callbacks and sessions
    this.progressCallbackManager.clear();
    this.sessionContextManager.cleanupExpiredSessions(0); // Cleanup all

    // Reset retry manager
    this.retryManager.reset();

    // Reset rate limit monitor
    this.rateLimitMonitor.reset();

    // Remove all event listeners
    this.removeAllListeners();
  }

  // Event emitter interface implementation
  on<T extends keyof MCPEventMap>(event: T, listener: MCPEventMap[T]): void {
    super.on(event, listener as (...args: any[]) => void);
  }

  off<T extends keyof MCPEventMap>(event: T, listener: MCPEventMap[T]): void {
    super.off(event, listener as (...args: any[]) => void);
  }

  emit<T extends keyof MCPEventMap>(event: T, ...args: Parameters<MCPEventMap[T]>): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * Create an MCP client instance with configuration
 * Convenience factory function for creating configured MCP clients
 *
 * @param config - MCP server configuration
 * @param metricsCollector - Optional metrics collector for integration
 * @returns Configured MCP client instance
 *
 * @example
 * ```typescript
 * const client = createMCPClient({
 *   serverPath: './roundtable_mcp_server',
 *   timeout: 60000,
 *   retries: 3,
 *   workingDirectory: process.cwd(),
 * });
 *
 * await client.connect();
 *
 * const result = await client.callTool({
 *   toolName: 'claude_subagent',
 *   arguments: {
 *     instruction: 'Analyze this code',
 *     project_path: '/path/to/project'
 *   }
 * });
 *
 * await client.disconnect();
 * ```
 */
export function createMCPClient(
  config: MCPServerConfig,
  metricsCollector?: MetricsCollector
): MCPClient {
  return new MCPClient(config, metricsCollector);
}

// Export SubagentMapper alias for the already exported SubagentMapperImpl
export { SubagentMapperImpl as SubagentMapper };

// Re-export types for convenience
export type {
  MCPServerConfig,
  ToolCallRequest,
  ToolCallResult,
  ProgressEvent,
  ProgressCallback,
  MCPSessionContext,
  ConnectionHealth,
  SubagentInfo,
  MCPEventMap,
};