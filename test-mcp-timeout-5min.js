#!/usr/bin/env node

/**
 * MCP 5-Minute Timeout Validation Test
 * 
 * This script specifically tests the MCP timeout functionality with a 5-minute (300000ms) timeout
 * as specified in the user requirements. It validates that long-running operations are properly
 * handled within the timeout constraints.
 * 
 * Configuration:
 * - Subagent: cursor
 * - Model: auto
 * - MCP Timeout: 300000 (5 minutes)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

console.log('🧪 MCP 5-Minute Timeout Validation Test');
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
    name: 'Long Operation Test (should timeout)',
    description: 'Test a long operation that should timeout after 5 minutes',
    timeout: 300000, // 5 minutes
    testDuration: 360000, // 6 minutes test timeout
    expectedBehavior: 'TIMEOUT',
    command: ['start', '--mcp-timeout', '300000', '-s', 'cursor', '-m', 'auto', '--verbose']
  },
  {
    name: 'Short Timeout Test (should timeout quickly)',
    description: 'Test with a very short timeout to verify timeout mechanism works',
    timeout: 10000, // 10 seconds
    testDuration: 20000, // 20 seconds test timeout
    expectedBehavior: 'TIMEOUT',
    command: ['start', '--mcp-timeout', '10000', '-s', 'cursor', '-m', 'auto', '--verbose']
  }
];

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
          mcpTimeoutDetected
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
        } else {
          success = false;
          reason = `Operation failed with exit code ${code}`;
        }
      } else if (config.expectedBehavior === 'TIMEOUT') {
        if (mcpTimeoutDetected) {
          success = true;
          reason = 'MCP timeout detected as expected';
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
        error: error.message
      });
    });
  });
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
  console.log('🚀 Starting MCP 5-minute timeout validation tests...\n');
  
  // Validate configuration first
  const configValid = await validateMCPConfiguration();
  if (!configValid) {
    console.log('\n❌ Configuration validation failed. Aborting tests.');
    process.exit(1);
  }

  const results = [];
  
  for (const config of testConfigs) {
    try {
      const result = await runTimeoutTest(config);
      results.push({ config, result });
      
      // Add delay between tests
      if (config !== testConfigs[testConfigs.length - 1]) {
        console.log('   ⏳ Waiting 3 seconds before next test...');
        await new Promise(resolve => setTimeout(resolve, 3000));
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
          mcpTimeoutDetected: false
        }
      });
    }
  }

  // Generate detailed test report
  console.log('\n📊 Test Results Summary');
  console.log('======================');
  
  const successful = results.filter(r => r.result.success).length;
  const total = results.length;
  
  results.forEach(({ config, result }) => {
    const status = result.success ? '✅ PASS' : '❌ FAIL';
    const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'N/A';
    console.log(`${status} ${config.name} (${duration})`);
    console.log(`   Reason: ${result.reason}`);
    if (result.progressEvents.length > 0) {
      console.log(`   Progress Events: ${result.progressEvents.length}`);
    }
    if (result.mcpTimeoutDetected) {
      console.log(`   MCP Timeout: ✅ Detected`);
    }
    console.log('');
  });
  
  console.log(`🎯 Overall: ${successful}/${total} tests passed`);
  
  // Generate detailed report file
  const reportPath = path.join(process.cwd(), 'test-artifacts', 'mcp-timeout-5min-report.md');
  await fs.ensureDir(path.dirname(reportPath));
  
  const report = `# MCP 5-Minute Timeout Validation Report

Generated: ${new Date().toISOString()}

## Test Configuration
- Subagent: cursor
- Model: auto
- MCP Timeout: 300000ms (5 minutes)

## Test Results

${results.map(({ config, result }, index) => `
### Test ${index + 1}: ${config.name}

**Status**: ${result.success ? '✅ PASS' : '❌ FAIL'}
**Duration**: ${result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'N/A'}
**Reason**: ${result.reason}
**MCP Timeout Detected**: ${result.mcpTimeoutDetected ? 'Yes' : 'No'}
**Progress Events**: ${result.progressEvents.length}

**Command**:
\`\`\`bash
node dist/bin/cli.mjs ${config.command.join(' ')}
\`\`\`

**Output**:
\`\`\`
${result.output.substring(0, 1000)}${result.output.length > 1000 ? '...' : ''}
\`\`\`

**Error Output**:
\`\`\`
${result.errorOutput.substring(0, 1000)}${result.errorOutput.length > 1000 ? '...' : ''}
\`\`\`
`).join('\n')}

## Summary

- **Total Tests**: ${total}
- **Passed**: ${successful}
- **Failed**: ${total - successful}
- **Success Rate**: ${((successful / total) * 100).toFixed(1)}%

## Key Findings

${successful === total ? 
  '✅ All MCP timeout tests passed! The 5-minute timeout functionality is working correctly.' :
  '⚠️ Some tests failed. The MCP timeout functionality may need attention.'}

## Recommendations

${results.some(r => !r.result.success) ? 
  '- Review failed tests and investigate timeout handling issues\n- Check MCP server configuration and connectivity\n- Verify timeout error messages are properly surfaced' :
  '- MCP timeout functionality is working correctly\n- Consider adding more comprehensive timeout scenarios\n- Monitor timeout behavior in production usage'}
`;

  await fs.writeFile(reportPath, report);
  console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  
  if (successful === total) {
    console.log('\n🎉 All MCP 5-minute timeout tests passed! The timeout functionality is working correctly.');
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