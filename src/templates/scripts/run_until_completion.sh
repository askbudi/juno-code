#!/usr/bin/env bash

# run_until_completion.sh
#
# Purpose: Continuously run juno-code until all kanban tasks are completed
#
# This script uses a do-while loop pattern: it runs juno-code at least once,
# then checks the kanban board for tasks in backlog, todo, or in_progress status.
# If tasks remain, it continues running juno-code. This ensures juno-code's
# internal task management systems get a chance to operate even if kanban.sh
# doesn't initially detect any tasks.
#
# Usage: ./.juno_task/scripts/run_until_completion.sh [juno-code arguments]
# Example: ./.juno_task/scripts/run_until_completion.sh -s claude -i 5 -v
# Example: ./.juno_task/scripts/run_until_completion.sh -b shell -s claude -m :opus
#
# All arguments passed to this script will be forwarded to juno-code.
# The script shows all stdout/stderr from juno-code in real-time.
#
# Environment Variables:
#   JUNO_DEBUG=true    - Show [DEBUG] diagnostic messages
#   JUNO_VERBOSE=true  - Show [RUN_UNTIL] informational messages
#   (Both default to false for silent operation)
#
# Created by: juno-code init command
# Date: Auto-generated during project initialization

set -euo pipefail  # Exit on error, undefined variable, or pipe failure

# DEBUG OUTPUT: Show that run_until_completion.sh is being executed
if [ "${JUNO_DEBUG:-false}" = "true" ]; then
    echo "[DEBUG] run_until_completion.sh is being executed from: $(pwd)" >&2
fi

# Color output for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
SCRIPTS_DIR=".juno_task/scripts"
KANBAN_SCRIPT="${SCRIPTS_DIR}/kanban.sh"

# Logging functions
log_info() {
    # Only print if JUNO_VERBOSE is set to true
    if [ "${JUNO_VERBOSE:-false}" = "true" ]; then
        echo -e "${BLUE}[RUN_UNTIL]${NC} $1" >&2
    fi
}

log_success() {
    # Only print if JUNO_VERBOSE is set to true
    if [ "${JUNO_VERBOSE:-false}" = "true" ]; then
        echo -e "${GREEN}[RUN_UNTIL]${NC} $1" >&2
    fi
}

log_warning() {
    # Only print if JUNO_VERBOSE is set to true
    if [ "${JUNO_VERBOSE:-false}" = "true" ]; then
        echo -e "${YELLOW}[RUN_UNTIL]${NC} $1" >&2
    fi
}

log_error() {
    # Always print errors regardless of JUNO_VERBOSE
    echo -e "${RED}[RUN_UNTIL]${NC} $1" >&2
}

log_status() {
    # Always print status updates so user knows what's happening
    echo -e "${CYAN}[RUN_UNTIL]${NC} $1" >&2
}

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Navigate to project root (parent of scripts directory)
PROJECT_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

# Change to project root
cd "$PROJECT_ROOT"

# Function to check if there are tasks remaining
has_remaining_tasks() {
    log_info "Checking kanban for remaining tasks..."

    # Check if kanban script exists
    if [ ! -f "$KANBAN_SCRIPT" ]; then
        log_error "Kanban script not found: $KANBAN_SCRIPT"
        log_error "Please run 'juno-code init' to initialize the project"
        return 1
    fi

    # Make sure the script is executable
    chmod +x "$KANBAN_SCRIPT"

    # Run kanban list and check for "No results found"
    # We capture both stdout and stderr to handle various output formats
    local kanban_output
    if kanban_output=$("$KANBAN_SCRIPT" list --status backlog todo in_progress 2>&1); then
        if echo "$kanban_output" | grep -q "No results found"; then
            log_info "No remaining tasks found"
            return 1  # No remaining tasks
        else
            log_info "Found remaining tasks"
            if [ "${JUNO_DEBUG:-false}" = "true" ]; then
                echo "[DEBUG] Kanban output:" >&2
                echo "$kanban_output" >&2
            fi
            return 0  # Has remaining tasks
        fi
    else
        # kanban.sh returned non-zero, check if it's because no results
        if echo "$kanban_output" | grep -q "No results found"; then
            log_info "No remaining tasks found (from error output)"
            return 1
        fi
        log_error "Failed to check kanban status"
        log_error "Output: $kanban_output"
        return 1  # Treat errors as "no tasks" to prevent infinite loops
    fi
}

# Main run loop
main() {
    local iteration=0
    local max_iterations="${JUNO_RUN_UNTIL_MAX_ITERATIONS:-0}"  # 0 = unlimited

    log_status "=== Run Until Completion ==="
    log_status "Arguments to juno-code: $*"

    if [ "$max_iterations" -gt 0 ]; then
        log_status "Maximum iterations: $max_iterations"
    else
        log_status "Maximum iterations: unlimited"
    fi

    # Check if we have any arguments
    if [ $# -eq 0 ]; then
        log_warning "No arguments provided. Running juno-code with no arguments."
    fi

    # Do-while loop pattern: Run juno-code at least once, then continue while tasks remain
    # This ensures juno-code's internal task management systems get a chance to operate
    # even if kanban.sh doesn't initially detect any tasks
    while true; do
        iteration=$((iteration + 1))

        log_status ""
        log_status "=========================================="
        log_status "Iteration $iteration"
        log_status "=========================================="

        # Check max iterations limit BEFORE running (prevents exceeding limit)
        if [ "$max_iterations" -gt 0 ] && [ "$iteration" -gt "$max_iterations" ]; then
            log_warning ""
            log_warning "=========================================="
            log_warning "Maximum iterations ($max_iterations) reached. Exiting."
            log_warning "=========================================="
            exit 0
        fi

        log_status "Running juno-code with args: $*"
        log_status "------------------------------------------"

        # Run juno-code with all provided arguments
        # We run juno-code FIRST (do-while pattern), then check for remaining tasks
        if juno-code "$@"; then
            log_success "juno-code completed successfully"
        else
            local exit_code=$?
            log_warning "juno-code exited with code $exit_code"
            # Continue the loop even if juno-code fails - it might succeed next iteration
            # Some failures are expected (e.g., partial task completion)
        fi

        log_status "------------------------------------------"
        log_status "Iteration $iteration complete. Checking for more tasks..."

        # Small delay to prevent rapid-fire execution and allow user to Ctrl+C if needed
        sleep 1

        # Check for remaining tasks AFTER running juno-code (do-while pattern)
        # This ensures juno-code runs at least once, allowing its internal task
        # management systems to check kanban for updates
        if ! has_remaining_tasks; then
            log_success ""
            log_success "=========================================="
            log_success "All tasks completed! Exiting after $iteration iteration(s)."
            log_success "=========================================="
            exit 0
        fi
    done
}

# Run main function with all arguments
main "$@"
