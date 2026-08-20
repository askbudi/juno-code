#!/usr/bin/env python3
"""Await precisely identified transient controller blockers, then resume.

Safety contract: this helper NEVER mutates Git state, files, locks, or
processes. It observes one captured transient condition, stops immediately if
the blocker changes identity or new drift appears, and optionally re-executes
one bounded command the moment the exact captured condition clears. Cleanup,
kill, stash, reset, or commit remain separately authorized operations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

AWAIT_SCHEMA = "juno_await_blocker.v1"
POLL_SECONDS_MIN = 0.25
POLL_SECONDS_MAX = 2.0


class AwaitError(RuntimeError):
    pass


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                            text=True, stdin=subprocess.DEVNULL)
    return result.stdout.strip() if result.returncode == 0 else ""


def controller_dirty_paths(controller: Path) -> list[str]:
    unstaged = sorted(filter(None, _git(controller, "diff", "--name-only").splitlines()))
    untracked = sorted(filter(None, _git(
        controller, "ls-files", "--others", "--exclude-standard").splitlines()))
    return sorted(set(unstaged + untracked))


def fingerprint(condition: str, controller: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Immutable blocker fingerprint captured once at await start."""
    lock_identity: Optional[str] = None
    lock_path = payload.get("path") if condition == "lock-release" else None
    if isinstance(lock_path, str):
        try:
            stat = os.stat(lock_path)
            lock_identity = f"inode={stat.st_ino}:dev={stat.st_dev}"
        except OSError:
            lock_identity = "absent"
    return {
        "schema_version": AWAIT_SCHEMA,
        "condition": condition,
        "controller": str(controller),
        "controller_head": _git(controller, "rev-parse", "HEAD") or None,
        "dirty_paths": controller_dirty_paths(controller),
        "lock_path": lock_path,
        "lock_identity": lock_identity,
        "pid": payload.get("pid"),
        "path": payload.get("path"),
        "task": payload.get("task"),
        "expected_state": payload.get("state"),
        "then_argv": payload.get("then"),
        "captured_at": time.time(),
    }


def _controller_clean(controller: Path, baseline: dict[str, Any]) -> tuple[bool, str]:
    dirty = controller_dirty_paths(controller)
    if not dirty:
        return True, "controller clean"
    new_paths = sorted(set(dirty) - set(baseline["dirty_paths"]))
    if new_paths:
        return False, f"blocker drifted: new dirty paths {new_paths}; stopping"
    return False, f"controller dirty: {', '.join(dirty[:8])}"


def _lock_released(controller: Path, baseline: dict[str, Any]) -> tuple[bool, str]:
    path = baseline["lock_path"]
    if not os.path.exists(path or ""):
        return True, "lock path absent"
    try:
        stat = os.stat(path)
    except OSError:
        return True, "lock path vanished"
    identity = f"inode={stat.st_ino}:dev={stat.st_dev}"
    if identity != baseline["lock_identity"]:
        return False, (f"blocker changed identity {baseline['lock_identity']} -> "
                       f"{identity}; stopping")
    return False, f"lock still present ({identity})"


def _process_exited(controller: Path, baseline: dict[str, Any]) -> tuple[bool, str]:
    pid = baseline["pid"]
    if not isinstance(pid, int) or pid <= 0:
        return False, "process identity is missing; stopping"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True, f"process {pid} exited"
    except PermissionError:
        return False, f"process {pid} owned by another user"
    return False, f"process {pid} still running"


def _path_condition(expected: str):
    def probe(controller: Path, baseline: dict[str, Any]) -> tuple[bool, str]:
        path = baseline.get("path")
        present = bool(path) and os.path.exists(path)
        if present == (expected == "path-exists"):
            return True, f"path {'present' if present else 'absent'} as expected"
        digest: Optional[str] = None
        if present and isinstance(path, str):
            try:
                digest = hashlib.sha256(Path(path).read_bytes()[:65536]).hexdigest()[:16]
            except OSError:
                digest = None
        return False, f"path {'present' if present else 'absent'} (digest {digest})"
    return probe


