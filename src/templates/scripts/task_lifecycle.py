#!/usr/bin/env python3
"""Task-derived root/direct-child lifecycle (Glow generation).

The three public operations accept only a Kanban task identity.  Project policy
is versioned in ``.juno_task/config/lifecycle.json`` and the first run freezes a
complete immutable plan.  Tests and this implementation are intentionally
co-owned: the implementation enforces authority and transition boundaries;
real-Git tests prove ordering, resumability, and review immutability against the
bytes users actually execute.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

CONFIG_SCHEMA = "juno_task_lifecycle_config.v2"
PLAN_SCHEMA = "juno_task_lifecycle_plan.v2"
STATE_SCHEMA = "juno_task_lifecycle_state.v2"
ATTEMPT_SCHEMA = "juno_task_lifecycle_attempt.v2"
RESULT_SCHEMA = "juno_task_lifecycle_result.v2"
GATE_SCHEMA = "juno_task_lifecycle_candidate_gate.v2"
REVIEW_SCHEMA = "juno_task_lifecycle_review.v2"
MAX_CAPTURE_BYTES = 64 * 1024
TASK_RE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
HIGH_PARTS = (".juno_task/scripts/", "src/templates/scripts/", "package", "lifecycle", "integration", "release", "security")
DELIVERY_PARTS = ("src/templates/", "dist/", "package.json", "package-lock.json", "migration", "runtime", "authorization")
PHASES = (
    "PLANNED", "PREPARED", "WORKTREES_ADMITTED", "IMPLEMENTING", "CANDIDATE_COMPOSED",
    "CANDIDATE_GATE_PASSED", "REVIEW_READY_CHECKPOINTED", "REVIEWING", "REVIEWED_PASS",
    "REPAIR_REQUIRED", "REVIEW_BUDGET_EXHAUSTED", "REVIEW_WAIVED_BY_OWNER", "READY_TO_INTEGRATE",
    "INTEGRATING", "PARTIAL_INTEGRATION", "INTEGRATED", "ACTUAL_TARGET_VERIFIED",
    "ACTUAL_TARGET_REVIEWED", "ACTUAL_TARGET_REVIEW_NOT_REQUIRED", "ACTUAL_TARGET_REVIEW_WAIVED_BY_OWNER",
    "CONTROLLER_SYNCED", "TERMINAL_CHECKPOINTED", "CLEANUP_COMPLETE", "COMPLETE",
)
TERMINAL = {"COMPLETE", "REVIEW_BUDGET_EXHAUSTED"}
REVIEW_ENV_BLOCKED = frozenset({
    "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROJECT_PATH",
    "PI_THINKING", "PI_AUTO_INSTRUCTION", "PI_SYSTEM_PROMPT", "PI_APPEND_SYSTEM_PROMPT", "PI_TOOLS",
    "PI_NO_SESSION", "PI_PRETTY", "PI_VERBOSE", "JUNO_MODEL", "JUNO_PROJECT_PATH",
    "JUNO_SUBAGENT_CAPTURE_PATH", "JUNO_TOOL_ID", "TASK_ROOT", "JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH",
    "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT",
})
REVIEW_ENV_SET = frozenset({
    "JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT",
    "JUNO_SUBAGENT_CAPTURE_PATH", "JUNO_TOOL_ID",
})
WORKER_ENV_SET = frozenset({
    "TASK_ROOT", "JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE",
    "JUNO_WORKSPACE_ENFORCEMENT", "JUNO_LIFECYCLE_AUTHORITY_MAP", "JUNO_SUBAGENT_CAPTURE_PATH", "JUNO_TOOL_ID",
})


class LifecycleError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = canonical_bytes(value)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
        handle.write(data); handle.flush(); os.fsync(handle.fileno()); temporary = Path(handle.name)
    os.replace(temporary, path)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise LifecycleError(f"mapping required: {path}")
    return value


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, stdin=subprocess.DEVNULL)
    if check and result.returncode:
        raise LifecycleError(f"git {shlex.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def git_common(repo: Path) -> str:
    return str((repo / git(repo, "rev-parse", "--git-common-dir")).resolve())


def full_ref(value: Any, label: str) -> str:
    text = str(value or "")
    if not text.startswith("refs/heads/") or any(c in text for c in " \t\r\n~^:?*[\\"):
        raise LifecycleError(f"{label} must be a full safe refs/heads/... name")
    return text


def safe_relative(value: Any, label: str) -> str:
    text = str(value or "")
    path = Path(text)
    if not text or path.is_absolute() or ".." in path.parts or text != path.as_posix() or any(ord(c) < 32 for c in text):
        raise LifecycleError(f"{label} must be an exact safe relative path")
    return text


def safe_task(task_id: str) -> str:
    if not TASK_RE.fullmatch(task_id):
        raise LifecycleError("task ID is missing or invalid")
    return task_id


def bounded(value: str) -> tuple[str, bool]:
    data = value.encode(errors="replace")
    return (value, False) if len(data) <= MAX_CAPTURE_BYTES else (data[-MAX_CAPTURE_BYTES:].decode(errors="replace"), True)


def run_command(command: list[str] | str, cwd: Path, artifact: Path, timeout: float, env: dict[str, str] | None = None) -> dict[str, Any]:
    if isinstance(command, list) and command and all(isinstance(x, str) and x for x in command):
        argv: Any = command; shell = False; display = shlex.join(command)
    elif isinstance(command, str) and command.strip():
        argv = command; shell = True; display = command
    else:
        raise LifecycleError("command must be a non-empty argv list or string")
    started = time.monotonic(); timed_out = False
    try:
        result = subprocess.run(argv, cwd=cwd, env=env, shell=shell, text=True, capture_output=True,
                                stdin=subprocess.DEVNULL, timeout=timeout)
        code, stdout, stderr = result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired as exc:
        timed_out = True; code = None
        stdout = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
    stdout, out_cut = bounded(stdout); stderr, err_cut = bounded(stderr)
    artifact.mkdir(parents=True, exist_ok=True)
    (artifact / "stdout.txt").write_text(stdout, encoding="utf-8"); (artifact / "stderr.txt").write_text(stderr, encoding="utf-8")
    receipt = {"command_sha256": hashlib.sha256(display.encode()).hexdigest(), "cwd": str(cwd.resolve()),
               "exit_code": code, "timed_out": timed_out, "elapsed_seconds": round(time.monotonic() - started, 3),
               "stdout": {"path": str((artifact / "stdout.txt").resolve()), "sha256": file_digest(artifact / "stdout.txt"), "truncated": out_cut},
               "stderr": {"path": str((artifact / "stderr.txt").resolve()), "sha256": file_digest(artifact / "stderr.txt"), "truncated": err_cut}}
    atomic_json(artifact / "receipt.json", receipt)
    return {**receipt, "stdout_text": stdout, "stderr_text": stderr}


def project_root(start: Path) -> Path:
    root = Path(git(start.resolve(), "rev-parse", "--show-toplevel"))
    if not (root / ".juno_task").is_dir():
        raise LifecycleError("project root lacks .juno_task")
    return root


def namespace(root: Path, task_id: str) -> Path:
    # Durable operational evidence belongs to Git-common metadata, not product/controller dirt.
    base = Path(git_common(root)) / "juno-lifecycle" / "tasks"
    path = base / safe_task(task_id)
    base.mkdir(parents=True, exist_ok=True)
    if base.is_symlink() or path.is_symlink():
        raise LifecycleError("lifecycle namespace symlinks are forbidden")
    if path.exists() and not path.is_dir():
        raise LifecycleError("lifecycle namespace collision")
    return path


def kanban_task(root: Path, task_id: str) -> dict[str, Any]:
    wrapper = root / ".juno_task/scripts/kanban.sh"
    if not wrapper.is_file():
        raise LifecycleError("local Kanban wrapper is missing")
    result = subprocess.run([str(wrapper), "get", task_id], cwd=root, text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
    if result.returncode:
        raise LifecycleError("task lookup failed: " + result.stderr.strip()[-2000:])
    try: value = json.loads(result.stdout)
    except json.JSONDecodeError as exc: raise LifecycleError("task lookup returned invalid JSON") from exc
    if not isinstance(value, list) or len(value) != 1 or value[0].get("id") != task_id:
        raise LifecycleError("task lookup is missing or ambiguous")
    return value[0]


def objective_risk(paths: list[str], declared: str, escalation: Any) -> tuple[str, str]:
    if declared not in RISK_ORDER:
        raise LifecycleError("objective risk must be low, medium, or high")
    lowered = [x.lower() for x in paths]
    deterministic = "high" if not paths or any(any(part in x for part in HIGH_PARTS) for x in lowered) else (
        "low" if all(x.endswith((".md", ".txt")) for x in lowered) else "medium")
    minimum = max(RISK_ORDER[declared], RISK_ORDER[deterministic])
    if escalation is not None:
        if escalation not in RISK_ORDER or RISK_ORDER[escalation] < minimum:
            raise LifecycleError("owner risk may escalate but cannot downgrade objective minimum")
        minimum = RISK_ORDER[escalation]
    return deterministic, next(k for k, v in RISK_ORDER.items() if v == minimum)


def validate_config(config: dict[str, Any], root: Path) -> dict[str, Any]:
    if config.get("schema_version") != CONFIG_SCHEMA:
        raise LifecycleError(f"lifecycle config must use {CONFIG_SCHEMA}")
    topologies = config.get("topologies")
    repositories = config.get("repositories")
    if not isinstance(topologies, dict) or not topologies or not isinstance(repositories, dict) or not repositories:
        raise LifecycleError("lifecycle config requires repository registry and topologies")
    normalized = json.loads(json.dumps(config))
    for repo_id, item in normalized["repositories"].items():
        if not TASK_RE.fullmatch(repo_id) or not isinstance(item, dict): raise LifecycleError("invalid repository registry entry")
        item["path"] = str((root / str(item.get("path", "."))).resolve()) if not Path(str(item.get("path", "."))).is_absolute() else str(Path(item["path"]).resolve())
        item["target_ref"] = full_ref(item.get("target_ref"), f"repositories.{repo_id}.target_ref")
        item["expected_paths"] = sorted({safe_relative(x, f"repositories.{repo_id}.expected_paths") for x in item.get("expected_paths", [])})
    for name, topology in normalized["topologies"].items():
        if not isinstance(topology, dict) or topology.get("root") not in repositories: raise LifecycleError(f"topology {name} has invalid root")
        children = topology.get("children", [])
        if not isinstance(children, list) or len(children) != len(set(children)) or any(x not in repositories for x in children):
            raise LifecycleError(f"topology {name} has missing or duplicate children")
        if topology["root"] in children: raise LifecycleError("root cannot be its own child")
        permitted = {topology["root"], *children}
        for child in children:
            parent = normalized["repositories"][child].get("parent")
            if parent != topology["root"]: raise LifecycleError("deeper or ambiguous repository nesting is unsupported")
            mount = normalized["repositories"][child].get("mount_path")
            if mount is not None: normalized["repositories"][child]["mount_path"] = safe_relative(mount, f"repositories.{child}.mount_path")
        for repo_id in permitted:
            parent = normalized["repositories"][repo_id].get("parent")
            if repo_id == topology["root"] and parent is not None: raise LifecycleError("topology root must not have a parent")
            if parent is not None and parent not in permitted: raise LifecycleError("deeper repository nesting is unsupported")
    default = normalized.get("default_topology")
    if default not in topologies: raise LifecycleError("default_topology is missing or unknown")
    return normalized


def derive_plan(root: Path, task: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    fields = task.get("fields") if isinstance(task.get("fields"), dict) else {}
    request = fields.get("lifecycle") if isinstance(fields.get("lifecycle"), dict) else {}
    topology_name = request.get("topology", config["default_topology"])
    topology = config["topologies"].get(topology_name)
    if not isinstance(topology, dict): raise LifecycleError("task selects an unknown topology")
    ids = [topology["root"], *topology.get("children", [])]
    overrides = request.get("repositories", {})
    if not isinstance(overrides, dict) or any(x not in ids for x in overrides): raise LifecycleError("task repository selection is ambiguous")
    repos = []
    all_paths: list[str] = []
    task_id = safe_task(str(task.get("id") or ""))
    workspace_root = Path(config.get("workspace_root") or (root.parent / "juno-lifecycle-worktrees")).expanduser().resolve() / task_id
    for repo_id in ids:
        base = config["repositories"][repo_id]; override = overrides.get(repo_id, {})
        if not isinstance(override, dict): raise LifecycleError("repository task override must be a mapping")
        allowed = {"expected_paths", "future_paths"}
        if any(k not in allowed for k in override): raise LifecycleError("task may select paths but cannot override repository identity or refs")
        existing = [safe_relative(x, f"{repo_id}.expected_paths") for x in override.get("expected_paths", base.get("expected_paths", []))]
        future = [safe_relative(x, f"{repo_id}.future_paths") for x in override.get("future_paths", [])]
        paths = sorted(set(existing + future))
        if not paths: raise LifecycleError(f"repository {repo_id} has no admitted paths")
        repo_path = Path(base["path"]).resolve()
        target = git(repo_path, "rev-parse", f"{base['target_ref']}^{{commit}}")
        if not SHA_RE.fullmatch(target): raise LifecycleError("target did not resolve to a commit")
        dispositions = {}
        for item in paths:
            # Sparse controllers intentionally omit product bytes.  Admission is
            # derived from the frozen target tree, never controller materialization.
            exists_at_target = subprocess.run(["git", "-C", str(repo_path), "cat-file", "-e", f"{target}:{item}"],
                                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            dispositions[item] = "existing" if exists_at_target else "future"
            if exists_at_target and item in future: raise LifecycleError(f"declared future path already exists: {repo_id}:{item}")
        repo = {"id": repo_id, "role": "root" if repo_id == topology["root"] else "child", "parent": base.get("parent"),
                "mount_path": base.get("mount_path"), "path": str(repo_path), "git_common_dir": git_common(repo_path),
                "target_ref": base["target_ref"], "approved_base_sha": target, "task_worktree": str(workspace_root / repo_id),
                "task_branch_ref": f"refs/heads/juno/task-{task_id}-{repo_id}", "expected_paths": paths,
                "path_dispositions": dispositions}
        repos.append(repo); all_paths.extend(f"{repo_id}:{x}" for x in paths)
    if len({r["git_common_dir"] for r in repos}) != len(repos): raise LifecycleError("repository identities are ambiguous or duplicated")
    declared = request.get("objective_risk", config.get("objective_risk", "high"))
    deterministic, effective = objective_risk(all_paths, declared, request.get("owner_risk_escalation"))
    validation = config.get("candidate_gate", {}).get("rows", [])
    if not isinstance(validation, list) or not validation: raise LifecycleError("candidate gate matrix must be non-empty")
    plan = {"schema_version": PLAN_SCHEMA, "task_id": task_id, "task_last_modified": task.get("last_modified"),
            "controller_root": str(root), "controller_branch": git(root, "symbolic-ref", "--quiet", "HEAD"),
            "expected_controller_head": git(root, "rev-parse", "HEAD"), "topology": topology_name,
            "root_repository": topology["root"], "repositories": repos, "objective_risk": declared,
            "deterministic_risk": deterministic, "effective_risk": effective, "candidate_gate": validation,
            "review_policy": {"round_limit": 2, "reviewers": ["A", "B"] if effective == "high" else ["A"]},
            "authorization_exclusions": ["push", "publication", "deployment", "production mutation", "restart", "post-deploy E2E"],
            "created_at": utc_now()}
    plan["plan_sha256"] = digest(plan)
    return plan


def state_without_hash(state: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in state.items() if k != "state_sha256"}


def load_state(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if value.get("schema_version") != STATE_SCHEMA or value.get("state_sha256") != digest(state_without_hash(value)):
        raise LifecycleError("lifecycle state schema/hash mismatch")
    return value


def append_attempt(ns: Path, state: dict[str, Any], phase: str, status: str, detail: dict[str, Any] | None = None) -> None:
    attempts = ns / "attempts"; attempts.mkdir(parents=True, exist_ok=True)
    number = state.get("attempt_count", 0) + 1
    previous = state.get("last_attempt_sha256")
    value = {"schema_version": ATTEMPT_SCHEMA, "attempt_id": f"{number:06d}", "parent_attempt": f"{number-1:06d}" if number > 1 else None,
             "task_id": state["task_id"], "phase": phase, "candidate_generation": state.get("candidate_generation", 0),
             "status": status, "failure_class": None if status == "passed" else (detail or {}).get("failure_class", "operation_failed"),
             "next_permitted_operation": state.get("next_permitted_action"), "repository_heads": state.get("candidate_shas", {}),
             "expected_controller_head": state.get("expected_controller_head"), "previous_attempt_sha256": previous,
             "summary": detail or {}, "created_at": utc_now()}
    value["attempt_sha256"] = digest(value)
    atomic_json(attempts / f"{number:06d}.json", value)
    state["attempt_count"] = number; state["last_attempt_sha256"] = value["attempt_sha256"]


def save_state(ns: Path, state: dict[str, Any], phase: str, status: str = "passed", detail: dict[str, Any] | None = None) -> None:
    if phase not in PHASES: raise LifecycleError(f"unsupported phase {phase}")
    state["phase"] = phase; state["updated_at"] = utc_now(); state["last_error"] = None if status == "passed" else (detail or {}).get("error")
    append_attempt(ns, state, phase, status, detail)
    state["state_sha256"] = digest(state_without_hash(state)); atomic_json(ns / "state.json", state)


def verify_attempt_chain(ns: Path, state: dict[str, Any]) -> None:
    previous = None; files = sorted((ns / "attempts").glob("*.json")) if (ns / "attempts").is_dir() else []
    for index, path in enumerate(files, 1):
        value = load_json(path); claimed = value.pop("attempt_sha256", None)
        if value.get("schema_version") != ATTEMPT_SCHEMA or value.get("attempt_id") != f"{index:06d}" or value.get("previous_attempt_sha256") != previous or digest(value) != claimed:
            raise LifecycleError("attempt hash chain is invalid")
        previous = claimed
    if len(files) != state.get("attempt_count") or previous != state.get("last_attempt_sha256"):
        raise LifecycleError("attempt index disagrees with state")


def fingerprint(repo: Path) -> dict[str, str]:
    return {"head": git(repo, "rev-parse", "HEAD"), "tracked_staged_untracked": git(repo, "status", "--porcelain=v2", "--untracked-files=all")}


def worktree_identity(repo: Path) -> dict[str, Any]:
    status = git(repo, "status", "--porcelain=v2", "--untracked-files=all")
    conflicts = sorted(filter(None, git(repo, "diff", "--name-only", "--diff-filter=U").splitlines()))
    branch = git(repo, "symbolic-ref", "HEAD", check=False)
    return {"root": str(repo.resolve()), "head": git(repo, "rev-parse", "HEAD"), "branch_ref": branch,
            "git_common_dir": git_common(repo), "index_sha256": hashlib.sha256(git(repo, "ls-files", "--stage").encode()).hexdigest(),
            "tracked_staged_untracked": status, "conflicts": conflicts, "clean": not status and not conflicts}


def changed_paths(repo: Path, base: str, tip: str) -> list[str]:
    return sorted(set(filter(None, git(repo, "diff", "--name-only", base, tip).splitlines())))


def prepare_worktrees(plan: dict[str, Any], ns: Path, state: dict[str, Any]) -> None:
    # Complete preflight happens before the first mutation.
    for repo in plan["repositories"]:
        source = Path(repo["path"]); target = git(source, "rev-parse", repo["target_ref"])
        if target != repo["approved_base_sha"]: raise LifecycleError(f"exact-base moved before prepare: {repo['id']}")
        branch_probe = subprocess.run(["git", "-C", str(source), "show-ref", "--verify", "--quiet", repo["task_branch_ref"]],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if Path(repo["task_worktree"]).exists() or branch_probe.returncode == 0:
            raise LifecycleError(f"worktree/branch collision: {repo['id']}")
        if branch_probe.returncode not in {0, 1}:
            raise LifecycleError(f"branch collision preflight failed: {repo['id']}")
        for path, disposition in repo["path_dispositions"].items():
            exists_at_base = subprocess.run(["git", "-C", str(source), "cat-file", "-e", f"{repo['approved_base_sha']}:{path}"],
                                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            actual = "existing" if exists_at_base else "future"
            if actual != disposition: raise LifecycleError(f"path disposition changed: {repo['id']}:{path}")
    save_state(ns, state, "PREPARED")
    created: list[dict[str, Any]] = []
    try:
        import worktree_lifecycle
        repository_receipts = []
        for repo in plan["repositories"]:
            task = Path(repo["task_worktree"]); task.parent.mkdir(parents=True, exist_ok=True)
            create_receipt = ns / f"worktree-create-{repo['id']}.json"
            create_args = argparse.Namespace(repository=Path(repo["path"]), target_ref=repo["target_ref"], expected_base=repo["approved_base_sha"],
                fetch=None, path=task, branch_ref=repo["task_branch_ref"], task_id=plan["task_id"], expected_path=repo["expected_paths"],
                validation_command=[], sparse=False, sparse_tooling_path=[], cleanup_owner=f"lifecycle:{plan['task_id']}",
                hard_min_free_bytes=None, output=create_receipt)
            worktree_lifecycle.create(create_args)
            repository_receipts.append({"id": repo["id"], "path": str(create_receipt), "sha256": file_digest(create_receipt)})
            created.append(repo)
        receipt = {"schema_version": "juno_composite_admission.v2", "passed": True, "task_id": plan["task_id"],
                   "plan_sha256": plan["plan_sha256"], "repositories": [{"id": r["id"], "worktree": r["task_worktree"], "base": r["approved_base_sha"],
                       "paths": r["path_dispositions"], "create_receipt": next(x for x in repository_receipts if x["id"] == r["id"])} for r in plan["repositories"]]}
        atomic_json(ns / "prepare.json", receipt); state["receipts"]["prepare"] = {"path": str(ns / "prepare.json"), "sha256": file_digest(ns / "prepare.json")}
        save_state(ns, state, "WORKTREES_ADMITTED")
    except Exception:
        # Roll back only exact clean helper-created worktrees, in child-first order.
        for repo in reversed(created):
            task = Path(repo["task_worktree"])
            if task.exists() and fingerprint(task) == {"head": repo["approved_base_sha"], "tracked_staged_untracked": ""}:
                subprocess.run(["git", "-C", repo["path"], "worktree", "remove", str(task)], stdin=subprocess.DEVNULL)
                subprocess.run(["git", "-C", repo["path"], "update-ref", "-d", repo["task_branch_ref"], repo["approved_base_sha"]], stdin=subprocess.DEVNULL)
        raise


def worker_authority(plan: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    prepare = state.get("receipts", {}).get("prepare", {})
    prepare_value = load_json(Path(prepare["path"])) if prepare.get("path") else {}
    create_receipts = {x.get("id"): x.get("create_receipt") for x in prepare_value.get("repositories", []) if isinstance(x, dict)}
    return {"schema_version": "juno_multi_root_worker_authority.v3", "task_id": plan["task_id"], "max_sequential_workers": 3,
            "concurrent_product_workers": False, "controller_root": str(Path(plan["controller_root"]).resolve()),
            "controller_branch": plan["controller_branch"], "plan_sha256": plan["plan_sha256"],
            "prepare_receipt": prepare, "repositories": [{"id": r["id"], "root": str(Path(r["task_worktree"]).resolve()),
            "branch_ref": r["task_branch_ref"], "git_common_dir": r["git_common_dir"], "approved_base_sha": r["approved_base_sha"],
            "paths": r["expected_paths"], "path_dispositions": r["path_dispositions"], "create_receipt": create_receipts.get(r["id"])}
            for r in plan["repositories"]], "forbidden": ["reviewer or canary dispatch", "target integration", "cutover", "cleanup",
            "release", "push", "publication", "deployment"]}


def product_dispatch_preflight(root: Path, operation: str, artifact: Path, *, role: str = "task", require_clean: bool = False) -> None:
    script = root / ".juno_task/scripts/controller_workspace.py"
    if not script.is_file(): raise LifecycleError("managed product dispatch authority is missing from TASK_ROOT")
    argv = [sys.executable, str(script), "dispatch-preflight", "--task-root", str(root), "--cwd", str(Path.cwd()),
            "--operation", operation, "--allow-role", role, "--explicit", "--output", str(artifact)]
    if require_clean: argv.append("--require-clean")
    result = subprocess.run(argv, cwd=root, text=True, capture_output=True, stdin=subprocess.DEVNULL)
    if result.returncode: raise LifecycleError(f"managed {operation} dispatch refused before launch: {result.stderr.strip()}")


def dispatch_worker(plan: dict[str, Any], ns: Path, state: dict[str, Any], repair: bool = False) -> None:
    count = state.get("worker_count", 0)
    if count >= 3: raise LifecycleError("sequential worker limit exhausted")
    number = count + 1; kind = "repair" if repair else "implementation"
    artifact = ns / f"worker-{number}"
    if artifact.exists(): raise LifecycleError("worker artifact/capture collision")
    artifact.mkdir(parents=True)
    authority = worker_authority(plan, state); authority_path = artifact / "authority-map.json"; atomic_json(authority_path, authority)
    authority_evidence = {"path": str(authority_path.resolve()), "sha256": file_digest(authority_path)}
    repair_evidence = None
    if repair:
        repair_path = (ns / "repair-packet.json").resolve()
        if not repair_path.is_file(): raise LifecycleError("immutable repair packet is missing")
        repair_evidence = {"path": str(repair_path), "sha256": file_digest(repair_path)}
    root_repo = next(r for r in plan["repositories"] if r["id"] == plan["root_repository"])
    controller = Path(plan["controller_root"]).resolve(); controller_before = controller_fingerprint(controller)
    if controller_before["tracked_staged_untracked"]: raise LifecycleError("worker controller is dirty")
    before: dict[str, Any] = {}
    for repo in plan["repositories"]:
        task = Path(repo["task_worktree"]).resolve()
        product_dispatch_preflight(task, "edit", artifact / f"{repo['id']}-dispatch-preflight.json")
        mark = worktree_identity(task)
        if mark["branch_ref"] != repo["task_branch_ref"] or mark["git_common_dir"] != repo["git_common_dir"] or not mark["clean"]:
            raise LifecycleError(f"worker pre-dispatch identity/clean refusal: {repo['id']}")
        if subprocess.run(["git", "-C", str(task), "merge-base", "--is-ancestor", repo["approved_base_sha"], mark["head"]],
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            raise LifecycleError(f"worker pre-dispatch HEAD is not descended from approved base: {repo['id']}")
        before[repo["id"]] = mark
    prompt = (f"Managed lifecycle worker. Task ID: {plan['task_id']}. Worker kind: {kind}.\n"
              f"Immutable authority map: {authority_path.resolve()} sha256={authority_evidence['sha256']}\n"
              f"Exact registered root task worktree: {Path(root_repo['task_worktree']).resolve()}\n"
              f"Exact authority: {json.dumps(authority, sort_keys=True)}\n"
              f"Repair packet: {json.dumps(repair_evidence, sort_keys=True) if repair_evidence else 'not-applicable'}\n"
              "Edit only admitted paths. Create coherent descendant commits and leave every task worktree clean. "
              "Do not dispatch workers/reviewers/canaries, integrate targets, cut over, clean worktrees, release, push, publish, deploy, or mutate the controller.\n")
    prompt_file = artifact / "prompt.md"; prompt_file.write_bytes(prompt.encode("utf-8")); prompt_before = exact_prompt_evidence(prompt_file, prompt, "worker")
    capture = artifact / "capture.json"; launcher_cwd = neutral_directory(artifact / "launcher-cwd")
    agent_root = Path(root_repo["task_worktree"]).resolve()
    tool_id = f"lifecycle_worker_{plan['task_id']}_{number}_{kind}_{hashlib.sha256(str(artifact).encode()).hexdigest()[:12]}"
    env, environment_contract = managed_agent_environment(controller, plan["controller_branch"], capture, tool_id,
        {"TASK_ROOT": str(agent_root), "JUNO_WORKSPACE_ROLE": "task", "JUNO_LIFECYCLE_AUTHORITY_MAP": str(authority_path.resolve())}, "worker")
    command = canonical_managed_command(controller, agent_root, prompt_file, plan.get("worker_command"), "worker")
    command_sha256 = hashlib.sha256(shlex.join(command).encode()).hexdigest()
    save_state(ns, state, "IMPLEMENTING")
    started_ns = time.time_ns()
    result = run_command(command, launcher_cwd, artifact / "process", 7200, env)
    process_receipt = load_json(artifact / "process/receipt.json")
    if process_receipt.get("command_sha256") != command_sha256 or process_receipt.get("cwd") != str(launcher_cwd):
        raise LifecycleError("worker process provenance is malformed")
    prompt_after = exact_prompt_evidence(prompt_file, prompt, "worker")
    if prompt_before != prompt_after: raise LifecycleError("worker prompt changed during dispatch")
    if result["timed_out"] or result["exit_code"] != 0: raise LifecycleError("implementation worker process failed")
    if not capture.is_file() or capture.stat().st_mtime_ns < started_ns: raise LifecycleError("worker capture is missing or stale")
    payload = load_json(capture); session = str(payload.get("session_id") or "").strip(); response = payload.get("result")
    prior_sessions = set(state.get("worker_sessions", [])) | {str(x.get("session_id")) for x in state.get("worker_launches", []) if x.get("session_id")}
    for old_receipt in ns.glob("worker-*/receipt.json"):
        if old_receipt != artifact / "receipt.json": prior_sessions.add(str(load_json(old_receipt).get("session_id") or ""))
    if not session or session in prior_sessions or not isinstance(response, str):
        raise LifecycleError("worker session is missing, duplicate, stale, or response is unbound")
    after: dict[str, Any] = {}; audits: dict[str, Any] = {}; committed = False
    for repo in plan["repositories"]:
        task = Path(repo["task_worktree"]).resolve(); mark = worktree_identity(task); old = before[repo["id"]]
        if mark["branch_ref"] != repo["task_branch_ref"] or mark["git_common_dir"] != repo["git_common_dir"]:
            raise LifecycleError(f"worker changed branch/common directory: {repo['id']}")
        if not mark["clean"]: raise LifecycleError(f"worker left dirty/conflicted residue: {repo['id']}")
        if subprocess.run(["git", "-C", str(task), "merge-base", "--is-ancestor", old["head"], mark["head"]],
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            raise LifecycleError(f"worker rewrote or produced non-descendant HEAD: {repo['id']}")
        paths = changed_paths(task, repo["approved_base_sha"], mark["head"])
        unexpected = [x for x in paths if not any(x == p or x.startswith(p.rstrip("/") + "/") for p in repo["expected_paths"])]
        if unexpected: raise LifecycleError(f"worker changed paths outside authority for {repo['id']}: {','.join(unexpected)}")
        committed = committed or mark["head"] != old["head"]
        after[repo["id"]] = mark; audits[repo["id"]] = {"approved_base_sha": repo["approved_base_sha"],
            "before_head": old["head"], "after_head": mark["head"], "changed_paths": paths,
            "expected_paths": repo["expected_paths"], "unexpected_paths": unexpected, "passed": not unexpected}
    if not committed: raise LifecycleError("worker produced no descendant commit")
    controller_after = controller_fingerprint(controller)
    if controller_before != controller_after: raise LifecycleError("worker mutated controller HEAD, index, tracked, or untracked state")
    receipt = {"schema_version": "juno_lifecycle_worker_launch.v1", "task_id": plan["task_id"], "worker_number": number,
        "kind": kind, "session_id": session, "response_sha256": hashlib.sha256(response.encode()).hexdigest(),
        "authority_map": authority_evidence, "repair_packet": repair_evidence, "prompt": prompt_before, "prompt_after": prompt_after,
        "command": command, "command_sha256": command_sha256, "environment_contract": environment_contract,
        "launcher_cwd": str(launcher_cwd), "agent_task_root": str(agent_root),
        "capture": {"path": str(capture.resolve()), "sha256": file_digest(capture), "created_after_dispatch": True},
        "process_receipt": {"path": str((artifact / 'process/receipt.json').resolve()), "sha256": file_digest(artifact / "process/receipt.json")},
        "controller_before": controller_before, "controller_after": controller_after, "worktrees_before": before,
        "worktrees_after": after, "changed_path_audit": audits,
        "preflight_receipts": [{"path": str(x.resolve()), "sha256": file_digest(x)} for x in sorted(artifact.glob("*-dispatch-preflight.json"))]}
    atomic_json(artifact / "receipt.json", receipt)
    state["worker_count"] = number; state.setdefault("worker_sessions", []).append(session)
    state["last_worker_result"] = {"kind": kind, "session_id": session, "worktrees_before": before, "worktrees_after": after,
                                   "changed_path_audit": audits, "controller_before": controller_before, "controller_after": controller_after}
    state.setdefault("worker_launches", []).append({"path": str((artifact / "receipt.json").resolve()), "sha256": file_digest(artifact / "receipt.json"),
                                                     "session_id": session, "kind": kind})


def compose_candidate(plan: dict[str, Any], ns: Path, state: dict[str, Any]) -> dict[str, Any]:
    candidates: dict[str, str] = {}
    changed: dict[str, list[str]] = {}
    for repo in plan["repositories"]:
        task = Path(repo["task_worktree"]); mark = fingerprint(task)
        if mark["tracked_staged_untracked"]: raise LifecycleError(f"candidate worktree is dirty: {repo['id']}")
        if mark["head"] == repo["approved_base_sha"]: raise LifecycleError(f"worker produced no commit: {repo['id']}")
        paths = changed_paths(task, repo["approved_base_sha"], mark["head"])
        unexpected = [x for x in paths if not any(x == p or x.startswith(p.rstrip("/") + "/") for p in repo["expected_paths"])]
        if unexpected: raise LifecycleError(f"changed paths exceed authority for {repo['id']}: {','.join(unexpected)}")
        for path, disposition in repo["path_dispositions"].items():
            if disposition == "future" and path in paths and not (task / path).exists(): raise LifecycleError(f"future path was not created: {repo['id']}:{path}")
        candidates[repo["id"]] = mark["head"]; changed[repo["id"]] = paths
    root = next(r for r in plan["repositories"] if r["id"] == plan["root_repository"])
    for child in [r for r in plan["repositories"] if r["role"] == "child" and r.get("mount_path")]:
        line = git(Path(root["task_worktree"]), "ls-tree", candidates[root["id"]], "--", child["mount_path"])
        fields = line.split()
        if len(fields) < 3 or fields[0] != "160000" or fields[2] != candidates[child["id"]]:
            raise LifecycleError(f"root candidate gitlink does not bind child tip: {child['id']}")
    receipt = {"schema_version": "juno_composed_candidate.v2", "task_id": plan["task_id"], "generation": state.get("candidate_generation", 0) + 1,
               "plan_sha256": plan["plan_sha256"], "root": root["id"], "candidate_shas": candidates, "changed_paths": changed,
               "expected_gitlinks": {r["mount_path"]: candidates[r["id"]] for r in plan["repositories"] if r.get("mount_path")}}
    receipt["candidate_digest"] = digest(receipt); atomic_json(ns / "candidate.json", receipt)
    state["candidate_generation"] = receipt["generation"]; state["candidate_shas"] = candidates; state["changed_paths"] = changed
    state["receipts"]["candidate"] = {"path": str(ns / "candidate.json"), "sha256": file_digest(ns / "candidate.json")}
    save_state(ns, state, "CANDIDATE_COMPOSED"); return receipt


def parity_pairs(checkout: Path) -> list[tuple[Path, Path]]:
    pairs = []
    template = checkout / "juno-code/src/templates/scripts/task_lifecycle.py"; runtime = checkout / ".juno_task/scripts/task_lifecycle.py"
    if template.is_file() or runtime.is_file(): pairs.append((template, runtime))
    return pairs


def candidate_gate(plan: dict[str, Any], candidate: dict[str, Any], ns: Path, state: dict[str, Any]) -> dict[str, Any]:
    rows = plan["candidate_gate"]
    if not rows: raise LifecycleError("empty candidate gate cannot pass")
    gate_root = ns / f"candidate-gate-{candidate['generation']}"; gate_root.mkdir(parents=True, exist_ok=False)
    checkouts: dict[str, Path] = {}
    evidence = []
    isolated_env = {k: v for k, v in os.environ.items() if k not in {"JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT", "TASK_ROOT"}}
    try:
        for repo in plan["repositories"]:
            checkout = gate_root / "checkouts" / repo["id"]
            result = subprocess.run(["git", "clone", "--no-local", "--no-checkout", repo["path"], str(checkout)], text=True, capture_output=True, stdin=subprocess.DEVNULL)
            if result.returncode: raise LifecycleError(f"candidate gate clone failed: {repo['id']}")
            git(checkout, "checkout", "--detach", candidate["candidate_shas"][repo["id"]]); checkouts[repo["id"]] = checkout
        for index, row in enumerate(rows, 1):
            if not isinstance(row, dict) or not row.get("id") or "command" not in row: raise LifecycleError("candidate gate row is malformed")
            applies = row.get("applies", "always")
            applicable = applies == "always" or applies == plan["effective_risk"] or applies == ("multi" if len(plan["repositories"]) > 1 else "single")
            if not applicable:
                evidence.append({"id": row["id"], "status": "not_applicable", "expected": row.get("expected", "exit 0"), "actual": "policy not applicable"}); continue
            repo_id = row.get("repository", plan["root_repository"])
            if repo_id not in checkouts: raise LifecycleError(f"candidate gate row references unknown repository: {repo_id}")
            result = run_command(row["command"], checkouts[repo_id], gate_root / f"row-{index:03d}", float(row.get("timeout_seconds", 7200)), isolated_env)
            item = {"id": row["id"], "status": "pass" if result["exit_code"] == 0 and not result["timed_out"] else "fail",
                    "expected": row.get("expected", "exit 0"), "actual": f"exit={result['exit_code']} timeout={result['timed_out']}",
                    "command_sha256": result["command_sha256"], "evidence_path": str(gate_root / f"row-{index:03d}" / "receipt.json"),
                    "evidence_sha256": file_digest(gate_root / f"row-{index:03d}" / "receipt.json")}
            evidence.append(item)
            if item["status"] == "fail": raise LifecycleError(f"candidate gate failed: {row['id']}")
        for checkout in checkouts.values():
            if fingerprint(checkout)["tracked_staged_untracked"]: raise LifecycleError("candidate gate mutated checkout")
            for left, right in parity_pairs(checkout):
                if not left.is_file() or not right.is_file() or left.read_bytes() != right.read_bytes(): raise LifecycleError("runtime/template parity failed")
        applicable_count = sum(x["status"] != "not_applicable" for x in evidence)
        if applicable_count == 0: raise LifecycleError("candidate gate has no applicable evidence rows")
        receipt = {"schema_version": GATE_SCHEMA, "passed": True, "candidate_digest": candidate["candidate_digest"],
                   "applicable": applicable_count, "passed_count": sum(x["status"] == "pass" for x in evidence), "rows": evidence,
                   "controller_routing_unset": True}
        atomic_json(gate_root / "receipt.json", receipt); state["validation_status"] = "passed"
        state["receipts"]["candidate_gate"] = {"path": str(gate_root / "receipt.json"), "sha256": file_digest(gate_root / "receipt.json")}
        save_state(ns, state, "CANDIDATE_GATE_PASSED"); return receipt
    finally:
        shutil.rmtree(gate_root / "checkouts", ignore_errors=True)


def strict_verdict(response: str) -> tuple[str, list[str]]:
    lines = [line.strip() for line in response.splitlines() if line.strip()]
    if any("JUNO_REVIEW_VERDICT:" in line and line != "JUNO_REVIEW_VERDICT: PASS" for line in lines):
        raise LifecycleError("review response contains an echoed, contradictory, or unsupported verdict")
    passes = [x for x in lines if x == "JUNO_REVIEW_VERDICT: PASS"]
    findings = [x for x in lines if x.startswith("JUNO_REVIEW_FINDING: ") and len(x) > 21]
    unsupported = [x for x in lines if x.startswith("JUNO_REVIEW_VERDICT:") and x != "JUNO_REVIEW_VERDICT: PASS"]
    if unsupported or (passes and findings) or len(passes) != (1 if passes else 0) or (not passes and not findings):
        raise LifecycleError("review response has missing, duplicate, contradictory, or unsupported verdict")
    return ("PASS", []) if passes else ("FINDINGS", findings)


def review_fingerprint(checkouts: dict[str, Path], candidates: dict[str, str]) -> dict[str, Any]:
    value = {}
    for repo_id, checkout in checkouts.items():
        mark = fingerprint(checkout)
        if mark["head"] != candidates[repo_id] or mark["tracked_staged_untracked"]:
            raise LifecycleError(f"review checkout is wrong HEAD or dirty: {repo_id}")
        value[repo_id] = mark
    return value


def controller_fingerprint(controller: Path) -> dict[str, str]:
    if not controller.is_dir() or not (controller / ".juno_task/config.json").is_file():
        raise LifecycleError("canonical review controller/config is missing")
    return {
        "head": git(controller, "rev-parse", "HEAD"), "branch_ref": git(controller, "symbolic-ref", "HEAD", check=False),
        "git_common_dir": git_common(controller), "config_sha256": file_digest(controller / ".juno_task/config.json"),
        "index_sha256": hashlib.sha256(git(controller, "ls-files", "--stage").encode()).hexdigest(),
        "tracked_staged_untracked": git(controller, "status", "--porcelain=v2", "--untracked-files=all"),
    }


def neutral_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=False)
    if (path / ".git").exists() or (path / ".juno_task").exists():
        raise LifecycleError("review launch roots must be neutral")
    return path.resolve()


def managed_agent_environment(controller: Path, branch: str, capture: Path, tool_id: str,
                              routing: dict[str, str] | None, kind: str) -> tuple[dict[str, str], dict[str, Any]]:
    # Future Pi/Juno selectors are denied by prefix. Only the exact routing map
    # below is restored, so configured provider/model defaults stay authoritative.
    removed = sorted(k for k in os.environ if k in REVIEW_ENV_BLOCKED or k.startswith(("PI_", "JUNO_")) or k == "TASK_ROOT")
    env = {k: v for k, v in os.environ.items() if k not in removed}
    explicit = {"JUNO_TASK_ROOT": str(controller.resolve()), "JUNO_CONTROLLER_BRANCH": branch.removeprefix("refs/heads/"),
                "JUNO_WORKSPACE_ROLE": "controller", "JUNO_WORKSPACE_ENFORCEMENT": "strict",
                "JUNO_SUBAGENT_CAPTURE_PATH": str(capture.resolve()), "JUNO_TOOL_ID": tool_id}
    explicit.update(routing or {})
    allowed = WORKER_ENV_SET if kind == "worker" else REVIEW_ENV_SET
    if set(explicit) != set(allowed): raise LifecycleError(f"{kind} routing environment is not exact")
    env.update(explicit)
    contract = {"schema_version": "juno_managed_agent_environment.v1", "kind": kind,
                "removed_key_names": removed, "blocked_key_names": sorted(REVIEW_ENV_BLOCKED),
                "explicitly_set_key_names": sorted(explicit)}
    contract["sha256"] = digest(contract)
    return env, contract


def reviewer_environment(controller: Path, branch: str, capture: Path, tool_id: str) -> tuple[dict[str, str], dict[str, Any]]:
    return managed_agent_environment(controller, branch, capture, tool_id, None, "review")


def canonical_managed_command(controller: Path, agent_cwd: Path, prompt_file: Path, override: Any, kind: str) -> list[str]:
    expected = ["yy", "pi", "--config", str((controller / ".juno_task/config.json").resolve()),
                "-w", str(agent_cwd.resolve()), "-f", str(prompt_file.resolve())]
    command = expected if override is None else override
    if not isinstance(command, list) or command != expected:
        raise LifecycleError(f"{kind} launch command is noncanonical or contains forbidden flags")
    return command


def canonical_review_command(controller: Path, agent_cwd: Path, prompt_file: Path, override: Any = None) -> list[str]:
    return canonical_managed_command(controller, agent_cwd, prompt_file, override, "review")


def exact_prompt_evidence(prompt_file: Path, prompt: str, kind: str = "review") -> dict[str, Any]:
    data = prompt_file.read_bytes()
    try: echo = data.decode("utf-8")
    except UnicodeDecodeError as exc: raise LifecycleError(f"{kind} prompt is not exact UTF-8") from exc
    if echo != prompt: raise LifecycleError(f"{kind} prompt bytes were tampered")
    return {"path": str(prompt_file.resolve()), "sha256": hashlib.sha256(data).hexdigest(),
            "byte_count": len(data), "echo": echo}


def review_pipeline(plan: dict[str, Any], candidate: dict[str, Any], ns: Path, state: dict[str, Any], kind: str = "pre_cas") -> list[dict[str, Any]]:
    round_number = state.get("review_round", 0) + 1
    if kind == "pre_cas" and round_number > 2: raise LifecycleError("autonomous review budget exhausted")
    review_root = ns / f"review-{kind}-{round_number}"
    checkout_root = review_root / "frozen-checkout"
    if checkout_root.exists(): raise LifecycleError("frozen review checkout collision")
    controller = Path(plan["controller_root"]).resolve(); controller_before_round = controller_fingerprint(controller)
    if controller_before_round["tracked_staged_untracked"]: raise LifecycleError("review controller is dirty")
    checkouts: dict[str, Path] = {}
    outcomes = []; sessions: set[str] = set()
    try:
        for repo in plan["repositories"]:
            checkout = checkout_root / repo["id"]
            result = subprocess.run(["git", "clone", "--no-local", "--no-checkout", repo["path"], str(checkout)], text=True, capture_output=True, stdin=subprocess.DEVNULL)
            if result.returncode: raise LifecycleError("frozen review checkout creation failed")
            git(checkout, "checkout", "--detach", candidate["candidate_shas"][repo["id"]]); checkouts[repo["id"]] = checkout.resolve()
        frozen_before_round = review_fingerprint(checkouts, candidate["candidate_shas"])
        frozen_identity = digest({"candidate_shas": candidate["candidate_shas"], "checkouts": frozen_before_round})
        absolute_checkouts = {repo_id: str(path) for repo_id, path in sorted(checkouts.items())}
        for reviewer in plan["review_policy"]["reviewers"]:
            before = review_fingerprint(checkouts, candidate["candidate_shas"]); controller_before = controller_fingerprint(controller)
            artifact = review_root / f"reviewer-{reviewer.lower()}"; artifact.mkdir(parents=True, exist_ok=True)
            launcher_cwd = neutral_directory(artifact / "launcher-cwd"); agent_cwd = neutral_directory(artifact / "agent-cwd")
            prompt = (f"Independently review task {plan['task_id']} kind={kind} reviewer={reviewer}.\n"
                      f"Candidate receipt: {Path(ns / 'candidate.json').resolve()}\n"
                      f"Gate receipt: {Path(state['receipts'].get('candidate_gate', {}).get('path', '')).resolve()}\n"
                      f"Frozen exact-tip checkouts: {json.dumps(absolute_checkouts, sort_keys=True)}\n"
                      "Inspect only those absolute frozen checkout paths. Do not edit them. Return response-only exactly one "
                      "JUNO_REVIEW_VERDICT: PASS or one or more JUNO_REVIEW_FINDING: severity; requirement; evidence; acceptance lines.\n")
            prompt_file = artifact / "prompt.md"; prompt_file.write_bytes(prompt.encode("utf-8")); prompt_before = exact_prompt_evidence(prompt_file, prompt)
            capture = artifact / "capture.json"
            env, environment_contract = reviewer_environment(controller, plan["controller_branch"], capture,
                                                               f"lifecycle_review_{kind}_{round_number}_{reviewer}")
            command = canonical_review_command(controller, agent_cwd, prompt_file, plan.get("review_command"))
            command_sha256 = hashlib.sha256(shlex.join(command).encode()).hexdigest()
            result = run_command(command, launcher_cwd, artifact / "process", 7200, env)
            process_receipt = load_json(artifact / "process/receipt.json")
            if process_receipt.get("command_sha256") != command_sha256 or process_receipt.get("cwd") != str(launcher_cwd):
                raise LifecycleError("review process provenance is malformed")
            prompt_after = exact_prompt_evidence(prompt_file, prompt)
            if prompt_before != prompt_after: raise LifecycleError("review prompt changed during dispatch")
            if (launcher_cwd / ".git").exists() or (launcher_cwd / ".juno_task").exists() or (agent_cwd / ".git").exists() or (agent_cwd / ".juno_task").exists():
                raise LifecycleError("review launch roots lost neutrality")
            if result["timed_out"] or result["exit_code"] != 0 or not capture.is_file(): raise LifecycleError("review process/capture failed")
            payload = load_json(capture); session = str(payload.get("session_id") or "").strip(); response = payload.get("result")
            if not session or session in sessions or not isinstance(response, str): raise LifecycleError("review session is missing, duplicate, or response is unbound")
            sessions.add(session); verdict, findings = strict_verdict(response)
            after = review_fingerprint(checkouts, candidate["candidate_shas"]); controller_after = controller_fingerprint(controller)
            if before != after: raise LifecycleError("reviewer mutated tracked, staged, untracked, or HEAD state")
            if controller_before != controller_after: raise LifecycleError("reviewer mutated controller HEAD, index, tracked, or untracked state")
            receipt = {"schema_version": REVIEW_SCHEMA, "kind": kind, "round": round_number, "reviewer": reviewer, "session_id": session,
                       "candidate_digest": candidate["candidate_digest"], "candidate_shas": candidate["candidate_shas"],
                       "frozen_checkout_identity": frozen_identity, "frozen_checkout_paths": absolute_checkouts,
                       "response_sha256": hashlib.sha256(response.encode()).hexdigest(), "verdict": verdict, "findings": findings,
                       "prompt": prompt_before, "prompt_after": prompt_after, "command": command, "command_sha256": command_sha256,
                       "launcher_cwd": str(launcher_cwd), "agent_cwd": str(agent_cwd), "environment_contract": environment_contract,
                       "capture": {"path": str(capture.resolve()), "sha256": file_digest(capture)},
                       "process_receipt": {"path": str((artifact / 'process/receipt.json').resolve()),
                                           "sha256": file_digest(artifact / "process/receipt.json")},
                       "checkout_before": before, "checkout_after": after,
                       "controller_before": controller_before, "controller_after": controller_after}
            atomic_json(artifact / "receipt.json", receipt); outcomes.append(receipt)
        frozen_after_round = review_fingerprint(checkouts, candidate["candidate_shas"]); controller_after_round = controller_fingerprint(controller)
        if frozen_before_round != frozen_after_round or controller_before_round != controller_after_round:
            raise LifecycleError("review round mutated frozen checkout or controller")
        pair = {"schema_version": "juno_review_round.v2", "kind": kind, "round": round_number, "same_frozen_checkout": True,
                "candidate_digest": candidate["candidate_digest"], "frozen_checkout_identity": frozen_identity,
                "controller_before": controller_before_round, "controller_after": controller_after_round,
                "outcomes": outcomes, "passed": all(x["verdict"] == "PASS" for x in outcomes)}
        atomic_json(review_root / "receipt.json", pair)
        if kind == "pre_cas": state["review_round"] = round_number
        state["review_status"] = "passed" if pair["passed"] else "findings"; state["review_passed"] = pair["passed"]
        state["receipts"][f"review_{kind}_{round_number}"] = {"path": str(review_root / "receipt.json"), "sha256": file_digest(review_root / "receipt.json")}
        if pair["passed"]: save_state(ns, state, "REVIEWED_PASS" if kind == "pre_cas" else "ACTUAL_TARGET_REVIEWED")
        else:
            findings = [x for outcome in outcomes for x in outcome["findings"]]
            atomic_json(ns / "repair-packet.json", {"schema_version": "juno_consolidated_repair.v2", "candidate_digest": candidate["candidate_digest"], "findings": findings})
            save_state(ns, state, "REPAIR_REQUIRED")
        return outcomes
    finally:
        shutil.rmtree(checkout_root, ignore_errors=True)


def waiver(plan: dict[str, Any], candidate: dict[str, Any], task: dict[str, Any]) -> dict[str, Any] | None:
    fields = task.get("fields") if isinstance(task.get("fields"), dict) else {}
    value = fields.get("lifecycle_waiver")
    if not isinstance(value, dict): return None
    expected_targets = {r["id"]: {"ref": r["target_ref"], "sha": r["approved_base_sha"]} for r in plan["repositories"]}
    if (value.get("status") != "waived_by_owner" or value.get("candidate_digest") != candidate["candidate_digest"]
            or value.get("effective_risk") != plan["effective_risk"] or value.get("targets") != expected_targets
            or value.get("review_passed") is not False or type(value.get("authorize_integration")) is not bool
            or type(value.get("authorize_local_release")) is not bool or not isinstance(value.get("packages"), list)):
        return None
    return {"schema_version": "juno_candidate_waiver.v2", **value, "task_id": plan["task_id"], "review_passed": False}


def integration_order(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(plan["repositories"], key=lambda x: (x["role"] == "root", x["id"]))


@contextlib.contextmanager
def target_locks(plan: dict[str, Any]):
    """Hold every (Git common directory, full target ref) channel in stable order."""
    handles = []
    try:
        channels = sorted((r["git_common_dir"], r["target_ref"]) for r in plan["repositories"])
        for common, target_ref in channels:
            lock_root = Path(common) / "juno-locks"; lock_root.mkdir(parents=True, exist_ok=True)
            lock = lock_root / ("lifecycle-" + hashlib.sha256(f"{common}\0{target_ref}".encode()).hexdigest() + ".lock")
            handle = lock.open("a+"); fcntl.flock(handle.fileno(), fcntl.LOCK_EX); handles.append(handle)
        yield
    finally:
        for handle in reversed(handles):
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN); handle.close()


def integrate_refs(plan: dict[str, Any], candidate: dict[str, Any], ns: Path, state: dict[str, Any], after_move: Callable[[dict[str, Any]], None] | None = None) -> None:
    state.setdefault("ref_movements", {})
    order = integration_order(plan)
    # Preflight the entire set before mutation; a stale root cannot be discovered only after a child moves.
    for repo in order:
        repo_id = repo["id"]; target = git(Path(repo["path"]), "rev-parse", repo["target_ref"]); wanted = candidate["candidate_shas"][repo_id]
        movement = state["ref_movements"].get(repo_id)
        if movement and (movement.get("candidate_sha") != wanted or target != wanted): raise LifecycleError(f"moved ref drifted: {repo_id}")
        if not movement and target not in {repo["approved_base_sha"], wanted}: raise LifecycleError(f"expected-SHA CAS mismatch: {repo_id}")
        if not movement and target == wanted: raise LifecycleError(f"target moved without a durable task movement receipt: {repo_id}")
    save_state(ns, state, "INTEGRATING")
    with target_locks(plan):
        # Revalidate all channels at the final authority boundary.
        for repo in order:
            repo_id = repo["id"]; target = git(Path(repo["path"]), "rev-parse", repo["target_ref"]); movement = state["ref_movements"].get(repo_id)
            expected = candidate["candidate_shas"][repo_id] if movement else repo["approved_base_sha"]
            if target != expected: raise LifecycleError(f"target changed while acquiring channels: {repo_id}")
        for repo in order:
            repo_id = repo["id"]; source = Path(repo["path"]); wanted = candidate["candidate_shas"][repo_id]
            if state["ref_movements"].get(repo_id): continue
            result = subprocess.run(["git", "-C", str(source), "update-ref", repo["target_ref"], wanted, repo["approved_base_sha"]], text=True, capture_output=True, stdin=subprocess.DEVNULL)
            if result.returncode: raise LifecycleError(f"expected-SHA CAS failed: {repo_id}")
            state["ref_movements"][repo_id] = {"expected_sha": repo["approved_base_sha"], "candidate_sha": wanted, "moved_at": utc_now()}
            save_state(ns, state, "PARTIAL_INTEGRATION", detail={"moved_repository": repo_id})
            if after_move: after_move(repo)
    state["integration_status"] = "integrated"; save_state(ns, state, "INTEGRATED")


def verify_actual_targets(plan: dict[str, Any], candidate: dict[str, Any], ns: Path, state: dict[str, Any]) -> bool:
    for repo in plan["repositories"]:
        if git(Path(repo["path"]), "rev-parse", repo["target_ref"]) != candidate["candidate_shas"][repo["id"]]:
            raise LifecycleError(f"actual target mismatch: {repo['id']}")
    root = next(r for r in plan["repositories"] if r["id"] == plan["root_repository"])
    for child in [r for r in plan["repositories"] if r.get("mount_path")]:
        fields = git(Path(root["path"]), "ls-tree", candidate["candidate_shas"][root["id"]], "--", child["mount_path"]).split()
        if len(fields) < 3 or fields[2] != candidate["candidate_shas"][child["id"]]: raise LifecycleError("actual root gitlink mismatch")
    delivery_sensitive = any(any(part in path.lower() for part in DELIVERY_PARTS) for paths in candidate["changed_paths"].values() for path in paths)
    state["actual_target_verification"] = "passed"; save_state(ns, state, "ACTUAL_TARGET_VERIFIED")
    return delivery_sensitive


def record_review_ready(plan: dict[str, Any], candidate: dict[str, Any], ns: Path, state: dict[str, Any]) -> None:
    controller = Path(plan["controller_root"]); wrapper = controller / ".juno_task/scripts/kanban.sh"
    if git(controller, "rev-parse", "HEAD") != state["expected_controller_head"]:
        raise LifecycleError("expected controller HEAD changed before candidate recording")
    response = ns / "review-ready-response.md"
    response.write_text(f"REVIEW_READY candidate generation {candidate['generation']} root {candidate['candidate_shas'][plan['root_repository']]} candidate digest {candidate['candidate_digest']}. Gate: {state['receipts']['candidate_gate']['path']}\n", encoding="utf-8")
    commands = ([str(wrapper), "mark", "in_progress", "--id", plan["task_id"], "--response-file", str(response)],
                [str(wrapper), "update", plan["task_id"], "--commit", candidate["candidate_shas"][plan["root_repository"]]])
    for command in commands:
        result = run_command(command, controller, ns / "candidate-record" / str(len(list((ns / 'candidate-record').glob('*/receipt.json'))) + 1), 60)
        if result["exit_code"] != 0 or result["timed_out"]: raise LifecycleError("Kanban candidate recording failed")


def controller_checkpoint(plan: dict[str, Any], ns: Path, state: dict[str, Any], label: str) -> None:
    controller = Path(plan["controller_root"]); expected = state["expected_controller_head"]
    if git(controller, "rev-parse", "HEAD") != expected: raise LifecycleError("expected controller HEAD changed before checkpoint")
    script = controller / ".juno_task/scripts/controller_checkpoint.py"
    result = run_command([sys.executable, str(script), "--task-id", plan["task_id"], "commit", "--message", f"chore(controller): lifecycle {plan['task_id']} {label}"], controller,
                         ns / f"controller-checkpoint-{label}", 120, {**os.environ, "JUNO_TASK_ROOT": str(controller), "JUNO_WORKSPACE_ROLE": "controller", "JUNO_WORKSPACE_ENFORCEMENT": "strict"})
    if result["exit_code"] != 0 or result["timed_out"]: raise LifecycleError("controller checkpoint failed")
    current = git(controller, "rev-parse", "HEAD")
    if current != expected and git(controller, "merge-base", "--is-ancestor", expected, current, check=False) == "":
        # merge-base --is-ancestor has no stdout; verify by return code explicitly.
        probe = subprocess.run(["git", "-C", str(controller), "merge-base", "--is-ancestor", expected, current], stdin=subprocess.DEVNULL)
        if probe.returncode: raise LifecycleError("controller checkpoint did not advance from expected HEAD")
    state["expected_controller_head"] = current; state["controller_checkpoint"] = label
    save_state(ns, state, "REVIEW_READY_CHECKPOINTED" if label == "review-ready" else "TERMINAL_CHECKPOINTED")


def controller_readback(plan: dict[str, Any], candidate: dict[str, Any], ns: Path, state: dict[str, Any]) -> None:
    controller = Path(plan["controller_root"])
    task = kanban_task(controller, plan["task_id"])
    if task.get("commit_hash") != candidate["candidate_shas"][plan["root_repository"]]: raise LifecycleError("controller Kanban candidate readback mismatch")
    project_config = load_json(controller / ".juno_task/config.json")
    flow = project_config.get("gitFlow")
    if isinstance(flow, dict) and flow.get("enabled") is True:
        integration_receipt = ns / "controller-sync-integration.json"
        repositories = [{"name": repo["id"], "path": repo["path"], "target_ref": repo["target_ref"],
                         "candidate_sha": candidate["candidate_shas"][repo["id"]]} for repo in plan["repositories"]]
        target_refs = {repo["id"]: {"target_ref": repo["target_ref"], "reviewed_tip": candidate["candidate_shas"][repo["id"]]}
                       for repo in plan["repositories"]}
        atomic_json(integration_receipt, {"schema_version": "juno_local_integration.v3", "outcome": "integrated", "passed": True,
                                          "repositories": repositories, "actual_target": {"target_refs": target_refs}})
        script = controller / ".juno_task/scripts/git_flow.py"
        result = run_command([sys.executable, str(script), "controller-sync", "--integration-receipt", str(integration_receipt), "--json"],
                             controller, ns / "controller-sync", 7200,
                             {key: value for key, value in os.environ.items() if key not in {"JUNO_WORKSPACE_ROLE", "JUNO_CONTROLLER_BRANCH", "TASK_ROOT"}})
        if result["exit_code"] != 0 or result["timed_out"]: raise LifecycleError("controller synchronization failed")
        try: sync = json.loads(result["stdout_text"])
        except json.JSONDecodeError as exc: raise LifecycleError("controller synchronization returned invalid JSON") from exc
        if sync.get("outcome") not in {"synced_local", "up_to_date"} or sync.get("resumable") is True:
            state["controller_sync"] = sync.get("outcome", "failed")
            state["release_status"] = "blocked_controller_sync_partial"
            state["receipts"]["controller_sync"] = {"path": sync.get("receiptPath"), "outcome": sync.get("outcome")}
            raise LifecycleError("controller synchronization is incomplete; sparse restoration/readback must resume")
        if sync.get("sparseRestoration", {}).get("required") and sync["sparseRestoration"].get("status") != "restored_and_verified":
            raise LifecycleError("controller sparse restoration readback is missing")
        state["receipts"]["controller_sync"] = {"path": sync.get("receiptPath"), "outcome": sync.get("outcome")}
    state["controller_sync"] = "verified"; save_state(ns, state, "CONTROLLER_SYNCED")


def cleanup_worktrees(plan: dict[str, Any], candidate: dict[str, Any], ns: Path, state: dict[str, Any]) -> None:
    for repo in integration_order(plan):
        task = Path(repo["task_worktree"]); wanted = candidate["candidate_shas"][repo["id"]]
        if not task.exists(): continue
        mark = fingerprint(task)
        if mark["head"] != wanted or mark["tracked_staged_untracked"]: raise LifecycleError(f"cleanup expected-head/clean refusal: {repo['id']}")
        if git(Path(repo["path"]), "rev-parse", repo["target_ref"]) != wanted: raise LifecycleError(f"cleanup reachability refusal: {repo['id']}")
        result = subprocess.run(["git", "-C", repo["path"], "worktree", "remove", str(task)], text=True, capture_output=True, stdin=subprocess.DEVNULL)
        if result.returncode: raise LifecycleError(f"cleanup failed: {repo['id']}")
        subprocess.run(["git", "-C", repo["path"], "update-ref", "-d", repo["task_branch_ref"], wanted], stdin=subprocess.DEVNULL)
    state["cleanup_status"] = "complete"; save_state(ns, state, "CLEANUP_COMPLETE")


def compact(state: dict[str, Any]) -> dict[str, Any]:
    return {"schema_version": RESULT_SCHEMA, "task_id": state["task_id"], "phase": state["phase"], "topology": state.get("topology"),
            "effective_risk": state.get("effective_risk"), "candidate_generation": state.get("candidate_generation", 0),
            "candidate_shas": state.get("candidate_shas", {}), "validation_status": state.get("validation_status", "not_started"),
            "review_status": state.get("review_status", "not_started"), "review_passed": state.get("review_passed", False),
            "integration_status": state.get("integration_status", "not_started"), "ref_movements": state.get("ref_movements", {}),
            "actual_target_verification": state.get("actual_target_verification", "not_started"), "actual_target_review": state.get("actual_target_review", "not_started"),
            "controller_sync": state.get("controller_sync", "not_started"), "controller_checkpoint": state.get("controller_checkpoint", "not_started"),
            "cleanup_status": state.get("cleanup_status", "not_started"), "release_status": state.get("release_status", "not_requested"),
            "attempt_count": state.get("attempt_count", 0), "last_error": state.get("last_error"), "next_permitted_action": state.get("next_permitted_action")}


def load_plan(ns: Path, state: dict[str, Any]) -> dict[str, Any]:
    plan = load_json(ns / "plan.json"); claimed = plan.pop("plan_sha256", None)
    if plan.get("schema_version") != PLAN_SCHEMA or digest(plan) != claimed or claimed != state.get("plan_sha256"):
        raise LifecycleError("immutable lifecycle plan drift")
    plan["plan_sha256"] = claimed; return plan


def advance(root: Path, task: dict[str, Any], plan: dict[str, Any], ns: Path, state: dict[str, Any]) -> int:
    while True:
        phase = state["phase"]
        if phase == "PLANNED": prepare_worktrees(plan, ns, state)
        elif phase == "WORKTREES_ADMITTED": dispatch_worker(plan, ns, state)
        elif phase == "IMPLEMENTING": compose_candidate(plan, ns, state)
        elif phase == "CANDIDATE_COMPOSED": candidate_gate(plan, load_json(ns / "candidate.json"), ns, state)
        elif phase == "CANDIDATE_GATE_PASSED":
            # Record the exact candidate before the expected-HEAD checkpoint and any reviewer dispatch.
            candidate = load_json(ns / "candidate.json"); record_review_ready(plan, candidate, ns, state)
            controller_checkpoint(plan, ns, state, "review-ready"); return 0
        elif phase == "REVIEW_READY_CHECKPOINTED":
            candidate = load_json(ns / "candidate.json"); decision = waiver(plan, candidate, task)
            if decision:
                atomic_json(ns / "owner-waiver.json", decision); state["review_status"] = "waived_by_owner"; state["review_passed"] = False
                state["receipts"]["owner_waiver"] = {"path": str(ns / "owner-waiver.json"), "sha256": file_digest(ns / "owner-waiver.json")}
                save_state(ns, state, "REVIEW_WAIVED_BY_OWNER")
            else: review_pipeline(plan, candidate, ns, state)
        elif phase == "REPAIR_REQUIRED":
            if state.get("review_round", 0) >= 2:
                state["review_status"] = "budget_exhausted"; save_state(ns, state, "REVIEW_BUDGET_EXHAUSTED"); return 3
            dispatch_worker(plan, ns, state, repair=True)
        elif phase == "REVIEWED_PASS": save_state(ns, state, "READY_TO_INTEGRATE")
        elif phase == "REVIEW_WAIVED_BY_OWNER":
            decision = load_json(Path(state["receipts"]["owner_waiver"]["path"]))
            if decision.get("authorize_integration") is not True: return 3
            save_state(ns, state, "READY_TO_INTEGRATE")
        elif phase in {"READY_TO_INTEGRATE", "PARTIAL_INTEGRATION", "INTEGRATING"}: integrate_refs(plan, load_json(ns / "candidate.json"), ns, state)
        elif phase == "INTEGRATED":
            candidate = load_json(ns / "candidate.json")
            if verify_actual_targets(plan, candidate, ns, state): review_pipeline(plan, candidate, ns, state, "actual_target")
            else: state["actual_target_review"] = "not_required"; save_state(ns, state, "ACTUAL_TARGET_REVIEW_NOT_REQUIRED")
        elif phase in {"ACTUAL_TARGET_REVIEWED", "ACTUAL_TARGET_REVIEW_NOT_REQUIRED", "ACTUAL_TARGET_REVIEW_WAIVED_BY_OWNER", "ACTUAL_TARGET_VERIFIED"}:
            controller_readback(plan, load_json(ns / "candidate.json"), ns, state)
        elif phase == "CONTROLLER_SYNCED": controller_checkpoint(plan, ns, state, "terminal")
        elif phase == "TERMINAL_CHECKPOINTED": cleanup_worktrees(plan, load_json(ns / "candidate.json"), ns, state)
        elif phase == "CLEANUP_COMPLETE": save_state(ns, state, "COMPLETE"); return 0
        elif phase in TERMINAL: return 0 if phase == "COMPLETE" else 3
        else: raise LifecycleError(f"phase cannot resume automatically: {phase}")


def public(task_id: str, operation: str) -> int:
    root = project_root(Path.cwd()); task_id = safe_task(task_id)
    # Status is observational: do not create the namespace or acquire mutation authority.
    ns = Path(git_common(root)) / "juno-lifecycle" / "tasks" / task_id
    state_path = ns / "state.json"
    if operation == "status":
        if ns.is_symlink(): raise LifecycleError("lifecycle namespace symlinks are forbidden")
        if not state_path.is_file():
            print(json.dumps({"schema_version": RESULT_SCHEMA, "task_id": task_id, "phase": "NOT_STARTED", "next_permitted_action": "run"}, sort_keys=True)); return 0
        state = load_state(state_path); verify_attempt_chain(ns, state); print(json.dumps(compact(state), sort_keys=True)); return 0
    ns = namespace(root, task_id)
    if operation == "run":
        if state_path.exists(): raise LifecycleError("lifecycle already exists; use resume")
        task = kanban_task(root, task_id); config = validate_config(load_json(root / ".juno_task/config/lifecycle.json"), root); plan = derive_plan(root, task, config)
        ns.mkdir(parents=True, exist_ok=False); atomic_json(ns / "plan.json", plan)
        state = {"schema_version": STATE_SCHEMA, "task_id": task_id, "phase": "PLANNED", "topology": plan["topology"], "effective_risk": plan["effective_risk"],
                 "plan_sha256": plan["plan_sha256"], "expected_controller_head": plan["expected_controller_head"], "candidate_generation": 0,
                 "candidate_shas": {}, "receipts": {}, "attempt_count": 0, "last_attempt_sha256": None, "worker_count": 0,
                 "review_round": 0, "review_status": "not_started", "review_passed": False, "validation_status": "not_started",
                 "integration_status": "not_started", "ref_movements": {}, "actual_target_verification": "not_started", "actual_target_review": "not_started",
                 "controller_sync": "not_started", "controller_checkpoint": "not_started", "cleanup_status": "not_started", "release_status": "not_requested",
                 "next_permitted_action": "prepare", "last_error": None}
        save_state(ns, state, "PLANNED"); task_value = task
    else:
        if not state_path.is_file(): raise LifecycleError("no lifecycle state; use run")
        state = load_state(state_path); verify_attempt_chain(ns, state); task_value = kanban_task(root, task_id); plan = load_plan(ns, state)
    try: code = advance(root, task_value, plan, ns, state)
    except LifecycleError as exc:
        state["last_error"] = str(exc); state["next_permitted_action"] = "resume_after_fix"; append_attempt(ns, state, state["phase"], "failed", {"error": str(exc), "failure_class": "fail_closed"})
        state["state_sha256"] = digest(state_without_hash(state)); atomic_json(state_path, state)
        print(f"lifecycle: error: {exc}", file=sys.stderr); print(json.dumps(compact(state), sort_keys=True)); return 2
    print(json.dumps(compact(state), sort_keys=True)); return code


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Run one task-derived root/direct-child lifecycle", allow_abbrev=False)
    sub = root.add_subparsers(dest="operation", required=True)
    for name in ("run", "resume", "status"):
        command = sub.add_parser(name, allow_abbrev=False); command.add_argument("--task", required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try: return public(args.task, args.operation)
    except (LifecycleError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(f"lifecycle: error: {exc}", file=sys.stderr); return 2


if __name__ == "__main__":
    raise SystemExit(main())
