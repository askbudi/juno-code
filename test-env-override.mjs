import { spawn } from 'child_process';

// Test 1: Regular spawn with env object
console.log('Test 1: spawn with env object (no undefined values)');
const proc1 = spawn('python3', ['-c', 'import os; print(sorted(os.environ.keys()))'], {
  env: {
    CUSTOM_VAR: 'test'
  }
});
proc1.stdout.on('data', (data) => console.log('Result:', data.toString().trim()));
await new Promise(resolve => proc1.on('close', resolve));

// Test 2: spawn with undefined values
console.log('\nTest 2: spawn with env object (with undefined values to override)');
const proc2 = spawn('python3', ['-c', 'import os; print(sorted(os.environ.keys()))'], {
  env: {
    CUSTOM_VAR: 'test',
    HOME: undefined,
    PATH: undefined,
    USER: undefined
  }
});
proc2.stdout.on('data', (data) => console.log('Result:', data.toString().trim()));
await new Promise(resolve => proc2.on('close', resolve));
