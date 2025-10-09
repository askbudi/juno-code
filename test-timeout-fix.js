#!/usr/bin/env node

/**
 * Test script to verify the timeout fix
 * Creates a test project and tests different timeout scenarios
 */

import { execa } from 'execa';
import path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';

async function testTimeoutFix() {
  console.log('🧪 Testing MCP timeout fix...\n');

  // Create temporary directory for testing
  const tempDir = await fs.mkdtemp(path.join('/tmp', 'juno-timeout-test-'));
  console.log(`📁 Test directory: ${tempDir}`);

  try {
    const binaryPath = path.resolve(process.cwd(), 'dist/bin/cli.mjs');

    // Step 1: Initialize a test project
    console.log('🚀 Initializing test project...');
    const initResult = await execa('node', [binaryPath, 'init'], {
      cwd: tempDir,
      input: '\n\nTest task for timeout\n\n2\ny\nhttps://github.com/askbudi/temp-test-ts-repo\n',
      timeout: 30000,
      reject: false
    });

    if (initResult.exitCode !== 0) {
      console.error('❌ Failed to initialize test project');
      console.error('STDERR:', initResult.stderr);
      return;
    }

    console.log('✅ Test project initialized successfully');

    // Step 2: Test with short timeout (10 seconds) to see if timeout is respected
    console.log('\n⏱️  Testing with 10-second timeout...');

    const startTime = Date.now();
    const shortTimeoutResult = await execa('node', [binaryPath, 'start', '--mcp-timeout', '10000', '--subagent', 'cursor'], {
      cwd: tempDir,
      timeout: 30000, // External timeout to prevent hanging
      reject: false
    });
    const endTime = Date.now();
    const actualDuration = endTime - startTime;

    console.log(`⏰ Actual duration: ${actualDuration}ms`);
    console.log(`🎯 Exit code: ${shortTimeoutResult.exitCode}`);

    // Check if timeout was respected (should timeout around 10 seconds, not 60 seconds)
    const timeoutWasRespected = actualDuration < 20000 && actualDuration > 9000; // Between 9-20 seconds

    if (timeoutWasRespected) {
      console.log('✅ Timeout fix appears to be working! (10-second timeout was respected)');
    } else if (actualDuration > 55000) {
      console.log('❌ Timeout not respected - still timing out at ~60 seconds');
    } else {
      console.log('🤔 Unexpected result - need to investigate further');
    }

    if (shortTimeoutResult.stderr) {
      console.log('\n📋 Error output:');
      console.log(shortTimeoutResult.stderr.substring(0, 500) + (shortTimeoutResult.stderr.length > 500 ? '...' : ''));
    }

    // Step 3: Test with longer timeout (60 seconds) to see if it completes
    console.log('\n⏱️  Testing with 60-second timeout...');

    const longStartTime = Date.now();
    const longTimeoutResult = await execa('node', [binaryPath, 'start', '--mcp-timeout', '60000', '--subagent', 'cursor'], {
      cwd: tempDir,
      timeout: 90000, // External timeout
      reject: false
    });
    const longEndTime = Date.now();
    const longActualDuration = longEndTime - longStartTime;

    console.log(`⏰ Actual duration: ${longActualDuration}ms`);
    console.log(`🎯 Exit code: ${longTimeoutResult.exitCode}`);

    if (longTimeoutResult.exitCode === 0) {
      console.log('✅ Long timeout allows completion - fix is working!');
    } else {
      console.log('🤔 Long timeout still failed - investigating...');
    }

    // Summary
    console.log('\n📊 Test Summary:');
    console.log(`   10s timeout test: ${timeoutWasRespected ? '✅ PASSED' : '❌ FAILED'} (${actualDuration}ms)`);
    console.log(`   60s timeout test: ${longTimeoutResult.exitCode === 0 ? '✅ PASSED' : '❌ FAILED'} (${longActualDuration}ms)`);

    console.log(`\n📁 Test directory preserved: ${tempDir}`);
    console.log(`🧹 To clean up: rm -rf ${tempDir}`);

    return timeoutWasRespected && longTimeoutResult.exitCode === 0;

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.log(`📁 Directory preserved for debugging: ${tempDir}`);
    return false;
  }
}

testTimeoutFix().then(success => {
  process.exit(success ? 0 : 1);
}).catch(console.error);