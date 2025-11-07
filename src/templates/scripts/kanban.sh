#!/bin/bash
#
# Kanban Wrapper Script
#
# This script ensures juno-kanban always executes from the project root directory,
# maintaining a single consistent database location regardless of where this script is called from.
#
# Usage: ./.juno_task/scripts/kanban.sh [juno-kanban arguments]
# Example: ./.juno_task/scripts/kanban.sh list --limit 5
#

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Navigate to project root (parent of scripts directory)
PROJECT_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

# Change to project root and execute juno-kanban with all passed arguments
cd "$PROJECT_ROOT" && juno-kanban "$@"
