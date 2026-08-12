#!/usr/bin/env python3
"""Small exact-base task-worktree state machine for the Bolt workflow.

The controller owns one compact JSON record per task. Product worktrees contain
only the target tree: this command never copies Kanban, specs, receipts, or
other controller data into them. Integration, review, release, and cleanup are
deliberately outside this interface.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import secrets
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
RUNTIME_PATH = ".juno_task/scripts/task_workspace.py"
GENERATED_OUTPUT_DECLARATION = "juno-code/scripts/implementation-contract.json"
MANAGED_OUTPUT_DECLARATION = "juno-code/src/templates/managed-assets.json"
GENERATED_OUTPUT_SCHEMA = "juno_generated_output_contract.v1"
UMBRELLA_INPUT_SCHEMA = "juno_task_umbrella_admission_input.v1"
UMBRELLA_ADMISSION_SCHEMA = "juno_task_umbrella_admission.v1"
UMBRELLA_RECOVERY_PLAN_SCHEMA = "juno_task_umbrella_recovery_plan.v1"
UMBRELLA_SUPERSESSION_SCHEMA = "juno_task_umbrella_admission_supersession.v1"
UMBRELLA_AUTHORIZATION_SCHEMA = "juno_task_umbrella_recovery_authorization.v1"
UMBRELLA_EXECUTION_MODE = "umbrella_owned_sequential"
UMBRELLA_RESERVATIONS_SCHEMA = "juno_task_umbrella_child_reservations.v1"


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
                "allowed_paths", "controller_private_paths", "focused_validation",
                "full_suite_validation"}
    if (not isinstance(value, dict) or frozenset(value) not in {frozenset(required), frozenset(required | {"selectable_paths"})}
            or value.get("schema_version") != CONFIG_SCHEMA):
        raise TaskWorkspaceError(f"task workspace policy must contain exactly the {CONFIG_SCHEMA} fields")
    value.setdefault("selectable_paths", [])
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
    for field in ("allowed_paths", "selectable_paths", "controller_private_paths"):
        items = value[field]
        if not isinstance(items, list) or (field != "selectable_paths" and not items):
            raise TaskWorkspaceError(f"{field} must be a list" + ("" if field == "selectable_paths" else " with at least one path"))
        value[field] = [normalized_relative(item, field) for item in items]
        if len(set(value[field])) != len(value[field]):
            raise TaskWorkspaceError(f"{field} contains duplicates")
    for selected in value["selectable_paths"]:
        if path_within(selected, value["allowed_paths"]) or path_within(selected, value["controller_private_paths"]):
            raise TaskWorkspaceError(f"selectable path overlaps a fixed or controller-private path: {selected}")
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
    full_suite = value["full_suite_validation"]
    if not isinstance(full_suite, dict) or set(full_suite) != {
            "id", "cwd", "argv", "timeout_seconds", "max_output_bytes"}:
        raise TaskWorkspaceError("full_suite_validation requires exactly id, cwd, argv, timeout_seconds, and max_output_bytes")
    normalized_relative(full_suite["cwd"], "full-suite validation cwd")
    if (not isinstance(full_suite["id"], str) or not full_suite["id"]
            or not isinstance(full_suite["argv"], list) or not full_suite["argv"]
            or any(not isinstance(part, str) or not part for part in full_suite["argv"])
            or not isinstance(full_suite["timeout_seconds"], int)
            or not 1 <= full_suite["timeout_seconds"] <= 3600
            or not isinstance(full_suite["max_output_bytes"], int)
            or not 1024 <= full_suite["max_output_bytes"] <= 1048576):
        raise TaskWorkspaceError("full_suite_validation bounds or argv are invalid")
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


def stable_sha256(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def task_manifest(controller: Path, task_id: str) -> tuple[Path, bytes]:
    path = task_file(controller, task_id)
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise TaskWorkspaceError(f"canonical hot Kanban task does not exist: {task_id}") from exc
    prefix = data[:4096].decode("utf-8", errors="replace")
    if not re.search(rf"(?m)^id:\s*{re.escape(task_id)}\s*$", prefix):
        raise TaskWorkspaceError(f"canonical Kanban task identity mismatch: {task_id}")
    return path, data


def require_task(controller: Path, task_id: str) -> None:
    task_manifest(controller, task_id)


def read_json_object(path: Path, label: str) -> tuple[dict[str, Any], str]:
    try:
        data = path.read_bytes()
        value = json.loads(data)
    except (OSError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"invalid {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise TaskWorkspaceError(f"invalid {label}: expected an object")
    return value, hashlib.sha256(data).hexdigest()


def load_umbrella_input(path: Path) -> tuple[dict[str, Any], str]:
    value, source_sha = read_json_object(path, "umbrella admission input")
    if (set(value) != {"schema_version", "execution_mode", "children"}
            or value.get("schema_version") != UMBRELLA_INPUT_SCHEMA
            or value.get("execution_mode") != UMBRELLA_EXECUTION_MODE
            or not isinstance(value.get("children"), list) or not value["children"]
            or not all(isinstance(item, str) and TASK_RE.fullmatch(item)
                       for item in value["children"])):
        raise TaskWorkspaceError(
            f"umbrella admission input must use {UMBRELLA_INPUT_SCHEMA} and declare only ordered child IDs"
        )
    if len(set(value["children"])) != len(value["children"]):
        raise TaskWorkspaceError("umbrella child set is duplicated or cyclic")
    return value, source_sha


def child_reservations(state: dict[str, Any]) -> dict[str, str]:
    value = state["queues"].setdefault("umbrella_child_reservations", {
        "schema_version": UMBRELLA_RESERVATIONS_SCHEMA, "owners": {},
    })
    if (not isinstance(value, dict) or set(value) != {"schema_version", "owners"}
            or value.get("schema_version") != UMBRELLA_RESERVATIONS_SCHEMA
            or not isinstance(value.get("owners"), dict)
            or not all(TASK_RE.fullmatch(str(child)) and TASK_RE.fullmatch(str(owner))
                       for child, owner in value["owners"].items())):
        raise TaskWorkspaceError("umbrella child reservation state is invalid")
    return value["owners"]


def state_path(controller: Path) -> Path:
    return controller / ".juno_task/state/tasks.json"


def read_state(controller: Path) -> dict[str, Any]:
    path = state_path(controller)
    if not path.exists():
        return {"schema_version": STATE_SCHEMA, "tasks": {}, "queues": {}}
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"invalid task state: {exc}") from exc
    # Pre-queue Bolt controllers have the same task-record schema without the
    # canonical queues section. Reading adds the empty section; the next atomic
    # state write performs the one-way, data-preserving schema completion.
    if isinstance(value, dict) and set(value) == {"schema_version", "tasks"} and value.get("schema_version") == STATE_SCHEMA:
        value = {**value, "queues": {}}
    if (not isinstance(value, dict) or set(value) != {"schema_version", "tasks", "queues"}
            or value.get("schema_version") != STATE_SCHEMA
            or not isinstance(value.get("tasks"), dict) or not isinstance(value.get("queues"), dict)):
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


def assign_enqueue_sequence(state: dict[str, Any]) -> int:
    meta = state["queues"].setdefault(
        "task_workspace_fifo", {"schema_version": "juno_task_workspace_fifo.v1", "next": 1}
    )
    if (not isinstance(meta, dict) or set(meta) != {"schema_version", "next"}
            or meta.get("schema_version") != "juno_task_workspace_fifo.v1"
            or not isinstance(meta.get("next"), int) or isinstance(meta.get("next"), bool)
            or not 1 <= meta["next"] <= 2**63 - 1):
        raise TaskWorkspaceError("task FIFO sequence state is invalid")
    value = meta["next"]
    meta["next"] += 1
    return value


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


def _log_component(value: str, fallback: str) -> str:
    cleaned = __import__("re").sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-.")
    return cleaned[:64] or fallback


def allocate_long_run_log(workflow: str, task: str) -> tuple[Path, Any]:
    """Exclusively allocate and announce one predictable, globally observable log."""
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    base = f"yy-{_log_component(workflow, 'run')}-{_log_component(task, 'task')}-{stamp}"
    for suffix in ("", *[f"-{number}" for number in range(1, 100)]):
        path = Path("/tmp") / f"{base}{suffix}.log"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            handle = os.fdopen(fd, "wb", buffering=0)
            print(f"yy long run log: {path}", file=sys.stderr, flush=True)
            return path, handle
        except FileExistsError:
            continue
        except OSError as exc:
            raise TaskWorkspaceError(f"cannot allocate long-run log {path}: {exc}") from exc
    raise TaskWorkspaceError(f"cannot allocate unique long-run log for {base}")


def _announce_long_run_completion(started: float, exit_code: int,
                                  timed_out: bool, log_path: Path) -> tuple[str, int]:
    finished = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    duration_ms = int((time.monotonic() - started) * 1000)
    print("yy long run complete: "
          f"finish_time={finished} duration_ms={duration_ms} exit_code={exit_code} "
          f"timed_out={'true' if timed_out else 'false'} log_path={log_path}",
          file=sys.stderr, flush=True)
    return finished, duration_ms


def run_validation(row: dict[str, Any], cwd: Path) -> dict[str, Any]:
    """Run argv-only validation with stdin closed and bounded output tails."""
    limit = row["max_output_bytes"]
    # Structured command output remains on stdout; producer bytes are always
    # relayed on stderr so callers never need an opt-in to observe a long run.
    stream_live = True
    started = time.monotonic()
    started_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    task_label = os.environ.get("JUNO_TASK_ID") or cwd.name
    log_path, log_handle = allocate_long_run_log(f"validation-{row['id']}", task_label)
    validation_env = {
        key: value for key, value in os.environ.items()
        if not key.startswith("JUNO_CONTROL_")
    }
    try:
        process = subprocess.Popen(row["argv"], cwd=cwd, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True, env=validation_env)
    except OSError as exc:
        message = str(exc).encode("utf-8", errors="replace")
        log_handle.write(message); log_handle.close()
        completed_at, duration_ms = _announce_long_run_completion(
            started, 127, False, log_path)
        tail = message[-limit:]
        return {"id": row["id"], "argv": row["argv"], "exit_code": 127,
                "timed_out": False, "timeout_seconds": row["timeout_seconds"], "duration_ms": duration_ms,
                "started_at": started_at, "completed_at": completed_at,
                "log_path": str(log_path), "log_sha256": hashlib.sha256(message).hexdigest(),
                "log_write_failed": False, "log_write_error": None,
                "stdout_tail": "", "stderr_tail": tail.decode("utf-8", errors="replace"),
                "stdout_truncated_bytes": 0, "stderr_truncated_bytes": len(message) - len(tail),
                "stdout_sha256": hashlib.sha256(b"").hexdigest(),
                "stderr_sha256": hashlib.sha256(message).hexdigest()}
    selector = selectors.DefaultSelector()
    stdout_tail = bytearray()
    stderr_tail = bytearray()
    stream_info = {process.stdout: ("stdout", stdout_tail), process.stderr: ("stderr", stderr_tail)}
    totals = {"stdout": 0, "stderr": 0}
    hashes = {"stdout": hashlib.sha256(), "stderr": hashlib.sha256()}
    for stream in stream_info:
        if stream is not None:
            selector.register(stream, selectors.EVENT_READ)
    deadline = started + row["timeout_seconds"]
    timed_out = False
    log_write_error: str | None = None
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
            hashes[name].update(data)
            _append_tail(tail, data, limit)
            if log_write_error is None:
                try:
                    log_handle.write(data)
                except OSError as exc:
                    log_write_error = str(exc)
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
            if stream_live:
                # Keep stdout reserved for the command's structured result.
                # A caller can merge stderr into tee for one observable log.
                sys.stderr.write(data.decode("utf-8", errors="replace"))
                sys.stderr.flush()
    exit_code = process.wait()
    if log_write_error is not None:
        exit_code = 74
    log_handle.close()
    completed_at, duration_ms = _announce_long_run_completion(
        started, exit_code, timed_out, log_path)
    selector.close()
    if process.stdout is not None:
        process.stdout.close()
    if process.stderr is not None:
        process.stderr.close()
    return {"id": row["id"], "argv": row["argv"], "exit_code": exit_code,
            "timed_out": timed_out, "timeout_seconds": row["timeout_seconds"],
            "duration_ms": duration_ms, "started_at": started_at, "completed_at": completed_at,
            "log_path": str(log_path),
            "log_sha256": hashlib.sha256(log_path.read_bytes()).hexdigest(),
            "log_write_failed": log_write_error is not None,
            "log_write_error": log_write_error,
            "stdout_tail": bytes(stdout_tail).decode("utf-8", errors="replace"),
            "stderr_tail": bytes(stderr_tail).decode("utf-8", errors="replace"),
            "stdout_truncated_bytes": totals["stdout"] - len(stdout_tail),
            "stderr_truncated_bytes": totals["stderr"] - len(stderr_tail),
            "stdout_sha256": hashes["stdout"].hexdigest(),
            "stderr_sha256": hashes["stderr"].hexdigest()}


def path_within(path: str, roots: list[str]) -> bool:
    return any(path == root or path.startswith(root + "/") for root in roots)


def target_blob(repository: Path, target_sha: str, path: str) -> bytes | None:
    """Read one exact tracked blob without trusting the controller checkout."""
    normalized_relative(path, "generated output path")
    result = subprocess.run(
        ["git", "-C", str(repository), "show", f"{target_sha}:{path}"],
        cwd=repository, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return result.stdout if result.returncode == 0 else None


def target_json(repository: Path, target_sha: str, path: str) -> tuple[dict[str, Any], str]:
    data = target_blob(repository, target_sha, path)
    if data is None:
        raise TaskWorkspaceError(f"generated-output declaration is missing: {path}")
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"invalid generated-output declaration {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise TaskWorkspaceError(f"invalid generated-output declaration {path}: expected object")
    return value, hashlib.sha256(data).hexdigest()


def derived_output_admission(repository: Path, target_sha: str,
                             admitted_paths: list[str]) -> tuple[list[str], dict[str, Any]]:
    """Expand admitted canonical sources to exact, declared parity destinations."""
    generated, generated_sha = target_json(repository, target_sha, GENERATED_OUTPUT_DECLARATION)
    if (set(generated) != {"schema_version", "source", "destinations"}
            or generated.get("schema_version") != GENERATED_OUTPUT_SCHEMA
            or not isinstance(generated.get("destinations"), list)):
        raise TaskWorkspaceError(f"invalid generated-output declaration {GENERATED_OUTPUT_DECLARATION}")
    source = normalized_relative(generated.get("source"), "generated source")
    destinations = [normalized_relative(item, "generated destination")
                    for item in generated["destinations"]]
    if not destinations or len(set(destinations)) != len(destinations) or source in destinations:
        raise TaskWorkspaceError(f"invalid generated-output declaration {GENERATED_OUTPUT_DECLARATION}")
    pairs: list[tuple[str, str, str, str]] = [
        (source, destination, "generator", GENERATED_OUTPUT_DECLARATION)
        for destination in destinations
    ]

    managed, managed_sha = target_json(repository, target_sha, MANAGED_OUTPUT_DECLARATION)
    rows = managed.get("admissionOutputs")
    if (managed.get("schemaVersion") != 1 or not isinstance(managed.get("assets"), list)
            or not isinstance(rows, list)):
        raise TaskWorkspaceError(f"invalid generated-output declaration {MANAGED_OUTPUT_DECLARATION}")
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {"source", "destination"}
                or not isinstance(row.get("source"), str)
                or not isinstance(row.get("destination"), str)):
            raise TaskWorkspaceError(f"invalid generated-output declaration {MANAGED_OUTPUT_DECLARATION}")
        managed_source = normalized_relative(
            f"juno-code/src/templates/{row.get('source')}", "managed source")
        destination = normalized_relative(row.get("destination"), "managed destination")
        if managed_source == destination:
            raise TaskWorkspaceError(f"invalid generated-output declaration {MANAGED_OUTPUT_DECLARATION}")
        pairs.append((managed_source, destination, "managed", MANAGED_OUTPUT_DECLARATION))

    seen_pairs: set[tuple[str, str]] = set()
    destination_sources: dict[str, str] = {}
    for pair_source, destination, _kind, _declaration in pairs:
        pair = (pair_source, destination)
        if pair in seen_pairs:
            raise TaskWorkspaceError(
                f"duplicate generated-output pair: {pair_source} -> {destination}")
        prior_source = destination_sources.get(destination)
        if prior_source is not None and prior_source != pair_source:
            raise TaskWorkspaceError(
                f"conflicting generated-output destination {destination}: {prior_source}, {pair_source}")
        seen_pairs.add(pair)
        destination_sources[destination] = pair_source

    declared: dict[tuple[str, str], tuple[str, str]] = {}
    for pair_source, destination, kind, declaration in pairs:
        if path_within(pair_source, admitted_paths):
            declared[(pair_source, destination)] = (kind, declaration)
    missing: list[str] = []
    bindings: list[dict[str, str]] = []
    expanded = list(admitted_paths)
    for (pair_source, destination), (kind, declaration) in sorted(declared.items()):
        source_bytes = target_blob(repository, target_sha, pair_source)
        destination_bytes = target_blob(repository, target_sha, destination)
        if source_bytes is None:
            missing.append(pair_source)
        if destination_bytes is None:
            missing.append(destination)
        if source_bytes is None or destination_bytes is None:
            continue
        if not path_within(destination, expanded):
            expanded.append(destination)
        bindings.append({
            "source": pair_source, "destination": destination, "kind": kind,
            "declaration": declaration,
            "base_source_sha256": hashlib.sha256(source_bytes).hexdigest(),
            "base_destination_sha256": hashlib.sha256(destination_bytes).hexdigest(),
        })
    if missing:
        raise TaskWorkspaceError(
            "declared generated outputs are missing at task start: " + ", ".join(sorted(set(missing)))
        )
    receipt = {
        "schema_version": "juno_task_generated_output_admission.v1",
        "declarations": {
            GENERATED_OUTPUT_DECLARATION: generated_sha,
            MANAGED_OUTPUT_DECLARATION: managed_sha,
        },
        "bindings": bindings,
    }
    return expanded, receipt


def verify_derived_output_parity(repository: Path, tip_sha: str,
                                 admission: Any, changed: list[str]) -> None:
    expected_declarations = {GENERATED_OUTPUT_DECLARATION, MANAGED_OUTPUT_DECLARATION}
    if (not isinstance(admission, dict)
            or set(admission) != {"schema_version", "declarations", "bindings"}
            or admission.get("schema_version") != "juno_task_generated_output_admission.v1"
            or not isinstance(admission.get("declarations"), dict)
            or set(admission["declarations"]) != expected_declarations
            or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
                   for value in admission["declarations"].values())
            or not isinstance(admission.get("bindings"), list)):
        raise TaskWorkspaceError("task creation receipt has no valid frozen generated-output admission")
    changed_set = set(changed)
    drift: list[str] = []
    seen_pairs: set[tuple[str, str]] = set()
    destination_sources: dict[str, str] = {}
    for binding in admission["bindings"]:
        if (not isinstance(binding, dict) or set(binding) != {
                "source", "destination", "kind", "declaration",
                "base_source_sha256", "base_destination_sha256"}
                or binding.get("kind") not in {"generator", "managed"}
                or binding.get("declaration") not in expected_declarations
                or any(not isinstance(binding.get(key), str)
                       or not re.fullmatch(r"[0-9a-f]{64}", binding[key])
                       for key in ("base_source_sha256", "base_destination_sha256"))):
            raise TaskWorkspaceError("task generated-output admission is invalid")
        source = normalized_relative(binding["source"], "frozen generated source")
        destination = normalized_relative(binding["destination"], "frozen generated destination")
        pair = (source, destination)
        if (pair in seen_pairs or (destination in destination_sources
                                   and destination_sources[destination] != source)):
            raise TaskWorkspaceError("task generated-output admission has duplicate or conflicting pairs")
        seen_pairs.add(pair)
        destination_sources[destination] = source
        if source not in changed_set and destination not in changed_set:
            continue
        source_bytes = target_blob(repository, tip_sha, source)
        destination_bytes = target_blob(repository, tip_sha, destination)
        if source_bytes is None or destination_bytes is None or source_bytes != destination_bytes:
            drift.append(destination)
    if drift:
        raise TaskWorkspaceError(
            "generated-output byte parity failed: " + ", ".join(sorted(set(drift)))
        )


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


def runtime_generation(repository: Path, target_sha: str) -> dict[str, Any]:
    """Bind the executing lifecycle bytes to the canonical target generation."""
    running_path = Path(__file__).resolve()
    try:
        running = running_path.read_bytes()
    except OSError as exc:
        raise TaskWorkspaceError(f"cannot read executing task runtime: {exc}") from exc
    target = run(["git", "-C", str(repository), "show",
                  f"{target_sha}:{RUNTIME_PATH}"], repository, check=False)
    target_bytes = target.stdout.encode("utf-8")
    running_sha = hashlib.sha256(running).hexdigest()
    target_sha256 = hashlib.sha256(target_bytes).hexdigest() if target.returncode == 0 else None
    return {"runtime_path": str(running_path), "target_path": RUNTIME_PATH,
            "running_sha256": running_sha, "target_sha256": target_sha256,
            "current": bool(target.returncode == 0 and running_sha == target_sha256)}


def require_current_runtime(repository: Path, target_sha: str) -> dict[str, Any]:
    generation = runtime_generation(repository, target_sha)
    if not generation["current"]:
        raise TaskWorkspaceError(
            "managed task runtime is stale or absent from the target; run `yy scripts update --force` "
            "from a juno-code package matching the target, then retry"
        )
    return generation


def assert_no_controller_data(repository: Path, sha: str, forbidden: list[str]) -> None:
    # Exact non-recursive prefix lookups avoid enumerating a potentially huge tree.
    offenders = [root for root in forbidden if git(repository, "ls-tree", "--name-only", sha, "--", root)]
    if offenders:
        sample = ", ".join(offenders[:5])
        raise TaskWorkspaceError(f"product target contains controller-private data ({sample}); hard-cut it before task start")


def require_full_task_materialization(worktree: Path, target_sha: str,
                                      allowed_paths: list[str],
                                      selected_entries: Optional[dict[str, dict[str, str]]] = None) -> dict[str, Any]:
    """Prove that a task role received a full checkout, never controller sparsity."""
    sparse = git(worktree, "config", "--worktree", "--bool", "--get",
                 "core.sparseCheckout", check=False).lower()
    if sparse == "true":
        raise TaskWorkspaceError("task worktree still has sparse checkout enabled")
    skipped = [line[2:] for line in git(worktree, "ls-files", "-t").splitlines()
               if line.startswith("S ")]
    if skipped:
        raise TaskWorkspaceError(
            f"task worktree still has skip-worktree paths ({', '.join(skipped[:5])})"
        )
    materialized = []
    for path in allowed_paths:
        if git(worktree, "ls-tree", "-r", "--name-only", target_sha, "--", path):
            if not (worktree / path).exists():
                raise TaskWorkspaceError(f"task worktree did not materialize tracked path: {path}")
            materialized.append(path)
    for path, entry in (selected_entries or {}).items():
        if entry["mode"] != "160000":
            continue
        nested = worktree / path
        actual = git(nested, "rev-parse", "HEAD", check=False) if nested.is_dir() else ""
        if actual != entry["object"]:
            raise TaskWorkspaceError(
                f"selected gitlink was not initialized at the target object: {path} ({entry['object']})"
            )
    return {"mode": "full", "sparse_checkout": False,
            "materialized_allowed_paths": sorted(materialized)}


def selected_task_paths(config: dict[str, Any], repository: Path, target_sha: str,
                        requested: list[str]) -> tuple[list[str], dict[str, dict[str, str]]]:
    normalized = [normalized_relative(item, "required task path") for item in requested]
    if len(set(normalized)) != len(normalized):
        raise TaskWorkspaceError("required task paths contain duplicates")
    unknown = [item for item in normalized if item not in config["selectable_paths"]]
    if unknown:
        raise TaskWorkspaceError(
            f"required task path is not admitted by policy: {', '.join(unknown)}"
        )
    entries: dict[str, dict[str, str]] = {}
    for item in normalized:
        output = git(repository, "ls-tree", target_sha, "--", item, check=False)
        lines = [line for line in output.splitlines() if line]
        if len(lines) != 1:
            raise TaskWorkspaceError(f"required task path is absent or ambiguous at target: {item}")
        metadata, actual_path = lines[0].split("\t", 1)
        mode, kind, object_id = metadata.split()
        if actual_path != item or mode not in {"040000", "160000"} or kind not in {"tree", "commit"}:
            raise TaskWorkspaceError(f"required task path has an unsafe target identity: {item}")
        entries[item] = {"mode": mode, "type": kind, "object": object_id}
    return [*config["allowed_paths"], *normalized], entries


def canonical_child_scope(repository: Path, base_sha: str, child_id: str,
                          body: bytes) -> tuple[list[str], list[dict[str, str]]]:
    """Resolve every exact tracked file named by canonical task prose; never trust caller scope."""
    text = body.decode("utf-8", errors="replace")
    # Path-like lexical tokens are merely candidates. Git's exact tree identity
    # is authority, and all matching tracked blobs are admitted. Directory
    # candidates are rejected rather than widened.
    candidates = sorted(set(
        token.strip("`'\"()[]{}<>,:;!?")
        for token in re.findall(
            r"(?:(?:\.?[A-Za-z0-9_-]+/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+)", text)
    ))
    evidence: list[dict[str, str]] = []
    for candidate in candidates:
        try:
            normalized_relative(candidate, f"canonical child {child_id} scope candidate")
        except TaskWorkspaceError:
            continue
        output = git(repository, "ls-tree", base_sha, "--", candidate, check=False)
        lines = [line for line in output.splitlines() if line]
        if len(lines) != 1:
            continue
        metadata, actual = lines[0].split("\t", 1)
        mode, kind, object_id = metadata.split()
        if actual == candidate and kind == "blob" and mode.startswith("100"):
            evidence.append({"path": candidate, "mode": mode, "object": object_id})
    if not evidence:
        raise TaskWorkspaceError(
            f"umbrella child {child_id} has no canonically derivable exact tracked-file scope"
        )
    return [row["path"] for row in evidence], evidence


def derive_umbrella_admission(controller: Path, umbrella_id: str, repository: Path,
                              target_ref: str, base_sha: str, input_path: Path,
                              baseline_paths: list[str], state: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    declaration, source_sha = load_umbrella_input(input_path)
    child_ids = declaration["children"]
    _umbrella_path, umbrella_body = task_manifest(controller, umbrella_id)
    umbrella_text = umbrella_body.decode("utf-8", errors="replace")
    declared_orders = [re.findall(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", match)
                       for match in re.findall(r"\[task_id\](.*?)\[/task_id\]", umbrella_text,
                                               flags=re.DOTALL)]
    if child_ids not in declared_orders:
        raise TaskWorkspaceError(
            "umbrella ordered child set has no exact durable [task_id] evidence: " + " ".join(child_ids)
        )
    if umbrella_id in child_ids:
        raise TaskWorkspaceError(f"umbrella child is self-referential or cyclic: {umbrella_id}")
    reservations = child_reservations(state)
    bindings: list[dict[str, Any]] = []
    union = list(baseline_paths)
    for child_id in child_ids:
        owner = state["tasks"].get(child_id)
        reserved = reservations.get(child_id)
        if owner is not None or (reserved is not None and reserved != umbrella_id):
            identity = reserved or (owner.get("task_id", child_id) if isinstance(owner, dict) else child_id)
            raise TaskWorkspaceError(f"umbrella child {child_id} is already owned by {identity}")
        _path, body = task_manifest(controller, child_id)
        exact_paths, evidence = canonical_child_scope(repository, base_sha, child_id, body)
        for required in exact_paths:
            if not path_within(required, union):
                union.append(required)
        bindings.append({
            "task_id": child_id,
            "task_revision_sha256": hashlib.sha256(body).hexdigest(),
            "scope_evidence": evidence,
            "scope_evidence_sha256": stable_sha256(evidence),
            "required_paths": exact_paths,
            "target_ref": target_ref, "base_sha": base_sha,
        })
    admission = {
        "schema_version": UMBRELLA_ADMISSION_SCHEMA,
        "execution_mode": UMBRELLA_EXECUTION_MODE,
        "input_path": str(input_path.resolve()), "input_sha256": source_sha,
        "ordered_child_ids": child_ids,
        "child_bindings": bindings,
        "union_paths": sorted(union),
        "union_paths_sha256": stable_sha256(sorted(union)),
    }
    return sorted(union), admission


def finalize_umbrella_admission(repository: Path, base_sha: str, union: list[str],
                                admission: dict[str, Any]) -> tuple[list[str], dict[str, Any], dict[str, Any]]:
    # Resolve both directions of every declared generated pair. A child that
    # canonically names only an installed destination still binds and admits
    # its exact source; no parent directory is inferred.
    _all_paths, all_generated = derived_output_admission(repository, base_sha, ["juno-code"])
    generated_by_child: dict[str, list[dict[str, str]]] = {}
    expanded = list(union)
    for binding in admission["child_bindings"]:
        pairs = [row for row in all_generated["bindings"]
                 if (path_within(row["source"], binding["required_paths"])
                     or path_within(row["destination"], binding["required_paths"]))]
        for row in pairs:
            for exact in (row["source"], row["destination"]):
                if not path_within(exact, expanded): expanded.append(exact)
        generated_by_child[binding["task_id"]] = sorted([
            {"source": row["source"], "destination": row["destination"], "kind": row["kind"]}
            for row in pairs
        ], key=lambda row: (row["source"], row["destination"], row["kind"]))
    union, generated = derived_output_admission(repository, base_sha, expanded)
    return sorted(union), {**admission, "union_paths": sorted(union),
                           "union_paths_sha256": stable_sha256(sorted(union)),
                           "generated_output_bindings": generated_by_child}, generated


def umbrella_drift(controller: Path, repository: Path, admission: Any,
                   generated: Any, state: dict[str, Any], umbrella_id: str) -> list[dict[str, str]]:
    expected_keys = {"schema_version", "execution_mode", "input_path", "input_sha256", "ordered_child_ids",
                     "child_bindings", "union_paths", "union_paths_sha256", "generated_output_bindings"}
    if (not isinstance(admission, dict) or set(admission) != expected_keys
            or admission.get("schema_version") != UMBRELLA_ADMISSION_SCHEMA
            or admission.get("execution_mode") != UMBRELLA_EXECUTION_MODE
            or not isinstance(admission.get("ordered_child_ids"), list)
            or not isinstance(admission.get("child_bindings"), list)):
        return [{"reason": "malformed_frozen_admission"}]
    drift: list[dict[str, str]] = []
    try:
        _input, current_input_sha = load_umbrella_input(Path(admission["input_path"]))
        if current_input_sha != admission["input_sha256"]:
            drift.append({"reason": "umbrella_input_bytes_drift"})
    except (TaskWorkspaceError, TypeError):
        drift.append({"reason": "umbrella_input_unavailable"})
    if (admission["ordered_child_ids"] != [row.get("task_id") for row in admission["child_bindings"]]
            or stable_sha256(admission.get("union_paths")) != admission.get("union_paths_sha256")):
        drift.append({"reason": "order_or_union_hash_drift"})
    reservations = child_reservations(state)
    generated_pairs = {(row.get("source"), row.get("destination"), row.get("kind"))
                       for row in generated.get("bindings", [])} if isinstance(generated, dict) else set()
    bound_targets = {(row.get("target_ref"), row.get("base_sha"))
                     for row in admission["child_bindings"] if isinstance(row, dict)}
    if len(bound_targets) != 1:
        drift.append({"reason": "child_target_or_base_binding_drift"})
    for binding in admission["child_bindings"]:
        child_id = binding.get("task_id", "unknown") if isinstance(binding, dict) else "unknown"
        if (not isinstance(binding, dict) or set(binding) != {"task_id", "task_revision_sha256",
                "scope_evidence", "scope_evidence_sha256", "required_paths", "target_ref", "base_sha"}):
            drift.append({"task_id": child_id, "reason": "malformed_child_binding"}); continue
        try:
            _path, body = task_manifest(controller, child_id)
            paths, evidence = canonical_child_scope(repository, binding.get("base_sha", ""), child_id, body)
        except TaskWorkspaceError:
            drift.append({"task_id": child_id, "reason": "canonical_child_unavailable"}); continue
        if (hashlib.sha256(body).hexdigest() != binding.get("task_revision_sha256")
                or paths != binding.get("required_paths")
                or evidence != binding.get("scope_evidence")
                or stable_sha256(evidence) != binding.get("scope_evidence_sha256")):
            drift.append({"task_id": child_id, "reason": "revision_or_scope_drift"})
        if reservations.get(child_id) != umbrella_id:
            drift.append({"task_id": child_id, "reason": "child_reservation_drift"})
        expected_generated = sorted(
            ({"source": source, "destination": destination, "kind": kind}
             for source, destination, kind in generated_pairs
             if path_within(str(source), paths) or path_within(str(destination), paths)),
            key=lambda row: (row["source"], row["destination"], row["kind"]),
        )
        if expected_generated != admission["generated_output_bindings"].get(child_id):
            drift.append({"task_id": child_id, "reason": "generated_binding_drift"})
    return drift


def effective_admission(record: dict[str, Any]) -> tuple[list[str], Any, str]:
    supersessions = record.get("admission_supersessions", [])
    if supersessions:
        latest = supersessions[-1]
        if (len(supersessions) != 1
                or stable_sha256(latest) != record.get("admission_supersession_sha256")):
            raise TaskWorkspaceError("authorized umbrella superseding admission identity drifted")
        return (latest["umbrella_admission"]["union_paths"],
                latest["generated_output_admission"], "superseding")
    receipt = record.get("creation_receipt", {})
    return (receipt.get("allowed_paths", []), receipt.get("generated_output_admission"), "historical_creation")


def initialize_selected_gitlinks(worktree: Path, entries: dict[str, dict[str, str]]) -> None:
    for path, entry in entries.items():
        if entry["mode"] != "160000":
            continue
        run(["git", "-C", str(worktree), "submodule", "update", "--init", "--", path], worktree)


def branch_ref(config: dict[str, Any], task_id: str) -> str:
    ref = f"{config['branch_prefix']}{task_id}"
    if run(["git", "check-ref-format", ref], Path.cwd(), check=False).returncode:
        raise TaskWorkspaceError(f"derived task branch is invalid: {ref}")
    return ref


def worktree_path(config: dict[str, Any], task_id: str) -> Path:
    return (Path(config["workspace_root"]) / task_id).resolve()


def routing_identity(controller: Path) -> dict[str, str]:
    invocation = os.environ.get("JUNO_CONTROL_INVOCATION_ROOT", "").strip()
    role = os.environ.get("JUNO_CONTROL_INVOCATION_ROLE", "").strip()
    effective = os.environ.get("JUNO_CONTROL_EFFECTIVE_ROOT", "").strip()
    policy_operation = os.environ.get("JUNO_CONTROL_OPERATION", "").strip()
    values = (invocation, role, effective, policy_operation)
    if not any(values):
        return {"invocation_root": str(controller.resolve()), "invocation_role": "controller",
                "effective_root": str(controller.resolve())}
    if not all(values) or role not in {"controller", "task", "integration-owner"}:
        raise TaskWorkspaceError("forwarded control audit identity is incomplete or invalid")
    if Path(effective).expanduser().resolve() != controller.resolve():
        raise TaskWorkspaceError("forwarded control audit effective root mismatched the controller")
    invocation_root = exact_root(Path(invocation), "control invocation root")
    controller_common = git(controller, "rev-parse", "--path-format=absolute", "--git-common-dir")
    invocation_common = git(invocation_root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    persisted_role = git(invocation_root, "config", "--worktree", "--get", "juno.workspace.role", check=False)
    role_matches = (invocation_root == controller.resolve() if role == "controller"
                    else persisted_role == role)
    if Path(controller_common).resolve() != Path(invocation_common).resolve() or not role_matches:
        raise TaskWorkspaceError("forwarded control audit invocation identity is not registered")
    return {"invocation_root": str(invocation_root), "invocation_role": role,
            "effective_root": str(controller.resolve()), "policy_operation": policy_operation}


def record_control_audit(controller: Path, surface: str, operation: str,
                         task_id: Optional[str] = None) -> dict[str, str]:
    routing = routing_identity(controller)
    forwarded_policy = routing.get("policy_operation")
    expected_policy = ("kanban" if operation in {"status", "recovery-plan"} else "orchestration")
    if surface == "task" and operation not in {"start", "status", "finish", "recovery-plan", "recovery-apply"}:
        raise TaskWorkspaceError(f"unsupported task audit operation: {operation}")
    if surface == "merge" and operation not in {"status", "next", "resolve", "review", "reopen"}:
        raise TaskWorkspaceError(f"unsupported merge audit operation: {operation}")
    if forwarded_policy is not None and forwarded_policy != expected_policy:
        raise TaskWorkspaceError(
            f"forwarded control audit policy mismatch: expected {expected_policy}, found {forwarded_policy}"
        )
    routing = {key: value for key, value in routing.items() if key != "policy_operation"}
    receipt = {
        "schema_version": "juno_control_operation_audit.v1",
        "surface": surface, "operation": operation, "policy_operation": expected_policy,
        "task_id": task_id,
        "routing": routing, "recorded_at_unix_ns": time.time_ns(),
    }
    data = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode()
    root = controller / ".juno_task/runtime/control-audit" / surface
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{receipt['recorded_at_unix_ns']}-{secrets.token_hex(12)}.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data); handle.flush(); os.fsync(handle.fileno())
    return {"path": str(path.resolve()), "sha256": hashlib.sha256(data).hexdigest()}


def clean_identity(record: dict[str, Any], repository: Path, target_sha: str,
                   config: dict[str, Any]) -> bool:
    worktree = Path(record["worktree"])
    branch = record["branch_ref"]
    identity = record.get("workspace_identity", {})
    creation_receipt = record.get("creation_receipt", {})
    try:
        allowed_paths, selected_entries = selected_task_paths(
            config, repository, target_sha, creation_receipt.get("requested_paths", [])
        )
        umbrella = creation_receipt.get("umbrella_admission")
        if isinstance(umbrella, dict):
            allowed_paths = umbrella.get("union_paths", [])
        allowed_paths, generated_output_admission = derived_output_admission(
            repository, target_sha, allowed_paths)
        if (allowed_paths != creation_receipt.get("allowed_paths")
                or generated_output_admission != creation_receipt.get("generated_output_admission")):
            return False
        materialization = require_full_task_materialization(
            worktree, target_sha, allowed_paths, selected_entries
        )
    except (OSError, TaskWorkspaceError):
        return False
    return (
        record.get("state") == "WORKING"
        and stable_sha256(creation_receipt) == identity.get("create_receipt_sha256")
        and record.get("base_sha") == target_sha
        and worktree.is_dir()
        and git(worktree, "config", "--worktree", "--get", "juno.workspace.role", check=False) == "task"
        and git(worktree, "config", "--worktree", "--get", "juno.workspace.roleBase", check=False) == target_sha
        and git(worktree, "config", "--worktree", "--get", "juno.workspace.taskId", check=False) == record.get("task_id")
        and git(worktree, "config", "--worktree", "--get", "juno.workspace.manifestIdentity", check=False) == identity.get("manifest_identity")
        and git(worktree, "config", "--worktree", "--get", "juno.workspace.createReceiptSha256", check=False) == identity.get("create_receipt_sha256")
        and git(worktree, "config", "--worktree", "--get", "juno.workspace.expectedPathsSha256", check=False) == identity.get("expected_paths_sha256")
        and stable_sha256(materialization) == identity.get("materialization_sha256")
        and git(worktree, "config", "--worktree", "--get", "juno.workspace.materializationSha256", check=False) == identity.get("materialization_sha256")
        and git(worktree, "status", "--porcelain=v1", "--untracked-files=all", check=False) == ""
        and git(worktree, "rev-parse", "HEAD", check=False) == target_sha
        and git(repository, "rev-parse", branch, check=False) == target_sha
        and git(worktree, "symbolic-ref", "-q", "HEAD", check=False) == branch
    )


def start(controller: Path, task_id: str, requested_paths: Optional[list[str]] = None,
          umbrella_input: Optional[Path] = None) -> dict[str, Any]:
    config = load_config(controller)
    require_task(controller, task_id)
    repository = product_repository(controller, config)
    target_sha = ref_sha(repository, config["target_ref"])
    requested_paths = requested_paths or []
    allowed_paths, selected_entries = selected_task_paths(config, repository, target_sha, requested_paths)
    umbrella_admission = None
    provisional_state = read_state(controller)
    if umbrella_input is not None:
        allowed_paths, umbrella_admission = derive_umbrella_admission(
            controller, task_id, repository, config["target_ref"], target_sha,
            umbrella_input.resolve(), allowed_paths, provisional_state)
        allowed_paths, umbrella_admission, generated_output_admission = finalize_umbrella_admission(
            repository, target_sha, allowed_paths, umbrella_admission)
    else:
        allowed_paths, generated_output_admission = derived_output_admission(
            repository, target_sha, allowed_paths)
    generation = require_current_runtime(repository, target_sha)
    assert_no_controller_data(repository, target_sha, config["controller_private_paths"])
    branch = branch_ref(config, task_id)
    worktree = worktree_path(config, task_id)
    with state_lock(controller):
        state = read_state(controller)
        reservations = child_reservations(state)
        reserved_owner = reservations.get(task_id)
        if reserved_owner is not None and reserved_owner != task_id:
            raise TaskWorkspaceError(f"task {task_id} is tracking-only under umbrella {reserved_owner}")
        if umbrella_input is not None:
            locked_baseline, locked_entries = selected_task_paths(
                config, repository, target_sha, requested_paths)
            locked_union, locked_umbrella = derive_umbrella_admission(
                controller, task_id, repository, config["target_ref"], target_sha,
                umbrella_input.resolve(), locked_baseline, state)
            locked_union, locked_umbrella, locked_generated = finalize_umbrella_admission(
                repository, target_sha, locked_union, locked_umbrella)
            if ((locked_union, locked_entries, locked_umbrella, locked_generated)
                    != (allowed_paths, selected_entries, umbrella_admission, generated_output_admission)):
                raise TaskWorkspaceError("umbrella admission changed before mutation")
        existing = state["tasks"].get(task_id)
        if existing:
            receipt = existing.get("creation_receipt", {})
            if receipt.get("requested_paths", []) != requested_paths:
                raise TaskWorkspaceError("task start required paths differ from the frozen creation receipt")
            frozen_umbrella = receipt.get("umbrella_admission")
            if ((umbrella_admission is None) != (frozen_umbrella is None)
                    or (umbrella_admission is not None and umbrella_admission != frozen_umbrella)):
                raise TaskWorkspaceError("task start umbrella admission differs from the frozen creation receipt")
            if clean_identity(existing, repository, target_sha, config):
                return {**existing, "outcome": "already_started"}
            raise TaskWorkspaceError("task start identity drifted; preserve the worktree and inspect task status")
        # show-ref is intentionally quiet; its exit status is the branch-collision contract.
        if run(["git", "-C", str(repository), "show-ref", "--verify", "--quiet", branch], repository, check=False).returncode == 0:
            raise TaskWorkspaceError(f"task branch already exists without a task record: {branch}")
        if worktree.exists():
            raise TaskWorkspaceError(f"task worktree path already exists without a task record: {worktree}")
        worktree.parent.mkdir(parents=True, exist_ok=True)
        created = False
        try:
            run(["git", "-C", str(repository), "worktree", "add", "-b", branch.removeprefix("refs/heads/"), str(worktree), target_sha], repository)
            created = True
            run(["git", "-C", str(repository), "config", "extensions.worktreeConfig", "true"], repository)
            run(["git", "-C", str(worktree), "sparse-checkout", "disable"], worktree)
            initialize_selected_gitlinks(worktree, selected_entries)
            materialization = require_full_task_materialization(
                worktree, target_sha, allowed_paths, selected_entries
            )
            manifest_identity = hashlib.sha256(task_file(controller, task_id).read_bytes()).hexdigest()
            expected_paths_sha256 = stable_sha256(allowed_paths)
            materialization_sha256 = stable_sha256(materialization)
            routing = routing_identity(controller)
            creation_receipt = {"schema_version": "juno_task_workspace_creation.v1", "task_id": task_id,
                                "repository": str(repository), "target_ref": config["target_ref"],
                                "base_sha": target_sha, "branch_ref": branch, "worktree": str(worktree),
                                "manifest_identity": manifest_identity, "allowed_paths": allowed_paths,
                                "requested_paths": requested_paths, "selected_entries": selected_entries,
                                "expected_paths_sha256": expected_paths_sha256,
                                "materialization": materialization, "routing": routing,
                                "runtime_generation": generation,
                                "generated_output_admission": generated_output_admission}
            if umbrella_admission is not None:
                creation_receipt["umbrella_admission"] = umbrella_admission
            create_receipt_sha256 = stable_sha256(creation_receipt)
            identity = {"manifest_identity": manifest_identity,
                        "create_receipt_sha256": create_receipt_sha256,
                        "expected_paths_sha256": expected_paths_sha256,
                        "materialization_sha256": materialization_sha256}
            record = {"schema_version": RECORD_SCHEMA, "task_id": task_id, "state": "WORKING",
                      "repository": str(repository), "target_ref": config["target_ref"], "base_sha": target_sha,
                      "branch_ref": branch, "worktree": str(worktree), "tip_sha": target_sha,
                      "workspace_identity": identity, "creation_receipt": creation_receipt, "routing": routing,
                      "changed_paths": [], "validation": []}
            state["tasks"][task_id] = record
            if umbrella_admission is not None:
                for child_id in umbrella_admission["ordered_child_ids"]:
                    reservations[child_id] = task_id
            for key, value in (("role", "task"), ("roleBase", target_sha), ("taskId", task_id),
                               ("manifestIdentity", manifest_identity),
                               ("createReceiptSha256", create_receipt_sha256),
                               ("expectedPathsSha256", expected_paths_sha256),
                               ("materializationSha256", materialization_sha256)):
                run(["git", "-C", str(worktree), "config", "--worktree", f"juno.workspace.{key}", value], worktree)
            run(["git", "-C", str(worktree), "config", "--worktree", "--unset-all",
                 "juno.workspace.roleAuthority"], worktree, check=False)
            write_state(controller, state)
        except Exception as creation_error:
            # Creation is not admitted without durable controller truth. Keep no
            # unrecorded branch/worktree if the atomic state write itself fails.
            if created:
                run(["git", "-C", str(worktree), "submodule", "deinit", "-f", "--all"], worktree, check=False)
                run(["git", "-C", str(repository), "worktree", "remove", "--force", str(worktree)], repository, check=False)
                run(["git", "-C", str(repository), "branch", "-D", branch.removeprefix("refs/heads/")], repository, check=False)
                branch_exists = run(["git", "-C", str(repository), "show-ref", "--verify", "--quiet", branch],
                                    repository, check=False).returncode == 0
                if worktree.exists() or branch_exists:
                    raise TaskWorkspaceError(
                        "task creation failed and registered-worktree rollback was incomplete; preserve evidence and inspect Git worktrees"
                    ) from creation_error
            raise
    return {**record, "outcome": "started"}


def _recovery_plan_locked(controller: Path, task_id: str, input_path: Path,
                          config: dict[str, Any], repository: Path,
                          state: dict[str, Any]) -> dict[str, Any]:
    record = state["tasks"].get(task_id)
    if not isinstance(record, dict) or record.get("state") != "WORKING":
        raise TaskWorkspaceError("umbrella recovery requires an already-WORKING task")
    receipt = record.get("creation_receipt", {}); predecessor_sha = stable_sha256(receipt)
    if predecessor_sha != record.get("workspace_identity", {}).get("create_receipt_sha256"):
        raise TaskWorkspaceError("historical creation receipt identity drifted; preserve this umbrella and create a replacement")
    if receipt.get("umbrella_admission") is not None:
        raise TaskWorkspaceError("umbrella already has start-time child-union admission")
    if (Path(record.get("repository", "")).resolve() != repository
            or record.get("target_ref") != config["target_ref"]
            or record.get("base_sha") != receipt.get("base_sha")
            or record.get("branch_ref") != receipt.get("branch_ref")
            or record.get("worktree") != receipt.get("worktree")
            or ref_sha(repository, config["target_ref"]) != record["base_sha"]):
        raise TaskWorkspaceError("umbrella target/base/branch/worktree identity drifted; preserve it and create a replacement")
    worktree = exact_root(Path(record["worktree"]), "recorded umbrella worktree")
    head = git(worktree, "rev-parse", "HEAD")
    if (git(worktree, "symbolic-ref", "-q", "HEAD", check=False) != record["branch_ref"]
            or optional_ref_sha(repository, record["branch_ref"]) != head
            or git(worktree, "status", "--porcelain=v1", "--untracked-files=all")):
        raise TaskWorkspaceError("umbrella recovery requires the exact clean branch/worktree identity")
    if run(["git", "-C", str(repository), "merge-base", "--is-ancestor",
            record["base_sha"], head], repository, check=False).returncode:
        raise TaskWorkspaceError("umbrella tip is rewritten or does not descend from its frozen base")
    _path, umbrella_body = task_manifest(controller, task_id)
    if hashlib.sha256(umbrella_body).hexdigest() != receipt.get("manifest_identity"):
        raise TaskWorkspaceError("umbrella task body changed since start; preserve it and create a replacement")
    baseline, _selected = selected_task_paths(config, repository, record["base_sha"], receipt.get("requested_paths", []))
    union, admission = derive_umbrella_admission(
        controller, task_id, repository, record["target_ref"], record["base_sha"],
        input_path.resolve(), baseline, state)
    union, admission, generated = finalize_umbrella_admission(repository, record["base_sha"], union, admission)
    original_allowed = receipt.get("allowed_paths", [])
    commits = git(worktree, "rev-list", "--reverse", f"{record['base_sha']}..{head}").splitlines()
    history: list[dict[str, Any]] = []; escaped: list[str] = []
    for commit in commits:
        paths = sorted(set(git(worktree, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines()))
        history.append({"commit": commit, "paths": paths, "paths_sha256": stable_sha256(paths)})
        escaped.extend(path for path in paths if not path_within(path, original_allowed))
    if escaped:
        raise TaskWorkspaceError("prior umbrella commit history escaped the historical admission: " + ", ".join(sorted(set(escaped))))
    changed = sorted(set(git(worktree, "diff", "--name-only", f"{record['base_sha']}..{head}").splitlines()))
    return {"schema_version": UMBRELLA_RECOVERY_PLAN_SCHEMA, "task_id": task_id,
            "repository": str(repository), "target_ref": record["target_ref"],
            "base_sha": record["base_sha"], "branch_ref": record["branch_ref"],
            "worktree": record["worktree"], "current_tip": head,
            "predecessor_receipt_sha256": predecessor_sha,
            "umbrella_manifest_identity": receipt["manifest_identity"],
            "umbrella_input_sha256": admission["input_sha256"],
            "umbrella_admission": admission, "generated_output_admission": generated,
            "newly_admitted_paths": sorted(path for path in union if not path_within(path, original_allowed)),
            "prior_changed_paths": changed, "prior_commit_history": history,
            "prior_changes_within_predecessor": True}


def build_umbrella_recovery_plan(controller: Path, task_id: str, input_path: Path) -> dict[str, Any]:
    config = load_config(controller); require_task(controller, task_id)
    repository = product_repository(controller, config)
    with state_lock(controller):
        return _recovery_plan_locked(controller, task_id, input_path, config, repository, read_state(controller))


def apply_umbrella_recovery(controller: Path, task_id: str, plan_path: Path,
                            input_path: Path, authorization_path: Path) -> dict[str, Any]:
    authorization_path = authorization_path.expanduser().resolve()
    canonical_authorizations = (controller / ".juno_task/receipts/task-admission-authorizations").resolve()
    try:
        authorization_path.relative_to(canonical_authorizations)
    except ValueError as exc:
        raise TaskWorkspaceError("authorization receipt is not in the canonical immutable controller receipt root") from exc
    plan, plan_file_sha = read_json_object(plan_path, "umbrella recovery plan")
    authorization, authorization_file_sha = read_json_object(authorization_path, "umbrella recovery authorization")
    plan_sha = stable_sha256(plan)
    if (plan.get("schema_version") != UMBRELLA_RECOVERY_PLAN_SCHEMA or plan.get("task_id") != task_id
            or set(authorization) != {"schema_version", "authorization_id", "task_id", "action",
                                          "plan_sha256", "plan_file_sha256", "predecessor_receipt_sha256"}
            or authorization.get("schema_version") != UMBRELLA_AUTHORIZATION_SCHEMA
            or authorization.get("task_id") != task_id or authorization.get("action") != "supersede_umbrella_admission"
            or authorization.get("plan_sha256") != plan_sha
            or authorization.get("plan_file_sha256") != plan_file_sha
            or authorization.get("predecessor_receipt_sha256") != plan.get("predecessor_receipt_sha256")
            or not isinstance(authorization.get("authorization_id"), str) or not authorization["authorization_id"]):
        raise TaskWorkspaceError("canonical immutable recovery authorization does not bind this exact reviewed plan")
    config = load_config(controller); repository = product_repository(controller, config)
    with state_lock(controller):
        state = read_state(controller); record = state["tasks"].get(task_id)
        if not isinstance(record, dict): raise TaskWorkspaceError("umbrella disappeared before recovery apply")
        existing = record.get("admission_supersessions", [])
        if (existing and existing[-1].get("reviewed_plan_sha256") == plan_sha
                and existing[-1].get("authorization_receipt", {}).get("sha256") == authorization_file_sha):
            return {**record, "outcome": "already_applied", "admission_status": "authorized_superseding"}
        if existing: raise TaskWorkspaceError("umbrella already has a different superseding admission")
        expected = _recovery_plan_locked(controller, task_id, input_path, config, repository, state)
        if expected != plan:
            raise TaskWorkspaceError("recovery plan is stale or a locked identity/scope/binding changed")
        supersession = {"schema_version": UMBRELLA_SUPERSESSION_SCHEMA,
            "authorization_receipt": {"path": str(authorization_path.resolve()),
                                      "sha256": authorization_file_sha,
                                      "authorization_id": authorization["authorization_id"]},
            "reviewed_plan": {"path": str(plan_path.resolve()), "sha256": plan_sha,
                              "file_sha256": plan_file_sha},
            "reviewed_plan_sha256": plan_sha,
            "predecessor_receipt_sha256": plan["predecessor_receipt_sha256"],
            "current_tip": plan["current_tip"], "newly_admitted_paths": plan["newly_admitted_paths"],
            "unaffected_prior_evidence": {"changed_paths": plan["prior_changed_paths"],
                                          "commit_history": plan["prior_commit_history"],
                                          "within_predecessor": True},
            "umbrella_admission": plan["umbrella_admission"],
            "generated_output_admission": plan["generated_output_admission"],
            "rollback_semantics": "preserve predecessor and supersession; never narrow or rewrite either receipt",
            "refusal_semantics": "preserve umbrella and create a newly admitted replacement; never start a child worktree"}
        reservations = child_reservations(state)
        for child_id in plan["umbrella_admission"]["ordered_child_ids"]:
            if reservations.get(child_id) not in {None, task_id}:
                raise TaskWorkspaceError(f"child ownership changed before recovery apply: {child_id}")
            reservations[child_id] = task_id
        updated = {**record, "admission_supersessions": [supersession],
                   "admission_supersession_sha256": stable_sha256(supersession)}
        state["tasks"][task_id] = updated; write_state(controller, state)
    return {**updated, "outcome": "applied", "admission_status": "authorized_superseding"}


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
    configured_repository = product_repository(controller, config)
    require_current_runtime(configured_repository,
                            ref_sha(configured_repository, config["target_ref"]))
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
    creation_receipt = record.get("creation_receipt", {})
    if stable_sha256(creation_receipt) != record.get("workspace_identity", {}).get("create_receipt_sha256"):
        raise TaskWorkspaceError("task creation receipt identity drifted")
    frozen_allowed, frozen_generated_admission, _admission_source = effective_admission(record)
    if not isinstance(frozen_allowed, list) or not frozen_allowed:
        raise TaskWorkspaceError("task admission has no frozen allowed paths")
    frozen_umbrella = (record.get("admission_supersessions", [{}])[-1].get("umbrella_admission")
                       if record.get("admission_supersessions")
                       else creation_receipt.get("umbrella_admission"))
    if frozen_umbrella is not None:
        drift = umbrella_drift(controller, repository, frozen_umbrella,
                               frozen_generated_admission, read_state(controller), task_id)
        if drift:
            raise TaskWorkspaceError(f"frozen umbrella child admission drifted: {json.dumps(drift, sort_keys=True)}")
    outside = [path for path in changed if not path_within(path, frozen_allowed)]
    if forbidden or outside:
        raise TaskWorkspaceError(f"task changed disallowed paths: {', '.join(sorted(set(forbidden + outside)))}")
    verify_derived_output_parity(repository, head, frozen_generated_admission, changed)
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
        # Final locked checkpoint: no queue mutation follows stale child,
        # declaration, generated-binding, branch, tip, or cleanliness evidence.
        if (git(worktree, "rev-parse", "HEAD") != head
                or optional_ref_sha(repository, current["branch_ref"]) != head
                or git(worktree, "symbolic-ref", "-q", "HEAD", check=False) != current["branch_ref"]
                or git(worktree, "status", "--porcelain=v1", "--untracked-files=all")):
            raise TaskWorkspaceError("task branch/tip/worktree changed before queue mutation")
        if frozen_umbrella is not None:
            final_drift = umbrella_drift(controller, repository, frozen_umbrella,
                                         frozen_generated_admission, state, task_id)
            if final_drift:
                raise TaskWorkspaceError(
                    f"frozen umbrella admission drifted before queue mutation: {json.dumps(final_drift, sort_keys=True)}"
                )
        queued["enqueue_sequence"] = assign_enqueue_sequence(state)
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
    configured_repository = product_repository(controller, config)
    current_target = optional_ref_sha(configured_repository, config["target_ref"])
    generation = runtime_generation(configured_repository, current_target) if current_target else None
    state = read_state(controller)
    record = state["tasks"].get(task_id)
    if not record:
        return {"schema_version": RECORD_SCHEMA, "task_id": task_id, "state": "NOT_STARTED",
                "outcome": "status", "runtime_generation": generation}
    result = {**record, "outcome": "status", "runtime_generation": generation}
    frozen_umbrella = (record.get("admission_supersessions", [{}])[-1].get("umbrella_admission")
                       if record.get("admission_supersessions")
                       else record.get("creation_receipt", {}).get("umbrella_admission"))
    if frozen_umbrella is not None:
        _paths, _generated, source = effective_admission(record)
        result["umbrella_admission_status"] = {
            "authority": ("authorized_superseding" if source == "superseding" else "historical_creation"),
            "ordered_child_ids": frozen_umbrella.get("ordered_child_ids"),
            "child_bindings": frozen_umbrella.get("child_bindings"),
            "union_paths_sha256": frozen_umbrella.get("union_paths_sha256"),
            "child_revision_drift": umbrella_drift(
                controller, configured_repository, frozen_umbrella, _generated, state, task_id),
        }
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
    value.add_argument("operation", choices=("start", "status", "finish", "recovery-plan", "recovery-apply"))
    value.add_argument("--task", required=True)
    value.add_argument("--path", action="append", default=[], help="required policy-admitted product root")
    value.add_argument("--umbrella-admission", type=Path,
                       help="versioned ordered-child exact-scope input")
    value.add_argument("--plan", type=Path, help="exact reviewed recovery plan")
    value.add_argument("--output", type=Path, help="exclusive recovery plan output")
    value.add_argument("--authorization-receipt", type=Path,
                       help="canonical immutable authorization binding the exact reviewed plan")
    value.add_argument("--controller", type=Path, default=Path.cwd(), help=argparse.SUPPRESS)
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        controller = exact_root(args.controller, "controller")
        if args.operation != "start" and args.path:
            raise TaskWorkspaceError("--path is supported only for task start")
        audit = record_control_audit(controller, "task", args.operation, args.task)
        if args.operation == "start":
            if args.plan or args.output or args.authorization_receipt:
                raise TaskWorkspaceError("recovery options are not supported for task start")
            result = start(controller, args.task, args.path, args.umbrella_admission)
        elif args.operation == "recovery-plan":
            if not args.umbrella_admission or not args.output or args.authorization_receipt or args.plan:
                raise TaskWorkspaceError("recovery-plan requires --umbrella-admission and --output")
            plan = build_umbrella_recovery_plan(controller, args.task, args.umbrella_admission)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            data = (json.dumps(plan, sort_keys=True, separators=(",", ":")) + "\n").encode()
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data); handle.flush(); os.fsync(handle.fileno())
            result = {"schema_version": UMBRELLA_RECOVERY_PLAN_SCHEMA, "task_id": args.task,
                      "outcome": "planned", "plan_path": str(args.output.resolve()),
                      "plan_sha256": stable_sha256(plan), "plan_file_sha256": hashlib.sha256(data).hexdigest()}
        elif args.operation == "recovery-apply":
            if not args.umbrella_admission or not args.plan or not args.authorization_receipt or args.output:
                raise TaskWorkspaceError("recovery-apply requires --umbrella-admission, --plan, and --authorization-receipt")
            result = apply_umbrella_recovery(
                controller, args.task, args.plan, args.umbrella_admission, args.authorization_receipt)
        else:
            if args.umbrella_admission or args.plan or args.output or args.authorization_receipt:
                raise TaskWorkspaceError("admission/recovery options are unsupported for this operation")
            result = {"status": status, "finish": finish}[args.operation](controller, args.task)
        result = {**result, "control_audit": audit}
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (TaskWorkspaceError, OSError, json.JSONDecodeError) as exc:
        print(f"task workspace: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
