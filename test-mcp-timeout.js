#!/usr/bin/env node

/**
 * MCP Timeout Test Script
 * 
 * This script tests the MCP timeout functionality by simulating
 * a long-running operation and verifying that the timeout is properly applied.
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 MCP Timeout Functionality Test');
console.log('==================================');

// Test configuration
const testConfigs = [
  {
    name: 'Short Timeout Test (10 seconds)',
    timeout: 10000,
    expectedBehavior: 'Should timeout after ~10 seconds',
    testDuration: 15000 // Allow 15 seconds for the test
  },
  {
    name: 'Medium Timeout Test (30 seconds)', 
    timeout: 30000,
    expectedBehavior: 'Should timeout after ~30 seconds',
    testDuration: 40000 // Allow 40 seconds for the test
  },
  {
    name: 'Long Timeout Test (5 minutes)',
    timeout: 300000,
    expectedBehavior: 'Should timeout after ~5 minutes',
    testDuration: 360000 // Allow 6 minutes for the test
  }
];

async function runTimeoutTest(config) {
  console.log(`\n📋 ${config.name}`);
  console.log(`   Timeout: ${config.timeout}ms (${config.timeout / 1000}s)`);
  console.log(`   Expected: ${config.expectedBehavior}`);
  
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    // Spawn the CLI with timeout configuration
    const cliProcess = spawn('node', [
      'dist/bin/cli.mjs',
      'start',
      '--mcp-timeout', config.timeout.toString(),
      '-s', 'cursor',
      '-m', 'auto'
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';
    let hasTimedOut = false;

    // Collect output
    cliProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    cliProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    // Monitor for timeout
    const timeoutMonitor = setTimeout(() => {
      if (!hasTimedOut) {
        hasTimedOut = true;
        cliProcess.kill('SIGTERM');
        console.log(`   ⏰ Process killed after ${config.testDuration / 1000}s (test timeout)`);
        resolve({
          success: false,
          reason: 'Test timeout exceeded',
          duration: Date.now() - startTime,
          output,
          errorOutput
        });
      }
    }, config.testDuration);

    cliProcess.on('close', (code, signal) => {
      clearTimeout(timeoutMonitor);
      const duration = Date.now() - startTime;
      
      if (hasTimedOut) {
        return; // Already handled by timeout monitor
      }

      console.log(`   ⏱️  Process completed in ${duration}ms (${(duration / 1000).toFixed(1)}s)`);
      console.log(`   📤 Exit code: ${code}, Signal: ${signal || 'none'}`);

      // Check if timeout was properly applied
      const expectedTimeoutRange = {
        min: config.timeout * 0.8, // Allow 20% tolerance
        max: config.timeout * 1.2  // Allow 20% tolerance
      };

      const isTimeoutInRange = duration >= expectedTimeoutRange.min && duration <= expectedTimeoutRange.max;
      const isMCPTimeoutError = errorOutput.includes('MCPTimeoutError') || errorOutput.includes('timed out');

      if (isTimeoutInRange && isMCPTimeoutError) {
        console.log(`   ✅ SUCCESS: Timeout applied correctly`);
        resolve({
          success: true,
          reason: 'Timeout applied correctly',
          duration,
          output,
          errorOutput
        });
      } else if (isTimeoutInRange) {
        console.log(`   ⚠️  PARTIAL: Timeout timing correct but no MCP timeout error detected`);
        resolve({
          success: false,
          reason: 'Timeout timing correct but no MCP timeout error',
          duration,
          output,
          errorOutput
        });
      } else {
        console.log(`   ❌ FAILED: Timeout not applied correctly`);
        console.log(`   📊 Expected: ${expectedTimeoutRange.min}-${expectedTimeoutRange.max}ms, Got: ${duration}ms`);
        resolve({
          success: false,
          reason: 'Timeout not applied correctly',
          duration,
          output,
          errorOutput
        });
      }
    });

    cliProcess.on('error', (error) => {
      clearTimeout(timeoutMonitor);
      const duration = Date.now() - startTime;
      console.log(`   ❌ Process error: ${error.message}`);
      resolve({
        success: false,
        reason: `Process error: ${error.message}`,
        duration,
        output,
        errorOutput
      });
    });
  });
}

async function runAllTests() {
  console.log('🚀 Starting MCP timeout tests...\n');
  
  const results = [];
  
  for (const config of testConfigs) {
    try {
      const result = await runTimeoutTest(config);
      results.push({ config, result });
      
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
          errorOutput: error.stack
        }
      });
    }
  }

  // Summary
  console.log('\n📊 Test Results Summary');
  console.log('======================');
  
  const successful = results.filter(r => r.result.success).length;
  const total = results.length;
  
  results.forEach(({ config, result }) => {
    const status = result.success ? '✅ PASS' : '❌ FAIL';
    const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'N/A';
    console.log(`${status} ${config.name} (${duration})`);
    if (!result.success) {
      console.log(`   Reason: ${result.reason}`);
    }
  });
  
  console.log(`\n🎯 Overall: ${successful}/${total} tests passed`);
  
  if (successful === total) {
    console.log('🎉 All MCP timeout tests passed! The timeout functionality is working correctly.');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed. Check the output above for details.');
    process.exit(1);
  }
}

// Run the tests
runAllTests().catch(error => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});