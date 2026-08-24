#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
publish-all.sh is retired because it could publish before the GitHub/submodule
closure and could not release @yylo/benchmark or yylo-ledger safely.

From the canonical integration owner, use the receipt-bound workflow:
  cp scripts/release-yylo.example.json /tmp/yylo-release.json
  # edit exact versions, dist-tags, optional package tags/releases, and stages, then:
  ./scripts/release-yylo.py plan /tmp/yylo-release.json --output /tmp/yylo-release-plan.json
  # review the bound SHAs, destinations, artifact hashes, and ordered actions, then:
  NPM_TOKEN=... PIP_UPLOAD_TOKEN=... ./scripts/release-yylo.py apply \
    /tmp/yylo-release-plan.json --receipt /tmp/yylo-release-receipt.json

Planning builds and validates the exact artifacts without publishing. Apply
routes through the shared guarded release authority, proves every credential
usable before the first remote mutation, publishes only the plan-bound
artifacts in dependency-safe order, verifies registry readback before marking
a stage complete, and resumes safely from the same receipt. No legacy argument
is accepted.
EOF
exit 2
