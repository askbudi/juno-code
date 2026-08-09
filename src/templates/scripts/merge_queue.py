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
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

import task_workspace as task_runtime

QUEUE_SCHEMA = "juno_merge_queue_state.v1"
ATTEMPT_SCHEMA = "juno_merge_queue_attempt.v1"


class MergeQueueError(RuntimeError):
    pass


class MergeValidationError(MergeQueueError):
    def __init__(self, message: str, evidence: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.evidence = evidence


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def queue_path(controller: Path) -> Path:
    return controller / ".juno_task/state/queue.json"


def read_queue(controller: Path) -> dict[str, Any]:
    path = queue_path(controller)
    if not path.exists():
        return {"schema_version": QUEUE_SCHEMA, "targets": {}}
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise MergeQueueError(f"invalid merge queue state: {exc}") from exc
    if (not isinstance(value, dict) or set(value) != {"schema_version", "targets"}
            or value.get("schema_version") != QUEUE_SCHEMA or not isinstance(value.get("targets"), dict)):
        raise MergeQueueError("invalid merge queue state schema")
    return value


def write_queue(controller: Path, queue: dict[str, Any]) -> None:
    path = queue_path(controller)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (canonical(queue) + "\n").encode()
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


def repository_identity(repository: Path) -> str:
    common = task_runtime.git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return str(Path(common).resolve())


def target_key(repository: Path, target_ref: str) -> str:
    material = f"{repository_identity(repository)}\0{target_ref}".encode()
    return hashlib.sha256(material).hexdigest()


def target_entry(queue: dict[str, Any], repository: Path, target_ref: str) -> dict[str, Any]:
    key = target_key(repository, target_ref)
    entry = queue["targets"].setdefault(key, {
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
def target_lock(controller: Path, repository: Path, target_ref: str) -> Iterator[None]:
    lock = controller / ".juno_task/runtime/merge-queue" / f"{target_key(repository, target_ref)}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a+b") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise MergeQueueError("another worker owns this repository/target-ref queue") from exc
            raise
        yield


def persist_attempt(controller: Path, attempt: dict[str, Any], *, state: Optional[str] = None,
                    conflict: Optional[dict[str, Any]] = None) -> None:
    with task_runtime.state_lock(controller):
        tasks = task_runtime.read_state(controller)
        current = tasks["tasks"].get(attempt["task_id"])
        if not isinstance(current, dict) or current.get("tip_sha") != attempt["feature_sha"]:
            raise MergeQueueError("task record changed while merge candidate was active")
        if state:
            tasks["tasks"][attempt["task_id"]] = {
                **current, "state": state, "queue_attempt": attempt,
                "last_queue_outcome": attempt["outcome"],
            }
            task_runtime.write_state(controller, tasks)
        queue = read_queue(controller)
        config = task_runtime.load_config(controller)
        repository = task_runtime.product_repository(controller, config)
        entry = target_entry(queue, repository, config["target_ref"])
        entry["last_attempt"] = attempt
        if conflict is None:
            entry["conflicts"].pop(attempt["task_id"], None)
        else:
            entry["conflicts"][attempt["task_id"]] = conflict
        write_queue(controller, queue)


def changed_paths(root: Path) -> list[str]:
    names: set[str] = set()
    for args in (("diff", "--name-only"), ("diff", "--cached", "--name-only"),
                 ("ls-files", "--others", "--exclude-standard")):
        names.update(filter(None, task_runtime.git(root, *args, check=False).splitlines()))
    return sorted(names)


def conflict_paths(root: Path) -> list[str]:
    return sorted(filter(None, task_runtime.git(root, "diff", "--name-only", "--diff-filter=U").splitlines()))


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
    return sorted(candidates, key=lambda row: row["task_id"])[0]


def candidate_directory(controller: Path, task_id: str, target_sha: str, feature_sha: str) -> Path:
    root = controller / ".juno_task/runtime/merge-queue/candidates"
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{task_id}-{target_sha[:10]}-{feature_sha[:10]}-", dir=root))


def validation_rows(config: dict[str, Any], candidate: Path) -> list[dict[str, Any]]:
    evidence = []
    for row in config["focused_validation"]:
        cwd = (candidate / row["cwd"]).resolve()
        try:
            cwd.relative_to(candidate)
        except ValueError as exc:
            raise MergeQueueError("affected validation cwd escaped candidate") from exc
        result = task_runtime.run_validation(row, cwd)
        evidence.append(result)
        if result["timed_out"] or result["exit_code"]:
            detail = result["stderr_tail"] or result["stdout_tail"]
            raise MergeValidationError(f"affected validation failed ({row['id']}): {detail}", evidence)
    return evidence


def assert_frozen_candidate(controller: Path, config: dict[str, Any], checkout: Path, candidate_sha: str) -> None:
    if task_runtime.load_config(controller) != config:
        raise MergeQueueError("task workspace policy changed while candidate validation was active")
    if task_runtime.git(checkout, "rev-parse", "HEAD", check=False) != candidate_sha:
        raise MergeQueueError("candidate HEAD changed while validation/review was active")
    if task_runtime.git(checkout, "status", "--porcelain=v1", "--untracked-files=all", check=False):
        raise MergeQueueError("candidate checkout became dirty while validation/review was active")


def review_candidate(_controller: Path, record: dict[str, Any], candidate_sha: str) -> dict[str, Any]:
    """Narrow seam for the deterministic risk-policy task; never dispatches a model.

    If risk policy has attached a gate, it must be bound to this exact candidate.
    Absence means the current policy classified the task as requiring no receipt.
    """
    gate = record.get("risk_review")
    if gate is None:
        return {"required": False, "candidate_sha": candidate_sha}
    if not isinstance(gate, dict) or gate.get("status") != "PASSED" or gate.get("candidate_sha") != candidate_sha:
        raise MergeQueueError("risk review gate is not PASSED for the exact candidate")
    return {"required": True, "candidate_sha": candidate_sha, "evidence": gate}


def cas_target(repository: Path, target_ref: str, candidate_sha: str, expected_sha: str) -> None:
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


def cleanup_candidate(repository: Path, checkout: Optional[Path], target_ref: str, candidate_sha: str) -> dict[str, Any]:
    if checkout is None:
        return {"candidate_checkout": None, "outcome": "not_required"}
    dirty = task_runtime.git(checkout, "status", "--porcelain=v1", "--untracked-files=all", check=False)
    reachable = task_runtime.run(["git", "-C", str(repository), "merge-base", "--is-ancestor",
                                  candidate_sha, target_ref], repository, check=False).returncode == 0
    if dirty or not reachable:
        return {"candidate_checkout": str(checkout), "outcome": "preserved",
                "reason": "dirty" if dirty else "candidate_unreachable_from_target"}
    result = task_runtime.run(["git", "-C", str(repository), "worktree", "remove", str(checkout)], repository, check=False)
    if result.returncode:
        return {"candidate_checkout": str(checkout), "outcome": "preserved", "reason": "worktree_remove_failed"}
    return {"candidate_checkout": str(checkout), "outcome": "removed"}


def recover_incomplete(controller: Path, config: dict[str, Any], repository: Path) -> Optional[dict[str, Any]]:
    """Recover the small durable window between MERGING truth and target CAS."""
    with task_runtime.state_lock(controller):
        tasks = task_runtime.read_state(controller)["tasks"]
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
        attempt = {**attempt, "outcome": "MERGED", "readback_sha": current, "recovered": True}
        persist_attempt(controller, attempt, state="MERGED")
        checkout_value = attempt.get("candidate_checkout")
        checkout = Path(checkout_value) if checkout_value and Path(checkout_value).is_dir() else None
        return {**attempt, "cleanup": cleanup_candidate(repository, checkout, config["target_ref"], candidate)}
    # CAS did not land (or another writer moved the target). Revalidate and
    # rebuild from the latest target rather than trusting pre-crash evidence.
    attempt = {**attempt, "outcome": "RECOVERED_RETRY", "observed_target_sha": current}
    persist_attempt(controller, attempt, state="QUEUED")
    return None


def merge_next(controller: Path) -> dict[str, Any]:
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    with target_lock(controller, repository, config["target_ref"]):
        recovered = recover_incomplete(controller, config, repository)
        if recovered is not None:
            return recovered
        record = select_next(controller, config)
        feature_worktree = validate_record(config, repository, record)
        target_sha = task_runtime.ref_sha(repository, config["target_ref"])
        feature_sha = record["tip_sha"]
        attempt = {"schema_version": ATTEMPT_SCHEMA, "task_id": record["task_id"],
                   "target_ref": config["target_ref"], "expected_target_sha": target_sha,
                   "feature_sha": feature_sha, "strategy": None, "candidate_sha": None,
                   "candidate_tree": None, "candidate_checkout": None, "validation": [],
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
                persist_attempt(controller, attempt, state="QUEUED")
                raise MergeQueueError("target no longer descends from the frozen feature base")
            attempt["strategy"] = "merge_both_parents"
            checkout = candidate_directory(controller, record["task_id"], target_sha, feature_sha)
            # git worktree requires the destination not to exist.
            checkout.rmdir()
            task_runtime.run(["git", "-C", str(repository), "worktree", "add", "--detach", str(checkout), target_sha], repository)
            attempt["candidate_checkout"] = str(checkout)
            merged = task_runtime.run(["git", "-C", str(checkout), "merge", "--no-ff", "--no-edit", feature_sha], checkout, check=False)
            if merged.returncode:
                conflicts = conflict_paths(checkout)
                if not conflicts:
                    attempt["outcome"] = "MERGE_FAILED"
                    persist_attempt(controller, attempt, state="QUEUED")
                    raise MergeQueueError(merged.stderr.strip() or "candidate merge failed")
                all_changed = changed_paths(checkout)
                guarded = sorted(set(all_changed) - set(conflicts))
                conflict = {"schema_version": ATTEMPT_SCHEMA, "task_id": record["task_id"],
                            "repository_identity": repository_identity(repository),
                            "target_ref": config["target_ref"], "expected_target_sha": target_sha,
                            "feature_sha": feature_sha, "candidate_checkout": str(checkout),
                            "candidate_head": task_runtime.git(checkout, "rev-parse", "HEAD"),
                            "merge_head": task_runtime.git(checkout, "rev-parse", "MERGE_HEAD"),
                            "conflict_paths": conflicts, "changed_paths": all_changed,
                            "guard_snapshot": guard_snapshot(checkout, guarded)}
                attempt["outcome"] = "CONFLICT"
                persist_attempt(controller, attempt, state="CONFLICT", conflict=conflict)
                return {**attempt, "conflict_paths": conflicts}
            candidate_sha = task_runtime.git(checkout, "rev-parse", "HEAD")
            parents = task_runtime.git(checkout, "show", "-s", "--format=%P", candidate_sha).split()
            if parents != [target_sha, feature_sha]:
                raise MergeQueueError("composed candidate does not have exact target/feature parents")
            validation_root = checkout
        attempt["candidate_sha"] = candidate_sha
        attempt["candidate_tree"] = task_runtime.git(repository, "rev-parse", f"{candidate_sha}^{{tree}}")
        try:
            attempt["validation"] = validation_rows(config, validation_root)
            assert_frozen_candidate(controller, config, validation_root, candidate_sha)
            attempt["review"] = review_candidate(controller, record, candidate_sha)
            assert_frozen_candidate(controller, config, validation_root, candidate_sha)
            if task_runtime.ref_sha(repository, config["target_ref"]) != target_sha:
                raise MergeQueueError("target moved before compare-and-swap; no ref was changed")
            persist_attempt(controller, attempt, state="MERGING")
            cas_target(repository, config["target_ref"], candidate_sha, target_sha)
        except MergeValidationError as exc:
            attempt["validation"] = exc.evidence
            attempt["outcome"] = "FAILED_TEST"
            persist_attempt(controller, attempt, state="QUEUED")
            raise
        except MergeQueueError:
            attempt["outcome"] = "STALE_TARGET"
            persist_attempt(controller, attempt, state="QUEUED")
            raise
        attempt["outcome"] = "MERGED"
        attempt["readback_sha"] = task_runtime.ref_sha(repository, config["target_ref"])
        persist_attempt(controller, attempt, state="MERGED")
        cleanup = cleanup_candidate(repository, checkout, config["target_ref"], candidate_sha)
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


def merge_resolve(controller: Path, task_id: str) -> dict[str, Any]:
    if not task_runtime.TASK_RE.fullmatch(task_id):
        raise MergeQueueError("unsafe task id")
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    with target_lock(controller, repository, config["target_ref"]):
        with task_runtime.state_lock(controller):
            tasks = task_runtime.read_state(controller)
            record = tasks["tasks"].get(task_id)
            queue = read_queue(controller)
            conflict = target_entry(queue, repository, config["target_ref"])["conflicts"].get(task_id)
        if not isinstance(record, dict) or record.get("state") != "CONFLICT" or not isinstance(conflict, dict):
            raise MergeQueueError("task has no bound CONFLICT candidate")
        if repository_identity(repository) != conflict["repository_identity"]:
            raise MergeQueueError("conflict repository identity drifted")
        if task_runtime.ref_sha(repository, config["target_ref"]) != conflict["expected_target_sha"]:
            raise MergeQueueError("target moved since conflict; preserve checkout and requeue explicitly")
        if task_runtime.git(repository, "rev-parse", record["branch_ref"], check=False) != conflict["feature_sha"]:
            raise MergeQueueError("feature tip moved since conflict")
        checkout = task_runtime.exact_root(Path(conflict["candidate_checkout"]), "conflict candidate checkout")
        if task_runtime.git(checkout, "rev-parse", "HEAD", check=False) != conflict["candidate_head"]:
            raise MergeQueueError("conflict candidate HEAD drifted")
        if task_runtime.git(checkout, "rev-parse", "MERGE_HEAD", check=False) != conflict["merge_head"]:
            raise MergeQueueError("conflict candidate MERGE_HEAD drifted")
        verify_resolution(checkout, conflict)
        task_runtime.run(["git", "-C", str(checkout), "commit", "--no-edit"], checkout)
        candidate_sha = task_runtime.git(checkout, "rev-parse", "HEAD")
        parents = task_runtime.git(checkout, "show", "-s", "--format=%P", candidate_sha).split()
        if parents != [conflict["expected_target_sha"], conflict["feature_sha"]]:
            raise MergeQueueError("resolved candidate does not have exact target/feature parents")
        attempt = {"schema_version": ATTEMPT_SCHEMA, "task_id": task_id,
                   "target_ref": config["target_ref"], "expected_target_sha": conflict["expected_target_sha"],
                   "feature_sha": conflict["feature_sha"], "strategy": "resolved_merge",
                   "candidate_sha": candidate_sha,
                   "candidate_tree": task_runtime.git(checkout, "rev-parse", "HEAD^{tree}"),
                   "candidate_checkout": str(checkout), "validation": [], "review": None,
                   "outcome": "MERGING"}
        try:
            attempt["validation"] = validation_rows(config, checkout)
            assert_frozen_candidate(controller, config, checkout, candidate_sha)
            attempt["review"] = review_candidate(controller, record, candidate_sha)
            assert_frozen_candidate(controller, config, checkout, candidate_sha)
            persist_attempt(controller, attempt, state="MERGING")
            cas_target(repository, config["target_ref"], candidate_sha, conflict["expected_target_sha"])
        except MergeValidationError as exc:
            attempt["validation"] = exc.evidence
            attempt["outcome"] = "FAILED_TEST"
            persist_attempt(controller, attempt, state="QUEUED")
            raise
        except MergeQueueError:
            attempt["outcome"] = "STALE_TARGET"
            persist_attempt(controller, attempt, state="QUEUED")
            raise
        attempt["outcome"] = "MERGED"
        attempt["readback_sha"] = task_runtime.ref_sha(repository, config["target_ref"])
        persist_attempt(controller, attempt, state="MERGED")
        return {**attempt, "cleanup": cleanup_candidate(repository, checkout, config["target_ref"], candidate_sha)}


def status(controller: Path) -> dict[str, Any]:
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    with task_runtime.state_lock(controller):
        tasks = task_runtime.read_state(controller)["tasks"]
        queue = read_queue(controller)
        entry = target_entry(queue, repository, config["target_ref"])
        rows = [{"task_id": task_id, "state": row.get("state"), "tip_sha": row.get("tip_sha")}
                for task_id, row in sorted(tasks.items()) if isinstance(row, dict)
                and row.get("target_ref") == config["target_ref"]
                and row.get("state") in {"QUEUED", "MERGING", "CONFLICT", "MERGED"}]
    return {"schema_version": QUEUE_SCHEMA, "repository_identity": repository_identity(repository),
            "target_ref": config["target_ref"], "target_sha": task_runtime.ref_sha(repository, config["target_ref"]),
            "tasks": rows, "last_attempt": entry["last_attempt"],
            "conflict_task_ids": sorted(entry["conflicts"])}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    sub = value.add_subparsers(dest="operation", required=True)
    sub.add_parser("status")
    sub.add_parser("next")
    resolve = sub.add_parser("resolve")
    resolve.add_argument("task_id")
    value.add_argument("--controller", type=Path, default=Path.cwd(), help=argparse.SUPPRESS)
    return value


def main(argv: Optional[list[str]] = None) -> int:
    args = parser().parse_args(argv)
    try:
        controller = task_runtime.exact_root(args.controller, "controller")
        if args.operation == "status":
            result = status(controller)
        elif args.operation == "next":
            result = merge_next(controller)
        else:
            result = merge_resolve(controller, args.task_id)
        print(canonical(result))
        return 0
    except (MergeQueueError, task_runtime.TaskWorkspaceError, OSError, json.JSONDecodeError) as exc:
        print(f"merge queue: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
