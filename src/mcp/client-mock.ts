/**
 * Mock MCP Client Implementation for juno-task-ts CLI
 *
 * This is a simplified mock implementation to make the CLI functional
 * without requiring the full MCP SDK installation.
 */

import type { MCPClient, MCPClientOptions, ToolCallRequest, ToolCallResponse } from './types.js';

/**
 * Mock MCP Client that simulates basic functionality
 */
export class MockMCPClient implements MCPClient {
  private options: MCPClientOptions;
  private connected: boolean = false;

  constructor(options: MCPClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.options.debug) {
      console.log('[MCP] Mock client connecting...');
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.options.debug) {
      console.log('[MCP] Mock client disconnecting...');
    }
    this.connected = false;
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    if (!this.connected) {
      throw new Error('MCP client not connected');
    }

    if (this.options.debug) {
      console.log(`[MCP] Mock tool call: ${request.toolName}`, request.parameters);
    }

    // Mock successful response
    return {
      toolId: request.toolName,
      content: `Mock response for tool: ${request.toolName}`,
      success: true,
      duration: 100,
      timestamp: new Date()
    };
  }

  async listTools(): Promise<string[]> {
    // Return mock tool list
    return ['mock_tool_1', 'mock_tool_2', 'file_operations'];
  }

  getConnectionStatus(): 'connected' | 'disconnected' | 'connecting' | 'error' {
    return this.connected ? 'connected' : 'disconnected';
  }

  async ping(): Promise<boolean> {
    return this.connected;
  }
}

/**
 * Create a mock MCP client instance
 */
export function createMCPClient(options: MCPClientOptions): MCPClient {
  return new MockMCPClient(options);
}

export default MockMCPClient;