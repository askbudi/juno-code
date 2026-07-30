#!/usr/bin/env python3
"""Resolve the canonical manifest for a workflow run without creating another evidence store."""
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RUN_CONTRACT_SCHEMA = "juno_workflow_run_contract.v1"


class WorkflowRunEvidenceError(RuntimeError):
    """Workflow evidence is absent, malformed, unbound, or outside its run directory."""


@dataclass(frozen=True)
class ResolvedWorkflowManifest:
    path: Path
    payload: dict[str, Any]
    sha256: str
    source: str


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise WorkflowRunEvidenceError(f"cannot parse {label}: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise WorkflowRunEvidenceError(f"{label} must be a JSON object: {path}")
    return payload


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def resolve_workflow_manifest(run_dir: Path) -> ResolvedWorkflowManifest:
    """Resolve the newest contract attempt, or a legacy root manifest when no attempt exists."""
    run_dir = run_dir.expanduser().resolve()
    if not run_dir.is_dir():
        raise WorkflowRunEvidenceError(f"workflow run directory does not exist: {run_dir}")

    contract_path = run_dir / "run_contract.json"
    root_manifest = run_dir / "manifest.json"
    if contract_path.is_file():
        contract = load_json_object(contract_path, "workflow run contract")
        schema = contract.get("schema_version")
        if schema not in {None, RUN_CONTRACT_SCHEMA}:
            raise WorkflowRunEvidenceError(f"unsupported workflow run contract schema: {schema!r}")
        attempts = contract.get("attempts") or []
        if not isinstance(attempts, list):
            raise WorkflowRunEvidenceError("workflow run contract attempts must be a list")
        if attempts:
            attempt = attempts[-1]
            if not isinstance(attempt, dict):
                raise WorkflowRunEvidenceError("newest workflow attempt must be an object")
            raw_path = str(attempt.get("manifest") or "")
            expected_hash = str(attempt.get("manifest_sha256") or "")
            if not raw_path:
                raise WorkflowRunEvidenceError("newest workflow attempt has no manifest path")
            if len(expected_hash) != 64 or any(char not in "0123456789abcdef" for char in expected_hash.lower()):
                raise WorkflowRunEvidenceError("newest workflow attempt manifest is not SHA-256-bound")
            candidate = Path(raw_path).expanduser()
            if not candidate.is_absolute():
                candidate = run_dir / candidate
            candidate = candidate.resolve()
            if not _inside(candidate, run_dir):
                raise WorkflowRunEvidenceError(f"newest workflow attempt manifest escapes run directory: {candidate}")
            if not candidate.is_file():
                raise WorkflowRunEvidenceError(f"newest workflow attempt manifest is missing: {candidate}")
            actual_hash = file_sha256(candidate)
            if actual_hash != expected_hash.lower():
                raise WorkflowRunEvidenceError(
                    f"newest workflow attempt manifest hash mismatch: expected={expected_hash.lower()} actual={actual_hash}"
                )
            payload = load_json_object(candidate, "workflow attempt manifest")
            recorded_run_dir = payload.get("run_directory")
            if recorded_run_dir and Path(str(recorded_run_dir)).expanduser().resolve() != run_dir:
                raise WorkflowRunEvidenceError(
                    f"workflow attempt manifest run_directory mismatch: expected={run_dir} actual={recorded_run_dir}"
                )
            return ResolvedWorkflowManifest(candidate, payload, actual_hash, "run_contract_latest_attempt")

    if not root_manifest.is_file():
        raise WorkflowRunEvidenceError(f"workflow run has no readable manifest: {run_dir}")
    payload = load_json_object(root_manifest, "legacy workflow manifest")
    return ResolvedWorkflowManifest(root_manifest, payload, file_sha256(root_manifest), "legacy_root_manifest")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("run_dir")
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable resolution receipt")
    args = parser.parse_args(argv)
    try:
        resolved = resolve_workflow_manifest(Path(args.run_dir))
    except WorkflowRunEvidenceError as exc:
        parser.exit(2, f"workflow_run_evidence: error: {exc}\n")
    payload = {
        "run_dir": str(Path(args.run_dir).expanduser().resolve()),
        "manifest": str(resolved.path),
        "manifest_sha256": resolved.sha256,
        "source": resolved.source,
    }
    print(json.dumps(payload, indent=2, sort_keys=True) if args.json else resolved.path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
