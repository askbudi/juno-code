#!/usr/bin/env node
/**
 * Test script to verify that environment variables are correctly passed
 * from the juno-task-ts MCP client to the MCP server process.
 *
 * This script:
 * 1. Creates an MCP client with custom environment variables
 * 2. Connects to the test-mcp-env-server.py
 * 3. Calls the get_env_vars tool
 * 4. Verifies that ONLY the expected environment variables are present
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function log(message, color = RESET) {
  console.log(`${color}${message}${RESET}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, GREEN);
}

function logError(message) {
  log(`❌ ${message}`, RED);
}

function logWarning(message) {
  log(`⚠️  ${message}`, YELLOW);
}

function logInfo(message) {
  log(`ℹ️  ${message}`, BLUE);
}

async function testEnvironmentVariables() {
  logInfo('Starting MCP Environment Variables Test');
  logInfo('========================================\n');

  // Define test environment variables
  const testEnvVars = {
    PYTHONUNBUFFERED: '1',
    MCP_LOG_LEVEL: 'ERROR',
    CUSTOM_VAR_1: 'test_value_1',
    CUSTOM_VAR_2: 'test_value_2',
    ROUNDTABLE_DEBUG: 'true',
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'test_token_12345'
  };

  logInfo('Test Configuration:');
  logInfo('  Expected environment variables to be passed:');
  Object.entries(testEnvVars).forEach(([key, value]) => {
    // Mask sensitive values
    const displayValue = key.includes('TOKEN') || key.includes('KEY') ? '***MASKED***' : value;
    console.log(`    ${key}: ${displayValue}`);
  });
  console.log('');

  // Create transport with custom environment variables
  const serverPath = path.join(__dirname, 'test-mcp-env-server.py');
  logInfo(`Connecting to MCP server: ${serverPath}`);

  const transport = new StdioClientTransport({
    command: 'python3',
    args: [serverPath],
    stderr: 'pipe',
    env: testEnvVars
  });

  const client = new Client({
    name: 'juno-task-ts-env-test',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {}
    }
  });

  try {
    // Connect to server
    logInfo('Connecting to MCP server...');
    await client.connect(transport);
    logSuccess('Connected successfully\n');

    // List available tools
    logInfo('Listing available tools...');
    const toolsList = await client.listTools();
    logSuccess(`Found ${toolsList.tools.length} tool(s):`);
    toolsList.tools.forEach(tool => {
      console.log(`  - ${tool.name}: ${tool.description}`);
    });
    console.log('');

    // Call the get_env_vars tool
    logInfo('Calling get_env_vars tool...');
    const result = await client.callTool({
      name: 'get_env_vars',
      arguments: {}
    });

    // Parse the environment variables from the result
    const envVarsText = result.content[0].text;
    const serverEnvVars = JSON.parse(envVarsText);

    logSuccess('Received environment variables from server\n');

    // Verify the environment variables
    logInfo('Verification Results:');
    logInfo('====================\n');

    let allTestsPassed = true;
    const expectedKeys = Object.keys(testEnvVars);
    const receivedKeys = Object.keys(serverEnvVars);

    // Check that all expected variables are present
    logInfo('1. Checking for expected variables:');
    for (const key of expectedKeys) {
      if (key in serverEnvVars) {
        const expectedValue = testEnvVars[key];
        const receivedValue = serverEnvVars[key];

        if (expectedValue === receivedValue) {
          const displayValue = key.includes('TOKEN') || key.includes('KEY') ? '***MASKED***' : receivedValue;
          logSuccess(`  ${key} = ${displayValue}`);
        } else {
          logError(`  ${key} has wrong value: expected "${expectedValue}", got "${receivedValue}"`);
          allTestsPassed = false;
        }
      } else {
        logError(`  ${key} is missing`);
        allTestsPassed = false;
      }
    }
    console.log('');

    // Check for SDK default environment variables (expected behavior)
    logInfo('2. Checking for SDK default environment variables:');
    const sdkDefaultVars = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
    const foundSdkVars = sdkDefaultVars.filter(key => key in serverEnvVars);
    const missingSdkVars = sdkDefaultVars.filter(key => !(key in serverEnvVars));

    if (foundSdkVars.length > 0) {
      logSuccess(`  Found ${foundSdkVars.length} SDK default variables (expected):`);
      foundSdkVars.forEach(key => {
        console.log(`    ✓ ${key}`);
      });
    }

    if (missingSdkVars.length > 0) {
      logInfo(`  Missing ${missingSdkVars.length} SDK default variables (optional):`);
      missingSdkVars.forEach(key => {
        console.log(`    - ${key}`);
      });
    }
    console.log('');

    // Check for unexpected variables (not in our list or SDK defaults)
    logInfo('3. Checking for other environment variables:');
    const allExpectedKeys = [...expectedKeys, ...sdkDefaultVars];
    const unexpectedVars = receivedKeys.filter(key => !allExpectedKeys.includes(key));

    if (unexpectedVars.length === 0) {
      logSuccess('  No unexpected environment variables ✓');
    } else {
      logInfo(`  Found ${unexpectedVars.length} other variable(s):`);
      unexpectedVars.forEach(key => {
        console.log(`    - ${key}: ${serverEnvVars[key]}`);
      });
    }
    console.log('');

    // Summary
    logInfo('Summary:');
    logInfo('========');
    console.log(`  User-defined variables: ${expectedKeys.length} (all present: ${allTestsPassed ? '✓' : '✗'})`);
    console.log(`  SDK default variables: ${foundSdkVars.length}/${sdkDefaultVars.length}`);
    console.log(`  Other variables: ${unexpectedVars.length}`);
    console.log(`  Total environment variables: ${receivedKeys.length}`);
    console.log('');

    if (allTestsPassed) {
      logSuccess('🎉 ALL TESTS PASSED!');
      logSuccess('✓ All user-defined environment variables are correctly passed to MCP server');
      logSuccess('✓ SDK default environment variables (HOME, PATH, etc.) are present as expected');
      logSuccess('✓ MCP server has the necessary environment to operate correctly');
      return true;
    } else {
      logError('❌ TESTS FAILED!');
      logError('Some user-defined environment variables are missing or incorrect.');
      return false;
    }

  } catch (error) {
    logError(`Error during test: ${error.message}`);
    console.error(error);
    return false;
  } finally {
    // Close the connection
    try {
      await client.close();
      logInfo('\nConnection closed.');
    } catch (e) {
      // Ignore close errors
    }
  }
}

// Run the test
testEnvironmentVariables()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    logError(`Unhandled error: ${error.message}`);
    console.error(error);
    process.exit(1);
  });