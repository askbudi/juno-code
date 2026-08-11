#!/usr/bin/env python3
"""Conflict-aware single-writer merge queue for Bolt task workspaces.

Only target-ref mutation is serialized. Feature worktrees remain independent,
and controller commits never participate in product history.
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

import integration_workspace as integration_runtime
import task_workspace as task_runtime
import risk_policy as risk_runtime

QUEUE_SCHEMA = task_runtime.STATE_SCHEMA
ATTEMPT_SCHEMA = "juno_merge_queue_attempt.v1"
OWNER_SCHEMA = "juno_merge_queue_candidate_owner.v1"
RISK_STATE_SCHEMA = "juno_merge_queue_risk_state.v1"
REVIEW_PROMPT_FIELDS = {
    "task_id", "review_kind", "reviewer_index", "repository", "base_sha",
    "tip_sha", "checklist_path", "findings_summary_path",
    "validation_evidence_path", "requirements_bundle", "findings_summary",
}
REVIEW_PLACEHOLDER_RE = re.compile(r"{{\s*([a-z_][a-z0-9_]*)\s*}}")
INTEGRATION_OWNER_CONFIG = "juno.integration.ownerPath"
INTEGRATION_OWNER_AUTHORITY = "protected-integration.v1"


class MergeQueueError(RuntimeError):
    pass


class AdmissionStateError(MergeQueueError):
    """A persisted admission tag is unsafe to interpret or replace."""


class MergeValidationError(MergeQueueError):
    def __init__(self, message: str, evidence: list[dict[str, Any]],
                 receipt_reference: Optional[dict[str, str]] = None) -> None:
        super().__init__(message)
        self.evidence = evidence
        self.receipt_reference = receipt_reference


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def write_canonical_exclusive(path: Path, value: dict[str, Any], limit: int) -> None:
    data = risk_runtime.canonical(value)
    if not data or len(data) > limit:
        raise MergeQueueError("exclusive queue artifact exceeds its bound")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise MergeQueueError(f"queue admission artifact already exists: {path}") from exc
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
    except BaseException:
        try: path.unlink()
        except OSError: pass
        raise


def repository_identity(repository: Path) -> str:
    common = task_runtime.git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return str(Path(common).resolve())


def target_key(repository: Path, target_ref: str) -> str:
    material = f"{repository_identity(repository)}\0{target_ref}".encode()
    return hashlib.sha256(material).hexdigest()


def registered_worktrees(repository: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    output = task_runtime.git(repository, "worktree", "list", "--porcelain")
    for line in [*output.splitlines(), ""]:
        if not line:
            if current:
                rows.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key in {"bare", "detached", "locked", "prunable"}:
            current[key] = True if not value else value
        else:
            current[key] = value
    return rows


def advance_registered_owner_role_base(repository: Path, expected: str,
                                        candidate: str) -> dict[str, Any]:
    """Persist authority only after this queue has admitted the exact CAS."""
    raw = task_runtime.git(repository, "config", "--local", "--get",
                           INTEGRATION_OWNER_CONFIG, check=False)
    if not raw:
        return {"status": "not_registered", "before": expected, "after": candidate}
    owner = Path(raw).expanduser().resolve()
    rows = {str(Path(row["worktree"]).resolve()): row for row in registered_worktrees(repository)
            if isinstance(row.get("worktree"), str) and row.get("prunable") is not True}
    if str(owner) not in rows or not owner.is_dir():
        raise MergeQueueError("registered integration owner is not a live linked worktree")

    def config(key: str) -> str | None:
        return task_runtime.git(owner, "config", "--worktree", "--get", key,
                                check=False) or None

    if config("juno.workspace.role") != "integration-owner":
        raise MergeQueueError("registered integration owner role is invalid")
    if config("juno.workspace.roleAuthority") != INTEGRATION_OWNER_AUTHORITY:
        raise MergeQueueError("registered integration owner authority is invalid")
    head = task_runtime.ref_sha(owner, "HEAD")
    if (head not in {expected, candidate}
            or task_runtime.git(owner, "symbolic-ref", "-q", "HEAD", check=False)
            or task_runtime.git(owner, "status", "--porcelain=v1", "--untracked-files=all",
                                check=False)
            or config("core.sparseCheckout") == "true"
            or any(line.startswith("S ") for line in task_runtime.git(
                owner, "ls-files", "-t", check=False).splitlines())):
        raise MergeQueueError("registered integration owner is not clean, detached, full, and exact")
    role_base = config("juno.workspace.roleBase")
    if role_base == candidate:
        return {"status": "already_advanced", "path": str(owner),
                "before": candidate, "after": candidate}
    if role_base != expected:
        raise MergeQueueError("registered integration owner roleBase is stale or divergent")
    task_runtime.git(owner, "config", "--worktree", "juno.workspace.roleBase", candidate)
    if config("juno.workspace.roleBase") != candidate:
        raise MergeQueueError("registered integration owner roleBase readback failed")
    return {"status": "advanced", "path": str(owner),
            "before": expected, "after": candidate}


def assert_target_unchecked_out(repository: Path, target_ref: str) -> None:
    owners = sorted(row.get("worktree", "") for row in registered_worktrees(repository)
                    if row.get("branch") == target_ref)
    if owners:
        raise MergeQueueError(
            f"target ref is checked out; detach its worktree before queue CAS: {', '.join(owners)}"
        )


def target_entry(state: dict[str, Any], repository: Path, target_ref: str) -> dict[str, Any]:
    key = target_key(repository, target_ref)
    entry = state["queues"].setdefault(key, {
        "repository_identity": repository_identity(repository),
        "target_ref": target_ref,
        "last_attempt": None,
        "conflicts": {},
    })
    expected = {"repository_identity", "target_ref", "last_attempt", "conflicts"}
    if not isinstance(entry, dict) or set(entry) != expected or not isinstance(entry.get("conflicts"), dict):
        raise MergeQueueError("invalid target queue entry")
    if entry["repository_identity"] != repository_identity(repository) or entry["target_ref"] != target_ref:
        raise MergeQueueError("target queue identity collision")
    return entry


@contextmanager
def target_lock(_controller: Path, repository: Path, target_ref: str) -> Iterator[None]:
    # The lock belongs to the repository, not a controller checkout. Distinct
    # controllers targeting the same full ref therefore contend on one inode.
    common = Path(repository_identity(repository))
    lock = common / "juno-locks/merge-queue" / f"{target_key(repository, target_ref)}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a+b") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise MergeQueueError("another worker owns this repository/target-ref queue") from exc
            raise
        yield


@contextmanager
def review_lock(repository: Path, task_id: str) -> Iterator[None]:
    lock = Path(repository_identity(repository)) / "juno-locks/review" / f"{task_id}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a+b") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise MergeQueueError("another reviewer owns this task review claim") from exc
            raise
        yield


def persist_attempt(controller: Path, attempt: dict[str, Any], *, state_name: Optional[str] = None,
                    conflict: Optional[dict[str, Any]] = None, remove_conflict: bool = False) -> None:
    with task_runtime.state_lock(controller):
        state = task_runtime.read_state(controller)
        current = state["tasks"].get(attempt["task_id"])
        if not isinstance(current, dict) or current.get("tip_sha") != attempt["feature_sha"]:
            raise MergeQueueError("task record changed while merge candidate was active")
        if state_name:
            state["tasks"][attempt["task_id"]] = {
                **current, "state": state_name, "queue_attempt": attempt,
                "last_queue_outcome": attempt["outcome"],
            }
        config = task_runtime.load_config(controller)
        repository = task_runtime.product_repository(controller, config)
        entry = target_entry(state, repository, config["target_ref"])
        entry["last_attempt"] = attempt
        if remove_conflict:
            entry["conflicts"].pop(attempt["task_id"], None)
        elif conflict is not None:
            entry["conflicts"][attempt["task_id"]] = conflict
        # Tasks and queue/conflict truth cross one atomic replace boundary.
        task_runtime.write_state(controller, state)


def changed_paths(root: Path) -> list[str]:
    names: set[str] = set()
    for args in (("diff", "--name-only"), ("diff", "--cached", "--name-only"),
                 ("ls-files", "--others", "--exclude-standard")):
        names.update(filter(None, task_runtime.git(root, *args, check=False).splitlines()))
    return sorted(names)


def conflict_paths(root: Path) -> list[str]:
    return sorted(filter(None, task_runtime.git(root, "diff", "--name-only", "--diff-filter=U").splitlines()))


def optional_revision(root: Path, revision: str) -> Optional[str]:
    result = task_runtime.run(["git", "-C", str(root), "rev-parse", f"{revision}^{{commit}}"], root, check=False)
    value = result.stdout.strip()
    return value if result.returncode == 0 and task_runtime.SHA_RE.fullmatch(value) else None


def file_digest(path: Path) -> Optional[str]:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def guard_snapshot(root: Path, paths: list[str]) -> dict[str, Any]:
    return {path: {
        "worktree_sha256": file_digest(root / path),
        "index": task_runtime.git(root, "ls-files", "-s", "--", path, check=False),
    } for path in paths}


def validate_record(config: dict[str, Any], repository: Path, record: dict[str, Any]) -> Path:
    required = {"task_id", "state", "repository", "target_ref", "base_sha", "branch_ref",
                "worktree", "tip_sha", "changed_paths", "validation"}
    if not required.issubset(record):
        raise MergeQueueError("queued task record is incomplete")
    worktree = task_runtime.exact_root(Path(record["worktree"]), "recorded feature worktree")
    tip = record["tip_sha"]
    if Path(record["repository"]).resolve() != repository or record["target_ref"] != config["target_ref"]:
        raise MergeQueueError("queued task repository/target identity drifted")
    if task_runtime.git(worktree, "status", "--porcelain=v1", "--untracked-files=all"):
        raise MergeQueueError("queued feature worktree is dirty; preserve it for inspection")
    if task_runtime.git(worktree, "rev-parse", "HEAD") != tip:
        raise MergeQueueError("queued feature worktree tip drifted")
    if task_runtime.git(repository, "rev-parse", record["branch_ref"], check=False) != tip:
        raise MergeQueueError("queued feature branch tip drifted")
    if task_runtime.run(["git", "-C", str(repository), "merge-base", "--is-ancestor", record["base_sha"], tip], repository, check=False).returncode:
        raise MergeQueueError("queued feature no longer descends from its frozen base")
    return worktree


def select_next(controller: Path, config: dict[str, Any]) -> dict[str, Any]:
    with task_runtime.state_lock(controller):
        tasks = task_runtime.read_state(controller)["tasks"]
        candidates = [row for row in tasks.values() if isinstance(row, dict)
                      and row.get("state") == "QUEUED"
                      and row.get("target_ref") == config["target_ref"]]
    if not candidates:
        raise MergeQueueError("no QUEUED task is ready for this target")
    return sorted(candidates, key=lambda row: (
        row.get("enqueue_sequence", 2**63 - 1), row["task_id"]
    ))[0]


def candidate_directory(controller: Path, task_id: str, target_sha: str, feature_sha: str) -> Path:
    root = controller / ".juno_task/runtime/merge-queue/candidates"
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{task_id}-{target_sha[:10]}-{feature_sha[:10]}-", dir=root))


def owner_marker(controller: Path, checkout: Path) -> Path:
    root = (controller / ".juno_task/runtime/merge-queue/candidates").resolve()
    return root / f".{checkout.resolve().name}.owner.json"


def create_candidate_checkout(controller: Path, repository: Path, task_id: str,
                              target_ref: str, target_sha: str, feature_sha: str) -> tuple[Path, str]:
    checkout = candidate_directory(controller, task_id, target_sha, feature_sha)
    checkout.rmdir()
    token = secrets.token_hex(24)
    task_runtime.run(["git", "-C", str(repository), "worktree", "add", "--detach",
                      str(checkout), target_sha], repository)
    marker = owner_marker(controller, checkout)
    ownership = {"schema_version": OWNER_SCHEMA, "token": token, "task_id": task_id,
                 "repository_identity": repository_identity(repository), "target_ref": target_ref,
                 "target_sha": target_sha, "feature_sha": feature_sha,
                 "candidate_checkout": str(checkout.resolve())}
    try:
        # A repository migrated to worktree-local sparse configuration may
        # still retain the legacy common core.sparseCheckout=true value. New
        # worktrees inherit that common value until they establish their own
        # setting, so an internal candidate created from a sparse controller
        # can otherwise omit every product path. Candidates are product
        # validation roots and must always be explicitly full checkouts.
        task_runtime.run(["git", "-C", str(checkout), "sparse-checkout", "disable"], checkout)
        sparse = task_runtime.git(
            checkout, "config", "--worktree", "--bool", "core.sparseCheckout", check=False
        )
        skipped = [line for line in task_runtime.git(
            checkout, "ls-files", "-t", check=False
        ).splitlines() if line.startswith("S ")]
        if sparse not in {"", "false"} or skipped:
            raise MergeQueueError("candidate full-checkout materialization failed")
        with marker.open("x") as handle:
            handle.write(canonical(ownership) + "\n")
    except Exception:
        # Registration succeeded but ownership admission did not. The exact
        # fresh path is still known in this stack frame; leave a loud error if
        # Git itself refuses the internal rollback.
        removed = task_runtime.run(["git", "-C", str(repository), "worktree", "remove", "--force",
                                    str(checkout)], repository, check=False)
        marker.unlink(missing_ok=True)
        if removed.returncode:
            raise MergeQueueError(f"candidate ownership creation failed and rollback failed: {checkout}")
        raise
    return checkout, token


def read_candidate_owner(controller: Path, checkout: Path) -> dict[str, Any]:
    marker = owner_marker(controller, checkout)
    try:
        value = json.loads(marker.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise MergeQueueError(f"candidate ownership marker is missing or invalid: {marker}") from exc
    required = {"schema_version", "token", "task_id", "repository_identity", "target_ref",
                "target_sha", "feature_sha", "candidate_checkout"}
    if not isinstance(value, dict) or set(value) != required or value.get("schema_version") != OWNER_SCHEMA:
        raise MergeQueueError(f"candidate ownership marker schema is invalid: {marker}")
    return value


def verify_candidate_owner(controller: Path, repository: Path, checkout: Path, token: str) -> dict[str, Any]:
    checkout = checkout.resolve()
    root = (controller / ".juno_task/runtime/merge-queue/candidates").resolve()
    try:
        checkout.relative_to(root)
    except ValueError as exc:
        raise MergeQueueError("candidate path is outside the configured queue root") from exc
    owner = read_candidate_owner(controller, checkout)
    if (owner["token"] != token or owner["candidate_checkout"] != str(checkout)
            or owner["repository_identity"] != repository_identity(repository)):
        raise MergeQueueError("candidate ownership token or repository identity mismatch")
    rows = [row for row in registered_worktrees(repository)
            if Path(row.get("worktree", "")).resolve() == checkout]
    if len(rows) != 1 or rows[0].get("branch") or not rows[0].get("detached"):
        raise MergeQueueError("candidate is not the exact registered detached queue worktree")
    if repository_identity(checkout) != repository_identity(repository):
        raise MergeQueueError("candidate checkout common-dir identity mismatch")
    return owner


def rollback_unadmitted_candidate(controller: Path, repository: Path, checkout: Path, token: str) -> None:
    """Remove only the exact current-attempt internal worktree, even if conflicted."""
    verify_candidate_owner(controller, repository, checkout, token)
    marker = owner_marker(controller, checkout)
    removed = task_runtime.run(["git", "-C", str(repository), "worktree", "remove", "--force",
                                str(checkout)], repository, check=False)
    still_registered = any(Path(row.get("worktree", "")).resolve() == checkout.resolve()
                           for row in registered_worktrees(repository))
    if removed.returncode or checkout.exists() or still_registered:
        orphan = Path(repository_identity(repository)) / "juno-orphans/merge-queue" / f"{token}.json"
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_text(canonical({"schema_version": OWNER_SCHEMA, "outcome": "ORPHANED",
                                     "candidate_owner": read_candidate_owner(controller, checkout),
                                     "controller_marker": str(marker),
                                     "remove_exit_code": removed.returncode,
                                     "still_registered": still_registered,
                                     "path_exists": checkout.exists()}) + "\n")
        raise MergeQueueError(f"unadmitted candidate rollback failed; orphan marker: {orphan}")
    marker.unlink()


@contextmanager
def validation_dependencies(candidate: Path, cwd: Path,
                            source_root: Optional[Path]) -> Iterator[None]:
    """Temporarily expose exact lock-compatible Node dependencies to a candidate."""
    lock = cwd / "package-lock.json"
    if source_root is None or not lock.is_file():
        yield
        return
    relative_cwd = cwd.relative_to(candidate)
    source_cwd = (source_root / relative_cwd).resolve()
    try:
        source_cwd.relative_to(source_root.resolve())
    except ValueError as exc:
        raise MergeQueueError("validation dependency source escaped feature worktree") from exc
    source_lock = source_cwd / "package-lock.json"
    source_modules = source_cwd / "node_modules"
    candidate_modules = cwd / "node_modules"
    if (not source_lock.is_file()
            or hashlib.sha256(lock.read_bytes()).digest()
            != hashlib.sha256(source_lock.read_bytes()).digest()):
        raise MergeQueueError("candidate validation package lock differs from feature worktree")
    if not source_modules.is_dir():
        raise MergeQueueError("lock-compatible feature dependencies are unavailable")
    if candidate_modules.exists() or candidate_modules.is_symlink():
        raise MergeQueueError("candidate validation dependency path already exists")
    relative_modules = str(candidate_modules.relative_to(candidate))
    ignore_probe = f"{relative_modules}/.juno-validation-dependency-probe"
    ignored = task_runtime.run(
        ["git", "-C", str(candidate), "check-ignore", "--quiet", "--", ignore_probe],
        candidate, check=False,
    )
    if ignored.returncode:
        raise MergeQueueError("candidate validation dependency path is not Git-ignored")
    candidate_modules.mkdir()
    linked: list[tuple[Path, Path]] = []
    try:
        for source_entry in sorted(source_modules.iterdir(), key=lambda path: path.name):
            candidate_entry = candidate_modules / source_entry.name
            candidate_entry.symlink_to(source_entry, target_is_directory=source_entry.is_dir())
            linked.append((candidate_entry, source_entry))
        if task_runtime.git(candidate, "status", "--porcelain=v1", "--untracked-files=all",
                            check=False):
            raise MergeQueueError("candidate dependency bridge changed Git-visible state")
        yield
    finally:
        for candidate_entry, source_entry in reversed(linked):
            if (not candidate_entry.is_symlink()
                    or candidate_entry.resolve(strict=False) != source_entry.resolve(strict=False)):
                raise MergeQueueError("candidate dependency bridge identity changed")
            candidate_entry.unlink()
        candidate_modules.rmdir()


def validation_rows(config: dict[str, Any], candidate: Path,
                    dependency_source: Optional[Path] = None) -> list[dict[str, Any]]:
    evidence = []
    for row in config["focused_validation"]:
        cwd = (candidate / row["cwd"]).resolve()
        try:
            cwd.relative_to(candidate)
        except ValueError as exc:
            raise MergeQueueError("affected validation cwd escaped candidate") from exc
        with validation_dependencies(candidate, cwd, dependency_source):
            result = task_runtime.run_validation(row, cwd)
        evidence.append(result)
        if result["timed_out"] or result["exit_code"]:
            detail = result["stderr_tail"] or result["stdout_tail"]
            raise MergeValidationError(f"affected validation failed ({row['id']}): {detail}", evidence)
    return evidence


def full_suite_command(config: dict[str, Any]) -> dict[str, Any]:
    row = config["full_suite_validation"]
    return {key: row[key] for key in
            ("id", "cwd", "argv", "timeout_seconds", "max_output_bytes")}


def fit_full_suite_receipt(receipt: dict[str, Any], limit: int) -> dict[str, Any]:
    """Fit captured UTF-8 tails inside the whole immutable receipt bound."""
    if len(risk_runtime.canonical(receipt)) <= limit:
        return receipt
    original = {
        name: receipt["result"][name]["tail"].encode("utf-8")
        for name in ("stdout", "stderr")
    }

    def with_cap(cap: int) -> dict[str, Any]:
        fitted = json.loads(json.dumps(receipt))
        for name, data in original.items():
            suffix = data[-cap:] if cap else b""
            tail = suffix.decode("utf-8", errors="ignore")
            kept = len(tail.encode("utf-8"))
            fitted["result"][name]["tail"] = tail
            fitted["result"][name]["truncated_bytes"] += len(data) - kept
        return fitted

    low, high = 0, max((len(value) for value in original.values()), default=0)
    best = with_cap(0)
    if len(risk_runtime.canonical(best)) > limit:
        raise MergeQueueError("full-suite receipt metadata exceeds its bound")
    while low <= high:
        middle = (low + high) // 2
        candidate = with_cap(middle)
        if len(risk_runtime.canonical(candidate)) <= limit:
            best, low = candidate, middle + 1
        else:
            high = middle - 1
    return best


def full_suite_validation(config: dict[str, Any], candidate: Path, plan: dict[str, Any],
                          identity: dict[str, str], receipt_path: Path,
                          claim: dict[str, Any],
                          dependency_source: Optional[Path] = None) -> dict[str, str]:
    row = config["full_suite_validation"]
    cwd = (candidate / row["cwd"]).resolve()
    try:
        cwd.relative_to(candidate)
    except ValueError as exc:
        raise MergeQueueError("full-suite validation cwd escaped candidate") from exc
    started_at = risk_runtime.utc_now()
    with validation_dependencies(candidate, cwd, dependency_source):
        evidence = task_runtime.run_validation(row, cwd)
    completed_at = risk_runtime.utc_now()
    receipt = {
        "schema_version": risk_runtime.FULL_SUITE_SCHEMA,
        "producer": {"schema_version": risk_runtime.FULL_SUITE_PRODUCER_SCHEMA,
                     "tool_id": risk_runtime.FULL_SUITE_TOOL_ID},
        "candidate": {"candidate_sha": plan["candidate"]["candidate_sha"],
                      "candidate_tree": plan["candidate"]["candidate_tree"]},
        "policy_identity": plan["policy_identity"],
        "claim": claim,
        "validation_identity": identity,
        "command": full_suite_command(config),
        "started_at": started_at, "completed_at": completed_at,
        "result": {"exit_code": evidence["exit_code"], "timed_out": evidence["timed_out"],
                   "stdout": {"sha256": evidence["stdout_sha256"],
                              "tail": evidence["stdout_tail"],
                              "truncated_bytes": evidence["stdout_truncated_bytes"]},
                   "stderr": {"sha256": evidence["stderr_sha256"],
                              "tail": evidence["stderr_tail"],
                              "truncated_bytes": evidence["stderr_truncated_bytes"]}},
    }
    receipt = fit_full_suite_receipt(receipt, plan["evidence_limits"]["max_receipt_bytes"])
    write_canonical_exclusive(receipt_path, receipt,
                              plan["evidence_limits"]["max_receipt_bytes"])
    if evidence["timed_out"] or evidence["exit_code"]:
        detail = evidence["stderr_tail"] or evidence["stdout_tail"]
        raise MergeValidationError(f"full-suite validation failed ({row['id']}): {detail}",
                                   [evidence], evidence_reference(receipt_path))
    reference = evidence_reference(receipt_path)
    return risk_runtime.verify_full_suite_receipt(
        reference, plan, identity, full_suite_command(config), claim)


def assert_frozen_candidate(controller: Path, config: dict[str, Any], checkout: Path, candidate_sha: str) -> None:
    if task_runtime.load_config(controller) != config:
        raise MergeQueueError("task workspace policy changed while candidate validation was active")
    if task_runtime.git(checkout, "rev-parse", "HEAD", check=False) != candidate_sha:
        raise MergeQueueError("candidate HEAD changed while validation/review was active")
    if task_runtime.git(checkout, "status", "--porcelain=v1", "--untracked-files=all", check=False):
        raise MergeQueueError("candidate checkout became dirty while validation/review was active")


def risk_policy_path(controller: Path) -> Path:
    return controller / ".juno_task/config/risk-policy.json"


def risk_request(repository: Path, candidate_sha: str, target_ref: str,
                 expected_target_sha: str) -> dict[str, str]:
    return {"repository": str(repository.resolve()), "candidate_sha": candidate_sha,
            "target_ref": target_ref, "expected_target_sha": expected_target_sha}


def risk_flags(record: dict[str, Any]) -> Any:
    # Risk is derived from Git. An absent optional flag list is never treated as
    # an asserted low tier; it merely supplies no additional escalation flags.
    return record.get("risk_flags", [])


def evidence_path(controller: Path, task_id: str, candidate_sha: str,
                  attempt_number: Optional[int] = None) -> Path:
    suffix = f".attempt-{attempt_number}" if attempt_number is not None else ""
    return (controller / ".juno_task/runtime/merge-queue/evidence" / task_id
            / f"{candidate_sha}{suffix}.json")


def evidence_reference(path: Path) -> dict[str, str]:
    return {"receipt_path": str(path.resolve()),
            "receipt_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def verify_risk_evidence(policy: dict[str, Any], request: dict[str, str], flags: Any,
                         reference: Any) -> dict[str, Any]:
    try:
        return risk_runtime.verify_candidate_evidence(policy, request, flags, reference)
    except risk_runtime.RiskPolicyError as exc:
        raise MergeQueueError(f"candidate risk evidence refused: {exc}") from exc


def requeue_stale_candidate(controller: Path, config: dict[str, Any], repository: Path,
                            record: dict[str, Any], observed_target_sha: str) -> dict[str, Any]:
    attempt = record.get("queue_attempt")
    if record.get("state") != "REQUEUING_STALE":
        if not isinstance(attempt, dict):
            raise MergeQueueError("stale awaiting task has no candidate attempt")
        checkout_value = attempt.get("candidate_checkout")
        owner = read_candidate_owner(controller, Path(checkout_value)) if checkout_value else None
        stale = {"schema_version": "juno_merge_queue_stale_requeue.v1",
                 "task_id": record["task_id"], "old_candidate_sha": attempt["candidate_sha"],
                 "old_candidate_checkout": checkout_value,
                 "old_candidate_token": attempt.get("candidate_token"),
                 "old_candidate_owner": owner, "observed_target_sha": observed_target_sha}
        reopening = {**record, "state": "REQUEUING_STALE", "stale_requeue": stale}
        with task_runtime.state_lock(controller):
            state = task_runtime.read_state(controller)
            if state["tasks"].get(record["task_id"]) != record:
                raise MergeQueueError("task changed before stale-candidate admission")
            state["tasks"][record["task_id"]] = reopening
            task_runtime.write_state(controller, state)
        record = reopening
    stale = record.get("stale_requeue")
    if not isinstance(stale, dict) or stale.get("schema_version") != "juno_merge_queue_stale_requeue.v1":
        raise MergeQueueError("REQUEUING_STALE recovery identity is invalid")
    checkout_value, token = stale.get("old_candidate_checkout"), stale.get("old_candidate_token")
    if checkout_value:
        checkout = Path(checkout_value)
        if checkout.exists():
            if read_candidate_owner(controller, checkout) != stale.get("old_candidate_owner"):
                raise MergeQueueError("stale candidate ownership drifted")
            rollback_unadmitted_candidate(controller, repository, checkout, token)
        else:
            marker = owner_marker(controller, checkout)
            if any(Path(row.get("worktree", "")).resolve() == checkout.resolve()
                   for row in registered_worktrees(repository)):
                raise MergeQueueError("absent stale checkout remains registered")
            if marker.exists():
                owner = read_candidate_owner(controller, checkout)
                if (owner != stale.get("old_candidate_owner") or owner.get("token") != token
                        or owner.get("task_id") != stale.get("task_id")
                        or owner.get("repository_identity") != repository_identity(repository)):
                    raise MergeQueueError("stale orphan marker ownership mismatched")
                parents = task_runtime.git(repository, "show", "-s", "--format=%P",
                                           stale["old_candidate_sha"], check=False).split()
                if parents != [owner.get("target_sha"), owner.get("feature_sha")]:
                    raise MergeQueueError("stale orphan marker candidate binding mismatched")
                marker.unlink()
    queued = {key: value for key, value in record.items()
              if key not in {"queue_attempt", "last_queue_outcome", "stale_requeue"}}
    queued.update({"state": "QUEUED", "last_queue_outcome": "RISK_TARGET_MOVED",
                   "observed_target_sha": observed_target_sha})
    with task_runtime.state_lock(controller):
        state = task_runtime.read_state(controller)
        if state["tasks"].get(record["task_id"]) != record:
            raise MergeQueueError("task changed during stale-candidate cleanup")
        queued["enqueue_sequence"] = task_runtime.assign_enqueue_sequence(state)
        state["tasks"][record["task_id"]] = queued
        target_entry(state, repository, config["target_ref"])["conflicts"].pop(record["task_id"], None)
        task_runtime.write_state(controller, state)
    return {**queued, "outcome": "RISK_TARGET_MOVED"}


def review_candidate(controller: Path, record: dict[str, Any], candidate_sha: str,
                     repository: Path, target_sha: str, validation_root: Path,
                     attempt: dict[str, Any]) -> dict[str, Any]:
    """Plan and strictly verify risk evidence for every frozen candidate.

    Low and optional-review normal candidates get a canonical zero-review
    receipt immediately. Higher-risk and release candidates are durably paused;
    absence or a hand-written PASS object can never authorize CAS.
    """
    try:
        policy = risk_runtime.load_policy(risk_policy_path(controller))
        request = risk_request(repository, candidate_sha, attempt["target_ref"], target_sha)
        flags = risk_flags(record)
        plan = risk_runtime.classify(policy, request, flags)
    except risk_runtime.RiskPolicyError as exc:
        raise MergeQueueError(f"candidate risk plan refused: {exc}") from exc
    current = attempt.get("risk")
    reference = current.get("evidence") if isinstance(current, dict) else None
    reference_from_state = reference is not None
    canonical_path = evidence_path(controller, record["task_id"], candidate_sha)
    if reference is None and canonical_path.is_file():
        reference = evidence_reference(canonical_path)
    risk = {"schema_version": RISK_STATE_SCHEMA, "candidate_sha": candidate_sha,
            "policy_identity": plan["policy_identity"], "plan": plan,
            "evidence": reference}
    if reference is not None:
        try:
            verified = verify_risk_evidence(policy, request, flags, reference)
            if verified["eligible"] and plan["full_suite_required"]:
                evidence = json.loads(Path(reference["receipt_path"]).read_text())
                identity = full_validation_identity(
                    controller, task_runtime.load_config(controller), record,
                    validation_root, candidate_sha)
                verify_queue_full_suite_admission(
                    controller, record["task_id"], plan, identity,
                    full_suite_command(task_runtime.load_config(controller)),
                    evidence["validation"]["full_suite_admission"])
        except MergeQueueError:
            if reference_from_state or not (plan["min_reviews"] or plan["full_suite_required"]):
                raise
            # External/legacy PASS projections are not cache authority. The
            # local full-suite + semantic workflow replaces them from scratch.
            verified = {"eligible": False}
            reference = None
            risk = {**risk, "evidence": None}
        if verified["eligible"]:
            return {**risk, "status": "ELIGIBLE", "evidence": reference}
    if plan["release_gate_required"]:
        return {**risk, "status": "AWAITING_RELEASE"}
    if plan["min_reviews"] or plan["full_suite_required"]:
        return {**risk, "status": "AWAITING_RISK"}
    try:
        receipt = risk_runtime.finalize(
            plan, request, affected_tests_passed=True, full_suite_admission=None,
            reviews=[], metrics={"model_calls": 0, "affected_test_runs": 1,
                                 "full_suite_runs": 0}, policy=policy,
        )
        path = canonical_path
        risk_runtime.atomic_receipt(path, receipt, policy)
        reference = evidence_reference(path)
        verified = risk_runtime.verify_candidate_evidence(policy, request, flags, reference)
    except risk_runtime.RiskPolicyError as exc:
        raise MergeQueueError(f"candidate zero-review evidence refused: {exc}") from exc
    if not verified["eligible"]:
        raise MergeQueueError("candidate zero-review evidence is not eligible")
    assert_frozen_candidate(controller, task_runtime.load_config(controller), validation_root, candidate_sha)
    return {**risk, "status": "ELIGIBLE", "evidence": reference}


def resume_awaiting(controller: Path, config: dict[str, Any], repository: Path,
                    record: dict[str, Any]) -> dict[str, Any]:
    attempt = record.get("queue_attempt")
    if not isinstance(attempt, dict) or attempt.get("candidate_sha") is None:
        raise MergeQueueError("awaiting-risk task has no frozen candidate identity")
    candidate_sha, expected = attempt["candidate_sha"], attempt["expected_target_sha"]
    current = task_runtime.ref_sha(repository, config["target_ref"])
    if current != expected:
        return requeue_stale_candidate(controller, config, repository, record, current)
    checkout_value = attempt.get("candidate_checkout")
    root = (task_runtime.exact_root(Path(checkout_value), "awaiting risk candidate")
            if checkout_value else validate_record(config, repository, record))
    assert_frozen_candidate(controller, config, root, candidate_sha)
    decision = review_candidate(controller, record, candidate_sha, repository, expected, root, attempt)
    attempt = {**attempt, "risk": decision, "review": decision}
    if decision["status"] != "ELIGIBLE":
        attempt["outcome"] = decision["status"]
        persist_attempt(controller, attempt, state_name=decision["status"])
        return attempt
    persist_attempt(controller, attempt, state_name="MERGING")
    assert_target_unchecked_out(repository, config["target_ref"])
    attempt["integration_owner_authority"] = cas_target(
        repository, config["target_ref"], candidate_sha, expected
    )
    attempt["managed_runtime_refresh"] = refresh_managed_controller(
        controller, repository, expected, candidate_sha, attempt["task_id"])
    attempt = {**attempt, "outcome": "MERGED",
               "readback_sha": task_runtime.ref_sha(repository, config["target_ref"])}
    persist_attempt(controller, attempt, state_name="MERGED", remove_conflict=True)
    checkout = Path(checkout_value) if checkout_value else None
    return {**attempt, "cleanup": cleanup_candidate(
        controller, repository, checkout, config["target_ref"], candidate_sha,
        attempt.get("candidate_token"))}


def refresh_managed_controller(controller: Path, repository: Path, previous_sha: str,
                               target_sha: str, task_id: str) -> dict[str, Any]:
    try:
        return integration_runtime.managed_runtime_refresh(
            controller, repository, previous_sha, target_sha, task_id=task_id)
    except integration_runtime.ManagedRuntimeError as exc:
        receipt = f" receipt={exc.receipt['path']}" if exc.receipt else ""
        raise MergeQueueError(f"post-integration managed runtime refresh failed: {exc}{receipt}") from exc


def cas_target(repository: Path, target_ref: str, candidate_sha: str,
               expected_sha: str) -> dict[str, Any]:
    result = task_runtime.run(["git", "-C", str(repository), "update-ref", target_ref,
                               candidate_sha, expected_sha], repository, check=False)
    if result.returncode:
        raise MergeQueueError("target moved before compare-and-swap; no ref was changed")
    actual = task_runtime.git(repository, "rev-parse", f"{target_ref}^{{commit}}")
    if actual != candidate_sha:
        raise MergeQueueError("target compare-and-swap readback mismatch")
    expected_tree = task_runtime.git(repository, "rev-parse", f"{candidate_sha}^{{tree}}")
    actual_tree = task_runtime.git(repository, "rev-parse", f"{target_ref}^{{tree}}")
    if actual_tree != expected_tree:
        raise MergeQueueError("target tree readback mismatch")
    return advance_registered_owner_role_base(repository, expected_sha, candidate_sha)


def cleanup_candidate(controller: Path, repository: Path, checkout: Optional[Path],
                      target_ref: str, candidate_sha: str, token: Optional[str]) -> dict[str, Any]:
    if checkout is None:
        return {"candidate_checkout": None, "outcome": "not_required"}
    try:
        if not token:
            raise MergeQueueError("candidate ownership token is absent")
        verify_candidate_owner(controller, repository, checkout, token)
    except MergeQueueError as exc:
        return {"candidate_checkout": str(checkout.resolve()), "outcome": "preserved",
                "reason": "ownership_mismatch", "detail": str(exc)}
    checkout = checkout.resolve()
    if task_runtime.git(checkout, "rev-parse", "HEAD", check=False) != candidate_sha:
        return {"candidate_checkout": str(checkout), "outcome": "preserved", "reason": "candidate_head_mismatch"}
    dirty = task_runtime.git(checkout, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    reachable = task_runtime.run(["git", "-C", str(repository), "merge-base", "--is-ancestor",
                                  candidate_sha, target_ref], repository, check=False).returncode == 0
    if dirty or not reachable:
        return {"candidate_checkout": str(checkout), "outcome": "preserved",
                "reason": "dirty" if dirty else "candidate_unreachable_from_target"}
    result = task_runtime.run(["git", "-C", str(repository), "worktree", "remove", str(checkout)], repository, check=False)
    if result.returncode:
        return {"candidate_checkout": str(checkout), "outcome": "preserved", "reason": "worktree_remove_failed"}
    owner_marker(controller, checkout).unlink(missing_ok=True)
    return {"candidate_checkout": str(checkout), "outcome": "removed"}


def recover_incomplete(controller: Path, config: dict[str, Any], repository: Path) -> Optional[dict[str, Any]]:
    """Recover the small durable window between MERGING truth and target CAS."""
    with task_runtime.state_lock(controller):
        canonical_state = task_runtime.read_state(controller)
        tasks = canonical_state["tasks"]
        rows = [row for row in tasks.values() if isinstance(row, dict)
                and row.get("state") == "MERGING" and row.get("target_ref") == config["target_ref"]]
    if not rows:
        return None
    record = sorted(rows, key=lambda row: row["task_id"])[0]
    attempt = record.get("queue_attempt")
    if not isinstance(attempt, dict) or attempt.get("feature_sha") != record.get("tip_sha"):
        raise MergeQueueError("MERGING task has invalid recovery identity")
    current = task_runtime.ref_sha(repository, config["target_ref"])
    candidate = attempt.get("candidate_sha")
    if current == candidate:
        expected_tree = task_runtime.git(repository, "rev-parse", f"{candidate}^{{tree}}")
        if expected_tree != attempt.get("candidate_tree"):
            raise MergeQueueError("MERGING recovery candidate tree mismatch")
        authority = advance_registered_owner_role_base(
            repository, attempt["expected_target_sha"], candidate
        )
        runtime_refresh = refresh_managed_controller(
            controller, repository, attempt["expected_target_sha"], candidate,
            attempt["task_id"])
        attempt = {**attempt, "outcome": "MERGED", "readback_sha": current, "recovered": True,
                   "integration_owner_authority": authority,
                   "managed_runtime_refresh": runtime_refresh}
        persist_attempt(controller, attempt, state_name="MERGED", remove_conflict=True)
        checkout_value = attempt.get("candidate_checkout")
        checkout = Path(checkout_value) if checkout_value and Path(checkout_value).is_dir() else None
        return {**attempt, "cleanup": cleanup_candidate(
            controller, repository, checkout, config["target_ref"], candidate, attempt.get("candidate_token")
        )}
    # CAS did not land (or another writer moved the target). Revalidate and
    # rebuild from the latest target rather than trusting pre-crash evidence.
    attempt = {**attempt, "outcome": "RECOVERED_RETRY", "observed_target_sha": current}
    conflict = target_entry(canonical_state, repository, config["target_ref"])["conflicts"].get(record["task_id"])
    if isinstance(conflict, dict) and conflict.get("resolved_candidate_sha") == candidate:
        persist_attempt(controller, attempt, state_name="CONFLICT_RESOLVED", conflict=conflict)
        # resolve is the explicit retry for a bound resolution candidate.
        raise MergeQueueError(f"resolved task {record['task_id']} recovered; retry with merge resolve")
    persist_attempt(controller, attempt, state_name="QUEUED")
    return None


def merge_next(controller: Path, task_id: Optional[str] = None) -> dict[str, Any]:
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    with target_lock(controller, repository, config["target_ref"]):
        recovered = recover_incomplete(controller, config, repository)
        if recovered is not None:
            return recovered
        if task_id is not None:
            if not task_runtime.TASK_RE.fullmatch(task_id):
                raise MergeQueueError("unsafe task id")
            with task_runtime.state_lock(controller):
                record = task_runtime.read_state(controller)["tasks"].get(task_id)
            if not isinstance(record, dict) or record.get("state") not in {
                    "AWAITING_RISK", "AWAITING_RELEASE", "REQUEUING_STALE"}:
                raise MergeQueueError("explicit next task is not awaiting risk or release evidence")
            return resume_awaiting(controller, config, repository, record)
        record = select_next(controller, config)
        feature_worktree = validate_record(config, repository, record)
        target_sha = task_runtime.ref_sha(repository, config["target_ref"])
        feature_sha = record["tip_sha"]
        attempt = {"schema_version": ATTEMPT_SCHEMA, "task_id": record["task_id"],
                   "target_ref": config["target_ref"], "expected_target_sha": target_sha,
                   "feature_sha": feature_sha, "strategy": None, "candidate_sha": None,
                   "candidate_tree": None, "candidate_checkout": None, "candidate_token": None, "validation": [],
                   "review": None, "outcome": "MERGING"}
        checkout: Optional[Path] = None
        direct = task_runtime.run(["git", "-C", str(repository), "merge-base", "--is-ancestor",
                                   target_sha, feature_sha], repository, check=False).returncode == 0
        if direct:
            attempt["strategy"] = "direct"
            candidate_sha = feature_sha
            validation_root = feature_worktree
        else:
            if task_runtime.run(["git", "-C", str(repository), "merge-base", "--is-ancestor",
                                 record["base_sha"], target_sha], repository, check=False).returncode:
                attempt["outcome"] = "STALE_TARGET"
                persist_attempt(controller, attempt, state_name="QUEUED")
                raise MergeQueueError("target no longer descends from the frozen feature base")
            attempt["strategy"] = "merge_both_parents"
            checkout, candidate_token = create_candidate_checkout(
                controller, repository, record["task_id"], config["target_ref"], target_sha, feature_sha
            )
            attempt["candidate_checkout"] = str(checkout)
            attempt["candidate_token"] = candidate_token
            merged = task_runtime.run(["git", "-C", str(checkout), "merge", "--no-ff", "--no-edit", feature_sha], checkout, check=False)
            if merged.returncode:
                conflicts = conflict_paths(checkout)
                if not conflicts:
                    attempt["outcome"] = "MERGE_FAILED"
                    rollback_unadmitted_candidate(controller, repository, checkout, candidate_token)
                    attempt.update({"candidate_checkout": None, "candidate_token": None})
                    persist_attempt(controller, attempt, state_name="QUEUED")
                    raise MergeQueueError(merged.stderr.strip() or "candidate merge failed")
                all_changed = changed_paths(checkout)
                guarded = sorted(set(all_changed) - set(conflicts))
                conflict = {"schema_version": ATTEMPT_SCHEMA, "task_id": record["task_id"],
                            "repository_identity": repository_identity(repository),
                            "target_ref": config["target_ref"], "expected_target_sha": target_sha,
                            "feature_sha": feature_sha, "candidate_checkout": str(checkout),
                            "candidate_token": candidate_token,
                            "candidate_head": task_runtime.git(checkout, "rev-parse", "HEAD"),
                            "merge_head": task_runtime.git(checkout, "rev-parse", "MERGE_HEAD"),
                            "conflict_paths": conflicts, "changed_paths": all_changed,
                            "guard_snapshot": guard_snapshot(checkout, guarded)}
                attempt["outcome"] = "CONFLICT"
                try:
                    persist_attempt(controller, attempt, state_name="CONFLICT", conflict=conflict)
                except Exception:
                    rollback_unadmitted_candidate(controller, repository, checkout, candidate_token)
                    raise
                return {**attempt, "conflict_paths": conflicts}
            candidate_sha = task_runtime.git(checkout, "rev-parse", "HEAD")
            parents = task_runtime.git(checkout, "show", "-s", "--format=%P", candidate_sha).split()
            if parents != [target_sha, feature_sha]:
                raise MergeQueueError("composed candidate does not have exact target/feature parents")
            validation_root = checkout
        attempt["candidate_sha"] = candidate_sha
        attempt["candidate_tree"] = task_runtime.git(repository, "rev-parse", f"{candidate_sha}^{{tree}}")
        try:
            attempt["validation"] = validation_rows(
                config, validation_root, feature_worktree if checkout is not None else None
            )
            assert_frozen_candidate(controller, config, validation_root, candidate_sha)
            if task_runtime.ref_sha(repository, config["target_ref"]) != target_sha:
                raise MergeQueueError("target moved before compare-and-swap; no ref was changed")
            decision = review_candidate(
                controller, record, candidate_sha, repository, target_sha,
                validation_root, attempt,
            )
            attempt["risk"] = decision
            attempt["review"] = decision
            assert_frozen_candidate(controller, config, validation_root, candidate_sha)
            if decision["status"] != "ELIGIBLE":
                attempt["outcome"] = decision["status"]
                persist_attempt(controller, attempt, state_name=decision["status"])
                return attempt
            try:
                persist_attempt(controller, attempt, state_name="MERGING")
            except Exception:
                if checkout is not None and attempt.get("candidate_token"):
                    rollback_unadmitted_candidate(
                        controller, repository, checkout, attempt["candidate_token"]
                    )
                raise
            assert_target_unchecked_out(repository, config["target_ref"])
            attempt["integration_owner_authority"] = cas_target(
                repository, config["target_ref"], candidate_sha, target_sha
            )
            attempt["managed_runtime_refresh"] = refresh_managed_controller(
                controller, repository, target_sha, candidate_sha, attempt["task_id"])
        except MergeValidationError as exc:
            attempt["validation"] = exc.evidence
            attempt["outcome"] = "FAILED_TEST"
            if checkout is not None and attempt.get("candidate_token"):
                rollback_unadmitted_candidate(controller, repository, checkout, attempt["candidate_token"])
                attempt.update({"candidate_checkout": None, "candidate_token": None})
            persist_attempt(controller, attempt, state_name="QUEUED")
            raise
        except MergeQueueError as exc:
            attempt["outcome"] = "STALE_TARGET" if "target moved" in str(exc) else "PRE_CAS_FAILED"
            # MERGING is a crash-recovery window, not long-lived admission of a
            # clean composition checkout. Any ordinary pre-CAS refusal removes
            # the exact owned internal candidate before returning task truth to
            # QUEUED. Durable CONFLICT/CONFLICT_RESOLVED paths return elsewhere
            # and are intentionally never handled here.
            integrated = task_runtime.ref_sha(repository, config["target_ref"]) == candidate_sha
            if integrated:
                attempt["outcome"] = "MERGING_READBACK_FAILED"
                persist_attempt(controller, attempt, state_name="MERGING")
                raise
            if checkout is not None and attempt.get("candidate_token"):
                rollback_unadmitted_candidate(controller, repository, checkout, attempt["candidate_token"])
                attempt.update({"candidate_checkout": None, "candidate_token": None})
            persist_attempt(controller, attempt, state_name="QUEUED")
            raise
        attempt["outcome"] = "MERGED"
        attempt["readback_sha"] = task_runtime.ref_sha(repository, config["target_ref"])
        persist_attempt(controller, attempt, state_name="MERGED", remove_conflict=True)
        cleanup = cleanup_candidate(
            controller, repository, checkout, config["target_ref"], candidate_sha, attempt.get("candidate_token")
        )
        return {**attempt, "cleanup": cleanup}


def verify_resolution(checkout: Path, conflict: dict[str, Any]) -> None:
    current = set(changed_paths(checkout))
    unexpected = current - set(conflict["changed_paths"])
    if unexpected:
        raise MergeQueueError(f"conflict checkout has unrelated drift: {', '.join(sorted(unexpected))}")
    for path, expected in conflict["guard_snapshot"].items():
        actual = {"worktree_sha256": file_digest(checkout / path),
                  "index": task_runtime.git(checkout, "ls-files", "-s", "--", path, check=False)}
        if actual != expected:
            raise MergeQueueError(f"conflict checkout changed outside conflict paths: {path}")
    unresolved = set(conflict_paths(checkout))
    if unresolved:
        raise MergeQueueError(f"conflict paths remain unresolved: {', '.join(sorted(unresolved))}")
    # A staged resolution that exactly selects the first parent legitimately
    # disappears from both diffs; the still-bound MERGE_HEAD proves it remains
    # an explicit merge resolution rather than an unrelated ordinary commit.


def verify_committed_resolution(checkout: Path, conflict: dict[str, Any], candidate_sha: str) -> None:
    if task_runtime.git(checkout, "status", "--porcelain=v1", "--untracked-files=all", check=False):
        raise MergeQueueError("committed resolution checkout is dirty")
    parents = task_runtime.git(checkout, "show", "-s", "--format=%P", candidate_sha).split()
    if parents != [conflict["expected_target_sha"], conflict["feature_sha"]]:
        raise MergeQueueError("committed resolution has unexpected parents")
    changed = set(filter(None, task_runtime.git(
        checkout, "diff", "--name-only", f"{conflict['expected_target_sha']}..{candidate_sha}"
    ).splitlines()))
    if changed - set(conflict["changed_paths"]):
        raise MergeQueueError("committed resolution changed unrelated paths")
    for path, expected in conflict["guard_snapshot"].items():
        index_parts = expected["index"].split()
        expected_blob = index_parts[1] if len(index_parts) >= 2 else ""
        actual_blob = task_runtime.git(checkout, "rev-parse", f"{candidate_sha}:{path}", check=False)
        if actual_blob != expected_blob:
            raise MergeQueueError(f"committed resolution changed outside conflict paths: {path}")


def merge_resolve(controller: Path, task_id: str) -> dict[str, Any]:
    if not task_runtime.TASK_RE.fullmatch(task_id):
        raise MergeQueueError("unsafe task id")
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    with target_lock(controller, repository, config["target_ref"]):
        with task_runtime.state_lock(controller):
            state = task_runtime.read_state(controller)
            record = state["tasks"].get(task_id)
            conflict = target_entry(state, repository, config["target_ref"])["conflicts"].get(task_id)
        if (not isinstance(record, dict) or record.get("state") not in {"CONFLICT", "CONFLICT_RESOLVED"}
                or not isinstance(conflict, dict)):
            raise MergeQueueError("task has no bound CONFLICT candidate")
        if repository_identity(repository) != conflict["repository_identity"]:
            raise MergeQueueError("conflict repository identity drifted")
        if task_runtime.ref_sha(repository, config["target_ref"]) != conflict["expected_target_sha"]:
            raise MergeQueueError("target moved since conflict; preserve checkout and requeue explicitly")
        if task_runtime.git(repository, "rev-parse", record["branch_ref"], check=False) != conflict["feature_sha"]:
            raise MergeQueueError("feature tip moved since conflict")
        checkout = task_runtime.exact_root(Path(conflict["candidate_checkout"]), "conflict candidate checkout")
        if record["state"] == "CONFLICT":
            observed_head = task_runtime.git(checkout, "rev-parse", "HEAD", check=False)
            observed_merge_head = optional_revision(checkout, "MERGE_HEAD")
            if observed_head == conflict["candidate_head"] and observed_merge_head == conflict["merge_head"]:
                verify_resolution(checkout, conflict)
                task_runtime.run(["git", "-C", str(checkout), "commit", "--no-edit"], checkout)
                candidate_sha = task_runtime.git(checkout, "rev-parse", "HEAD")
            elif observed_merge_head is None:
                # The prior invocation may have committed the exact resolution
                # before an injected/crash-time atomic state-write failure.
                verify_committed_resolution(checkout, conflict, observed_head)
                candidate_sha = observed_head
            else:
                raise MergeQueueError("conflict candidate identity drifted")
        else:
            candidate_sha = conflict.get("resolved_candidate_sha")
            if (not isinstance(candidate_sha, str)
                    or task_runtime.git(checkout, "rev-parse", "HEAD", check=False) != candidate_sha
                    or task_runtime.git(checkout, "status", "--porcelain=v1", "--untracked-files=all", check=False)):
                raise MergeQueueError("resolved conflict candidate identity drifted")
        parents = task_runtime.git(checkout, "show", "-s", "--format=%P", candidate_sha).split()
        if parents != [conflict["expected_target_sha"], conflict["feature_sha"]]:
            raise MergeQueueError("resolved candidate does not have exact target/feature parents")
        attempt = {"schema_version": ATTEMPT_SCHEMA, "task_id": task_id,
                   "target_ref": config["target_ref"], "expected_target_sha": conflict["expected_target_sha"],
                   "feature_sha": conflict["feature_sha"], "strategy": "resolved_merge",
                   "candidate_sha": candidate_sha,
                   "candidate_tree": task_runtime.git(checkout, "rev-parse", "HEAD^{tree}"),
                   "candidate_checkout": str(checkout), "candidate_token": conflict.get("candidate_token"),
                   "validation": [], "review": None,
                   "outcome": "MERGING"}
        resolved_conflict = {**conflict, "resolution_state": "RESOLVED",
                             "resolved_candidate_sha": candidate_sha,
                             "resolved_candidate_tree": attempt["candidate_tree"]}
        # The resolved commit is durable before validation. A failed test can
        # therefore retry this exact checkout/commit without a second merge.
        persist_attempt(controller, attempt, state_name="CONFLICT_RESOLVED", conflict=resolved_conflict)
        try:
            attempt["validation"] = validation_rows(
                config, checkout, task_runtime.exact_root(
                    Path(record["worktree"]), "resolved feature worktree")
            )
            assert_frozen_candidate(controller, config, checkout, candidate_sha)
            if task_runtime.ref_sha(repository, config["target_ref"]) != conflict["expected_target_sha"]:
                raise MergeQueueError("target moved before compare-and-swap; no ref was changed")
            decision = review_candidate(
                controller, record, candidate_sha, repository,
                conflict["expected_target_sha"], checkout, attempt,
            )
            attempt["risk"] = decision
            attempt["review"] = decision
            assert_frozen_candidate(controller, config, checkout, candidate_sha)
            if decision["status"] != "ELIGIBLE":
                attempt["outcome"] = decision["status"]
                persist_attempt(controller, attempt, state_name=decision["status"],
                                conflict=resolved_conflict)
                return attempt
            persist_attempt(controller, attempt, state_name="MERGING")
            assert_target_unchecked_out(repository, config["target_ref"])
            attempt["integration_owner_authority"] = cas_target(
                repository, config["target_ref"], candidate_sha,
                conflict["expected_target_sha"]
            )
            attempt["managed_runtime_refresh"] = refresh_managed_controller(
                controller, repository, conflict["expected_target_sha"], candidate_sha,
                attempt["task_id"])
        except MergeValidationError as exc:
            attempt["validation"] = exc.evidence
            attempt["outcome"] = "FAILED_TEST"
            persist_attempt(controller, attempt, state_name="CONFLICT_RESOLVED", conflict=resolved_conflict)
            raise
        except MergeQueueError:
            integrated = task_runtime.ref_sha(repository, config["target_ref"]) == candidate_sha
            attempt["outcome"] = "MERGING_READBACK_FAILED" if integrated else "STALE_TARGET"
            persist_attempt(
                controller, attempt,
                state_name="MERGING" if integrated else "CONFLICT_RESOLVED",
                conflict=None if integrated else resolved_conflict,
            )
            raise
        attempt["outcome"] = "MERGED"
        attempt["readback_sha"] = task_runtime.ref_sha(repository, config["target_ref"])
        persist_attempt(controller, attempt, state_name="MERGED", remove_conflict=True)
        return {**attempt, "cleanup": cleanup_candidate(
            controller, repository, checkout, config["target_ref"], candidate_sha, attempt.get("candidate_token")
        )}


def dispatch_reviewer(controller: Path, candidate_root: Path, plan: dict[str, Any],
                      task_id: str, reviewer: str, sequence: int,
                      predecessor_receipt: Optional[Path],
                      attempt_number: int) -> dict[str, str]:
    """Launch one canonical reviewer. Tests replace this seam with a fake."""
    run_root = (controller / ".juno_task/runtime/merge-queue/reviews" / task_id
                / plan["candidate"]["candidate_sha"] / f"attempt-{attempt_number}"
                / f"{sequence}-{reviewer}")
    if run_root.exists():
        raise MergeQueueError(f"review output already exists; inspect before retry: {run_root}")
    binding_path = run_root.parent / f"{sequence}-{reviewer}.binding.json"
    prompt = render_managed_review_prompt(
        controller, candidate_root, plan, task_id, reviewer, sequence,
        run_root.parent / f"{sequence}-{reviewer}.prompt.md",
    )
    try:
        risk_runtime.write_review_binding(
            binding_path, candidate_sha=plan["candidate"]["candidate_sha"],
            policy_identity=plan["policy_identity"], reviewer=reviewer,
            predecessor_receipt=predecessor_receipt,
        )
        branch = task_runtime.git(controller, "symbolic-ref", "-q", "HEAD")
        command = risk_runtime.reviewer_command(
            Path(__file__).resolve().parent, controller_root=controller,
            controller_branch=branch, candidate_root=candidate_root,
            candidate_sha=plan["candidate"]["candidate_sha"], prompt_file=prompt,
            out_dir=run_root, reviewer=reviewer, task_id=task_id,
            review_binding_path=binding_path,
        )
        result = subprocess.run(command, cwd=controller, stdin=subprocess.DEVNULL,
                                text=True, capture_output=True)
        if result.returncode:
            raise MergeQueueError(
                f"managed {reviewer} failed: {(result.stderr or result.stdout)[-512:]}"
            )
        payload = json.loads(result.stdout)
        receipt = Path(payload["receipt"]).resolve()
        return {"runner_receipt_path": str(receipt),
                "runner_receipt_sha256": hashlib.sha256(receipt.read_bytes()).hexdigest()}
    except (risk_runtime.RiskPolicyError, OSError, KeyError, json.JSONDecodeError) as exc:
        raise MergeQueueError(f"managed {reviewer} evidence failed: {exc}") from exc


def managed_review_prompt(controller: Path) -> Path:
    """Resolve review guidance without materializing it in a sparse controller."""
    legacy = controller / ".juno_task/prompts/review_commit_parallel_runner.md"
    if legacy.is_file():
        return legacy.resolve()

    identity_path = controller / ".juno_task/runtime/identity.json"
    try:
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        executable = Path(identity["executable"]).expanduser().resolve()
        expected_sha = identity["executable_sha256"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise MergeQueueError("managed review prompt runtime identity is missing or invalid") from exc
    if not executable.is_file() or not isinstance(expected_sha, str):
        raise MergeQueueError("managed review prompt runtime identity is missing or invalid")
    if hashlib.sha256(executable.read_bytes()).hexdigest() != expected_sha:
        raise MergeQueueError("managed review prompt runtime executable hash drifted")

    prompt = executable.parent.parent / "templates/prompts/review_commit_parallel_runner.md"
    if not prompt.is_file():
        raise MergeQueueError("managed review prompt is missing from the installed runtime")
    return prompt.resolve()


def bounded_json_reference(reference: dict[str, Any], limit: int, label: str) -> dict[str, Any]:
    if (not isinstance(reference, dict)
            or set(reference) not in ({"path", "sha256"}, {"path", "sha256", "bytes"})):
        raise MergeQueueError(f"{label} reference is malformed")
    path = Path(str(reference["path"])).resolve()
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise MergeQueueError(f"{label} is missing") from exc
    if (not data or len(data) > limit or hashlib.sha256(data).hexdigest() != reference["sha256"]
            or ("bytes" in reference and reference["bytes"] != len(data))):
        raise MergeQueueError(f"{label} identity is invalid")
    try:
        value = json.loads(data)
    except json.JSONDecodeError as exc:
        raise MergeQueueError(f"{label} is not JSON") from exc
    if not isinstance(value, dict):
        raise MergeQueueError(f"{label} must be one object")
    return value


def prior_findings_summary(controller: Path, record: dict[str, Any],
                           plan: dict[str, Any]) -> tuple[str, str]:
    evidence_root = controller / ".juno_task/runtime/merge-queue/evidence" / record["task_id"]
    explicit_sha = record.get("prior_findings_candidate_sha")
    if explicit_sha is not None and not isinstance(explicit_sha, str):
        raise MergeQueueError("prior review findings candidate identity is malformed")
    prior_sha = explicit_sha
    paths = sorted(evidence_root.glob(f"{prior_sha}.attempt-*.json")) if prior_sha else []
    if explicit_sha and not paths:
        raise MergeQueueError("prior review findings evidence is missing")
    if not paths:
        legacy_sha = record.get("reopened_from_candidate_sha")
        legacy_paths = (sorted(evidence_root.glob(f"{legacy_sha}.attempt-*.json"))
                        if isinstance(legacy_sha, str) else [])
        candidates: list[tuple[str, str, list[Path]]] = []
        grouped: dict[str, list[Path]] = {}
        for evidence_path in evidence_root.glob("*.attempt-*.json"):
            grouped.setdefault(evidence_path.name.split(".attempt-", 1)[0], []).append(evidence_path)
        limit = plan["evidence_limits"]["max_receipt_bytes"]
        for candidate_sha, candidate_paths in grouped.items():
            newest = ""
            has_findings = False
            valid = True
            for evidence_path in sorted(candidate_paths):
                data = evidence_path.read_bytes()
                if not data or len(data) > limit:
                    valid = False
                    break
                evidence = json.loads(data)
                candidate = evidence.get("candidate", {})
                if (candidate.get("candidate_sha") != candidate_sha
                        or candidate.get("base_sha") != plan["candidate"]["base_sha"]
                        or candidate.get("target_ref") != plan["candidate"]["target_ref"]):
                    valid = False
                    break
                newest = max(newest, str(evidence.get("created_at", "")))
                has_findings = has_findings or any(
                    review.get("verdict") == "findings"
                    for review in evidence.get("reviews", []) if isinstance(review, dict)
                )
            if valid and has_findings:
                candidates.append((newest, candidate_sha, sorted(candidate_paths)))
        if candidates:
            legacy_candidates = [row for row in candidates if row[1] == legacy_sha]
            _, prior_sha, paths = max(
                legacy_candidates or candidates, key=lambda row: (row[0], row[1]))
    if not prior_sha or not paths:
        return ("No prior reviewed candidate is bound to this exact queue record.",
                "queue-state:none")
    summaries: list[str] = []
    evidence_refs: list[str] = []
    limit = plan["evidence_limits"]["max_receipt_bytes"]
    for evidence_path in paths:
        data = evidence_path.read_bytes()
        if not data or len(data) > limit:
            raise MergeQueueError("prior review evidence exceeds its bound")
        evidence = json.loads(data)
        if evidence.get("candidate", {}).get("candidate_sha") != prior_sha:
            raise MergeQueueError("prior review evidence candidate identity drifted")
        evidence_refs.append(
            f"{evidence_path.resolve()} sha256={hashlib.sha256(data).hexdigest()}"
        )
        for review in evidence.get("reviews", []):
            managed = review.get("managed_runner", {})
            runner = bounded_json_reference(
                {"path": managed.get("receipt_path"), "sha256": managed.get("receipt_sha256")},
                limit, "prior managed reviewer receipt",
            )
            response = bounded_json_reference(
                runner.get("artifacts", {}).get("response", {}), limit,
                "prior managed reviewer response",
            )
            for finding in response.get("findings", []):
                if not isinstance(finding, dict):
                    raise MergeQueueError("prior reviewer finding is malformed")
                summaries.append(
                    f"- {finding.get('code', 'UNKNOWN')} [{finding.get('severity', 'unknown')}]: "
                    f"{finding.get('summary', '')}"
                )
    if not summaries:
        summaries.append("- The immediate prior candidate had no recorded blocking finding text.")
    return (f"Immediate prior candidate: {prior_sha}\n" + "\n".join(summaries),
            "; ".join(evidence_refs))


def render_review_template(template: str, fields: dict[str, str]) -> str:
    names = set(REVIEW_PLACEHOLDER_RE.findall(template))
    if names != REVIEW_PROMPT_FIELDS or set(fields) != REVIEW_PROMPT_FIELDS:
        missing = sorted(REVIEW_PROMPT_FIELDS - names)
        unknown = sorted(names - REVIEW_PROMPT_FIELDS)
        raise MergeQueueError(
            f"managed review prompt placeholder contract drifted; missing={missing} unknown={unknown}"
        )
    rendered = REVIEW_PLACEHOLDER_RE.sub(lambda match: fields[match.group(1)], template)
    for name in REVIEW_PROMPT_FIELDS:
        if re.search(r"{{\s*" + re.escape(name) + r"\s*}}", rendered):
            raise MergeQueueError(f"managed review prompt retained placeholder {name}")
    return rendered


def render_managed_review_prompt(controller: Path, candidate_root: Path,
                                 plan: dict[str, Any], task_id: str,
                                 reviewer: str, sequence: int,
                                 output_path: Path) -> Path:
    template_path = managed_review_prompt(controller)
    template_data = template_path.read_bytes()
    if not template_data or len(template_data) > 65536:
        raise MergeQueueError("managed review prompt template is empty or unbounded")
    with task_runtime.state_lock(controller):
        record = task_runtime.read_state(controller)["tasks"].get(task_id)
    attempt = record.get("queue_attempt") if isinstance(record, dict) else None
    stored = attempt.get("risk") if isinstance(attempt, dict) else None
    if (not isinstance(record, dict) or record.get("state") != "AWAITING_RISK"
            or not isinstance(attempt, dict) or not isinstance(stored, dict)
            or attempt.get("candidate_sha") != plan["candidate"]["candidate_sha"]
            or stored.get("plan") != plan):
        raise MergeQueueError("review prompt queue binding changed before dispatch")
    task_path = task_runtime.task_file(controller, task_id).resolve()
    task_data = task_path.read_bytes()
    if not task_data or len(task_data) > 65536:
        raise MergeQueueError("canonical review task is empty or unbounded")
    progress = stored.get("review_progress", {})
    admission = progress.get("full_suite_admission") if isinstance(progress, dict) else None
    receipt = admission.get("receipt") if isinstance(admission, dict) else None
    if plan["full_suite_required"]:
        if not isinstance(receipt, dict) or set(receipt) != {"receipt_path", "receipt_sha256"}:
            raise MergeQueueError("review prompt full-suite evidence is missing")
        receipt_path = Path(receipt["receipt_path"]).resolve()
        receipt_data = receipt_path.read_bytes()
        if hashlib.sha256(receipt_data).hexdigest() != receipt["receipt_sha256"]:
            raise MergeQueueError("review prompt full-suite evidence identity drifted")
        validation_path = f"{receipt_path} sha256={receipt['receipt_sha256']}"
    else:
        validation_path = "queue-state: affected validation embedded below"
    findings_summary, findings_path = prior_findings_summary(controller, record, plan)
    validation_bundle = canonical({
        "affected_validation": attempt.get("validation", []),
        "full_suite_admission": admission,
    })
    requirements = (
        f"Canonical Kanban task ({task_path}, sha256={hashlib.sha256(task_data).hexdigest()}):\n\n"
        + task_data.decode("utf-8")
        + "\n\nQueue-bound risk plan:\n\n" + canonical(plan)
        + "\n\nQueue-bound validation summary:\n\n" + validation_bundle
    )
    fields = {
        "task_id": task_id,
        "review_kind": f"merge-queue-{plan['tier']}-risk",
        "reviewer_index": f"{sequence}:{reviewer}",
        "repository": str(candidate_root.resolve()),
        "base_sha": plan["candidate"]["base_sha"],
        "tip_sha": plan["candidate"]["candidate_sha"],
        "checklist_path": f"{task_path} sha256={hashlib.sha256(task_data).hexdigest()}",
        "findings_summary_path": findings_path,
        "validation_evidence_path": validation_path,
        "requirements_bundle": requirements,
        "findings_summary": findings_summary,
    }
    try:
        rendered = render_review_template(template_data.decode("utf-8"), fields).encode()
    except UnicodeDecodeError as exc:
        raise MergeQueueError("managed review prompt template is not UTF-8") from exc
    if not rendered or len(rendered) > 524288:
        raise MergeQueueError("rendered managed review prompt is empty or unbounded")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise MergeQueueError(f"rendered review prompt already exists: {output_path}") from exc
    with os.fdopen(fd, "wb") as handle:
        handle.write(rendered); handle.flush(); os.fsync(handle.fileno())
    return output_path.resolve()


def full_validation_identity(controller: Path, config: dict[str, Any],
                             record: dict[str, Any], candidate_root: Path,
                             candidate_sha: str) -> dict[str, Any]:
    policy_path = controller / ".juno_task/config/task-workspace.json"
    try:
        policy_bytes = policy_path.read_bytes()
    except OSError as exc:
        raise MergeQueueError("task-workspace policy is missing during review") from exc
    if not policy_bytes or len(policy_bytes) > 65536:
        raise MergeQueueError("task-workspace policy bytes are empty or unbounded")
    recorded = record.get("validation")
    if not isinstance(recorded, list) or len(recorded) != len(config["focused_validation"]):
        raise MergeQueueError("task record validation command evidence is missing")
    command_projection = []
    for row in recorded:
        if (not isinstance(row, dict) or not isinstance(row.get("id"), str)
                or not isinstance(row.get("argv"), list)
                or not isinstance(row.get("timeout_seconds"), int)):
            raise MergeQueueError("task record validation command evidence is malformed")
        command_projection.append({"id": row["id"], "argv": row["argv"],
                                   "timeout_seconds": row["timeout_seconds"]})
    commands = canonical(command_projection).encode()
    full_config = canonical(config["full_suite_validation"]).encode()
    if len(commands) > 65536 or len(full_config) > 65536:
        raise MergeQueueError("validation identity projection is unbounded")
    return {"task_workspace_config_sha256": hashlib.sha256(policy_bytes).hexdigest(),
            "full_suite_config_sha256": hashlib.sha256(full_config).hexdigest(),
            "task_validation_commands_sha256": hashlib.sha256(commands).hexdigest()}


def full_suite_attempt_paths(controller: Path, task_id: str, candidate_sha: str,
                             attempt_number: int) -> tuple[Path, Path]:
    root = (controller / ".juno_task/state/merge-queue/full-suite" / task_id
            / candidate_sha / f"attempt-{attempt_number}").resolve()
    return root / "claim.json", root / "receipt.json"


def create_full_suite_claim(controller: Path, task_id: str, plan: dict[str, Any],
                            identity: dict[str, str], command: dict[str, Any],
                            attempt_number: int) -> dict[str, Any]:
    claim_path, receipt_path = full_suite_attempt_paths(
        controller, task_id, plan["candidate"]["candidate_sha"], attempt_number)
    if claim_path.exists() or receipt_path.exists():
        raise MergeQueueError("queue admission canonical path already exists")
    token = secrets.token_hex(24)
    claim = {"schema_version": risk_runtime.FULL_SUITE_CLAIM_SCHEMA,
             "producer": {"schema_version": risk_runtime.FULL_SUITE_PRODUCER_SCHEMA,
                          "tool_id": risk_runtime.FULL_SUITE_TOOL_ID},
             "task_id": task_id,
             "candidate": {"candidate_sha": plan["candidate"]["candidate_sha"],
                           "candidate_tree": plan["candidate"]["candidate_tree"]},
             "policy_identity": plan["policy_identity"],
             "validation_identity": identity, "command": command,
             "token": token, "attempt_number": attempt_number,
             "expected_receipt_path": str(receipt_path)}
    write_canonical_exclusive(claim_path, claim,
                              plan["evidence_limits"]["max_receipt_bytes"])
    if receipt_path.exists():
        raise MergeQueueError("queue admission receipt path collided before suite execution")
    claim_ref = {"claim_path": str(claim_path),
                 "claim_sha256": hashlib.sha256(claim_path.read_bytes()).hexdigest()}
    return {"schema_version": risk_runtime.FULL_SUITE_ADMISSION_SCHEMA,
            "state": "CLAIMED", "attempt_number": attempt_number, "token": token,
            "claim": claim_ref, "expected_receipt_path": str(receipt_path)}


def persist_full_suite_claim(controller: Path, attempt: dict[str, Any],
                             suite_attempt_number: int,
                             create: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Create the exclusive claim and admit it in one brief state-lock section."""
    with task_runtime.state_lock(controller):
        state = task_runtime.read_state(controller)
        current = state["tasks"].get(attempt["task_id"])
        current_attempt = current.get("queue_attempt") if isinstance(current, dict) else None
        if (not isinstance(current_attempt, dict)
                or current.get("tip_sha") != attempt["feature_sha"]
                or any(current_attempt.get(key) != attempt.get(key) for key in
                       ("task_id", "feature_sha", "candidate_sha", "expected_target_sha"))):
            raise MergeQueueError("task review claim changed before full-suite admission")
        try:
            claimed = create()
        except MergeQueueError as exc:
            if "exists" not in str(exc) and "collided" not in str(exc):
                raise
            stored = {**attempt["risk"], "review_progress": {
                **attempt["risk"]["review_progress"],
                "collision_floor": suite_attempt_number}}
            updated = {**attempt, "risk": stored, "review": stored}
            state["tasks"][attempt["task_id"]] = {
                **current, "state": "AWAITING_RISK", "queue_attempt": updated,
                "last_queue_outcome": "FULL_SUITE_CLAIM_COLLISION"}
            config = task_runtime.load_config(controller)
            repository = task_runtime.product_repository(controller, config)
            target_entry(state, repository, config["target_ref"])["last_attempt"] = updated
            task_runtime.write_state(controller, state)
            raise
        stored = {**attempt["risk"], "review_progress": {
            **attempt["risk"]["review_progress"], "attempt_counter": suite_attempt_number,
            "full_suite_admission": claimed}}
        updated = {**attempt, "risk": stored, "review": stored, "outcome": "REVIEWING"}
        state["tasks"][attempt["task_id"]] = {
            **current, "state": "AWAITING_RISK", "queue_attempt": updated,
            "last_queue_outcome": updated["outcome"]}
        config = task_runtime.load_config(controller)
        repository = task_runtime.product_repository(controller, config)
        target_entry(state, repository, config["target_ref"])["last_attempt"] = updated
        task_runtime.write_state(controller, state)
    return claimed, updated


