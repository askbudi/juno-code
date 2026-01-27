#!/usr/bin/env bash

# kanban.sh
#
# Purpose: Kanban wrapper with Python environment setup
#
# This script ensures juno-kanban always executes from the project root directory
# with the proper Python virtual environment activated.
#
# Usage: ./.juno_task/scripts/kanban.sh [juno-kanban arguments]
# Example: ./.juno_task/scripts/kanban.sh list --limit 5
# Example: ./.juno_task/scripts/kanban.sh list -f json --raw  # (flag order normalized)
# Example: ./.juno_task/scripts/kanban.sh -f json --raw list  # (also works)
#
# Note: Global flags (-f/--format, -p/--pretty, --raw, -v/--verbose, -c/--config)
#       can be placed anywhere in the command line. This wrapper normalizes them
#       to appear before the command for juno-kanban compatibility.
#
# Environment Variables:
#   JUNO_DEBUG=true    - Show [DEBUG] diagnostic messages
#   JUNO_VERBOSE=true  - Show [KANBAN] informational messages
#   (Both default to false for silent operation)
#
# Created by: juno-code init command
# Date: Auto-generated during project initialization

set -euo pipefail  # Exit on error, undefined variable, or pipe failure

# DEBUG OUTPUT: Show that kanban.sh is being executed (only if JUNO_DEBUG=true)
# Note: JUNO_DEBUG is separate from JUNO_VERBOSE for fine-grained control
if [ "${JUNO_DEBUG:-false}" = "true" ]; then
    echo "[DEBUG] kanban.sh is being executed from: $(pwd)" >&2
fi

# Color output for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
VENV_DIR=".venv_juno"
SCRIPTS_DIR=".juno_task/scripts"
INSTALL_SCRIPT="${SCRIPTS_DIR}/install_requirements.sh"

# Logging functions
log_info() {
    # Only print if JUNO_VERBOSE is set to true
    if [ "${JUNO_VERBOSE:-false}" = "true" ]; then
        echo -e "${BLUE}[KANBAN]${NC} $1"
    fi
}

log_success() {
    # Only print if JUNO_VERBOSE is set to true
    if [ "${JUNO_VERBOSE:-false}" = "true" ]; then
        echo -e "${GREEN}[KANBAN]${NC} $1"
    fi
}

log_warning() {
    # Only print if JUNO_VERBOSE is set to true
    if [ "${JUNO_VERBOSE:-false}" = "true" ]; then
        echo -e "${YELLOW}[KANBAN]${NC} $1"
    fi
}

log_error() {
    # Always print errors regardless of JUNO_VERBOSE
    echo -e "${RED}[KANBAN]${NC} $1"
}

# Function to check if we're inside .venv_juno specifically
# CRITICAL: Don't just check for ANY venv - check if we're in .venv_juno
is_in_venv_juno() {
    # Check if VIRTUAL_ENV is set and points to .venv_juno
    if [ -n "${VIRTUAL_ENV:-}" ]; then
        # Check if VIRTUAL_ENV path contains .venv_juno
        if [[ "${VIRTUAL_ENV:-}" == *"/.venv_juno" ]] || [[ "${VIRTUAL_ENV:-}" == *".venv_juno"* ]]; then
            return 0  # Inside .venv_juno
        fi

        # Check if the basename is .venv_juno
        if [ "$(basename "${VIRTUAL_ENV:-}")" = ".venv_juno" ]; then
            return 0  # Inside .venv_juno
        fi
    fi

    return 1  # Not inside .venv_juno (or not in any venv)
}

# Function to activate virtual environment
activate_venv() {
    local venv_path="$1"

    if [ ! -d "$venv_path" ]; then
        log_error "Virtual environment not found: $venv_path"
        return 1
    fi

    # Activate the venv
    # shellcheck disable=SC1091
    if [ -f "$venv_path/bin/activate" ]; then
        source "$venv_path/bin/activate"
        log_success "Activated virtual environment: $venv_path"
        return 0
    else
        log_error "Activation script not found: $venv_path/bin/activate"
        return 1
    fi
}

