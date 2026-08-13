#!/usr/bin/env python3
"""Small exact-base task-worktree state machine for the Bolt workflow.

The controller owns one compact JSON record per task. Product worktrees contain
only the target tree: this command never copies Kanban, specs, receipts, or
other controller data into them. Integration, review, release, and cleanup are
deliberately outside this interface.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
import posixpath
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any, Iterator, Optional

CONFIG_SCHEMA = "juno_task_workspace_config.v1"
STATE_SCHEMA = "juno_task_workspace_state.v1"
RECORD_SCHEMA = "juno_task_workspace_record.v1"
SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")
TASK_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
SEMVER_RE = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\Z"
)
RUNTIME_PATH = ".juno_task/scripts/task_workspace.py"
RUNTIME_BOOTSTRAP_SCHEMA = "juno_target_task_runtime_bootstrap.v1"
RUNTIME_BOOTSTRAP_ROOT = ".juno_task/runtime/task-runtime-bootstrap"
MANAGED_INVENTORY_PATH = ".juno_task/managed-assets.json"
GENERATED_OUTPUT_DECLARATION = "juno-code/scripts/implementation-contract.json"
MANAGED_OUTPUT_DECLARATION = "juno-code/src/templates/managed-assets.json"
GENERATED_OUTPUT_SCHEMA = "juno_generated_output_contract.v1"


class TaskWorkspaceError(RuntimeError):
    pass


def is_valid_semver(value: Any) -> bool:
    """Return whether value is an exact ASCII SemVer 2.0.0 version string."""
    return isinstance(value, str) and SEMVER_RE.fullmatch(value) is not None


def run(argv: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, stdin=subprocess.DEVNULL)
    if check and result.returncode:
        raise TaskWorkspaceError(result.stderr.strip() or result.stdout.strip() or f"command failed: {argv!r}")
    return result


def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check=check).stdout.strip()


def git_pathnames(root: Path, *args: str) -> list[str]:
    """Read Git pathnames without display quoting or line-based ambiguity."""
    result = subprocess.run(
        ["git", "-C", str(root), *args], cwd=root, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
        raise TaskWorkspaceError(detail or f"Git pathname command failed: {args!r}")
    raw = result.stdout
    if raw and not raw.endswith(b"\0"):
        raise TaskWorkspaceError("Git produced malformed NUL-delimited changed paths")
    paths: list[str] = []
    for item in raw.split(b"\0")[:-1] if raw else []:
        if not item:
            raise TaskWorkspaceError("Git produced an empty changed path")
        try:
            value = item.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise TaskWorkspaceError(
                "Git changed path is not valid UTF-8 and cannot be represented in canonical JSON"
            ) from exc
        path = PurePosixPath(value)
        if (path.is_absolute() or path.as_posix() != value or value == "."
                or ".." in path.parts or ".git" in path.parts):
            raise TaskWorkspaceError("Git produced an unsafe changed path")
        paths.append(value)
    return sorted(set(paths))
def load_package_bound_test_fixture(test_file: str, fixture_name: str) -> Any:
    """Load a fixture only from a verified installed package or canonical source tree."""
    if not re.fullmatch(r"[A-Za-z0-9_]+\.py", fixture_name):
        raise TaskWorkspaceError("unsafe package test fixture name")
    test_path = Path(test_file).resolve()

    def load(candidate: Path) -> Any:
        candidate = candidate.resolve()
        if not candidate.is_file():
            raise TaskWorkspaceError("verified package is missing its canonical test fixture")
        spec = importlib.util.spec_from_file_location(
            f"juno_package_fixture_{candidate.stem}_{hashlib.sha256(str(candidate).encode()).hexdigest()[:12]}",
            candidate)
        if spec is None or spec.loader is None:
            raise TaskWorkspaceError("canonical package test fixture is not loadable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    # Installed execution has exactly one authority: the controller's bound,
    # hash-identified package. Never inspect an adjacent tests directory.
    explicit = os.environ.get("JUNO_TASK_ROOT", "").strip()
    explicit_root = Path(explicit).expanduser().resolve() if explicit else None
    installed_test_root = (test_path.parents[3] if len(test_path.parents) > 3 and
                           test_path.parents[2].name == ".juno_task" else None)
    package_test_root = (explicit_root / "dist/templates/scripts/tests"
                         if explicit_root is not None else None)
    explicit_applies = (explicit_root is not None and
                        (installed_test_root == explicit_root or test_path.parent == package_test_root))
    runtime_root = explicit_root if explicit_applies else installed_test_root
    if runtime_root is not None:
        identity_path = runtime_root / ".juno_task/runtime/identity.json"
        inventory_path = runtime_root / ".juno_task/managed-assets.json"
        if identity_path.exists() or explicit_applies:
            try:
                identity = json.loads(identity_path.read_bytes())
                inventory = json.loads(inventory_path.read_bytes())
                executable = Path(identity["executable"]).expanduser().resolve()
                version = identity["version"]
                executable_hash = hashlib.sha256(executable.read_bytes()).hexdigest()
                package_root = executable.parent.parent.parent
                package = json.loads((package_root / "package.json").read_text())
            except (OSError, KeyError, TypeError, json.JSONDecodeError):
                identity = inventory = package = None
                executable_hash = version = ""
                package_root = Path("/")
            valid = (
                isinstance(identity, dict) and set(identity) == {
                    "package", "version", "executable", "executable_sha256", "source", "tracked"}
                and identity.get("package") == "juno-code"
                and identity.get("source") == "installed-release" and identity.get("tracked") is False
                and is_valid_semver(version)
                and executable_hash == identity.get("executable_sha256")
                and isinstance(inventory, dict) and inventory.get("schemaVersion") == 1
                and inventory.get("packageName") == "juno-code"
                and inventory.get("packageVersion") == version
                and isinstance(inventory.get("assets"), dict)
                and isinstance(package, dict) and package.get("name") == "juno-code"
                and package.get("version") == version)
            if not valid:
                raise TaskWorkspaceError(
                    f"package-bound test fixture unavailable: {fixture_name}; run `yy scripts update --force` "
                    "from the controller's bound juno-code installation, then retry")
            return load(package_root / "dist/templates/scripts/tests" / fixture_name)

    # Development execution is the only fallback. Its identity is an actual
    # Git worktree plus exact tracked juno-code paths, never a guessed sibling.
    discovered = run(["git", "-C", str(test_path.parent), "rev-parse", "--show-toplevel"],
                     test_path.parent, check=False)
    if discovered.returncode == 0:
        source_root = Path(discovered.stdout.strip()).resolve()
        canonical = source_root / "juno-code/src/templates/scripts/tests" / fixture_name
        allowed_tests = {
            source_root / ".juno_task/scripts/tests" / test_path.name,
            source_root / "juno-code/src/templates/scripts/tests" / test_path.name}
        package_path = source_root / "juno-code/package.json"
        tracked = run(["git", "-C", str(source_root), "ls-files", "--error-unmatch",
                       str(canonical.relative_to(source_root)),
                       str(test_path.relative_to(source_root))], source_root, check=False)
        try:
            source_package = json.loads(package_path.read_text())
        except (OSError, json.JSONDecodeError):
            source_package = None
        if (test_path in allowed_tests and tracked.returncode == 0 and
                isinstance(source_package, dict) and source_package.get("name") == "juno-code"):
            return load(canonical)

    raise TaskWorkspaceError(
        f"package-bound test fixture unavailable: {fixture_name}; run `yy scripts update --force` "
        "from the controller's bound juno-code installation, then retry")


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


def lexical_absolute(path: Path) -> Path:
    """Normalize spelling without following a filesystem object."""
    return Path(os.path.abspath(os.path.expanduser(os.fspath(path))))


def reject_symlink_components(path: Path, label: str) -> None:
    """Refuse an exact identity path if any existing component is a symlink."""
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            if stat.S_ISLNK(current.lstat().st_mode):
                raise TaskWorkspaceError(f"{label} contains a symlink component: {current}")
        except FileNotFoundError:
            # The exact-root check supplies the stable missing/reused diagnosis.
            return


def exact_root(path: Path, label: str, *, physical_identity: bool = True) -> Path:
    lexical = lexical_absolute(path)
    if physical_identity:
        reject_symlink_components(lexical, label)
        candidate = lexical
    else:
        candidate = lexical.resolve()
    actual = git(candidate, "rev-parse", "--show-toplevel", check=False)
    actual_path = lexical_absolute(Path(actual)) if physical_identity and actual else (
        Path(actual).resolve() if actual else None)
    if not actual or actual_path != candidate:
        raise TaskWorkspaceError(f"{label} is not an exact Git worktree: {candidate}")
    return candidate


def task_file(controller: Path, task_id: str) -> Path:
    if not TASK_RE.fullmatch(task_id):
        raise TaskWorkspaceError("unsafe task id")
    return controller / ".juno_task/tasks" / task_id[:2].lower() / f"{task_id}.md"


def stable_sha256(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


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
    generated_bytes = target_blob(repository, target_sha, GENERATED_OUTPUT_DECLARATION)
    managed_bytes = target_blob(repository, target_sha, MANAGED_OUTPUT_DECLARATION)
    if generated_bytes is None and managed_bytes is None:
        return list(admitted_paths), {
            "schema_version": "juno_task_generated_output_admission.v2",
            "declarations": {}, "bindings": [],
            "scope": "product_has_no_juno_generated_output_surface",
        }
    if generated_bytes is None or managed_bytes is None:
        missing = (GENERATED_OUTPUT_DECLARATION if generated_bytes is None
                   else MANAGED_OUTPUT_DECLARATION)
        raise TaskWorkspaceError(
            f"generated-output declaration surface is partial; missing: {missing}")
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
    if (isinstance(admission, dict)
            and admission == {
                "schema_version": "juno_task_generated_output_admission.v2",
                "declarations": {}, "bindings": [],
                "scope": "product_has_no_juno_generated_output_surface",
            }):
        return
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
            "managed task runtime is stale or absent from the target; recover with "
            "`yy task runtime-bootstrap --dry-run`, review its receipt, then run "
            "`yy task runtime-bootstrap --apply <receipt>` and retry"
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


def _declared_submodule_urls(repository: Path, commit: str) -> dict[str, str]:
    raw = run(["git", "-C", str(repository), "show", f"{commit}:.gitmodules"],
              repository, check=False)
    if raw.returncode:
        return {}
    with tempfile.TemporaryDirectory(prefix="juno-gitmodules-") as temporary:
        config = Path(temporary) / ".gitmodules"
        config.write_text(raw.stdout)
        paths = run(["git", "config", "-f", str(config), "--get-regexp",
                     r"^submodule\..*\.path$"], repository, check=False).stdout.splitlines()
        result: dict[str, str] = {}
        for row in paths:
            key, _, path = row.partition(" ")
            name = key.removeprefix("submodule.").removesuffix(".path")
            url = run(["git", "config", "-f", str(config), "--get",
                       f"submodule.{name}.url"], repository, check=False).stdout.strip()
            if path and url:
                result[path] = url
        return result


def _resolved_submodule_url(parent_url: str | None, child_url: str) -> str:
    if (child_url.startswith("/") or child_url.startswith("file://")
            or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", child_url)
            or re.match(r"^[^/]+@[^:]+:", child_url)
            or not child_url.startswith(("./", "../"))):
        return child_url
    if not parent_url:
        raise TaskWorkspaceError(f"relative submodule URL has no authoritative parent remote: {child_url}")
    if parent_url.startswith("file://"):
        return "file://" + str((Path(parent_url.removeprefix("file://")).parent / child_url).resolve())
    if parent_url.startswith("/"):
        return str((Path(parent_url).parent / child_url).resolve())
    if "://" in parent_url:
        return urllib.parse.urljoin(parent_url.rstrip("/") + "/", child_url)
    scp = re.fullmatch(r"([^/:\s]+@[^:\s]+):(.+)", parent_url)
    if scp:
        resolved = posixpath.normpath(posixpath.join(scp.group(2), child_url))
        if resolved == ".." or resolved.startswith("../"):
            raise TaskWorkspaceError(f"relative submodule URL escapes SSH remote namespace: {child_url}")
        return f"{scp.group(1)}:{resolved}"
    raise TaskWorkspaceError(f"cannot resolve relative submodule URL safely: {child_url}")


def nested_gitlink_remote_closure(repository: Path, commit: str,
                                  parent_remote_url: str | None = None,
                                  prefix: str = "") -> dict[str, Any]:
    """Prove gitlinks recursively from isolated fetches of declared remotes.

    The probe repositories have no alternates and never borrow objects from a
    product worktree, so accidental local availability cannot become
    publication truth. Callers may safely run this before allocating or moving
    a worktree.
    """
    commit = ref_sha(repository, commit)
    tree = git(repository, "ls-tree", "-r", commit, check=False)
    gitlinks: list[tuple[str, str]] = []
    for line in tree.splitlines():
        metadata, separator, path = line.partition("\t")
        fields = metadata.split()
        if separator and len(fields) == 3 and fields[0] == "160000" and fields[1] == "commit":
            gitlinks.append((path, fields[2]))
    urls = _declared_submodule_urls(repository, commit)
    evidence: list[dict[str, Any]] = []
    available = True
    for path, child_sha in gitlinks:
        full_path = f"{prefix}/{path}" if prefix else path
        declared = urls.get(path)
        if not declared:
            evidence.append({"path": full_path, "sha": child_sha, "remote": None,
                             "available": False, "failed_check": "declared_remote_missing"})
            available = False
            continue
        try:
            remote = _resolved_submodule_url(parent_remote_url, declared)
        except TaskWorkspaceError as exc:
            evidence.append({"path": full_path, "sha": child_sha, "remote": declared,
                             "available": False, "failed_check": "remote_resolution",
                             "detail": str(exc)})
            available = False
            continue
        with tempfile.TemporaryDirectory(prefix="juno-gitlink-closure-") as temporary:
            probe = Path(temporary) / "probe.git"
            run(["git", "init", "--bare", str(probe)], repository)
            fetched = run(["git", "-C", str(probe), "-c", "protocol.file.allow=always",
                           "fetch", "--no-tags", "--depth=1", remote, child_sha], probe,
                          check=False)
            row: dict[str, Any] = {"path": full_path, "sha": child_sha,
                                   "remote": remote, "available": fetched.returncode == 0,
                                   "failed_check": None if fetched.returncode == 0 else "fetch_exact"}
            if fetched.returncode:
                row["detail"] = (fetched.stderr or fetched.stdout).strip()[-2000:]
                available = False
            else:
                nested = nested_gitlink_remote_closure(
                    probe, child_sha, remote, full_path)
                row["nested"] = nested["gitlinks"]
                if not nested["available"]:
                    row["available"] = False
                    row["failed_check"] = "nested_gitlink_unavailable"
                    available = False
            evidence.append(row)
    return {"root_sha": commit, "available": available, "gitlinks": evidence,
            "source": "isolated_declared_remote_fetch"}


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
    return lexical_absolute(Path(config["workspace_root"]) / task_id)


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
    expected_policy = ("kanban" if operation == "status" else "orchestration")
    if surface == "task" and operation not in {"start", "status", "finish"}:
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


def start(controller: Path, task_id: str, requested_paths: Optional[list[str]] = None) -> dict[str, Any]:
    config = load_config(controller)
    require_task(controller, task_id)
    repository = product_repository(controller, config)
    target_sha = ref_sha(repository, config["target_ref"])
    requested_paths = requested_paths or []
    allowed_paths, selected_entries = selected_task_paths(config, repository, target_sha, requested_paths)
    generation = require_current_runtime(repository, target_sha)
    allowed_paths, generated_output_admission = derived_output_admission(
        repository, target_sha, allowed_paths)
    assert_no_controller_data(repository, target_sha, config["controller_private_paths"])
    branch = branch_ref(config, task_id)
    worktree = worktree_path(config, task_id)
    with state_lock(controller):
        state = read_state(controller)
        existing = state["tasks"].get(task_id)
        if existing:
            if existing.get("creation_receipt", {}).get("requested_paths", []) != requested_paths:
                raise TaskWorkspaceError("task start required paths differ from the frozen creation receipt")
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


def _persist_failed_validation(controller: Path, task_id: str, frozen: dict[str, Any], validations: list[dict[str, Any]]) -> None:
    with state_lock(controller):
        state = read_state(controller)
        current = state["tasks"].get(task_id)
        if current != frozen:
            raise TaskWorkspaceError("task state changed during focused validation; inspect status and retry")
        state["tasks"][task_id] = {**current, "validation": validations,
                                   "last_validation_outcome": "TIMEOUT" if validations[-1]["timed_out"] else "FAILED"}
        write_state(controller, state)


def observe_working_task(record: dict[str, Any], configured_repository: Path,
                         config: dict[str, Any], task_id: str) -> tuple[Path, Path, str, list[str]]:
    """Read one admitted WORKING task from live Git identity, never its start snapshot."""
    creation_receipt = record.get("creation_receipt", {})
    identity = record.get("workspace_identity", {})
    expected_worktree = worktree_path(config, task_id)
    receipt_matches = (
        isinstance(creation_receipt, dict)
        and stable_sha256(creation_receipt) == identity.get("create_receipt_sha256")
        and creation_receipt.get("task_id") == task_id
        and creation_receipt.get("repository") == record.get("repository")
        and creation_receipt.get("target_ref") == record.get("target_ref")
        and creation_receipt.get("base_sha") == record.get("base_sha")
        and creation_receipt.get("branch_ref") == record.get("branch_ref")
        and creation_receipt.get("worktree") == record.get("worktree")
        and creation_receipt.get("manifest_identity") == identity.get("manifest_identity")
        and creation_receipt.get("expected_paths_sha256") == identity.get("expected_paths_sha256")
        and stable_sha256(creation_receipt.get("allowed_paths")) == identity.get("expected_paths_sha256")
        and stable_sha256(creation_receipt.get("materialization")) == identity.get("materialization_sha256")
    )
    if record.get("task_id") != task_id or record.get("state") != "WORKING" or not receipt_matches:
        raise TaskWorkspaceError("task creation receipt or recorded identity drifted")
    try:
        recorded_repository = exact_root(
            Path(record["repository"]), "recorded task repository", physical_identity=True)
        worktree = exact_root(
            Path(record["worktree"]), "recorded task worktree", physical_identity=True)
    except (KeyError, TypeError, OSError, TaskWorkspaceError) as exc:
        raise TaskWorkspaceError("recorded task repository/worktree is missing or reused") from exc
    if recorded_repository != configured_repository or worktree != expected_worktree:
        raise TaskWorkspaceError("task repository/worktree identity drifted")
    if (Path(git(recorded_repository, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
            != Path(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()):
        raise TaskWorkspaceError("recorded task worktree belongs to a different repository")
    metadata = {
        "role": "task", "roleBase": record["base_sha"], "taskId": task_id,
        "manifestIdentity": identity.get("manifest_identity"),
        "createReceiptSha256": identity.get("create_receipt_sha256"),
        "expectedPathsSha256": identity.get("expected_paths_sha256"),
        "materializationSha256": identity.get("materialization_sha256"),
    }
    drifted = [key for key, expected in metadata.items()
               if not isinstance(expected, str) or not expected
               or git(worktree, "config", "--worktree", "--get",
                      f"juno.workspace.{key}", check=False) != expected]
    if drifted:
        raise TaskWorkspaceError(
            "task worktree role/identity drifted: " + ", ".join(drifted)
        )
    head = git(worktree, "rev-parse", "HEAD", check=False)
    branch = record["branch_ref"]
    if (not SHA_RE.fullmatch(head)
            or git(worktree, "symbolic-ref", "-q", "HEAD", check=False) != branch
            or git(recorded_repository, "rev-parse", branch, check=False) != head):
        raise TaskWorkspaceError("task branch/worktree identity drifted")
    if git(worktree, "status", "--porcelain=v1", "--untracked-files=all"):
        raise TaskWorkspaceError("task worktree is dirty; commit or remove all changes")
    if run(["git", "-C", str(recorded_repository), "merge-base", "--is-ancestor",
            record["base_sha"], head], recorded_repository, check=False).returncode:
        raise TaskWorkspaceError("task tip no longer descends from the exact recorded base")
    changed = git_pathnames(
        worktree, "diff", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB",
        "-z", f"{record['base_sha']}..{head}"
    )
    return recorded_repository, worktree, head, changed


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
    repository, worktree, head, changed = observe_working_task(
        record, configured_repository, config, task_id
    )
    if head == record["base_sha"]:
        raise TaskWorkspaceError("task has no committed changes")
    if not changed:
        raise TaskWorkspaceError("task has no product diff from its exact recorded base")
    forbidden = [path for path in changed if path_within(path, config["controller_private_paths"])]
    creation_receipt = record.get("creation_receipt", {})
    if stable_sha256(creation_receipt) != record.get("workspace_identity", {}).get("create_receipt_sha256"):
        raise TaskWorkspaceError("task creation receipt identity drifted")
    frozen_allowed = creation_receipt.get("allowed_paths")
    if not isinstance(frozen_allowed, list) or not frozen_allowed:
        raise TaskWorkspaceError("task creation receipt has no frozen allowed paths")
    outside = [path for path in changed if not path_within(path, frozen_allowed)]
    if forbidden or outside:
        raise TaskWorkspaceError(f"task changed disallowed paths: {', '.join(sorted(set(forbidden + outside)))}")
    verify_derived_output_parity(
        repository, head, creation_receipt.get("generated_output_admission"), changed)
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
    try:
        post_repository, post_worktree, post_head, post_changed = observe_working_task(
            record, configured_repository, config, task_id
        )
    except TaskWorkspaceError as exc:
        raise TaskWorkspaceError("task tip or worktree changed during focused validation") from exc
    if ((post_repository, post_worktree, post_head, post_changed)
            != (repository, worktree, head, changed)):
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
    if record.get("state") == "WORKING":
        _, _, live_tip, live_paths = observe_working_task(
            record, configured_repository, config, task_id
        )
        result.update({"tip_sha": live_tip, "changed_paths": live_paths})
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


def _load_boundary_runtime(filename: str, module_name: str) -> Any:
    sibling = Path(__file__).resolve().with_name(filename)
    if not sibling.is_file():
        raise TaskWorkspaceError(f"packaged boundary validator is missing: {filename}")
    spec = importlib.util.spec_from_file_location(module_name, sibling)
    if spec is None or spec.loader is None:
        raise TaskWorkspaceError(f"cannot load boundary validator: {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_migrated_sparse_controller(controller: Path,
                                       task_config: dict[str, Any]) -> dict[str, Any]:
    metadata_path = controller / ".juno_task/config/metadata-controller.json"
    try:
        boundary = _load_boundary_runtime(
            "metadata_controller.py", "juno_task_runtime_metadata_boundary")
        policy = boundary.load_policy(metadata_path)
    except Exception as exc:
        raise TaskWorkspaceError(f"runtime bootstrap requires a valid metadata-controller policy: {exc}") from exc
    resolver_path = Path(__file__).resolve().with_name("controller_resolver.py")
    if not resolver_path.is_file():
        raise TaskWorkspaceError("packaged controller registration validator is missing")
    resolver_env = {key: value for key, value in os.environ.items()
                    if key not in {"JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH",
                                  "JUNO_WORKSPACE_ROLE"}}
    resolved = subprocess.run(
        [sys.executable, str(resolver_path), "--cwd", str(controller),
         "--operation", "orchestration", "--format", "json"],
        cwd=controller, env=resolver_env, text=True, capture_output=True,
        stdin=subprocess.DEVNULL)
    if resolved.returncode:
        raise TaskWorkspaceError(resolved.stderr.strip() or "controller registration refused")
    try:
        route = json.loads(resolved.stdout)
    except json.JSONDecodeError as exc:
        raise TaskWorkspaceError("controller registration validator returned invalid evidence") from exc
    branch = git(controller, "symbolic-ref", "-q", "HEAD", check=False)
    role = git(controller, "config", "--worktree", "--get", "juno.workspace.role", check=False)
    sparse = git(controller, "config", "--worktree", "--bool", "--get",
                 "core.sparseCheckout", check=False).lower()
    registered_path = git(controller, "config", "--local", "--get", "juno.controller.path", check=False)
    registered_branch = git(controller, "config", "--local", "--get", "juno.controller.branch", check=False)
    try:
        config_json = json.loads((controller / ".juno_task/config.json").read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"runtime bootstrap controller config is invalid: {exc}") from exc
    expected_shape = {"mode": "metadata-only",
                      "policy": ".juno_task/config/metadata-controller.json"}
    if (branch != policy["controller_branch"] or role != "controller" or sparse != "true"
            or not registered_path
            or Path(registered_path).expanduser().resolve() != controller.resolve()
            or registered_branch not in {policy["controller_branch"],
                                         policy["controller_branch"].removeprefix("refs/heads/")}
            or route.get("valid") is not True or Path(str(route.get("path", ""))).resolve() != controller.resolve()
            or route.get("role") != "controller"
            or route.get("role_source") != "controller-registration"
            or not isinstance(config_json, dict) or "lifecycle" in config_json
            or config_json.get("controllerWorkspace") != expected_shape
            or task_config.get("target_ref") != policy["product_ref"]):
        raise TaskWorkspaceError(
            "runtime bootstrap is restricted to the exact registered migrated sparse metadata controller")
    inspection = boundary.inspect(controller, policy,
                                  expected_branch=policy["controller_branch"], require_active=True)
    required_checks = {"branch_exact", "tracked_boundary", "product_absent", "role"}
    failed = sorted(name for name in required_checks if inspection.get("checks", {}).get(name) is not True)
    if failed:
        raise TaskWorkspaceError(
            "runtime bootstrap metadata-controller boundary failed: " + ", ".join(failed))
    return {"policy_sha256": _file_sha256(metadata_path),
            "controller_branch": policy["controller_branch"],
            "product_ref": policy["product_ref"], "checks": sorted(required_checks)}


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _controller_bootstrap_identity(controller: Path) -> dict[str, Any]:
    metadata = controller / ".juno_task/config/metadata-controller.json"
    return {
        "root": str(controller.resolve()),
        "git_common_dir": str(Path(git(controller, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()),
        "head_sha": git(controller, "rev-parse", "HEAD^{commit}"),
        "head_tree": git(controller, "rev-parse", "HEAD^{tree}"),
        "metadata_controller_sha256": _file_sha256(metadata) if metadata.is_file() else None,
    }


def _bootstrap_receipt_path(controller: Path, digest: str) -> Path:
    root = (controller / RUNTIME_BOOTSTRAP_ROOT).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = (root / f"{digest}-plan.json").resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise TaskWorkspaceError("unsafe task-runtime bootstrap receipt path") from exc
    return path


def _bootstrap_target_status(repository: Path) -> str:
    return git(repository, "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
               f":(exclude){RUNTIME_BOOTSTRAP_ROOT}")


def _runtime_prior_state(repository: Path, target_sha: str,
                         proposed: bytes) -> dict[str, Any]:
    prior = target_blob(repository, target_sha, RUNTIME_PATH)
    if prior is None:
        package_bytes = target_blob(repository, target_sha, "juno-code/package.json")
        source = target_blob(repository, target_sha,
                             "juno-code/src/templates/scripts/task_workspace.py")
        try:
            package = json.loads(package_bytes) if package_bytes is not None else None
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TaskWorkspaceError("target package identity is invalid; refusing bootstrap") from exc
        if isinstance(package, dict) and package.get("name") == "juno-code" and source != proposed:
            raise TaskWorkspaceError(
                "Juno source target runtime template does not match exact package bytes")
        return {"state": "absent", "mode": None, "sha256": None, "bytes_base64": None,
                "classification": "missing"}
    tree_row = git(repository, "ls-tree", target_sha, "--", RUNTIME_PATH)
    try:
        prior_mode = tree_row.split(None, 1)[0]
    except (AttributeError, IndexError) as exc:
        raise TaskWorkspaceError("target task runtime tree identity is invalid") from exc
    if prior_mode not in {"100644", "100755"}:
        raise TaskWorkspaceError("target task runtime has an unsafe Git mode")
    prior_sha = hashlib.sha256(prior).hexdigest()
    source_path = "juno-code/src/templates/scripts/task_workspace.py"
    source = target_blob(repository, target_sha, source_path)
    inventory_bytes = target_blob(repository, target_sha, MANAGED_INVENTORY_PATH)
    try:
        inventory = json.loads(inventory_bytes) if inventory_bytes is not None else None
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError("target managed inventory is invalid; refusing bootstrap") from exc
    package_version = inventory.get("packageVersion") if isinstance(inventory, dict) else None
    assets = inventory.get("assets") if isinstance(inventory, dict) else None
    entry = assets.get(RUNTIME_PATH) if isinstance(assets, dict) else None
    inventory_valid = (
        isinstance(inventory, dict) and set(inventory) == {
            "schemaVersion", "packageName", "packageVersion", "assets"}
        and inventory.get("schemaVersion") == 1
        and inventory.get("packageName") == "juno-code"
        and isinstance(package_version, str)
        and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", package_version)
        and isinstance(entry, dict)
        and set(entry) == {"type", "templateVersion", "sourceSha256", "installedSha256"}
        and entry.get("type") == "script"
        and entry.get("templateVersion") == package_version
        and entry.get("sourceSha256") == prior_sha
        and entry.get("installedSha256") == prior_sha
    )
    if not inventory_valid or source != prior:
        raise TaskWorkspaceError(
            "target task runtime is customized or lacks immutable package/source provenance; "
            "refusing bootstrap")
    classification = "exact_managed_source_inventory_generation"
    return {"state": "present", "mode": prior_mode, "sha256": prior_sha,
            "bytes_base64": base64.b64encode(prior).decode(),
            "classification": classification}


def _runtime_bootstrap_plan(controller: Path, package_version: str,
                            package_runtime_sha256: str) -> dict[str, Any]:
    config = load_config(controller)
    controller_class = require_migrated_sparse_controller(controller, config)
    if not is_valid_semver(package_version):
        raise TaskWorkspaceError("invalid package version identity")
    running = Path(__file__).resolve().read_bytes()
    running_sha = hashlib.sha256(running).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", package_runtime_sha256) or running_sha != package_runtime_sha256:
        raise TaskWorkspaceError("package task-runtime hash does not match the executing recovery engine")
    repository = product_repository(controller, config)
    if _bootstrap_target_status(repository):
        raise TaskWorkspaceError("configured target worktree is dirty; refusing runtime bootstrap")
    target_ref = config["target_ref"]
    target_sha = ref_sha(repository, target_ref)
    target_tree = git(repository, "rev-parse", f"{target_sha}^{{tree}}")
    prior = _runtime_prior_state(repository, target_sha, running)
    if prior["sha256"] == running_sha:
        raise TaskWorkspaceError("target task runtime already matches the package")
    plan = {
        "schema_version": RUNTIME_BOOTSTRAP_SCHEMA,
        "operation": "plan",
        "controller_identity": {**_controller_bootstrap_identity(controller),
                                "controller_class": controller_class},
        "package": {"name": "juno-code", "version": package_version,
                    "task_runtime_sha256": running_sha},
        "target": {"repository": str(repository), "ref": target_ref,
                   "sha": target_sha, "tree": target_tree},
        "path": RUNTIME_PATH,
        "prior": prior,
        "proposed": {"mode": "100755", "sha256": running_sha,
                     "bytes_base64": base64.b64encode(running).decode()},
    }
    raw = (json.dumps(plan, sort_keys=True, separators=(",", ":")) + "\n").encode()
    digest = hashlib.sha256(raw).hexdigest()
    path = _bootstrap_receipt_path(controller, digest)
    if path.exists() and path.read_bytes() != raw:
        raise TaskWorkspaceError("immutable task-runtime bootstrap receipt collision")
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    return {**plan, "receipt": {"path": str(path), "sha256": digest}}


def _load_runtime_bootstrap_plan(controller: Path, receipt_path: Path,
                                 package_version: str,
                                 package_runtime_sha256: str) -> tuple[dict[str, Any], str]:
    path = receipt_path.expanduser().resolve()
    root = (controller / RUNTIME_BOOTSTRAP_ROOT).resolve()
    try:
        path.relative_to(root)
        raw = path.read_bytes()
        plan = json.loads(raw)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"invalid task-runtime bootstrap receipt: {exc}") from exc
    digest = hashlib.sha256(raw).hexdigest()
    if path.name != f"{digest}-plan.json":
        raise TaskWorkspaceError("task-runtime bootstrap receipt immutable identity mismatch")
    required = {"schema_version", "operation", "controller_identity", "package",
                "target", "path", "prior", "proposed"}
    if (not isinstance(plan, dict) or set(plan) != required
            or plan.get("schema_version") != RUNTIME_BOOTSTRAP_SCHEMA
            or plan.get("operation") != "plan" or plan.get("path") != RUNTIME_PATH
            or plan.get("package") != {"name": "juno-code", "version": package_version,
                                       "task_runtime_sha256": package_runtime_sha256}):
        raise TaskWorkspaceError("task-runtime bootstrap receipt/controller/package identity mismatch")
    try:
        proposed = base64.b64decode(plan["proposed"]["bytes_base64"], validate=True)
    except (KeyError, TypeError, ValueError) as exc:
        raise TaskWorkspaceError("task-runtime bootstrap proposed bytes are invalid") from exc
    if (hashlib.sha256(proposed).hexdigest() != package_runtime_sha256
            or plan["proposed"].get("sha256") != package_runtime_sha256
            or plan["proposed"].get("mode") != "100755"
            or hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest() != package_runtime_sha256):
        raise TaskWorkspaceError("task-runtime bootstrap package bytes/hash mismatch")
    consumed = root / f"{digest}-applied.json"
    durable = root / f"{digest}-completion-durable.json"
    if consumed.exists() and durable.exists():
        raise TaskWorkspaceError("task-runtime bootstrap receipt has already been applied")
    return plan, digest


def _write_runtime_bootstrap_record(path: Path, payload: dict[str, Any]) -> bytes:
    raw = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if path.exists():
        if path.read_bytes() != raw:
            raise TaskWorkspaceError(f"immutable task-runtime bootstrap record collision: {path.name}")
        return raw
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(6)}")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)
    return raw


def _target_ref_holders(repository: Path, target_ref: str) -> list[dict[str, Any]]:
    output = run(["git", "-C", str(repository), "worktree", "list", "--porcelain"], repository)
    records: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    for line in [*output.stdout.splitlines(), ""]:
        if not line:
            if current.get("branch") == target_ref:
                records.append(current)
            current = {}
            continue
        key, _, value = line.partition(" ")
        if key in {"worktree", "HEAD", "branch", "locked"}:
            current[key.lower()] = value if value else True
    return records


@contextmanager
def _target_mutation_lock(repository: Path, target_ref: str) -> Iterator[None]:
    # Contend on the merge queue's repository/ref lock inode. Runtime recovery
    # and queue delivery must never mutate the same target concurrently.
    common = Path(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    key = hashlib.sha256(f"{common}\0{target_ref}".encode()).hexdigest()
    path = common / "juno-locks/merge-queue" / f"{key}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise TaskWorkspaceError(
                    "another worker owns this repository/target-ref queue; refusing runtime bootstrap"
                ) from exc
            raise
        yield


def _admit_target_holder(repository: Path, target_ref: str,
                         expected_sha: str) -> dict[str, Any] | None:
    holders = _target_ref_holders(repository, target_ref)
    if len(holders) > 1:
        raise TaskWorkspaceError(
            "target ref has multiple checked-out holders; remove the extra holder with "
            "`git worktree remove <path>` after review, then rerun the same --apply receipt")
    if not holders:
        return None
    row = holders[0]
    if row.get("locked"):
        raise TaskWorkspaceError(
            "target-ref holder is locked; unlock it with `git worktree unlock <path>` after review, "
            "then rerun the same --apply receipt")
    holder = exact_root(Path(str(row.get("worktree", ""))), "target-ref holder")
    if (git(holder, "symbolic-ref", "-q", "HEAD", check=False) != target_ref
            or git(holder, "rev-parse", "HEAD^{commit}", check=False) != expected_sha):
        raise TaskWorkspaceError("target-ref holder HEAD/ref moved; refusing before target mutation")
    if git(holder, "status", "--porcelain=v1", "--untracked-files=all", check=False):
        raise TaskWorkspaceError(
            "target-ref holder is dirty; clean it without stash/reset automation, then rerun "
            "the same --apply receipt")
    return {"path": str(holder), "branch": target_ref, "previous_sha": expected_sha,
            "git_common_dir": str(Path(git(holder, "rev-parse", "--path-format=absolute",
                                           "--git-common-dir")).resolve())}


def _validate_intent_holder(repository: Path, intent_holder: Any,
                            target_ref: str) -> Path | None:
    holders = _target_ref_holders(repository, target_ref)
    if intent_holder is None:
        if holders:
            raise TaskWorkspaceError(
                "a target-ref holder appeared after planning apply; refusing durable intent recovery")
        return None
    if (not isinstance(intent_holder, dict) or set(intent_holder) != {
            "path", "branch", "previous_sha", "git_common_dir"}
            or intent_holder.get("branch") != target_ref):
        raise TaskWorkspaceError("task-runtime bootstrap target-holder intent is invalid")
    if len(holders) != 1 or Path(str(holders[0].get("worktree", ""))).resolve() != Path(
            intent_holder["path"]).resolve() or holders[0].get("locked"):
        raise TaskWorkspaceError("target-ref holder topology changed after durable apply intent")
    holder = exact_root(Path(intent_holder["path"]), "durable target-ref holder")
    if (Path(git(holder, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
            != Path(intent_holder["git_common_dir"]).resolve()):
        raise TaskWorkspaceError("target-ref holder Git identity changed")
    return holder


def _holder_dirt_matches_interrupted_runtime_sync(holder: Path,
                                                   prior: dict[str, Any],
                                                   proposed: bytes) -> bool:
    status = git(holder, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    rows = [line for line in status.splitlines() if line]
    if not rows or any(line[3:] != RUNTIME_PATH for line in rows):
        return False
    try:
        prior_bytes = (base64.b64decode(prior["bytes_base64"], validate=True)
                       if prior.get("bytes_base64") is not None else None)
    except (KeyError, TypeError, ValueError):
        return False
    working = (holder / RUNTIME_PATH).read_bytes() if (holder / RUNTIME_PATH).is_file() else None
    index_result = subprocess.run(
        ["git", "-C", str(holder), "show", f":{RUNTIME_PATH}"], cwd=holder,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    indexed = index_result.stdout if index_result.returncode == 0 else None
    # Recovery admits only a mixed/exact transition containing proposed bytes.
    # Ambiguous staged deletion (both absent) is user dirt, never bootstrap state.
    admitted = {prior_bytes, proposed}
    return working in admitted and indexed in admitted and proposed in {working, indexed}


def _holder_is_prepared_for_cas(holder: Path, previous_sha: str,
                                proposed: bytes) -> bool:
    if git(holder, "rev-parse", "HEAD^{commit}", check=False) != previous_sha:
        return False
    status = git(holder, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    prior = run(["git", "-C", str(holder), "cat-file", "-e",
                 f"{previous_sha}:{RUNTIME_PATH}"], holder, check=False)
    expected_code = "M" if prior.returncode == 0 else "A"
    if status.splitlines() != [f"{expected_code}  {RUNTIME_PATH}"]:
        return False
    destination = holder / RUNTIME_PATH
    if not destination.is_file() or destination.read_bytes() != proposed:
        return False
    indexed = subprocess.run(
        ["git", "-C", str(holder), "show", f":{RUNTIME_PATH}"], cwd=holder,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return indexed.returncode == 0 and indexed.stdout == proposed


def _prepare_target_holder_for_cas(holder: Path, target_ref: str,
                                   previous_sha: str, commit_sha: str,
                                   prior: dict[str, Any], proposed: bytes) -> None:
    current = git(holder, "rev-parse", "HEAD^{commit}", check=False)
    status = git(holder, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    branch = git(holder, "symbolic-ref", "-q", "HEAD", check=False)
    if current != previous_sha or branch != target_ref:
        raise TaskWorkspaceError("target-ref holder moved outside the durable apply intent")
    if _holder_is_prepared_for_cas(holder, previous_sha, proposed):
        return
    recovering_interruption = bool(status) and _holder_dirt_matches_interrupted_runtime_sync(
        holder, prior, proposed)
    if status and not recovering_interruption:
        raise TaskWorkspaceError("target-ref holder became dirty before synchronization")
    # Prepare the one-path index/worktree transition while the ref still names
    # previous_sha. Only after exact prepared-state verification may CAS advance
    # the branch. Thus no post-CAS operation can overwrite concurrent holder dirt.
    # A one-tree merge is deliberately non-destructive: unlike --reset, Git
    # refuses when tracked or untracked working bytes raced the admitted index.
    result = run(["git", "-C", str(holder), "read-tree", "-m", "-u", commit_sha],
                 holder, check=False)
    if result.returncode:
        raise TaskWorkspaceError(
            "target-holder synchronization was interrupted before CAS; rerun the same --apply receipt")
    if (git(holder, "symbolic-ref", "-q", "HEAD", check=False) != target_ref
            or not _holder_is_prepared_for_cas(holder, previous_sha, proposed)):
        raise TaskWorkspaceError(
            "target-holder synchronization is incomplete before CAS; rerun the same --apply receipt")


def _validate_runtime_bootstrap_commit(repository: Path, plan: dict[str, Any],
                                       commit_sha: str, proposed: bytes) -> str:
    previous_sha = plan["target"]["sha"]
    if git(repository, "rev-parse", f"{commit_sha}^", check=False) != previous_sha:
        raise TaskWorkspaceError("runtime bootstrap commit parent mismatch")
    committed_row = git(repository, "ls-tree", commit_sha, "--", RUNTIME_PATH, check=False)
    changed = git(repository, "diff-tree", "--no-commit-id", "--name-only", "-r",
                  commit_sha, check=False).splitlines()
    if (target_blob(repository, commit_sha, RUNTIME_PATH) != proposed
            or not committed_row.startswith(plan["proposed"]["mode"] + " blob ")
            or changed != [RUNTIME_PATH]):
        raise TaskWorkspaceError("runtime bootstrap reviewed commit identity mismatch")
    return git(repository, "rev-parse", f"{commit_sha}^{{tree}}")


def _apply_runtime_bootstrap(controller: Path, package_version: str,
                             package_runtime_sha256: str, receipt_path: Path) -> dict[str, Any]:
    config = load_config(controller)
    controller_class = require_migrated_sparse_controller(controller, config)
    plan, digest = _load_runtime_bootstrap_plan(
        controller, receipt_path, package_version, package_runtime_sha256)
    expected_controller_identity = {**_controller_bootstrap_identity(controller),
                                    "controller_class": controller_class}
    if plan.get("controller_identity") != expected_controller_identity:
        raise TaskWorkspaceError("task-runtime bootstrap controller identity mismatch")
    repository = product_repository(controller, config)
    target = plan["target"]
    if str(repository) != target.get("repository") or config["target_ref"] != target.get("ref"):
        raise TaskWorkspaceError("task-runtime bootstrap target identity changed")
    if _bootstrap_target_status(repository):
        raise TaskWorkspaceError("configured target worktree is dirty; refusing runtime bootstrap")
    proposed = base64.b64decode(plan["proposed"]["bytes_base64"], validate=True)
    record_root = (controller / RUNTIME_BOOTSTRAP_ROOT).resolve()
    intent_path = record_root / f"{digest}-apply-intent.json"
    applied_path = record_root / f"{digest}-applied.json"
    durable_path = record_root / f"{digest}-completion-durable.json"
    intent: dict[str, Any] | None = None
    if intent_path.exists():
        try:
            intent = json.loads(intent_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise TaskWorkspaceError("task-runtime bootstrap apply intent is invalid") from exc
        if (not isinstance(intent, dict) or set(intent) != {
                "schema_version", "operation", "plan_sha256", "target_ref",
                "previous_sha", "commit_sha", "tree", "path", "package", "target_holder"}
                or intent.get("schema_version") != RUNTIME_BOOTSTRAP_SCHEMA
                or intent.get("operation") != "apply-intent" or intent.get("plan_sha256") != digest
                or intent.get("target_ref") != config["target_ref"]
                or intent.get("previous_sha") != target.get("sha")
                or intent.get("path") != RUNTIME_PATH
                or not SHA_RE.fullmatch(str(intent.get("commit_sha", "")))
                or not SHA_RE.fullmatch(str(intent.get("tree", "")))
                or intent.get("package") != plan["package"]):
            raise TaskWorkspaceError("task-runtime bootstrap apply intent identity mismatch")
        commit_sha = intent.get("commit_sha", "")
        tree = _validate_runtime_bootstrap_commit(repository, plan, commit_sha, proposed)
        if tree != intent.get("tree"):
            raise TaskWorkspaceError("task-runtime bootstrap apply intent tree mismatch")
    else:
        current_sha = ref_sha(repository, config["target_ref"])
        if (current_sha != target.get("sha")
                or git(repository, "rev-parse", f"{current_sha}^{{tree}}") != target.get("tree")):
            raise TaskWorkspaceError("task-runtime bootstrap target ref moved after planning")
        if _runtime_prior_state(repository, current_sha, proposed) != plan.get("prior"):
            raise TaskWorkspaceError("task-runtime bootstrap prior path state changed")
        workspace_root = Path(config["workspace_root"])
        workspace_root.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=".yy-task-runtime-bootstrap-", dir=workspace_root))
        added = False
        try:
            temporary.rmdir()
            run(["git", "-C", str(repository), "worktree", "add", "--detach",
                 str(temporary), current_sha], repository)
            added = True
            if git(temporary, "status", "--porcelain=v1", "--untracked-files=all"):
                raise TaskWorkspaceError("isolated target worktree is not clean")
            destination = temporary / RUNTIME_PATH
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(proposed); destination.chmod(0o755)
            run(["git", "-C", str(temporary), "add", "--", RUNTIME_PATH], temporary)
            if git(temporary, "diff", "--cached", "--name-only").splitlines() != [RUNTIME_PATH]:
                raise TaskWorkspaceError("runtime bootstrap staged an unexpected path")
            run(["git", "-C", str(temporary), "-c", "core.hooksPath=/dev/null", "commit", "-m",
                 f"chore(juno): bootstrap package task runtime\n\nReviewed-Plan: {digest}\nJuno-Package: {package_version}"], temporary)
            commit_sha = git(temporary, "rev-parse", "HEAD^{commit}")
            tree = _validate_runtime_bootstrap_commit(repository, plan, commit_sha, proposed)
        finally:
            if added:
                run(["git", "-C", str(repository), "worktree", "remove", "--force",
                     str(temporary)], repository, check=False)
            elif temporary.exists():
                temporary.rmdir()
        with _target_mutation_lock(repository, config["target_ref"]):
            if ref_sha(repository, config["target_ref"]) != current_sha:
                raise TaskWorkspaceError("task-runtime bootstrap target ref raced before durable intent")
            target_holder = _admit_target_holder(repository, config["target_ref"], current_sha)
            intent = {"schema_version": RUNTIME_BOOTSTRAP_SCHEMA, "operation": "apply-intent",
                      "plan_sha256": digest, "target_ref": config["target_ref"],
                      "previous_sha": current_sha, "commit_sha": commit_sha, "tree": tree,
                      "path": RUNTIME_PATH, "package": plan["package"],
                      "target_holder": target_holder}
            _write_runtime_bootstrap_record(intent_path, intent)

    guard_holder: Path | None = None
    try:
        with _target_mutation_lock(repository, config["target_ref"]):
            if intent["target_holder"] is None:
                workspace_root = Path(config["workspace_root"])
                expected_guard = (workspace_root /
                                  f".yy-task-runtime-bootstrap-guard-{digest}").resolve()
                holders = _target_ref_holders(repository, config["target_ref"])
                if holders:
                    if (len(holders) != 1 or holders[0].get("locked")
                            or Path(str(holders[0].get("worktree", ""))).resolve()
                            != expected_guard):
                        raise TaskWorkspaceError(
                            "a non-guard target-ref holder appeared after durable apply intent")
                    holder = exact_root(expected_guard, "durable package-owned target guard")
                    if (git(holder, "symbolic-ref", "-q", "HEAD", check=False)
                            != config["target_ref"]
                            or git(holder, "config", "--worktree", "--get",
                                   "juno.bootstrap.guardDigest", check=False) != digest):
                        raise TaskWorkspaceError("durable package-owned target guard identity changed")
                    guard_holder = holder
                else:
                    holder = None
            else:
                holder = _validate_intent_holder(
                    repository, intent["target_holder"], config["target_ref"])
            current_sha = ref_sha(repository, config["target_ref"])
            if current_sha not in {intent["previous_sha"], intent["commit_sha"]}:
                raise TaskWorkspaceError(
                    "task-runtime bootstrap target ref moved outside the durable apply intent")
            if holder is None:
                # Hold the branch in a package-owned clean worktree through CAS
                # and durable completion. Ordinary Git worktree creation then
                # fails instead of racing the no-holder observation.
                _validate_intent_holder(repository, None, config["target_ref"])
                workspace_root = Path(config["workspace_root"])
                workspace_root.mkdir(parents=True, exist_ok=True)
                guard_holder = (workspace_root /
                                f".yy-task-runtime-bootstrap-guard-{digest}").resolve()
                if guard_holder.exists():
                    raise TaskWorkspaceError(
                        "durable package-owned target guard path exists outside Git registration")
                branch = config["target_ref"].removeprefix("refs/heads/")
                added = run(["git", "-C", str(repository), "worktree", "add",
                             str(guard_holder), branch], repository, check=False)
                if added.returncode:
                    raise TaskWorkspaceError(
                        "target-ref holder appeared before guarded CAS; refusing target mutation")
                run(["git", "-C", str(guard_holder), "config", "--worktree",
                     "juno.bootstrap.guardDigest", digest], guard_holder)
                holder = guard_holder
            if current_sha == intent["previous_sha"]:
                index_lock = Path(git(holder, "rev-parse", "--path-format=absolute",
                                      "--git-path", "index.lock"))
                if index_lock.exists():
                    raise TaskWorkspaceError(
                        "target-holder index is locked; refusing before target CAS advancement")
                _prepare_target_holder_for_cas(holder, config["target_ref"],
                                               intent["previous_sha"], intent["commit_sha"],
                                               plan["prior"], proposed)
                holders = _target_ref_holders(repository, config["target_ref"])
                if (len(holders) != 1
                        or Path(str(holders[0].get("worktree", ""))).resolve() != holder
                        or ref_sha(repository, config["target_ref"]) != intent["previous_sha"]
                        or not _holder_is_prepared_for_cas(
                            holder, intent["previous_sha"], proposed)):
                    raise TaskWorkspaceError("target-ref holder raced before target CAS advancement")
                cas = run(["git", "-C", str(repository), "update-ref", config["target_ref"],
                           intent["commit_sha"], intent["previous_sha"]], repository, check=False)
                if cas.returncode:
                    raise TaskWorkspaceError("task-runtime bootstrap target ref CAS advancement failed")
            if (git(holder, "symbolic-ref", "-q", "HEAD", check=False) != config["target_ref"]
                    or git(holder, "rev-parse", "HEAD^{commit}", check=False) != intent["commit_sha"]
                    or git(holder, "status", "--porcelain=v1", "--untracked-files=all", check=False)):
                raise TaskWorkspaceError(
                    "target-holder changed during CAS; concurrent dirt was preserved; "
                    "rerun the same --apply receipt after review")
            result = {"schema_version": RUNTIME_BOOTSTRAP_SCHEMA, "operation": "apply",
                      "outcome": "completed", "plan_sha256": digest,
                      "target_ref": config["target_ref"], "previous_sha": intent["previous_sha"],
                      "commit_sha": intent["commit_sha"], "tree": intent["tree"],
                      "path": RUNTIME_PATH, "package": plan["package"],
                      "target_holder": intent["target_holder"]}
            if guard_holder is not None:
                if (git(guard_holder, "config", "--worktree", "--get",
                        "juno.bootstrap.guardDigest", check=False) != digest
                        or git(guard_holder, "status", "--porcelain=v1",
                               "--untracked-files=all", check=False)):
                    raise TaskWorkspaceError(
                        "package-owned target guard changed; refusing cleanup and completion")
                removed = run(["git", "-C", str(repository), "worktree", "remove",
                               str(guard_holder)], repository, check=False)
                if removed.returncode:
                    raise TaskWorkspaceError(
                        "package-owned target guard cleanup failed; rerun the same --apply receipt")
                guard_holder = None
            try:
                raw = _write_runtime_bootstrap_record(applied_path, result)
                completion = {"schema_version": RUNTIME_BOOTSTRAP_SCHEMA,
                              "operation": "completion-durable", "plan_sha256": digest,
                              "applied_sha256": hashlib.sha256(raw).hexdigest(),
                              "commit_sha": intent["commit_sha"]}
                _write_runtime_bootstrap_record(durable_path, completion)
            except (OSError, TaskWorkspaceError) as exc:
                raise TaskWorkspaceError(
                    "target CAS completed but durable completion recording failed; "
                    "rerun the same --apply receipt") from exc
    finally:
        # Never force-remove a guard: process interruption leaves its exact Git
        # registration and digest for safe same-receipt recovery.
        pass
    return {**result, "receipt": {"path": str(applied_path),
                                   "sha256": hashlib.sha256(raw).hexdigest()},
            "completion_durable": {"path": str(durable_path)}}


def runtime_bootstrap(controller: Path, package_version: str,
                      package_runtime_sha256: str,
                      receipt_path: Optional[Path]) -> dict[str, Any]:
    return (_runtime_bootstrap_plan(controller, package_version, package_runtime_sha256)
            if receipt_path is None else
            _apply_runtime_bootstrap(controller, package_version,
                                     package_runtime_sha256, receipt_path))


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("operation", choices=("start", "status", "finish", "runtime-bootstrap"))
    value.add_argument("--task")
    value.add_argument("--path", action="append", default=[], help="required policy-admitted product root")
    value.add_argument("--controller", type=Path, default=Path.cwd(), help=argparse.SUPPRESS)
    value.add_argument("--dry-run", action="store_true")
    value.add_argument("--apply", type=Path)
    value.add_argument("--package-version")
    value.add_argument("--package-runtime-sha256")
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        controller = exact_root(args.controller, "controller", physical_identity=False)
        if args.operation == "runtime-bootstrap":
            if args.task or args.path or not args.package_version or not args.package_runtime_sha256:
                raise TaskWorkspaceError("runtime-bootstrap package identity is incomplete")
            if args.dry_run == bool(args.apply):
                raise TaskWorkspaceError("runtime-bootstrap requires exactly one of --dry-run or --apply <receipt>")
            result = runtime_bootstrap(controller, args.package_version,
                                       args.package_runtime_sha256, args.apply)
        else:
            if not args.task:
                raise TaskWorkspaceError(f"task {args.operation} requires --task")
            if args.operation != "start" and args.path:
                raise TaskWorkspaceError("--path is supported only for task start")
            if args.dry_run or args.apply or args.package_version or args.package_runtime_sha256:
                raise TaskWorkspaceError("runtime-bootstrap options are not supported for task lifecycle operations")
            audit = record_control_audit(controller, "task", args.operation, args.task)
            result = (start(controller, args.task, args.path) if args.operation == "start"
                      else {"status": status, "finish": finish}[args.operation](controller, args.task))
            result = {**result, "control_audit": audit}
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (TaskWorkspaceError, OSError, json.JSONDecodeError) as exc:
        print(f"task workspace: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
