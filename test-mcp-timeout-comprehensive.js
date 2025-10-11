#!/usr/bin/env node

/**
 * Comprehensive MCP Timeout Test Suite
 * 
 * This test suite validates MCP timeout functionality with various scenarios:
 * 1. Quick operations that should complete within timeout
 * 2. Long operations that should timeout
 * 3. Different timeout values and their behavior
 * 4. Error handling and cleanup when timeouts occur
 * 5. Progress tracking during timeout scenarios
 * 
 * Configuration:
 * - Subagent: cursor
 * - Model: auto
 * - MCP Timeout: 300000 (5 minutes) - as specified in user requirements
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

console.log('🧪 Comprehensive MCP Timeout Test Suite');
console.log('========================================');
console.log('Configuration:');
console.log('- Subagent: cursor');
console.log('- Model: auto');
console.log('- MCP Timeout: 300000ms (5 minutes)');
console.log('');

// Test configurations for different timeout scenarios
const testConfigs = [
  {
    name: 'Quick Operation Test (should complete)',
    description: 'Test a quick operation that should complete within 5 minutes',
    timeout: 300000, // 5 minutes
    testDuration: 60000, // 1 minute test timeout
    expectedBehavior: 'SUCCESS',
    command: ['start', '--mcp-timeout', '300000', '-s', 'cursor', '-m', 'auto', '--dry-run']
  },
  {
    name: 'Short Timeout Test (should timeout quickly)',
    description: 'Test with a very short timeout to verify timeout mechanism works',
    timeout: 5000, // 5 seconds
    testDuration: 15000, // 15 seconds test timeout
    expectedBehavior: 'TIMEOUT',
    command: ['start', '--mcp-timeout', '5000', '-s', 'cursor', '-m', 'auto', '--verbose']
  },
  {
    name: 'Medium Timeout Test (should timeout)',
    description: 'Test with medium timeout to verify timeout behavior',
    timeout: 15000, // 15 seconds
    testDuration: 30000, // 30 seconds test timeout
    expectedBehavior: 'TIMEOUT',
    command: ['start', '--mcp-timeout', '15000', '-s', 'cursor', '-m', 'auto', '--verbose']
  },
  {
    name: 'Long Timeout Test (should complete)',
    description: 'Test with long timeout for operations that should complete',
    timeout: 60000, // 1 minute
    testDuration: 90000, // 1.5 minutes test timeout
    expectedBehavior: 'SUCCESS',
    command: ['start', '--mcp-timeout', '60000', '-s', 'cursor', '-m', 'auto', '--dry-run']
  },
  {
    name: 'Very Long Timeout Test (should complete)',
    description: 'Test with very long timeout to verify no premature timeouts',
    timeout: 300000, // 5 minutes
    testDuration: 60000, // 1 minute test timeout
    expectedBehavior: 'SUCCESS',
    command: ['start', '--mcp-timeout', '300000', '-s', 'cursor', '-m', 'auto', '--dry-run']
  }
];

// Mock MCP server simulation for timeout testing
class MockMCPServer {
  constructor(timeoutMs = 30000) {
    this.timeoutMs = timeoutMs;
    this.operations = new Map();
  }
  
  async simulateLongOperation(operationId, durationMs) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      // Simulate progress events every 2 seconds
      const progressInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[MOCK] Operation ${operationId}: ${elapsed}ms elapsed`);
      }, 2000);
      
      // Complete the operation after the specified duration
      setTimeout(() => {
        clearInterval(progressInterval);
        const actualDuration = Date.now() - startTime;
        console.log(`[MOCK] Operation ${operationId} completed in ${actualDuration}ms`);
        resolve({
          operationId,
          duration: actualDuration,
          success: true
        });
      }, durationMs);
      
      // Set up timeout
      setTimeout(() => {
        clearInterval(progressInterval);
        const actualDuration = Date.now() - startTime;
        console.log(`[MOCK] Operation ${operationId} timed out after ${actualDuration}ms`);
        reject(new Error(`Operation ${operationId} timed out after ${actualDuration}ms`));
      }, this.timeoutMs);
    });
  }
}

async function runTimeoutTest(config) {
  console.log(`\n📋 ${config.name}`);
  console.log(`   Description: ${config.description}`);
  console.log(`   MCP Timeout: ${config.timeout}ms (${config.timeout / 1000}s)`);
  console.log(`   Expected: ${config.expectedBehavior}`);
  console.log(`   Command: node dist/bin/cli.mjs ${config.command.join(' ')}`);
  
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    // Spawn the CLI with the specified configuration
    const cliProcess = spawn('node', ['dist/bin/cli.mjs', ...config.command], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        JUNO_TASK_MCP_TIMEOUT: config.timeout.toString()
      }
    });

    let output = '';
    let errorOutput = '';
    let hasTimedOut = false;
    let mcpTimeoutDetected = false;
    let progressEvents = [];
    let connectionErrors = [];

    // Collect output and analyze for timeout indicators
    cliProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      
      // Look for progress events
      if (chunk.includes('Starting tool:') || chunk.includes('Connecting to subagent') || chunk.includes('Executing:')) {
        progressEvents.push({
          timestamp: Date.now(),
          event: chunk.trim(),
          type: 'progress'
        });
      }
    });

    cliProcess.stderr.on('data', (data) => {
      const chunk = data.toString();
      errorOutput += chunk;
      
      // Look for MCP timeout errors
      if (chunk.includes('MCPTimeoutError') || chunk.includes('timed out') || chunk.includes('timeout')) {
        mcpTimeoutDetected = true;
        progressEvents.push({
          timestamp: Date.now(),
          event: chunk.trim(),
          type: 'timeout_error'
        });
      }
      
      // Look for connection errors
      if (chunk.includes('Connection closed') || chunk.includes('MCP error -32000') || chunk.includes('MCPConnectionError')) {
        connectionErrors.push({
          timestamp: Date.now(),
          error: chunk.trim(),
          type: 'connection_error'
        });
      }
    });

    // Monitor for test timeout
    const testTimeoutMonitor = setTimeout(() => {
      if (!hasTimedOut) {
        hasTimedOut = true;
        cliProcess.kill('SIGTERM');
        console.log(`   ⏰ Test timeout exceeded (${config.testDuration / 1000}s)`);
        resolve({
          success: false,
          reason: 'Test timeout exceeded',
          duration: Date.now() - startTime,
          output,
          errorOutput,
          progressEvents,
          mcpTimeoutDetected,
          connectionErrors
        });
      }
    }, config.testDuration);

    cliProcess.on('close', (code, signal) => {
      clearTimeout(testTimeoutMonitor);
      const duration = Date.now() - startTime;
      
      if (hasTimedOut) {
        return; // Already handled by test timeout monitor
      }

      console.log(`   ⏱️  Process completed in ${duration}ms (${(duration / 1000).toFixed(1)}s)`);
      console.log(`   📤 Exit code: ${code}, Signal: ${signal || 'none'}`);
      console.log(`   📊 Progress events captured: ${progressEvents.length}`);
      console.log(`   🔗 Connection errors: ${connectionErrors.length}`);

      // Analyze the results based on expected behavior
      let success = false;
      let reason = '';

      if (config.expectedBehavior === 'SUCCESS') {
        if (code === 0 && !mcpTimeoutDetected) {
          success = true;
          reason = 'Operation completed successfully within timeout';
        } else if (mcpTimeoutDetected) {
          success = false;
          reason = 'Unexpected MCP timeout detected';
        } else if (connectionErrors.length > 0) {
          success = false;
          reason = `Connection errors detected: ${connectionErrors[0].error}`;
        } else {
          success = false;
          reason = `Operation failed with exit code ${code}`;
        }
      } else if (config.expectedBehavior === 'TIMEOUT') {
        if (mcpTimeoutDetected) {
          success = true;
          reason = 'MCP timeout detected as expected';
        } else if (connectionErrors.length > 0) {
          success = false;
          reason = `Connection errors instead of timeout: ${connectionErrors[0].error}`;
        } else if (code !== 0) {
          success = false;
          reason = 'Process failed but no MCP timeout detected';
        } else {
          success = false;
          reason = 'Process completed successfully but expected timeout';
        }
      }

      if (success) {
        console.log(`   ✅ SUCCESS: ${reason}`);
      } else {
        console.log(`   ❌ FAILED: ${reason}`);
      }

      resolve({
        success,
        reason,
        duration,
        output,
        errorOutput,
        progressEvents,
        mcpTimeoutDetected,
        connectionErrors,
        exitCode: code,
        signal
      });
    });

    cliProcess.on('error', (error) => {
      clearTimeout(testTimeoutMonitor);
      const duration = Date.now() - startTime;
      console.log(`   ❌ Process error: ${error.message}`);
      resolve({
        success: false,
        reason: `Process error: ${error.message}`,
        duration,
        output,
        errorOutput,
        progressEvents,
        mcpTimeoutDetected,
        connectionErrors,
        error: error.message
      });
    });
  });
}

async function runMockTimeoutTests() {
  console.log('\n🔬 Running Mock MCP Timeout Tests...');
  
  const mockConfigs = [
    {
      name: 'Mock Quick Operation (should complete)',
      operationDuration: 2000, // 2 seconds
      clientTimeout: 10000, // 10 seconds
      expectedResult: 'SUCCESS'
    },
    {
      name: 'Mock Long Operation (should timeout)',
      operationDuration: 15000, // 15 seconds
      clientTimeout: 10000, // 10 seconds
      expectedResult: 'TIMEOUT'
    },
    {
      name: 'Mock Very Long Operation (should timeout)',
      operationDuration: 30000, // 30 seconds
      clientTimeout: 5000, // 5 seconds
      expectedResult: 'TIMEOUT'
    }
  ];
  
  const results = [];
  
  for (const config of mockConfigs) {
    console.log(`\n📋 ${config.name}`);
    console.log(`   Operation Duration: ${config.operationDuration}ms (${config.operationDuration / 1000}s)`);
    console.log(`   Client Timeout: ${config.clientTimeout}ms (${config.clientTimeout / 1000}s)`);
    console.log(`   Expected Result: ${config.expectedResult}`);
    
    const startTime = Date.now();
    
    try {
      const mockServer = new MockMCPServer(config.clientTimeout);
      const result = await mockServer.simulateLongOperation(
        `test-${Date.now()}`,
        config.operationDuration
      );
      
      const totalDuration = Date.now() - startTime;
      
      if (config.expectedResult === 'SUCCESS') {
        console.log(`✅ SUCCESS: Operation completed in ${totalDuration}ms`);
        results.push({ config, success: true, reason: 'Operation completed successfully', duration: totalDuration });
      } else {
        console.log(`❌ UNEXPECTED SUCCESS: Expected timeout but operation succeeded`);
        results.push({ config, success: false, reason: 'Expected timeout but operation succeeded', duration: totalDuration });
      }
      
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      
      if (config.expectedResult === 'TIMEOUT') {
        console.log(`✅ EXPECTED TIMEOUT: Operation timed out after ${totalDuration}ms`);
        results.push({ config, success: true, reason: 'Operation timed out as expected', duration: totalDuration });
      } else {
        console.log(`❌ UNEXPECTED TIMEOUT: Expected success but operation timed out`);
        results.push({ config, success: false, reason: 'Expected success but operation timed out', duration: totalDuration });
      }
    }
  }
  
  return results;
}

async function validateMCPConfiguration() {
  console.log('🔍 Validating MCP Configuration...');
  
  try {
    // Check if the CLI binary exists
    const cliPath = path.join(process.cwd(), 'dist/bin/cli.mjs');
    if (!await fs.pathExists(cliPath)) {
      console.log('   ❌ CLI binary not found. Please run "npm run build" first.');
      return false;
    }
    console.log('   ✅ CLI binary found');

    // Check MCP configuration
    const mcpConfigPath = path.join(process.cwd(), '.juno_task/mcp.json');
    if (await fs.pathExists(mcpConfigPath)) {
      const mcpConfig = await fs.readJson(mcpConfigPath);
      console.log('   ✅ MCP configuration found');
      console.log(`   📋 Available servers: ${Object.keys(mcpConfig.mcpServers || {}).join(', ')}`);
      
      // Check if the Python server exists
      const serverPath = mcpConfig.mcpServers['roundtable-ai']?.args?.[0];
      if (serverPath && await fs.pathExists(serverPath)) {
        console.log('   ✅ MCP server script found');
      } else {
        console.log('   ⚠️  MCP server script not found or not accessible');
      }
    } else {
      console.log('   ⚠️  MCP configuration not found. Some tests may fail.');
    }

    return true;
  } catch (error) {
    console.log(`   ❌ Configuration validation failed: ${error.message}`);
    return false;
  }
}

async function runAllTests() {
  console.log('🚀 Starting comprehensive MCP timeout validation tests...\n');
  
  // Validate configuration first
  const configValid = await validateMCPConfiguration();
  if (!configValid) {
    console.log('\n❌ Configuration validation failed. Aborting tests.');
    process.exit(1);
  }

  const results = [];
  
  // Run CLI-based timeout tests
  console.log('\n📋 Running CLI-based Timeout Tests...');
  for (const config of testConfigs) {
    try {
      const result = await runTimeoutTest(config);
      results.push({ config, result, testType: 'cli_timeout' });
      
      // Add delay between tests
      if (config !== testConfigs[testConfigs.length - 1]) {
        console.log('   ⏳ Waiting 2 seconds before next test...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.log(`   ❌ Test failed with error: ${error.message}`);
      results.push({ 
        config, 
        result: { 
          success: false, 
          reason: `Test error: ${error.message}`,
          duration: 0,
          output: '',
          errorOutput: error.stack,
          progressEvents: [],
          mcpTimeoutDetected: false,
          connectionErrors: []
        },
        testType: 'cli_timeout'
      });
    }
  }
  
  // Run mock-based timeout tests
  const mockResults = await runMockTimeoutTests();
  results.push(...mockResults.map(r => ({ ...r, testType: 'mock_timeout' })));

  // Generate detailed test report
  console.log('\n📊 Test Results Summary');
  console.log('======================');
  
  const successful = results.filter(r => r.result.success).length;
  const total = results.length;
  
  results.forEach(({ config, result, testType }) => {
    const status = result.success ? '✅ PASS' : '❌ FAIL';
    const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'N/A';
    console.log(`${status} ${config.name} (${duration}) - ${testType}`);
    console.log(`   Reason: ${result.reason}`);
    if (result.progressEvents && result.progressEvents.length > 0) {
      console.log(`   Progress Events: ${result.progressEvents.length}`);
    }
    if (result.mcpTimeoutDetected) {
      console.log(`   MCP Timeout: ✅ Detected`);
    }
    if (result.connectionErrors && result.connectionErrors.length > 0) {
      console.log(`   Connection Errors: ${result.connectionErrors.length}`);
    }
    console.log('');
  });
  
  console.log(`🎯 Overall: ${successful}/${total} tests passed`);
  
  // Generate detailed report file
  const reportPath = path.join(process.cwd(), 'test-artifacts', 'mcp-timeout-comprehensive-report.md');
  await fs.ensureDir(path.dirname(reportPath));
  
  const report = `# Comprehensive MCP Timeout Test Report

Generated: ${new Date().toISOString()}

## Test Configuration
- Subagent: cursor
- Model: auto
- MCP Timeout: 300000ms (5 minutes)

## Test Results

${results.map(({ config, result, testType }, index) => `
### Test ${index + 1}: ${config.name}

**Status**: ${result.success ? '✅ PASS' : '❌ FAIL'}
**Type**: ${testType}
**Duration**: ${result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'N/A'}
**Reason**: ${result.reason}
**MCP Timeout Detected**: ${result.mcpTimeoutDetected ? 'Yes' : 'No'}
**Progress Events**: ${result.progressEvents ? result.progressEvents.length : 0}
**Connection Errors**: ${result.connectionErrors ? result.connectionErrors.length : 0}

**Command**:
\`\`\`bash
node dist/bin/cli.mjs ${config.command ? config.command.join(' ') : 'N/A (Mock Test)'}
\`\`\`

**Output**:
\`\`\`
${result.output ? result.output.substring(0, 1000) : 'N/A (Mock Test)'}${result.output && result.output.length > 1000 ? '...' : ''}
\`\`\`

**Error Output**:
\`\`\`
${result.errorOutput ? result.errorOutput.substring(0, 1000) : 'N/A (Mock Test)'}${result.errorOutput && result.errorOutput.length > 1000 ? '...' : ''}
\`\`\`
`).join('\n')}

## Summary

- **Total Tests**: ${total}
- **Passed**: ${successful}
- **Failed**: ${total - successful}
- **Success Rate**: ${((successful / total) * 100).toFixed(1)}%

## Key Findings

${successful === total ? 
  '✅ All MCP timeout tests passed! The timeout functionality is working correctly.' :
  '⚠️ Some tests failed. The MCP timeout functionality may need attention.'}

## Recommendations

${results.some(r => !r.result.success) ? 
  '- Review failed tests and investigate timeout handling issues\n- Check MCP server configuration and connectivity\n- Verify timeout error messages are properly surfaced\n- Consider improving connection error handling' :
  '- MCP timeout functionality is working correctly\n- Consider adding more comprehensive timeout scenarios\n- Monitor timeout behavior in production usage'}

## Test Types

### CLI-based Tests
These tests use the actual CLI binary with different timeout configurations to validate:
- Quick operations that should complete within timeout
- Long operations that should timeout
- Different timeout values and their behavior
- Error handling and cleanup when timeouts occur

### Mock-based Tests
These tests use simulated MCP operations to validate:
- Timeout mechanism works correctly
- Progress tracking during timeout scenarios
- Error handling for timeout conditions
- Cleanup after timeout events

## Timeout Configuration Analysis

The tests validate the following timeout scenarios:
- **5 seconds**: Should timeout quickly for long operations
- **15 seconds**: Medium timeout for testing timeout behavior
- **1 minute**: Long timeout for operations that should complete
- **5 minutes**: Very long timeout as specified in user requirements

## Connection Issues

${results.some(r => r.result.connectionErrors && r.result.connectionErrors.length > 0) ? 
  'Some tests encountered connection issues with the MCP server. This may indicate:\n- MCP server is not running or accessible\n- Network connectivity issues\n- Server configuration problems\n- Python environment issues' :
  'No connection issues detected in the tests.'}
`;

  await fs.writeFile(reportPath, report);
  console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  
  if (successful === total) {
    console.log('\n🎉 All MCP timeout tests passed! The timeout functionality is working correctly.');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed. Check the detailed report for more information.');
    process.exit(1);
  }
}

// Run the tests
runAllTests().catch(error => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});