#!/usr/bin/env bash
# Single compatibility policy for Juno 2's Kanban runtime.
# Keep consumers executable-agnostic: they source this file and validate output.

JUNO_KANBAN_COMPAT_RANGE='>=2.0.5,<3.0.0'

juno_kanban_parse_compatible_version() {
    local output="${1-}"
    python3 - "$output" <<'PY'
import re
import sys

output = sys.argv[1]
matches = re.findall(r"(?<![0-9A-Za-z])([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][0-9A-Za-z.-]+)?(?![0-9A-Za-z])", output)
if len(matches) != 1:
    print("expected exactly one semantic version in --version output", file=sys.stderr)
    raise SystemExit(2)
major, minor, patch = (int(part) for part in matches[0])
if (major, minor, patch) < (2, 0, 5) or major >= 3:
    print(f"unsupported juno-kanban version {major}.{minor}.{patch}; required >=2.0.5,<3.0.0", file=sys.stderr)
    raise SystemExit(3)
print(f"{major}.{minor}.{patch}")
PY
}

juno_kanban_check_executable() {
    local executable="${1:?juno-kanban executable is required}"
    local label="${2:-runtime}"
    local output version
    if [[ ! -x "$executable" ]]; then
        echo "juno-kanban $label executable is missing or not executable: $executable" >&2
        return 1
    fi
    # Identity checks are metadata-only. Close stdin so a heredoc/pipe remains
    # untouched for the subsequent create command; the CLI treats readable stdin
    # as task-body input even when --version is present.
    if ! output=$("$executable" --version </dev/null 2>&1); then
        echo "juno-kanban $label --version failed: $executable: $output" >&2
        return 1
    fi
    if ! version=$(juno_kanban_parse_compatible_version "$output"); then
        echo "juno-kanban $label identity rejected: executable=$executable output=$output policy=$JUNO_KANBAN_COMPAT_RANGE" >&2
        return 1
    fi
    printf 'juno-kanban identity: label=%s executable=%s version=%s policy=%s\n' \
        "$label" "$executable" "$version" "$JUNO_KANBAN_COMPAT_RANGE" >&2
}
