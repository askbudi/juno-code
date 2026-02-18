import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Fast test config: excludes slow binary-execution and integration tests.
 * Use `npm test -- --run` for fast feedback during development.
 * Use `npm run test:full` to run ALL tests including binary, integration, and Python.
 */
export default mergeConfig(baseConfig, defineConfig({
  test: {
    exclude: [
      'node_modules',
      'dist',
      'coverage',
      'src/test-utils/**',
      '**/*.d.ts',
      // Slow tests excluded from fast runs
      'src/cli/__tests__/binary-execution*.test.ts',
      'src/cli/__tests__/*-binary-execution*.test.ts',
      'src/cli/__tests__/*-tui-execution*.test.ts',
      'src/__tests__/integration/**',
      'src/__tests__/e2e/**',
    ],
    // No coverage in fast mode for speed
    coverage: {
      enabled: false,
    },
  },
}));
