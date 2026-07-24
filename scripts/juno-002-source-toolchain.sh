#!/usr/bin/env bash
# Repository-local Juno 2 source installer and executable selector.
set -euo pipefail

SCRIPT_PATH=${BASH_SOURCE[0]}
while [[ -L "$SCRIPT_PATH" ]]; do
    LINK_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd -P)
    LINK_TARGET=$(readlink "$SCRIPT_PATH")
    [[ "$LINK_TARGET" == /* ]] && SCRIPT_PATH=$LINK_TARGET || SCRIPT_PATH="$LINK_DIR/$LINK_TARGET"
done
SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd -P)
JUNO_CODE_ROOT=$(cd "$SCRIPT_DIR/.." && pwd -P)
REPOSITORY_ROOT=$(cd "$JUNO_CODE_ROOT/.." && pwd -P)
POLICY_FILE="$JUNO_CODE_ROOT/src/templates/scripts/juno-toolchain-policy.sh"
# shellcheck source=../src/templates/scripts/juno-toolchain-policy.sh
source "$POLICY_FILE"

STATE_DIR="${JUNO_002_STATE_DIR:-$REPOSITORY_ROOT/.juno_toolchain/juno-002}"
BIN_DIR="$STATE_DIR/bin"
SELECTED_FILE="$STATE_DIR/selected"
PREVIOUS_FILE="$STATE_DIR/previous"
NPM_PREFIX="$STATE_DIR/npm"
VENV_DIR="$STATE_DIR/.venv_juno"
NPM_CMD="${JUNO_002_NPM:-npm}"
PYTHON_CMD="${JUNO_002_PYTHON:-python3}"
CODE_SOURCE="${JUNO_002_CODE_SOURCE:-$JUNO_CODE_ROOT}"
KANBAN_SOURCE="${JUNO_002_KANBAN_SOURCE:-$REPOSITORY_ROOT/juno_kanban}"

fail() { echo "juno-002-toolchain: $*" >&2; exit 1; }
canonical_dir() { (cd "$1" && pwd -P); }

write_selection() {
    local destination=$1 code_executable=$2 kanban_executable=$3 code_source=$4 kanban_source=$5 temp
    mkdir -p "$(dirname "$destination")"
    temp=$(mktemp "${destination}.tmp.XXXXXX")
    printf '%s\n%s\n%s\n%s\n' "$code_executable" "$kanban_executable" "$code_source" "$kanban_source" > "$temp"
    mv "$temp" "$destination"
}

load_selection() {
    local file=${1:-$SELECTED_FILE}
    [[ -f "$file" ]] || fail "selector does not exist: $file; run install or select"
    [[ $(wc -l < "$file" | tr -d ' ') -eq 4 ]] || fail "invalid selector state: $file"
    SELECTED_CODE=$(sed -n '1p' "$file")
    SELECTED_KANBAN=$(sed -n '2p' "$file")
    SELECTED_CODE_SOURCE=$(sed -n '3p' "$file")
    SELECTED_KANBAN_SOURCE=$(sed -n '4p' "$file")
}

validate_code() {
    local executable=$1 output
    [[ -x "$executable" ]] || fail "juno-code executable is missing or not executable: $executable"
    output=$(cd "$STATE_DIR" && "$executable" --version 2>&1) || fail "juno-code --version failed: $executable: $output"
    [[ "$output" =~ (^|[^0-9])2\.0\.1([^0-9]|$) ]] || fail "juno-code identity rejected: executable=$executable output=$output required=2.0.1"
    printf 'juno-code identity: executable=%s version=2.0.1\n' "$executable" >&2
}

select_paths() {
    local code_executable=$1 kanban_executable=$2 code_source=$3 kanban_source=$4
    validate_code "$code_executable"
    juno_kanban_check_executable "$kanban_executable" selected
    if [[ -f "$SELECTED_FILE" ]]; then cp "$SELECTED_FILE" "$PREVIOUS_FILE"; fi
    write_selection "$SELECTED_FILE" "$code_executable" "$kanban_executable" "$code_source" "$kanban_source"
    echo "selected: juno-code=$code_executable juno-kanban=$kanban_executable"
}

install_sources() {
    CODE_SOURCE=$(canonical_dir "$CODE_SOURCE")
    KANBAN_SOURCE=$(canonical_dir "$KANBAN_SOURCE")
    [[ -f "$CODE_SOURCE/package.json" ]] || fail "juno-code source is invalid: $CODE_SOURCE"
    [[ -f "$KANBAN_SOURCE/setup.py" ]] || fail "juno-kanban source is invalid: $KANBAN_SOURCE"
    mkdir -p "$STATE_DIR" "$BIN_DIR" "$NPM_PREFIX"

    if [[ ! -x "$VENV_DIR/bin/python" ]]; then "$PYTHON_CMD" -m venv "$VENV_DIR"; fi
    "$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --upgrade "$KANBAN_SOURCE"
    "$NPM_CMD" run build --prefix "$CODE_SOURCE"
    "$NPM_CMD" install --prefix "$NPM_PREFIX" --no-audit --no-fund --ignore-scripts "$CODE_SOURCE"

    local code_executable="$NPM_PREFIX/node_modules/.bin/yy"
    local kanban_executable="$VENV_DIR/bin/juno-kanban"
    validate_code "$code_executable"
    juno_kanban_check_executable "$kanban_executable" installed-source

    ln -sfn "$SCRIPT_DIR/juno-002-source-toolchain.sh" "$BIN_DIR/yy-juno-002"
    ln -sfn "$SCRIPT_DIR/juno-002-source-toolchain.sh" "$BIN_DIR/juno-kanban-juno-002"
    select_paths "$code_executable" "$kanban_executable" "$CODE_SOURCE" "$KANBAN_SOURCE"
    echo "aliases: $BIN_DIR/yy-juno-002 $BIN_DIR/juno-kanban-juno-002"
}

run_selected() {
    local kind=$1
    shift
    load_selection
    validate_code "$SELECTED_CODE"
    juno_kanban_check_executable "$SELECTED_KANBAN" runtime
    export VIRTUAL_ENV="$(cd "$(dirname "$SELECTED_KANBAN")/.." && pwd -P)"
    export PATH="$VIRTUAL_ENV/bin:$PATH"
    export JUNO_002_CODE_SOURCE="$SELECTED_CODE_SOURCE"
    export JUNO_002_KANBAN_SOURCE="$SELECTED_KANBAN_SOURCE"
    if [[ "$kind" == code ]]; then
        if [[ $# -eq 1 && ( "$1" == "--version" || "$1" == "-V" ) ]]; then cd "$STATE_DIR"; fi
        exec "$SELECTED_CODE" "$@"
    fi
    exec "$SELECTED_KANBAN" "$@"
}

controller_status() {
    python3 "$JUNO_CODE_ROOT/src/templates/scripts/controller_resolver.py" \
        --cwd "$REPOSITORY_ROOT" --operation diagnostic --format json
}

register_controller() {
    local controller_path=${1:?controller path required} branch=${2:-}
    local args=(--cwd "$REPOSITORY_ROOT" --register "$controller_path" --format json)
    [[ -n "$branch" ]] && args+=(--branch "$branch")
    python3 "$JUNO_CODE_ROOT/src/templates/scripts/controller_resolver.py" "${args[@]}"
}

status() {
    load_selection
    validate_code "$SELECTED_CODE"
    juno_kanban_check_executable "$SELECTED_KANBAN" selected
    printf 'state=%s\nalias_dir=%s\njuno_code_source=%s\njuno_kanban_source=%s\npolicy=%s\n' \
        "$STATE_DIR" "$BIN_DIR" "$SELECTED_CODE_SOURCE" "$SELECTED_KANBAN_SOURCE" "$JUNO_KANBAN_COMPAT_RANGE"
}

rollback_selection() {
    [[ -f "$PREVIOUS_FILE" ]] || fail "no previous executable selection to restore"
    load_selection "$PREVIOUS_FILE"
    validate_code "$SELECTED_CODE"
    juno_kanban_check_executable "$SELECTED_KANBAN" rollback
    local current
    current=$(mktemp "${SELECTED_FILE}.current.XXXXXX")
    cp "$SELECTED_FILE" "$current"
    cp "$PREVIOUS_FILE" "$SELECTED_FILE"
    mv "$current" "$PREVIOUS_FILE"
    echo "restored previous executable selection"
}

invoked_as=$(basename "$0")
case "$invoked_as" in
    yy-juno-002) run_selected code "$@" ;;
    juno-kanban-juno-002) run_selected kanban "$@" ;;
    *)
        command=${1:-status}; shift || true
        case "$command" in
            install) install_sources ;;
            select)
                [[ $# -eq 4 ]] || fail "usage: $0 select CODE_EXECUTABLE KANBAN_EXECUTABLE CODE_SOURCE KANBAN_SOURCE"
                select_paths "$1" "$2" "$3" "$4"
                ;;
            rollback-selection) rollback_selection ;;
            controller-status) controller_status ;;
            register-controller) register_controller "$@" ;;
            status) status ;;
            run-yy) run_selected code "$@" ;;
            run-kanban) run_selected kanban "$@" ;;
            *) fail "usage: $0 {install|select|rollback-selection|controller-status|register-controller PATH [BRANCH]|status|run-yy|run-kanban}" ;;
        esac
        ;;
esac
