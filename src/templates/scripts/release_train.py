#!/usr/bin/env python3
"""Deterministic, offline release-train projection and stale-plan gate."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

import task_workspace as task_runtime

DECLARATION_SCHEMA = "juno_release_train_declaration.v1"
REPORT_SCHEMA = "juno_release_train_plan.v1"
IDENTITY_SCHEMA = "juno_release_train_plan_identity.v1"
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
        else:
            result = build_plan(controller, args.declaration, args.output)
            rendered = canonical(result) + "\n"
            if args.output:
                args.output.expanduser().resolve().write_text(rendered)
            print(canonical(result) if args.json else human(result))
        return 0
    except (ReleaseTrainError, task_runtime.TaskWorkspaceError, OSError, json.JSONDecodeError) as exc:
        print(f"release train: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