def verify_queue_claimed_admission(controller: Path, task_id: str, plan: dict[str, Any],
                                    identity: dict[str, str], command: dict[str, Any],
                                    admission: Any) -> dict[str, Any]:
    keys = {"schema_version", "state", "attempt_number", "token", "claim",
            "expected_receipt_path"}
    if (not isinstance(admission, dict) or set(admission) != keys
            or admission.get("schema_version") != risk_runtime.FULL_SUITE_ADMISSION_SCHEMA
            or admission.get("state") != "CLAIMED"
            or not isinstance(admission.get("attempt_number"), int)
            or isinstance(admission.get("attempt_number"), bool)
            or admission["attempt_number"] <= 0
            or not isinstance(admission.get("token"), str)
            or len(admission["token"]) != 48
            or not isinstance(admission.get("claim"), dict)
            or set(admission["claim"]) != {"claim_path", "claim_sha256"}):
        raise MergeQueueError("stored CLAIMED full-suite admission is malformed")
    claim_path, receipt_path = full_suite_attempt_paths(
        controller, task_id, plan["candidate"]["candidate_sha"], admission["attempt_number"])
    if (admission["claim"].get("claim_path") != str(claim_path)
            or admission.get("expected_receipt_path") != str(receipt_path)):
        raise MergeQueueError("stored CLAIMED full-suite admission is not canonical")
    try:
        claim = risk_runtime._bounded_object(
            admission["claim"]["claim_path"], admission["claim"]["claim_sha256"],
            plan, "full-suite claim")
    except risk_runtime.RiskPolicyError as exc:
        raise MergeQueueError(f"stored CLAIMED full-suite admission refused: {exc}") from exc
    expected = {"schema_version": risk_runtime.FULL_SUITE_CLAIM_SCHEMA,
                "producer": {"schema_version": risk_runtime.FULL_SUITE_PRODUCER_SCHEMA,
                             "tool_id": risk_runtime.FULL_SUITE_TOOL_ID},
                "task_id": task_id,
                "candidate": {"candidate_sha": plan["candidate"]["candidate_sha"],
                              "candidate_tree": plan["candidate"]["candidate_tree"]},
                "policy_identity": plan["policy_identity"],
                "validation_identity": identity, "command": command,
                "token": admission["token"], "attempt_number": admission["attempt_number"],
                "expected_receipt_path": str(receipt_path)}
    if claim != expected:
        raise MergeQueueError("stored CLAIMED full-suite claim identity drifted")
    return {**admission, "claim": {"claim_path": str(claim_path),
                                    "claim_sha256": admission["claim"]["claim_sha256"]},
            "expected_receipt_path": str(receipt_path)}


