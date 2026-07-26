#!/usr/bin/env python3
"""Run a Juno command while holding a repository-scoped shared writer lease."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - platform capability failure
    fcntl = None  # type: ignore[assignment]


def git_common_dir(cwd: Path) -> Path | None:
    result = subprocess.run(
        ["git", "-C", str(cwd), "rev-parse", "--path-format=absolute", "--git-common-dir"],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return Path(result.stdout.strip()).resolve()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")

    cwd = Path(args.cwd).expanduser().resolve()
    common_dir = git_common_dir(cwd)
    if common_dir is None:
        return subprocess.run(command, cwd=str(cwd)).returncode
    if fcntl is None:
        print("repository_writer_guard: error: repository leases require POSIX fcntl", file=sys.stderr)
        return 2

    lease_path = common_dir / "juno-repository-writer.lock"
    lease_path.parent.mkdir(parents=True, exist_ok=True)
    with lease_path.open("a+", encoding="utf-8") as lease:
        fcntl.flock(lease.fileno(), fcntl.LOCK_SH)
        environment = os.environ.copy()
        environment["JUNO_REPOSITORY_WRITER_LEASE"] = str(lease_path)
        try:
            return subprocess.run(command, cwd=str(cwd), env=environment).returncode
        finally:
            fcntl.flock(lease.fileno(), fcntl.LOCK_UN)


if __name__ == "__main__":
    raise SystemExit(main())
