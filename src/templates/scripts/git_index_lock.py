#!/usr/bin/env python3
"""Diagnose Git index locks and quarantine only high-confidence stale empty locks."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


SCHEMA_VERSION = "juno_git_index_lock_diagnostic.v1"
DEFAULT_HASH_LIMIT_BYTES = 16 * 1024 * 1024
DEFAULT_STALE_MIN_AGE_SECONDS = 300.0
DEFAULT_STABILITY_SECONDS = 1.0


class IndexLockError(Exception):
    pass


def run_git(repository: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repository), *args],
        text=True,
        capture_output=True,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise IndexLockError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def absolute_git_path(repository: Path, name: str) -> Path:
    value = run_git(repository, "rev-parse", "--path-format=absolute", "--git-path", name)
    return Path(value).resolve()


def bounded_sha256(path: Path, limit_bytes: int = DEFAULT_HASH_LIMIT_BYTES) -> dict[str, Any]:
    digest = hashlib.sha256()
    hashed = 0
    with path.open("rb") as handle:
        while hashed < limit_bytes:
            chunk = handle.read(min(1024 * 1024, limit_bytes - hashed))
            if not chunk:
                break
            digest.update(chunk)
            hashed += len(chunk)
        complete = handle.read(1) == b""
    return {"sha256": digest.hexdigest(), "hashed_bytes": hashed, "hash_complete": complete}


def open_owners(path: Path) -> dict[str, Any]:
    try:
        result = subprocess.run(
            ["lsof", "-Fpc", "--", str(path)],
            text=True,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=5,
        )
    except FileNotFoundError:
        return {"available": False, "owners": []}
    except subprocess.TimeoutExpired:
        return {"available": False, "owners": [], "reason": "timeout"}
    owners: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in result.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            current = {"pid": int(line[1:])}
            owners.append(current)
        elif line.startswith("c") and current is not None:
            current["command_name_sha256"] = hashlib.sha256(line[1:].encode("utf-8")).hexdigest()
    return {"available": True, "owners": owners}


def file_evidence(path: Path, hash_limit_bytes: int) -> dict[str, Any] | None:
    try:
        info = path.stat()
        digest = bounded_sha256(path, hash_limit_bytes)
    except FileNotFoundError:
        return None
    evidence = {
        "path": str(path),
        "inode": info.st_ino,
        "size_bytes": info.st_size,
        "mtime_ns": info.st_mtime_ns,
    }
    evidence.update(digest)
    return evidence


def diagnose_index_lock(
    repository: Path, *, hash_limit_bytes: int = DEFAULT_HASH_LIMIT_BYTES
) -> dict[str, Any]:
    repository = repository.expanduser().resolve()
    root = Path(run_git(repository, "rev-parse", "--show-toplevel")).resolve()
    common_dir = Path(
        run_git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).resolve()
    lock_path = absolute_git_path(repository, "index.lock")
    index_path = absolute_git_path(repository, "index")
    lock = file_evidence(lock_path, hash_limit_bytes)
    present = lock is not None
    return {
        "schema_version": SCHEMA_VERSION,
        "repository_root": str(root),
        "git_common_dir": str(common_dir),
        "index_path": str(index_path),
        "index": file_evidence(index_path, hash_limit_bytes) if present else None,
        "lock_path": str(lock_path),
        "lock": lock,
        "lock_present": present,
        "open_owner_probe": open_owners(lock_path) if present else {"available": True, "owners": []},
        "safe_next_action": "preserve_and_coordinate" if present else "proceed",
        "mutation_performed": False,
    }


def _same_lock(left: dict[str, Any], right: dict[str, Any]) -> bool:
    keys = ("inode", "size_bytes", "mtime_ns", "sha256", "hashed_bytes", "hash_complete")
    return all(left.get(key) == right.get(key) for key in keys)


def _stale_rejection_reasons(receipt: dict[str, Any], min_age_seconds: float) -> list[str]:
    if not receipt["lock_present"]:
        return ["lock_absent"]
    lock = receipt["lock"]
    index = receipt["index"]
    owners = receipt["open_owner_probe"]
    reasons: list[str] = []
    age_seconds = max(0.0, (time.time_ns() - int(lock["mtime_ns"])) / 1_000_000_000)
    if age_seconds < min_age_seconds:
        reasons.append("lock_too_new")
    if lock["size_bytes"] != 0:
        reasons.append("lock_not_empty")
    if not lock["hash_complete"]:
        reasons.append("lock_hash_incomplete")
    if not owners.get("available"):
        reasons.append("owner_probe_unavailable")
    elif owners.get("owners"):
        reasons.append("lock_has_open_owner")
    if not index or index.get("size_bytes", 0) <= 0:
        reasons.append("index_missing_or_empty")
    return reasons


def recover_high_confidence_stale_index_lock(
    repository: Path,
    *,
    min_age_seconds: float = DEFAULT_STALE_MIN_AGE_SECONDS,
    stability_seconds: float = DEFAULT_STABILITY_SECONDS,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Atomically quarantine an old, empty, ownerless lock after two stable observations.

    Non-empty, young, changing, owned, or unprobeable locks are never moved. The
    quarantined inode is retained beside the index for forensic review.
    """
    if min_age_seconds < 0 or stability_seconds < 0:
        raise IndexLockError("stale lock thresholds must be non-negative")
    repository = repository.expanduser().resolve()
    first = diagnose_index_lock(repository)
    if not first["lock_present"]:
        first["stale_recovery"] = {"outcome": "not_needed", "rejection_reasons": []}
        return first
    reasons = _stale_rejection_reasons(first, min_age_seconds)
    if reasons:
        first["stale_recovery"] = {"outcome": "preserved", "rejection_reasons": reasons}
        return first

    sleep_fn(stability_seconds)
    second = diagnose_index_lock(repository)
    if not second["lock_present"] or not _same_lock(first["lock"], second["lock"]):
        second["stale_recovery"] = {
            "outcome": "preserved",
            "rejection_reasons": ["lock_changed_during_observation"],
        }
        return second
    reasons = _stale_rejection_reasons(second, min_age_seconds)
    if reasons:
        second["stale_recovery"] = {"outcome": "preserved", "rejection_reasons": reasons}
        return second

    lock_path = Path(second["lock_path"])
    final_owners = open_owners(lock_path)
    if not final_owners.get("available") or final_owners.get("owners"):
        second["open_owner_probe"] = final_owners
        second["stale_recovery"] = {
            "outcome": "preserved",
            "rejection_reasons": [
                "owner_probe_unavailable" if not final_owners.get("available") else "lock_has_open_owner"
            ],
        }
        return second
    final_lock = file_evidence(lock_path, DEFAULT_HASH_LIMIT_BYTES)
    if final_lock is None or not _same_lock(second["lock"], final_lock):
        second["stale_recovery"] = {
            "outcome": "preserved",
            "rejection_reasons": ["lock_changed_before_quarantine"],
        }
        return second

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    quarantine_path = lock_path.with_name(f"index.lock.stale.{stamp}.{final_lock['inode']}")
    if quarantine_path.exists():
        raise IndexLockError(f"stale lock quarantine path already exists: {quarantine_path}")
    lock_path.rename(quarantine_path)
    quarantined = file_evidence(quarantine_path, DEFAULT_HASH_LIMIT_BYTES)
    if quarantined is None or not _same_lock(final_lock, quarantined):
        raise IndexLockError(f"stale lock quarantine verification failed: {quarantine_path}")

    receipt = diagnose_index_lock(repository)
    if receipt["lock_present"]:
        raise IndexLockError("a new Git index lock appeared during stale-lock recovery")
    receipt["mutation_performed"] = True
    receipt["stale_recovery"] = {
        "outcome": "quarantined",
        "rejection_reasons": [],
        "quarantine_path": str(quarantine_path),
        "quarantined_lock": quarantined,
        "observed_lock": second["lock"],
        "min_age_seconds": min_age_seconds,
        "stability_seconds": stability_seconds,
    }
    return receipt


