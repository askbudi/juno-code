#!/usr/bin/env python3
"""Small non-echoing primitives for project-owned task hydration workflows."""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath


class HydrationError(RuntimeError):
    pass


def project_destination(root: Path, value: str) -> Path:
    relative = PurePosixPath(value)
    if relative.is_absolute() or not value or ".." in relative.parts or ".git" in relative.parts:
        raise HydrationError("destination must be a normalized path inside the task worktree")
    destination = root.joinpath(*relative.parts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink() or any(parent.is_symlink() for parent in destination.parents if parent != root.parent):
        raise HydrationError("destination contains a symbolic-link component")
    return destination


def copy_env(root: Path, source_value: str, destination_value: str) -> None:
    source = Path(source_value).expanduser()
    if not source.is_absolute():
        raise HydrationError("env source must be one explicitly approved absolute file")
    if source.is_symlink() or not source.is_file():
        raise HydrationError("approved env source is missing, not regular, or symbolic")
    destination = project_destination(root, destination_value)
    data = source.read_bytes()
    if destination.is_file() and destination.read_bytes() == data:
        os.chmod(destination, 0o600)
        return
    descriptor, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def node_package(root: Path, value: str) -> Path:
    relative = PurePosixPath(value)
    if relative.is_absolute() or not value or ".." in relative.parts or ".git" in relative.parts:
        raise HydrationError("node package cwd must be a normalized worktree path")
    package = root.joinpath(*relative.parts)
    if package.is_symlink() or not package.is_dir() or not (package / "package-lock.json").is_file():
        raise HydrationError("node package cwd or exact lock is missing or symbolic")
    return package


def lock_digest(package: Path) -> str:
    return hashlib.sha256((package / "package-lock.json").read_bytes()).hexdigest()


def npm_check(package: Path) -> None:
    result = subprocess.run(
        ["npm", "ls", "--depth=0", "--ignore-scripts"], cwd=package,
        stdin=subprocess.DEVNULL, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise HydrationError("installed Node dependency tree does not satisfy the exact lock")


def verify_node_lock(root: Path, cwd: str) -> None:
    package = node_package(root, cwd)
    stamp = package / "node_modules/.yylo-package-lock.sha256"
    if not stamp.is_file() or stamp.is_symlink() or stamp.read_text().strip() != lock_digest(package):
        raise HydrationError("installed Node dependencies are missing or stale for package-lock.json")
    npm_check(package)


def hydrate_node(root: Path, cwd: str) -> None:
    package = node_package(root, cwd)
    result = subprocess.run(
        ["npm", "ci", "--no-audit", "--no-fund"], cwd=package,
        stdin=subprocess.DEVNULL, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise HydrationError("npm ci failed for exact-lock hydration")
    npm_check(package)
    stamp = package / "node_modules/.yylo-package-lock.sha256"
    stamp.parent.mkdir(parents=True, exist_ok=True)
    temporary = stamp.with_name(f".{stamp.name}.{os.getpid()}.tmp")
    temporary.write_text(f"{lock_digest(package)}\n")
    os.replace(temporary, stamp)


def verify_clean(root: Path) -> None:
    result = subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain=v1", "--untracked-files=all"],
        stdin=subprocess.DEVNULL, text=True, capture_output=True, check=False,
    )
    if result.returncode or result.stdout:
        raise HydrationError("hydration left tracked or unignored worktree drift")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    env = sub.add_parser("copy-env")
    env.add_argument("--source", required=True)
    env.add_argument("--destination", required=True)
    for name in ("hydrate-node", "verify-node-lock"):
        node = sub.add_parser(name)
        node.add_argument("--cwd", required=True)
    sub.add_parser("verify-clean")
    args = parser.parse_args()
    root = Path(args.project_root).resolve()
    if not root.is_dir() or subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
        text=True, capture_output=True, check=False,
    ).stdout.strip() != str(root):
        raise HydrationError("--project-root must be the exact task Git worktree")
    if args.command == "copy-env":
        copy_env(root, args.source, args.destination)
    elif args.command == "hydrate-node":
        hydrate_node(root, args.cwd)
    elif args.command == "verify-node-lock":
        verify_node_lock(root, args.cwd)
    else:
        verify_clean(root)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HydrationError as exc:
        print(f"worktree_hydration: error: {exc}", file=__import__("sys").stderr)
        raise SystemExit(2)