def verify_queue_full_suite_admission(controller: Path, task_id: str, plan: dict[str, Any],
                                      identity: dict[str, str], command: dict[str, Any],
                                      admission: Any) -> dict[str, Any]:
    if not isinstance(admission, dict) or admission.get("state") != "COMPLETE":
        raise MergeQueueError("full-suite admission is not complete")
    attempt_number = admission.get("attempt_number")
    if not isinstance(attempt_number, int) or isinstance(attempt_number, bool):
        raise MergeQueueError("full-suite admission attempt is invalid")
    claim_path, receipt_path = full_suite_attempt_paths(
        controller, task_id, plan["candidate"]["candidate_sha"], attempt_number)
    state_root = (controller / ".juno_task/state/merge-queue/full-suite").resolve()
    for path in (claim_path, receipt_path):
        try: path.resolve().relative_to(state_root)
        except ValueError as exc: raise MergeQueueError("full-suite admission escaped controller state") from exc
    if (admission.get("claim", {}).get("claim_path") != str(claim_path)
            or admission.get("receipt", {}).get("receipt_path") != str(receipt_path)):
        raise MergeQueueError("full-suite admission is not at its canonical queue-owned path")
    try:
        return risk_runtime.verify_full_suite_admission(
            admission, plan, identity, command)
    except risk_runtime.RiskPolicyError as exc:
        raise MergeQueueError(f"full-suite admission refused: {exc}") from exc


