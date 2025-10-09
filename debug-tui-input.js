#!/usr/bin/env node

/**
 * Debug script to test TUI input processing
 */

import { execa } from 'execa';
import path from 'node:path';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function debugTUIInput() {
  console.log('🐛 Debugging TUI Input Processing');
  console.log('===============================\n');

  // Create temporary directory
  const tempDir = await fs.mkdtemp(path.join('/tmp', 'juno-debug-'));
  console.log(`📁 Test directory: ${tempDir}`);

  try {
    const binaryPath = path.resolve(__dirname, 'dist/bin/cli.mjs');

    if (!await fs.pathExists(binaryPath)) {
      throw new Error(`Binary not found: ${binaryPath}. Run 'npm run build' first.`);
    }

    // Test with very simple input to see what happens
    const simpleInput = [
      '', // Project directory - accept default
      'Simple test task', // Task description
      '', // Finish task input
      '2', // Select codex
      'y', // Git setup
      'https://github.com/test/test.git' // Git URL
    ];

    const input = simpleInput.join('\n') + '\n';

    console.log('📝 Input sequence:');
    simpleInput.forEach((inp, i) => {
      console.log(`   ${i + 1}. ${inp === '' ? '[Enter]' : `"${inp}"`}`);
    });

    console.log('\n🚀 Executing init command...');

    const result = await execa('node', [binaryPath, 'init'], {
      cwd: tempDir,
      input: input,
      timeout: 30000,
      reject: false,
      env: {
        NO_COLOR: '1',
        CI: '', // Empty string instead of 'false'
        NODE_ENV: 'development', // Prevent test environment detection
        FORCE_INTERACTIVE: '1',
        JUNO_TASK_CONFIG: ''
      }
    });

    console.log(`\n📊 Results:`);
    console.log(`   Exit Code: ${result.exitCode}`);
    console.log(`   Success: ${result.exitCode === 0 ? '✅' : '❌'}`);

    // Show all stdout output
    console.log(`\n📋 STDOUT (complete):`);
    console.log('---');
    console.log(result.stdout || '(empty)');
    console.log('---');

    // Show any stderr
    if (result.stderr && result.stderr.trim()) {
      console.log(`\n❌ STDERR:`);
      console.log(result.stderr);
    }

    // Check what files were created
    console.log(`\n📁 Files created:`);
    const allFiles = await fs.readdir(tempDir, { recursive: true });
    allFiles.filter(f => f !== '.DS_Store').forEach(f => console.log(`   - ${f}`));

    // Check init.md content specifically
    const initPath = path.join(tempDir, '.juno_task/init.md');
    if (await fs.pathExists(initPath)) {
      const initContent = await fs.readFile(initPath, 'utf-8');
      console.log(`\n📄 init.md content:`);
      console.log('---');
      console.log(initContent);
      console.log('---');
    }

    // Check config.json content
    const configPath = path.join(tempDir, '.juno_task/config.json');
    if (await fs.pathExists(configPath)) {
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      console.log(`\n⚙️ config.json relevant fields:`);
      console.log(`   defaultSubagent: ${config.defaultSubagent}`);
      console.log(`   workingDirectory: ${config.workingDirectory}`);
    }

    console.log(`\n🔍 Manual inspection:`);
    console.log(`   cd ${tempDir} && ls -la`);
    console.log(`   cat ${tempDir}/.juno_task/init.md`);
    console.log(`🧹 Clean up: rm -rf ${tempDir}`);

    return { success: result.exitCode === 0, tempDir };

  } catch (error) {
    console.error('❌ Debug failed:', error.message);
    console.log(`📁 Directory preserved: ${tempDir}`);
    return { success: false, tempDir, error: error.message };
  }
}

debugTUIInput().then(result => {
  console.log('\n' + '='.repeat(50));
  if (result.success) {
    console.log('✅ Debug completed successfully');
  } else {
    console.log('❌ Debug failed');
  }
  if (result.error) {
    console.log(`Error: ${result.error}`);
  }
  process.exit(result.success ? 0 : 1);
});