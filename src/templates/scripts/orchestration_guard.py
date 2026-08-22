#!/usr/bin/env python3
"""Visible singleton/ownership guard for cron and workflow launch.

This guard serializes generic orchestration only. It never changes Git refs or
confers merge authority; Bolt target advancement is owned by ``yy merge``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def metadata_root(controller: Path) -> Path:
    override = os.environ.get("YYLO_SESSION_METADATA_DIRECTORY", "").strip()
    if override:
        candidate = Path(override)
        return candidate if candidate.is_absolute() else (controller / candidate).resolve()
    completed = subprocess.run(
        ["git", "-C", str(controller), "rev-parse", "--path-format=absolute", "--git-common-dir"],
        text=True, capture_output=True,
    )
    if completed.returncode == 0 and completed.stdout.strip():
        return Path(completed.stdout.strip()).resolve() / "juno" / "session_metadata"
    identity = hashlib.sha256(str(controller.resolve()).encode()).hexdigest()[:16]
    state = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state / "@yylo/cli" / "session_metadata" / identity


def resolve_controller(cwd: Path) -> dict[str, object]:
    resolver = Path(__file__).resolve().with_name("controller_resolver.py")
    completed = subprocess.run(
        [sys.executable, str(resolver), "--cwd", str(cwd), "--operation", "orchestration"],
        text=True, capture_output=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "controller resolution failed")
    return json.loads(completed.stdout)


def acquire(lock: Path) -> None:
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        lock.mkdir()
    except FileExistsError:
        try:
            owner = json.loads((lock / "owner.json").read_text())
            pid = int(owner.get("pid", 0))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pid = 0
        if process_alive(pid):
            raise RuntimeError(f"orchestration overlap: lock {lock} is owned by live pid {pid}")
        quarantine = lock.with_name(f"{lock.name}.stale-{os.getpid()}-{time.time_ns()}")
        try:
            lock.rename(quarantine)
        except FileNotFoundError:
            return acquire(lock)
        shutil.rmtree(quarantine, ignore_errors=True)
        return acquire(lock)
    (lock / "owner.json").write_text(json.dumps({
        "pid": os.getpid(), "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }, indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key", required=True, help="Stable cron/workflow ownership key")
    parser.add_argument("--cwd", default=os.getcwd(), help="Controller resolution starting directory")
    parser.add_argument("--allow-non-controller", action="store_true", help="Permit an explicitly configured non-controller launch role")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Command after --")
    args = parser.parse_args(argv)
    if not args.command:
        parser.error("a command is required after --")
    command = args.command[1:] if args.command[0] == "--" else args.command
    try:
        resolution = resolve_controller(Path(args.cwd))
        role = str(resolution.get("role", ""))
        if role != "controller" and not args.allow_non_controller:
            raise RuntimeError(f"ownership preflight requires role 'controller', resolved {role!r}")
        controller = Path(str(resolution["path"]))
        digest = hashlib.sha256(args.key.encode()).hexdigest()[:16]
        lock = metadata_root(controller) / "orchestration_locks" / f"{digest}.lock"
        acquire(lock)
        env = os.environ.copy()
        env.update({
            "JUNO_TASK_ROOT": str(controller),
            "JUNO_CONTROLLER_SOURCE": str(resolution.get("source", "")),
            "JUNO_WORKSPACE_ROLE": role,
            "YYLO_SESSION_METADATA_DIRECTORY": str(metadata_root(controller)),
        })
        try:
            return subprocess.run(command, cwd=str(controller), env=env).returncode
        finally:
            shutil.rmtree(lock, ignore_errors=True)
    except (RuntimeError, OSError, KeyError) as exc:
        print(f"orchestration_guard.py: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
