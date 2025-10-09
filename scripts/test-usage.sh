#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-all}"

echo ""
echo "Juno Task TS – Test Runner Usage"
echo "---------------------------------"
echo ""

if [[ "$MODE" == "all" || "$MODE" == "tui" ]]; then
  echo "TUI (PTY) Tests:"
  echo "  Build binary first:"
  echo "    npm --prefix juno-task-ts run build"
  echo "  Run TUI tests:"
  echo "    npm --prefix juno-task-ts run test:tui"
  echo "  Keep temp folder for inspection:"
  echo "    PRESERVE_TMP=1 npm --prefix juno-task-ts run test:tui"
  echo "  Env vars:"
  echo "    TEST_TMP_DIR=/tmp        # base tmp dir (default /tmp)"
  echo "    TUI_ARTIFACTS_DIR=...    # stable artifacts dir (default test-artifacts/tui)"
  echo ""
fi

if [[ "$MODE" == "all" || "$MODE" == "binary" ]]; then
  echo "Interactive Binary Tests:"
  echo "  Build binary first:"
  echo "    npm --prefix juno-task-ts run build"
  echo "  Run binary tests:"
  echo "    npm --prefix juno-task-ts run test:binary"
  echo "  Keep temp folder for inspection:"
  echo "    PRESERVE_TMP=1 npm --prefix juno-task-ts run test:binary"
  echo "  Env vars:"
  echo "    TEST_TMP_DIR=/tmp           # base tmp dir (default /tmp)"
  echo "    BINARY_ARTIFACTS_DIR=...    # stable artifacts dir (default test-artifacts/binary)"
  echo ""
fi

echo "Artifacts:"
echo "  TUI outputs:     juno-task-ts/test-artifacts/tui/*.txt"
echo "  Binary reports:  juno-task-ts/test-artifacts/binary/*.md"
echo ""
echo "Notes:"
echo "  - node-pty requires native bindings matching your Node version. If needed:"
echo "      npm --prefix juno-task-ts rebuild node-pty"
echo "  - For direct vitest invocation, ensure RUN_TUI=1 for PTY tests."

