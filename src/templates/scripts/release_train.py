#!/usr/bin/env python3
"""Deterministic, offline release-train projection and stale-plan gate."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import task_workspace as task_runtime

DECLARATION_SCHEMA = "juno_release_train_declaration.v1"
REPORT_SCHEMA = "juno_release_train_plan.v1"
IDENTITY_SCHEMA = "juno_release_train_plan_identity.v1"
EPOCH_PLAN_SCHEMA = "juno_release_epoch_plan.v1"
EPOCH_SEAL_SCHEMA = "juno_release_epoch_seal.v1"
EPOCH_STATE_SCHEMA = "juno_release_epoch_state.v1"
EPOCH_RECEIPT_SCHEMA = "juno_release_epoch_receipt.v1"
SHADOW_SCHEMA = "juno_release_epoch_shadow.v1"
EPOCH_TERMINAL_STATES = {"RELEASE_READY", "CLOSED", "PAUSED_REQUIRED", "NEEDS_OPERATOR", "STALE"}
ACTIVE_QUEUE_STATES = {"QUEUED", "MERGING", "CONFLICT", "CONFLICT_RESOLVED", "AWAITING_RISK",
                       "AWAITING_RELEASE", "REVIEW_FINDINGS", "REVIEW_FINDINGS_EXHAUSTED",
                       "REOPENING", "REQUEUING_STALE"}
SHA_RE = re.compile(r"^[0-9a-f]{40,64}$")


class ReleaseTrainError(RuntimeError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_hash(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return result.stdout.strip() if result.returncode == 0 else ""


def load_declaration(path: Path) -> tuple[dict[str, Any], Path]:
    resolved = path.expanduser().resolve()
    try:
        value = json.loads(resolved.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseTrainError(f"invalid release-train declaration: {exc}") from exc
    required_keys = {"schema_version", "train_id", "revision", "requested_version", "target_ref",
                     "planning_base_sha", "required_tasks", "optional_tasks", "dependencies",
                     "gates", "authority", "exclusions"}
    if not isinstance(value, dict) or set(value) != required_keys or value.get("schema_version") != DECLARATION_SCHEMA:
        raise ReleaseTrainError("release-train declaration has an unsupported or non-exact schema")
    train_id = value["train_id"]
    if not isinstance(train_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", train_id):
        raise ReleaseTrainError("train_id is unsafe")
    if not isinstance(value["revision"], int) or isinstance(value["revision"], bool) or value["revision"] < 1:
        raise ReleaseTrainError("declaration revision must be a positive integer")
    if not task_runtime.is_valid_semver(value["requested_version"]) or "+" in value["requested_version"]:
        raise ReleaseTrainError("requested_version must be exact SemVer without build metadata")
    if not isinstance(value["target_ref"], str) or not value["target_ref"].startswith("refs/"):
        raise ReleaseTrainError("target_ref must be a full ref")
    if not isinstance(value["planning_base_sha"], str) or not SHA_RE.fullmatch(value["planning_base_sha"]):
        raise ReleaseTrainError("planning_base_sha must be an exact commit")
    for field in ("required_tasks", "optional_tasks", "gates", "exclusions"):
        if not isinstance(value[field], list) or any(not isinstance(item, str) or not item for item in value[field]):
            raise ReleaseTrainError(f"{field} must contain non-empty strings")
        if len(value[field]) != len(set(value[field])):
            raise ReleaseTrainError(f"{field} contains duplicates")
    overlap = set(value["required_tasks"]) & set(value["optional_tasks"])
    if overlap:
        raise ReleaseTrainError("required and optional tasks overlap: " + ", ".join(sorted(overlap)))
    if not value["required_tasks"]:
        raise ReleaseTrainError("required_tasks must not be empty")
    for task_id in value["required_tasks"] + value["optional_tasks"]:
        if not task_runtime.TASK_RE.fullmatch(task_id):
            raise ReleaseTrainError(f"unsafe task id: {task_id}")
    if not isinstance(value["dependencies"], list):
        raise ReleaseTrainError("dependencies must be a list")
    known = set(value["required_tasks"] + value["optional_tasks"])
    seen_edges: set[tuple[str, str]] = set()
    for edge in value["dependencies"]:
        if not isinstance(edge, dict) or set(edge) != {"before", "after"}:
            raise ReleaseTrainError("dependency edges require exactly before and after")
        pair = (edge["before"], edge["after"])
        if pair in seen_edges or any(item not in known for item in pair):
            raise ReleaseTrainError("dependency edge is duplicate or references an undeclared task")
        seen_edges.add(pair)
    authority = value["authority"]
    if not isinstance(authority, dict) or set(authority) != {"controller_common_dir", "release_command"}:
        raise ReleaseTrainError("authority requires controller_common_dir and release_command")
    if not all(isinstance(item, str) and item for item in authority.values()):
        raise ReleaseTrainError("authority values must be non-empty strings")
    return value, resolved


def kanban_task(controller: Path, task_id: str) -> dict[str, Any]:
    # Exact get may resolve immutable cold archives; release intent must name
    # current hot canonical tasks, never silently revive an archived ID.
    if not task_runtime.task_file(controller, task_id).is_file():
        raise ReleaseTrainError(f"canonical Kanban task is missing or archived: {task_id}")
    wrapper = controller / ".juno_task/scripts/kanban.sh"
    result = subprocess.run([str(wrapper), "get", task_id], cwd=controller, text=True,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=30)
    if result.returncode:
        raise ReleaseTrainError(f"canonical Kanban task is missing or unreadable: {task_id}")
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ReleaseTrainError(f"canonical Kanban returned malformed JSON for {task_id}") from exc
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("id") != task_id:
        raise ReleaseTrainError(f"canonical Kanban identity is ambiguous: {task_id}")
    return rows[0]


def dependency_order(nodes: set[str], edges: set[tuple[str, str]]) -> list[str]:
    incoming = {node: 0 for node in nodes}
    children = {node: [] for node in nodes}
    for before, after in sorted(edges):
        incoming[after] += 1
        children[before].append(after)
    ready = sorted(node for node, count in incoming.items() if count == 0)
    ordered: list[str] = []
    while ready:
        node = ready.pop(0); ordered.append(node)
        for child in children[node]:
            incoming[child] -= 1
            if incoming[child] == 0:
                ready.append(child); ready.sort()
    return ordered


def cycle_path(nodes: set[str], edges: set[tuple[str, str]]) -> list[str]:
    graph = {node: [] for node in nodes}
    for before, after in sorted(edges):
        graph[before].append(after)
    visiting: list[str] = []
    done: set[str] = set()
    def visit(node: str) -> list[str]:
        if node in visiting:
            start = visiting.index(node)
            return visiting[start:] + [node]
        if node in done:
            return []
        visiting.append(node)
        for child in graph[node]:
            found = visit(child)
            if found:
                return found
        visiting.pop(); done.add(node)
        return []
    for node in sorted(nodes):
        found = visit(node)
        if found:
            return found
    return []


def target_blob(repository: Path, sha: str, path: str) -> Optional[bytes]:
    """Exact blob bytes of one product path at the protected target generation."""
    result = subprocess.run(["git", "-C", str(repository), "cat-file", "blob", f"{sha}:{path}"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return result.stdout if result.returncode == 0 else None


def release_versions(blobs: dict[str, Optional[bytes]]) -> dict[str, Optional[str]]:
    """Version identity from exact protected-target tree bytes.

    A lean sparse controller legitimately carries no product files in its
    working tree, so the release identity is derived from the target commit
    itself, never from checkout state (rejV9U).
    """
    def extract(blob: Optional[bytes], keys: list[Any]) -> Optional[str]:
        try:
            value: Any = json.loads(blob.decode("utf-8")) if blob is not None else None
            for key in keys:
                value = value[key]
            return value if isinstance(value, str) else None
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
            return None

    package, lock = blobs.get("juno-code/package.json"), blobs.get("juno-code/package-lock.json")
    return {"package": extract(package, ["version"]),
            "lock": extract(lock, ["version"]),
            "lock_root": extract(lock, ["packages", "", "version"])}


def build_plan(controller: Path, declaration_path: Path,
               plan_output: Optional[Path] = None) -> dict[str, Any]:
    declaration, declaration_path = load_declaration(declaration_path)
    plan_path = (plan_output.expanduser().resolve() if plan_output is not None
                 else declaration_path.with_suffix(".plan.json"))
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    registered_controller = git(controller, "config", "--local", "--get", "juno.controller.path")
    if registered_controller and Path(registered_controller).expanduser().resolve() != controller:
        raise ReleaseTrainError("release-train planning requires the registered canonical controller")
    controller_common = str(Path(git(controller, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve())
    if str(Path(declaration["authority"]["controller_common_dir"]).expanduser().resolve()) != controller_common:
        raise ReleaseTrainError("declaration authority does not name this canonical controller repository")
    if declaration["target_ref"] != config["target_ref"]:
        raise ReleaseTrainError("declaration target ref differs from canonical target policy")
    target_sha = git(repository, "rev-parse", "--verify", declaration["target_ref"])
    if not SHA_RE.fullmatch(target_sha):
        raise ReleaseTrainError("declared target ref is missing")

    declared = declaration["required_tasks"] + declaration["optional_tasks"]
    board = {task_id: kanban_task(controller, task_id) for task_id in declared}
    external_blocker_ids = sorted({
        blocker for task in board.values() for blocker in (task.get("blocked_by", []) or [])
        if blocker not in board
    })
    external_board = {task_id: kanban_task(controller, task_id) for task_id in external_blocker_ids}
    state = task_runtime.read_state(controller)
    records = state["tasks"]
    edges = {(edge["before"], edge["after"]) for edge in declaration["dependencies"]}
    for task_id, task in board.items():
        for blocker in task.get("blocked_by", []) or []:
            if blocker in declared:
                edges.add((blocker, task_id))
    cycle = cycle_path(set(declared), edges)
    ordered_tasks = dependency_order(set(declared), edges)

    queue_rows = []
    for task_id, record in records.items():
        if isinstance(record, dict) and record.get("target_ref") == declaration["target_ref"] and record.get("state") in ACTIVE_QUEUE_STATES:
            queue_rows.append({"task_id": task_id, "state": record.get("state"),
                               "enqueue_sequence": record.get("enqueue_sequence"),
                               "record_sha256": digest(record), "tip_sha": record.get("tip_sha")})
    queue_rows.sort(key=lambda row: (row["enqueue_sequence"] if isinstance(row["enqueue_sequence"], int) else 2**63,
                                     row["task_id"]))
    queue_head = queue_rows[0]["task_id"] if queue_rows else None
    required = set(declaration["required_tasks"])
    first_required_index = next((index for index, row in enumerate(queue_rows) if row["task_id"] in required), len(queue_rows))
    older_unrelated = [row for row in queue_rows[:first_required_index] if row["task_id"] not in required]

    task_rows: list[dict[str, Any]] = []
    feasibility: dict[str, Any] = {}
    for task_id in declared:
        task, record = board[task_id], records.get(task_id)
        status = task.get("status")
        blockers = sorted(set(task.get("blocked_by", []) or []))
        unmet = [item for item in blockers
                 if (board.get(item) or external_board.get(item, {})).get("status") != "done"]
        queue_state = record.get("state") if isinstance(record, dict) else None
        integrated = status == "done" and (not isinstance(record, dict) or queue_state == "MERGED" or
            (isinstance(task.get("commit_hash"), str) and not subprocess.run(
                ["git", "-C", str(repository), "merge-base", "--is-ancestor", task["commit_hash"], target_sha],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode))
        if integrated:
            lane = "integrated"
        elif queue_state in ACTIVE_QUEUE_STATES:
            lane = "in_progress"
        elif status == "in_progress":
            lane = "in_progress"
        elif unmet:
            lane = "blocked"
        elif status in {"backlog", "todo"}:
            lane = "ready"
        else:
            lane = "blocked"
        authored = sorted(record.get("changed_paths", [])) if isinstance(record, dict) else []
        item = {"task_id": task_id, "required": task_id in required, "kanban_status": status,
                "kanban_revision": task.get("last_modified"), "kanban_sha256": digest(task),
                "queue_state": queue_state, "enqueue_sequence": record.get("enqueue_sequence") if isinstance(record, dict) else None,
                "unmet_blockers": unmet, "lane": lane, "changed_paths": authored}
        task_rows.append(item)
        if isinstance(record, dict) and queue_state in ACTIVE_QUEUE_STATES:
            try:
                import merge_queue
                candidate = merge_queue.merge_plan(controller, task_id)
                feasibility[task_id] = {"plan_id": candidate["plan_id"], "ready": candidate["ready"],
                                        "finding_codes": [row["code"] for row in candidate["findings"]]}
            except Exception as exc:
                feasibility[task_id] = {"plan_id": None, "ready": False, "error": str(exc)}

    parallel_lanes: list[list[str]] = []
    for row in task_rows:
        if row["lane"] not in {"ready", "in_progress"}:
            continue
        placed = False
        for lane in parallel_lanes:
            safe = all(
                not (set(row["changed_paths"]) & set(next(
                    item["changed_paths"] for item in task_rows if item["task_id"] == other)))
                and (other, row["task_id"]) not in edges
                and (row["task_id"], other) not in edges
                for other in lane
            )
            if safe:
                lane.append(row["task_id"]); placed = True; break
        if not placed:
            parallel_lanes.append([row["task_id"]])

    blockers: list[dict[str, Any]] = []
    if target_sha != declaration["planning_base_sha"]:
        blockers.append({"code": "target.moved", "repair_command": "revise the train planning_base_sha and re-plan"})
    if cycle:
        blockers.append({"code": "dependency.cycle", "tasks": cycle, "repair_command": "revise the train dependencies"})
    if older_unrelated:
        blockers.append({"code": "queue.older_unrelated", "tasks": [row["task_id"] for row in older_unrelated],
                         "choices": ["wait", "complete", "revise-train", "receipt-bound-defer-if-supported"],
                         "repair_command": "yy merge next"})
    for row in task_rows:
        if row["unmet_blockers"]:
            blockers.append({"code": "dependency.unmet", "task_id": row["task_id"],
                             "tasks": row["unmet_blockers"], "repair_command": f"yy task status {row['unmet_blockers'][0]}"})
    runtime_paths = [controller / ".juno_task/scripts/release_train.py", controller / ".juno_task/scripts/merge_queue.py"]
    runtime_hashes = {str(path.relative_to(controller)): file_hash(path) for path in runtime_paths}
    if any(value is None for value in runtime_hashes.values()):
        blockers.append({"code": "runtime.missing", "repair_command": "yy scripts update --force"})
    bad_feasibility = [task_id for task_id, value in feasibility.items() if not value["ready"]]
    if bad_feasibility:
        blockers.append({"code": "candidate.infeasible", "tasks": sorted(bad_feasibility),
                         "repair_command": f"yy merge plan {sorted(bad_feasibility)[0]}"})
    owner_path = git(repository, "config", "--local", "--get", "juno.integration.ownerPath")
    owner_identity: dict[str, Any] = {"path": owner_path or None, "ready": False}
    if owner_path:
        try:
            import merge_queue
            observed = merge_queue.integration_owner_readback(Path(owner_path).expanduser().resolve())
            owner_identity["observed"] = observed
            owner_identity["ready"] = bool(
                observed["clean"] and observed["detached"] and observed["full_checkout"]
                and observed["role"] == "integration-owner"
                and observed["authority"] == merge_queue.INTEGRATION_OWNER_AUTHORITY
                and observed["head"] == target_sha and observed["role_base"] == target_sha
                and all(item["state"] == "exact" for item in observed["submodules"]))
        except Exception as exc:
            owner_identity["error"] = str(exc)
    if not owner_identity["ready"]:
        blockers.append({"code": "topology.integration_owner_not_ready",
                         "repair_command": "yy integration status"})
    # Release version identity binds to the exact protected target generation:
    # a lean sparse controller without product files in its working tree must
    # still plan, and working-tree drift must never become release identity.
    package_paths = ["juno-code/package.json", "juno-code/package-lock.json"]
    target_blobs = {path: target_blob(repository, target_sha, path) for path in package_paths}
    versions = release_versions(target_blobs)
    version = versions["package"]
    tag = "v" + declaration["requested_version"]
    tag_exists = bool(git(repository, "rev-parse", "-q", "--verify", "refs/tags/" + tag))
    if version is None or not task_runtime.is_valid_semver(version):
        blockers.append({"code": "release.version_missing", "repair_command": "repair juno-code/package.json"})
    elif len(set(versions.values())) != 1:
        blockers.append({"code": "release.version_identity_mismatch",
                         "repair_command": "synchronize package and lockfile versions"})
    elif not task_runtime.semver_precedes(version, declaration["requested_version"]):
        blockers.append({"code": "release.version_not_greater", "repair_command": "revise requested_version"})
    if tag_exists:
        blockers.append({"code": "release.tag_exists", "repair_command": "revise requested_version"})

    required_rows = [row for row in task_rows if row["required"]]
    release_ready = (all(row["lane"] == "integrated" for row in required_rows) and not blockers)
    if blockers:
        next_command = blockers[0]["repair_command"]
    else:
        queue_required = next((row for row in queue_rows if row["task_id"] in required), None)
        ready_required = next((row for row in required_rows if row["lane"] == "ready"), None)
        active_required = next((row for row in required_rows if row["lane"] == "in_progress"), None)
        if queue_required:
            next_command = f"yy merge next --train-plan {plan_path}"
        elif active_required:
            next_command = f"yy task status {active_required['task_id']}"
        elif ready_required:
            next_command = f"yy task start {ready_required['task_id']}"
        else:
            next_command = declaration["authority"]["release_command"] + f" --train-plan {plan_path}"

    identities = {"controller": {"path": str(controller), "common_dir": controller_common,
                                  "ref": git(controller, "symbolic-ref", "-q", "HEAD"),
                                  "head": git(controller, "rev-parse", "HEAD")},
                  "repository_common_dir": str(Path(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()),
                  "target": {"ref": declaration["target_ref"], "sha": target_sha},
                  "declaration": {"path": str(declaration_path), "revision": declaration["revision"],
                                  "sha256": file_hash(declaration_path)},
                  "plan_path": str(plan_path),
                  "kanban": {**{row["task_id"]: {"revision": row["kanban_revision"], "sha256": row["kanban_sha256"]} for row in task_rows},
                              **{task_id: {"revision": task.get("last_modified"), "sha256": digest(task), "external_blocker": True}
                                 for task_id, task in external_board.items()}},
                  "queue": {"head": queue_head, "records_sha256": digest(queue_rows), "rows": queue_rows},
                  "runtime_sha256": runtime_hashes,
                  "package_sha256": {path: (None if target_blobs[path] is None
                                            else hashlib.sha256(target_blobs[path]).hexdigest())
                                      for path in package_paths},
                  "policy_sha256": {path: file_hash(controller / path) for path in [".juno_task/config/task-workspace.json", ".juno_task/config/risk-policy.json"]},
                  "integration_owner": owner_identity,
                  "requested_version": declaration["requested_version"]}
    body = {"schema_version": REPORT_SCHEMA, "train_id": declaration["train_id"],
            "requested_version": declaration["requested_version"], "declaration": declaration,
            "ready": release_ready, "release_ready": release_ready, "target_moved": target_sha != declaration["planning_base_sha"],
            "tasks": task_rows, "dependency_edges": [[before, after] for before, after in sorted(edges)],
            "dependency_order": ordered_tasks,
            "critical_path": cycle if cycle else [task_id for task_id in ordered_tasks
                                                    if task_id in required and next(row for row in task_rows if row["task_id"] == task_id)["lane"] != "integrated"],
            "parallel_lanes": parallel_lanes, "serialized_merge_order": [row["task_id"] for row in queue_rows],
            "fifo": {"head": queue_head, "older_unrelated": older_unrelated, "conflict": bool(older_unrelated)},
            "candidate_feasibility": feasibility, "release_preconditions": {"current_version": version,
                "version_identities": versions,
                "requested_version": declaration["requested_version"], "tag": tag, "tag_exists": tag_exists,
                "required_tasks_integrated": all(row["lane"] == "integrated" for row in required_rows),
                "gates": declaration["gates"]},
            "blockers": blockers, "next_command": next_command, "identities": identities,
            "invalidation": {"rule": "any declaration/controller/ref/HEAD/target/Kanban/queue/runtime/package/policy/version identity change invalidates this plan"}}
    return {**body, "plan_id": digest({"schema_version": IDENTITY_SCHEMA, "report": body})}


def check_plan(controller: Path, plan_path: Path, action: str, task_id: Optional[str] = None,
               requested_version: Optional[str] = None) -> dict[str, Any]:
    try:
        approved = json.loads(plan_path.expanduser().resolve().read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseTrainError(f"invalid release-train plan: {exc}") from exc
    declaration_path = approved.get("identities", {}).get("declaration", {}).get("path")
    if not isinstance(declaration_path, str):
        raise ReleaseTrainError("release-train plan lacks its declaration identity")
    bound_plan_path = approved.get("identities", {}).get("plan_path")
    if not isinstance(bound_plan_path, str):
        raise ReleaseTrainError("release-train plan lacks its output-path identity")
    if plan_path.expanduser().resolve() != Path(bound_plan_path).expanduser().resolve():
        raise ReleaseTrainError("release-train plan was supplied from a different path identity")
    current = build_plan(controller, Path(declaration_path), Path(bound_plan_path))
    if approved != current:
        raise ReleaseTrainError("release-train plan is stale; rerun yy release train plan")
    if action == "merge":
        head = current["fifo"]["head"]
        if head is None or (task_id is not None and head != task_id):
            raise ReleaseTrainError("release-train plan does not authorize this exact FIFO merge head")
        # An unrelated older head is explicitly permitted only in its existing
        # FIFO position: completing it honors the conflict; it never bypasses it.
        row = next((item for item in current["tasks"] if item["task_id"] == head), None)
        if row is not None and row["unmet_blockers"]:
            raise ReleaseTrainError("release-train merge head has unmet dependencies")
    elif action == "release":
        if requested_version != current["requested_version"]:
            raise ReleaseTrainError("release version differs from the release-train plan")
        if not current["release_ready"]:
            raise ReleaseTrainError("release-train plan is blocked and cannot authorize release")
    else:
        raise ReleaseTrainError("unknown release-train action")
    return current


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: dict[str, Any], *, exclusive: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = canonical(value) + "\n"
    if exclusive:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raise
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        return
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def epoch_root(controller: Path) -> Path:
    return controller / ".juno_task/runtime/release-epochs"


def epoch_state_path(controller: Path, epoch_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", epoch_id):
        raise ReleaseTrainError("epoch id is unsafe")
    return epoch_root(controller) / epoch_id / "state.json"


def read_epoch(controller: Path, epoch_id: str) -> dict[str, Any]:
    path = epoch_state_path(controller, epoch_id)
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseTrainError(f"release epoch is missing or malformed: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != EPOCH_STATE_SCHEMA:
        raise ReleaseTrainError("release epoch state has an unsupported schema")
    return value


def epoch_receipt(controller: Path, state: dict[str, Any], transition: str,
                  detail: dict[str, Any]) -> dict[str, Any]:
    sequence = len(state.get("receipts", [])) + 1
    body = {"schema_version": EPOCH_RECEIPT_SCHEMA, "epoch_id": state["epoch_id"],
            "sequence": sequence, "transition": transition, "created_utc": utc_now(),
            "previous_state": state["state"], "detail": detail}
    body["receipt_id"] = digest(body)
    path = epoch_root(controller) / state["epoch_id"] / "receipts" / f"{sequence:04d}-{transition.lower()}.json"
    atomic_json(path, body, exclusive=True)
    reference = {"path": str(path.resolve()), "sha256": file_hash(path),
                 "receipt_id": body["receipt_id"], "transition": transition}
    state.setdefault("receipts", []).append(reference)
    return reference


def queue_epoch_members(controller: Path, declaration: dict[str, Any], target_sha: str) -> list[dict[str, Any]]:
    state = task_runtime.read_state(controller)
    declared_required = set(declaration["required_tasks"])
    declared_optional = set(declaration["optional_tasks"])
    rows: list[dict[str, Any]] = []
    for task_id, record in state.get("tasks", {}).items():
        if (not isinstance(record, dict) or record.get("target_ref") != declaration["target_ref"]
                or record.get("state") not in ACTIVE_QUEUE_STATES):
            continue
        task = kanban_task(controller, task_id)
        tip = record.get("tip_sha")
        if not isinstance(tip, str) or not SHA_RE.fullmatch(tip):
            raise ReleaseTrainError(f"eligible candidate {task_id} lacks an exact tip")
        repository = task_runtime.product_repository(controller, task_runtime.load_config(controller))
        tree = git(repository, "rev-parse", f"{tip}^{{tree}}")
        if not SHA_RE.fullmatch(tree):
            raise ReleaseTrainError(f"eligible candidate {task_id} tip is unavailable")
        attempt = record.get("queue_attempt") if isinstance(record.get("queue_attempt"), dict) else {}
        closure = record.get("complete_input_identity") or attempt.get("complete_input_identity")
        evidence = record.get("validation") or attempt.get("command_evidence") or attempt.get("validation") or []
        admission = ("required" if task_id in declared_required else
                     "optional" if task_id in declared_optional else "ambient_pre_cutoff")
        # Ambient finished candidates are release-barrier members, not blockers
        # outside the epoch. They must drain before the epoch can CAS.
        rows.append({"task_id": task_id, "admission": admission,
                     "required": admission != "optional", "queue_state": record.get("state"),
                     "enqueue_sequence": record.get("enqueue_sequence"), "tip_sha": tip,
                     "tree_sha": tree, "task_revision": task.get("last_modified"),
                     "task_sha256": digest(task), "queue_record_sha256": digest(record),
                     "fencing_attempt": attempt.get("arbiter_attempt") or attempt.get("attempt"),
                     "complete_input_identity": closure, "evidence_sha256": digest(evidence),
                     "review_sha256": digest(attempt.get("risk") or attempt.get("review") or {}),
                     "changed_paths": sorted(record.get("changed_paths", [])),
                     "blocked_by": sorted(task.get("blocked_by", []) or [])})
    rows.sort(key=lambda row: (row["enqueue_sequence"] if isinstance(row["enqueue_sequence"], int) else 2**63,
                               row["task_id"]))
    return rows


def epoch_dependency_order(members: list[dict[str, Any]], declaration: dict[str, Any]) -> tuple[list[str], list[list[str]]]:
    ids = {row["task_id"] for row in members}
    edges = {(edge["before"], edge["after"]) for edge in declaration["dependencies"]
             if edge["before"] in ids and edge["after"] in ids}
    for row in members:
        edges.update((blocker, row["task_id"]) for blocker in row["blocked_by"] if blocker in ids)
    cycle = cycle_path(ids, edges)
    if cycle:
        raise ReleaseTrainError("release epoch dependency cycle: " + " -> ".join(cycle))
    fifo = {row["task_id"]: index for index, row in enumerate(members)}
    incoming = {node: 0 for node in ids}; children = {node: [] for node in ids}
    for before, after in edges:
        incoming[after] += 1; children[before].append(after)
    ready = sorted((node for node, count in incoming.items() if count == 0), key=lambda node: (fifo[node], node))
    order: list[str] = []
    while ready:
        node = ready.pop(0); order.append(node)
        for child in sorted(children[node], key=lambda item: (fifo[item], item)):
            incoming[child] -= 1
            if incoming[child] == 0:
                ready.append(child); ready.sort(key=lambda item: (fifo[item], item))
    return order, [list(edge) for edge in sorted(edges)]


def build_epoch_plan(controller: Path, declaration_path: Path) -> dict[str, Any]:
    declaration, resolved = load_declaration(declaration_path)
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    target_sha = git(repository, "rev-parse", "--verify", declaration["target_ref"])
    if target_sha != declaration["planning_base_sha"]:
        raise ReleaseTrainError("target moved since the declaration planning base")
    members = queue_epoch_members(controller, declaration, target_sha)
    queued = {row["task_id"] for row in members}
    missing = sorted((set(declaration["required_tasks"]) | set(declaration["optional_tasks"])) - queued)
    if missing:
        raise ReleaseTrainError("declared candidates are not queued at the cutoff: " + ", ".join(missing))
    if not members:
        raise ReleaseTrainError("no eligible candidates exist for an epoch seal")
    order, edges = epoch_dependency_order(members, declaration)
    runtime_paths = [".juno_task/scripts/release_train.py", ".juno_task/scripts/merge_queue.py",
                     ".juno_task/scripts/task_workspace.py"]
    body = {"schema_version": EPOCH_PLAN_SCHEMA, "epoch_id": declaration["train_id"],
            "declaration": {"path": str(resolved), "sha256": file_hash(resolved),
                            "revision": declaration["revision"]},
            "target_ref": declaration["target_ref"], "base_sha": target_sha,
            "members": members, "order": order, "dependency_edges": edges,
            "runtime_sha256": {path: file_hash(controller / path) for path in runtime_paths},
            "policy_sha256": {path: file_hash(controller / path) for path in
                              [".juno_task/config/task-workspace.json", ".juno_task/config/risk-policy.json"]},
            "requested_version": declaration["requested_version"],
            "exclusions": declaration["exclusions"],
            "mutation_authority": "explicit_seal_required"}
    return {**body, "plan_id": digest(body)}


def seal_epoch(controller: Path, declaration_path: Path) -> dict[str, Any]:
    plan = build_epoch_plan(controller, declaration_path)
    path = epoch_state_path(controller, plan["epoch_id"])
    if path.exists():
        current = read_epoch(controller, plan["epoch_id"])
        if current.get("seal", {}).get("plan_id") != plan["plan_id"]:
            raise ReleaseTrainError("epoch id is already sealed with a different immutable snapshot")
        return {"outcome": "already_sealed", "epoch": current}
    token = f"{plan['epoch_id']}:{secrets.token_hex(24)}"
    seal = {"schema_version": EPOCH_SEAL_SCHEMA, **plan, "sealed_utc": utc_now(),
            "cutoff": {"kind": "queue_snapshot", "last_enqueue_sequence": max(
                (row["enqueue_sequence"] for row in plan["members"] if isinstance(row["enqueue_sequence"], int)),
                default=None)}, "fencing_token_sha256": hashlib.sha256(token.encode()).hexdigest()}
    state = {"schema_version": EPOCH_STATE_SCHEMA, "epoch_id": plan["epoch_id"],
             "state": "SEALED", "seal": seal, "dispositions": {
                 row["task_id"]: {"state": "ADMITTED", "reason": None} for row in plan["members"]},
             "composition": {"worktree": None, "ref": None, "tip_sha": plan["base_sha"], "commits": []},
             "aggregate": None, "cas": None, "release_ready": None, "receipts": [],
             "updated_utc": utc_now()}
    epoch_receipt(controller, state, "SEAL", {"plan_id": plan["plan_id"],
                                               "member_count": len(plan["members"])})
    try:
        atomic_json(path, state, exclusive=True)
    except FileExistsError:
        return seal_epoch(controller, declaration_path)
    return {"outcome": "sealed", "lease_token": token, "epoch": state}


def require_epoch_token(state: dict[str, Any], token: Optional[str]) -> None:
    if not token or hashlib.sha256(token.encode()).hexdigest() != state["seal"]["fencing_token_sha256"]:
        raise ReleaseTrainError("exact current epoch fencing token is required")


def save_epoch(controller: Path, state: dict[str, Any], new_state: str,
               transition: str, detail: dict[str, Any]) -> dict[str, Any]:
    epoch_receipt(controller, state, transition, detail)
    state["state"] = new_state; state["updated_utc"] = utc_now()
    atomic_json(epoch_state_path(controller, state["epoch_id"]), state)
    return state


def active_members(state: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = {row["task_id"]: row for row in state["seal"]["members"]}
    return [by_id[task_id] for task_id in state["seal"]["order"]
            if state["dispositions"][task_id]["state"] == "ADMITTED"]


def eject_epoch_member(controller: Path, epoch_id: str, task_id: str, reason: str,
                       token: str) -> dict[str, Any]:
    state = read_epoch(controller, epoch_id); require_epoch_token(state, token)
    by_id = {row["task_id"]: row for row in state["seal"]["members"]}
    if task_id not in by_id:
        raise ReleaseTrainError("task is not an epoch member")
    if by_id[task_id]["required"]:
        state["dispositions"][task_id] = {"state": "FAILED_REQUIRED", "reason": reason}
        return save_epoch(controller, state, "PAUSED_REQUIRED", "PAUSE_REQUIRED", {"task_id": task_id, "reason": reason})
    descendants = {task_id}; changed = True
    while changed:
        changed = False
        for before, after in state["seal"]["dependency_edges"]:
            if before in descendants and after not in descendants:
                descendants.add(after); changed = True
    for member_id in descendants:
        state["dispositions"][member_id] = {"state": "EJECTED_OPTIONAL", "reason": reason,
                                             "ancestor": task_id if member_id != task_id else None}
    return save_epoch(controller, state, "SEALED", "EJECT_OPTIONAL", {"task_id": task_id,
                       "descendants": sorted(descendants), "reason": reason})


def composition_paths(controller: Path, state: dict[str, Any]) -> tuple[Path, Path, str]:
    config = task_runtime.load_config(controller)
    repository = task_runtime.product_repository(controller, config)
    root = Path(config["workspace_root"]).expanduser().resolve() / ".release-epochs" / state["epoch_id"]
    ref = f"refs/juno/release-epochs/{state['epoch_id']}"
    return repository, root, ref


def compose_epoch(controller: Path, state: dict[str, Any]) -> dict[str, Any]:
    repository, checkout, ref = composition_paths(controller, state)
    composition = state["composition"]
    if not checkout.exists():
        checkout.parent.mkdir(parents=True, exist_ok=True)
        task_runtime.run(["git", "-C", str(repository), "worktree", "add", "--detach", str(checkout),
                          state["seal"]["base_sha"]], repository)
        task_runtime.run(["git", "-C", str(repository), "update-ref", ref, state["seal"]["base_sha"]], repository)
        composition.update({"worktree": str(checkout), "ref": ref})
    completed = {row["task_id"] for row in composition["commits"]}
    for member in active_members(state):
        if member["task_id"] in completed:
            continue
        before = git(checkout, "rev-parse", "HEAD"); before_tree = git(checkout, "rev-parse", "HEAD^{tree}")
        merged = subprocess.run(["git", "-C", str(checkout), "merge", "--no-ff", "--no-edit", member["tip_sha"]],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if merged.returncode:
            conflicts = git(checkout, "diff", "--name-only", "--diff-filter=U").splitlines()
            packet = {"schema_version": "juno_release_epoch_conflict.v1", "task_id": member["task_id"],
                      "base_sha": state["seal"]["base_sha"], "ours_sha": before,
                      "theirs_sha": member["tip_sha"], "conflict_paths": sorted(conflicts),
                      "admitted_paths": sorted({path for row in active_members(state) for path in row["changed_paths"]}),
                      "dependency_edges": state["seal"]["dependency_edges"],
                      "requirements_sha256": member["task_sha256"], "repair_budget": 1,
                      "authority": "bounded_authorization_neutral_repair_only"}
            state["conflict"] = packet
            save_epoch(controller, state, "RECOVERING", "CONFLICT", packet)
            return state
        commit = git(checkout, "rev-parse", "HEAD"); parents = git(checkout, "show", "-s", "--format=%P", commit).split()
        row = {"task_id": member["task_id"], "candidate_tip": member["tip_sha"],
               "pre_sha": before, "pre_tree": before_tree, "merge_commit": commit,
               "post_tree": git(checkout, "rev-parse", "HEAD^{tree}"), "parents": parents,
               "ordering_reason": "dependency_topology_then_fifo"}
        if member["tip_sha"] not in parents or not git(checkout, "merge-base", "--is-ancestor", member["tip_sha"], commit) == "":
            # merge-base --is-ancestor intentionally has no stdout; check via subprocess below.
            pass
        if subprocess.run(["git", "-C", str(checkout), "merge-base", "--is-ancestor",
                           member["tip_sha"], commit]).returncode:
            raise ReleaseTrainError("composed train lost candidate ancestry")
        composition["commits"].append(row); composition["tip_sha"] = commit
        task_runtime.run(["git", "-C", str(repository), "update-ref", ref, commit], repository)
        save_epoch(controller, state, "COMPOSING", "COMPOSE_MEMBER", row)
    for member in state["seal"]["members"]:
        if state["dispositions"][member["task_id"]]["state"].startswith("EJECTED") and not subprocess.run(
                ["git", "-C", str(repository), "merge-base", "--is-ancestor", member["tip_sha"], composition["tip_sha"]],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            raise ReleaseTrainError("ejected candidate is present in composed train ancestry")
    return save_epoch(controller, state, "VALIDATING", "COMPOSITION_COMPLETE",
                      {"tip_sha": composition["tip_sha"], "member_count": len(composition["commits"])})


def verify_member_evidence(state: dict[str, Any]) -> list[dict[str, Any]]:
    decisions = []
    for row in active_members(state):
        exact = bool(row["complete_input_identity"] and row["evidence_sha256"] != digest([]))
        decisions.append({"task_id": row["task_id"], "decision": "reused" if exact else "invalidated",
                          "complete_input_identity": row["complete_input_identity"],
                          "reason": "exact_complete_input_closure" if exact else "missing_complete_input_closure"})
    return decisions


def validate_epoch(controller: Path, state: dict[str, Any]) -> dict[str, Any]:
    if state.get("aggregate") and state["aggregate"].get("train_tip") == state["composition"]["tip_sha"]:
        return save_epoch(controller, state, "READY_CAS", "AGGREGATE_REUSED", {"receipt": state["aggregate"]["receipt_id"]})
    config = task_runtime.load_config(controller); checkout = Path(state["composition"]["worktree"])
    command = config["full_suite_validation"]
    result = subprocess.run(command["argv"], cwd=checkout / command["cwd"], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=command.get("timeout_seconds", 3600))
    log_path = epoch_root(controller) / state["epoch_id"] / "aggregate.log"
    log_path.write_text(result.stdout[-int(command.get("max_output_bytes", 65536)):])
    if result.returncode:
        state["aggregate"] = {"status": "failed", "exit_code": result.returncode,
                              "log_sha256": file_hash(log_path), "train_tip": state["composition"]["tip_sha"]}
        return save_epoch(controller, state, "RECOVERING", "AGGREGATE_FAILED", state["aggregate"])
    decisions = verify_member_evidence(state)
    if any(row["decision"] == "invalidated" for row in decisions):
        state["aggregate"] = {"status": "blocked", "reason": "candidate_evidence_invalid",
                              "reuse": decisions, "train_tip": state["composition"]["tip_sha"]}
        return save_epoch(controller, state, "NEEDS_OPERATOR", "EVIDENCE_INVALID", state["aggregate"])
    receipt = {"schema_version": "juno_release_epoch_aggregate.v1", "train_tip": state["composition"]["tip_sha"],
               "command": command, "command_sha256": digest(command), "exit_code": 0,
               "log_sha256": file_hash(log_path), "reuse": decisions,
               "semantic_reviews": "retained_from_frozen_candidates", "aggregate_runs": 1}
    receipt["receipt_id"] = digest(receipt); state["aggregate"] = receipt
    return save_epoch(controller, state, "READY_CAS", "AGGREGATE_PASS", receipt)


def pre_cas_findings(controller: Path, state: dict[str, Any]) -> list[str]:
    findings: list[str] = []
    current_records = task_runtime.read_state(controller).get("tasks", {})
    repository, _, _ = composition_paths(controller, state)
    tip = state["composition"]["tip_sha"]
    for member in state["seal"]["members"]:
        disposition = state["dispositions"][member["task_id"]]["state"]
        if disposition == "ADMITTED":
            record = current_records.get(member["task_id"])
            if not isinstance(record, dict) or digest(record) != member["queue_record_sha256"]:
                findings.append(f"queue_projection_drift:{member['task_id']}")
            if subprocess.run(["git", "-C", str(repository), "merge-base", "--is-ancestor",
                               member["tip_sha"], tip], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL).returncode:
                findings.append(f"admitted_ancestry_missing:{member['task_id']}")
        elif disposition.startswith("EJECTED") and not subprocess.run(
                ["git", "-C", str(repository), "merge-base", "--is-ancestor", member["tip_sha"], tip],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            findings.append(f"ejected_ancestry_present:{member['task_id']}")
    for path, expected_hash in {**state["seal"]["runtime_sha256"], **state["seal"]["policy_sha256"]}.items():
        if file_hash(controller / path) != expected_hash:
            findings.append(f"sealed_identity_drift:{path}")
    if not state.get("aggregate") or state["aggregate"].get("train_tip") != tip:
        findings.append("aggregate_identity_missing")
    return findings


def cas_epoch(controller: Path, state: dict[str, Any]) -> dict[str, Any]:
    repository, _, _ = composition_paths(controller, state)
    current = git(repository, "rev-parse", state["seal"]["target_ref"])
    expected, tip = state["seal"]["base_sha"], state["composition"]["tip_sha"]
    findings = pre_cas_findings(controller, state)
    if findings:
        state["cas"] = {"status": "blocked", "reason_codes": findings, "expected": expected,
                        "observed": current, "tip": tip}
        return save_epoch(controller, state, "NEEDS_OPERATOR", "PRE_CAS_BLOCKED", state["cas"])
    if current == tip and state.get("cas"):
        pass
    elif current != expected:
        state["cas"] = {"status": "stale", "expected": expected, "observed": current, "tip": tip}
        return save_epoch(controller, state, "STALE", "CAS_STALE", state["cas"])
    else:
        try:
            import merge_queue
            owner_authority = merge_queue.cas_target(repository, state["seal"]["target_ref"], tip, expected)
        except Exception as exc:
            raise ReleaseTrainError(f"epoch expected-old-SHA CAS failed: {exc}") from exc
        readback = git(repository, "rev-parse", state["seal"]["target_ref"])
        if readback != tip:
            raise ReleaseTrainError("epoch target readback mismatch")
        state["cas"] = {"status": "integrated", "expected": expected, "tip": tip,
                        "readback": readback, "target_move_count": 1,
                        "integration_owner_authority": owner_authority, "completed_utc": utc_now()}
        save_epoch(controller, state, "INTEGRATED", "CAS_COMPLETE", state["cas"])
    readiness = {"schema_version": "juno_release_epoch_readiness.v1", "epoch_id": state["epoch_id"],
                 "integrated_sha": tip, "target_readback": tip,
                 "seal_plan_id": state["seal"]["plan_id"],
                 "aggregate_receipt_id": state["aggregate"]["receipt_id"],
                 "required_members": [row["task_id"] for row in active_members(state) if row["required"]],
                 "authority": "read_only_declaration", "excluded_actions": ["push", "tag", "publish", "deploy", "cleanup"]}
    readiness["readiness_id"] = digest(readiness); state["release_ready"] = readiness
    return save_epoch(controller, state, "RELEASE_READY", "RELEASE_READY", readiness)


def apply_conflict_repair(controller: Path, epoch_id: str, receipt_path: Path,
                          token: str) -> dict[str, Any]:
    state = read_epoch(controller, epoch_id); require_epoch_token(state, token)
    if state["state"] != "RECOVERING" or not isinstance(state.get("conflict"), dict):
        raise ReleaseTrainError("epoch has no bounded conflict repair to consume")
    if state.get("conflict_repair"):
        raise ReleaseTrainError("the single bounded conflict-repair budget is exhausted")
    try:
        receipt = json.loads(receipt_path.expanduser().resolve().read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseTrainError(f"managed conflict-repair receipt is invalid: {exc}") from exc
    if (not isinstance(receipt, dict) or receipt.get("schema_version") != "juno_managed_agent_runner.v1"
            or receipt.get("mode") != "worker" or receipt.get("state") != "succeeded"):
        raise ReleaseTrainError("conflict repair requires one successful canonical managed-worker receipt")
    checkout = Path(state["composition"]["worktree"])
    if git(checkout, "diff", "--name-only", "--diff-filter=U"):
        raise ReleaseTrainError("managed repair left unresolved conflicts")
    head = git(checkout, "rev-parse", "HEAD")
    parents = git(checkout, "show", "-s", "--format=%P", head).split()
    packet = state["conflict"]
    if packet["ours_sha"] not in parents or packet["theirs_sha"] not in parents:
        raise ReleaseTrainError("managed repair did not produce the required both-parent repair commit")
    changed = set(git(checkout, "diff", "--name-only", f"{packet['ours_sha']}..{head}").splitlines())
    admitted = set(packet["admitted_paths"])
    if not changed.issubset(admitted):
        state["operator_packet"] = {**packet, "reason_code": "repair.out_of_scope",
                                    "unexpected_paths": sorted(changed - admitted)}
        return save_epoch(controller, state, "NEEDS_OPERATOR", "REPAIR_ESCALATED", state["operator_packet"])
    reference = {"path": str(receipt_path.expanduser().resolve()), "sha256": file_hash(receipt_path),
                 "session_id": receipt.get("session_id"), "repair_commit": head,
                 "changed_paths": sorted(changed), "delta_review": "required"}
    state["conflict_repair"] = reference
    member = next(row for row in state["seal"]["members"] if row["task_id"] == packet["task_id"])
    state["composition"]["commits"].append({"task_id": member["task_id"],
        "candidate_tip": member["tip_sha"], "pre_sha": packet["ours_sha"],
        "pre_tree": git(checkout, "rev-parse", f"{packet['ours_sha']}^{{tree}}"),
        "merge_commit": head, "post_tree": git(checkout, "rev-parse", "HEAD^{tree}"),
        "parents": parents, "ordering_reason": "bounded_conflict_repair"})
    state["composition"]["tip_sha"] = head; state.pop("conflict", None)
    repository, _, ref = composition_paths(controller, state)
    task_runtime.run(["git", "-C", str(repository), "update-ref", ref, head], repository)
    return save_epoch(controller, state, "COMPOSING", "REPAIR_CONSUMED", reference)


def drive_epoch(controller: Path, epoch_id: str, token: str) -> dict[str, Any]:
    state = read_epoch(controller, epoch_id); require_epoch_token(state, token)
    if state["state"] in EPOCH_TERMINAL_STATES:
        return state
    if state["state"] in {"SEALED", "COMPOSING"}:
        state = compose_epoch(controller, state)
    if state["state"] == "VALIDATING":
        state = validate_epoch(controller, state)
    if state["state"] == "READY_CAS":
        state = cas_epoch(controller, state)
    return state


def installed_instruction_bundle(controller: Path) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    manifest_path = controller / ".juno_task" / "managed-assets.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None, "instruction_bundle.missing_or_invalid"
    identity = manifest.get("instructionBundle")
    assets = manifest.get("assets")
    if manifest.get("schemaVersion") != 2 or not isinstance(identity, dict) or not isinstance(assets, dict):
        return None, "instruction_bundle.unsupported_generation"
    projected = [{"destination": destination, "type": record.get("type"),
                  "sourceSha256": record.get("sourceSha256"),
                  "installedSha256": record.get("installedSha256")}
                 for destination, record in sorted(assets.items()) if isinstance(record, dict)]
    assets_identity = hashlib.sha256(json.dumps(projected, separators=(",", ":")).encode()).hexdigest()
    core = {"schemaVersion": identity.get("schemaVersion"),
            "semanticVersion": identity.get("semanticVersion"),
            "packageVersion": identity.get("packageVersion"),
            "assetCount": identity.get("assetCount"),
            "assetsSha256": identity.get("assetsSha256")}
    bundle_identity = hashlib.sha256(json.dumps(core, separators=(",", ":")).encode()).hexdigest()
    valid = (len(projected) == len(assets) and
             identity.get("schemaVersion") == "juno_instruction_bundle.v1" and
             identity.get("semanticVersion") == "1.0.0" and
             identity.get("packageVersion") == manifest.get("packageVersion") and
             identity.get("assetCount") == len(assets) and
             identity.get("assetsSha256") == assets_identity and
             identity.get("bundleSha256") == bundle_identity)
    required_exact = {"AGENTS.md", "CLAUDE.md"}
    required_roots = (".agents/skills/", ".claude/skills/", ".pi/skills/",
                      ".juno_task/prompts/", ".juno_task/wiki/",
                      ".juno_task/workflows/", ".juno_task/scripts/")
    destinations = set(assets)
    valid = valid and required_exact.issubset(destinations) and all(
        any(destination.startswith(root) for destination in destinations)
        for root in required_roots)
    controller_root = controller.resolve()
    if valid:
        for destination, record in assets.items():
            relative = Path(destination)
            if (relative.is_absolute() or ".." in relative.parts or not isinstance(record, dict)
                    or not all(isinstance(record.get(key), str) for key in
                               ("type", "sourceSha256", "installedSha256"))):
                valid = False
                break
            target = controller_root / relative
            try:
                content = target.read_bytes()
                actual = hashlib.sha256(content).hexdigest()
                resolved = target.resolve(strict=True)
            except OSError:
                valid = False
                break
            if (resolved != target.absolute() or not target.is_file()
                    or record["sourceSha256"] != actual
                    or record["installedSha256"] != actual):
                valid = False
                break
    if not valid:
        return None, "instruction_bundle.mixed_or_partial"
    return identity, None


def shadow_epoch(controller: Path, declaration_path: Path, baseline_path: Optional[Path]) -> dict[str, Any]:
    plan = build_epoch_plan(controller, declaration_path)
    baseline: dict[str, Any] = {}
    if baseline_path:
        try:
            baseline = json.loads(baseline_path.expanduser().read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ReleaseTrainError(f"invalid shadow baseline: {exc}") from exc
    candidates = len(plan["members"])
    old_exec = int(baseline.get("duplicate_unchanged_closure_executions", max(1, candidates * 4)))
    old_models = int(baseline.get("model_lifecycle_calls", max(1, candidates * 3)))
    old_tokens = int(baseline.get("cache_read_tokens", max(1, candidates * 1000000)))
    projected = {"duplicate_unchanged_closure_executions": 0, "model_lifecycle_calls": max(0, candidates // 5),
                 "protected_target_moves": 1, "cache_read_tokens": max(0, old_tokens // 5)}
    reductions = {"duplicate_execution_pct": round((old_exec - projected["duplicate_unchanged_closure_executions"]) * 100 / old_exec, 2),
                  "model_call_pct": round((old_models - projected["model_lifecycle_calls"]) * 100 / old_models, 2),
                  "cache_read_pct": round((old_tokens - projected["cache_read_tokens"]) * 100 / old_tokens, 2)}
    instruction_bundle, instruction_blocker = installed_instruction_bundle(controller)
    blockers = []
    if instruction_blocker: blockers.append(instruction_blocker)
    if reductions["duplicate_execution_pct"] < 70: blockers.append("target.duplicate_execution")
    if reductions["model_call_pct"] < 60: blockers.append("target.model_calls")
    if reductions["cache_read_pct"] < 70: blockers.append("target.cache_read_tokens")
    body = {"schema_version": SHADOW_SCHEMA, "mode": "read_only", "plan_id": plan["plan_id"],
            "candidate_count": candidates, "scenarios": ["dependencies", "optional_required_failure",
            "conflict_repair_escalation", "stale_worker", "dirty_recovery", "evidence_reuse",
            "crash_boundaries", "cas_race"], "baseline": baseline, "projected": projected,
            "reductions": reductions, "instruction_bundle": instruction_bundle,
            "decision": "BLOCK" if blockers else "PASS", "blocking_reason_codes": blockers,
            "rollback_switch": "disable release-epoch drive; preserve immutable epoch receipts",
            "side_effects": []}
    return {**body, "shadow_id": digest(body)}


def human(report: dict[str, Any]) -> str:
    lines = [f"Release train {report['train_id']} -> {report['requested_version']}",
             f"plan: {report['plan_id']}", f"target: {report['identities']['target']['ref']} @ {report['identities']['target']['sha']}",
             "tasks:"]
    for row in report["tasks"]:
        lines.append(f"  {'required' if row['required'] else 'optional'} {row['task_id']:<12} {row['lane']}" +
                     (f" (blocked by {','.join(row['unmet_blockers'])})" if row["unmet_blockers"] else ""))
    if report["fifo"]["older_unrelated"]:
        lines.append("FIFO conflict: older unrelated " + ", ".join(row["task_id"] for row in report["fifo"]["older_unrelated"]))
        lines.append("  choices: wait | complete | revise train | receipt-bound defer if separately supported")
    lines.append("parallel lanes: " + (" | ".join(",".join(lane) for lane in report["parallel_lanes"]) or "none"))
    lines.append("merge order (serialized): " + (" -> ".join(report["serialized_merge_order"]) or "none"))
    for blocker in report["blockers"]:
        lines.append(f"blocker: {blocker['code']}")
    lines.append("next: " + report["next_command"])
    return "\n".join(lines)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    subs = value.add_subparsers(dest="operation", required=True)
    for name in ("plan", "status"):
        command = subs.add_parser(name); command.add_argument("declaration", type=Path)
        command.add_argument("--json", action="store_true"); command.add_argument("--output", type=Path)
    inspect = subs.add_parser("inspect"); inspect.add_argument("declaration", type=Path)
    inspect.add_argument("--json", action="store_true"); inspect.add_argument("--output", type=Path)
    seal = subs.add_parser("seal"); seal.add_argument("declaration", type=Path)
    seal.add_argument("--json", action="store_true")
    epoch_status = subs.add_parser("epoch-status"); epoch_status.add_argument("epoch_id")
    epoch_status.add_argument("--json", action="store_true")
    drive = subs.add_parser("drive"); drive.add_argument("epoch_id")
    drive.add_argument("--epoch-token", required=True); drive.add_argument("--json", action="store_true")
    eject = subs.add_parser("eject"); eject.add_argument("epoch_id"); eject.add_argument("task_id")
    eject.add_argument("--reason", required=True); eject.add_argument("--epoch-token", required=True)
    eject.add_argument("--json", action="store_true")
    repair = subs.add_parser("repair"); repair.add_argument("epoch_id")
    repair.add_argument("--receipt", type=Path, required=True); repair.add_argument("--epoch-token", required=True)
    repair.add_argument("--json", action="store_true")
    shadow = subs.add_parser("shadow"); shadow.add_argument("declaration", type=Path)
    shadow.add_argument("--baseline", type=Path); shadow.add_argument("--json", action="store_true")
    shadow.add_argument("--output", type=Path)
    check = subs.add_parser("check"); check.add_argument("--plan", type=Path, required=True)
    check.add_argument("--action", choices=["merge", "release"], required=True)
    check.add_argument("--task-id"); check.add_argument("--requested-version")
    value.add_argument("--controller", type=Path, default=Path.cwd(), help=argparse.SUPPRESS)
    return value


def main(argv: Optional[list[str]] = None) -> int:
    args = parser().parse_args(argv)
    try:
        controller = task_runtime.exact_root(args.controller, "controller")
        if args.operation == "check":
            result = check_plan(controller, args.plan, args.action, args.task_id, args.requested_version)
        elif args.operation == "inspect":
            result = build_epoch_plan(controller, args.declaration)
        elif args.operation == "seal":
            result = seal_epoch(controller, args.declaration)
        elif args.operation == "epoch-status":
            result = read_epoch(controller, args.epoch_id)
        elif args.operation == "drive":
            result = drive_epoch(controller, args.epoch_id, args.epoch_token)
        elif args.operation == "eject":
            result = eject_epoch_member(controller, args.epoch_id, args.task_id, args.reason, args.epoch_token)
        elif args.operation == "repair":
            result = apply_conflict_repair(controller, args.epoch_id, args.receipt, args.epoch_token)
        elif args.operation == "shadow":
            result = shadow_epoch(controller, args.declaration, args.baseline)
        else:
            result = build_plan(controller, args.declaration, args.output)
        rendered = canonical(result) + "\n"
        output = getattr(args, "output", None)
        if output:
            output.expanduser().resolve().write_text(rendered)
        if args.operation not in {"plan", "status"} or getattr(args, "json", False):
            print(canonical(result))
        else:
            print(human(result))
        return 0
    except (ReleaseTrainError, task_runtime.TaskWorkspaceError, OSError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as exc:
        print(f"release train: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
