#!/usr/bin/env node
/**
 * Test script to verify the enhanced feedback collector visual output
 *
 * This script simulates the feedback collector being used and captures its output
 * to verify that the visual enhancements are working correctly.
 */

import { ConcurrentFeedbackCollector } from './dist/utils/concurrent-feedback-collector.mjs';
import { EOL } from 'node:os';

console.log('Testing Enhanced Feedback Collector UX...' + EOL);

// Create collector with custom submission handler to avoid actual feedback command
const collector = new ConcurrentFeedbackCollector({
  showHeader: true,
  verbose: false,
  onSubmit: async (feedback) => {
    console.log(EOL + '=== TEST: Feedback received ===' + EOL);
    console.log('Length:', feedback.length, 'bytes');
    console.log('Preview:', feedback.substring(0, 50) + '...');
    console.log('=== TEST: End ===' + EOL);
  }
});

// Start the collector
collector.start();

console.log(EOL + 'Visual Header Test Complete!');
console.log('The header above should show:');
console.log('  ✅ Bold blue bordered box');
console.log('  ✅ Yellow title text');
console.log('  ✅ Clear instructions for blank line submission');
console.log('  ✅ Clear instructions for --- delimiter submission');
console.log('  ✅ Visual prompt indicator (>)');
console.log(EOL);

// Simulate user input
const testInput = [
  'This is test feedback line 1',
  'This is test feedback line 2',
  'This is test feedback line 3',
  '---'  // Delimiter submission
];

console.log('Simulating input:');
testInput.forEach(line => console.log('  Input: ' + line));
console.log(EOL);

// Send simulated input
let inputBuffer = testInput.join(EOL) + EOL;
process.stdin.emit('data', inputBuffer);

// Wait a moment then stop
setTimeout(async () => {
  await collector.stop();

  console.log(EOL + '=== Test Summary ===');
  console.log('Submissions:', collector.getSubmissionCount());
  console.log('Expected: 1 submission (using --- delimiter)');

  if (collector.getSubmissionCount() === 1) {
    console.log('✅ Test PASSED: --- delimiter works correctly!');
  } else {
    console.log('❌ Test FAILED: Expected 1 submission but got', collector.getSubmissionCount());
  }

  process.exit(0);
}, 500);