def failed_full_suite_admission(controller: Path, task_id: str, plan: dict[str, Any],
                                identity: dict[str, str], command: dict[str, Any],
                                claimed: dict[str, Any],
                                receipt_reference: dict[str, str]) -> dict[str, Any]:
    attempt_number = claimed.get("attempt_number")
    claim_path, receipt_path = full_suite_attempt_paths(
        controller, task_id, plan["candidate"]["candidate_sha"], attempt_number)
    if (claimed.get("claim", {}).get("claim_path") != str(claim_path)
            or claimed.get("expected_receipt_path") != str(receipt_path)
            or receipt_reference.get("receipt_path") != str(receipt_path)):
        raise MergeQueueError("failed full-suite admission is not at its canonical path")
    complete = {"schema_version": risk_runtime.FULL_SUITE_ADMISSION_SCHEMA,
                "state": "COMPLETE", "attempt_number": attempt_number,
                "token": claimed.get("token"), "claim": claimed.get("claim"),
                "receipt": receipt_reference}
    try:
        risk_runtime.verify_full_suite_admission(
            complete, plan, identity, command, False)
    except risk_runtime.RiskPolicyError as exc:
        raise MergeQueueError(f"failed full-suite receipt refused: {exc}") from exc
    receipt = json.loads(receipt_path.read_text())
    result = receipt["result"]
    if not result["timed_out"] and result["exit_code"] == 0:
        raise MergeQueueError("successful full-suite receipt cannot enter FAILED admission")
    failure = {"exit_code": result["exit_code"], "timed_out": result["timed_out"],
               "stdout_tail": result["stdout"]["tail"],
               "stderr_tail": result["stderr"]["tail"]}
    return {"schema_version": risk_runtime.FULL_SUITE_ADMISSION_SCHEMA,
            "state": "FAILED", "attempt_number": attempt_number,
            "token": claimed["token"], "claim": claimed["claim"],
            "receipt": receipt_reference, "failure": failure}


