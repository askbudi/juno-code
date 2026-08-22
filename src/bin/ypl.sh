#!/usr/bin/env bash

# ypl.sh
#
# Purpose: Shortcut wrapper for `yy pi --live`.
#
# `ypl "hello"` is equivalent to `yy pi --live "hello"` and forwards every
# user-supplied argument unchanged after the injected `pi --live` arguments.

set -euo pipefail

# Get the directory where this script is located.
# IMPORTANT: Resolve symlinks first (npm creates symlinks in /usr/local/bin or /opt/homebrew/bin)
# We need the real path to find yylo.sh in the same dist/bin directory.
if [ -L "${BASH_SOURCE[0]}" ]; then
    REAL_SCRIPT="$(readlink "${BASH_SOURCE[0]}")"
    if [[ "$REAL_SCRIPT" != /* ]]; then
        REAL_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd "$(dirname "$REAL_SCRIPT")" && pwd)/$(basename "$REAL_SCRIPT")"
    fi
    SCRIPT_DIR="$(cd "$(dirname "$REAL_SCRIPT")" && pwd)"
else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

YYLO_WRAPPER="${SCRIPT_DIR}/yylo.sh"

if [ ! -x "$YYLO_WRAPPER" ]; then
    echo "ypl: unable to find executable yylo wrapper at $YYLO_WRAPPER" >&2
    exit 127
fi

# Source the common wrapper so its executable-boundary $0 remains ypl. The
# wrapper replaces this process and carries identity via node argv[0].
set -- pi --live "$@"
# shellcheck source=/dev/null
source "$YYLO_WRAPPER"