def _task_state(controller: Path, baseline: dict[str, Any]) -> tuple[bool, str]:
    task = baseline.get("task")
    state_path = controller / ".juno_task/state/tasks.json"
    try:
        state = json.loads(state_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return False, f"task state unreadable: {exc}"
    record = (state.get("tasks") or {}).get(task)
    current = record.get("state") if isinstance(record, dict) else None
    allowed = baseline.get("expected_state")
    if isinstance(allowed, str):
        allowed = [allowed]
    if isinstance(current, str) and current in (allowed or []):
        return True, f"task {task} reached {current}"
    return False, f"task {task} state {current}, waiting for {allowed}"


PROBES: dict[str, Callable[[Path, dict[str, Any]], tuple[bool, str]]] = {
    "controller-clean": _controller_clean,
    "lock-release": _lock_released,
    "process-exit": _process_exited,
    "path-exists": _path_condition("path-exists"),
    "path-gone": _path_condition("path-gone"),
    "task-state": _task_state,
}


def await_condition(condition: str, controller: Path, payload: dict[str, Any],
                    timeout: float, on_event: Optional[Callable[[str], None]] = None,
                    sleep=time.sleep, monotonic=time.monotonic) -> dict[str, Any]:
    if condition not in PROBES:
        raise AwaitError(f"unknown await condition: {condition}")
    probe = PROBES[condition]
    baseline = fingerprint(condition, controller, payload)
    deadline = monotonic() + timeout
    started = monotonic()
    last_message = ""
    while True:
        cleared, message = probe(controller, baseline)
        if message != last_message and on_event is not None:
            on_event(message)
        last_message = message
        if cleared:
            return {"schema_version": AWAIT_SCHEMA, "condition": condition,
                    "outcome": "cleared", "waited_seconds": round(monotonic() - started, 3),
                    "fingerprint": baseline, "last_message": message}
        if message.startswith("blocker drifted") or message.startswith("blocker changed"):
            return {"schema_version": AWAIT_SCHEMA, "condition": condition,
                    "outcome": "drifted", "waited_seconds": round(monotonic() - started, 3),
                    "fingerprint": baseline, "last_message": message}
        if monotonic() >= deadline:
            return {"schema_version": AWAIT_SCHEMA, "condition": condition,
                    "outcome": "timeout", "waited_seconds": round(monotonic() - started, 3),
                    "fingerprint": baseline, "last_message": message}
        sleep(random.uniform(POLL_SECONDS_MIN, POLL_SECONDS_MAX))


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("condition", choices=sorted(PROBES))
    parser.add_argument("--controller", type=Path, default=Path.cwd())
    parser.add_argument("--path", help="lock or observed filesystem path")
    parser.add_argument("--pid", type=int, help="process identity to observe")
    parser.add_argument("--task", help="task id for task-state conditions")
    parser.add_argument("--state", action="append", default=[],
                        help="allowed terminal state (repeatable)")
    parser.add_argument("--timeout", type=float, default=1800.0)
    parser.add_argument("--then", nargs=argparse.REMAINDER,
                        help="bounded command to execute once the condition clears")
    args = parser.parse_args(argv)
    try:
        result = await_condition(
            args.condition, args.controller,
            {"path": args.path, "pid": args.pid, "task": args.task,
             "state": args.state or None, "then": args.then or None},
            args.timeout,
            on_event=lambda message: print(f"[await] {message}", file=sys.stderr, flush=True))
        if result["outcome"] == "cleared" and args.then:
            # The retry command is explicitly authorized by --then; the await
            # helper itself still never mutates anything before this point.
            result["then_exit_code"] = subprocess.call(args.then, cwd=args.controller)
        print(json.dumps(result, sort_keys=True, indent=1))
        return 0 if result["outcome"] in {"cleared", "cleared_awaiting_exec"} else 2
    except AwaitError as exc:
        print(f"await: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
