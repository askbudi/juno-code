#!/usr/bin/env python3
"""Small exact-base task-worktree state machine for the Bolt workflow.

The controller owns one compact JSON record per task. Product worktrees contain
only the target tree: this command never copies Kanban, specs, receipts, or
other controller data into them. Integration, review, release, and cleanup are
deliberately outside this interface.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any, Iterator, Optional

CONFIG_SCHEMA = "juno_task_workspace_config.v1"
STATE_SCHEMA = "juno_task_workspace_state.v1"
RECORD_SCHEMA = "juno_task_workspace_record.v1"
SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")
TASK_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")


class TaskWorkspaceError(RuntimeError):
    pass


def run(argv: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, stdin=subprocess.DEVNULL)
    if check and result.returncode:
        raise TaskWorkspaceError(result.stderr.strip() or result.stdout.strip() or f"command failed: {argv!r}")
    return result


def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check=check).stdout.strip()


def normalized_relative(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise TaskWorkspaceError(f"{label} must be a normalized relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or value == "." or ".." in path.parts or ".git" in path.parts:
        raise TaskWorkspaceError(f"unsafe {label}: {value!r}")
    return value.rstrip("/")


def load_config(controller: Path) -> dict[str, Any]:
    path = controller / ".juno_task/config/task-workspace.json"
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"invalid task workspace policy: {exc}") from exc
    required = {"schema_version", "repository", "target_ref", "workspace_root", "branch_prefix",
                "allowed_paths", "controller_private_paths", "focused_validation"}
    if not isinstance(value, dict) or set(value) != required or value.get("schema_version") != CONFIG_SCHEMA:
        raise TaskWorkspaceError(f"task workspace policy must contain exactly the {CONFIG_SCHEMA} fields")
    repository = Path(value["repository"])
    if repository.is_absolute() or ".." in repository.parts:
        raise TaskWorkspaceError("repository must stay inside the controller Git worktree")
    target = value["target_ref"]
    prefix = value["branch_prefix"]
    if not isinstance(target, str) or not target.startswith("refs/heads/"):
        raise TaskWorkspaceError("target_ref must be a full local branch ref")
    if not isinstance(prefix, str) or not prefix.startswith("refs/heads/") or not prefix.endswith("-"):
        raise TaskWorkspaceError("branch_prefix must be a full local branch prefix ending in '-'")
    workspace = Path(value["workspace_root"]).expanduser()
    if not workspace.is_absolute() or workspace == Path("/"):
        raise TaskWorkspaceError("workspace_root must be an explicit absolute directory")
    for field in ("allowed_paths", "controller_private_paths"):
        items = value[field]
        if not isinstance(items, list) or not items:
            raise TaskWorkspaceError(f"{field} must be a non-empty list")
        value[field] = [normalized_relative(item, field) for item in items]
        if len(set(value[field])) != len(value[field]):
            raise TaskWorkspaceError(f"{field} contains duplicates")
    validations = value["focused_validation"]
    if not isinstance(validations, list) or not validations:
        raise TaskWorkspaceError("focused_validation must contain at least one command")
    for row in validations:
        if not isinstance(row, dict) or set(row) != {"id", "cwd", "argv", "timeout_seconds", "max_output_bytes"}:
            raise TaskWorkspaceError("focused validation rows require exactly id, cwd, argv, timeout_seconds, and max_output_bytes")
        normalized_relative(row["cwd"], "validation cwd")
        if not isinstance(row["id"], str) or not row["id"] or not isinstance(row["argv"], list) or not row["argv"]:
            raise TaskWorkspaceError("focused validation id and argv must be non-empty")
        if any(not isinstance(part, str) or not part for part in row["argv"]):
            raise TaskWorkspaceError("focused validation argv entries must be non-empty strings")
        if not isinstance(row["timeout_seconds"], int) or not 1 <= row["timeout_seconds"] <= 3600:
            raise TaskWorkspaceError("focused validation timeout_seconds must be an integer from 1 through 3600")
        if not isinstance(row["max_output_bytes"], int) or not 1024 <= row["max_output_bytes"] <= 1048576:
            raise TaskWorkspaceError("focused validation max_output_bytes must be an integer from 1024 through 1048576")
    return value


def exact_root(path: Path, label: str) -> Path:
    path = path.expanduser().resolve()
    actual = git(path, "rev-parse", "--show-toplevel", check=False)
    if not actual or Path(actual).resolve() != path:
        raise TaskWorkspaceError(f"{label} is not an exact Git worktree: {path}")
    return path


def task_file(controller: Path, task_id: str) -> Path:
    if not TASK_RE.fullmatch(task_id):
        raise TaskWorkspaceError("unsafe task id")
    return controller / ".juno_task/tasks" / task_id[:2].lower() / f"{task_id}.md"


def require_task(controller: Path, task_id: str) -> None:
    path = task_file(controller, task_id)
    try:
        prefix = path.read_text()[:4096]
    except OSError as exc:
        raise TaskWorkspaceError(f"canonical Kanban task does not exist: {task_id}") from exc
    if not re.search(rf"(?m)^id:\s*{re.escape(task_id)}\s*$", prefix):
        raise TaskWorkspaceError(f"canonical Kanban task identity mismatch: {task_id}")


def state_path(controller: Path) -> Path:
    return controller / ".juno_task/state/tasks.json"


def read_state(controller: Path) -> dict[str, Any]:
    path = state_path(controller)
    if not path.exists():
        return {"schema_version": STATE_SCHEMA, "tasks": {}}
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"invalid task state: {exc}") from exc
    if not isinstance(value, dict) or set(value) != {"schema_version", "tasks"} or value.get("schema_version") != STATE_SCHEMA or not isinstance(value.get("tasks"), dict):
        raise TaskWorkspaceError("invalid task workspace state schema")
    return value


def write_state(controller: Path, state: dict[str, Any]) -> None:
    path = state_path(controller)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def state_lock(controller: Path) -> Iterator[None]:
    # Runtime locks are ignored controller-local state; only tasks.json is durable truth.
    lock = controller / ".juno_task/runtime/task-workspace.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield


@contextmanager
def finish_lock(controller: Path, task_id: str) -> Iterator[None]:
    lock = controller / ".juno_task/runtime/task-workspace" / f"{task_id}.finish.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield


def _append_tail(buffer: bytearray, data: bytes, limit: int) -> None:
    buffer.extend(data)
    if len(buffer) > limit:
        del buffer[:len(buffer) - limit]


def run_validation(row: dict[str, Any], cwd: Path) -> dict[str, Any]:
    """Run argv-only validation with stdin closed and bounded output tails."""
    limit = row["max_output_bytes"]
    started = time.monotonic()
    try:
        process = subprocess.Popen(row["argv"], cwd=cwd, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
    except OSError as exc:
        message = str(exc).encode("utf-8", errors="replace")
        tail = message[-limit:]
        return {"id": row["id"], "argv": row["argv"], "exit_code": 127,
                "timed_out": False, "timeout_seconds": row["timeout_seconds"], "duration_ms": 0,
                "stdout_tail": "", "stderr_tail": tail.decode("utf-8", errors="replace"),
                "stdout_truncated_bytes": 0, "stderr_truncated_bytes": len(message) - len(tail)}
    selector = selectors.DefaultSelector()
    stdout_tail = bytearray()
    stderr_tail = bytearray()
    stream_info = {process.stdout: ("stdout", stdout_tail), process.stderr: ("stderr", stderr_tail)}
    totals = {"stdout": 0, "stderr": 0}
    for stream in stream_info:
        if stream is not None:
            selector.register(stream, selectors.EVENT_READ)
    deadline = started + row["timeout_seconds"]
    timed_out = False
    while selector.get_map():
        if time.monotonic() >= deadline and not timed_out:
            timed_out = True
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for key, _ in selector.select(0.05 if not timed_out else 0.01):
            stream = key.fileobj
            data = os.read(stream.fileno(), 65536)
            if not data:
                selector.unregister(stream)
                continue
            name, tail = stream_info[stream]
            totals[name] += len(data)
            _append_tail(tail, data, limit)
    exit_code = process.wait()
    return {"id": row["id"], "argv": row["argv"], "exit_code": exit_code,
            "timed_out": timed_out, "timeout_seconds": row["timeout_seconds"],
            "duration_ms": int((time.monotonic() - started) * 1000),
            "stdout_tail": bytes(stdout_tail).decode("utf-8", errors="replace"),
            "stderr_tail": bytes(stderr_tail).decode("utf-8", errors="replace"),
            "stdout_truncated_bytes": totals["stdout"] - len(stdout_tail),
            "stderr_truncated_bytes": totals["stderr"] - len(stderr_tail)}


def path_within(path: str, roots: list[str]) -> bool:
    return any(path == root or path.startswith(root + "/") for root in roots)


def product_repository(controller: Path, config: dict[str, Any]) -> Path:
    return exact_root(controller / config["repository"], "configured product repository")


def ref_sha(repository: Path, ref: str) -> str:
    sha = git(repository, "rev-parse", f"{ref}^{{commit}}", check=False)
    if not SHA_RE.fullmatch(sha):
        raise TaskWorkspaceError(f"target ref does not resolve to a commit: {ref}")
    return sha


def optional_ref_sha(repository: Path, ref: str) -> Optional[str]:
    result = run(["git", "-C", str(repository), "rev-parse", f"{ref}^{{commit}}"], repository, check=False)
    value = result.stdout.strip()
    return value if result.returncode == 0 and SHA_RE.fullmatch(value) else None


def assert_no_controller_data(repository: Path, sha: str, forbidden: list[str]) -> None:
    # Exact non-recursive prefix lookups avoid enumerating a potentially huge tree.
    offenders = [root for root in forbidden if git(repository, "ls-tree", "--name-only", sha, "--", root)]
    if offenders:
        sample = ", ".join(offenders[:5])
        raise TaskWorkspaceError(f"product target contains controller-private data ({sample}); hard-cut it before task start")


def branch_ref(config: dict[str, Any], task_id: str) -> str:
    ref = f"{config['branch_prefix']}{task_id}"
    if run(["git", "check-ref-format", ref], Path.cwd(), check=False).returncode:
        raise TaskWorkspaceError(f"derived task branch is invalid: {ref}")
    return ref


def worktree_path(config: dict[str, Any], task_id: str) -> Path:
    return (Path(config["workspace_root"]) / task_id).resolve()


def clean_identity(record: dict[str, Any], repository: Path, target_sha: str) -> bool:
    worktree = Path(record["worktree"])
    branch = record["branch_ref"]
    return (
        record.get("state") == "WORKING"
        and record.get("base_sha") == target_sha
        and worktree.is_dir()
        and git(worktree, "status", "--porcelain=v1", "--untracked-files=all", check=False) == ""
        and git(worktree, "rev-parse", "HEAD", check=False) == target_sha
        and git(repository, "rev-parse", branch, check=False) == target_sha
        and git(worktree, "symbolic-ref", "-q", "HEAD", check=False) == branch
    )


def start(controller: Path, task_id: str) -> dict[str, Any]:
    config = load_config(controller)
    require_task(controller, task_id)
    repository = product_repository(controller, config)
    target_sha = ref_sha(repository, config["target_ref"])
    assert_no_controller_data(repository, target_sha, config["controller_private_paths"])
    branch = branch_ref(config, task_id)
    worktree = worktree_path(config, task_id)
    with state_lock(controller):
        state = read_state(controller)
        existing = state["tasks"].get(task_id)
        if existing:
            if clean_identity(existing, repository, target_sha):
                return {**existing, "outcome": "already_started"}
            raise TaskWorkspaceError("task start identity drifted; preserve the worktree and inspect task status")
        # show-ref is intentionally quiet; its exit status is the branch-collision contract.
        if run(["git", "-C", str(repository), "show-ref", "--verify", "--quiet", branch], repository, check=False).returncode == 0:
            raise TaskWorkspaceError(f"task branch already exists without a task record: {branch}")
        if worktree.exists():
            raise TaskWorkspaceError(f"task worktree path already exists without a task record: {worktree}")
        worktree.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "-C", str(repository), "worktree", "add", "-b", branch.removeprefix("refs/heads/"), str(worktree), target_sha], repository)
        record = {"schema_version": RECORD_SCHEMA, "task_id": task_id, "state": "WORKING",
                  "repository": str(repository), "target_ref": config["target_ref"], "base_sha": target_sha,
                  "branch_ref": branch, "worktree": str(worktree), "tip_sha": target_sha,
                  "changed_paths": [], "validation": []}
        state["tasks"][task_id] = record
        try:
            write_state(controller, state)
        except Exception:
            # Creation is not admitted without durable controller truth. Keep no
            # unrecorded branch/worktree if the atomic state write itself fails.
            run(["git", "-C", str(repository), "worktree", "remove", str(worktree)], repository, check=False)
            run(["git", "-C", str(repository), "branch", "-D", branch.removeprefix("refs/heads/")], repository, check=False)
            raise
    return {**record, "outcome": "started"}


def _persist_failed_validation(controller: Path, task_id: str, frozen: dict[str, Any], validations: list[dict[str, Any]]) -> None:
    with state_lock(controller):
        state = read_state(controller)
        current = state["tasks"].get(task_id)
        if current != frozen:
            raise TaskWorkspaceError("task state changed during focused validation; inspect status and retry")
        state["tasks"][task_id] = {**current, "validation": validations,
                                   "last_validation_outcome": "TIMEOUT" if validations[-1]["timed_out"] else "FAILED"}
        write_state(controller, state)


def _finish_once(controller: Path, task_id: str) -> dict[str, Any]:
    config = load_config(controller)
    require_task(controller, task_id)
    with state_lock(controller):
        state = read_state(controller)
        record = state["tasks"].get(task_id)
        if not record:
            raise TaskWorkspaceError("task has not been started")
        if record.get("state") == "QUEUED":
            return {**record, "outcome": "already_queued"}
        if record.get("state") != "WORKING":
            raise TaskWorkspaceError(f"task cannot finish from {record.get('state')}")
        frozen_record = json.loads(json.dumps(record))

    # Validations run outside the controller state lock. Independent feature
    # finishes therefore stay concurrent; the compare below prevents stale state.
    repository = product_repository(controller, config)
    worktree = exact_root(Path(record["worktree"]), "recorded task worktree")
    if repository != Path(record["repository"]).resolve() or worktree != worktree_path(config, task_id):
        raise TaskWorkspaceError("task repository/worktree identity drifted")
    head = git(worktree, "rev-parse", "HEAD")
    if git(worktree, "symbolic-ref", "-q", "HEAD", check=False) != record["branch_ref"] or git(repository, "rev-parse", record["branch_ref"], check=False) != head:
        raise TaskWorkspaceError("task branch/worktree identity drifted")
    if git(worktree, "status", "--porcelain=v1", "--untracked-files=all"):
        raise TaskWorkspaceError("task worktree is dirty; commit or remove all changes before finish")
    if head == record["base_sha"]:
        raise TaskWorkspaceError("task has no committed changes")
    if run(["git", "-C", str(repository), "merge-base", "--is-ancestor", record["base_sha"], head], repository, check=False).returncode:
        raise TaskWorkspaceError("task tip no longer descends from the exact recorded base")
    changed = sorted(set(git(worktree, "diff", "--name-only", f"{record['base_sha']}..{head}").splitlines()))
    if not changed:
        raise TaskWorkspaceError("task has no product diff from its exact recorded base")
    forbidden = [path for path in changed if path_within(path, config["controller_private_paths"])]
    outside = [path for path in changed if not path_within(path, config["allowed_paths"])]
    if forbidden or outside:
        raise TaskWorkspaceError(f"task changed disallowed paths: {', '.join(sorted(set(forbidden + outside)))}")
    validations = []
    for row in config["focused_validation"]:
        cwd = (worktree / row["cwd"]).resolve()
        try:
            cwd.relative_to(worktree)
        except ValueError as exc:
            raise TaskWorkspaceError("focused validation cwd escaped task worktree") from exc
        evidence = run_validation(row, cwd)
        validations.append(evidence)
        if evidence["timed_out"] or evidence["exit_code"]:
            _persist_failed_validation(controller, task_id, frozen_record, validations)
            if evidence["timed_out"]:
                raise TaskWorkspaceError(f"focused validation timed out ({row['id']}) after {row['timeout_seconds']}s")
            detail = evidence["stderr_tail"] or evidence["stdout_tail"]
            raise TaskWorkspaceError(f"focused validation failed ({row['id']}, exit {evidence['exit_code']}): {detail}")
    if load_config(controller) != config:
        raise TaskWorkspaceError("task workspace policy changed during focused validation")
    if git(worktree, "rev-parse", "HEAD") != head or git(worktree, "status", "--porcelain=v1", "--untracked-files=all"):
        raise TaskWorkspaceError("task tip or worktree changed during focused validation")
    queued = {**record, "state": "QUEUED", "tip_sha": head, "changed_paths": changed,
              "validation": validations, "last_validation_outcome": "PASSED"}
    with state_lock(controller):
        state = read_state(controller)
        current = state["tasks"].get(task_id)
        if current != frozen_record:
            if isinstance(current, dict) and current.get("state") == "QUEUED" and current.get("tip_sha") == head:
                return {**current, "outcome": "already_queued"}
            raise TaskWorkspaceError("task state changed during focused validation; inspect status and retry")
        state["tasks"][task_id] = queued
        write_state(controller, state)
    return {**queued, "outcome": "queued"}


def finish(controller: Path, task_id: str) -> dict[str, Any]:
    # Same-task finish calls serialize across validation; different task IDs use
    # different leases and continue in parallel.
    if not TASK_RE.fullmatch(task_id):
        raise TaskWorkspaceError("unsafe task id")
    with finish_lock(controller, task_id):
        return _finish_once(controller, task_id)


def status(controller: Path, task_id: str) -> dict[str, Any]:
    config = load_config(controller)
    require_task(controller, task_id)
    state = read_state(controller)
    record = state["tasks"].get(task_id)
    if not record:
        return {"schema_version": RECORD_SCHEMA, "task_id": task_id, "state": "NOT_STARTED", "outcome": "status"}
    result = {**record, "outcome": "status"}
    repository = Path(record.get("repository", ""))
    if repository.is_dir():
        current = optional_ref_sha(repository, record.get("target_ref", ""))
        result["current_target_sha"] = current or None
        result["target_available"] = bool(current)
        result["target_moved"] = (current != record.get("base_sha")) if current else None
        if not current:
            result["target_error"] = "target_ref_unavailable"
    else:
        result.update({"current_target_sha": None, "target_available": False,
                       "target_moved": None, "target_error": "repository_unavailable"})
    return result


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("operation", choices=("start", "status", "finish"))
    value.add_argument("--task", required=True)
    value.add_argument("--controller", type=Path, default=Path.cwd(), help=argparse.SUPPRESS)
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        controller = exact_root(args.controller, "controller")
        result = {"start": start, "status": status, "finish": finish}[args.operation](controller, args.task)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (TaskWorkspaceError, OSError, json.JSONDecodeError) as exc:
        print(f"task workspace: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
