#!/usr/bin/env node

/**
 * Standalone MCP Client Connection Test Script
 *
 * This script tests MCP server connectivity using .juno_task/mcp.json configuration
 * and verifies availability of claude, cursor, codex, and gemini subagents.
 *
 * Usage: node test-mcp-standalone.mjs [working-directory]
 */

import { MCPConfigLoader, JunoMCPClient, createMCPClientFromConfig } from './dist/index.mjs';
import * as path from 'path';
import * as fs from 'fs';

const TOOL_NAMES_TO_TEST = [
  'claude_subagent',
  'cursor_subagent',
  'codex_subagent',
  'gemini_subagent'
];

const AVAILABILITY_TOOLS = [
  'check_claude_availability',
  'check_cursor_availability',
  'check_codex_availability',
  'check_gemini_availability'
];

async function main() {
  const workingDirectory = process.argv[2] || process.cwd();

  console.log('🎯 MCP Client Connection Test');
  console.log('=============================');
  console.log(`Working directory: ${workingDirectory}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('');

  try {
    // Step 1: Load MCP configuration
    console.log('📋 Step 1: Loading MCP Configuration');
    console.log('-----------------------------------');

    const configPath = path.join(workingDirectory, '.juno_task', 'mcp.json');
    console.log(`Configuration path: ${configPath}`);

    if (!fs.existsSync(configPath)) {
      throw new Error(`MCP configuration not found at ${configPath}. Please run 'juno-task init' first.`);
    }

    const config = await MCPConfigLoader.loadConfig(workingDirectory);
    const serverConfig = await MCPConfigLoader.getDefaultServerConfig(workingDirectory);

    console.log(`✅ Configuration loaded successfully`);
    console.log(`   Default server: ${config.default_server}`);
    console.log(`   Available servers: ${Object.keys(config.mcpServers).join(', ')}`);
    console.log(`   Server command: ${serverConfig.command}`);
    console.log(`   Server args: ${serverConfig.args.join(' ')}`);
    console.log('');

    // Step 2: Create MCP client
    console.log('🔌 Step 2: Creating MCP Client');
    console.log('------------------------------');

    const mcpClient = new JunoMCPClient({
      serverName: config.default_server,
      workingDirectory: workingDirectory,
      debug: true,
      timeout: serverConfig.timeout * 1000, // Convert to milliseconds
      environment: serverConfig.env
    });

    console.log(`✅ MCP Client created with server: ${config.default_server}`);
    console.log('');

    // Step 3: Test connection
    console.log('🔗 Step 3: Testing MCP Server Connection');
    console.log('---------------------------------------');

    const startTime = Date.now();
    await mcpClient.connect();
    const connectionTime = Date.now() - startTime;

    console.log(`✅ Connection successful (${connectionTime}ms)`);
    console.log('');

    // Step 4: List all available tools
    console.log('🛠️  Step 4: Listing Available Tools');
    console.log('----------------------------------');

    const listStartTime = Date.now();
    const tools = await mcpClient.listTools();
    const listTime = Date.now() - listStartTime;

    console.log(`✅ Tools retrieved successfully (${listTime}ms)`);
    console.log(`   Found ${tools.length} tools:`);

    tools.forEach((tool, index) => {
      console.log(`   ${index + 1}. ${tool.name}`);
      if (tool.description) {
        console.log(`      Description: ${tool.description}`);
      }
    });
    console.log('');

    // Step 5: Test subagent tools
    console.log('🤖 Step 5: Testing Subagent Tools');
    console.log('---------------------------------');

    const subagentResults = [];

    for (const toolName of TOOL_NAMES_TO_TEST) {
      const toolExists = tools.some(tool => tool.name === toolName);

      if (toolExists) {
        console.log(`🔍 Testing ${toolName}...`);

        try {
          const testStartTime = Date.now();
          const result = await mcpClient.callTool({
            toolName: toolName,
            parameters: {
              instruction: `Simple test: What is 2 + 2?`,
              model: getDefaultModelForSubagent(toolName),
              max_tokens: 50
            }
          });
          const testTime = Date.now() - testStartTime;

          console.log(`   ✅ ${toolName} is working (${testTime}ms)`);
          console.log(`   📝 Response: ${result.content.substring(0, 100)}...`);

          subagentResults.push({
            name: toolName,
            status: 'working',
            responseTime: testTime,
            response: result.content.substring(0, 200)
          });
        } catch (error) {
          console.log(`   ❌ ${toolName} failed: ${error.message}`);
          subagentResults.push({
            name: toolName,
            status: 'failed',
            error: error.message
          });
        }
      } else {
        console.log(`   ⚠️  ${toolName} not found in available tools`);
        subagentResults.push({
          name: toolName,
          status: 'not_found'
        });
      }

      console.log('');
    }

    // Step 6: Test availability check tools
    console.log('✅ Step 6: Testing Availability Check Tools');
    console.log('------------------------------------------');

    const availabilityResults = [];

    for (const toolName of AVAILABILITY_TOOLS) {
      const toolExists = tools.some(tool => tool.name === toolName);

      if (toolExists) {
        console.log(`🔍 Testing ${toolName}...`);

        try {
          const testStartTime = Date.now();
          const result = await mcpClient.callTool({
            toolName: toolName,
            parameters: {}
          });
          const testTime = Date.now() - testStartTime;

          console.log(`   ✅ ${toolName} is working (${testTime}ms)`);
          console.log(`   📝 Response: ${result.content}`);

          availabilityResults.push({
            name: toolName,
            status: 'working',
            responseTime: testTime,
            response: result.content
          });
        } catch (error) {
          console.log(`   ❌ ${toolName} failed: ${error.message}`);
          availabilityResults.push({
            name: toolName,
            status: 'failed',
            error: error.message
          });
        }
      } else {
        console.log(`   ⚠️  ${toolName} not found in available tools`);
        availabilityResults.push({
          name: toolName,
          status: 'not_found'
        });
      }

      console.log('');
    }

    // Step 7: Summary Report
    console.log('📊 Step 7: Test Summary Report');
    console.log('==============================');

    const report = {
      timestamp: new Date().toISOString(),
      workingDirectory: workingDirectory,
      serverConfig: {
        name: config.default_server,
        command: serverConfig.command,
        args: serverConfig.args
      },
      connectionTest: {
        status: 'success',
        responseTime: connectionTime
      },
      toolsList: {
        status: 'success',
        responseTime: listTime,
        totalTools: tools.length
      },
      subagentTests: subagentResults,
      availabilityTests: availabilityResults
    };

    console.log('🎯 Connection Status: ✅ SUCCESS');
    console.log(`📊 Total Tools Available: ${tools.length}`);
    console.log(`🤖 Subagent Tools Working: ${subagentResults.filter(r => r.status === 'working').length}/${TOOL_NAMES_TO_TEST.length}`);
    console.log(`✅ Availability Tools Working: ${availabilityResults.filter(r => r.status === 'working').length}/${AVAILABILITY_TOOLS.length}`);

    // Disconnect
    await mcpClient.disconnect();

    // Save detailed report
    const reportPath = path.join(workingDirectory, 'mcp-test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`📄 Detailed report saved to: ${reportPath}`);

    console.log('');
    console.log('🎉 MCP Client Connection Test COMPLETED SUCCESSFULLY!');
    process.exit(0);

  } catch (error) {
    console.error('');
    console.error('❌ MCP Client Connection Test FAILED');
    console.error('=====================================');
    console.error(`Error: ${error.message}`);

    if (error.stack) {
      console.error('');
      console.error('Stack trace:');
      console.error(error.stack);
    }

    // Save error report
    const errorReport = {
      timestamp: new Date().toISOString(),
      workingDirectory: workingDirectory,
      error: {
        message: error.message,
        stack: error.stack
      }
    };

    const errorReportPath = path.join(workingDirectory, 'mcp-test-error-report.json');
    fs.writeFileSync(errorReportPath, JSON.stringify(errorReport, null, 2));
    console.error(`📄 Error report saved to: ${errorReportPath}`);

    process.exit(1);
  }
}

function getDefaultModelForSubagent(toolName) {
  const modelMap = {
    'claude_subagent': 'claude-3-haiku-20240307',
    'cursor_subagent': 'gpt-4',
    'codex_subagent': 'gpt-5',
    'gemini_subagent': 'gemini-pro'
  };

  return modelMap[toolName] || 'claude-3-haiku-20240307';
}

// Run the test
main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});