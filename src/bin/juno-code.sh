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

# Routing must never execute resolver bytes from a mutable product/task
# checkout. Source and packaged layouts both place templates beside bin/utils.
PACKAGED_CONTROLLER_RESOLVER="${SCRIPT_DIR}/../templates/scripts/controller_resolver.py"

# Path to bootstrap.sh (should be in .juno_task/scripts after init)
BOOTSTRAP_SCRIPT=".juno_task/scripts/bootstrap.sh"

classify_prebootstrap_command() {
    PREBOOTSTRAP_COMMAND=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --) shift; PREBOOTSTRAP_COMMAND="${1:-}"; break ;;
            -q|--quiet|--silent|--no-color|--enable-feedback|--no-hooks|--no-hook) shift ;;
            -c|--config|-l|--log-file|--log-level|-s|--subagent|-b|--backend|-m|--model|--agents|--mcp-timeout|-r|--resume|--stale-threshold|--on-hourly-limit|--thinking)
                [ "$#" -ge 2 ] || return 1
                shift 2 ;;
            --config=*|--log-file=*|--log-level=*|--subagent=*|--backend=*|--model=*|--agents=*|--mcp-timeout=*|--resume=*|--stale-threshold=*|--on-hourly-limit=*|--thinking=*|-c=*|-l=*|-s=*|-b=*|-m=*|-r=*) shift ;;
            -v|--verbose)
                shift
                case "${1:-}" in 0|1|2|true|false|yes|no) shift ;; esac ;;
            --verbose=*|-v=*) shift ;;
            *) PREBOOTSTRAP_COMMAND="$1"; break ;;
        esac
    done
    case "$PREBOOTSTRAP_COMMAND" in
        -V|--version|info|where|kanban|task|merge) return 0 ;;
        doctor) [ "${2:-}" = "workspace" ] && return 0 ;;
    esac
    return 1
}

require_compatible_node() {
    local version major minor
    if ! command -v node >/dev/null 2>&1; then
        echo "juno-code: Node.js >=20.10 is required; no node executable was found" >&2
        return 69
    fi
    version="$(node -p 'process.versions.node' 2>/dev/null || true)"
    major="${version%%.*}"
    minor="${version#*.}"; minor="${minor%%.*}"
    if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || (( major < 20 || (major == 20 && minor < 10) )); then
        echo "juno-code: refusing to run this distribution under unsupported Node ${version:-unknown}; select Node.js >=20.10 and retry" >&2
        return 69
    fi
}

route_registered_product_control() {
    local operation="${1:-}"
    shift || true
    case "$operation" in kanban|task|merge) ;; *) return 1 ;; esac
    local resolution fields controller invocation role branch source runtime
    [ -f "$PACKAGED_CONTROLLER_RESOLVER" ] || return 1
    if ! resolution="$(JUNO_TASK_ROOT= JUNO_CONTROLLER_BRANCH= JUNO_WORKSPACE_ROLE= JUNO_WORKSPACE_ENFORCEMENT=off \
        python3 "$PACKAGED_CONTROLLER_RESOLVER" --cwd "$PWD" --operation diagnostic)"; then
        return 2
    fi
    fields="$(printf '%s' "$resolution" | python3 -c 'import json,sys; x=json.load(sys.stdin); print(x["path"]); print(x["current_root"]); print(x["role"]); print(x.get("expected_branch") or ""); print(x["source"])')" || return 2
    controller="$(printf '%s\n' "$fields" | sed -n '1p')"
    invocation="$(printf '%s\n' "$fields" | sed -n '2p')"
    role="$(printf '%s\n' "$fields" | sed -n '3p')"
    branch="$(printf '%s\n' "$fields" | sed -n '4p')"
    source="$(printf '%s\n' "$fields" | sed -n '5p')"
    [ "$controller" != "$invocation" ] || return 1
    case "$role" in task|integration-owner) ;; *)
        echo "juno-code: control-plane routing refused persisted workspace role '$role'; run yy doctor workspace" >&2
        return 2 ;;
    esac
    runtime="$(git -C "$controller" config --worktree --get juno.controller.runtimeExecutable 2>/dev/null || true)"
    if [ -z "$runtime" ] || [ ! -f "$runtime" ]; then
        echo "juno-code: registered controller runtime is missing or stale; run yy doctor workspace from '$invocation'" >&2
        return 2
    fi
    require_compatible_node || return $?
    export JUNO_TASK_ROOT="$controller"
    export JUNO_CONTROLLER_BRANCH="$branch"
    export JUNO_CONTROLLER_SOURCE="$source"
    export JUNO_WORKSPACE_ROLE=controller
    export JUNO_WORKSPACE_ENFORCEMENT=strict
    export JUNO_CONTROL_INVOCATION_ROOT="$invocation"
    export JUNO_CONTROL_INVOCATION_ROLE="$role"
    export JUNO_CONTROL_EFFECTIVE_ROOT="$controller"
    export JUNO_CONTROL_OPERATION="$operation"
    cd "$controller"
    exec node "$runtime" "$@"
}

# Main execution flow
main() {
    # Classify discovery and control-plane commands before touching checkout
    # bootstrap. Registered product worktrees dispatch through the controller's
    # pinned runtime; controller calls retain the current packaged CLI.
    if classify_prebootstrap_command "$@"; then
        route_registered_product_control "$PREBOOTSTRAP_COMMAND" "$@" || {
            local status=$?
            [ "$status" -eq 1 ] || return "$status"
        }
        require_compatible_node
        exec node "$CLI_ENTRYPOINT" "$@"
    fi

    require_compatible_node

    # Check if we're in an initialized juno-code project
    if [ -d ".juno_task" ] && [ -f "$BOOTSTRAP_SCRIPT" ]; then
        # Project is initialized - use bootstrap.sh to setup environment and run CLI
        # Bootstrap.sh will:
        # 1. Check if we're in a venv
        # 2. Check if .venv_juno exists, create if needed
        # 3. Activate venv if needed
        # 4. Execute the command we pass to it

        # Execute through bash instead of chmodding a tracked managed script.
        # Agent bootstrap must not alter exact task/candidate worktree bytes.
        exec bash "$BOOTSTRAP_SCRIPT" node "$CLI_ENTRYPOINT" "$@"
    else
        # Not initialized or bootstrap missing - run CLI directly
        # This allows 'juno-code init' to work without bootstrap
        exec node "$CLI_ENTRYPOINT" "$@"
    fi
}

# Run main with all arguments
main "$@"
