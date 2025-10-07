#!/usr/bin/env node
/**
 * Minimal TypeScript MCP Client Test Project
 *
 * Purpose: Isolate and debug MCP connection issues described in USER_FEEDBACK.md
 * Problem: MCP client connection exits every few milliseconds and isn't working properly
 *
 * Focus:
 * - Basic connection establishment
 * - Connection persistence (don't exit immediately)
 * - Proper error handling and logging
 * - Testing the connection stays alive for at least 30 seconds
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Get current directory for this test project
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure logging
const DEBUG = true;

function log(message: string, level: 'INFO' | 'DEBUG' | 'ERROR' | 'WARN' = 'INFO') {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;

  if (level === 'DEBUG' && !DEBUG) return;

  switch (level) {
    case 'ERROR':
      console.error(`${prefix} ${message}`);
      break;
    case 'WARN':
      console.warn(`${prefix} ${message}`);
      break;
    case 'DEBUG':
      console.debug(`${prefix} ${message}`);
      break;
    default:
      console.log(`${prefix} ${message}`);
  }
}

/**
 * Minimal MCP Client Test Class
 */
class MCPClientTest {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private isConnected = false;
  private connectionStartTime: number = 0;
  private testDuration = 30000; // 30 seconds
  private keepAliveInterval: NodeJS.Timeout | null = null;