def verify_queue_failed_admission(controller: Path, task_id: str, plan: dict[str, Any],
                                   identity: dict[str, str], command: dict[str, Any],
                                   admission: Any) -> dict[str, Any]:
    keys = {"schema_version", "state", "attempt_number", "token", "claim",
            "receipt", "failure"}
    if (not isinstance(admission, dict) or set(admission) != keys
            or admission.get("schema_version") != risk_runtime.FULL_SUITE_ADMISSION_SCHEMA
            or admission.get("state") != "FAILED"):
        raise MergeQueueError("stored FAILED full-suite admission is malformed")
    attempt_number = admission.get("attempt_number")
    _, receipt_path = full_suite_attempt_paths(
        controller, task_id, plan["candidate"]["candidate_sha"], attempt_number)
    try:
        historical_claim = risk_runtime._bounded_object(
            admission.get("claim", {}).get("claim_path"),
            admission.get("claim", {}).get("claim_sha256"), plan, "failed full-suite claim")
        historical_identity = historical_claim["validation_identity"]
        historical_command = historical_claim["command"]
    except (risk_runtime.RiskPolicyError, KeyError, TypeError) as exc:
        raise MergeQueueError(f"stored FAILED full-suite claim refused: {exc}") from exc
    claimed = {"schema_version": risk_runtime.FULL_SUITE_ADMISSION_SCHEMA,
               "state": "CLAIMED", "attempt_number": attempt_number,
               "token": admission.get("token"), "claim": admission.get("claim"),
               "expected_receipt_path": str(receipt_path)}
    verify_queue_claimed_admission(
        controller, task_id, plan, historical_identity, historical_command, claimed)
    rebuilt = failed_full_suite_admission(
        controller, task_id, plan, historical_identity, historical_command,
        claimed, admission.get("receipt"))
    if rebuilt != admission:
        raise MergeQueueError("stored FAILED full-suite admission projection drifted")
    return rebuilt


