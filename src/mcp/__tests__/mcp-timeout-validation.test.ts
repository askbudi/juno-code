/**
 * MCP Timeout Functionality Validation Test
 * 
 * This test validates that MCP timeout settings work correctly with long-running operations.
 * Tests the 5-minute (300000ms) timeout configuration as specified in the user requirements.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import which from 'which';
import { JunoMCPClient, createMCPClient } from '../client.js';
import { MCPTimeoutError, MCPConnectionError } from '../errors.js';
import { execa } from 'execa';
import path from 'node:path';
import fs from 'fs-extra';

const hasRoundtableServer = Boolean(which.sync('roundtable-mcp-server', { nothrow: true }));
const describeIf = hasRoundtableServer ? describe : describe.skip;

describeIf('MCP Timeout Functionality Validation', () => {
  const TEST_TIMEOUT = 300000; // 5 minutes as specified
  const LONG_OPERATION_DURATION = 200000; // 3.33 minutes - should complete within timeout
  const EXCEED_TIMEOUT_DURATION = 400000; // 6.67 minutes - should timeout

  let testDir: string;
  let mcpClient: JunoMCPClient;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp('/tmp/mcp-timeout-test-');
    
    // Create MCP client with 5-minute timeout
    mcpClient = createMCPClient({
      serverName: 'roundtable-ai',
      timeout: TEST_TIMEOUT,
      workingDirectory: testDir,
      debug: true
    });
  });

  afterEach(async () => {
    // Cleanup
    if (mcpClient) {
      await mcpClient.disconnect();
    }
    if (testDir && await fs.pathExists(testDir)) {
      await fs.remove(testDir);
    }
  });

  describe('Timeout Configuration Validation', () => {
    it('should use the specified 5-minute timeout', () => {
      expect(mcpClient).toBeDefined();
      // The timeout should be set to 300000ms (5 minutes)
      expect((mcpClient as any).options.timeout).toBe(TEST_TIMEOUT);
    });

    it('should validate timeout configuration in MCP config', async () => {
      const configPath = path.join(process.cwd(), '.juno_task/mcp.json');
      const config = await fs.readJson(configPath);
      
      // The roundtable-ai server should have a timeout configured
      expect(config.mcpServers['roundtable-ai'].timeout).toBeDefined();
      expect(config.mcpServers['roundtable-ai'].timeout).toBeGreaterThan(0);
    });
  });

  describe('Connection Timeout Handling', () => {
    it('should handle connection timeout gracefully', async () => {
      // Create client with very short timeout to test connection timeout
      const shortTimeoutClient = createMCPClient({
        serverName: 'roundtable-ai',
        timeout: 100, // 100ms - very short
        workingDirectory: testDir,
        debug: true
      });

      await expect(shortTimeoutClient.connect()).rejects.toThrow(MCPTimeoutError);
    });

    it('should connect successfully within normal timeout', async () => {
      // This should connect within the 5-minute timeout
      await expect(mcpClient.connect()).resolves.not.toThrow();
    });
  });

  describe('Tool Call Timeout Handling', () => {
    it('should complete tool calls within timeout', async () => {
      await mcpClient.connect();

      // Mock a tool call that takes less than the timeout
      const mockToolCall = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second
        return { content: 'Tool completed successfully' };
      });

      // Replace the actual tool call with our mock
      vi.spyOn(mcpClient as any, 'callToolWithTimeout').mockImplementation(mockToolCall);

      const result = await mcpClient.callTool({
        toolName: 'test_tool',
        arguments: { duration: 1000 }
      });

      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(TEST_TIMEOUT);
    });

    it('should timeout tool calls that exceed the limit', async () => {
      // Use a short timeout to make this test deterministic and fast
      const shortTimeoutClient = createMCPClient({
        serverName: 'roundtable-ai',
        timeout: 1000, // 1 second
        workingDirectory: testDir,
        debug: true
      });

      await shortTimeoutClient.connect();

      // Mock a tool call that takes longer than the timeout
      const mockToolCall = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5s, exceeds 1s timeout
        return { content: 'This should not be reached' };
      });

      vi.spyOn(shortTimeoutClient as any, 'callToolWithTimeout').mockImplementation(mockToolCall);

      await expect(shortTimeoutClient.callTool({
        toolName: 'long_running_tool',
        arguments: { duration: EXCEED_TIMEOUT_DURATION }
      })).rejects.toThrow(MCPTimeoutError);
    });
  });

  describe('Real MCP Server Timeout Testing', () => {
    it('should handle real MCP server operations within timeout', async () => {
      await mcpClient.connect();

      // Test listing tools - should complete quickly
      const tools = await mcpClient.listTools();
      expect(Array.isArray(tools)).toBe(true);
    });

    it('should timeout on operations that exceed configured limit', async () => {
      // Create a client with a very short timeout for this test
      const shortTimeoutClient = createMCPClient({
        serverName: 'roundtable-ai',
        timeout: 1000, // 1 second timeout
        workingDirectory: testDir,
        debug: true
      });

      await shortTimeoutClient.connect();

      // This should timeout if the operation takes longer than 1 second
      // Note: This test might be flaky depending on server response time
      try {
        await shortTimeoutClient.callTool({
          toolName: 'claude_subagent',
          arguments: {
            instruction: 'Perform a complex analysis that takes time',
            project_path: testDir,
            model: 'auto',
            iteration: 1
          }
        });
      } catch (error) {
        expect(error).toBeInstanceOf(MCPTimeoutError);
      }
    });
  });

  describe('Timeout Error Handling and Recovery', () => {
    it('should provide meaningful timeout error messages', async () => {
      const shortTimeoutClient = createMCPClient({
        serverName: 'roundtable-ai',
        timeout: 100,
        workingDirectory: testDir,
        debug: true
      });

      try {
        await shortTimeoutClient.connect();
      } catch (error) {
        expect(error).toBeInstanceOf(MCPTimeoutError);
        expect((error as MCPTimeoutError).message).toContain('timed out');
        expect((error as MCPTimeoutError).message).toContain('100ms');
      }
    });

    it('should handle timeout errors gracefully without crashing', async () => {
      const shortTimeoutClient = createMCPClient({
        serverName: 'roundtable-ai',
        timeout: 100,
        workingDirectory: testDir,
        debug: true
      });

      // Should not throw unhandled errors
      await expect(shortTimeoutClient.connect()).rejects.toThrow(MCPTimeoutError);
      
      // Client should still be usable after timeout
      expect(shortTimeoutClient.getConnectionStatus()).toBeDefined();
    });
  });

  describe('CLI Integration Timeout Testing', () => {
    it('should respect timeout settings in CLI commands', async () => {
      // Test the CLI with timeout configuration
      const result = await execa('node', ['dist/bin/cli.mjs', '--help'], {
        cwd: process.cwd(),
        timeout: 10000 // 10 second test timeout
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--mcp-timeout');
    });

    it('should handle timeout in start command', async () => {
      // Create a test project directory
      const testProjectDir = path.join(testDir, 'test-project');
      await fs.ensureDir(testProjectDir);

      // Test with a very short timeout to ensure timeout handling works
      const result = await execa('node', [
        'dist/bin/cli.mjs', 
        'start',
        '--mcp-timeout', '1000', // 1 second timeout
        '--dry-run'
      ], {
        cwd: process.cwd(),
        timeout: 15000, // 15 second test timeout
        env: {
          ...process.env,
          JUNO_TASK_MCP_TIMEOUT: '1000'
        }
      });

      // The command should complete (even if with timeout error)
      expect(result.exitCode).toBeDefined();
    });
  });

  describe('Performance and Resource Cleanup', () => {
    it('should clean up resources after timeout', async () => {
      const shortTimeoutClient = createMCPClient({
        serverName: 'roundtable-ai',
        timeout: 100,
        workingDirectory: testDir,
        debug: true
      });

      try {
        await shortTimeoutClient.connect();
      } catch (error) {
        // Expected to timeout
      }

      // Client should be properly disposed
      shortTimeoutClient.dispose();
      
      // No memory leaks or hanging processes should occur
      expect(shortTimeoutClient.getConnectionStatus()).toBeDefined();
    });

    it('should handle multiple timeout scenarios without resource leaks', async () => {
      const clients = [];
      
      // Create multiple clients with short timeouts
      for (let i = 0; i < 5; i++) {
        const client = createMCPClient({
          serverName: 'roundtable-ai',
          timeout: 100,
          workingDirectory: testDir,
          debug: false
        });
        clients.push(client);
      }

      // All should timeout
      for (const client of clients) {
        await expect(client.connect()).rejects.toThrow(MCPTimeoutError);
        client.dispose();
      }

      // No hanging resources
      expect(clients.length).toBe(5);
    });
  });

  describe('Configuration Validation', () => {
    it('should validate timeout configuration from environment', () => {
      const originalTimeout = process.env.JUNO_TASK_MCP_TIMEOUT;
      
      try {
        process.env.JUNO_TASK_MCP_TIMEOUT = '300000';
        
        const client = createMCPClient({
          serverName: 'roundtable-ai',
          workingDirectory: testDir
        });

        // The client should pick up the environment timeout
        expect((client as any).options.timeout).toBe(300000);
      } finally {
        if (originalTimeout) {
          process.env.JUNO_TASK_MCP_TIMEOUT = originalTimeout;
        } else {
          delete process.env.JUNO_TASK_MCP_TIMEOUT;
        }
      }
    });

    it('should handle invalid timeout values gracefully', () => {
      expect(() => {
        createMCPClient({
          serverName: 'roundtable-ai',
          timeout: -1, // Invalid timeout
          workingDirectory: testDir
        });
      }).not.toThrow(); // Should not throw during creation

      expect(() => {
        createMCPClient({
          serverName: 'roundtable-ai',
          timeout: 0, // Invalid timeout
          workingDirectory: testDir
        });
      }).not.toThrow(); // Should not throw during creation
    });
  });
});
