#!/usr/bin/env python3
"""Produce deterministic release provenance; this is not same-UID hostile signing."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any


AUTH_SCHEMA = "juno_bolt_release_authorization.v1"
RECEIPT_SCHEMA = "juno_bolt_release_gate.v1"
PRODUCER_SCHEMA = "juno_bolt_release_gate_producer.v1"
TOOL_ID = "yylo.release-gate"
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
DIGEST_RE = re.compile(r"[0-9a-f]{64}\Z")
MAX_BYTES = 65536


class ReleaseGateError(RuntimeError):
    pass


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def atomic(path: Path, value: dict[str, Any]) -> None:
    data = canonical(value); path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix="." + path.name + ".", delete=False) as out:
        out.write(data); out.flush(); os.fsync(out.fileno()); temporary = Path(out.name)
    os.replace(temporary, path)


def produce(authorization_path: Path, authorization_sha256: str, candidate_sha: str,
            policy_identity: str, output: Path) -> dict[str, Any]:
    if not DIGEST_RE.fullmatch(authorization_sha256):
        raise ReleaseGateError("owner authorization digest is malformed")
    try: data = authorization_path.read_bytes()
    except OSError as exc: raise ReleaseGateError("owner authorization is missing") from exc
    if not data or len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != authorization_sha256:
        raise ReleaseGateError("owner authorization digest/content mismatch")
    try: authorization = json.loads(data)
    except (UnicodeError, json.JSONDecodeError) as exc: raise ReleaseGateError("owner authorization is malformed") from exc
    keys = {"schema_version", "candidate_sha", "policy_identity", "owner_id", "authorized_scopes"}
    if (not isinstance(authorization, dict) or set(authorization) != keys
            or data != canonical(authorization)
            or authorization.get("schema_version") != AUTH_SCHEMA
            or authorization.get("candidate_sha") != candidate_sha
            or authorization.get("policy_identity") != policy_identity
            or not SHA_RE.fullmatch(candidate_sha) or not DIGEST_RE.fullmatch(policy_identity)
            or not isinstance(authorization.get("owner_id"), str) or not authorization["owner_id"]
            or len(authorization["owner_id"].encode()) > 512
            or authorization.get("authorized_scopes") != ["local_release"]):
        raise ReleaseGateError("owner authorization does not bind this local release")
    receipt = {"schema_version": RECEIPT_SCHEMA, "producer_schema": PRODUCER_SCHEMA,
               "tool_id": TOOL_ID, "candidate_sha": candidate_sha,
               "policy_identity": policy_identity, "authority_id": authorization["owner_id"],
               "owner_authorization_sha256": authorization_sha256, "validation": "passed"}
    atomic(output, receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("command", choices=("produce",))
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--authorization-sha256", required=True)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--policy-identity", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        value = produce(args.authorization, args.authorization_sha256, args.candidate_sha,
                        args.policy_identity, args.output)
        print(json.dumps(value, sort_keys=True)); return 0
    except ReleaseGateError as exc:
        print(f"release_gate.py: {exc}", file=__import__("sys").stderr); return 1


if __name__ == "__main__":
    raise SystemExit(main())