def recover_claimed_full_suite(controller: Path, task_id: str, plan: dict[str, Any],
                               identity: dict[str, str], command: dict[str, Any],
                               admission: Any) -> Optional[dict[str, Any]]:
    admission = verify_queue_claimed_admission(
        controller, task_id, plan, identity, command, admission)
    attempt_number = admission["attempt_number"]
    claim_path, receipt_path = full_suite_attempt_paths(
        controller, task_id, plan["candidate"]["candidate_sha"], attempt_number)
    if (admission.get("claim", {}).get("claim_path") != str(claim_path)
            or admission.get("expected_receipt_path") != str(receipt_path)):
        raise MergeQueueError("stored CLAIMED full-suite admission path drifted")
    if not receipt_path.exists():
        return admission
    complete = {"schema_version": risk_runtime.FULL_SUITE_ADMISSION_SCHEMA,
                "state": "COMPLETE", "attempt_number": attempt_number,
                "token": admission.get("token"), "claim": admission.get("claim"),
                "receipt": evidence_reference(receipt_path)}
    try:
        return verify_queue_full_suite_admission(
            controller, task_id, plan, identity, command, complete)
    except MergeQueueError as success_error:
        try:
            return failed_full_suite_admission(
                controller, task_id, plan, identity, command, admission,
                complete["receipt"])
        except MergeQueueError:
            raise success_error


def review_target_checkpoint(controller: Path, config: dict[str, Any], repository: Path,
                             task_id: str, candidate_sha: str,
                             expected_target_sha: str) -> Optional[dict[str, Any]]:
    """Briefly validate the review claim and stop spending tokens after target movement."""
    with target_lock(controller, repository, config["target_ref"]):
        with task_runtime.state_lock(controller):
            record = task_runtime.read_state(controller)["tasks"].get(task_id)
        if not isinstance(record, dict) or record.get("state") != "AWAITING_RISK":
            raise MergeQueueError("review claim state changed while semantic review was active")
        attempt = record.get("queue_attempt")
        if (not isinstance(attempt, dict) or attempt.get("candidate_sha") != candidate_sha
                or attempt.get("expected_target_sha") != expected_target_sha):
            raise MergeQueueError("review claim candidate identity changed")
        current = task_runtime.ref_sha(repository, config["target_ref"])
    if current != expected_target_sha:
        return requeue_stale_candidate(controller, config, repository, record, current)
    return None