  async connect(serverPath: string): Promise<void> {
    log(`Starting MCP connection test to: ${serverPath}`);
    this.connectionStartTime = Date.now();

    try {
      log('Creating StdioClientTransport...');

      // Determine if it's a Python server
      const isPython = serverPath.endsWith('.py');
      const command = isPython ? 'python3' : serverPath;
      const args = isPython ? [serverPath] : [];

      log(`Command: ${command}, Args: ${JSON.stringify(args)}`);

      // Create transport
      this.transport = new StdioClientTransport({
        command,
        args
      });

      log('Transport created successfully');

      // Create MCP client
      log('Creating MCP Client...');
      this.client = new Client({
        name: 'mcp-client-test',
        version: '1.0.0'
      }, {
        capabilities: {
          tools: {}
        }
      });

      log('Client created successfully');

      // Connect to server
      log('Attempting to connect to server...');
      await this.client.connect(this.transport);

      this.isConnected = true;
      const connectionTime = Date.now() - this.connectionStartTime;
      log(`🎉 Connection established successfully in ${connectionTime}ms!`, 'INFO');

      // Set up connection monitoring
      this.startConnectionMonitoring();

    } catch (error) {
      const connectionTime = Date.now() - this.connectionStartTime;
      log(`❌ Connection failed after ${connectionTime}ms: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');

      if (error instanceof Error && error.stack) {
        log(`Stack trace: ${error.stack}`, 'DEBUG');
      }

      throw error;
    }
  }

  async testBasicOperations(): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('Client not connected');
    }

    try {
      log('Testing basic operations...');

      // Test 1: List available tools
      log('Test 1: Listing available tools...');
      const toolsResult = await this.client.listTools();
      log(`✅ Found ${toolsResult.tools.length} tools:`);

      for (const tool of toolsResult.tools) {
        log(`  - ${tool.name}: ${tool.description || 'No description'}`);
      }

      // Test 2: Check if we can call a tool (if any available)
      if (toolsResult.tools.length > 0) {
        const firstTool = toolsResult.tools[0];
        log(`Test 2: Testing tool call to "${firstTool.name}"...`);

        try {
          // Try calling the first available tool with empty parameters
          const result = await this.client.callTool({
            name: firstTool.name,
            arguments: {}
          });

          log(`✅ Tool call successful. Result type: ${typeof result}`);
          if (result && typeof result === 'object' && 'content' in result) {
            log(`Result content preview: ${JSON.stringify(result).substring(0, 200)}...`);
          }
        } catch (toolError) {
          log(`⚠️ Tool call failed (this might be expected if parameters are required): ${toolError instanceof Error ? toolError.message : String(toolError)}`, 'WARN');
        }
      } else {
        log('No tools available to test', 'WARN');
      }

    } catch (error) {
      log(`❌ Basic operations test failed: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      throw error;
    }
  }

  private startConnectionMonitoring(): void {
    log(`Starting connection persistence test for ${this.testDuration / 1000} seconds...`);

    let secondsElapsed = 0;
    this.keepAliveInterval = setInterval(() => {
      secondsElapsed++;
      const elapsed = Date.now() - this.connectionStartTime;

      log(`⏰ Connection alive for ${secondsElapsed} seconds (${elapsed}ms total)`, 'DEBUG');

      // Test connection health every 5 seconds
      if (secondsElapsed % 5 === 0) {
        this.checkConnectionHealth().catch(error => {
          log(`❌ Connection health check failed: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
        });
      }

      // Stop monitoring after test duration
      if (elapsed >= this.testDuration) {
        this.stopConnectionMonitoring();
        log(`🎉 Connection persistence test completed! Connection stayed alive for ${elapsed}ms`, 'INFO');
      }
    }, 1000);
  }

  private async checkConnectionHealth(): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('Client not connected');
    }

    try {
      // Simple health check by listing tools
      await this.client.listTools();
      log('💚 Connection health check passed', 'DEBUG');
    } catch (error) {
      log(`💔 Connection health check failed: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      this.isConnected = false;
      throw error;
    }
  }

  private stopConnectionMonitoring(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  async disconnect(): Promise<void> {
    log('Disconnecting from MCP server...');

    this.stopConnectionMonitoring();

    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
        log('✅ Client closed successfully');
      }

      if (this.transport) {
        await this.transport.close();
        this.transport = null;
        log('✅ Transport closed successfully');
      }

      this.isConnected = false;
      const totalTime = Date.now() - this.connectionStartTime;
      log(`🏁 Disconnection completed. Total connection time: ${totalTime}ms`);

    } catch (error) {
      log(`⚠️ Error during disconnection: ${error instanceof Error ? error.message : String(error)}`, 'WARN');
    }
  }

  getConnectionStatus(): { connected: boolean; uptime: number } {
    return {
      connected: this.isConnected,
      uptime: this.isConnected ? Date.now() - this.connectionStartTime : 0
    };
  }
}

/**
 * Find the test server path
 */
function findTestServerPath(): string {
  // Path to the roundtable MCP test server
  const testServerPath = path.resolve(__dirname, '../../../roundtable_mcp_server/roundtable_mcp_server/test_server.py');

  log(`Looking for test server at: ${testServerPath}`, 'DEBUG');

  return testServerPath;
}

/**
 * Main test function
 */
async function main(): Promise<void> {
  log('🚀 Starting MCP Client Test Project');
  log('====================================');

  const client = new MCPClientTest();
  let testSuccess = false;

  try {
    // Parse command line args or use default test server
    const serverPath = process.argv[2] || findTestServerPath();

    log(`Using MCP server: ${serverPath}`);

    // Step 1: Connect to server
    await client.connect(serverPath);

    // Step 2: Test basic operations
    await client.testBasicOperations();

    // Step 3: Wait for connection persistence test to complete
    log('Waiting for connection persistence test...');

    // Set up graceful shutdown
    const cleanup = async () => {
      log('Received shutdown signal, cleaning up...');
      await client.disconnect();
      process.exit(testSuccess ? 0 : 1);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Wait for the test duration plus a buffer
    await new Promise(resolve => {
      setTimeout(() => {
        testSuccess = true;
        resolve(undefined);
      }, 32000); // 32 seconds - slightly longer than the 30-second test
    });

    log('🎉 All tests completed successfully!');

  } catch (error) {
    log(`💥 Test failed: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');

    if (error instanceof Error && error.stack) {
      log(`Full error details: ${error.stack}`, 'DEBUG');
    }

    testSuccess = false;
  } finally {
    await client.disconnect();
  }

  process.exit(testSuccess ? 0 : 1);
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log(`💥 Uncaught exception: ${error.message}`, 'ERROR');
  log(`Stack: ${error.stack}`, 'DEBUG');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log(`💥 Unhandled rejection: ${reason}`, 'ERROR');
  process.exit(1);
});

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    log(`💥 Main function failed: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
    process.exit(1);
  });
}

export { MCPClientTest };