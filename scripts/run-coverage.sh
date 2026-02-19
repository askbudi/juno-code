#!/usr/bin/env bash
# Unified coverage runner: TypeScript (vitest/V8) + Python (pytest-cov)
# Runs both coverage suites and merges LCOV output into coverage/merged-lcov.info
set -o pipefail

cd "$(dirname "$0")/.." || exit 1

ts_ok=0
py_ok=0

echo "=== TypeScript coverage (vitest) ==="
npx vitest run --coverage || ts_ok=$?

echo ""
echo "=== Python coverage (pytest-cov) ==="
npm run test:coverage:python || py_ok=$?

echo ""
echo "=== Merging coverage reports ==="
node scripts/merge-coverage.js

if [ $ts_ok -ne 0 ] && [ $py_ok -ne 0 ]; then
  echo ""
  echo "Both TypeScript and Python coverage had failures."
  exit 1
fi

echo ""
echo "Coverage reports generated in coverage/"
echo "  TypeScript: coverage/lcov.info"
echo "  Python:     coverage/python-lcov.info"
echo "  Merged:     coverage/merged-lcov.info"
