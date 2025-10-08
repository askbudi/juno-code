#!/usr/bin/env node

/**
 * Debug keyboard input processing
 */

import { useInput } from 'ink';
import React from 'react';
import { render } from 'ink-testing-library';

// Simple test component to debug keyboard input
const DebugKeyboard = () => {
  const [output, setOutput] = React.useState([]);

  useInput((input, key) => {
    console.log('Raw input:', JSON.stringify(input));
    console.log('Key object:', key);

    const keyName = key.return ? 'return' :
                    key.escape ? 'escape' :
                    key.tab ? 'tab' :
                    key.backspace ? 'backspace' :
                    key.delete ? 'delete' :
                    input || 'unknown';

    console.log('Processed keyName:', JSON.stringify(keyName));
    console.log('---');

    setOutput(prev => [...prev, `${JSON.stringify(input)} -> ${JSON.stringify(keyName)}`]);
  });

  return null;
};

console.log('🔍 Debugging keyboard input processing...');
console.log('Press keys to see how they are processed (Ctrl+C to exit)');

const { unmount } = render(<DebugKeyboard />);

setTimeout(() => {
  unmount();
  console.log('Debug session ended');
}, 30000);