#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd -P)"

candidates=()
if [[ -n "${JUNO_GIT_FLOW_PYTHON:-}" ]]; then
  candidates+=("$JUNO_GIT_FLOW_PYTHON")
else
  candidates+=("$PROJECT_ROOT/.venv_juno/bin/python3" "$PROJECT_ROOT/.venv_juno/bin/python")
  command -v python3 >/dev/null 2>&1 && candidates+=("$(command -v python3)")
fi
for python_bin in "${candidates[@]}"; do
  [[ -x "$python_bin" ]] || continue
  if "$python_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    engine="$SCRIPT_DIR/git_flow.py"
    resolver="$SCRIPT_DIR/controller_resolver.py"
    if [[ -f "$resolver" ]]; then
      controller_root="$("$python_bin" "$resolver" --cwd "$PROJECT_ROOT" --operation diagnostic --format root)"
      controller_engine="$controller_root/.juno_task/scripts/git_flow.py"
      [[ -f "$controller_engine" ]] && engine="$controller_engine"
    fi
    exec "$python_bin" "$engine" "$@"
  fi
done
printf '%s\n' 'git-flow: error: Python 3.10 or newer is required.' >&2
exit 2
