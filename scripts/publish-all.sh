#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
publish-all.sh is retired because it could publish before the GitHub/submodule
closure and could not release @yylo/benchmark or yylo-ledger safely.

From the canonical integration owner, use the receipt-bound workflow:
  cp scripts/release-yylo.example.json /tmp/yylo-release.json
  # edit exact versions, then:
  ./scripts/release-yylo.py plan /tmp/yylo-release.json --output /tmp/yylo-release-plan.json
  NPM_TOKEN=... PIP_UPLOAD_TOKEN=... ./scripts/release-yylo.py apply \
    /tmp/yylo-release-plan.json --receipt /tmp/yylo-release-receipt.json

The command refuses missing credentials before its first remote mutation and
can resume from the same receipt. No legacy argument is accepted.
EOF
exit 2