# Function to ensure Python environment is ready
ensure_python_environment() {
    log_info "Checking Python environment..."

    # Step 1: Check if we're already in .venv_juno specifically
    if is_in_venv_juno; then
        log_success "Already inside .venv_juno virtual environment"
        return 0
    fi

    # Step 2: Not in .venv_juno - check if .venv_juno exists in project root
    if [ -d "$VENV_DIR" ]; then
        log_info "Found existing virtual environment: $VENV_DIR"

        # Activate the venv
        if activate_venv "$VENV_DIR"; then
            return 0
        else
            log_error "Failed to activate virtual environment"
            return 1
        fi
    fi

    # Step 3: .venv_juno doesn't exist - need to create it
    log_warning "Virtual environment not found: $VENV_DIR"
    log_info "Running install_requirements.sh to create virtual environment..."

    # Check if install_requirements.sh exists
    if [ ! -f "$INSTALL_SCRIPT" ]; then
        log_error "Install script not found: $INSTALL_SCRIPT"
        log_error "Please run 'juno-code init' to initialize the project"
        return 1
    fi

    # Make sure the script is executable
    chmod +x "$INSTALL_SCRIPT"

    # Run the install script
    if bash "$INSTALL_SCRIPT"; then
        log_success "Python environment setup completed successfully"

        # After install, activate the venv if it was created
        if [ -d "$VENV_DIR" ]; then
            if activate_venv "$VENV_DIR"; then
                return 0
            fi
        fi

        return 0
    else
        log_error "Failed to run install_requirements.sh"
        log_error "Please check the error messages above"
        return 1
    fi
}

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Navigate to project root (parent of scripts directory)
PROJECT_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

# Change to project root
cd "$PROJECT_ROOT"

# Arrays to store normalized arguments (declared at script level for proper handling)
declare -a NORMALIZED_GLOBAL_FLAGS=()
declare -a NORMALIZED_COMMAND_ARGS=()

# Normalize argument order for juno-kanban
# juno-kanban requires global flags BEFORE the command, but users often
# write them after (e.g., "list -f json --raw" instead of "-f json --raw list")
# This function reorders arguments so global flags come first.
# Results are stored in NORMALIZED_GLOBAL_FLAGS and NORMALIZED_COMMAND_ARGS arrays.
normalize_arguments() {
    # Reset arrays
    NORMALIZED_GLOBAL_FLAGS=()
    NORMALIZED_COMMAND_ARGS=()
    local found_command=false

    # Known subcommands
    local commands="create search get show update archive mark list merge"

    while [[ $# -gt 0 ]]; do
        case $1 in
            # Global flags that take a value
            -f|--format|-c|--config)
                if [[ -n "${2:-}" ]]; then
                    NORMALIZED_GLOBAL_FLAGS+=("$1" "$2")
                    shift 2
                else
                    NORMALIZED_GLOBAL_FLAGS+=("$1")
                    shift
                fi
                ;;
            # Global flags that don't take a value
            -p|--pretty|--raw|-v|--verbose|-h|--help|--version)
                NORMALIZED_GLOBAL_FLAGS+=("$1")
                shift
                ;;
            # Check if this is a known command
            *)
                # Check if this argument is a known command
                local is_command=false
                for cmd in $commands; do
                    if [[ "$1" == "$cmd" ]]; then
                        is_command=true
                        found_command=true
                        break
                    fi
                done

                # If we found a command, everything from here goes to command_args
                if $is_command || $found_command; then
                    NORMALIZED_COMMAND_ARGS+=("$1")
                    found_command=true
                else
                    # Before finding a command, treat as command arg
                    NORMALIZED_COMMAND_ARGS+=("$1")
                fi
                shift
                ;;
        esac
    done
}

# Main kanban logic
main() {
    log_info "=== juno-kanban Wrapper ==="

    # Ensure Python environment is ready
    if ! ensure_python_environment; then
        log_error "Failed to setup Python environment"
        exit 1
    fi

    log_success "Python environment ready!"

    # Normalize argument order (global flags before command)
    # This allows users to write "list -f json --raw" which gets reordered to "-f json --raw list"
    normalize_arguments "$@"

    if [ "${JUNO_DEBUG:-false}" = "true" ]; then
        echo "[DEBUG] Original args: $*" >&2
        echo "[DEBUG] Normalized global flags: ${NORMALIZED_GLOBAL_FLAGS[*]:-<none>}" >&2
        echo "[DEBUG] Normalized command args: ${NORMALIZED_COMMAND_ARGS[*]:-<none>}" >&2
    fi

    # Execute juno-kanban with normalized arguments from project root
    # Close stdin (redirect from /dev/null) to prevent hanging when called from tools
    # that don't provide stdin (similar to Issue #42 hook fix)
    # Build the command properly preserving argument quoting
    log_info "Executing juno-kanban with normalized arguments"

    # Execute with proper array expansion to preserve quoting
    # Use ${arr[@]+"${arr[@]}"} pattern to handle empty arrays with set -u
    juno-kanban ${NORMALIZED_GLOBAL_FLAGS[@]+"${NORMALIZED_GLOBAL_FLAGS[@]}"} \
                ${NORMALIZED_COMMAND_ARGS[@]+"${NORMALIZED_COMMAND_ARGS[@]}"} < /dev/null
}

# Run main function with all arguments
main "$@"
