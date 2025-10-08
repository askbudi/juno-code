#!/usr/bin/env node

/**
 * Test script to verify keyboard input handling in feedback command
 */

import { spawn } from 'child_process';
import path from 'path';

const cliPath = path.join(process.cwd(), 'dist', 'bin', 'cli.mjs');

console.log('🧪 Testing Feedback Command Keyboard Input');
console.log('This will test if delete/backspace keys work in feedback prompt editor\n');

const child = spawn('node', [cliPath, 'feedback', '--interactive'], {
  stdio: 'inherit',
  cwd: '/tmp/juno-feedback-test'
});

child.on('exit', (code) => {
  console.log(`\n🏁 Test completed with exit code: ${code}`);
  process.exit(code);
});

child.on('error', (error) => {
  console.error('❌ Error running test:', error);
  process.exit(1);
});