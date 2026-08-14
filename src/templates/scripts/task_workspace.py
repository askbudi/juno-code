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
import shlex
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
UMBRELLA_INPUT_SCHEMA = "juno_task_umbrella_admission_input.v1"
UMBRELLA_ADMISSION_SCHEMA = "juno_task_umbrella_admission.v1"
UMBRELLA_RECOVERY_PLAN_SCHEMA = "juno_task_umbrella_recovery_plan.v1"
UMBRELLA_SUPERSESSION_SCHEMA = "juno_task_umbrella_admission_supersession.v1"
UMBRELLA_AUTHORIZATION_SCHEMA = "juno_task_umbrella_recovery_authorization.v1"
UMBRELLA_EXECUTION_MODE = "umbrella_owned_sequential"
UMBRELLA_RESERVATIONS_SCHEMA = "juno_task_umbrella_child_reservations.v1"
TASK_SCOPE_SCHEMA = "juno_task_canonical_scope.v1"
AUTHORIZATION_LEDGER_SCHEMA = "juno_task_umbrella_authorization_ledger.v1"
TERMINAL_TASK_STATUSES = {"done", "archived", "cancelled", "canceled", "closed"}
PRESTART_TRACKING_STATUSES = {"backlog", "todo"}


class TaskWorkspaceError(RuntimeError):
    pass


def is_valid_semver(value: Any) -> bool:
    """Return whether value is an exact ASCII SemVer 2.0.0 version string."""
    return isinstance(value, str) and SEMVER_RE.fullmatch(value) is not None


def semver_precedes(older: str, newer: str) -> bool:
    """Compare validated SemVer values without trusting an optional dependency."""
    def parts(value: str) -> tuple[tuple[int, int, int], list[str] | None]:
        public = value.split("+", 1)[0]
        core, separator, prerelease = public.partition("-")
        return tuple(int(item) for item in core.split(".")), prerelease.split(".") if separator else None

    older_core, older_pre = parts(older)
    newer_core, newer_pre = parts(newer)
    if older_core != newer_core:
        return older_core < newer_core
    if older_pre is None or newer_pre is None:
        return older_pre is not None and newer_pre is None
    for left, right in zip(older_pre, newer_pre):
        if left == right:
            continue
        left_numeric, right_numeric = left.isdigit(), right.isdigit()
        if left_numeric and right_numeric:
            return int(left) < int(right)
        if left_numeric != right_numeric:
            return left_numeric
        return left < right
    return len(older_pre) < len(newer_pre)


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


def task_status(body: bytes, task_id: str) -> str:
    match = re.search(r"(?m)^status:\s*([A-Za-z_]+)\s*$", body[:4096].decode("utf-8", errors="replace"))
    if not match:
        raise TaskWorkspaceError(f"canonical child {task_id} has no unambiguous lifecycle status")
    return match.group(1).lower()


def task_scope_path(controller: Path, task_id: str) -> Path:
    return controller / ".juno_task/task-scopes" / task_id[:2].lower() / f"{task_id}.json"


def load_task_scope(controller: Path, task_id: str, body: bytes) -> tuple[dict[str, Any], str]:
    value, file_sha = read_json_object(task_scope_path(controller, task_id), f"canonical child scope {task_id}")
    keys = {"schema_version", "task_id", "task_revision_sha256", "lifecycle_status",
            "umbrella_relations", "scope"}
    relation_keys = {"owner", "children"}; scope_keys = {
        "baseline", "selectable_paths", "required_paths", "generated_paths"}
    if (set(value) != keys or value.get("schema_version") != TASK_SCOPE_SCHEMA
            or value.get("task_id") != task_id
            or value.get("task_revision_sha256") != hashlib.sha256(body).hexdigest()
            or value.get("lifecycle_status") != task_status(body, task_id)
            or not isinstance(value.get("umbrella_relations"), dict)
            or set(value["umbrella_relations"]) != relation_keys
            or value["umbrella_relations"].get("owner") is not None
               and not TASK_RE.fullmatch(str(value["umbrella_relations"].get("owner")))
            or not isinstance(value["umbrella_relations"].get("children"), list)
            or not all(isinstance(item, str) and TASK_RE.fullmatch(item)
                       for item in value["umbrella_relations"]["children"])
            or not isinstance(value.get("scope"), dict) or set(value["scope"]) != scope_keys
            or not isinstance(value["scope"].get("baseline"), bool)):
        raise TaskWorkspaceError(f"canonical child scope {task_id} is absent, ambiguous, stale, or malformed")
    for field in ("selectable_paths", "required_paths", "generated_paths"):
        rows = value["scope"].get(field)
        if not isinstance(rows, list):
            raise TaskWorkspaceError(f"canonical child scope {task_id}.{field} must be a list")
        normalized = [normalized_relative(item, f"canonical child scope {task_id}.{field}") for item in rows]
        if normalized != sorted(set(normalized)):
            raise TaskWorkspaceError(f"canonical child scope {task_id}.{field} must be sorted and unique")
    if len(set(value["umbrella_relations"]["children"])) != len(value["umbrella_relations"]["children"]):
        raise TaskWorkspaceError(f"canonical child scope {task_id} has duplicate relations")
    return value, file_sha


def validate_umbrella_graph(controller: Path, umbrella_id: str, child_ids: list[str],
                            umbrella_body: bytes) -> tuple[dict[str, Any], str]:
    umbrella_scope, umbrella_scope_sha = load_task_scope(controller, umbrella_id, umbrella_body)
    if umbrella_scope["umbrella_relations"]["children"] != child_ids:
        raise TaskWorkspaceError("umbrella ordered children contradict canonical scope relations")
    if umbrella_scope["umbrella_relations"]["owner"] is not None:
        raise TaskWorkspaceError("nested/owned umbrella execution is contradictory")
    visited: set[str] = set(); active: set[str] = set()
    def walk(task_id: str) -> None:
        if task_id in active: raise TaskWorkspaceError(f"indirect umbrella cycle detected at {task_id}")
        if task_id in visited: return
        active.add(task_id)
        _path, body = task_manifest(controller, task_id)
        scope, _sha = load_task_scope(controller, task_id, body)
        for nested in scope["umbrella_relations"]["children"]: walk(nested)
        active.remove(task_id); visited.add(task_id)
    walk(umbrella_id)
    return umbrella_scope, umbrella_scope_sha


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


