/**
 * Version information for juno-task-ts
 */

// Build artifacts inject __VERSION__. Source-mode execution uses npm's exact
// package identity instead of a stale hard-coded release value.
export const version =
  (typeof __VERSION__ !== 'undefined' && __VERSION__) ||
  process.env.npm_package_version ||
  '0.0.0-dev';

// Development flag
export const isDevelopment = typeof __DEV__ !== 'undefined' ? __DEV__ : true;
