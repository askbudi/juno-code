import { defineConfig } from 'vitest/config';

// Dedicated Vitest config for TUI/PTY tests to avoid worker-thread issues
// - Runs in Node environment
// - Uses forks pool with a single worker
// - Includes only PTY-driven TUI tests

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/cli/__tests__/init-command-tui-execution.test.ts'
    ],
    exclude: [
      'node_modules',
      'dist'
    ],
    testTimeout: 60000,
    hookTimeout: 20000,
    retry: 0,
    bail: 1,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        maxForks: 1
      }
    },
    reporters: ['verbose'],
    env: {
      NO_COLOR: '1',
      NODE_ENV: 'test'
    }
  }
});
