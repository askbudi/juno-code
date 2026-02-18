/**
 * Test setup file for juno-task-ts
 * This file is loaded before all tests
 */

import '@testing-library/jest-dom';

// Mock environment variables for tests
process.env.NODE_ENV = 'test';
process.env.VITEST = 'true';

// Global test configuration
beforeAll(() => {
  // Set timezone for consistent date testing
  process.env.TZ = 'UTC';
});

beforeEach(() => {
  // Clear all mocks before each test
  vi.clearAllMocks();

  // Reset console methods
  vi.restoreAllMocks();
});

afterEach(() => {
  // Clean up after each test
  vi.clearAllTimers();
});

// Extend expect with custom matchers if needed
expect.extend({
  // Custom matchers can be added here
});

// Global test utilities
global.testUtils = {
  // Add global test utilities here
};