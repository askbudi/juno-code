#!/usr/bin/env python3
"""Single-repository task lifecycle orchestrator.

The public interface is ``run``, ``resume``, and ``status``.  Git/review helpers
remain implementation details.  State is hash-bound, resumable, and truthful:
no phase is inferred from a later phase and failed mutations retain the last
proven boundary.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
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
from typing import Any

SCHEMA = "juno_task_lifecycle.v1"
STATE_SCHEMA = "juno_task_lifecycle_state.v1"
RESULT_SCHEMA = "juno_task_lifecycle_result.v1"
REVIEW_SCHEMA = "juno_review.v1"
OWNER_REVIEW_FIELD = "lifecycle_review"
RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
HIGH_RISK_PATH_PARTS = (
    ".juno_task/scripts/", "src/templates/scripts/", "package.json", "package-lock.json",
    "git", "lifecycle", "integration", "workflow", "security", "release", "deploy",
)
DELIVERY_PATH_PARTS = ("package.json", "package-lock.json", "src/templates/", "dist/", "scripts/")
TERMINAL = {"COMPLETE", "REVIEW_BUDGET_EXHAUSTED", "BLOCKED"}
MAX_CAPTURE_BYTES = 64 * 1024


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
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    os.replace(temporary, path)


def load_mapping(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        try:
            import yaml  # type: ignore
        except ImportError as exc:
            raise LifecycleError("YAML manifest requires PyYAML; JSON remains dependency-free") from exc
        value = yaml.safe_load(text)
    if not isinstance(value, dict):
        raise LifecycleError(f"mapping required: {path}")
    return value


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, stdin=subprocess.DEVNULL)
    if check and result.returncode:
        raise LifecycleError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def full_ref(value: str) -> str:
    if not value.startswith("refs/heads/"):
        raise LifecycleError("target_ref and task_branch_ref must be full refs/heads/... names")
    return value


def bounded_text(value: str) -> tuple[str, bool]:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_CAPTURE_BYTES:
        return value, False
    return encoded[-MAX_CAPTURE_BYTES:].decode("utf-8", errors="replace"), True


def run_command(command: list[str] | str, cwd: Path, artifact: Path, *, timeout: float, env: dict[str, str] | None = None) -> dict[str, Any]:
    if isinstance(command, str):
        argv: list[str] | str = command
        shell = True
        preview = command
    elif isinstance(command, list) and command and all(isinstance(x, str) and x for x in command):
        argv = command
        shell = False
        preview = shlex.join(command)
    else:
        raise LifecycleError("command must be a non-empty argv list or shell string")
    started = time.monotonic()
    timed_out = False
    try:
        result = subprocess.run(argv, shell=shell, cwd=cwd, text=True, capture_output=True,
                                stdin=subprocess.DEVNULL, timeout=timeout, env=env)
        code: int | None = result.returncode
        stdout, stderr = result.stdout, result.stderr
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        code = None
        stdout = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
    out_value, out_truncated = bounded_text(stdout)
    err_value, err_truncated = bounded_text(stderr)
    artifact.mkdir(parents=True, exist_ok=True)
    (artifact / "stdout.txt").write_text(out_value, encoding="utf-8")
    (artifact / "stderr.txt").write_text(err_value, encoding="utf-8")
    receipt = {
        "command_sha256": hashlib.sha256(preview.encode()).hexdigest(), "cwd": str(cwd.resolve()),
        "exit_code": code, "timed_out": timed_out, "elapsed_seconds": round(time.monotonic() - started, 3),
        "stdout": {"path": str((artifact / 'stdout.txt').resolve()), "sha256": file_digest(artifact / "stdout.txt"), "truncated": out_truncated},
        "stderr": {"path": str((artifact / 'stderr.txt').resolve()), "sha256": file_digest(artifact / "stderr.txt"), "truncated": err_truncated},
    }
    atomic_json(artifact / "receipt.json", receipt)
    return {**receipt, "stdout_text": out_value, "stderr_text": err_value}


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("schema_version") != SCHEMA:
        raise LifecycleError(f"schema_version must be {SCHEMA}")
    task_id = str(manifest.get("task_id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", task_id):
        raise LifecycleError("task_id is missing or invalid")
    repositories = manifest.get("repositories")
    if not isinstance(repositories, list) or len(repositories) != 1:
        raise LifecycleError("v1 requires repositories with exactly one entry")
    repo = repositories[0]
    if not isinstance(repo, dict) or repo.get("id") != "root":
        raise LifecycleError("the v1 repository entry must have id: root")
    controller_root = Path(str(manifest.get("controller_root") or "")).expanduser()
    if not controller_root.is_absolute():
        raise LifecycleError("controller_root must be absolute")
    checklist = Path(str(manifest.get("requirements_checklist") or "")).expanduser()
    if not checklist.is_absolute() or not checklist.is_file():
        raise LifecycleError("requirements_checklist must be an existing absolute file")
    required = ("path", "target_ref", "approved_base_sha", "task_worktree", "task_branch_ref", "expected_paths")
    missing = [key for key in required if not repo.get(key)]
    if missing:
        raise LifecycleError("repository missing fields: " + ", ".join(missing))
    full_ref(str(repo["target_ref"])); full_ref(str(repo["task_branch_ref"]))
    if not re.fullmatch(r"[0-9a-f]{40}", str(repo["approved_base_sha"])):
        raise LifecycleError("approved_base_sha must be a full SHA")
    expected = repo["expected_paths"]
    if not isinstance(expected, list) or not expected or not all(isinstance(x, str) and x and not Path(x).is_absolute() and ".." not in Path(x).parts for x in expected):
        raise LifecycleError("expected_paths must be non-empty safe relative paths")
    declared = str(manifest.get("objective_risk") or "").strip()
    if declared not in RISK_ORDER:
        raise LifecycleError("objective_risk must be low, medium, or high")
    deterministic = classify_risk(expected)
    escalation = manifest.get("owner_risk_escalation")
    if escalation is not None and escalation not in RISK_ORDER:
        raise LifecycleError("owner_risk_escalation must be low, medium, high, or null")
    minimum = max(RISK_ORDER[deterministic], RISK_ORDER[declared])
    if escalation is not None:
        if RISK_ORDER[escalation] < minimum:
            raise LifecycleError("owner risk may escalate but cannot downgrade deterministic/objective risk")
        minimum = RISK_ORDER[escalation]
    effective = next(name for name, order in RISK_ORDER.items() if order == minimum)
    normalized = copy.deepcopy(manifest)
    normalized["objective_risk"] = declared
    normalized["deterministic_risk"] = deterministic
    normalized["effective_risk"] = effective
    normalized["repositories"][0]["expected_paths"] = sorted(set(expected))
    normalized.setdefault("review", {"initial_pair_limit": 1, "replacement_pair_limit": 1})
    review = normalized["review"]
    if review.get("initial_pair_limit") != 1 or review.get("replacement_pair_limit") != 1:
        raise LifecycleError("review budget requires one initial pair and one replacement pair")
    extension = review.get("owner_authorized_extension_pair_limit", 0)
    if type(extension) is not int or not 0 <= extension <= 8:
        raise LifecycleError("owner-authorized review extensions must be a bounded count from zero through eight")
    review["owner_authorized_extension_pair_limit"] = extension
    for command_key in ("implementation_command", "repair_command", "review_command"):
        configured = normalized.get(command_key)
        if configured is None:
            continue
        if (not isinstance(configured, list) or configured[:2] != ["yy", "pi"]
                or any(token in {"--provider", "--model", "--resume", "--continue", "cc"} or token.startswith(("--provider=", "--model=", "--resume=", "--continue=")) for token in configured[2:])):
            raise LifecycleError(f"{command_key} must be a fresh canonical yy pi launch inheriting project defaults")
    normalized.setdefault("timeouts", {})
    normalized["timeouts"].setdefault("agent_seconds", 7200)
    normalized["timeouts"].setdefault("validation_seconds", 7200)
    return normalized


def classify_risk(paths: list[str]) -> str:
    lowered = [path.lower() for path in paths]
    if not lowered:
        return "high"
    if any(any(part in path for part in HIGH_RISK_PATH_PARTS) for path in lowered):
        return "high"
    if all(path.endswith((".md", ".txt")) for path in lowered):
        return "low"
    classified_suffixes = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".json", ".yaml", ".yml", ".sh")
    if all(path.endswith(classified_suffixes) for path in lowered):
        return "medium"
    return "high"


def state_path(manifest: dict[str, Any], explicit: Path | None = None) -> Path:
    if explicit:
        return explicit.resolve()
    root = Path(str(manifest.get("artifact_root") or "")).expanduser()
    if not root.is_absolute():
        raise LifecycleError("artifact_root must be absolute")
    return (root / "state.json").resolve()


def new_state(manifest_path: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": STATE_SCHEMA, "task_id": manifest["task_id"], "phase": "PLANNED",
        "generation": 0, "manifest": {"path": str(manifest_path.resolve()), "sha256": file_digest(manifest_path)},
        "effective_risk": manifest["effective_risk"], "candidate_sha": None, "reviewed_task_tip_sha": None,
        "candidate_path": None, "candidate_composed": False, "integrated_sha": None,
        "release_sha": None, "release_tag": None, "review_status": "not_started", "review_passed": False,
        "validation_status": "not_started", "integration_status": "not_started",
        "actual_target_verification": "not_started", "actual_target_review": "not_started",
        "controller_sync": "not_started", "controller_checkpoint": "not_started", "cleanup_status": "not_started",
        "review_round": 0, "events": [], "receipts": {}, "last_error": None,
    }


def load_state(path: Path) -> dict[str, Any]:
    value = load_mapping(path)
    if value.get("schema_version") != STATE_SCHEMA:
        raise LifecycleError("unsupported lifecycle state schema")
    expected = value.get("state_sha256")
    if not isinstance(expected, str) or digest({key: item for key, item in value.items() if key != "state_sha256"}) != expected:
        raise LifecycleError("lifecycle state hash mismatch")
    return value


def save_state(path: Path, state: dict[str, Any], phase: str, *, receipt: tuple[str, Path] | None = None, detail: dict[str, Any] | None = None) -> None:
    previous = state["phase"]
    state["phase"] = phase
    state["last_error"] = None
    state["generation"] += 1
    event = {"at": utc_now(), "from": previous, "to": phase, "generation": state["generation"]}
    if detail:
        event["detail"] = detail
    if receipt:
        key, receipt_path = receipt
        state["receipts"][key] = {"path": str(receipt_path.resolve()), "sha256": file_digest(receipt_path)}
        event["receipt"] = key
    state["events"].append(event)
    state["state_sha256"] = digest({key: value for key, value in state.items() if key != "state_sha256"})
    atomic_json(path, state)


def scripts(repo: Path) -> dict[str, Path]:
    root = repo / ".juno_task" / "scripts"
    values = {
        "worktree": root / "worktree_lifecycle.py", "candidate": root / "integration_candidate.py",
        "integrate": root / "integration_owner_preflight.py", "checkpoint": root / "controller_checkpoint.py",
        "kanban": root / "kanban.sh", "review_template": repo / ".juno_task" / "prompts" / "review_commit_parallel_runner.md",
    }
    missing = [str(path) for path in values.values() if not path.exists()]
    if missing:
        raise LifecycleError("missing managed lifecycle assets: " + ", ".join(missing))
    return values


def helper(command: list[str], cwd: Path, output: Path, timeout: float = 600, env: dict[str, str] | None = None) -> dict[str, Any]:
    result = run_command(command, cwd, output.parent / (output.stem + "-process"), timeout=timeout, env=env)
    if result["timed_out"] or result["exit_code"] != 0:
        raise LifecycleError(f"helper failed ({shlex.join(command)}): {result['stderr_text'].strip()}")
    if output.exists():
        payload = load_mapping(output)
        payload["_helper_stdout_text"] = result["stdout_text"]
        payload["_helper_stderr_text"] = result["stderr_text"]
        return payload
    return result


def prepare(manifest: dict[str, Any], state: dict[str, Any], path: Path) -> None:
    repo = manifest["repositories"][0]
    repository = Path(repo["path"]).resolve()
    task = Path(repo["task_worktree"]).resolve()
    assets = scripts(repository)
    target = git(repository, "rev-parse", f"{repo['target_ref']}^{{commit}}")
    if target != repo["approved_base_sha"]:
        raise LifecycleError(f"exact-base admission refused: expected={repo['approved_base_sha']} actual={target}")
    artifact = path.parent / "prepare"
    create = artifact / "create.json"
    command = [sys.executable, str(assets["worktree"]), "create", "--repository", str(repository),
               "--target-ref", repo["target_ref"], "--expected-base", repo["approved_base_sha"],
               "--path", str(task), "--branch-ref", repo["task_branch_ref"], "--task-id", manifest["task_id"]]
    for expected in repo["expected_paths"]:
        command += ["--expected-path", expected]
    command += ["--cleanup-owner", str(manifest.get("cleanup_owner") or "logical-orchestrator"), "--output", str(create)]
    helper(command, repository, create)
    verify = artifact / "verify.json"
    helper([sys.executable, str(assets["worktree"]), "verify", "--manifest", str(create), "--path", str(task), "--output", str(verify)], repository, verify)
    edit = artifact / "edit-preflight.json"
    edit_command = [sys.executable, str(assets["worktree"]), "edit-preflight", "--repository", str(repository),
                    "--target-ref", repo["target_ref"], "--approved-base", repo["approved_base_sha"],
                    "--task-id", manifest["task_id"], "--path", str(task), "--manifest", str(create),
                    "--verify-receipt", str(verify), "--task-worktree", str(task),
                    "--task-branch-ref", repo["task_branch_ref"], "--cleanup-owner", str(manifest.get("cleanup_owner") or "logical-orchestrator"),
                    "--next-receipt", str(artifact / "next-verify.json"), "--output", str(edit)]
    for expected in repo["expected_paths"]: edit_command += ["--expected-path", expected]
    edit_env = dict(os.environ)
    edit_env.update({"JUNO_TASK_ROOT": str(Path(manifest["controller_root"]).resolve()),
                     "JUNO_WORKSPACE_ROLE": "task", "JUNO_WORKSPACE_ENFORCEMENT": "strict"})
    helper(edit_command, repository, edit, env=edit_env)
    preflight = artifact / "target-preflight.json"
    helper([sys.executable, str(assets["candidate"]), "target-preflight", "--repository", str(repository),
            "--target-ref", repo["target_ref"], "--approved-base", repo["approved_base_sha"], "--output", str(preflight)], repository, preflight)
    receipt = artifact / "receipt.json"
    atomic_json(receipt, {"schema_version": "juno_lifecycle_prepare.v1", "passed": True, "task_id": manifest["task_id"],
                          "approved_base_sha": target, "worktree": str(task), "create_sha256": file_digest(create),
                          "verify_sha256": file_digest(verify), "edit_preflight_sha256": file_digest(edit),
                          "target_preflight_sha256": file_digest(preflight)})
    save_state(path, state, "IMPLEMENT_READY", receipt=("prepare", receipt))


def review_environment(manifest: dict[str, Any]) -> dict[str, str]:
    env = dict(os.environ)
    env.update({"JUNO_TASK_ROOT": str(Path(manifest["controller_root"]).resolve()),
                "JUNO_WORKSPACE_ROLE": "controller", "JUNO_WORKSPACE_ENFORCEMENT": "strict"})
    return env


def agent_command(manifest: dict[str, Any], prompt_path: Path, kind: str) -> list[str]:
    configured = manifest.get(f"{kind}_command")
    if configured is None:
        return ["yy", "pi", "-p", prompt_path.read_text(encoding="utf-8")]
    if not isinstance(configured, list) or not configured or not all(isinstance(x, str) for x in configured):
        raise LifecycleError(f"{kind}_command must be an argv list")
    rendered = [x.replace("{{prompt_path}}", str(prompt_path)).replace("{{prompt}}", prompt_path.read_text(encoding="utf-8")) for x in configured]
    return rendered


def worktree_is_inactive(task: Path) -> bool:
    try:
        probe = subprocess.run(["lsof", "-n", "-P", "+D", str(task)], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise LifecycleError(f"interrupted worker activity is unknown: {exc}") from exc
    if probe.returncode == 1: return True
    if probe.returncode == 0: return False
    raise LifecycleError(f"interrupted worker activity probe failed with exit {probe.returncode}")


def recover_interrupted_worker(manifest: dict[str, Any], state: dict[str, Any], path: Path, *, repair: bool) -> None:
    repo = manifest["repositories"][0]; task = Path(repo["task_worktree"]).resolve()
    if not worktree_is_inactive(task): raise LifecycleError("interrupted worker still appears active")
    if git(task, "status", "--porcelain=v2", "--untracked-files=all"):
        raise LifecycleError("interrupted worker left dirty state; inspect and commit or restore before resume")
    before = state.get("repair_base_sha") if repair else repo["approved_base_sha"]
    head = git(task, "rev-parse", "HEAD")
    if head != before:
        state["candidate_sha"] = head
        state["reviewed_task_tip_sha"] = head
        save_state(path, state, "CANDIDATE_FROZEN", detail={"recovered_interrupted_worker": True, "candidate_sha": head})
    else:
        save_state(path, state, "REPAIR_REQUIRED" if repair else "IMPLEMENT_READY", detail={"recovered_no_worker_commit": True})


def dispatch_implementation(manifest: dict[str, Any], state: dict[str, Any], path: Path, *, repair: bool = False) -> None:
    repo = manifest["repositories"][0]
    task = Path(repo["task_worktree"]).resolve()
    artifact = path.parent / (f"repair-{state['review_round']}" if repair else "implementation")
    artifact.mkdir(parents=True, exist_ok=True)
    if repair:
        packet = path.parent / f"review-{state['review_round']}" / "repair-packet.json"
        prompt = ("Repair the complete consolidated lifecycle review packet at " + str(packet) +
                  ". Work only in TASK_ROOT, run focused tests, commit coherent product bytes, and stop at REVIEW_READY. "
                  "Do not launch reviewers, integrate, release, or clean worktrees.\n")
    else:
        prompt = str(manifest.get("implementation_prompt") or
                     f"Implement Kanban task {manifest['task_id']} completely in this admitted TASK_ROOT. Read AGENTS.md and the task. "
                     "Use focused tests, commit coherent product bytes, run the required candidate-boundary checks, and stop at REVIEW_READY. "
                     "Do not launch semantic reviewers, integrate, release, or clean worktrees.")
    prompt_path = artifact / "prompt.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    before = git(task, "rev-parse", "HEAD")
    env = dict(os.environ)
    env.update({"TASK_ROOT": str(task), "JUNO_WORKSPACE_ROLE": "task", "JUNO_WORKSPACE_ENFORCEMENT": "strict"})
    controller = manifest.get("controller_root")
    if controller:
        env["JUNO_TASK_ROOT"] = str(Path(controller).resolve())
    result = run_command(agent_command(manifest, prompt_path, "repair" if repair else "implementation"), task, artifact / "process",
                         timeout=float(manifest["timeouts"]["agent_seconds"]), env=env)
    if result["timed_out"] or result["exit_code"] != 0:
        raise LifecycleError(("repair" if repair else "implementation") + " worker failed")
    after = git(task, "rev-parse", "HEAD")
    if after == before or git(task, "status", "--porcelain=v2", "--untracked-files=all"):
        raise LifecycleError("worker must return a changed, committed, clean task tip")
    state["candidate_sha"] = after
    state["reviewed_task_tip_sha"] = after
    save_state(path, state, "CANDIDATE_FROZEN", detail={"candidate_sha": after, "worker": "repair" if repair else "implementation"})


def changed_paths(repository: Path, base: str, tip: str) -> list[str]:
    return sorted(set(git(repository, "diff", "--name-only", base, tip).splitlines()))


def built_in_parity_pairs(task: Path) -> list[list[str]]:
    pairs: list[list[str]] = []
    template_root = task / "juno-code/src/templates"
    for category in ("scripts", "prompts", "wiki"):
        source = template_root / category
        runtime = task / ".juno_task" / category
        if not source.is_dir() or not runtime.is_dir(): continue
        for source_path in source.rglob("*"):
            if source_path.is_file():
                relative = source_path.relative_to(source)
                runtime_path = runtime / relative
                if runtime_path.is_file():
                    pairs.append([str(source_path.relative_to(task)), str(runtime_path.relative_to(task))])
    canonical = task / "juno-code/src/templates/skills/canonical/ralph-loop/references/implement.md"
    if canonical.is_file():
        destinations = [
            "juno-code/src/templates/skills/claude/ralph-loop/references/implement.md",
            "juno-code/src/templates/skills/codex/ralph-loop/references/implement.md",
            "juno-code/src/templates/skills/pi/ralph-loop/references/implement.md",
            "juno-code/.claude/skills/ralph-loop/references/implement.md",
            "juno-code/.agents/skills/ralph-loop/references/implement.md",
            "juno-code/.pi/skills/ralph-loop/references/implement.md",
            ".claude/skills/ralph-loop/references/implement.md", ".agents/skills/ralph-loop/references/implement.md",
            ".pi/skills/ralph-loop/references/implement.md",
        ]
        pairs.extend([[str(canonical.relative_to(task)), destination] for destination in destinations])
    return pairs


def closure_audit(manifest: dict[str, Any], state: dict[str, Any], path: Path) -> None:
    repo = manifest["repositories"][0]
    repository, task = Path(repo["path"]).resolve(), Path(repo["task_worktree"]).resolve()
    tip = state["candidate_sha"]
    findings: list[str] = []
    if git(task, "rev-parse", "HEAD") != tip or git(task, "status", "--porcelain=v2", "--untracked-files=all"):
        findings.append("candidate_not_clean_exact_tip")
    paths = changed_paths(repository, repo["approved_base_sha"], tip)
    unexpected = [item for item in paths if not any(item == prefix or item.startswith(prefix.rstrip("/") + "/") for prefix in repo["expected_paths"])]
    if unexpected:
        findings.append("unexpected_paths:" + ",".join(unexpected))
    added_diff = git(repository, "diff", "--unified=0", repo["approved_base_sha"], tip)
    forbidden = ("sign" + "er", "private" + " key", "hm" + "ac", "seat" + "belt", "bubble" + "wrap",
                 "trusted" + " runtime", "helper-owned" + " editing", "helper-owned" + " commit")
    added_lines = "\n".join(line[1:].lower() for line in added_diff.splitlines() if line.startswith("+") and not line.startswith("+++"))
    for term in forbidden:
        if term in added_lines: findings.append("forbidden_architecture:" + term.replace(" ", "_"))
    workflow_runtime = task / ".juno_task/scripts/workflow_runner.sh"
    if workflow_runtime.is_file():
        workflow_text = workflow_runtime.read_text(encoding="utf-8")
        if "task lifecycle hard cut" not in workflow_text or "env[\"JUNO_WORKFLOW_DIRECT_OWNER\"]" in workflow_text:
            findings.append("workflow_hard_cut_incomplete")
    pairs = built_in_parity_pairs(task) + (manifest.get("parity_pairs") or [])
    for pair in pairs:
        if not isinstance(pair, list) or len(pair) != 2:
            findings.append("invalid_parity_pair")
            continue
        if pair[0] not in paths and pair[1] not in paths:
            continue
        left, right = task / pair[0], task / pair[1]
        if not left.is_file() or not right.is_file() or left.read_bytes() != right.read_bytes():
            findings.append(f"parity_mismatch:{pair[0]}:{pair[1]}")
    receipt = path.parent / f"closure-{state['review_round']}" / "receipt.json"
    atomic_json(receipt, {"schema_version": "juno_lifecycle_closure_audit.v1", "passed": not findings,
                          "candidate_sha": tip, "changed_paths": paths, "findings": findings})
    if findings:
        raise LifecycleError("closure audit failed: " + ";".join(findings))
    save_state(path, state, "CLOSURE_AUDITED", receipt=(f"closure_{state['review_round']}", receipt))


def isolated_validation(manifest: dict[str, Any], state: dict[str, Any], path: Path) -> None:
    repo = manifest["repositories"][0]
    repository = Path(repo["path"]).resolve()
    tip = state["candidate_sha"]
    artifact = path.parent / f"validation-{state['review_round']}"
    clone = artifact / "checkout"
    if clone.exists():
        raise LifecycleError(f"validation checkout collision: {clone}")
    artifact.mkdir(parents=True, exist_ok=True)
    cloned = subprocess.run(["git", "clone", "--no-local", "--no-checkout", str(repository), str(clone)],
                            text=True, capture_output=True, stdin=subprocess.DEVNULL)
    if cloned.returncode:
        raise LifecycleError(f"isolated validation clone failed: {cloned.stderr.strip()}")
    git(clone, "checkout", "--detach", tip)
    commands = manifest.get("validation_commands")
    if not isinstance(commands, list) or not commands:
        raise LifecycleError("validation_commands must contain the exact-tip candidate boundary suite")
    env = {key: value for key, value in os.environ.items() if key not in {
        "JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT"
    }}
    results = []
    try:
        for index, command in enumerate(commands, start=1):
            result = run_command(command, clone, artifact / f"command-{index:03d}",
                                 timeout=float(manifest["timeouts"]["validation_seconds"]), env=env)
            results.append({key: value for key, value in result.items() if not key.endswith("_text")})
            if result["timed_out"] or result["exit_code"] != 0:
                raise LifecycleError(f"candidate validation command {index} failed")
    finally:
        shutil.rmtree(clone, ignore_errors=True)
    receipt = artifact / "receipt.json"
    atomic_json(receipt, {"schema_version": "juno_lifecycle_validation.v1", "passed": True, "candidate_sha": tip,
                          "controller_routing_unset": True, "commands": results})
    state["validation_status"] = "passed"
    save_state(path, state, "CANDIDATE_VALIDATED", receipt=(f"validation_{state['review_round']}", receipt))


def render_review(manifest: dict[str, Any], state: dict[str, Any], reviewer: str, artifact: Path, kind: str = "high-risk pre-CAS") -> Path:
    repo = manifest["repositories"][0]
    template = Path(repo["path"]).resolve() / ".juno_task/prompts/review_commit_parallel_runner.md"
    checklist = Path(str(manifest["requirements_checklist"])).resolve()
    if not template.is_file() or not checklist.is_file():
        raise LifecycleError("review template and requirements_checklist must exist")
    prior = artifact.parent / "prior-findings.json"
    if not prior.exists():
        previous_packet = artifact.parent.parent / f"review-{max(0, state['review_round'] - 1)}" / "repair-packet.json"
        atomic_json(prior, load_mapping(previous_packet) if previous_packet.is_file() else {"findings": []})
    validation = path_for_receipt(state, f"validation_{max(0, state['review_round'] - 1)}")
    values = {
        "task_id": manifest["task_id"], "review_kind": kind, "reviewer_index": reviewer,
        "repository": str(Path(repo["path"]).resolve()), "base_sha": repo["approved_base_sha"],
        "tip_sha": state["candidate_sha"], "checklist_path": str(checklist),
        "requirements_bundle": checklist.read_text(encoding="utf-8"),
        "findings_summary_path": str(prior), "findings_summary": prior.read_text(encoding="utf-8"),
        "validation_evidence_path": str(validation),
    }
    text = template.read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{{ " + key + " }}", value)
    if re.search(r"{{\s*[^}]+\s*}}", text):
        raise LifecycleError("unresolved canonical review template variable")
    prompt = artifact / "prompt.md"
    artifact.mkdir(parents=True, exist_ok=True)
    prompt.write_text(text, encoding="utf-8")
    return prompt


def path_for_receipt(state: dict[str, Any], key: str) -> Path:
    value = state["receipts"].get(key)
    if not isinstance(value, dict):
        raise LifecycleError(f"missing state receipt: {key}")
    path = Path(value["path"])
    if not path.is_file() or file_digest(path) != value["sha256"]:
        raise LifecycleError(f"state receipt drift: {key}")
    return path


def extract_session_id(stdout: str, stderr: str) -> str | None:
    text = stdout + "\n" + stderr
    matches = re.findall(r"(?im)(?:session[_ ]id|session id\(s\))\s*[:=]\s*([A-Za-z0-9._:-]+)", text)
    return matches[-1] if matches else None


def strict_verdict(text: str) -> tuple[str, list[str]]:
    """Parse only the last contiguous machine-verdict block.

    Launchers may echo the prompt (including its example verdicts), so earlier
    blocks are transport noise.  The final block itself remains fail-closed.
    """
    blocks: list[list[str]] = []
    current: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line == "JUNO_REVIEW_VERDICT: PASS" or (
            line.startswith("JUNO_REVIEW_FINDING: ") and len(line) > len("JUNO_REVIEW_FINDING: ")
        ):
            current.append(line)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    if not blocks:
        raise LifecycleError("review output lacks a strict verdict class")
    final = blocks[-1]
    passes = [line for line in final if line == "JUNO_REVIEW_VERDICT: PASS"]
    findings = [line for line in final if line.startswith("JUNO_REVIEW_FINDING: ")]
    if passes and findings or len(passes) > 1:
        raise LifecycleError("review output contains contradictory or unsupported final verdict block")
    if passes:
        return "PASS", []
    return "FINDINGS", findings


def review_pair(manifest: dict[str, Any], state: dict[str, Any], path: Path) -> None:
    repo = manifest["repositories"][0]
    task = Path(repo["task_worktree"]).resolve()
    frozen = state["candidate_sha"]
    previous_round = state["review_round"]
    round_number = previous_round + 1
    state["review_round"] = round_number
    root = path.parent / f"review-{round_number}"
    outcomes = []
    session_ids: set[str] = set()
    for reviewer in ("A", "B") if state["effective_risk"] == "high" else ("A",):
        if git(task, "rev-parse", "HEAD") != frozen or git(task, "status", "--porcelain=v2", "--untracked-files=all"):
            state["review_round"] = previous_round
            raise LifecycleError("candidate changed during sequential same-tip review")
        artifact = root / f"reviewer-{reviewer.lower()}"
        prompt = render_review(manifest, state, reviewer, artifact)
        result = run_command(agent_command(manifest, prompt, "review"), Path(manifest["controller_root"]).resolve(), artifact / "process",
                             timeout=float(manifest["timeouts"]["agent_seconds"]), env=review_environment(manifest))
        if result["timed_out"] or result["exit_code"] != 0:
            state["review_round"] = previous_round
            raise LifecycleError(f"Reviewer {reviewer} launcher/process failed before semantic completion")
        try:
            verdict, findings = strict_verdict(result["stdout_text"])
        except LifecycleError:
            state["review_round"] = previous_round
            raise
        session_id = extract_session_id(result["stdout_text"], result["stderr_text"])
        if not session_id:
            state["review_round"] = previous_round
            raise LifecycleError(f"Reviewer {reviewer} lacks fresh session identity evidence")
        if session_id in session_ids:
            state["review_round"] = previous_round
            raise LifecycleError(f"Reviewer {reviewer} reused review session identity")
        session_ids.add(session_id)
        receipt = artifact / "receipt.json"
        atomic_json(receipt, {"schema_version": "juno_independent_review.v1", "reviewer": reviewer,
                              "base_sha": repo["approved_base_sha"], "reviewed_tip": frozen,
                              "verdict": verdict, "findings": findings, "session_id": session_id,
                              "process_receipt_sha256": file_digest(artifact / "process" / "receipt.json")})
        outcomes.append(load_mapping(receipt))
    if git(task, "rev-parse", "HEAD") != frozen:
        state["review_round"] = previous_round
        raise LifecycleError("candidate changed before review pair consolidation")
    pair = root / "pair.json"
    all_findings = [finding for outcome in outcomes for finding in outcome["findings"]]
    atomic_json(pair, {"schema_version": "juno_review_pair.v1", "base_sha": repo["approved_base_sha"],
                       "tip_sha": frozen, "sequential": True, "same_tip": True, "outcomes": outcomes,
                       "passed": not all_findings, "findings": all_findings})
    if all_findings:
        packet = root / "repair-packet.json"
        groups: dict[str, dict[str, Any]] = {}
        for finding in all_findings:
            body = finding.split(":", 1)[1].strip()
            pieces = [piece.strip() for piece in body.split(";", 3)]
            key = pieces[1] if len(pieces) > 1 else body
            groups.setdefault(key, {"requirement": key, "findings": [], "acceptance_conditions": []})
            groups[key]["findings"].append(finding)
            if len(pieces) == 4:
                groups[key]["acceptance_conditions"].append(pieces[3])
        atomic_json(packet, {"schema_version": "juno_consolidated_repair.v1", "failed_tip": frozen,
                             "root_cause_groups": list(groups.values()), "all_reviewers_completed": True})
        state["review_status"] = "findings"
        save_state(path, state, "REPAIR_REQUIRED", receipt=(f"review_pair_{round_number}", pair))
        return
    consolidated = root / "premerge-review.json"
    atomic_json(consolidated, {"schema_version": REVIEW_SCHEMA, "review_kind": "pre_merge", "passed": True,
                               "reviewed_tip": frozen, "open_bugs": [], "independent_review_pair_sha256": file_digest(pair)})
    state["review_status"] = "passed"
    state["review_passed"] = True
    save_state(path, state, "REVIEWED_PASS", receipt=("premerge_review", consolidated))


def owner_waiver(manifest: dict[str, Any], state: dict[str, Any]) -> dict[str, Any] | None:
    controller = manifest.get("controller_root")
    if not controller:
        return None
    wrapper = Path(controller).resolve() / ".juno_task/scripts/kanban.sh"
    if not wrapper.is_file():
        return None
    result = subprocess.run([str(wrapper), "get", manifest["task_id"], "-f", "json"], cwd=controller,
                            text=True, capture_output=True, stdin=subprocess.DEVNULL)
    if result.returncode:
        return None
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    task = value[0] if isinstance(value, list) and len(value) == 1 else value
    fields = task.get("fields") if isinstance(task, dict) else None
    decision = fields.get(OWNER_REVIEW_FIELD) if isinstance(fields, dict) else None
    if not isinstance(decision, dict):
        return None
    expected = {"status": "waived_by_owner", "candidate_sha": state["candidate_sha"]}
    if any(decision.get(key) != expected_value for key, expected_value in expected.items()):
        return None
    projection = {"task_id": manifest["task_id"], "objective_risk": manifest["objective_risk"],
                  "effective_risk": state["effective_risk"], "decision": decision}
    return {"schema_version": "juno_owner_review_waiver.v1", "status": "waived_by_owner",
            "candidate_sha": state["candidate_sha"], "review_passed": False,
            **projection, "kanban_projection_sha256": digest(projection)}


def controller_checkpoint(manifest: dict[str, Any], state: dict[str, Any], path: Path, label: str) -> None:
    controller = Path(manifest["controller_root"]).resolve()
    script = controller / ".juno_task/scripts/controller_checkpoint.py"
    command = manifest.get("controller_checkpoint_command")
    if command is None:
        if not script.is_file():
            raise LifecycleError("managed controller checkpoint runtime is missing")
        command = [sys.executable, str(script), "commit", "--message", f"chore(controller): checkpoint lifecycle {label}"]
    env = dict(os.environ)
    env.update({"JUNO_TASK_ROOT": str(controller), "JUNO_WORKSPACE_ROLE": "controller", "JUNO_WORKSPACE_ENFORCEMENT": "strict"})
    artifact = path.parent / "controller-checkpoint" / label
    result = run_command(command, controller, artifact, timeout=120, env=env)
    if result["timed_out"] or result["exit_code"] != 0:
        state["controller_checkpoint"] = f"{label}_failed"
        raise LifecycleError(f"controller checkpoint failed at {label}")
    receipt = artifact / "lifecycle-receipt.json"
    atomic_json(receipt, {"schema_version": "juno_lifecycle_controller_checkpoint.v1", "passed": True,
                          "label": label, "process_receipt_sha256": file_digest(artifact / "receipt.json")})
    state["controller_checkpoint"] = f"{label}_passed"
    save_state(path, state, "CONTROLLER_CHECKPOINTED", receipt=(f"controller_checkpoint_{label}", receipt), detail={"return_phase": state.get("checkpoint_return_phase")})


def review_composed_candidate(manifest: dict[str, Any], state: dict[str, Any], candidate: dict[str, Any], root: Path) -> Path:
    repo = manifest["repositories"][0]
    template = Path(repo["path"]).resolve() / ".juno_task/prompts/review_commit_parallel_runner.md"
    checklist = Path(str(manifest["requirements_checklist"])).resolve()
    artifact = root / "candidate-review"
    artifact.mkdir(parents=True, exist_ok=True)
    prior_source = root.parent / f"review-{state['review_round']}" / "prior-findings.json"
    prior_value = load_mapping(prior_source) if prior_source.is_file() else {"findings": []}
    prior = artifact / "prior-findings.json"; atomic_json(prior, prior_value)
    values = {
        "task_id": manifest["task_id"], "review_kind": "composed candidate", "reviewer_index": "candidate",
        "repository": str(Path(candidate["candidate_path"]).resolve()), "base_sha": candidate["expected_target_sha"],
        "tip_sha": candidate["candidate_sha"], "checklist_path": str(checklist),
        "requirements_bundle": checklist.read_text(encoding="utf-8"),
        "findings_summary_path": str(prior), "findings_summary": prior.read_text(encoding="utf-8"),
        "validation_evidence_path": str((root / "candidate.json").resolve()),
    }
    text = template.read_text(encoding="utf-8")
    for key, value in values.items(): text = text.replace("{{ " + key + " }}", value)
    if re.search(r"{{\s*[^}]+\s*}}", text):
        raise LifecycleError("unresolved canonical review template variable")
    prompt = artifact / "prompt.md"; prompt.write_text(text, encoding="utf-8")
    result = run_command(agent_command(manifest, prompt, "review"), Path(manifest["controller_root"]).resolve(), artifact / "process",
                         timeout=float(manifest["timeouts"]["agent_seconds"]), env=review_environment(manifest))
    if result["timed_out"] or result["exit_code"] != 0: raise LifecycleError("composed candidate review launcher failed")
    verdict, findings = strict_verdict(result["stdout_text"])
    receipt = artifact / "receipt.json"
    atomic_json(receipt, {"schema_version": REVIEW_SCHEMA, "review_kind": "candidate", "passed": verdict == "PASS",
                          "reviewed_tip": candidate["candidate_sha"], "open_bugs": findings})
    if verdict != "PASS": raise LifecycleError("composed candidate semantic review found blocking issues")
    return receipt


def record_owner_waiver(state: dict[str, Any], path: Path, waiver: dict[str, Any]) -> None:
    receipt = path.parent / "owner-waiver.json"
    atomic_json(receipt, waiver)
    state["review_status"] = "waived_by_owner"; state["review_passed"] = False
    save_state(path, state, "REVIEW_WAIVED_BY_OWNER", receipt=("owner_waiver", receipt))


def capture_controller_sync(value: dict[str, Any], state: dict[str, Any]) -> None:
    try:
        terminal_line = [line for line in value.pop("_helper_stdout_text", "").splitlines() if line.strip().startswith("{")][-1]
        sync = json.loads(terminal_line).get("controller_sync", {})
    except (IndexError, json.JSONDecodeError):
        sync = {}
    outcome = str(sync.get("outcome") or "unknown")
    projection: dict[str, Any] = {"outcome": outcome}
    if isinstance(sync.get("candidateSha"), str):
        projection["candidate_sha"] = sync["candidateSha"]
    receipt_path = Path(str(sync.get("receiptPath") or "")).expanduser()
    if receipt_path.is_absolute() and receipt_path.is_file():
        projection["receipt"] = {"path": str(receipt_path.resolve()), "sha256": file_digest(receipt_path)}
    state["controller_sync"] = outcome
    state["controller_sync_evidence"] = projection


def candidate_and_integrate(manifest: dict[str, Any], state: dict[str, Any], path: Path) -> None:
    repo = manifest["repositories"][0]
    repository = Path(repo["path"]).resolve()
    assets = scripts(repository)
    root = path.parent / "integration"
    root.mkdir(parents=True, exist_ok=True)
    matrix = root / "requirements-matrix.json"
    atomic_json(matrix, {"task_acceptance": "PASS", "closure_audit": "PASS", "candidate_validation": "PASS"})
    acceptance_key = "premerge_review" if state["review_status"] == "passed" else "owner_waiver"
    premerge = path_for_receipt(state, acceptance_key)
    reviewed_task_tip = state.get("reviewed_task_tip_sha") or state["candidate_sha"]
    state["reviewed_task_tip_sha"] = reviewed_task_tip
    plan = root / "candidate-plan.json"
    command = [sys.executable, str(assets["candidate"]), "plan", "--repository", str(repository),
               "--target-ref", repo["target_ref"], "--base-sha", repo["approved_base_sha"],
               "--reviewed-tip", reviewed_task_tip, "--task-worktree", str(Path(repo["task_worktree"]).resolve()),
               "--task-id", manifest["task_id"],
               "--premerge-review" if acceptance_key == "premerge_review" else "--owner-waiver", str(premerge),
               "--pdr-matrix", str(matrix)]
    for expected in repo["expected_paths"]:
        command += ["--expected-path", expected]
    channel_owner = repo.get("target_channel_owner")
    if channel_owner:
        command += ["--target-channel-owner", str(Path(channel_owner).resolve())]
    helper(command + ["--output", str(plan)], repository, plan)
    built = root / "candidate.json"
    candidate_path = root / "composed-candidate"
    helper([sys.executable, str(assets["candidate"]), "build", "--plan", str(plan), "--candidate-path", str(candidate_path),
            "--validation-command", "git diff --check", "--output", str(built)], repository, built,
           timeout=float(manifest["timeouts"]["validation_seconds"]))
    candidate = load_mapping(built)
    review_args: list[str] = []
    if candidate.get("candidate_bytes_changed_by_composition") is True:
        composed_validation = root / "composed-validation"
        composed_clone = composed_validation / "checkout"
        composed_source = Path(candidate["candidate_path"]).resolve()
        cloned = subprocess.run(["git", "clone", "--no-local", "--no-checkout", str(composed_source), str(composed_clone)],
                                text=True, capture_output=True, stdin=subprocess.DEVNULL)
        if cloned.returncode: raise LifecycleError(f"composed validation clone failed: {cloned.stderr.strip()}")
        git(composed_clone, "checkout", "--detach", candidate["candidate_sha"])
        isolated_env = {key: value for key, value in os.environ.items() if key not in {
            "JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT"
        }}
        try:
            for index, validation_command in enumerate(manifest["validation_commands"], start=1):
                result = run_command(validation_command, composed_clone, composed_validation / f"command-{index:03d}",
                                     timeout=float(manifest["timeouts"]["validation_seconds"]), env=isolated_env)
                if result["timed_out"] or result["exit_code"] != 0:
                    raise LifecycleError(f"composed candidate validation command {index} failed")
        finally:
            shutil.rmtree(composed_clone, ignore_errors=True)
        candidate_review = review_composed_candidate(manifest, state, candidate, root)
        review_args = ["--candidate-review", str(candidate_review)]
    eligible = root / "eligible.json"
    helper([sys.executable, str(assets["candidate"]), "verify", "--candidate", str(built), *review_args, "--output", str(eligible)], repository, eligible)
    candidate_sha = candidate["candidate_sha"]
    expected_target_sha = candidate["expected_target_sha"]
    state["candidate_sha"] = candidate_sha
    state["candidate_path"] = str(Path(candidate["candidate_path"]).resolve())
    state["candidate_composed"] = candidate.get("candidate_bytes_changed_by_composition") is True
    integration = root / "integration.json"
    actual_receipt = root / "actual-review.json"
    actual_artifact = root / "actual-review-process"
    actual_validation = actual_artifact / "validation.json"
    atomic_json(actual_validation, {"candidate_sha": candidate_sha, "deterministic_actual_target_validation": "passed"})
    actual_state = {"candidate_sha": candidate_sha, "review_round": 0, "receipts": {
        "validation_0": {"path": str(actual_validation), "sha256": file_digest(actual_validation)}
    }}
    actual_prompt = render_review(manifest, actual_state, "actual-target", actual_artifact,
                                  kind="delivery-sensitive post-CAS")
    actual_command = shlex.join(agent_command(manifest, actual_prompt, "review"))
    integrate = [sys.executable, str(assets["integrate"]), "integrate", "--repository",
                 f"root={repository},{repo['target_ref']},{expected_target_sha},{candidate_sha}",
                 "--candidate-receipt", str(eligible), "--risk-tier", state["effective_risk"],
                 "--checked-out-target", "detach_same_sha", "--validation-command", "git diff --check",
                 "--task-id", manifest["task_id"], "--output", str(integration)]
    delivery_sensitive = state["effective_risk"] == "high" or any(
        any(part in changed for part in DELIVERY_PATH_PARTS)
        for changed in changed_paths(repository, repo["approved_base_sha"], candidate_sha)
    ) or candidate.get("candidate_bytes_changed_by_composition") is True
    if delivery_sensitive:
        integrate += ["--require-actual-review", "--actual-review-command", actual_command,
                      "--actual-review-receipt", str(actual_receipt)]
    state["integration_status"] = "in_progress"
    save_state(path, state, "INTEGRATING", detail={"integration_receipt": str(integration), "eligible_receipt": str(eligible)})
    try:
        value = helper(integrate, repository, integration, timeout=float(manifest["timeouts"]["validation_seconds"]),
                       env=review_environment(manifest))
    except LifecycleError:
        if integration.is_file():
            partial = load_mapping(integration)
            moved = any(update.get("status") in {"moved", "resumed_already_moved"} for update in partial.get("updates", []))
            state["integration_status"] = str(partial.get("outcome") or "failed_preserved")
            if moved:
                state["integrated_sha"] = candidate_sha
                error = str(partial.get("error") or "")
                if error.startswith("actual_target_review"):
                    state["actual_target_verification"] = "passed"
                    state["actual_target_review"] = "failed"
                elif error in {"actual_target_validation_failed", "actual target readback mismatch"}:
                    state["actual_target_verification"] = "failed"
                else:
                    state["actual_target_verification"] = "incomplete"
            save_state(path, state, "PARTIAL_INTEGRATION" if moved else "READY_TO_INTEGRATE",
                       receipt=("integration_partial", integration),
                       detail={"error": partial.get("error"), "resume_stage": partial.get("resume_stage")})
        raise
    state["integrated_sha"] = candidate_sha
    state["integration_status"] = "integrated"
    state["actual_target_verification"] = "passed"
    state["actual_target_review"] = "passed" if value.get("actual_semantic_review") == "performed" else "not_required_by_policy"
    capture_controller_sync(value, state)
    save_state(path, state, "ACTUAL_TARGET_VERIFIED", receipt=("integration", integration))


def resume_partial_integration(manifest: dict[str, Any], state: dict[str, Any], path: Path) -> None:
    repo = manifest["repositories"][0]
    repository = Path(repo["path"]).resolve()
    assets = scripts(repository)
    root = path.parent / "integration"
    prior = path_for_receipt(state, "integration_partial")
    eligible = root / "eligible.json"
    actual_receipt = root / "actual-review.json"
    actual_prompt = root / "actual-review-process" / "prompt.md"
    if not eligible.is_file() or not actual_prompt.is_file():
        raise LifecycleError("partial integration resume evidence is incomplete")
    candidate_sha = state["candidate_sha"]
    built = load_mapping(root / "candidate.json")
    expected_target_sha = built.get("expected_target_sha")
    if not isinstance(expected_target_sha, str):
        raise LifecycleError("partial integration candidate lacks expected target identity")
    actual_command = shlex.join(agent_command(manifest, actual_prompt, "review"))
    attempt = root / f"integration-resume-{state['generation']}.json"
    integrate = [sys.executable, str(assets["integrate"]), "integrate", "--repository",
                 f"root={repository},{repo['target_ref']},{expected_target_sha},{candidate_sha}",
                 "--candidate-receipt", str(eligible), "--resume-receipt", str(prior),
                 "--risk-tier", state["effective_risk"], "--checked-out-target", "detach_same_sha",
                 "--validation-command", "git diff --check", "--task-id", manifest["task_id"],
                 "--output", str(attempt)]
    delivery_sensitive = state["effective_risk"] == "high" or any(
        any(part in changed for part in DELIVERY_PATH_PARTS)
        for changed in changed_paths(repository, repo["approved_base_sha"], candidate_sha)
    ) or state.get("candidate_composed") is True
    if delivery_sensitive:
        integrate += ["--require-actual-review", "--actual-review-command", actual_command,
                      "--actual-review-receipt", str(actual_receipt)]
    try:
        value = helper(integrate, repository, attempt, timeout=float(manifest["timeouts"]["validation_seconds"]),
                       env=review_environment(manifest))
    except LifecycleError:
        if attempt.is_file():
            partial = load_mapping(attempt)
            state["integration_status"] = str(partial.get("outcome") or "partial_local_integration")
            error = str(partial.get("error") or "")
            if error.startswith("actual_target_review"):
                state["actual_target_verification"] = "passed"
                state["actual_target_review"] = "failed"
            elif error in {"actual_target_validation_failed", "actual target readback mismatch"}:
                state["actual_target_verification"] = "failed"
            else:
                state["actual_target_verification"] = "incomplete"
            save_state(path, state, "PARTIAL_INTEGRATION", receipt=("integration_partial", attempt),
                       detail={"error": partial.get("error"), "resume_stage": partial.get("resume_stage")})
        raise
    state["integrated_sha"] = candidate_sha
    state["integration_status"] = "integrated"
    state["actual_target_verification"] = "passed"
    state["actual_target_review"] = "passed" if value.get("actual_semantic_review") == "performed" else "not_required_by_policy"
    capture_controller_sync(value, state)
    save_state(path, state, "ACTUAL_TARGET_VERIFIED", receipt=("integration", attempt), detail={"resumed_partial_integration": True})


def recover_integration(manifest: dict[str, Any], state: dict[str, Any], path: Path) -> None:
    repo = manifest["repositories"][0]; repository = Path(repo["path"]).resolve()
    receipt = path.parent / "integration" / "integration.json"
    target = git(repository, "rev-parse", repo["target_ref"])
    if not receipt.is_file():
        if target != repo["approved_base_sha"]:
            raise LifecycleError("integration interruption moved target without durable integration evidence")
        state["integration_status"] = "not_started"
        save_state(path, state, "READY_TO_INTEGRATE", detail={"recovered_integration": "not_started"})
        return
    value = load_mapping(receipt)
    moved = any(update.get("status") in {"moved", "resumed_already_moved"} for update in value.get("updates", []))
    if value.get("passed") is True and value.get("outcome") == "integrated":
        if target != state["candidate_sha"]:
            raise LifecycleError("completed integration receipt disagrees with actual target")
        state["integrated_sha"] = state["candidate_sha"]; state["integration_status"] = "integrated"
        state["actual_target_verification"] = "passed"
        state["actual_target_review"] = "passed" if value.get("actual_semantic_review") == "performed" else "not_required_by_policy"
        save_state(path, state, "ACTUAL_TARGET_VERIFIED", receipt=("integration", receipt), detail={"recovered_integration": "complete"})
    elif moved:
        if target != state["candidate_sha"]:
            raise LifecycleError("partial integration receipt disagrees with actual target")
        state["integrated_sha"] = state["candidate_sha"]; state["integration_status"] = str(value.get("outcome") or "partial_local_integration")
        error = str(value.get("error") or "")
        state["actual_target_verification"] = "passed" if error.startswith("actual_target_review") else "incomplete"
        state["actual_target_review"] = "failed" if error.startswith("actual_target_review") else "not_started"
        save_state(path, state, "PARTIAL_INTEGRATION", receipt=("integration_partial", receipt), detail={"recovered_integration": "partial"})
    else:
        state["integration_status"] = "failed_preserved"
        save_state(path, state, "READY_TO_INTEGRATE", detail={"recovered_integration": "failed_preserved"})


def terminal_controller_readback(manifest: dict[str, Any], state: dict[str, Any], path: Path, *, recovered: bool = False) -> bool:
    """Prove controller ancestry and canonical Kanban projection before cleanup."""
    successful = {"synced_local", "up_to_date", "verified_local"}
    if state.get("controller_sync") not in successful and not recovered:
        return False
    controller = Path(manifest["controller_root"]).resolve()
    integrated = state.get("integrated_sha")
    try:
        controller_head = git(controller, "rev-parse", "HEAD")
        if not integrated or subprocess.run(["git", "-C", str(controller), "merge-base", "--is-ancestor", integrated, controller_head],
                                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            return False
    except LifecycleError:
        return False
    evidence = state.get("controller_sync_evidence") if isinstance(state.get("controller_sync_evidence"), dict) else {}
    expected_controller = evidence.get("candidate_sha")
    if expected_controller and expected_controller != controller_head:
        return False
    wrapper = controller / ".juno_task/scripts/kanban.sh"
    if not wrapper.is_file():
        return False
    result = subprocess.run([str(wrapper), "get", manifest["task_id"], "-f", "json"], cwd=controller,
                            text=True, capture_output=True, stdin=subprocess.DEVNULL)
    if result.returncode:
        return False
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        return False
    task = value[0] if isinstance(value, list) and len(value) == 1 else value
    expected_task_tip = state.get("reviewed_task_tip_sha") or state.get("candidate_sha")
    if (not isinstance(task, dict) or task.get("id") != manifest["task_id"]
            or task.get("commit_hash") != expected_task_tip):
        return False
    if recovered and state.get("controller_sync") not in successful:
        state["controller_sync"] = "verified_local"
    receipt = path.parent / "controller-terminal-readback.json"
    atomic_json(receipt, {"schema_version": "juno_lifecycle_controller_readback.v1", "passed": True,
                          "task_id": manifest["task_id"], "integrated_sha": integrated,
                          "controller_head": controller_head, "integration_is_ancestor": True,
                          "kanban_status": task.get("status"), "kanban_commit_hash": task.get("commit_hash"),
                          "controller_sync": state["controller_sync"]})
    save_state(path, state, "ACTUAL_TARGET_VERIFIED", receipt=("controller_terminal_readback", receipt),
               detail={"terminal_controller_readback": "passed"})
    return True


def cleanup(manifest: dict[str, Any], state: dict[str, Any], path: Path) -> None:
    repo = manifest["repositories"][0]
    repository = Path(repo["path"]).resolve()
    task = Path(repo["task_worktree"]).resolve()
    assets = scripts(repository)
    cleanup_root = path.parent / "cleanup"
    candidate_path = Path(state.get("candidate_path") or task).resolve()
    if candidate_path != task:
        candidate_receipt = cleanup_root / "candidate.json"
        helper([sys.executable, str(assets["worktree"]), "cleanup", "--repository", str(repository),
                "--path", str(candidate_path), "--target-ref", repo["target_ref"], "--branch-ref", "DETACHED",
                "--expected-head", state["candidate_sha"], "--output", str(candidate_receipt)], repository, candidate_receipt)
    receipt = cleanup_root / "receipt.json"
    reviewed_task_tip = state.get("reviewed_task_tip_sha")
    if not reviewed_task_tip:
        raise LifecycleError("reviewed task-tip identity is missing before cleanup")
    command = [sys.executable, str(assets["worktree"]), "cleanup", "--repository", str(repository), "--path", str(task),
               "--target-ref", repo["target_ref"], "--branch-ref", repo["task_branch_ref"],
               "--expected-head", reviewed_task_tip, "--delete-branch", "--output", str(receipt)]
    try:
        helper(command, repository, receipt)
    except LifecycleError:
        state["cleanup_status"] = "blocked"
        save_state(path, state, "CLEANUP_BLOCKED", detail={"receipt": str(receipt)})
        raise
    state["cleanup_status"] = "complete"
    save_state(path, state, "CLEANUP_COMPLETE", receipt=("cleanup", receipt))


def compact_result(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": RESULT_SCHEMA, "task_id": state["task_id"], "phase": state["phase"],
        "effective_risk": state["effective_risk"], "candidate_sha": state["candidate_sha"],
        "integrated_sha": state["integrated_sha"], "release_sha": state["release_sha"], "release_tag": state["release_tag"],
        "validation_status": state["validation_status"], "review_status": state["review_status"],
        "review_passed": state["review_passed"], "integration_status": state["integration_status"],
        "actual_target_verification": state["actual_target_verification"], "actual_target_review": state["actual_target_review"],
        "controller_sync": state["controller_sync"], "controller_checkpoint": state["controller_checkpoint"],
        "cleanup_status": state["cleanup_status"], "last_error": state["last_error"], "state_sha256": state.get("state_sha256"),
    }


def maximum_review_round(manifest: dict[str, Any], state: dict[str, Any]) -> int:
    extension = manifest["review"].get("owner_authorized_extension_pair_limit", 0)
    maximum = manifest["review"]["initial_pair_limit"] + manifest["review"]["replacement_pair_limit"]
    expected_bases = state.get("review_budget_extension_base_shas")
    if extension and not isinstance(expected_bases, dict):
        raise LifecycleError("owner-authorized review extension bases are missing")
    for index in range(1, extension + 1):
        value = load_mapping(path_for_receipt(state, f"review_budget_extension_{index}"))
        expected_base = expected_bases.get(str(index))
        if (value.get("schema_version") != "juno_review_budget_extension.v1" or value.get("task_id") != state["task_id"]
                or value.get("candidate_sha") != expected_base or value.get("additional_consolidated_repairs") != 1
                or value.get("additional_replacement_pairs") != 1 or value.get("bounded") is not True):
            raise LifecycleError(f"owner-authorized review extension {index} evidence is invalid")
    return maximum + extension


def advance(manifest_path: Path, manifest: dict[str, Any], state: dict[str, Any], path: Path) -> int:
    while True:
        phase = state["phase"]
        if phase == "PLANNED": prepare(manifest, state, path)
        elif phase == "IMPLEMENT_READY":
            save_state(path, state, "IMPLEMENTING")
            dispatch_implementation(manifest, state, path)
        elif phase in {"CANDIDATE_FROZEN", "REPLACEMENT_VALIDATED"}:
            closure_audit(manifest, state, path)
        elif phase == "CLOSURE_AUDITED": isolated_validation(manifest, state, path)
        elif phase == "CANDIDATE_VALIDATED":
            waiver = owner_waiver(manifest, state)
            if waiver: record_owner_waiver(state, path, waiver)
            else: review_pair(manifest, state, path)
        elif phase == "REPAIR_REQUIRED":
            waiver = owner_waiver(manifest, state)
            if waiver:
                record_owner_waiver(state, path, waiver)
                continue
            if state["review_round"] >= maximum_review_round(manifest, state):
                state["review_status"] = "budget_exhausted"
                save_state(path, state, "REVIEW_BUDGET_EXHAUSTED")
                return 3
            state["repair_base_sha"] = state["candidate_sha"]
            save_state(path, state, "REPAIRING")
            dispatch_implementation(manifest, state, path, repair=True)
        elif phase in {"REVIEWED_PASS", "REVIEW_WAIVED_BY_OWNER"}:
            state["checkpoint_return_phase"] = "READY_TO_INTEGRATE"
            controller_checkpoint(manifest, state, path, "review-ready")
        elif phase == "CONTROLLER_CHECKPOINTED":
            return_phase = state.pop("checkpoint_return_phase", None)
            if return_phase == "READY_TO_INTEGRATE":
                save_state(path, state, "READY_TO_INTEGRATE")
            elif return_phase == "COMPLETE":
                save_state(path, state, "COMPLETE")
            else:
                raise LifecycleError("controller checkpoint return phase is missing")
        elif phase == "READY_TO_INTEGRATE": candidate_and_integrate(manifest, state, path)
        elif phase == "INTEGRATING": recover_integration(manifest, state, path)
        elif phase == "PARTIAL_INTEGRATION": resume_partial_integration(manifest, state, path)
        elif phase == "ACTUAL_TARGET_VERIFIED":
            if not terminal_controller_readback(manifest, state, path):
                save_state(path, state, "CONTROLLER_SYNC_REQUIRED",
                           detail={"controller_sync": state.get("controller_sync"), "cleanup_withheld": True})
                return 3
            cleanup(manifest, state, path)
        elif phase == "CONTROLLER_SYNC_REQUIRED":
            # A controller owner may repair synchronization out of band. Resume
            # only after direct ancestry and canonical Kanban readback prove it.
            if not terminal_controller_readback(manifest, state, path, recovered=True):
                save_state(path, state, "CONTROLLER_SYNC_REQUIRED",
                           detail={"controller_sync": state.get("controller_sync"), "cleanup_withheld": True})
                return 3
            cleanup(manifest, state, path)
        elif phase == "CLEANUP_COMPLETE":
            state["checkpoint_return_phase"] = "COMPLETE"
            controller_checkpoint(manifest, state, path, "terminal")
        elif phase in TERMINAL or phase == "CLEANUP_BLOCKED": return 0 if phase in {"COMPLETE", "REVIEW_WAIVED_BY_OWNER"} else 3
        elif phase == "REPAIRING": recover_interrupted_worker(manifest, state, path, repair=True)
        elif phase == "IMPLEMENTING": recover_interrupted_worker(manifest, state, path, repair=False)
        else: raise LifecycleError(f"unsupported or non-resumable phase: {phase}")


def actual_review(args: argparse.Namespace) -> int:
    manifest = validate_manifest(load_mapping(Path(args.manifest)))
    repo = manifest["repositories"][0]
    artifact = Path(args.output).resolve().parent / "actual-review-process"
    state = {"candidate_sha": args.tip, "review_round": 0, "receipts": {}}
    validation = artifact / "validation.json"
    atomic_json(validation, {"candidate_sha": args.tip, "deterministic_actual_target_validation": "passed"})
    state["receipts"]["validation_0"] = {"path": str(validation), "sha256": file_digest(validation)}
    prompt = render_review(manifest, state, "actual-target", artifact, kind="delivery-sensitive post-CAS")
    result = run_command(agent_command(manifest, prompt, "review"), Path(manifest["controller_root"]).resolve(), artifact / "process",
                         timeout=float(manifest["timeouts"]["agent_seconds"]), env=review_environment(manifest))
    if result["timed_out"] or result["exit_code"] != 0:
        return 2
    verdict, findings = strict_verdict(result["stdout_text"])
    atomic_json(Path(args.output), {"schema_version": REVIEW_SCHEMA, "review_kind": "actual_target",
                                   "passed": verdict == "PASS", "reviewed_tip": args.tip, "open_bugs": findings})
    return 0 if verdict == "PASS" else 2


def public_run(args: argparse.Namespace, resume: bool) -> int:
    manifest_value = getattr(args, "manifest", None)
    state_value = getattr(args, "state", None)
    manifest_path = Path(manifest_value).resolve() if manifest_value else None
    explicit_state = Path(state_value).resolve() if state_value else None
    if resume:
        if explicit_state is None:
            raise LifecycleError("resume requires --state")
        state = load_state(explicit_state)
        manifest_path = Path(state["manifest"]["path"])
        if not manifest_path.is_file() or file_digest(manifest_path) != state["manifest"]["sha256"]:
            raise LifecycleError("frozen lifecycle manifest drift")
        manifest = validate_manifest(load_mapping(manifest_path))
        path = explicit_state
    else:
        if manifest_path is None:
            raise LifecycleError("run requires --manifest")
        manifest = validate_manifest(load_mapping(manifest_path))
        path = state_path(manifest, explicit_state)
        if path.exists():
            raise LifecycleError(f"state already exists; use resume: {path}")
        state = new_state(manifest_path, manifest)
        save_state(path, state, "PLANNED")
    try:
        code = advance(manifest_path, manifest, state, path)
    except LifecycleError as exc:
        state["last_error"] = str(exc)
        state["state_sha256"] = digest({key: value for key, value in state.items() if key != "state_sha256"})
        atomic_json(path, state)
        print(f"lifecycle: error: {exc}", file=sys.stderr)
        print(json.dumps(compact_result(state), sort_keys=True))
        return 2
    print(json.dumps(compact_result(state), sort_keys=True))
    return code


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Run one resumable single-repository task lifecycle", allow_abbrev=False)
    sub = root.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", allow_abbrev=False); run.add_argument("--manifest", required=True); run.add_argument("--state")
    resume = sub.add_parser("resume", allow_abbrev=False); resume.add_argument("--state", required=True)
    status = sub.add_parser("status", allow_abbrev=False); status.add_argument("--state", required=True)
    internal = sub.add_parser("_actual-review", help=argparse.SUPPRESS, allow_abbrev=False)
    internal.add_argument("--manifest", required=True); internal.add_argument("--tip", required=True); internal.add_argument("--output", required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "run": return public_run(args, False)
        if args.command == "resume": return public_run(args, True)
        if args.command == "status":
            print(json.dumps(compact_result(load_state(Path(args.state).resolve())), sort_keys=True)); return 0
        if args.command == "_actual-review": return actual_review(args)
        raise LifecycleError("unsupported command")
    except (LifecycleError, OSError, json.JSONDecodeError) as exc:
        print(f"lifecycle: error: {exc}", file=sys.stderr); return 2


if __name__ == "__main__":
    raise SystemExit(main())
