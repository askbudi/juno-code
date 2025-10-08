#!/usr/bin/env node

/**
 * Test script for simplified init command
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a temporary directory for testing
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-init-test-'));
console.log(`Testing in directory: ${testDir}`);

// Simulated user inputs for the 5-step flow
const userInput =
  testDir + '\n' +                           // Step 1: Project Root
  'Build a simple REST API with Node.js and Express\n\nFeatures:\n- User authentication\n- Database integration\n- API endpoints\n' +  // Step 2: Main Task (no trailing newline before Ctrl+D)
  '\x04' +                                   // Ctrl+D to end multi-line input
  '1\n' +                                   // Step 3: Editor Selection (VS Code)
  'y\n' +                                   // Step 4: Git Setup (yes)
  '\n' +                                    // Step 4: Git URL (skip)
  '1\n';                                   // Step 5: Override existing files (if needed)

const child = spawn('node', [
  path.join(__dirname, 'dist/bin/cli.mjs'),
  'init',
  '--interactive'
], {
  cwd: testDir,
  stdio: ['pipe', 'pipe', 'pipe']
});

// Send user input
child.stdin.write(userInput);
child.stdin.end();

let stdout = '';
let stderr = '';

child.stdout.on('data', (data) => {
  stdout += data.toString();
  process.stdout.write(data);
});

child.stderr.on('data', (data) => {
  stderr += data.toString();
  process.stderr.write(data);
});

child.on('close', (code) => {
  console.log(`\n\nProcess exited with code: ${code}`);

  if (code === 0) {
    console.log('\n✅ SUCCESS: Init command completed successfully');

    // Check created files
    const files = [
      '.juno_task/prompt.md',
      '.juno_task/init.md',
      'README.md'
    ];

    console.log('\n📁 Created files:');
    files.forEach(file => {
      const filePath = path.join(testDir, file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        console.log(`  ✅ ${file} (${content.length} chars)`);

        if (file === '.juno_task/prompt.md') {
          console.log('\n📝 prompt.md content preview:');
          console.log(content.substring(0, 300) + '...');
        }
      } else {
        console.log(`  ❌ ${file} (missing)`);
      }
    });
  } else {
    console.log('\n❌ FAILED: Init command failed');
    console.log('STDERR:', stderr);
  }

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log(`\n🧹 Cleaned up test directory: ${testDir}`);
});

child.on('error', (error) => {
  console.error('Failed to start subprocess:', error);
  process.exit(1);
});