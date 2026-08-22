#!/usr/bin/env bash
# install-exp.sh — Build yylo from source and install as "exp-yylo"
#
# This lets you run your local development build as "exp-yylo"
# while keeping the stable npm-installed "yylo" untouched.
#
# Usage:
#   npm run build:exp          # build + install exp-yylo
#   npm run uninstall:exp      # remove exp-yylo symlink

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ACTION="${1:-install}"

# Determine the global bin directory via npm prefix
GLOBAL_BIN="$(npm config get prefix)/bin"

EXP_BINARY="$GLOBAL_BIN/exp-yylo"
TARGET="$PROJECT_DIR/dist/bin/yylo.sh"

case "$ACTION" in
  install)
    # Build from source to ensure we have the latest code
    echo "Building yylo from source..."
    (cd "$PROJECT_DIR" && npm run build)
    echo ""

    # Verify build output exists
    if [ ! -f "$TARGET" ]; then
      echo "Error: dist/bin/yylo.sh not found. Build failed."
      exit 1
    fi

    # Ensure target is executable
    chmod +x "$TARGET"

    # Create symlink (overwrite if exists)
    ln -sf "$TARGET" "$EXP_BINARY"
    echo "Installed: exp-yylo -> $TARGET"
    echo "Run 'exp-yylo --help' to verify."
    ;;

  uninstall)
    if [ -L "$EXP_BINARY" ]; then
      rm "$EXP_BINARY"
      echo "Removed: $EXP_BINARY"
    elif [ -e "$EXP_BINARY" ]; then
      echo "Warning: $EXP_BINARY exists but is not a symlink. Not removing."
      exit 1
    else
      echo "Nothing to remove: $EXP_BINARY does not exist."
    fi
    ;;

  *)
    echo "Usage: $0 [install|uninstall]"
    exit 1
    ;;
esac