def _consumer_runtime_provenance(repository: Path, target_sha: str,
                                 runtime_sha256: str) -> tuple[bool, bool]:
    inventory_bytes = target_blob(repository, target_sha, MANAGED_INVENTORY_PATH)
    if inventory_bytes is None:
        return False, True
    try:
        inventory = json.loads(inventory_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, False
    assets = inventory.get("assets") if isinstance(inventory, dict) else None
    entry = assets.get(RUNTIME_PATH) if isinstance(assets, dict) else None
    legacy = isinstance(assets, dict) and entry is None
    valid = (
        isinstance(inventory, dict)
        and set(inventory) == {"schemaVersion", "packageName", "packageVersion", "assets"}
        and inventory.get("schemaVersion") == 1
        and inventory.get("packageName") == "juno-code"
        and is_valid_semver(inventory.get("packageVersion"))
        and isinstance(entry, dict)
        and set(entry) == {"type", "templateVersion", "sourceSha256", "installedSha256"}
        and entry.get("type") == "script"
        and is_valid_semver(entry.get("templateVersion"))
        and entry.get("sourceSha256") == runtime_sha256
        and entry.get("installedSha256") == runtime_sha256
    )
    return valid, legacy


def _provenance_repair_error(controller: Path, target_sha: str) -> TaskWorkspaceError:
    receipt = f"/tmp/juno-target-runtime-provenance-{target_sha}.json"
    controller_arg = shlex.quote(str(controller.resolve()))
    receipt_arg = shlex.quote(receipt)
    return TaskWorkspaceError(
        "consumer target runtime lacks exact managed-inventory provenance. Exact repair: "
        f"`yy migrate target-runtime-provenance plan --controller {controller_arg} "
        f"--output {receipt_arg}`; review it, then run "
        f"`yy migrate target-runtime-provenance apply --plan {receipt_arg} "
        f"--output {shlex.quote(receipt + '.applied')} "
        "--authorize-target-runtime-provenance`; then use `yy task runtime-bootstrap "
        "--dry-run` if the admitted package generation is still stale"
    )


def require_current_runtime(repository: Path, target_sha: str,
                            controller: Path | None = None) -> dict[str, Any]:
    generation = runtime_generation(repository, target_sha)
    source_repository = (
        target_blob(repository, target_sha, "juno-code/package.json") is not None
        or target_blob(repository, target_sha,
                       "juno-code/src/templates/scripts/task_workspace.py") is not None
    )
    if generation["current"] and not source_repository:
        provenance, legacy = _consumer_runtime_provenance(
            repository, target_sha, generation["target_sha256"])
        if provenance:
            generation["managed_inventory_provenance"] = True
            return generation
        if legacy and controller is not None:
            raise _provenance_repair_error(controller, target_sha)
        raise TaskWorkspaceError(
            "consumer target runtime managed-inventory provenance is malformed or mismatched"
        )
    if not generation["current"]:
        if source_repository:
            raise TaskWorkspaceError(
                "managed task runtime differs from a Juno source target; use a controller "
                "package/runtime matching that target, or atomically update the source package "
                "template, tracked runtime, and managed inventory if an upgrade is intended"
            )
        target_runtime = target_blob(repository, target_sha, RUNTIME_PATH)
        _, legacy_provenance = _consumer_runtime_provenance(
            repository, target_sha, generation.get("target_sha256") or "")
        if target_runtime is not None and legacy_provenance and controller is not None:
            raise _provenance_repair_error(controller, target_sha)
        raise TaskWorkspaceError(
            "managed task runtime is stale or absent from the consumer target; recover with "
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


def canonical_child_scope(controller: Path, repository: Path, base_sha: str, child_id: str,
                          body: bytes, config: dict[str, Any], expected_owner: str) -> tuple[list[str], list[dict[str, str]], dict[str, Any]]:
    """Read one pre-implementation, revision-bound authoritative scope declaration."""
    declaration, declaration_sha = load_task_scope(controller, child_id, body)
    lifecycle = declaration["lifecycle_status"]
    if lifecycle not in PRESTART_TRACKING_STATUSES:
        classification = "terminal" if lifecycle in TERMINAL_TASK_STATUSES else "active or unknown"
        raise TaskWorkspaceError(
            f"umbrella child {child_id} lifecycle is not an unowned pre-start tracking state "
            f"({classification}): {lifecycle}; allowed: {', '.join(sorted(PRESTART_TRACKING_STATUSES))}"
        )
    relation = declaration["umbrella_relations"]
    if relation["children"]:
        raise TaskWorkspaceError(
            f"flat umbrella child {child_id} must not declare nested children: {', '.join(relation['children'])}"
        )
    if relation["owner"] != expected_owner:
        raise TaskWorkspaceError(
            f"umbrella child {child_id} relation contradicts owner {expected_owner}: {relation['owner']}"
        )
    scope = declaration["scope"]
    selectable = scope["selectable_paths"]
    unknown = [path for path in selectable if path not in config["selectable_paths"]]
    if unknown:
        raise TaskWorkspaceError(f"umbrella child {child_id} has unadmitted selectable scope: {', '.join(unknown)}")
    selected_task_paths(config, repository, base_sha, selectable)
    exact = [*scope["required_paths"], *scope["generated_paths"]]
    evidence: list[dict[str, str]] = []
    for candidate in exact:
        output = git(repository, "ls-tree", base_sha, "--", candidate, check=False)
        lines = [line for line in output.splitlines() if line]
        if len(lines) != 1:
            raise TaskWorkspaceError(f"umbrella child {child_id} exact scope is absent or ambiguous: {candidate}")
        metadata, actual = lines[0].split("\t", 1); mode, kind, object_id = metadata.split()
        if actual != candidate or kind != "blob" or not mode.startswith("100"):
            raise TaskWorkspaceError(f"umbrella child {child_id} scope is not one exact tracked file: {candidate}")
        evidence.append({"path": candidate, "mode": mode, "object": object_id})
    if not scope["baseline"] and not selectable and not exact:
        raise TaskWorkspaceError(f"umbrella child {child_id} authoritative scope is empty")
    paths = [*selectable, *exact]
    frozen = {"declaration_path": str(task_scope_path(controller, child_id).resolve()),
              "declaration_sha256": declaration_sha, "declaration": declaration,
              "baseline": scope["baseline"]}
    return paths, evidence, frozen


def derive_umbrella_admission(controller: Path, umbrella_id: str, repository: Path,
                              target_ref: str, base_sha: str, input_path: Path,
                              baseline_paths: list[str], state: dict[str, Any],
                              config: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    declaration, source_sha = load_umbrella_input(input_path)
    child_ids = declaration["children"]
    _umbrella_path, umbrella_body = task_manifest(controller, umbrella_id)
    umbrella_scope, umbrella_scope_sha = validate_umbrella_graph(
        controller, umbrella_id, child_ids, umbrella_body)
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
        exact_paths, evidence, frozen_scope = canonical_child_scope(
            controller, repository, base_sha, child_id, body, config, umbrella_id)
        for required in exact_paths:
            if not path_within(required, union):
                union.append(required)
        bindings.append({
            "task_id": child_id,
            "task_revision_sha256": hashlib.sha256(body).hexdigest(),
            "scope_evidence": evidence,
            "scope_evidence_sha256": stable_sha256(evidence),
            "required_paths": exact_paths, "canonical_scope": frozen_scope,
            "target_ref": target_ref, "base_sha": base_sha,
        })
    admission = {
        "schema_version": UMBRELLA_ADMISSION_SCHEMA,
        "execution_mode": UMBRELLA_EXECUTION_MODE,
        "input_path": str(input_path.resolve()), "input_sha256": source_sha,
        "umbrella_scope_sha256": umbrella_scope_sha, "umbrella_scope": umbrella_scope,
        "ordered_child_ids": child_ids,
        "child_bindings": bindings,
        "union_paths": sorted(union),
        "union_paths_sha256": stable_sha256(sorted(union)),
    }
    return sorted(union), admission


def finalize_umbrella_admission(repository: Path, base_sha: str, union: list[str],
                                admission: dict[str, Any]) -> tuple[list[str], dict[str, Any], dict[str, Any]]:
    _all_paths, all_generated = derived_output_admission(repository, base_sha, ["juno-code"])
    generated_by_child: dict[str, list[dict[str, str]]] = {}
    expanded = list(union)
    for binding in admission["child_bindings"]:
        pairs = [row for row in all_generated["bindings"]
                 if (path_within(row["source"], binding["required_paths"])
                     or path_within(row["destination"], binding["required_paths"]))]
        for row in pairs:
            for exact in (row["source"], row["destination"]):
                if not path_within(exact, expanded):
                    expanded.append(exact)
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
    expected_keys = {"schema_version", "execution_mode", "input_path", "input_sha256",
                     "umbrella_scope_sha256", "umbrella_scope", "ordered_child_ids",
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
    try:
        _umbrella_path, umbrella_body = task_manifest(controller, umbrella_id)
        current_umbrella_scope, current_umbrella_sha = load_task_scope(controller, umbrella_id, umbrella_body)
        if (current_umbrella_scope != admission["umbrella_scope"]
                or current_umbrella_sha != admission["umbrella_scope_sha256"]):
            drift.append({"reason": "umbrella_scope_drift"})
    except TaskWorkspaceError:
        drift.append({"reason": "umbrella_scope_unavailable"})
    generated_pairs = {(row.get("source"), row.get("destination"), row.get("kind"))
                       for row in generated.get("bindings", [])} if isinstance(generated, dict) else set()
    bound_targets = {(row.get("target_ref"), row.get("base_sha"))
                     for row in admission["child_bindings"] if isinstance(row, dict)}
    if len(bound_targets) != 1:
        drift.append({"reason": "child_target_or_base_binding_drift"})
    for binding in admission["child_bindings"]:
        child_id = binding.get("task_id", "unknown") if isinstance(binding, dict) else "unknown"
        if (not isinstance(binding, dict) or set(binding) != {"task_id", "task_revision_sha256",
                "scope_evidence", "scope_evidence_sha256", "required_paths", "canonical_scope",
                "target_ref", "base_sha"}):
            drift.append({"task_id": child_id, "reason": "malformed_child_binding"})
            continue
        try:
            _path, body = task_manifest(controller, child_id)
            config = load_config(controller)
            paths, evidence, frozen_scope = canonical_child_scope(
                controller, repository, binding.get("base_sha", ""), child_id, body, config, umbrella_id)
        except TaskWorkspaceError:
            drift.append({"task_id": child_id, "reason": "canonical_child_unavailable"})
            continue
        if (hashlib.sha256(body).hexdigest() != binding.get("task_revision_sha256")
                or paths != binding.get("required_paths")
                or evidence != binding.get("scope_evidence")
                or stable_sha256(evidence) != binding.get("scope_evidence_sha256")
                or frozen_scope != binding.get("canonical_scope")):
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
    expected_policy = ("kanban" if operation in {"status", "preflight", "recovery-plan"}
                       else "orchestration")
    if surface == "task" and operation not in {
            "start", "status", "preflight", "finish",
            "recovery-plan", "recovery-authorize", "recovery-apply"}:
        raise TaskWorkspaceError(f"unsupported task audit operation: {operation}")
    if surface == "merge" and operation not in {"status", "next", "resolve", "review", "reopen", "reconcile", "refresh"}:
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
            umbrella_input.resolve(), allowed_paths, provisional_state, config)
        allowed_paths, umbrella_admission, generated_output_admission = finalize_umbrella_admission(
            repository, target_sha, allowed_paths, umbrella_admission)
    else:
        allowed_paths, generated_output_admission = derived_output_admission(
            repository, target_sha, allowed_paths)
    generation = require_current_runtime(repository, target_sha, controller)
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
                umbrella_input.resolve(), locked_baseline, state, config)
            locked_union, locked_umbrella, locked_generated = finalize_umbrella_admission(
                repository, target_sha, locked_union, locked_umbrella)
            if ((locked_union, locked_entries, locked_umbrella, locked_generated)
                    != (allowed_paths, selected_entries, umbrella_admission,
                        generated_output_admission)):
                raise TaskWorkspaceError("umbrella admission changed before mutation")
        existing = state["tasks"].get(task_id)
        if existing:
            receipt = existing.get("creation_receipt", {})
            if receipt.get("requested_paths", []) != requested_paths:
                raise TaskWorkspaceError("task start required paths differ from the frozen creation receipt")
            frozen_umbrella = receipt.get("umbrella_admission")
            if ((umbrella_admission is None) != (frozen_umbrella is None)
                    or (umbrella_admission is not None and umbrella_admission != frozen_umbrella)):
                raise TaskWorkspaceError(
                    "task start umbrella admission differs from the frozen creation receipt")
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
        input_path.resolve(), baseline, state, config)
    union, admission, generated = finalize_umbrella_admission(repository, record["base_sha"], union, admission)
    original_allowed = receipt.get("allowed_paths", [])
    commits = git(worktree, "rev-list", "--reverse", "--parents", f"{record['base_sha']}..{head}").splitlines()
    history: list[dict[str, Any]] = []; escaped: list[str] = []
    for row in commits:
        commit, *parents = row.split()
        edges: list[dict[str, Any]] = []
        # Every parent edge is authority. In particular, merge commits are not
        # reduced to first-parent combined diff semantics.
        for parent in parents:
            paths = sorted(set(git(worktree, "diff", "--name-only", parent, commit).splitlines()))
            edges.append({"parent": parent, "paths": paths, "paths_sha256": stable_sha256(paths)})
            escaped.extend(path for path in paths if not path_within(path, original_allowed))
        history.append({"commit": commit, "parent_edges": edges,
                        "parent_edges_sha256": stable_sha256(edges)})
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


def authorization_ledger(state: dict[str, Any]) -> dict[str, Any]:
    value = state["queues"].setdefault("umbrella_authorization_ledger", {
        "schema_version": AUTHORIZATION_LEDGER_SCHEMA, "issued": {},
    })
    if (not isinstance(value, dict) or set(value) != {"schema_version", "issued"}
            or value.get("schema_version") != AUTHORIZATION_LEDGER_SCHEMA
            or not isinstance(value.get("issued"), dict)):
        raise TaskWorkspaceError("umbrella authorization ledger is invalid")
    return value["issued"]


def issue_umbrella_recovery_authorization(controller: Path, task_id: str,
                                           plan_path: Path, input_path: Path) -> dict[str, Any]:
    plan, plan_file_sha = read_json_object(plan_path, "umbrella recovery plan")
    plan_sha = stable_sha256(plan)
    config = load_config(controller); repository = product_repository(controller, config)
    with state_lock(controller):
        state = read_state(controller)
        expected = _recovery_plan_locked(controller, task_id, input_path, config, repository, state)
        if plan != expected:
            raise TaskWorkspaceError("only the exact current reviewed recovery plan can be authorized")
        issued = authorization_ledger(state)
        for authorization_id, row in issued.items():
            if row.get("plan_sha256") == plan_sha and row.get("plan_file_sha256") == plan_file_sha:
                return {**row, "authorization_id": authorization_id, "outcome": "already_issued"}
        authorization_id = secrets.token_hex(24)
        root = controller / ".juno_task/receipts/task-admission-authorizations"
        root.mkdir(parents=True, exist_ok=True)
        path = root / f"{task_id}-{authorization_id}.json"
        receipt = {"schema_version": UMBRELLA_AUTHORIZATION_SCHEMA,
                   "authorization_id": authorization_id, "task_id": task_id,
                   "action": "supersede_umbrella_admission", "plan_sha256": plan_sha,
                   "plan_file_sha256": plan_file_sha,
                   "predecessor_receipt_sha256": plan["predecessor_receipt_sha256"]}
        data = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        row = {"path": str(path.resolve()), "sha256": hashlib.sha256(data).hexdigest(),
               "plan_sha256": plan_sha, "plan_file_sha256": plan_file_sha,
               "predecessor_receipt_sha256": plan["predecessor_receipt_sha256"]}
        issued[authorization_id] = row
        try: write_state(controller, state)
        except Exception:
            path.unlink(missing_ok=True); raise
    return {**row, "authorization_id": authorization_id, "outcome": "issued"}


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
        ledger_row = authorization_ledger(state).get(authorization.get("authorization_id"))
        if (not isinstance(ledger_row, dict)
                or ledger_row.get("path") != str(authorization_path)
                or ledger_row.get("sha256") != authorization_file_sha
                or ledger_row.get("plan_sha256") != plan_sha
                or ledger_row.get("plan_file_sha256") != plan_file_sha):
            raise TaskWorkspaceError("authorization receipt was not issued by trusted controller ledger")
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
        raise TaskWorkspaceError(
            f"recorded task repository/worktree is missing or reused: {exc}"
        ) from exc
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


def review_ready_closure(controller: Path, config: dict[str, Any], record: dict[str, Any],
                         configured_repository: Path, task_id: str,
                         runtime: dict[str, Any]) -> tuple[
                             Path, Path, str, list[str], dict[str, Any]]:
    """Validate the cheap finish boundary and bind it as one immutable closure."""
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
            raise TaskWorkspaceError(
                f"frozen umbrella child admission drifted: {json.dumps(drift, sort_keys=True)}")
    outside = [path for path in changed if not path_within(path, frozen_allowed)]
    if forbidden or outside:
        raise TaskWorkspaceError(
            f"task changed disallowed paths: {', '.join(sorted(set(forbidden + outside)))}"
        )
    verify_derived_output_parity(repository, head, frozen_generated_admission, changed)
    policy_path = controller / ".juno_task/config/risk-policy.json"
    try:
        policy_sha256 = hashlib.sha256(policy_path.read_bytes()).hexdigest()
    except OSError as exc:
        raise TaskWorkspaceError("risk policy is missing during task preflight") from exc
    closure_body = {
        "schema_version": "juno_task_review_ready_closure.v1",
        "task_id": task_id,
        "base_sha": record["base_sha"],
        "tip_sha": head,
        "tree_sha": git(repository, "rev-parse", f"{head}^{{tree}}"),
        "changed_paths": changed,
        "changed_paths_sha256": stable_sha256(changed),
        "allowed_paths_sha256": stable_sha256(frozen_allowed),
        "creation_receipt_sha256": record["workspace_identity"]["create_receipt_sha256"],
        "generated_output_admission_sha256": stable_sha256(
            frozen_generated_admission
        ),
        "risk_policy_sha256": policy_sha256,
        "runtime_sha256": runtime["running_sha256"],
        "unresolved_findings_candidate_sha": record.get("prior_findings_candidate_sha"),
    }
    closure = {**closure_body, "closure_sha256": stable_sha256(closure_body)}
    return repository, worktree, head, changed, closure


def preflight(controller: Path, task_id: str) -> dict[str, Any]:
    """Run finish identity/admission checks without validation or queue mutation."""
    if not TASK_RE.fullmatch(task_id):
        raise TaskWorkspaceError("unsafe task id")
    config = load_config(controller)
    require_task(controller, task_id)
    configured_repository = product_repository(controller, config)
    runtime = require_current_runtime(configured_repository,
                                      ref_sha(configured_repository, config["target_ref"]),
                                      controller)
    with state_lock(controller):
        record = read_state(controller)["tasks"].get(task_id)
        if not isinstance(record, dict):
            raise TaskWorkspaceError("task has not been started")
        if record.get("state") != "WORKING":
            raise TaskWorkspaceError(f"task cannot preflight from {record.get('state')}")
        frozen_record = json.loads(json.dumps(record))
    _, worktree, head, changed, closure = review_ready_closure(
        controller, config, frozen_record, configured_repository, task_id, runtime
    )
    if load_config(controller) != config:
        raise TaskWorkspaceError("task workspace policy changed during preflight")
    return {"schema_version": RECORD_SCHEMA, "task_id": task_id, "state": "WORKING",
            "outcome": "preflight_passed", "worktree": str(worktree), "tip_sha": head,
            "changed_paths": changed, "review_ready_closure": closure}


def _finish_once(controller: Path, task_id: str) -> dict[str, Any]:
    config = load_config(controller)
    require_task(controller, task_id)
    configured_repository = product_repository(controller, config)
    runtime = require_current_runtime(configured_repository,
                                      ref_sha(configured_repository, config["target_ref"]),
                                      controller)
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
    repository, worktree, head, changed, closure = review_ready_closure(
        controller, config, frozen_record, configured_repository, task_id, runtime
    )
    _frozen_allowed, frozen_generated_admission, _admission_source = effective_admission(
        frozen_record)
    frozen_umbrella = (
        frozen_record.get("admission_supersessions", [{}])[-1].get("umbrella_admission")
        if frozen_record.get("admission_supersessions")
        else frozen_record.get("creation_receipt", {}).get("umbrella_admission")
    )
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
              "review_ready_closure": closure,
              "review_round": 1,
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
    if record.get("state") == "WORKING":
        _, _, live_tip, live_paths = observe_working_task(
            record, configured_repository, config, task_id
        )
        result.update({"tip_sha": live_tip, "changed_paths": live_paths})
    frozen_umbrella = (record.get("admission_supersessions", [{}])[-1].get("umbrella_admission")
                       if record.get("admission_supersessions")
                       else record.get("creation_receipt", {}).get("umbrella_admission"))
    if frozen_umbrella is not None:
        _paths, frozen_generated, source = effective_admission(record)
        result["umbrella_admission_status"] = {
            "authority": ("authorized_superseding" if source == "superseding"
                          else "historical_creation"),
            "ordered_child_ids": frozen_umbrella.get("ordered_child_ids"),
            "child_bindings": frozen_umbrella.get("child_bindings"),
            "union_paths_sha256": frozen_umbrella.get("union_paths_sha256"),
            "child_revision_drift": umbrella_drift(
                controller, configured_repository, frozen_umbrella,
                frozen_generated, state, task_id),
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


def require_metadata_only_controller(controller: Path,
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
    registered_path = git(controller, "config", "--local", "--get", "juno.controller.path", check=False)
    registered_branch = git(controller, "config", "--local", "--get", "juno.controller.branch", check=False)
    try:
        config_json = json.loads((controller / ".juno_task/config.json").read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(f"runtime bootstrap controller config is invalid: {exc}") from exc
    expected_shape = {"mode": "metadata-only",
                      "policy": ".juno_task/config/metadata-controller.json"}
    if (branch != policy["controller_branch"] or role != "controller"
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
            "runtime bootstrap is restricted to the exact registered metadata-only controller")
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


def _managed_inventory_entries_valid(assets: Any) -> bool:
    try:
        return isinstance(assets, dict) and all(
            isinstance(path, str) and normalized_relative(path, "managed inventory path") == path
            and isinstance(record, dict)
            and set(record) == {"type", "templateVersion", "sourceSha256", "installedSha256"}
            and isinstance(record.get("type"), str) and bool(record["type"])
            and is_valid_semver(record.get("templateVersion"))
            and re.fullmatch(r"[0-9a-f]{64}", str(record.get("sourceSha256", ""))) is not None
            and re.fullmatch(r"[0-9a-f]{64}", str(record.get("installedSha256", ""))) is not None
            for path, record in assets.items())
    except TaskWorkspaceError:
        return False


def cli_version_output_valid(result: subprocess.CompletedProcess[str],
                             version: str, cwd: Path) -> bool:
    """Accept only the prefixed machine or canonical human --version contract."""
    if result.stdout == f"juno-code {version}\n" and result.stderr == "":
        return True
    if result.stdout != f"{version}\n":
        return False
    node_version = r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    node_platform = r"(?:aix|android|darwin|freebsd|linux|openbsd|sunos|win32)"
    historical_banner = (
        rf"\n🎯 Juno Code v{re.escape(version)} - TypeScript CLI\n"
        rf"   Node\.js {node_version} on {node_platform}\n"
        rf"   Working directory: {re.escape(str(cwd))}\n\n"
    )
    return re.fullmatch(historical_banner, result.stderr) is not None


def _legacy_installed_runtime_prior(controller: Path, prior: bytes, prior_mode: str,
                                    recovery_package_version: str) -> dict[str, Any]:
    """Prove an inventory-less consumer blob came from the registered old release."""
    identity_path = controller / ".juno_task/runtime/identity.json"
    if identity_path.is_symlink() or not identity_path.is_file():
        raise TaskWorkspaceError(
            "consumer target task runtime lacks managed inventory and installed runtime identity")
    try:
        identity_bytes = identity_path.read_bytes()
        identity = json.loads(identity_bytes)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(
            "consumer target installed runtime identity is missing or invalid") from exc
    required = {"package", "version", "executable", "executable_sha256", "source", "tracked"}
    if (not isinstance(identity, dict) or set(identity) != required
            or identity.get("package") != "juno-code"
            or identity.get("source") != "installed-release"
            or identity.get("tracked") is not False
            or not is_valid_semver(identity.get("version"))
            or not semver_precedes(identity["version"], recovery_package_version)
            or re.fullmatch(r"[0-9a-f]{64}", str(identity.get("executable_sha256", ""))) is None):
        raise TaskWorkspaceError(
            "consumer target installed runtime identity is invalid or not older than recovery")
    configured_version = git(
        controller, "config", "--worktree", "--get", "juno.controller.runtimeVersion",
        check=False)
    configured_executable = git(
        controller, "config", "--worktree", "--get", "juno.controller.runtimeExecutable",
        check=False)
    try:
        executable = Path(identity["executable"]).expanduser().resolve(strict=True)
    except (OSError, TypeError, ValueError) as exc:
        raise TaskWorkspaceError("consumer target installed runtime executable is missing") from exc
    if (str(executable) != identity["executable"]
            or configured_version != identity["version"]
            or configured_executable != identity["executable"]
            or not executable.is_file() or not os.access(executable, os.X_OK)):
        raise TaskWorkspaceError("consumer target installed runtime identity is stale or tampered")
    executable_sha256 = hashlib.sha256(executable.read_bytes()).hexdigest()
    if executable_sha256 != identity["executable_sha256"]:
        raise TaskWorkspaceError("consumer target installed runtime identity is stale or tampered")
    if git(executable.parent, "rev-parse", "--show-toplevel", check=False):
        raise TaskWorkspaceError("consumer target installed runtime must be outside Git")
    try:
        package_root = executable.parents[2]
    except IndexError as exc:
        raise TaskWorkspaceError(
            "consumer target installed runtime package layout is invalid") from exc
    if (executable.parent.parent != package_root / "dist"
            or executable.name not in {"cli.mjs", "cli.js"}):
        raise TaskWorkspaceError("consumer target installed runtime package layout is invalid")
    try:
        manifest_path = package_root / "package.json"
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
        template = package_root / "dist/templates/scripts/task_workspace.py"
        template_bytes = template.read_bytes()
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError(
            "consumer target installed runtime package/template identity is missing") from exc
    if (not isinstance(manifest, dict) or manifest.get("name") != "juno-code"
            or manifest.get("version") != identity["version"] or template.is_symlink()
            or template_bytes != prior):
        raise TaskWorkspaceError(
            "consumer target task runtime does not match the registered installed template")
    version_result = run([str(executable), "--version"], executable.parent, check=False)
    if (version_result.returncode != 0
            or not cli_version_output_valid(
                version_result, identity["version"], executable.parent)
            or hashlib.sha256(executable.read_bytes()).hexdigest() != executable_sha256):
        raise TaskWorkspaceError("consumer target installed runtime version output mismatched")
    prior_sha = hashlib.sha256(prior).hexdigest()
    provenance = {
        "identity_sha256": hashlib.sha256(identity_bytes).hexdigest(),
        "version": identity["version"], "executable": str(executable),
        "executable_sha256": executable_sha256, "package_root": str(package_root),
        "package_json_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "template": str(template),
        "template_sha256": hashlib.sha256(template_bytes).hexdigest(),
    }
    return {"state": "present", "mode": prior_mode, "sha256": prior_sha,
            "bytes_base64": base64.b64encode(prior).decode(),
            "classification": "exact_registered_legacy_installed_consumer_generation",
            "package_version": identity["version"], "inventory_package_version": None,
            "inventory_mode": None, "inventory_sha256": None,
            "inventory_bytes_base64": None, "legacy_runtime": provenance}


def _runtime_prior_state(controller: Path, repository: Path, target_sha: str,
                         proposed: bytes, recovery_package_version: str) -> dict[str, Any]:
    prior = target_blob(repository, target_sha, RUNTIME_PATH)
    package_bytes = target_blob(repository, target_sha, "juno-code/package.json")
    source = target_blob(repository, target_sha,
                         "juno-code/src/templates/scripts/task_workspace.py")
    try:
        package = json.loads(package_bytes) if package_bytes is not None else None
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TaskWorkspaceError("target package identity is invalid; refusing bootstrap") from exc
    source_repository = package_bytes is not None or source is not None
    if source_repository and (not isinstance(package, dict)
                              or package.get("name") != "juno-code"
                              or not is_valid_semver(package.get("version"))):
        raise TaskWorkspaceError("Juno source target package identity is invalid")
    if prior is None:
        if source_repository:
            target_package_version = package["version"]
            if source != proposed:
                if not semver_precedes(target_package_version, recovery_package_version):
                    raise TaskWorkspaceError(
                        "Juno source target runtime is absent at a non-older package/template "
                        "generation; upgrade or rebind the controller package/runtime to match "
                        "the target, then repair source identities atomically if still required")
                raise TaskWorkspaceError(
                    "Juno source target runtime is absent at an older package/template "
                    "generation; update package template/runtime/inventory atomically")
            raise TaskWorkspaceError(
                "Juno source target runtime is absent; update package template/runtime/inventory "
                "atomically instead of runtime bootstrap")
        inventory_bytes = target_blob(repository, target_sha, MANAGED_INVENTORY_PATH)
        if inventory_bytes is None:
            return {"state": "absent", "mode": None, "sha256": None,
                    "bytes_base64": None, "classification": "missing",
                    "inventory_mode": None, "inventory_sha256": None,
                    "inventory_bytes_base64": None}
        try:
            inventory = json.loads(inventory_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TaskWorkspaceError(
                "consumer target managed inventory is invalid; refusing bootstrap") from exc
        prior_version = inventory.get("packageVersion") if isinstance(inventory, dict) else None
        assets = inventory.get("assets") if isinstance(inventory, dict) else None
        entry = assets.get(RUNTIME_PATH) if isinstance(assets, dict) else None
        all_entries_valid = _managed_inventory_entries_valid(assets)
        runtime_version = entry.get("templateVersion") if isinstance(entry, dict) else None
        entry_valid = entry is None or (
            isinstance(entry, dict)
            and entry.get("type") == "script"
            and entry.get("installedSha256") == entry.get("sourceSha256")
            and is_valid_semver(runtime_version)
            and (runtime_version == recovery_package_version
                 or semver_precedes(runtime_version, recovery_package_version)))
        if (not isinstance(inventory, dict) or set(inventory) != {
                "schemaVersion", "packageName", "packageVersion", "assets"}
                or inventory.get("schemaVersion") != 1
                or inventory.get("packageName") != "juno-code"
                or not is_valid_semver(prior_version) or not all_entries_valid
                or not entry_valid
                or (prior_version != recovery_package_version
                    and not semver_precedes(prior_version, recovery_package_version))):
            raise TaskWorkspaceError(
                "consumer target missing runtime lacks an exact non-newer managed-inventory "
                "generation; refusing bootstrap")
        inventory_row = git(repository, "ls-tree", target_sha, "--", MANAGED_INVENTORY_PATH)
        inventory_mode = inventory_row.split(None, 1)[0] if inventory_row else ""
        if inventory_mode not in {"100644", "100755"}:
            raise TaskWorkspaceError("target managed inventory has an unsafe Git mode")
        return {"state": "absent", "mode": None, "sha256": None,
                "bytes_base64": None, "classification": "missing",
                "inventory_mode": inventory_mode,
                "inventory_sha256": hashlib.sha256(inventory_bytes).hexdigest(),
                "inventory_bytes_base64": base64.b64encode(inventory_bytes).decode()}
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
    inventory_package_version = inventory.get("packageVersion") if isinstance(inventory, dict) else None
    assets = inventory.get("assets") if isinstance(inventory, dict) else None
    entry = assets.get(RUNTIME_PATH) if isinstance(assets, dict) else None
    runtime_package_version = entry.get("templateVersion") if isinstance(entry, dict) else None
    all_entries_valid = _managed_inventory_entries_valid(assets)
    inventory_valid = (
        isinstance(inventory, dict) and set(inventory) == {
            "schemaVersion", "packageName", "packageVersion", "assets"}
        and inventory.get("schemaVersion") == 1
        and inventory.get("packageName") == "juno-code"
        and is_valid_semver(inventory_package_version)
        and all_entries_valid
        and isinstance(entry, dict)
        and entry.get("type") == "script"
        and is_valid_semver(runtime_package_version)
        and entry.get("sourceSha256") == prior_sha
        and entry.get("installedSha256") == prior_sha
    )
    if source_repository:
        if source != prior:
            raise TaskWorkspaceError("Juno source target template/runtime identity is inconsistent")
        if not inventory_valid or package.get("version") != runtime_package_version:
            raise TaskWorkspaceError(
                "Juno source target runtime is customized or lacks exact "
                "package/source/inventory provenance; refusing bootstrap")
        if not semver_precedes(runtime_package_version, recovery_package_version):
            raise TaskWorkspaceError(
                "Juno source target generation is not older than the recovery package; upgrade "
                "or rebind the controller package/runtime to match the target")
        raise TaskWorkspaceError(
            "Juno source target runtime is stale; update package template/runtime/inventory "
            "atomically instead of runtime bootstrap")
    if not inventory_valid:
        if inventory_bytes is None:
            return _legacy_installed_runtime_prior(
                controller, prior, prior_mode, recovery_package_version)
        raise TaskWorkspaceError(
            "consumer target task runtime is customized or lacks exact managed-inventory "
            "provenance; refusing bootstrap")
    if not semver_precedes(runtime_package_version, recovery_package_version):
        raise TaskWorkspaceError(
            "consumer target managed runtime package generation is not older than the recovery "
            "package; refusing bootstrap")
    inventory_row = git(repository, "ls-tree", target_sha, "--", MANAGED_INVENTORY_PATH)
    inventory_mode = inventory_row.split(None, 1)[0] if inventory_row else ""
    if inventory_mode not in {"100644", "100755"}:
        raise TaskWorkspaceError("target managed inventory has an unsafe Git mode")
    return {"state": "present", "mode": prior_mode, "sha256": prior_sha,
            "bytes_base64": base64.b64encode(prior).decode(),
            "classification": "exact_managed_inventory_consumer_generation",
            "package_version": runtime_package_version,
            "inventory_package_version": inventory_package_version,
            "inventory_mode": inventory_mode,
            "inventory_sha256": hashlib.sha256(inventory_bytes).hexdigest(),
            "inventory_bytes_base64": base64.b64encode(inventory_bytes).decode()}


def _proposed_inventory(prior: dict[str, Any], package_version: str,
                        runtime_sha256: str) -> dict[str, Any]:
    if not isinstance(prior, dict):
        raise TaskWorkspaceError("task-runtime bootstrap prior inventory binding is invalid")
    encoded = prior.get("inventory_bytes_base64")
    if encoded is None:
        inventory = {"schemaVersion": 1, "packageName": "juno-code",
                     "packageVersion": package_version, "assets": {}}
        inventory_mode = "100644"
    else:
        try:
            inventory = json.loads(base64.b64decode(encoded, validate=True))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise TaskWorkspaceError("task-runtime bootstrap prior inventory is invalid") from exc
        inventory_mode = prior.get("inventory_mode")
        if (not isinstance(inventory, dict)
                or set(inventory) != {"schemaVersion", "packageName", "packageVersion", "assets"}
                or inventory.get("schemaVersion") != 1
                or inventory.get("packageName") != "juno-code"
                or not isinstance(inventory.get("assets"), dict)
                or inventory_mode not in {"100644", "100755"}):
            raise TaskWorkspaceError("task-runtime bootstrap prior inventory binding is invalid")
    inventory["packageVersion"] = package_version
    inventory["assets"][RUNTIME_PATH] = {
        "type": "script", "templateVersion": package_version,
        "sourceSha256": runtime_sha256, "installedSha256": runtime_sha256,
    }
    inventory_bytes = (json.dumps(inventory, indent=2) + "\n").encode()
    return {"path": MANAGED_INVENTORY_PATH, "mode": inventory_mode,
            "sha256": hashlib.sha256(inventory_bytes).hexdigest(),
            "bytes_base64": base64.b64encode(inventory_bytes).decode()}


def _runtime_bootstrap_plan(controller: Path, package_version: str,
                            package_runtime_sha256: str) -> dict[str, Any]:
    config = load_config(controller)
    controller_class = require_metadata_only_controller(controller, config)
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
    prior = _runtime_prior_state(
        controller, repository, target_sha, running, package_version)
    if prior["sha256"] == running_sha:
        raise TaskWorkspaceError("target task runtime already matches the package")
    proposed_inventory = _proposed_inventory(prior, package_version, running_sha)
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
                     "bytes_base64": base64.b64encode(running).decode(),
                     "inventory": proposed_inventory},
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
                                       "task_runtime_sha256": package_runtime_sha256}
            or not isinstance(plan.get("controller_identity"), dict)
            or not isinstance(plan.get("target"), dict)
            or set(plan["target"]) != {"repository", "ref", "sha", "tree"}
            or not isinstance(plan["target"].get("repository"), str)
            or not isinstance(plan["target"].get("ref"), str)
            or not SHA_RE.fullmatch(str(plan["target"].get("sha", "")))
            or not SHA_RE.fullmatch(str(plan["target"].get("tree", "")))
            or not isinstance(plan.get("prior"), dict)
            or not isinstance(plan.get("proposed"), dict)):
        raise TaskWorkspaceError("task-runtime bootstrap receipt/controller/package identity mismatch")
    try:
        proposed = base64.b64decode(plan["proposed"]["bytes_base64"], validate=True)
    except (KeyError, TypeError, ValueError) as exc:
        raise TaskWorkspaceError("task-runtime bootstrap proposed bytes are invalid") from exc
    if (set(plan["proposed"]) != {"mode", "sha256", "bytes_base64", "inventory"}
            or hashlib.sha256(proposed).hexdigest() != package_runtime_sha256
            or plan["proposed"].get("sha256") != package_runtime_sha256
            or plan["proposed"].get("mode") != "100755"
            or hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest() != package_runtime_sha256):
        raise TaskWorkspaceError("task-runtime bootstrap package bytes/hash mismatch")
    proposed_inventory = plan["proposed"].get("inventory")
    expected_inventory = _proposed_inventory(
        plan.get("prior", {}), package_version, package_runtime_sha256)
    if proposed_inventory != expected_inventory:
        raise TaskWorkspaceError(
            "task-runtime bootstrap inventory is not derived from bound prior/package bytes")
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


def _bootstrap_path_bytes(prior: dict[str, Any], proposed: bytes,
                          proposed_inventory: bytes | None) -> dict[str, tuple[bytes | None, bytes]]:
    paths = {RUNTIME_PATH: (
        base64.b64decode(prior["bytes_base64"], validate=True)
        if prior.get("bytes_base64") is not None else None, proposed)}
    if proposed_inventory is not None:
        paths[MANAGED_INVENTORY_PATH] = (
            base64.b64decode(prior["inventory_bytes_base64"], validate=True)
            if prior.get("inventory_bytes_base64") is not None else None,
            proposed_inventory)
    return paths


def _holder_dirt_matches_interrupted_runtime_sync(
        holder: Path, prior: dict[str, Any], proposed: bytes,
        proposed_inventory: bytes | None = None) -> bool:
    status = run(["git", "-C", str(holder), "status", "--porcelain=v1",
                  "--untracked-files=all"], holder, check=False).stdout.rstrip("\n")
    rows = [line for line in status.splitlines() if line]
    try:
        paths = _bootstrap_path_bytes(prior, proposed, proposed_inventory)
    except (KeyError, TypeError, ValueError):
        return False
    if not rows or any(line[3:] not in paths for line in rows):
        return False
    saw_proposed = False
    for path, (prior_bytes, proposed_bytes) in paths.items():
        destination = holder / path
        working = destination.read_bytes() if destination.is_file() else None
        index_result = subprocess.run(
            ["git", "-C", str(holder), "show", f":{path}"], cwd=holder,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        indexed = index_result.stdout if index_result.returncode == 0 else None
        # Every path must remain at an exact prior/proposed boundary. At least
        # one proposed side proves this is a package-created partial transition.
        admitted = {prior_bytes, proposed_bytes}
        if working not in admitted or indexed not in admitted:
            return False
        saw_proposed = saw_proposed or proposed_bytes in {working, indexed}
    return saw_proposed


def _holder_is_prepared_for_cas(holder: Path, previous_sha: str,
                                proposed: bytes,
                                proposed_inventory: bytes | None = None) -> bool:
    if git(holder, "rev-parse", "HEAD^{commit}", check=False) != previous_sha:
        return False
    paths = {RUNTIME_PATH: proposed}
    if proposed_inventory is not None:
        paths[MANAGED_INVENTORY_PATH] = proposed_inventory
    expected_status = []
    for path in sorted(paths):
        prior = run(["git", "-C", str(holder), "cat-file", "-e",
                     f"{previous_sha}:{path}"], holder, check=False)
        expected_status.append(f'{"M" if prior.returncode == 0 else "A"}  {path}')
    status = git(holder, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    if status.splitlines() != expected_status:
        return False
    for path, expected in paths.items():
        destination = holder / path
        if not destination.is_file() or destination.read_bytes() != expected:
            return False
        indexed = subprocess.run(
            ["git", "-C", str(holder), "show", f":{path}"], cwd=holder,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if indexed.returncode != 0 or indexed.stdout != expected:
            return False
    return True


def _prepare_target_holder_for_cas(holder: Path, target_ref: str,
                                   previous_sha: str, commit_sha: str,
                                   prior: dict[str, Any], proposed: bytes,
                                   proposed_inventory: bytes | None = None) -> None:
    current = git(holder, "rev-parse", "HEAD^{commit}", check=False)
    status = git(holder, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    branch = git(holder, "symbolic-ref", "-q", "HEAD", check=False)
    if current != previous_sha or branch != target_ref:
        raise TaskWorkspaceError("target-ref holder moved outside the durable apply intent")
    if _holder_is_prepared_for_cas(
            holder, previous_sha, proposed, proposed_inventory):
        return
    recovering_interruption = bool(status) and _holder_dirt_matches_interrupted_runtime_sync(
        holder, prior, proposed, proposed_inventory)
    if recovering_interruption:
        paths = " ".join(sorted(_bootstrap_path_bytes(
            prior, proposed, proposed_inventory)))
        raise TaskWorkspaceError(
            "target-holder synchronization stopped in an exact package-created partial state; "
            f"after review run `git restore --source={previous_sha} --staged --worktree -- "
            f"{paths}` in {holder}, then rerun the same --apply receipt")
    if status:
        raise TaskWorkspaceError("target-ref holder became dirty before synchronization")
    # Prepare the exact planned-path index/worktree transition while the ref still names
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
            or not _holder_is_prepared_for_cas(
                holder, previous_sha, proposed, proposed_inventory)):
        raise TaskWorkspaceError(
            "target-holder synchronization is incomplete before CAS; rerun the same --apply receipt")


def _validate_runtime_bootstrap_commit(repository: Path, plan: dict[str, Any],
                                       commit_sha: str, proposed: bytes,
                                       proposed_inventory: bytes | None = None) -> str:
    previous_sha = plan["target"]["sha"]
    if git(repository, "rev-parse", f"{commit_sha}^", check=False) != previous_sha:
        raise TaskWorkspaceError("runtime bootstrap commit parent mismatch")
    committed_row = git(repository, "ls-tree", commit_sha, "--", RUNTIME_PATH, check=False)
    changed = git(repository, "diff-tree", "--no-commit-id", "--name-only", "-r",
                  commit_sha, check=False).splitlines()
    expected_paths = [RUNTIME_PATH]
    inventory_valid = True
    if proposed_inventory is not None:
        expected_paths.append(MANAGED_INVENTORY_PATH)
        inventory_row = git(repository, "ls-tree", commit_sha, "--", MANAGED_INVENTORY_PATH,
                            check=False)
        inventory_valid = (
            target_blob(repository, commit_sha, MANAGED_INVENTORY_PATH) == proposed_inventory
            and inventory_row.startswith(plan["proposed"]["inventory"]["mode"] + " blob "))
    if (target_blob(repository, commit_sha, RUNTIME_PATH) != proposed
            or not committed_row.startswith(plan["proposed"]["mode"] + " blob ")
            or sorted(changed) != sorted(expected_paths) or not inventory_valid):
        raise TaskWorkspaceError("runtime bootstrap reviewed commit identity mismatch")
    return git(repository, "rev-parse", f"{commit_sha}^{{tree}}")


def _apply_runtime_bootstrap(controller: Path, package_version: str,
                             package_runtime_sha256: str, receipt_path: Path) -> dict[str, Any]:
    config = load_config(controller)
    controller_class = require_metadata_only_controller(controller, config)
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
    proposed = base64.b64decode(plan["proposed"]["bytes_base64"], validate=True)
    if (_runtime_prior_state(controller, repository, target["sha"], proposed, package_version)
            != plan.get("prior")):
        raise TaskWorkspaceError(
            "task-runtime bootstrap bound target prior state does not match the receipt")
    inventory_plan = plan["proposed"].get("inventory")
    proposed_inventory = (base64.b64decode(inventory_plan["bytes_base64"], validate=True)
                          if inventory_plan is not None else None)
    record_root = (controller / RUNTIME_BOOTSTRAP_ROOT).resolve()
    intent_path = record_root / f"{digest}-apply-intent.json"
    applied_path = record_root / f"{digest}-applied.json"
    durable_path = record_root / f"{digest}-completion-durable.json"
    intent: dict[str, Any] | None = None
    if not intent_path.exists() and _bootstrap_target_status(repository):
        raise TaskWorkspaceError("configured target worktree is dirty; refusing runtime bootstrap")
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
        tree = _validate_runtime_bootstrap_commit(
            repository, plan, commit_sha, proposed, proposed_inventory)
        if tree != intent.get("tree"):
            raise TaskWorkspaceError("task-runtime bootstrap apply intent tree mismatch")
    else:
        current_sha = ref_sha(repository, config["target_ref"])
        if (current_sha != target.get("sha")
                or git(repository, "rev-parse", f"{current_sha}^{{tree}}") != target.get("tree")):
            raise TaskWorkspaceError("task-runtime bootstrap target ref moved after planning")
        if _runtime_prior_state(controller, repository, current_sha, proposed,
                                package_version) != plan.get("prior"):
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
            changed_paths = [RUNTIME_PATH]
            if proposed_inventory is not None:
                inventory_destination = temporary / MANAGED_INVENTORY_PATH
                inventory_destination.write_bytes(proposed_inventory)
                inventory_destination.chmod(int(inventory_plan["mode"], 8) & 0o777)
                changed_paths.append(MANAGED_INVENTORY_PATH)
            run(["git", "-C", str(temporary), "add", "--", *changed_paths], temporary)
            if (git(temporary, "diff", "--cached", "--name-only").splitlines()
                    != sorted(changed_paths)):
                raise TaskWorkspaceError("runtime bootstrap staged an unexpected path")
            run(["git", "-C", str(temporary), "-c", "core.hooksPath=/dev/null", "commit", "-m",
                 f"chore(juno): bootstrap package task runtime\n\nReviewed-Plan: {digest}\nJuno-Package: {package_version}"], temporary)
            commit_sha = git(temporary, "rev-parse", "HEAD^{commit}")
            tree = _validate_runtime_bootstrap_commit(
                repository, plan, commit_sha, proposed, proposed_inventory)
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
    guard_ownership_path = record_root / f"{digest}-guard-ownership.json"
    try:
        with _target_mutation_lock(repository, config["target_ref"]):
            if intent["target_holder"] is None:
                workspace_root = Path(config["workspace_root"])
                expected_guard = (workspace_root /
                                  f".yy-task-runtime-bootstrap-guard-{digest}").resolve()
                ownership = {"schema_version": RUNTIME_BOOTSTRAP_SCHEMA,
                             "operation": "guard-ownership", "plan_sha256": digest,
                             "repository": str(repository), "target_ref": config["target_ref"],
                             "path": str(expected_guard)}
                ownership_exists = guard_ownership_path.exists()
                if ownership_exists:
                    try:
                        if json.loads(guard_ownership_path.read_text()) != ownership:
                            raise TaskWorkspaceError("package-owned target guard record mismatch")
                    except (OSError, json.JSONDecodeError) as exc:
                        raise TaskWorkspaceError("package-owned target guard record is invalid") from exc
                holders = _target_ref_holders(repository, config["target_ref"])
                if holders:
                    if not ownership_exists:
                        raise TaskWorkspaceError(
                            "target-ref holder lacks durable package guard ownership")
                    if (len(holders) != 1 or holders[0].get("locked")
                            or Path(str(holders[0].get("worktree", ""))).resolve()
                            != expected_guard):
                        raise TaskWorkspaceError(
                            "a non-guard target-ref holder appeared after durable apply intent")
                    holder = exact_root(expected_guard, "durable package-owned target guard")
                    guard_digest = git(holder, "config", "--worktree", "--get",
                                       "juno.bootstrap.guardDigest", check=False)
                    if git(holder, "symbolic-ref", "-q", "HEAD", check=False) != config["target_ref"]:
                        raise TaskWorkspaceError("durable package-owned target guard identity changed")
                    if not guard_digest:
                        if (git(holder, "rev-parse", "HEAD^{commit}", check=False)
                                != intent["previous_sha"]
                                or git(holder, "status", "--porcelain=v1",
                                       "--untracked-files=all", check=False)):
                            raise TaskWorkspaceError(
                                "incomplete package-owned target guard is not clean at expected SHA")
                        run(["git", "-C", str(holder), "config", "--worktree",
                             "juno.bootstrap.guardDigest", digest], holder)
                    elif guard_digest != digest:
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
                # until immediately before durable completion. Ordinary Git worktree creation then
                # fails instead of racing the no-holder observation.
                _validate_intent_holder(repository, None, config["target_ref"])
                workspace_root = Path(config["workspace_root"])
                workspace_root.mkdir(parents=True, exist_ok=True)
                guard_holder = (workspace_root /
                                f".yy-task-runtime-bootstrap-guard-{digest}").resolve()
                if guard_holder.exists():
                    raise TaskWorkspaceError(
                        "durable package-owned target guard path exists outside Git registration")
                _write_runtime_bootstrap_record(guard_ownership_path, ownership)
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
                                               plan["prior"], proposed, proposed_inventory)
                holders = _target_ref_holders(repository, config["target_ref"])
                if (len(holders) != 1
                        or Path(str(holders[0].get("worktree", ""))).resolve() != holder
                        or ref_sha(repository, config["target_ref"]) != intent["previous_sha"]
                        or not _holder_is_prepared_for_cas(
                            holder, intent["previous_sha"], proposed,
                            proposed_inventory)):
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
                guard_ownership_path.unlink(missing_ok=True)
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
    value.add_argument("operation", choices=(
        "start", "status", "preflight", "finish",
        "recovery-plan", "recovery-authorize", "recovery-apply", "runtime-bootstrap"))
    value.add_argument("--task")
    value.add_argument("--path", action="append", default=[], help="required policy-admitted product root")
    value.add_argument("--umbrella-admission", type=Path,
                       help="versioned ordered-child exact-scope input")
    value.add_argument("--plan", type=Path, help="exact reviewed recovery plan")
    value.add_argument("--output", type=Path, help="exclusive recovery plan output")
    value.add_argument("--authorization-receipt", type=Path,
                       help="canonical immutable authorization binding the exact reviewed plan")
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
            if (args.task or args.path or args.umbrella_admission or args.plan or args.output
                    or args.authorization_receipt or not args.package_version
                    or not args.package_runtime_sha256):
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
            if args.operation == "start":
                if args.plan or args.output or args.authorization_receipt:
                    raise TaskWorkspaceError("recovery options are not supported for task start")
                result = start(controller, args.task, args.path, args.umbrella_admission)
            elif args.operation == "recovery-plan":
                if not args.umbrella_admission or not args.output or args.authorization_receipt or args.plan:
                    raise TaskWorkspaceError(
                        "recovery-plan requires --umbrella-admission and --output")
                plan = build_umbrella_recovery_plan(
                    controller, args.task, args.umbrella_admission)
                args.output.parent.mkdir(parents=True, exist_ok=True)
                data = (json.dumps(plan, sort_keys=True, separators=(",", ":")) + "\n").encode()
                fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data); handle.flush(); os.fsync(handle.fileno())
                result = {"schema_version": UMBRELLA_RECOVERY_PLAN_SCHEMA,
                          "task_id": args.task, "outcome": "planned",
                          "plan_path": str(args.output.resolve()),
                          "plan_sha256": stable_sha256(plan),
                          "plan_file_sha256": hashlib.sha256(data).hexdigest()}
            elif args.operation == "recovery-authorize":
                if not args.umbrella_admission or not args.plan or args.authorization_receipt or args.output:
                    raise TaskWorkspaceError(
                        "recovery-authorize requires --umbrella-admission and --plan")
                result = issue_umbrella_recovery_authorization(
                    controller, args.task, args.plan, args.umbrella_admission)
            elif args.operation == "recovery-apply":
                if (not args.umbrella_admission or not args.plan
                        or not args.authorization_receipt or args.output):
                    raise TaskWorkspaceError(
                        "recovery-apply requires --umbrella-admission, --plan, and --authorization-receipt")
                result = apply_umbrella_recovery(
                    controller, args.task, args.plan, args.umbrella_admission,
                    args.authorization_receipt)
            else:
                if args.umbrella_admission or args.plan or args.output or args.authorization_receipt:
                    raise TaskWorkspaceError(
                        "admission/recovery options are unsupported for this operation")
                result = {"status": status, "preflight": preflight,
                          "finish": finish}[args.operation](controller, args.task)
            result = {**result, "control_audit": audit}
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (TaskWorkspaceError, OSError, json.JSONDecodeError) as exc:
        print(f"task workspace: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
