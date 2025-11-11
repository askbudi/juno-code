/**
 * MCP Backend Implementation for juno-code
 *
 * Wraps the existing MCP client to conform to the Backend interface
 * Provides compatibility layer for the backend manager
 */

import type { Backend } from '../backend-manager.js';
import type { ToolCallRequest, ToolCallResult, ProgressCallback } from '../../mcp/types.js';
import { createMCPClient, createMCPClientFromConfig, type MCPClientOptions } from '../../mcp/client.js';
import type { JunoMCPClient } from '../../mcp/client.js';
import { engineLogger } from '../../cli/utils/advanced-logger.js';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * MCP backend configuration
 */
export interface MCPBackendConfig {
  /** MCP server name or path */
  serverName?: string;

  /** Working directory */
  workingDirectory: string;

  /** Connection timeout in milliseconds */
  timeout?: number;

  /** Number of retries for failed connections */
  retries?: number;

  /** Enable debug logging */
  debug?: boolean;

  /** Enable progress streaming */
  enableProgressStreaming?: boolean;

  /** Session ID for progress tracking */
  sessionId?: string;

  /** Additional environment variables */
  environment?: Record<string, string>;

  /** Additional MCP client options */
  additionalOptions?: Partial<MCPClientOptions>;
}

// =============================================================================
// MCP Backend Implementation
// =============================================================================

/**
 * MCP backend that wraps the existing MCP client
 */
export class MCPBackend implements Backend {
  readonly type = 'mcp' as const;
  readonly name = 'MCP (Model Context Protocol)';

  private config: MCPBackendConfig | null = null;
  private client: JunoMCPClient | null = null;
  private progressCallbacks: ProgressCallback[] = [];

  /**
   * Configure the MCP backend
   */
  configure(config: MCPBackendConfig): void {
    this.config = config;
  }

  /**
   * Initialize the MCP backend
   */
  async initialize(): Promise<void> {
    if (!this.config) {
      throw new Error('MCP backend not configured. Call configure() first.');
    }

    try {
      // Create MCP client options
      const clientOptions: MCPClientOptions = {
        serverName: this.config.serverName,
        workingDirectory: this.config.workingDirectory,
        timeout: this.config.timeout || 30000,
        retries: this.config.retries || 3,
        debug: this.config.debug || false,
        environment: this.config.environment,
        enableProgressStreaming: this.config.enableProgressStreaming !== false,
        sessionId: this.config.sessionId,
        ...this.config.additionalOptions
      };

      // Create MCP client using configuration or fallback to basic creation
      if (this.config.serverName && this.config.workingDirectory) {
        this.client = await createMCPClientFromConfig(
          this.config.serverName,
          this.config.workingDirectory,
          clientOptions
        );
      } else {
        this.client = createMCPClient(clientOptions);
      }

      // Set up progress callback forwarding
      this.client.onProgress(async (event) => {
        // Forward progress events to all registered callbacks
        for (const callback of this.progressCallbacks) {
          try {
            await callback(event);
          } catch (error) {
            // Don't break on callback errors
            if (this.config?.debug) {
              engineLogger.warn(`MCP progress callback error: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      });

      // Connect to MCP server
      await this.client.connect();

      if (this.config.debug) {
        engineLogger.info(`MCP backend initialized with server: ${this.config.serverName || 'default'}`);
      }

    } catch (error) {
      throw new Error(`Failed to initialize MCP backend: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Execute a tool call request using MCP client
   */
  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (!this.client) {
      throw new Error('MCP backend not initialized. Call initialize() first.');
    }

    try {
      // Execute the tool call using the MCP client
      const response = await this.client.callTool(request);

      // Convert MCP response to ToolCallResult format
      return {
        content: response.content,
        status: response.success ? 'completed' : 'failed',
        startTime: response.timestamp,
        endTime: response.timestamp,
        duration: response.duration,
        error: response.success ? undefined : {
          type: 'mcp_tool_call',
          message: response.content,
          timestamp: response.timestamp
        },
        progressEvents: [], // Progress events are handled via callbacks
        request
      };

    } catch (error) {
      // Re-throw with more context
      throw new Error(`MCP tool call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if MCP backend is available
   */
  async isAvailable(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      // Test connection by pinging
      return await this.client.ping();
    } catch (error) {
      if (this.config?.debug) {
        engineLogger.warn(`MCP backend availability check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
  }

  /**
   * Set progress callback
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.push(callback);
    return () => {
      const index = this.progressCallbacks.indexOf(callback);
      if (index !== -1) {
        this.progressCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Clean up MCP resources
   */
  async cleanup(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
        this.client.dispose();
      } catch (error) {
        if (this.config?.debug) {
          engineLogger.warn(`MCP cleanup error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.client = null;
    }

    this.progressCallbacks = [];
  }

  // =============================================================================
  // Additional MCP-specific Methods
  // =============================================================================

  /**
   * Get the underlying MCP client (for advanced usage)
   */
  getMCPClient(): JunoMCPClient | null {
    return this.client;
  }

  /**
   * List available tools from MCP server
   */
  async listTools(): Promise<any[]> {
    if (!this.client) {
      throw new Error('MCP backend not initialized');
    }

    return this.client.listTools();
  }

  /**
   * Get MCP server health information
   */
  getHealth(): any {
    if (!this.client) {
      return { state: 'not_initialized' };
    }

    return this.client.getHealth();
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): string {
    if (!this.client) {
      return 'not_initialized';
    }

    return this.client.getConnectionStatus();
  }

  /**
   * Get rate limit status
   */
  getRateLimitStatus(): any {
    if (!this.client) {
      return null;
    }

    return this.client.getRateLimitStatus();
  }
}