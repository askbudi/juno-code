import { spawn } from 'child_process';

console.log('Test: spawn with null values to override');
const env = {
  CUSTOM_VAR: 'test',
  HOME: null,
  PATH: null,
  USER: null,
  SHELL: null,
  TERM: null,
  LOGNAME: null
};

// Filter out null values (since spawn doesn't accept them)
const filteredEnv = Object.fromEntries(
  Object.entries(env).filter(([k, v]) => v !== null)
);

console.log('Filtered env:', filteredEnv);

const proc = spawn('python3', ['-c', 'import os; print(sorted(os.environ.keys()))'], {
  env: filteredEnv
});
proc.stdout.on('data', (data) => console.log('Result:', data.toString().trim()));
await new Promise(resolve => proc.on('close', resolve));
