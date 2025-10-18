#!/usr/bin/env node
/**
 * Manual Test: MCP Progress Events with Input Redisplay
 *
 * This script tests the fix for Issue #2 - MCP Progress Events Disrupting User Input
 *
 * To test:
 * 1. Run: node test-progress-redisplay.mjs
 * 2. Start typing some text (e.g., "hello world")
 * 3. Wait for simulated progress events to appear
 * 4. Verify that your typed text is redisplayed after progress events
 * 5. Expected: After progress flush, you should see "> hello world"
 * 6. Press Ctrl-D to exit
 */

import { ConcurrentFeedbackCollector } from './dist/index.mjs';

console.log('🧪 Testing MCP Progress Events with Input Redisplay\n');
console.log('Instructions:');
console.log('1. Start typing some text (e.g., "hello world")');
console.log('2. Wait 3 seconds for simulated progress events');
console.log('3. Verify your typed text is redisplayed after progress');
console.log('4. Press Ctrl-D to exit\n');

const collector = new ConcurrentFeedbackCollector({
  command: 'echo',
  commandArgs: ['echo', 'Feedback submitted:'],
  verbose: true,
  showHeader: true,
  progressFlushInterval: 3000, // Flush every 3 seconds for testing
  onSubmit: async (feedback) => {
    console.log('\n✅ Feedback submitted:', feedback);
  }
});

// Simulate MCP progress events every 2 seconds
let progressCount = 0;
const progressSimulator = setInterval(() => {
  progressCount++;
  // These will be buffered and flushed every 3 seconds
  console.error(`📊 MCP Progress Event ${progressCount}: Processing subagent iteration...`);
  console.error(`   ⚙️  Tool execution: Reading file system...`);
  console.error(`   🔍 Analysis: Parsing code structure...`);
}, 2000);

// Cleanup on exit
process.on('SIGINT', () => {
  clearInterval(progressSimulator);
  process.exit(0);
});

// Start the feedback collector
collector.start();

// Wait for user to exit
await collector.waitForCompletion();
clearInterval(progressSimulator);

console.log('\n✅ Test completed!');
