#!/usr/bin/env node
/**
 * Merges TypeScript (vitest/V8) and Python (pytest-cov) LCOV coverage reports
 * into a single unified LCOV file.
 *
 * LCOV is an additive format — records for different source files can be
 * concatenated safely as long as they don't cover the same files (TS tests
 * cover .ts, Python tests cover .py, so there is no overlap).
 *
 * Usage: node scripts/merge-coverage.js
 * Reads:  coverage/lcov.info          (vitest V8)
 *         coverage/python-lcov.info   (pytest-cov)
 * Writes: coverage/merged-lcov.info   (combined)
 */

const fs = require('fs');
const path = require('path');

const coverageDir = path.resolve(__dirname, '..', 'coverage');
const tsLcov = path.join(coverageDir, 'lcov.info');
const pyLcov = path.join(coverageDir, 'python-lcov.info');
const merged = path.join(coverageDir, 'merged-lcov.info');

const parts = [];

if (fs.existsSync(tsLcov)) {
  parts.push(fs.readFileSync(tsLcov, 'utf8').trimEnd());
  console.log('  TypeScript coverage: coverage/lcov.info');
} else {
  console.warn('  Warning: TypeScript LCOV not found (coverage/lcov.info)');
}

if (fs.existsSync(pyLcov)) {
  parts.push(fs.readFileSync(pyLcov, 'utf8').trimEnd());
  console.log('  Python coverage:     coverage/python-lcov.info');
} else {
  console.warn('  Warning: Python LCOV not found (coverage/python-lcov.info)');
}

if (parts.length === 0) {
  console.error('Error: No coverage files found to merge.');
  process.exit(1);
}

fs.writeFileSync(merged, parts.join('\n') + '\n');
console.log('  Merged coverage:     coverage/merged-lcov.info');
console.log(`  (${parts.length} report(s) merged)`);