def merge_review(controller: Path, task_id: str) -> dict[str, Any]:
    if not task_runtime.TASK_RE.fullmatch(task_id):
        raise MergeQueueError("unsafe task id")
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    with review_lock(repository, task_id):
        with task_runtime.state_lock(controller):
            record = task_runtime.read_state(controller)["tasks"].get(task_id)
        if not isinstance(record, dict) or record.get("state") not in {
                "AWAITING_RISK", "AWAITING_RELEASE", "REQUEUING_STALE"}:
            raise MergeQueueError("task has no frozen candidate awaiting risk evidence")
        if record.get("state") == "REQUEUING_STALE":
            return requeue_stale_candidate(
                controller, config, repository, record,
                task_runtime.ref_sha(repository, config["target_ref"]))
        attempt = record.get("queue_attempt")
        if not isinstance(attempt, dict):
            raise MergeQueueError("awaiting task has no queue attempt")
        if record["state"] == "AWAITING_RELEASE":
            raise MergeQueueError("release candidate requires separate owner-authorized release gate evidence")
        candidate_sha, expected = attempt.get("candidate_sha"), attempt.get("expected_target_sha")
        if task_runtime.ref_sha(repository, config["target_ref"]) != expected:
            return requeue_stale_candidate(
                controller, config, repository, record,
                task_runtime.ref_sha(repository, config["target_ref"]))
        checkout_value = attempt.get("candidate_checkout")
        candidate_root = (task_runtime.exact_root(Path(checkout_value), "review candidate")
                          if checkout_value else validate_record(config, repository, record))
        assert_frozen_candidate(controller, config, candidate_root, candidate_sha)
        claimed: Optional[dict[str, Any]] = None
        try:
            policy = risk_runtime.load_policy(risk_policy_path(controller))
            request = risk_request(repository, candidate_sha, config["target_ref"], expected)
            plan = risk_runtime.classify(policy, request, risk_flags(record))
            stored = attempt.get("risk")
            if (not isinstance(stored, dict) or stored.get("candidate_sha") != candidate_sha
                    or stored.get("policy_identity") != plan["policy_identity"]
                    or stored.get("plan") != plan):
                raise MergeQueueError("stored awaiting-risk plan does not match fresh Git policy")
            if plan["release_gate_required"]:
                raise MergeQueueError("release candidate cannot use semantic review as release authority")
            progress = stored.get("review_progress")
            if progress is None:
                progress = {"schema_version": "juno_merge_queue_review_progress.v4",
                            "attempt_counter": 0, "review_attempt_counter": 0,
                            "collision_floor": 0,
                            "full_suite_admission": None,
                            "steps": []}
            if isinstance(progress, dict) and progress.get("schema_version") in {
                    "juno_merge_queue_review_progress.v2", "juno_merge_queue_review_progress.v3"}:
                progress = {"schema_version": "juno_merge_queue_review_progress.v4",
                            "attempt_counter": progress.get("attempt_counter"),
                            "review_attempt_counter": progress.get("attempt_counter"),
                            "collision_floor": 0,
                            "full_suite_admission": None, "steps": progress.get("steps")}
            allowed_progress = {"schema_version", "attempt_counter", "review_attempt_counter",
                                "collision_floor",
                                "full_suite_admission", "steps",
                                "full_validation_passed", "validation_identity"}
            if (not isinstance(progress, dict) or not set(progress).issubset(allowed_progress)
                    or not {"schema_version", "attempt_counter", "review_attempt_counter",
                            "collision_floor", "full_suite_admission", "steps"}.issubset(progress)
                    or progress.get("schema_version") != "juno_merge_queue_review_progress.v4"
                    or not isinstance(progress.get("attempt_counter"), int)
                    or isinstance(progress.get("attempt_counter"), bool)
                    or not 0 <= progress["attempt_counter"] <= 10000
                    or not isinstance(progress.get("review_attempt_counter"), int)
                    or isinstance(progress.get("review_attempt_counter"), bool)
                    or not 0 <= progress["review_attempt_counter"] <= 10000
                    or not isinstance(progress.get("collision_floor"), int)
                    or isinstance(progress.get("collision_floor"), bool)
                    or not 0 <= progress["collision_floor"] <= 10000
                    or (progress.get("full_suite_admission") is not None
                        and not isinstance(progress.get("full_suite_admission"), dict))
                    or not isinstance(progress.get("steps"), list)):
                raise MergeQueueError("stored reviewer continuation is malformed")
            # Deprecated booleans/projections are explicitly non-authoritative.
            progress = {key: progress[key] for key in
                        ("schema_version", "attempt_counter", "review_attempt_counter",
                         "collision_floor", "full_suite_admission", "steps")}
            current_validation_identity = full_validation_identity(
                controller, config, record, candidate_root, candidate_sha)
            stored = {**stored, "review_progress": progress}
            attempt = {**attempt, "risk": stored, "review": stored}
            suite_admission = None
            prior_attempt = max(progress["attempt_counter"], progress["collision_floor"])
            existing_admission = progress["full_suite_admission"]
            if existing_admission is not None:
                admission_state = existing_admission.get("state")
                if (not isinstance(admission_state, str)
                        or admission_state not in {"COMPLETE", "FAILED", "CLAIMED"}):
                    raise AdmissionStateError(
                        "stored full-suite admission state is malformed or unsupported")
            if plan["full_suite_required"] and existing_admission is not None:
                if admission_state == "COMPLETE":
                    try:
                        suite_admission = verify_queue_full_suite_admission(
                            controller, task_id, plan, current_validation_identity,
                            full_suite_command(config), existing_admission)
                    except MergeQueueError:
                        suite_admission = None
                elif admission_state == "FAILED":
                    verified_failed = verify_queue_failed_admission(
                        controller, task_id, plan, current_validation_identity,
                        full_suite_command(config), existing_admission)
                    prior_attempt = max(prior_attempt, verified_failed["attempt_number"])
                    progress = {**progress, "full_suite_admission": verified_failed}
                    stored = {**stored, "review_progress": progress}
                    attempt = {**attempt, "risk": stored, "review": stored}
                elif admission_state == "CLAIMED":
                    recovered = recover_claimed_full_suite(
                        controller, task_id, plan, current_validation_identity,
                        full_suite_command(config), existing_admission)
                    prior_attempt = max(prior_attempt, recovered["attempt_number"])
                    if recovered["state"] == "COMPLETE":
                        suite_admission = recovered
                        progress = {**progress, "full_suite_admission": recovered}
                        stored = {**stored, "review_progress": progress}
                        attempt = {**attempt, "risk": stored, "review": stored}
                        persist_attempt(controller, attempt, state_name="AWAITING_RISK")
                    elif recovered["state"] == "FAILED":
                        progress = {**progress, "full_suite_admission": recovered,
                                    "attempt_counter": prior_attempt}
                        stored = {**stored, "review_progress": progress}
                        attempt = {**attempt, "risk": stored, "review": stored}
                        persist_attempt(controller, attempt, state_name="AWAITING_RISK")
                        failure = recovered["failure"]
                        detail = failure["stderr_tail"] or failure["stdout_tail"]
                        raise MergeValidationError(
                            f"recovered full-suite attempt failed: {detail}", [failure],
                            recovered["receipt"])
                    else:
                        claimed = recovered
            if plan["full_suite_required"] and suite_admission is None and claimed is None:
                if prior_attempt >= 10000:
                    raise MergeQueueError("bounded full-suite attempt namespace is exhausted")
                suite_attempt_number = prior_attempt + 1
                claimed, attempt = persist_full_suite_claim(
                    controller, attempt, suite_attempt_number,
                    lambda: create_full_suite_claim(
                        controller, task_id, plan, current_validation_identity,
                        full_suite_command(config), suite_attempt_number))
                stored = attempt["risk"]
                progress = stored["review_progress"]
            if plan["full_suite_required"] and suite_admission is None:
                claim_binding = {"claim_path": claimed["claim"]["claim_path"],
                                 "claim_sha256": claimed["claim"]["claim_sha256"],
                                 "token": claimed["token"],
                                 "attempt_number": claimed["attempt_number"]}
                receipt_path = Path(claimed["expected_receipt_path"])
                suite_reference = full_suite_validation(
                    config, candidate_root, plan, current_validation_identity,
                    receipt_path, claim_binding,
                    task_runtime.exact_root(
                        Path(record["worktree"]), "review feature worktree"))
                after_validation_identity = full_validation_identity(
                    controller, task_runtime.load_config(controller), record,
                    candidate_root, candidate_sha)
                if after_validation_identity != current_validation_identity:
                    raise MergeQueueError("validation identity changed during full validation")
                complete = {"schema_version": risk_runtime.FULL_SUITE_ADMISSION_SCHEMA,
                            "state": "COMPLETE", "attempt_number": claimed["attempt_number"],
                            "token": claimed["token"], "claim": claimed["claim"],
                            "receipt": suite_reference}
                suite_admission = verify_queue_full_suite_admission(
                    controller, task_id, plan, current_validation_identity,
                    full_suite_command(config), complete)
                progress = {**progress, "full_suite_admission": suite_admission}
                stored = {**stored, "review_progress": progress}
                attempt = {**attempt, "risk": stored, "review": stored}
                persist_attempt(controller, attempt, state_name="AWAITING_RISK")
            stale = review_target_checkpoint(
                controller, config, repository, task_id, candidate_sha, expected)
            if stale is not None:
                return stale
            if progress["review_attempt_counter"] >= 10000:
                raise MergeQueueError("bounded reviewer attempt namespace is exhausted")
            review_attempt_number = progress["review_attempt_counter"] + 1
            progress = {**progress, "review_attempt_counter": review_attempt_number}
            stored = {**stored, "review_progress": progress}
            attempt = {**attempt, "risk": stored, "review": stored, "outcome": "REVIEWING"}
            persist_attempt(controller, attempt, state_name="AWAITING_RISK")
            reviews: list[dict[str, str]] = []
            predecessor: Optional[Path] = None
            steps = progress["steps"]
            if len(steps) > len(plan["reviewer_sequence"]):
                raise MergeQueueError("stored reviewer continuation exceeds the policy sequence")
            for index, step in enumerate(steps):
                reviewer = plan["reviewer_sequence"][index]
                sequence = index + 1
                if (not isinstance(step, dict) or set(step) != {
                        "sequence", "reviewer", "reference", "verified"}
                        or step.get("sequence") != sequence or step.get("reviewer") != reviewer):
                    raise MergeQueueError("stored reviewer continuation order is invalid")
                compact = risk_runtime._compact_review(
                    step.get("reference"), reviewer, sequence, candidate_sha,
                    plan["policy_identity"], plan,
                )
                if compact != step.get("verified") or compact["verdict"] != "pass" \
                        or compact["finding_count"]:
                    raise MergeQueueError("stored reviewer continuation evidence is no longer valid")
                reviews.append(step["reference"])
                predecessor = Path(step["reference"]["runner_receipt_path"])
            for sequence, reviewer in enumerate(
                    plan["reviewer_sequence"][len(reviews):], len(reviews) + 1):
                reference = dispatch_reviewer(
                    controller, candidate_root, plan, task_id, reviewer,
                    sequence, predecessor, review_attempt_number,
                )
                reviews.append(reference)
                predecessor = Path(reference["runner_receipt_path"])
                assert_frozen_candidate(controller, config, candidate_root, candidate_sha)
                compact = risk_runtime._compact_review(  # canonical verifier; no receipt shortcut
                    reference, reviewer, sequence, candidate_sha,
                    plan["policy_identity"], plan,
                )
                if compact["verdict"] != "pass" or compact["finding_count"]:
                    break
                step = {"sequence": sequence, "reviewer": reviewer,
                        "reference": reference, "verified": compact}
                progress = {**progress, "steps": [*progress["steps"], step]}
                stored = {**stored, "review_progress": progress}
                attempt = {**attempt, "risk": stored, "review": stored}
                # A PASS is durable before Reviewer B starts. A transport
                # failure therefore retries only the missing suffix.
                persist_attempt(controller, attempt, state_name="AWAITING_RISK")
                stale = review_target_checkpoint(
                    controller, config, repository, task_id, candidate_sha, expected)
                if stale is not None:
                    return stale
            with target_lock(controller, repository, config["target_ref"]):
                current_target = task_runtime.ref_sha(repository, config["target_ref"])
                if current_target != expected:
                    with task_runtime.state_lock(controller):
                        current_record = task_runtime.read_state(controller)["tasks"].get(task_id)
                    if not isinstance(current_record, dict):
                        raise MergeQueueError("review claim task disappeared before stale cleanup")
                    return requeue_stale_candidate(
                        controller, config, repository, current_record, current_target)
            receipt = risk_runtime.finalize(
                plan, request, affected_tests_passed=True,
                full_suite_admission=suite_admission,
                reviews=reviews,
                metrics={"model_calls": len(reviews), "affected_test_runs": 1,
                         "full_suite_runs": 1 if plan["full_suite_required"] else 0},
                policy=policy,
            )
            path = evidence_path(controller, task_id, candidate_sha, review_attempt_number)
            if path.exists():
                raise MergeQueueError("review evidence attempt path already exists")
            risk_runtime.atomic_receipt(path, receipt, policy)
            reference = evidence_reference(path)
            verified = risk_runtime.verify_candidate_evidence(
                policy, request, risk_flags(record), reference)
        except MergeValidationError as exc:
            if claimed is not None and exc.receipt_reference is not None:
                failed_admission = failed_full_suite_admission(
                    controller, task_id, plan, current_validation_identity,
                    full_suite_command(config), claimed, exc.receipt_reference)
                progress = {**progress, "full_suite_admission": failed_admission}
                stored = {**stored, "review_progress": progress}
                attempt = {**attempt, "risk": stored, "review": stored}
            # Full-suite failure truth lives in the immutable admission receipt.
            # Keep the separately admitted affected-validation rows intact so a
            # later successful retry cannot render superseded failure evidence
            # as the current reviewer input.
            failed = {**attempt, "outcome": "FAILED_FULL_SUITE"}
            persist_attempt(controller, failed, state_name="AWAITING_RISK")
            raise
        except AdmissionStateError:
            raise
        except (risk_runtime.RiskPolicyError, MergeQueueError) as exc:
            if "queue admission canonical path already exists" in str(exc) \
                    or "queue admission receipt path collided" in str(exc):
                raise MergeQueueError(str(exc)) from exc
            failed = {**attempt, "outcome": "REVIEW_FAILED", "risk_failure": str(exc)[:512]}
            persist_attempt(controller, failed, state_name="AWAITING_RISK")
            raise MergeQueueError(str(exc)) from exc
        outcome = "RISK_EVIDENCE_READY" if verified["eligible"] else "REVIEW_FINDINGS"
        risk_state = {**stored, "status": outcome, "evidence": reference}
        updated = {key: value for key, value in attempt.items() if key != "risk_failure"}
        updated.update({"risk": risk_state, "review": risk_state, "outcome": outcome})
        with target_lock(controller, repository, config["target_ref"]):
            with task_runtime.state_lock(controller):
                current_record = task_runtime.read_state(controller)["tasks"].get(task_id)
            current_target = task_runtime.ref_sha(repository, config["target_ref"])
            if current_target != expected:
                if not isinstance(current_record, dict):
                    raise MergeQueueError("review claim task disappeared before stale cleanup")
                return requeue_stale_candidate(
                    controller, config, repository, current_record, current_target)
            persist_attempt(controller, updated, state_name=(
                "AWAITING_RISK" if verified["eligible"] else "REVIEW_FINDINGS"))
        return updated


