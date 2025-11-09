#!/usr/bin/env bash

# juno-code.sh
#
# Purpose: Shell wrapper for juno-code CLI
#
# This script integrates bootstrap.sh with the main CLI entry point.
# When users run 'juno-code', this wrapper:
# 1. Checks if project is initialized (.juno_task exists)
# 2. If initialized: Runs bootstrap.sh to ensure Python environment is ready
# 3. Executes the actual TypeScript CLI with all arguments
#
# Architecture: juno-code = shell-shim + juno-code logic
#
# Created by: juno-code build system
# Auto-generated during npm build

set -euo pipefail

# Get the directory where this script is located
# IMPORTANT: Resolve symlinks first (npm creates symlinks in /usr/local/bin or /opt/homebrew/bin)
# We need the real path to find cli.mjs in the same directory
if [ -L "${BASH_SOURCE[0]}" ]; then
    # Follow the symlink to get the real script location
    REAL_SCRIPT="$(readlink "${BASH_SOURCE[0]}")"
    # If it's a relative symlink, make it absolute relative to the symlink location
    if [[ "$REAL_SCRIPT" != /* ]]; then
        REAL_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd "$(dirname "$REAL_SCRIPT")" && pwd)/$(basename "$REAL_SCRIPT")"
    fi
    SCRIPT_DIR="$(cd "$(dirname "$REAL_SCRIPT")" && pwd)"
else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# Path to the actual CLI entrypoint (Node.js)
CLI_ENTRYPOINT="${SCRIPT_DIR}/cli.mjs"

# Path to bootstrap.sh (should be in .juno_task/scripts after init)
BOOTSTRAP_SCRIPT=".juno_task/scripts/bootstrap.sh"

# Main execution flow
main() {
    # Check if we're in an initialized juno-code project
    if [ -d ".juno_task" ] && [ -f "$BOOTSTRAP_SCRIPT" ]; then
        # Project is initialized - use bootstrap.sh to setup environment and run CLI
        # Bootstrap.sh will:
        # 1. Check if we're in a venv
        # 2. Check if .venv_juno exists, create if needed
        # 3. Activate venv if needed
        # 4. Execute the command we pass to it

        # Make sure bootstrap script is executable
        chmod +x "$BOOTSTRAP_SCRIPT" 2>/dev/null || true

        # Delegate to bootstrap.sh with node CLI as the command to execute
        # Bootstrap will setup environment then exec our CLI
        exec "$BOOTSTRAP_SCRIPT" node "$CLI_ENTRYPOINT" "$@"
    else
        # Not initialized or bootstrap missing - run CLI directly
        # This allows 'juno-code init' to work without bootstrap
        exec node "$CLI_ENTRYPOINT" "$@"
    fi
}

# Run main with all arguments
main "$@"
