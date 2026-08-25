#!/bin/sh
# Cold fixture-construction probe for the test-performance benchmark profile.
# Reproduces the pre-cache global-setup cost: one Python venv plus one git
# controller initialization, the two per-invocation constructions Wave 1
# replaces with content-addressed immutable bases.
set -eu
root="${1:-/tmp/yylo-bench-fixture-probe}"
rm -rf "$root"
mkdir -p "$root/controller/.juno_task/scripts" "$root/controller/.venv_juno"
python3 -m venv "$root/controller/.venv_juno"
git init -q -b fixture-controller "$root/controller"
rm -rf "$root"