def merge_reopen(controller: Path, task_id: str) -> dict[str, Any]:
    """Recoverable two-phase requeue after a new validated feature tip."""
    if not task_runtime.TASK_RE.fullmatch(task_id):
        raise MergeQueueError("unsafe task id")
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    with target_lock(controller, repository, config["target_ref"]):
        with task_runtime.state_lock(controller):
            state = task_runtime.read_state(controller)
            record = state["tasks"].get(task_id)
        source_state = record.get("state") if isinstance(record, dict) else None
        failure_outcome = record.get("last_queue_outcome") if isinstance(record, dict) else None
        failed_queue_repair = (
            ((source_state == "AWAITING_RISK"
              and failure_outcome in {"FAILED_FULL_SUITE", "REVIEW_FAILED"})
             or (source_state == "QUEUED" and failure_outcome == "FAILED_TEST"))
            and isinstance(record.get("queue_attempt"), dict)
            and record["queue_attempt"].get("outcome") == failure_outcome
        )
        queued_tip_refresh = (
            source_state == "QUEUED"
            and isinstance(record.get("tip_sha"), str)
            and not failed_queue_repair
        )
        if (source_state not in {"REVIEW_FINDINGS", "REOPENING"}
                and not failed_queue_repair and not queued_tip_refresh):
            raise MergeQueueError("task has no review findings or failed queue repair to reopen")
        if source_state in {"REVIEW_FINDINGS", "AWAITING_RISK", "QUEUED"}:
            old_attempt = record.get("queue_attempt")
            if not isinstance(old_attempt, dict):
                if queued_tip_refresh:
                    old_attempt = {
                        "candidate_sha": record["tip_sha"],
                        "candidate_checkout": None,
                        "candidate_token": None,
                        "outcome": "QUEUED_TIP_REFRESH",
                    }
                else:
                    raise MergeQueueError("review finding task has no frozen queue attempt")
            worktree = task_runtime.exact_root(Path(record["worktree"]), "feature worktree")
            if Path(record["repository"]).resolve() != repository:
                raise MergeQueueError("feature repository identity drifted")
            if task_runtime.git(worktree, "symbolic-ref", "-q", "HEAD", check=False) != record["branch_ref"]:
                raise MergeQueueError("feature worktree branch identity drifted")
            new_tip = task_runtime.git(worktree, "rev-parse", "HEAD")
            if task_runtime.git(repository, "rev-parse", record["branch_ref"], check=False) != new_tip:
                raise MergeQueueError("feature branch tip identity drifted")
            if new_tip == record["tip_sha"]:
                raise MergeQueueError("reopen requires a new committed feature tip")
            if task_runtime.git(worktree, "status", "--porcelain=v1", "--untracked-files=all"):
                raise MergeQueueError("feature worktree must be clean before reopen")
            if task_runtime.run(["git", "-C", str(repository), "merge-base", "--is-ancestor",
                                 record["tip_sha"], new_tip], repository, check=False).returncode:
                raise MergeQueueError("new feature tip must descend from the queued or reviewed tip")
            changed = sorted(set(task_runtime.git(
                worktree, "diff", "--name-only", f"{record['base_sha']}..{new_tip}"
            ).splitlines()))
            forbidden = [path for path in changed
                         if task_runtime.path_within(path, config["controller_private_paths"])]
            outside = [path for path in changed
                       if not task_runtime.path_within(path, config["allowed_paths"])]
            if not changed or forbidden or outside:
                raise MergeQueueError("reopened feature tip has empty or disallowed product changes")
            validations = validation_rows(config, worktree)
            if task_runtime.git(worktree, "rev-parse", "HEAD") != new_tip \
                    or task_runtime.git(worktree, "status", "--porcelain=v1", "--untracked-files=all"):
                raise MergeQueueError("feature tip changed during reopen validation")
            checkout_value, token = old_attempt.get("candidate_checkout"), old_attempt.get("candidate_token")
            owner = (read_candidate_owner(controller, Path(checkout_value))
                     if checkout_value else None)
            policy_bytes = (controller / ".juno_task/config/task-workspace.json").read_bytes()
            reopen_attempt = {
                "schema_version": "juno_merge_queue_reopen.v1",
                "task_id": task_id,
                "old_candidate_sha": old_attempt["candidate_sha"],
                "old_candidate_checkout": checkout_value,
                "old_candidate_token": token,
                "old_candidate_owner": owner,
                "source_outcome": old_attempt.get("outcome"),
                "new_feature_tip": new_tip,
                "changed_paths": changed,
                "validations": validations,
                "validation_identity": digest({
                    "new_feature_tip": new_tip, "changed_paths": changed,
                    "task_workspace_policy_sha256": hashlib.sha256(policy_bytes).hexdigest(),
                    "focused_validation": config["focused_validation"],
                }),
            }
            reopening = {**record, "state": "REOPENING", "reopen_attempt": reopen_attempt}
            with task_runtime.state_lock(controller):
                state = task_runtime.read_state(controller)
                if state["tasks"].get(task_id) != record:
                    raise MergeQueueError("task state changed before reopen admission")
                state["tasks"][task_id] = reopening
                task_runtime.write_state(controller, state)
            record = reopening
        reopen_attempt = record.get("reopen_attempt")
        if (not isinstance(reopen_attempt, dict)
                or reopen_attempt.get("schema_version") != "juno_merge_queue_reopen.v1"):
            raise MergeQueueError("REOPENING task has invalid recovery identity")
        worktree = task_runtime.exact_root(Path(record["worktree"]), "feature worktree")
        new_tip = reopen_attempt["new_feature_tip"]
        if (task_runtime.git(worktree, "rev-parse", "HEAD", check=False) != new_tip
                or task_runtime.git(repository, "rev-parse", record["branch_ref"], check=False) != new_tip
                or task_runtime.git(worktree, "status", "--porcelain=v1", "--untracked-files=all")):
            raise MergeQueueError("REOPENING feature identity drifted")
        checkout_value = reopen_attempt.get("old_candidate_checkout")
        token = reopen_attempt.get("old_candidate_token")
        if checkout_value:
            if not token:
                raise MergeQueueError("old candidate ownership token is missing")
            checkout = Path(checkout_value)
            if checkout.exists():
                if read_candidate_owner(controller, checkout) != reopen_attempt.get("old_candidate_owner"):
                    raise MergeQueueError("old candidate ownership drifted during reopen")
                rollback_unadmitted_candidate(controller, repository, checkout, token)
            else:
                marker = owner_marker(controller, checkout)
                registered = any(Path(row.get("worktree", "")).resolve() == checkout.resolve()
                                 for row in registered_worktrees(repository))
                if registered:
                    raise MergeQueueError("old candidate path is absent but remains registered")
                if marker.exists():
                    observed_owner = read_candidate_owner(controller, checkout)
                    expected_owner = reopen_attempt.get("old_candidate_owner")
                    if (observed_owner != expected_owner
                            or reopen_attempt.get("task_id") != task_id
                            or observed_owner.get("task_id") != task_id
                            or observed_owner.get("token") != token
                            or observed_owner.get("candidate_checkout") != str(checkout.resolve())
                            or observed_owner.get("repository_identity") != repository_identity(repository)):
                        raise MergeQueueError("orphaned old candidate marker ownership mismatched")
                    candidate_sha = reopen_attempt.get("old_candidate_sha")
                    parents = task_runtime.git(
                        repository, "show", "-s", "--format=%P", candidate_sha,
                        check=False,
                    ).split()
                    if parents != [observed_owner.get("target_sha"), observed_owner.get("feature_sha")]:
                        raise MergeQueueError("orphaned marker does not bind the persisted candidate SHA")
                    # Git removal already succeeded. Delete only the strictly
                    # matched marker; an unlink failure leaves REOPENING truth
                    # intact for another identical retry.
                    marker.unlink()
        queued = {key: value for key, value in record.items()
                  if key not in {"queue_attempt", "last_queue_outcome", "reopen_attempt"}}
        queued.update({"state": "QUEUED", "tip_sha": new_tip,
                       "changed_paths": reopen_attempt["changed_paths"],
                       "validation": reopen_attempt["validations"],
                       "last_validation_outcome": "PASSED",
                       "reopened_from_candidate_sha": reopen_attempt["old_candidate_sha"]})
        prior_findings_sha = record.get("prior_findings_candidate_sha")
        if source_state == "REVIEW_FINDINGS":
            prior_findings_sha = reopen_attempt["old_candidate_sha"]
        if isinstance(prior_findings_sha, str):
            queued["prior_findings_candidate_sha"] = prior_findings_sha
        with task_runtime.state_lock(controller):
            state = task_runtime.read_state(controller)
            if state["tasks"].get(task_id) != record:
                raise MergeQueueError("task state changed during reopen")
            queued["enqueue_sequence"] = task_runtime.assign_enqueue_sequence(state)
            state["tasks"][task_id] = queued
            entry = target_entry(state, repository, config["target_ref"])
            entry["conflicts"].pop(task_id, None)
            task_runtime.write_state(controller, state)
        source_outcome = reopen_attempt.get("source_outcome")
        outcome = ({"FAILED_FULL_SUITE": "REQUEUED_AFTER_FULL_SUITE_FAILURE",
                    "REVIEW_FAILED": "REQUEUED_AFTER_REVIEW_FAILURE",
                    "FAILED_TEST": "REQUEUED_AFTER_VALIDATION_FAILURE",
                    "QUEUED_TIP_REFRESH": "REQUEUED_AFTER_TIP_REFRESH"}.get(
                        source_outcome, "REQUEUED_AFTER_FINDINGS"))
        return {**queued, "outcome": outcome}


def status(controller: Path) -> dict[str, Any]:
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    with task_runtime.state_lock(controller):
        state = task_runtime.read_state(controller)
        tasks = state["tasks"]
        entry = target_entry(state, repository, config["target_ref"])
        rows = [{"task_id": task_id, "state": row.get("state"), "tip_sha": row.get("tip_sha"),
                 "candidate_sha": ((row.get("queue_attempt") or {}).get("candidate_sha")
                                   if isinstance(row.get("queue_attempt"), dict) else None),
                 "candidate_checkout": ((row.get("queue_attempt") or {}).get("candidate_checkout")
                                        if isinstance(row.get("queue_attempt"), dict) else None),
                 "risk_status": (((row.get("queue_attempt") or {}).get("risk") or {}).get("status")
                                 if isinstance((row.get("queue_attempt") or {}).get("risk"), dict) else None),
                 "risk_policy_identity": (((row.get("queue_attempt") or {}).get("risk") or {}).get("policy_identity")
                                          if isinstance((row.get("queue_attempt") or {}).get("risk"), dict) else None),
                 "review_attempt_counter": (((((row.get("queue_attempt") or {}).get("risk") or {})
                                               .get("review_progress") or {}).get("review_attempt_counter"))
                                            if isinstance((((row.get("queue_attempt") or {}).get("risk") or {})
                                                           .get("review_progress")), dict) else None),
                 "completed_reviewers": ([step.get("reviewer") for step in
                                            ((((row.get("queue_attempt") or {}).get("risk") or {})
                                              .get("review_progress") or {}).get("steps", []))]
                                           if isinstance((((row.get("queue_attempt") or {}).get("risk") or {})
                                                          .get("review_progress")), dict) else [])}
                for task_id, row in sorted(tasks.items()) if isinstance(row, dict)
                and row.get("target_ref") == config["target_ref"]
                and row.get("state") in {"QUEUED", "MERGING", "CONFLICT", "CONFLICT_RESOLVED",
                                         "AWAITING_RISK", "AWAITING_RELEASE", "REVIEW_FINDINGS",
                                         "REOPENING", "REQUEUING_STALE", "MERGED"}]
    return {"schema_version": QUEUE_SCHEMA, "repository_identity": repository_identity(repository),
            "target_ref": config["target_ref"], "target_sha": task_runtime.ref_sha(repository, config["target_ref"]),
            "tasks": rows, "last_attempt": entry["last_attempt"],
            "conflict_task_ids": sorted(entry["conflicts"])}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    sub = value.add_subparsers(dest="operation", required=True)
    sub.add_parser("status")
    next_command = sub.add_parser("next")
    next_command.add_argument("task_id", nargs="?")
    resolve = sub.add_parser("resolve")
    resolve.add_argument("task_id")
    review = sub.add_parser("review")
    review.add_argument("task_id")
    reopen = sub.add_parser("reopen")
    reopen.add_argument("task_id")
    value.add_argument("--controller", type=Path, default=Path.cwd(), help=argparse.SUPPRESS)
    return value


def main(argv: Optional[list[str]] = None) -> int:
    args = parser().parse_args(argv)
    try:
        controller = task_runtime.exact_root(args.controller, "controller")
        audit = task_runtime.record_control_audit(
            controller, "merge", args.operation, getattr(args, "task_id", None))
        if args.operation == "status":
            result = status(controller)
        elif args.operation == "next":
            result = merge_next(controller, args.task_id)
        elif args.operation == "resolve":
            result = merge_resolve(controller, args.task_id)
        elif args.operation == "review":
            result = merge_review(controller, args.task_id)
        else:
            result = merge_reopen(controller, args.task_id)
        result = {**result, "control_audit": audit}
        print(canonical(result))
        return 0
    except (MergeQueueError, task_runtime.TaskWorkspaceError, risk_runtime.RiskPolicyError,
            OSError, json.JSONDecodeError) as exc:
        print(f"merge queue: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
