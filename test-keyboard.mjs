#!/usr/bin/env node

/**
 * Test script to verify keyboard input handling in PromptEditor
 */

console.log('🧪 Testing Keyboard Input Handling');
console.log('This script will test if delete/backspace keys work in TUI prompt editors\n');

import { spawn } from 'child_process';
import path from 'path';

const cliPath = path.join(process.cwd(), 'dist', 'bin', 'cli.mjs');

console.log('📝 Testing: init command interactive prompt...');
console.log('Instructions:');
console.log('1. Type some text');
console.log('2. Try pressing Backspace key - should delete characters');
console.log('3. Try pressing Delete key - should delete characters');
console.log('4. Press ESC to exit');
console.log('\nStarting CLI...\n');

const child = spawn('node', [cliPath, 'init', '--interactive-prompt'], {
  stdio: 'inherit',
  cwd: '/tmp/juno-keyboard-test'
});

child.on('exit', (code) => {
  console.log(`\n🏁 Test completed with exit code: ${code}`);
  process.exit(code);
});

child.on('error', (error) => {
  console.error('❌ Error running test:', error);
  process.exit(1);
});