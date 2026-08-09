#!/usr/bin/env python3
"""Configured, receipt-backed integration/controller Git synchronization for Juno projects."""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

sys.dont_write_bytecode = True
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

SCHEMA_V1 = "juno_git_flow.v1"
SCHEMA = "juno_git_flow.v2"
SYNC_SCHEMA = "juno_controller_sync.v1"
DEFAULT_CONTROLLER = [
    ".juno_task/archive", ".juno_task/attachments", ".juno_task/ledger",
    ".juno_task/plan.md", ".juno_task/sessions", ".juno_task/specs",
    ".juno_task/tasks", ".juno_task/tmp", ".juno_task/workflows",
]
DEFAULT_SHARED = [
    ".juno_task/config.json", ".juno_task/scripts", ".juno_task/config",
    ".juno_task/prompts", ".juno_task/wiki", "AGENTS.md",
]
PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
class FlowError(Exception):
    pass


def run(argv: list[str], cwd: Path, check: bool = True, *, timeout: float | None = None,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, stdin=subprocess.DEVNULL,
                                timeout=timeout, env=env or {**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    except subprocess.TimeoutExpired as exc:
        raise FlowError(f"command timed out after {timeout}s") from exc
    if check and result.returncode:
        raise FlowError(result.stderr.strip() or result.stdout.strip() or f"command failed: {' '.join(argv)}")
    return result


def git(repo: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(repo), *args], repo, check).stdout.strip()


def root(path: Path) -> Path:
    value = git(path, "rev-parse", "--show-toplevel", check=False)
    if not value:
        raise FlowError(f"not a Git worktree: {path}")
    return Path(value).resolve()


def common(path: Path) -> Path:
    return Path(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()


def resolve(repo: Path, ref: str) -> str:
    value = git(repo, "rev-parse", f"{ref}^{{commit}}", check=False)
    if not re.fullmatch(r"[0-9a-f]{40,64}", value):
        raise FlowError(f"missing commit ref: {ref}")
    return value


def full_ref(branch: str) -> str:
    value = branch if branch.startswith("refs/heads/") else f"refs/heads/{branch}"
    if not value.startswith("refs/heads/") or value == "refs/heads/":
        raise FlowError("branch must be a full local head ref")
    return value


def short_ref(branch: str) -> str:
    return full_ref(branch).removeprefix("refs/heads/")


def remote_ref(remote: str, branch: str) -> str:
    return f"refs/remotes/{remote}/{short_ref(branch)}"


def clean(repo: Path) -> bool:
    return git(repo, "status", "--porcelain=v2", "--untracked-files=all") == ""


def attached(repo: Path) -> str | None:
    return git(repo, "symbolic-ref", "-q", "HEAD", check=False) or None


def ancestor(repo: Path, old: str, new: str) -> bool:
    return run(["git", "-C", str(repo), "merge-base", "--is-ancestor", old, new], repo, False).returncode == 0


def counts(repo: Path, left: str, right: str) -> tuple[int, int]:
    a, b = git(repo, "rev-list", "--left-right", "--count", f"{left}...{right}").split()
    return int(a), int(b)


def digest_json(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_write(path: Path, payload: dict[str, Any], *, replace: bool = False) -> None:
    path = path.expanduser().resolve()
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if path.exists() and not replace:
        if path.read_text(encoding="utf-8") == encoded:
            return
        raise FlowError(f"immutable receipt collision: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(encoded); handle.flush(); os.fsync(handle.fileno())
    temporary.replace(path)


def controller(invocation: Path) -> Path:
    resolver = SCRIPT_DIR / "controller_resolver.py"
    if not resolver.is_file():
        raise FlowError("controller_resolver.py is required")
    result = run([sys.executable, str(resolver), "--cwd", str(invocation),
                  "--operation", "diagnostic", "--format", "json"], invocation, False)
    if result.returncode:
        raise FlowError(result.stderr.strip() or "controller resolver refused Git-flow context")
    try:
        payload = json.loads(result.stdout); candidate = Path(str(payload["path"])).resolve()
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise FlowError("controller resolver returned invalid JSON") from exc
    if payload.get("valid") is not True:
        raise FlowError("controller resolver returned invalid context")
    return candidate


def safe_policy_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if (not value or value != value.strip() or path.is_absolute() or ".." in path.parts
            or value in {".", ".git"} or path.parts[0] == ".git" or "\\" in value
            or any(c in value for c in "*?[]{}") or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise FlowError(f"unsafe policy path: {value!r}")
    return path


def normalize_paths(value: Any, name: str, *, required: bool = False) -> list[str]:
    if not isinstance(value, list) or (required and not value) or any(not isinstance(item, str) for item in value):
        raise FlowError(f"{name} must be {'a non-empty ' if required else 'an '}array of strings")
    output = sorted({str(safe_policy_path(item)) for item in value})
    if len(output) != len(value):
        raise FlowError(f"{name} must contain unique normalized paths")
    for left in output:
        for right in output:
            if left != right and right.startswith(left + "/"):
                raise FlowError(f"{name} contains overlapping paths: {left}, {right}")
    return output


def overlap(left: str, right: str) -> bool:
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def validate_policy(value: Any, *, allow_v1: bool = True) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise FlowError("Git-flow policy must be an object")
    schema = value.get("schemaVersion")
    if schema == SCHEMA_V1 and allow_v1:
        controller_paths = normalize_paths(value.get("controllerOwnedPaths"), "controllerOwnedPaths", required=True)
        return {**value, "controllerOwnedPaths": controller_paths}
    if schema != SCHEMA:
        raise FlowError(f"Git-flow policy schema must be {SCHEMA}")
    allowed = {"schemaVersion", "projectId", "remote", "integrationBranch", "controllerBranch", "checkoutMode",
               "submodules", "controllerOwnedPaths", "sharedPaths", "controllerSync"}
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise FlowError(f"unknown Git-flow policy fields: {unknown}")
    project_id = value.get("projectId")
    if not isinstance(project_id, str) or not PROJECT_ID_RE.fullmatch(project_id):
        raise FlowError("projectId must be a safe 1-128 character slug")
    for key in ("remote", "integrationBranch", "controllerBranch"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise FlowError(f"Git-flow policy requires {key}")
    source_ref, target_ref = full_ref(value["integrationBranch"]), full_ref(value["controllerBranch"])
    if source_ref == target_ref:
        raise FlowError("integrationBranch and controllerBranch must be distinct")
    if value.get("checkoutMode") != "detached":
        raise FlowError("Git-flow v2 requires checkoutMode=detached")
    sub = value.get("submodules")
    if not isinstance(sub, dict) or set(sub) != {"mode", "advanceConfiguredBranches"} or sub.get("mode") not in {"exact", "tracking"} or not isinstance(sub.get("advanceConfiguredBranches"), bool):
        raise FlowError("invalid submodules policy")
    controller_paths = normalize_paths(value.get("controllerOwnedPaths"), "controllerOwnedPaths", required=True)
    shared_paths = normalize_paths(value.get("sharedPaths"), "sharedPaths")
    collisions = [(a, b) for a in controller_paths for b in shared_paths if overlap(a, b)]
    if collisions:
        raise FlowError(f"controller/shared path overlap: {collisions}")
    sync = value.get("controllerSync")
    expected_sync = {"enabled", "mode", "validationCommands", "validationTimeoutSeconds", "lockTimeoutSeconds"}
    if not isinstance(sync, dict) or set(sync) != expected_sync:
        raise FlowError("controllerSync has invalid or unknown fields")
    if not isinstance(sync.get("enabled"), bool) or sync.get("mode") != "auto-when-safe":
        raise FlowError("controllerSync requires boolean enabled and mode=auto-when-safe")
    commands = sync.get("validationCommands")
    if not isinstance(commands, list) or any(not isinstance(command, str) or not command.strip() or "\x00" in command for command in commands):
        raise FlowError("controllerSync.validationCommands must be non-empty command strings")
    if not isinstance(sync.get("validationTimeoutSeconds"), int) or not 1 <= sync["validationTimeoutSeconds"] <= 86400:
        raise FlowError("controllerSync.validationTimeoutSeconds must be 1..86400")
    if not isinstance(sync.get("lockTimeoutSeconds"), int) or not 0 <= sync["lockTimeoutSeconds"] <= 300:
        raise FlowError("controllerSync.lockTimeoutSeconds must be 0..300")
    return {**value, "integrationBranch": short_ref(source_ref), "controllerBranch": short_ref(target_ref),
            "controllerOwnedPaths": controller_paths, "sharedPaths": shared_paths}


def validate_policy_boundaries(controller_root: Path, policy: dict[str, Any]) -> None:
    if policy.get("schemaVersion") != SCHEMA: return
    for relative in [*policy["controllerOwnedPaths"], *policy["sharedPaths"]]:
        current = controller_root
        for part in PurePosixPath(relative).parts:
            current = current / part
            if not current.exists() and not current.is_symlink(): break
            if current.is_symlink(): raise FlowError(f"policy path crosses a symlink: {relative}")
            if current != controller_root and (current / ".git").exists():
                raise FlowError(f"policy path crosses a nested repository: {relative}")
        try: current.resolve(strict=False).relative_to(controller_root)
        except ValueError as exc: raise FlowError(f"policy path escapes controller: {relative}") from exc


def config(controller_root: Path, *, allow_v1: bool = True) -> tuple[dict[str, Any], Path]:
    main_path = controller_root / ".juno_task" / "config.json"
    try:
        main = json.loads(main_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FlowError(f"cannot read Juno config: {exc}") from exc
    flow = main.get("gitFlow")
    if not isinstance(flow, dict) or flow.get("enabled") is not True:
        raise FlowError("Git flow is disabled; run git-flow.sh configure")
    relative = safe_policy_path(str(flow.get("policy") or ""))
    policy_path = (controller_root / relative).resolve()
    try:
        policy_path.relative_to(controller_root)
        value = json.loads(policy_path.read_text(encoding="utf-8"))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise FlowError(f"cannot read Git-flow policy: {exc}") from exc
    policy = validate_policy(value, allow_v1=allow_v1)
    validate_policy_boundaries(controller_root, policy)
    return policy, policy_path


def integration(controller_root: Path) -> Path:
    value = git(controller_root, "config", "--local", "--get", "juno.gitFlow.integrationCheckout", check=False)
    if not value:
        raise FlowError("integration checkout is not registered; run git-flow.sh configure")
    candidate = Path(value).expanduser().resolve()
    if common(candidate) != common(controller_root):
        raise FlowError("integration checkout is not linked to the controller repository")
    return candidate


def fetch(repo: Path, remote: str, branch: str, required: bool = True) -> bool:
    probe = run(["git", "-C", str(repo), "ls-remote", "--exit-code", "--heads", remote, full_ref(branch)], repo, False)
    if probe.returncode == 2:
        if required: raise FlowError(f"remote branch is missing: {remote}/{short_ref(branch)}")
        return False
    if probe.returncode: raise FlowError(probe.stderr.strip() or "git ls-remote failed")
    git(repo, "fetch", "--no-tags", remote, f"+{full_ref(branch)}:{remote_ref(remote, branch)}")
    return True


def tree_has(repo: Path, tree: str, path: str) -> bool:
    return bool(git(repo, "ls-tree", tree, "--", path))


def submodules(repo: Path, tree: str) -> list[dict[str, str]]:
    raw = git(repo, "show", f"{tree}:.gitmodules", check=False)
    if not raw: return []
    with tempfile.NamedTemporaryFile("w", delete=False) as handle:
        handle.write(raw); module_config = Path(handle.name)
    try:
        entries = run(["git", "config", "-f", str(module_config), "--get-regexp", r"^submodule\..*\.path$"], repo, False).stdout.strip()
        rows: list[dict[str, str]] = []
        for line in entries.splitlines():
            key, path = line.split(None, 1); section = key[len("submodule."):-len(".path")]
            entry = git(repo, "ls-tree", tree, "--", path).split()
            if len(entry) < 3 or entry[0] != "160000": raise FlowError(f"missing gitlink at {tree}: {path}")
            branch = run(["git", "config", "-f", str(module_config), "--get", f"submodule.{section}.branch"], repo, False).stdout.strip()
            rows.append({"path": path, "sha": entry[2], "branch": branch})
        return rows
    finally:
        module_config.unlink(missing_ok=True)


def status_payload(invocation: Path, no_fetch: bool = False) -> dict[str, Any]:
    ctl = controller(invocation); policy, policy_path = config(ctl); source = integration(ctl)
    source_ref, target_ref = full_ref(policy["integrationBranch"]), full_ref(policy["controllerBranch"])
    if attached(source): raise FlowError("integration checkout must be detached")
    if not no_fetch:
        fetch(ctl, policy["remote"], source_ref, False); fetch(ctl, policy["remote"], target_ref, False)
    source_tip, checkout_tip, target_tip = resolve(ctl, source_ref), resolve(source, "HEAD"), resolve(ctl, target_ref)
    def relation(local: str, tracking: str) -> dict[str, Any]:
        if not git(ctl, "rev-parse", "--verify", tracking, check=False):
            return {"remoteExists": False, "ahead": None, "behind": None, "remoteSha": None}
        ahead, behind = counts(ctl, local, tracking)
        return {"remoteExists": True, "ahead": ahead, "behind": behind, "remoteSha": resolve(ctl, tracking)}
    source_state = relation(source_ref, remote_ref(policy["remote"], source_ref))
    target_state = relation(target_ref, remote_ref(policy["remote"], target_ref))
    children = []
    for row in submodules(source, checkout_tip):
        child = source / row["path"]; initialized = bool(git(child, "rev-parse", "--show-toplevel", check=False)) if child.is_dir() else False
        item: dict[str, Any] = {**row, "initialized": initialized}
        if initialized:
            head = resolve(child, "HEAD"); item.update({"checkoutSha": head, "detached": attached(child) is None, "clean": clean(child), "gitlinkMatch": head == row["sha"]})
        children.append(item)
    children_ok = all(item.get("initialized") and item.get("clean") and item.get("detached") and item.get("gitlinkMatch") for item in children)
    ready = clean(source) and checkout_tip == source_tip and children_ok
    remote_synced = source_state.get("remoteExists") is True and source_state.get("ahead") == 0 and source_state.get("behind") == 0
    sync_policy = policy.get("controllerSync", {"enabled": False})
    return {"schemaVersion": policy["schemaVersion"], "operation": "status", "fetchPerformed": not no_fetch,
            "policy": str(policy_path), "projectId": policy.get("projectId"), "remote": policy["remote"],
            "integration": {"checkout": str(source), "checkoutSha": checkout_tip, "branch": short_ref(source_ref),
                            "branchSha": source_tip, "detached": True, "clean": clean(source),
                            "protectedPathViolations": [], **source_state},
            "controller": {"checkout": str(ctl), "branch": short_ref(target_ref), "branchSha": target_tip,
                           "clean": clean(ctl), "attachedRef": attached(ctl), **target_state},
            "submodules": children, "integrationReady": ready, "integrationSynced": ready and remote_synced,
            "controllerSync": {"enabled": sync_policy.get("enabled", False), "migrationRequired": policy["schemaVersion"] == SCHEMA_V1},
            "allSynced": ready and remote_synced and target_state.get("ahead") == 0 and target_state.get("behind") == 0}


def render_status(payload: dict[str, Any]) -> str:
    source, target = payload["integration"], payload["controller"]
    relation = lambda item: "NOT PUBLISHED" if not item["remoteExists"] else f"ahead {item['ahead']}, behind {item['behind']}"
    return "\n".join(["JUNO GIT FLOW STATUS", "", "INTEGRATION",
        f"  Checkout: {source['checkout']} @ {source['checkoutSha'][:9]} [DETACHED]",
        f"  Local:    {source['branch']} @ {source['branchSha'][:9]}",
        f"  Remote:   {payload['remote']}/{source['branch']} [{relation(source)}]",
        f"  State:    {'SYNCED' if payload['integrationSynced'] else 'ATTENTION REQUIRED'}", "", "CONTROLLER",
        f"  Checkout: {target['checkout']}", f"  Local:    {target['branch']} @ {target['branchSha'][:9]}",
        f"  Remote:   {payload['remote']}/{target['branch']} [{relation(target)}]", "",
        f"CONTROLLER SYNC: {'ENABLED' if payload['controllerSync']['enabled'] else 'DISABLED'}",
        f"SUBMODULES: {len(payload['submodules'])}"])


@contextmanager
def lease(repo: Path):
    path = common(repo) / "juno-integration-owner.lock"; handle = path.open("a+")
    try:
        try: fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc: raise FlowError(f"Git-flow lease is busy: {path}") from exc
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN); handle.close()


def v2_policy(base: dict[str, Any], project_id: str, enabled: bool, commands: list[str]) -> dict[str, Any]:
    return validate_policy({"schemaVersion": SCHEMA, "projectId": project_id, "remote": base["remote"],
        "integrationBranch": short_ref(base["integrationBranch"]), "controllerBranch": short_ref(base["controllerBranch"]),
        "checkoutMode": "detached", "submodules": base["submodules"],
        "controllerOwnedPaths": base.get("controllerOwnedPaths", DEFAULT_CONTROLLER),
        "sharedPaths": base.get("sharedPaths", DEFAULT_SHARED),
        "controllerSync": {"enabled": enabled, "mode": "auto-when-safe", "validationCommands": commands,
                           "validationTimeoutSeconds": 1800, "lockTimeoutSeconds": 30}}, allow_v1=False)


def configure(args: argparse.Namespace, invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation); policy_path = ctl / ".juno_task/config/git-flow.json"
    if args.migrate_policy:
        current, existing_path = config(ctl)
        if current["schemaVersion"] != SCHEMA_V1:
            raise FlowError("--migrate-policy requires a juno_git_flow.v1 policy")
        project_id = args.project_id or ctl.name
        policy = v2_policy(current, project_id, False, [])
        validate_policy_boundaries(ctl, policy)
        atomic_write(existing_path, policy, replace=True)
        return {"operation": "configure", "outcome": "migrated_disabled", "policy": str(existing_path), "projectId": project_id}
    required = {"integration_branch": args.integration_branch, "controller_branch": args.controller_branch,
                "integration_checkout": args.integration_checkout}
    missing = [key.replace("_", "-") for key, value in required.items() if value is None]
    if missing: raise FlowError(f"configure requires: {', '.join(missing)}")
    source = root(args.integration_checkout.expanduser().resolve())
    if common(source) != common(ctl): raise FlowError("integration checkout and controller must be linked worktrees")
    if attached(source): raise FlowError("integration checkout must be detached")
    if attached(ctl) != full_ref(args.controller_branch): raise FlowError("controller checkout must be attached to the configured controller branch")
    resolve(ctl, full_ref(args.integration_branch)); resolve(ctl, full_ref(args.controller_branch))
    base = {"remote": args.remote, "integrationBranch": args.integration_branch, "controllerBranch": args.controller_branch,
            "submodules": {"mode": args.submodules, "advanceConfiguredBranches": args.advance_submodule_branches},
            "controllerOwnedPaths": DEFAULT_CONTROLLER, "sharedPaths": DEFAULT_SHARED}
    project_id = args.project_id or ctl.name
    policy = v2_policy(base, project_id, args.enable_controller_sync, args.validation_command)
    validate_policy_boundaries(ctl, policy)
    policy_path.parent.mkdir(parents=True, exist_ok=True); atomic_write(policy_path, policy, replace=policy_path.exists())
    main_path = ctl / ".juno_task/config.json"; main = json.loads(main_path.read_text(encoding="utf-8"))
    main["gitFlow"] = {"enabled": True, "policy": ".juno_task/config/git-flow.json"}; atomic_write(main_path, main, replace=True)
    git(ctl, "config", "--local", "juno.gitFlow.integrationCheckout", str(source))
    return {"operation": "configure", "policy": str(policy_path), "projectId": project_id,
            "controllerSyncEnabled": args.enable_controller_sync, "integrationCheckout": str(source), "status": status_payload(ctl, True)}


def sync(invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation); policy, _ = config(ctl); source = integration(ctl)
    with lease(ctl):
        if not clean(source): raise FlowError("integration checkout is dirty")
        if attached(source): raise FlowError("integration checkout must be detached")
        source_ref = full_ref(policy["integrationBranch"]); fetch(ctl, policy["remote"], source_ref, False)
        tracking = remote_ref(policy["remote"], source_ref)
        if git(ctl, "rev-parse", "--verify", tracking, check=False):
            local, remote = resolve(ctl, source_ref), resolve(ctl, tracking); ahead, behind = counts(ctl, source_ref, tracking)
            if ahead and behind: raise FlowError("integration branch diverged from remote")
            if behind: git(ctl, "update-ref", source_ref, remote, local)
        tip = resolve(ctl, source_ref); git(source, "switch", "--detach", tip)
        git(source, "submodule", "sync", "--recursive"); git(source, "submodule", "update", "--init", "--recursive", "--checkout", "--force")
        advanced: list[str] = []
        if policy["submodules"]["advanceConfiguredBranches"]:
            for row in submodules(source, tip):
                if not row["branch"]: raise FlowError(f"submodule branch is not configured: {row['path']}")
                child = source / row["path"]
                if not clean(child): raise FlowError(f"dirty submodule: {row['path']}")
                fetch(child, policy["remote"], row["branch"]); remote_tip = resolve(child, remote_ref(policy["remote"], row["branch"]))
                if row["sha"] != remote_tip:
                    if not ancestor(child, row["sha"], remote_tip): raise FlowError(f"submodule diverged: {row['path']}")
                    git(child, "switch", "--detach", remote_tip); git(source, "add", "--", row["path"]); advanced.append(row["path"])
            if advanced:
                old = tip; git(source, "commit", "-m", "chore(integration): update submodule pointers")
                tip = resolve(source, "HEAD"); git(ctl, "update-ref", source_ref, tip, old)
        for row in submodules(source, tip): git(source / row["path"], "switch", "--detach", row["sha"])
        if not clean(source): raise FlowError("post-sync integration checkout is dirty")
    return {"operation": "sync", "advancedSubmodules": advanced, "status": status_payload(invocation)}


def push(invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation); policy, _ = config(ctl); source = integration(ctl)
    with lease(ctl):
        before = status_payload(invocation); item = before["integration"]
        if not item["clean"] or item["checkoutSha"] != item["branchSha"]: raise FlowError("integration checkout is not eligible for push; run status/sync")
        if item.get("behind"): raise FlowError("integration remote is ahead or divergent")
        pushed: list[str] = []
        if policy["submodules"]["advanceConfiguredBranches"]:
            for row in submodules(source, item["branchSha"]):
                child = source / row["path"]
                if not row["branch"]: raise FlowError(f"submodule branch missing: {row['path']}")
                fetch(child, policy["remote"], row["branch"]); tracking = remote_ref(policy["remote"], row["branch"])
                ahead, behind = counts(child, row["sha"], tracking)
                if behind: raise FlowError(f"submodule remote is ahead/diverged: {row['path']}")
                if ahead: git(child, "push", policy["remote"], f"{row['sha']}:{full_ref(row['branch'])}"); pushed.append(row["path"])
        git(source, "push", "--recurse-submodules=check", policy["remote"], f"{full_ref(policy['integrationBranch'])}:{full_ref(policy['integrationBranch'])}")
        pushed.append("root"); after = status_payload(invocation)
        if not after["integrationSynced"]: raise FlowError("post-push integration parity verification failed")
    return {"operation": "push", "pushed": pushed, "status": after}


def project_store(ctl: Path, policy: dict[str, Any]) -> Path:
    return common(ctl) / "juno/controller-sync/projects" / policy["projectId"]


def classify(path: str, policy: dict[str, Any]) -> str:
    for entry in policy["controllerOwnedPaths"]:
        if path == entry or path.startswith(entry + "/"): return "controller"
    for entry in policy["sharedPaths"]:
        if path == entry or path.startswith(entry + "/"): return "shared"
    return "product"


def tree_paths(repo: Path, *trees: str) -> list[str]:
    result: set[str] = set()
    for tree in trees:
        result.update(git(repo, "ls-tree", "-r", "--name-only", tree).splitlines())
    return sorted(result)


def path_entry(repo: Path, tree: str, path: str) -> str:
    return git(repo, "ls-tree", tree, "--", path)


def verify_nested_source(source: Path, target_tip: str, source_tip: str, integration_value: dict[str, Any]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for row in submodules(source, source_tip):
        child = source / row["path"]
        if not child.is_dir() or not git(child, "rev-parse", "--show-toplevel", check=False):
            raise FlowError(f"nested checkout is not initialized: {row['path']}")
        head = resolve(child, "HEAD")
        if head != row["sha"] or attached(child) is not None or not clean(child):
            raise FlowError(f"nested checkout identity is unsafe: {row['path']}")
        target_entry = git(source, "ls-tree", target_tip, "--", row["path"]).split()
        changed = len(target_entry) < 3 or target_entry[2] != row["sha"]
        receipt_bound = any(item.get("candidate_sha") == row["sha"] for item in integration_value.get("repositories", []))
        if changed and not receipt_bound:
            raise FlowError(f"changed nested gitlink lacks successful integration receipt identity: {row['path']}")
        evidence.append({**row, "checkoutSha": head, "clean": True, "detached": True,
                         "changedFromController": changed, "integrationReceiptBound": receipt_bound})
    return evidence


def load_integration_receipt(path: Path, ctl: Path, source_ref: str, source_tip: str,
                             *, expected_sha256: str | None = None) -> tuple[dict[str, Any], str]:
    try:
        encoded = path.read_bytes(); observed_sha256 = hashlib.sha256(encoded).hexdigest(); value = json.loads(encoded)
    except (OSError, json.JSONDecodeError) as exc: raise FlowError(f"invalid integration receipt: {exc}") from exc
    if expected_sha256 is not None and observed_sha256 != expected_sha256:
        raise FlowError("resume source integration receipt digest mismatch")
    if value.get("schema_version") != "juno_local_integration.v3" or value.get("outcome") != "integrated" or value.get("passed") is not True:
        raise FlowError("exact successful juno_local_integration.v3 receipt required")
    matches = [item for item in value.get("repositories", []) if item.get("target_ref") == source_ref and item.get("candidate_sha") == source_tip]
    if len(matches) != 1: raise FlowError("integration receipt does not bind the configured integration ref and tip")
    reviewed = value.get("actual_target", {}).get("target_refs", {})
    if not any(item.get("target_ref") == source_ref and item.get("reviewed_tip") == source_tip for item in reviewed.values()):
        raise FlowError("integration receipt lacks exact actual-target readback")
    if common(Path(matches[0]["path"]).resolve()) != common(ctl): raise FlowError("integration receipt repository identity mismatch")
    return value, observed_sha256


def process_evidence(ctl: Path) -> dict[str, Any]:
    """Use lifecycle process discovery, excluding only this invocation's own ancestry."""
    try:
        import worktree_lifecycle as lifecycle
        previous_cwd = Path.cwd()
        try:
            os.chdir(tempfile.gettempdir())
            status, processes = lifecycle.active_cwd_processes(ctl)
        finally:
            os.chdir(previous_cwd)
        ancestry: set[int] = {os.getpid()}; current = os.getpid()
        for _ in range(64):
            result = subprocess.run(["ps", "-o", "ppid=", "-p", str(current)], text=True,
                                    capture_output=True, stdin=subprocess.DEVNULL)
            if result.returncode or not result.stdout.strip().isdigit(): break
            current = int(result.stdout.strip())
            if current <= 1 or current in ancestry: break
            ancestry.add(current)
        foreign = [item for item in processes if item.get("pid") not in ancestry]
        if status == "unknown": return {"probe_status": "unknown", "blocking": True, "processes": processes}
        return {"probe_status": "active" if foreign else "none", "blocking": bool(foreign),
                "processes": foreign, "ignoredInvocationAncestry": sorted(ancestry)}
    except Exception as exc:
        return {"probe_status": "unknown", "blocking": True, "error": type(exc).__name__}


def checkpoint_if_needed(ctl: Path) -> dict[str, Any]:
    if clean(ctl): return {"outcome": "noop", "head": resolve(ctl, "HEAD"), "selected": []}
    script = SCRIPT_DIR / "controller_checkpoint.py"
    result = run([sys.executable, str(script), "--root", str(ctl), "commit",
                  "--message", "chore(controller): checkpoint before controller sync", "--json"], ctl, False)
    if result.returncode: raise FlowError(result.stderr.strip() or "controller checkpoint refused")
    return json.loads(result.stdout)


def create_candidate(ctl: Path, policy: dict[str, Any], target_tip: str, source_tip: str,
                     operation_id: str, store: Path, integration_receipt_sha: str) -> tuple[dict[str, Any], Path, str, str]:
    try: import worktree_lifecycle as lifecycle
    except ImportError as exc: raise FlowError("worktree_lifecycle.py is required") from exc
    candidate = store / "candidates" / operation_id / "worktree"
    branch = f"refs/heads/juno/controller-sync-candidate/{policy['projectId']}/{operation_id}"
    create_receipt = store / "candidates" / operation_id / "lifecycle-create.json"
    args = argparse.Namespace(repository=ctl, target_ref=full_ref(policy["controllerBranch"]), expected_base=target_tip,
        fetch=None, path=candidate, branch_ref=branch, task_id=f"controller-sync-{operation_id}", expected_path=[],
        validation_command=[], sparse=False, sparse_tooling_path=[], cleanup_owner=f"controller-sync:{operation_id}",
        hard_min_free_bytes=None, output=create_receipt)
    lifecycle.create(args)
    merged = run(["git", "-C", str(candidate), "merge", "--no-ff", "--no-commit", source_tip], candidate, False)
    conflicts = git(candidate, "diff", "--name-only", "--diff-filter=U", check=False).splitlines()
    policy_conflicts = sorted(path for path in conflicts if classify(path, policy) != "product")
    if policy_conflicts:
        git(candidate, "merge", "--abort", check=False)
        return {"outcome": "pending_conflict", "conflicts": policy_conflicts}, candidate, branch, target_tip
    all_paths = tree_paths(ctl, target_tip, source_tip)
    for path in all_paths:
        owner = classify(path, policy)
        if owner == "product":
            if path_entry(ctl, source_tip, path):
                restored = run(["git", "-C", str(candidate), "restore", "--source", source_tip, "--staged", "--worktree", "--", path], candidate, False)
                if restored.returncode: raise FlowError(restored.stderr.strip() or f"cannot restore product path: {path}")
            else:
                run(["git", "-C", str(candidate), "rm", "-rf", "--ignore-unmatch", "--", path], candidate, False)
        elif owner == "controller" and not path_entry(ctl, source_tip, path) and path_entry(ctl, target_tip, path):
            # Controller ownership is additive: an integration-side deletion
            # cannot silently erase durable controller state.
            restored = run(["git", "-C", str(candidate), "restore", "--source", target_tip, "--staged", "--worktree", "--", path], candidate, False)
            if restored.returncode: raise FlowError(restored.stderr.strip() or f"cannot preserve controller path: {path}")
    if merged.returncode and not conflicts: raise FlowError(merged.stderr.strip() or "controller candidate merge failed")
    git(candidate, "add", "-A"); tree = git(candidate, "write-tree")
    message = "\n".join([
        f"chore(controller): sync {short_ref(policy['integrationBranch'])}", "",
        f"Juno-Integration-Receipt: {integration_receipt_sha}",
        f"Juno-Controller-Expected: {target_tip}",
        f"Juno-Path-Policy: {digest_json({'controller': policy['controllerOwnedPaths'], 'shared': policy['sharedPaths']})}",
        f"Juno-Validation-Policy: {digest_json(policy['controllerSync']['validationCommands'])}",
    ])
    candidate_sha = run(["git", "-C", str(candidate), "commit-tree", tree, "-p", target_tip, "-p", source_tip,
                         "-m", message], candidate).stdout.strip()
    git(candidate, "merge", "--quit")
    git(ctl, "update-ref", branch, candidate_sha, target_tip)
    if git(ctl, "show", "-s", "--format=%P", candidate_sha).split() != [target_tip, source_tip]: raise FlowError("candidate parent identity mismatch")
    violations = [path for path in all_paths if classify(path, policy) == "product" and path_entry(ctl, candidate_sha, path) != path_entry(ctl, source_tip, path)]
    if violations: raise FlowError(f"product tree equality failed: {violations[:20]}")
    return {"outcome": "candidate_built", "tree": tree, "changedPaths": {
        owner: [path for path in all_paths if classify(path, policy) == owner and path_entry(ctl, target_tip, path) != path_entry(ctl, candidate_sha, path)]
        for owner in ("product", "controller", "shared")}}, candidate, branch, candidate_sha


def cleanup_candidate(ctl: Path, candidate: Path, branch: str, expected: str, target_ref: str,
                      store: Path, operation_id: str) -> dict[str, Any]:
    import worktree_lifecycle as lifecycle
    receipt = store / "candidates" / operation_id / "lifecycle-cleanup.json"
    args = argparse.Namespace(repository=ctl, path=candidate, output=receipt, target_ref=target_ref,
        branch_ref=branch, expected_head=expected, delete_branch=True, activity_probe_timeout_seconds=5,
        deinitialized_submodule=[])
    return lifecycle.cleanup(args)


def candidate_identity(candidate: Path, expected_sha: str) -> dict[str, Any]:
    try:
        return {"head": resolve(candidate, "HEAD"), "expectedHead": expected_sha,
                "clean": clean(candidate), "matches": resolve(candidate, "HEAD") == expected_sha and clean(candidate)}
    except Exception as exc:
        return {"head": None, "expectedHead": expected_sha, "clean": False, "matches": False, "error": str(exc)}


def persist_then_cleanup(receipt_path: Path, receipt: dict[str, Any], ctl: Path, candidate: Path,
                         branch: str, expected: str, target_ref: str, store: Path,
                         operation_id: str) -> None:
    cleanup_receipt = store / "candidates" / operation_id / "lifecycle-cleanup.json"
    receipt["candidateCleanup"] = {"status": "pending", "receiptPath": str(cleanup_receipt)}
    atomic_write(receipt_path, receipt, replace=receipt_path.exists())
    try:
        result = cleanup_candidate(ctl, candidate, branch, expected, target_ref, store, operation_id)
        receipt["candidateCleanup"] = {"status": "completed", "passed": result.get("passed", True),
                                       "receiptPath": str(cleanup_receipt), "refusals": result.get("refusals", [])}
    except Exception as exc:
        receipt["candidateCleanup"] = {"status": "refused_preserved", "passed": False,
                                       "receiptPath": str(cleanup_receipt), "error": str(exc)}
    atomic_write(receipt_path, receipt, replace=True)


def validation(candidate: Path, expected_sha: str, policy: dict[str, Any], store: Path, operation_id: str) -> list[dict[str, Any]]:
    artifacts = store / "validation" / operation_id; artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    sanitized = {key: value for key, value in os.environ.items() if key not in {"JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "GIT_INDEX_FILE"}}
    for index, command in enumerate(policy["controllerSync"]["validationCommands"]):
        before = candidate_identity(candidate, expected_sha)
        if not before["matches"]:
            results.append({"commandSha256": hashlib.sha256(command.encode()).hexdigest(), "exitCode": 125,
                            "timedOut": False, "identityBefore": before, "identityAfter": before,
                            "identityDrift": True, "refusal": "candidate identity invalid before validation"})
            break
        started = time.monotonic()
        try:
            result = subprocess.run(command, shell=True, cwd=candidate, text=True, capture_output=True,
                                    stdin=subprocess.DEVNULL, timeout=policy["controllerSync"]["validationTimeoutSeconds"], env=sanitized)
            exit_code, timed_out, stdout, stderr = result.returncode, False, result.stdout, result.stderr
        except subprocess.TimeoutExpired as exc:
            exit_code, timed_out = 124, True
            stdout = exc.stdout or ""; stderr = exc.stderr or ""
            if isinstance(stdout, bytes): stdout = stdout.decode(errors="replace")
            if isinstance(stderr, bytes): stderr = stderr.decode(errors="replace")
        out_path, err_path = artifacts / f"{index:03d}.stdout.txt", artifacts / f"{index:03d}.stderr.txt"
        out_path.write_text(stdout, encoding="utf-8"); err_path.write_text(stderr, encoding="utf-8")
        after = candidate_identity(candidate, expected_sha); identity_drift = not after["matches"]
        item = {"commandSha256": hashlib.sha256(command.encode()).hexdigest(),
                "exitCode": 125 if identity_drift and exit_code == 0 else exit_code,
                "commandExitCode": exit_code, "timedOut": timed_out,
                "durationSeconds": round(time.monotonic() - started, 6),
                "stdoutSha256": file_sha(out_path), "stderrSha256": file_sha(err_path),
                "identityBefore": before, "identityAfter": after, "identityDrift": identity_drift}
        results.append(item)
        if item["exitCode"]: break
    return results


def detach_controller_with_lifecycle(ctl: Path, target_ref: str, target_tip: str) -> dict[str, Any]:
    import worktree_lifecycle as lifecycle
    previous_cwd = Path.cwd()
    try:
        os.chdir(tempfile.gettempdir())
        return lifecycle.detach_same_sha(ctl, ctl, target_ref, target_tip,
                                          controller=ctl, allow_controller_root=True)
    finally:
        os.chdir(previous_cwd)


def sparse_controller_policy(ctl: Path) -> tuple[Any, dict[str, Any]] | None:
    path = ctl / ".juno_task/config/controller-workspace.json"
    if not path.is_file(): return None
    try: import controller_workspace
    except ImportError as exc: raise FlowError("controller_workspace.py is required for sparse controller sync") from exc
    try: return controller_workspace, controller_workspace.load_policy(path)
    except controller_workspace.WorkspaceError as exc: raise FlowError(f"invalid sparse controller policy: {exc}") from exc


def restore_sparse_controller(ctl: Path, expected_head: str) -> dict[str, Any]:
    authority = sparse_controller_policy(ctl)
    if authority is None:
        return {"required": False, "status": "not_configured"}
    module, policy = authority
    if os.environ.get("JUNO_INJECT_SPARSE_RESTORATION_FAILURE") == "1":
        raise FlowError("injected sparse restoration failure")
    module.configure(ctl, policy, expected_head)
    evidence = module.inspect(ctl, policy)
    if resolve(ctl, policy["controller_branch"]) != expected_head or resolve(ctl, "HEAD") != expected_head or not evidence["passed"]:
        raise FlowError("sparse restoration readback mismatch")
    return {"required": True, "status": "restored_and_verified", "evidence": evidence}


def record_sparse_restoration(receipt: dict[str, Any], ctl: Path, candidate_head: str) -> bool:
    """Record success or durable ref-moved partial truth without rewriting the moved ref."""
    try:
        receipt["sparseRestoration"] = restore_sparse_controller(ctl, candidate_head)
    except FlowError as exc:
        receipt.update({"outcome": "controller_ref_moved_sparse_restore_pending", "resumable": True,
                        "refusal": str(exc)})
        return False
    receipt.update({"outcome": "synced_local", "resumable": False})
    return True


def sync_receipt_base(ctl: Path, policy: dict[str, Any], policy_path: Path, source_ref: str, target_ref: str,
                      source_tip: str, target_tip: str, integration_receipt: Path | None,
                      integration_receipt_sha: str | None = None) -> dict[str, Any]:
    return {"schemaVersion": SYNC_SCHEMA, "operation": "controller-sync", "createdAt": utc_now(),
        "projectId": policy["projectId"], "repositoryRoot": str(root(ctl)), "gitCommonDir": str(common(ctl)),
        "controllerCheckout": str(ctl), "controllerRef": target_ref, "integrationRef": source_ref,
        "expectedControllerSha": target_tip, "integratedSha": source_tip,
        "sourceIntegrationReceipt": None if integration_receipt is None else {"path": str(integration_receipt.resolve()), "sha256": integration_receipt_sha},
        "policy": {"path": str(policy_path), "digest": digest_json(policy), "controllerOwnedPaths": policy["controllerOwnedPaths"], "sharedPaths": policy["sharedPaths"]},
        "mergeBase": git(ctl, "merge-base", target_tip, source_tip), "candidateSha": None, "candidateTree": None,
        "parents": [target_tip, source_tip], "validation": [], "processEvidence": None, "checkpoint": None,
        "cas": {"attempted": False, "before": target_tip, "after": None}, "remotePublished": False,
        "integrationRemainsSuccessful": True, "resumable": False, "outcome": "failed_preserved"}


def controller_sync(invocation: Path, args: argparse.Namespace) -> dict[str, Any]:
    ctl = controller(invocation); policy, policy_path = config(ctl, allow_v1=False)
    sync_policy = policy["controllerSync"]
    if not sync_policy["enabled"]:
        return {"schemaVersion": SYNC_SCHEMA, "operation": "controller-sync", "outcome": "not_enabled", "integrationRemainsSuccessful": True}
    source = integration(ctl); source_ref, target_ref = full_ref(policy["integrationBranch"]), full_ref(policy["controllerBranch"])
    source_tip, target_tip = resolve(ctl, source_ref), resolve(ctl, target_ref)
    if args.plan:
        process = process_evidence(ctl)
        return {**sync_receipt_base(ctl, policy, policy_path, source_ref, target_ref, source_tip, target_tip, None),
                "outcome": "up_to_date" if source_tip == target_tip or ancestor(ctl, source_tip, target_tip) else "validated_pending",
                "planOnly": True, "processEvidence": process, "wouldMutate": False}
    integration_receipt: Path
    resume_path: Path | None = None
    prior: dict[str, Any] | None = None
    expected_integration_sha: str | None = None
    if args.resume:
        resume_path = args.resume.expanduser().resolve()
        try: prior = json.loads(resume_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc: raise FlowError(f"invalid resume receipt: {exc}") from exc
        if prior.get("schemaVersion") != SYNC_SCHEMA or not prior.get("resumable") or not prior.get("sourceIntegrationReceipt", {}).get("path"):
            raise FlowError("exact resumable controller-sync receipt required")
        if prior.get("projectId") != policy["projectId"] or prior.get("controllerRef") != target_ref or prior.get("integrationRef") != source_ref:
            raise FlowError("resume receipt channel identity mismatch")
        integration_receipt = Path(prior["sourceIntegrationReceipt"]["path"])
        expected_integration_sha = prior["sourceIntegrationReceipt"].get("sha256")
        if not re.fullmatch(r"[0-9a-f]{64}", str(expected_integration_sha or "")):
            raise FlowError("resume receipt has invalid source integration receipt digest")
    elif args.integration_receipt:
        integration_receipt = args.integration_receipt.expanduser().resolve()
    else:
        raise FlowError("controller-sync mutation requires --integration-receipt or --resume")
    integration_value, receipt_hash = load_integration_receipt(
        integration_receipt, ctl, source_ref, source_tip, expected_sha256=expected_integration_sha)
    policy_digest = digest_json(policy)
    if prior is not None and prior.get("outcome") == "controller_ref_moved_sparse_restore_pending":
        candidate_head = str(prior.get("candidateSha") or "")
        if not re.fullmatch(r"[0-9a-f]{40,64}", candidate_head) or resolve(ctl, target_ref) != candidate_head:
            raise FlowError("sparse restoration resume controller ref identity mismatch")
        restored_path = resume_path.with_name(resume_path.stem + "-restored.json")
        resumed = {**prior, "createdAt": utc_now(), "resumeReceipt": {"path": str(resume_path), "sha256": file_sha(resume_path)}}
        try:
            resumed["sparseRestoration"] = restore_sparse_controller(ctl, candidate_head)
            resumed.update({"outcome": "synced_local", "resumable": False})
        except FlowError as exc:
            resumed.update({"outcome": "controller_ref_moved_sparse_restore_pending", "resumable": True, "refusal": str(exc)})
        atomic_write(restored_path, resumed, replace=restored_path.exists())
        return {**resumed, "receiptPath": str(restored_path)}
    resume_hash = "" if resume_path is None else file_sha(resume_path)
    operation_id = hashlib.sha256(f"{receipt_hash}\0{target_tip}\0{source_tip}\0{policy_digest}\0{resume_hash}".encode()).hexdigest()[:24]
    store = project_store(ctl, policy); receipt_path = store / "receipts" / f"{operation_id}.json"
    if receipt_path.exists():
        existing = json.loads(receipt_path.read_text(encoding="utf-8"))
        binding_matches = (existing.get("projectId") == policy["projectId"]
            and existing.get("controllerRef") == target_ref and existing.get("integrationRef") == source_ref
            and existing.get("integratedSha") == source_tip
            and existing.get("policy", {}).get("digest") == policy_digest
            and existing.get("sourceIntegrationReceipt", {}).get("sha256") == receipt_hash)
        success_current = (existing.get("outcome") == "synced_local"
            and binding_matches and existing.get("candidateSha") == resolve(ctl, target_ref)
            and attached(ctl) == target_ref and resolve(ctl, "HEAD") == existing.get("candidateSha") and clean(ctl))
        up_to_date_current = existing.get("outcome") == "up_to_date" and binding_matches and ancestor(ctl, source_tip, resolve(ctl, target_ref))
        if success_current or up_to_date_current:
            return {**existing, "receiptPath": str(receipt_path), "idempotent": True}
        if existing.get("outcome") not in {"synced_local", "up_to_date"}:
            return {**existing, "receiptPath": str(receipt_path), "idempotent": True,
                    "safeNextAction": f"controller-sync --resume {receipt_path}" if existing.get("resumable") else None}
        stale = sync_receipt_base(ctl, policy, policy_path, source_ref, target_ref, source_tip, target_tip,
                                  integration_receipt, receipt_hash)
        stale.update({"operationId": operation_id, "outcome": "stale_rebuild_required", "resumable": True,
                      "priorReceipt": {"path": str(receipt_path), "sha256": file_sha(receipt_path)},
                      "refusal": "historical success no longer matches current controller readback"})
        stale_path = receipt_path.with_name(f"{operation_id}-stale-{digest_json(stale['priorReceipt'])[:12]}.json")
        if stale_path.exists():
            prior_stale = json.loads(stale_path.read_text(encoding="utf-8"))
            if (prior_stale.get("outcome") == "stale_rebuild_required"
                    and prior_stale.get("priorReceipt") == stale["priorReceipt"]
                    and prior_stale.get("expectedControllerSha") == target_tip
                    and prior_stale.get("integratedSha") == source_tip
                    and prior_stale.get("policy", {}).get("digest") == policy_digest):
                return {**prior_stale, "receiptPath": str(stale_path), "idempotent": True}
        atomic_write(stale_path, stale)
        return {**stale, "receiptPath": str(stale_path)}
    receipt = sync_receipt_base(ctl, policy, policy_path, source_ref, target_ref, source_tip, target_tip,
                                integration_receipt, receipt_hash)
    receipt["operationId"] = operation_id
    if resume_path is not None: receipt["resumeReceipt"] = {"path": str(resume_path), "sha256": resume_hash}
    if ancestor(ctl, source_tip, target_tip):
        receipt.update({"outcome": "up_to_date", "resumable": False}); atomic_write(receipt_path, receipt, replace=receipt_path.exists())
        return {**receipt, "receiptPath": str(receipt_path)}
    store.mkdir(parents=True, exist_ok=True)
    lock = store / "locks/channel.lock"; lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a+") as handle:
        deadline = time.monotonic() + sync_policy["lockTimeoutSeconds"]
        while True:
            try: fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB); break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise FlowError("controller-sync project lock timeout")
                time.sleep(0.05)
        process = process_evidence(ctl); receipt["processEvidence"] = process
        if not clean(ctl):
            if process.get("blocking"):
                receipt.update({"outcome": "pending_active_controller", "resumable": True,
                                "refusal": "active or unknown controller process blocks checkpoint"})
                atomic_write(receipt_path, receipt, replace=receipt_path.exists()); return {**receipt, "receiptPath": str(receipt_path)}
            try: receipt["checkpoint"] = checkpoint_if_needed(ctl)
            except FlowError as exc:
                receipt.update({"outcome": "blocked_controller_checkpoint", "resumable": True, "refusal": str(exc)})
                atomic_write(receipt_path, receipt, replace=receipt_path.exists()); return {**receipt, "receiptPath": str(receipt_path)}
            target_tip = resolve(ctl, target_ref); receipt["expectedControllerSha"] = target_tip; receipt["parents"] = [target_tip, source_tip]
            receipt["mergeBase"] = git(ctl, "merge-base", target_tip, source_tip); receipt["cas"]["before"] = target_tip
        if file_sha(integration_receipt) != receipt_hash:
            receipt.update({"outcome": "stale_rebuild_required", "resumable": True,
                            "refusal": "source integration receipt changed before candidate construction"})
            atomic_write(receipt_path, receipt, replace=receipt_path.exists()); return {**receipt, "receiptPath": str(receipt_path)}
        if attached(source) or not clean(source) or resolve(source, "HEAD") != source_tip:
            receipt.update({"outcome": "failed_preserved", "resumable": False, "refusal": "integration checkout is not exact, clean, and detached"})
            atomic_write(receipt_path, receipt, replace=receipt_path.exists()); return {**receipt, "receiptPath": str(receipt_path)}
        try: receipt["nestedRepositories"] = verify_nested_source(source, target_tip, source_tip, integration_value)
        except FlowError as exc:
            receipt.update({"outcome": "failed_preserved", "resumable": False, "refusal": str(exc)})
            atomic_write(receipt_path, receipt, replace=receipt_path.exists()); return {**receipt, "receiptPath": str(receipt_path)}
        try:
            built, candidate, branch, candidate_head = create_candidate(
                ctl, policy, target_tip, source_tip, operation_id, store, receipt_hash)
        except Exception as exc:
            receipt.update({"outcome": "failed_preserved", "resumable": True, "refusal": str(exc)})
            atomic_write(receipt_path, receipt, replace=receipt_path.exists()); return {**receipt, "receiptPath": str(receipt_path)}
        if built["outcome"] == "pending_conflict":
            receipt.update(built); receipt["resumable"] = True
            persist_then_cleanup(receipt_path, receipt, ctl, candidate, branch, target_tip, target_ref, store, operation_id)
            return {**receipt, "receiptPath": str(receipt_path)}
        receipt.update({"candidateSha": candidate_head, "candidateTree": built["tree"], "changedPaths": built["changedPaths"]})
        pending_ref = f"refs/juno/controller-sync/pending/{policy['projectId']}/{operation_id}"
        git(ctl, "update-ref", pending_ref, candidate_head)
        results = validation(candidate, candidate_head, policy, store, operation_id); receipt["validation"] = results
        receipt["candidateIdentityAfterValidation"] = candidate_identity(candidate, candidate_head)
        failed = any(item["exitCode"] for item in results) or not receipt["candidateIdentityAfterValidation"]["matches"]
        if failed:
            receipt.update({"outcome": "pending_validation_failure", "resumable": True, "pendingRef": pending_ref})
            persist_then_cleanup(receipt_path, receipt, ctl, candidate, branch, candidate_head, pending_ref, store, operation_id)
            return {**receipt, "receiptPath": str(receipt_path)}
        process = process_evidence(ctl); receipt["processEvidence"] = process
        if process.get("blocking") or attached(ctl) != target_ref or not clean(ctl) or resolve(ctl, "HEAD") != target_tip:
            receipt.update({"outcome": "validated_pending", "resumable": True, "pendingRef": pending_ref})
            persist_then_cleanup(receipt_path, receipt, ctl, candidate, branch, candidate_head, pending_ref, store, operation_id)
            return {**receipt, "receiptPath": str(receipt_path)}
        if not candidate_identity(candidate, candidate_head)["matches"]:
            receipt.update({"outcome": "pending_validation_failure", "resumable": True,
                            "pendingRef": pending_ref, "refusal": "candidate identity changed after validation"})
            persist_then_cleanup(receipt_path, receipt, ctl, candidate, branch, candidate_head, pending_ref, store, operation_id)
            return {**receipt, "receiptPath": str(receipt_path)}
        if file_sha(integration_receipt) != receipt_hash:
            receipt.update({"outcome": "stale_rebuild_required", "resumable": True,
                            "pendingRef": pending_ref, "refusal": "source integration receipt changed before CAS"})
            persist_then_cleanup(receipt_path, receipt, ctl, candidate, branch, candidate_head, pending_ref, store, operation_id)
            return {**receipt, "receiptPath": str(receipt_path)}
        import integration_owner_preflight as authority
        authority_item = {"path": ctl, "target_ref": target_ref}; lock_path = authority.lock_file(authority_item); lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+") as channel_lock:
            authority.acquire_bounded(channel_lock, sync_policy["lockTimeoutSeconds"])
            if resolve(ctl, target_ref) != target_tip or resolve(ctl, "HEAD") != target_tip or not clean(ctl):
                receipt.update({"outcome": "stale_rebuild_required", "resumable": True, "pendingRef": pending_ref})
            else:
                try: receipt["checkoutDetachment"] = detach_controller_with_lifecycle(ctl, target_ref, target_tip)
                except Exception as exc:
                    receipt.update({"outcome": "validated_pending", "resumable": True,
                                    "pendingRef": pending_ref, "refusal": str(exc)})
                else:
                    receipt["cas"]["attempted"] = True
                    update = authority.run(ctl, "update-ref", target_ref, candidate_head, target_tip, check=False)
                    if update.returncode:
                        restored = run(["git", "-C", str(ctl), "switch", short_ref(target_ref)], ctl, False)
                        receipt.update({"outcome": "stale_rebuild_required", "resumable": True, "pendingRef": pending_ref,
                                        "checkoutRestoration": {"status": "restored_current_target" if restored.returncode == 0 else "detached_preserved",
                                                                "exitCode": restored.returncode}})
                    else:
                        restored = run(["git", "-C", str(ctl), "switch", short_ref(target_ref)], ctl, False)
                        receipt["cas"]["after"] = resolve(ctl, target_ref)
                        if restored.returncode:
                            receipt.update({"outcome": "controller_ref_moved_sparse_restore_pending", "resumable": True,
                                            "pendingRef": pending_ref, "refusal": "controller ref moved but checkout restoration failed"})
                        else:
                            if not record_sparse_restoration(receipt, ctl, candidate_head):
                                receipt["pendingRef"] = pending_ref
        cleanup_target = target_ref if receipt["outcome"] == "synced_local" else pending_ref
        persist_then_cleanup(receipt_path, receipt, ctl, candidate, branch, candidate_head, cleanup_target, store, operation_id)
        if receipt["outcome"] == "synced_local": git(ctl, "update-ref", "-d", pending_ref, candidate_head)
        atomic_write(receipt_path, receipt, replace=True)
        return {**receipt, "receiptPath": str(receipt_path)}


def auto_after_integration(repository: Path, integration_receipt: Path) -> dict[str, Any]:
    """Best-effort hook called only after integration truth and locks are finalized."""
    # Workflow Runner launches the integration owner from the controller and may
    # carry a controller role assertion into the detached integration checkout.
    # Controller resolution must use persisted registration, not that caller-role
    # assertion, or every generated integration path would report a false bridge
    # failure before it can even observe disabled policy.
    asserted_role = os.environ.pop("JUNO_WORKSPACE_ROLE", None)
    asserted_branch = os.environ.pop("JUNO_CONTROLLER_BRANCH", None)
    asserted_root = os.environ.pop("JUNO_TASK_ROOT", None)
    try:
        try:
            ctl = controller(repository); policy, _ = config(ctl)
            if policy.get("schemaVersion") != SCHEMA or not policy.get("controllerSync", {}).get("enabled"):
                return {"outcome": "not_enabled"}
            args = argparse.Namespace(plan=False, resume=None, integration_receipt=integration_receipt)
            result = controller_sync(repository, args)
            return {key: result[key] for key in ("outcome", "receiptPath", "candidateSha", "integrationRemainsSuccessful", "error") if key in result}
        except FlowError as exc:
            if str(exc).startswith("Git flow is disabled;"):
                return {"outcome": "not_enabled"}
            return {"outcome": "failed_preserved", "integrationRemainsSuccessful": True, "error": str(exc)}
        except Exception as exc:
            return {"outcome": "failed_preserved", "integrationRemainsSuccessful": True, "error": str(exc)}
    finally:
        if asserted_role is not None: os.environ["JUNO_WORKSPACE_ROLE"] = asserted_role
        if asserted_branch is not None: os.environ["JUNO_CONTROLLER_BRANCH"] = asserted_branch
        if asserted_root is not None: os.environ["JUNO_TASK_ROOT"] = asserted_root


def parser() -> argparse.ArgumentParser:
    root_p = argparse.ArgumentParser(description=__doc__, allow_abbrev=False); sub = root_p.add_subparsers(dest="operation", required=True)
    c = sub.add_parser("configure", allow_abbrev=False)
    c.add_argument("--integration-branch"); c.add_argument("--controller-branch"); c.add_argument("--integration-checkout", type=Path)
    c.add_argument("--remote", default="origin"); c.add_argument("--submodules", choices=["exact", "tracking"], default="exact")
    c.add_argument("--advance-submodule-branches", action="store_true"); c.add_argument("--project-id")
    c.add_argument("--enable-controller-sync", action="store_true"); c.add_argument("--validation-command", action="append", default=[])
    c.add_argument("--migrate-policy", action="store_true")
    s = sub.add_parser("status", allow_abbrev=False); s.add_argument("--no-fetch", action="store_true")
    s.add_argument("--details", action="store_true"); s.add_argument("--strict", action="store_true"); s.add_argument("--json", action="store_true")
    for name in ("sync", "push"):
        p = sub.add_parser(name, allow_abbrev=False); p.add_argument("--json", action="store_true")
    cs = sub.add_parser("controller-sync", allow_abbrev=False); cs.add_argument("--json", action="store_true")
    mode = cs.add_mutually_exclusive_group(); mode.add_argument("--plan", action="store_true"); mode.add_argument("--integration-receipt", type=Path); mode.add_argument("--resume", type=Path)
    return root_p


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv); invocation = root(Path.cwd())
        if args.operation == "configure": result = configure(args, invocation)
        elif args.operation == "status": result = status_payload(invocation, args.no_fetch)
        elif args.operation == "sync": result = sync(invocation)
        elif args.operation == "push": result = push(invocation)
        else: result = controller_sync(invocation, args)
        as_json = getattr(args, "json", False)
        if args.operation == "status" and not as_json: print(render_status(result))
        else: print(json.dumps(result, indent=2, sort_keys=True))
        return 3 if getattr(args, "strict", False) and not result["integrationSynced"] else 0
    except (FlowError, OSError, json.JSONDecodeError) as exc:
        print(f"git-flow: error: {exc}", file=sys.stderr); return 2


if __name__ == "__main__":
    raise SystemExit(main())
