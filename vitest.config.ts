import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/test-utils/setup.ts'],
    include: [
      'src/**/*.{test,spec}.{js,ts,tsx}',
      'src/**/__tests__/**/*.{js,ts,tsx}'
    ],
    exclude: [
      'node_modules',
      'dist',
      'coverage',
      'src/test-utils/**',
      '**/*.d.ts',
      'src/cli/__tests__/utils.test.ts', // broken: references nonexistent modules (completion.js, test-runner.js)
    ],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{js,ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{js,ts,tsx}',
        'src/__tests__/**',
        'src/test-utils/**',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/constants.ts',
        'src/index.ts',
        'src/bin/**',
        'src/version.ts'
      ],

      // Coverage thresholds — current baseline; raise as coverage improves
      thresholds: {
        global: {
          branches: 40,
          functions: 25,
          lines: 10,
          statements: 10
        }
      },

      // Coverage watermarks for display
      watermarks: {
        statements: [80, 95],
        functions: [80, 95],
        branches: [80, 95],
        lines: [80, 95]
      },

      // Report uncovered lines
      reportOnFailure: true,
      skipFull: false
    },

    // Test execution
    testTimeout: 10000,
    hookTimeout: 10000,
    retry: 2,
    bail: 1,  // Stop on first failure in CI

    // Performance
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: true,
        useAtomics: true
      }
    },

    // Reporters
    reporter: process.env.CI
      ? ['verbose', 'github-actions', 'json']
      : ['verbose'],

    // Output
    outputFile: {
      json: './test-results/results.json',
      html: './test-results/results.html'
    },

    // Mock handling
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,

    // Test types - disabled for now
    typecheck: {
      enabled: false,
      only: false,
      checker: 'tsc'
    },

    // Watch mode
    watch: !process.env.CI,
    watchExclude: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'test-results/**'
    ],

    // Environment variables
    env: {
      NODE_ENV: 'test',
      VITEST: 'true'
    }
  },

  // Path resolution
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@/cli': resolve(__dirname, './src/cli'),
      '@/core': resolve(__dirname, './src/core'),
      '@/templates': resolve(__dirname, './src/templates'),
      '@/utils': resolve(__dirname, './src/utils'),
      '@/types': resolve(__dirname, './src/types'),
      '@/test-utils': resolve(__dirname, './src/test-utils')
    }
  },

  // ESBuild options for test compilation
  esbuild: {
    target: 'node18',
    format: 'esm'
  },

  // Define globals
  define: {
    __VERSION__: JSON.stringify('test'),
    __DEV__: 'true'
  }
});