def require_index_unlocked(repository: Path) -> dict[str, Any]:
    receipt = recover_high_confidence_stale_index_lock(repository)
    if receipt["lock_present"]:
        reasons = receipt.get("stale_recovery", {}).get("rejection_reasons", [])
        raise IndexLockError(
            "git_index_lock_present: "
            f"path={receipt['lock_path']} rejection_reasons={reasons} "
            "safe_next_action=preserve_and_coordinate"
        )
    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.getcwd(), help="Path inside the Git repository")
    parser.add_argument("--output", help="Optional JSON receipt path")
    parser.add_argument("--hash-limit-bytes", type=int, default=DEFAULT_HASH_LIMIT_BYTES)
    parser.add_argument(
        "--recover-high-confidence-stale",
        action="store_true",
        help="Quarantine an old, stable, empty, ownerless lock; preserve all uncertain locks",
    )
    parser.add_argument("--stale-min-age-seconds", type=float, default=DEFAULT_STALE_MIN_AGE_SECONDS)
    parser.add_argument("--stability-seconds", type=float, default=DEFAULT_STABILITY_SECONDS)
    args = parser.parse_args(argv)
    if args.hash_limit_bytes < 0:
        parser.error("--hash-limit-bytes must be non-negative")
    if args.stale_min_age_seconds < 0 or args.stability_seconds < 0:
        parser.error("stale lock thresholds must be non-negative")
    if args.recover_high_confidence_stale:
        receipt = recover_high_confidence_stale_index_lock(
            Path(args.repository),
            min_age_seconds=args.stale_min_age_seconds,
            stability_seconds=args.stability_seconds,
        )
    else:
        receipt = diagnose_index_lock(Path(args.repository), hash_limit_bytes=args.hash_limit_bytes)
    encoded = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).expanduser().resolve().write_text(encoded, encoding="utf-8")
    print(json.dumps(receipt, sort_keys=True))
    return 2 if receipt["lock_present"] else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (IndexLockError, OSError) as exc:
        print(f"git_index_lock: error: {exc}", file=sys.stderr)
        raise SystemExit(2)
