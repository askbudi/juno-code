#!/usr/bin/env python3
"""Read-only Git index-lock diagnostics; never mutate the index or lock."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "juno_git_index_lock_diagnostic.v1"
DEFAULT_HASH_LIMIT_BYTES = 16 * 1024 * 1024


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


def require_index_unlocked(repository: Path) -> dict[str, Any]:
    receipt = diagnose_index_lock(repository)
    if receipt["lock_present"]:
        raise IndexLockError(
            "git_index_lock_present: "
            f"path={receipt['lock_path']} safe_next_action=preserve_and_coordinate; never delete it"
        )
    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.getcwd(), help="Path inside the Git repository")
    parser.add_argument("--output", help="Optional JSON receipt path")
    parser.add_argument("--hash-limit-bytes", type=int, default=DEFAULT_HASH_LIMIT_BYTES)
    args = parser.parse_args(argv)
    if args.hash_limit_bytes < 0:
        parser.error("--hash-limit-bytes must be non-negative")
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
