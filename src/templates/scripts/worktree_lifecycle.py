#!/usr/bin/env python3
"""Create, verify, audit, and safely clean exact-base named Git worktrees."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

SCHEMA = "juno_worktree_lifecycle.v2"

class LifecycleError(Exception): pass

def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, stdin=subprocess.DEVNULL,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if check and result.returncode:
        raise LifecycleError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()

def full_ref(value: str) -> str:
    if not value.startswith("refs/"):
        raise LifecycleError("refs must be full names beginning with refs/")
    return value

def branch_ref(value: str, *, allow_detached: bool = False) -> str:
    if allow_detached and value == "DETACHED":
        return value
    if not value.startswith("refs/heads/"):
        raise LifecycleError("branch refs must be full refs/heads/... names" + (" or DETACHED" if allow_detached else ""))
    return value

def submodule_repository(value: str) -> tuple[str, Path]:
    relative, separator, repository = value.partition("=")
    path = Path(relative)
    if not separator or not relative or not repository or path.is_absolute() or ".." in path.parts:
        raise argparse.ArgumentTypeError("deinitialized submodule must be RELATIVE_PATH=APPROVED_REPOSITORY")
    return path.as_posix(), Path(repository).expanduser().resolve()

def identity(repo: Path) -> tuple[Path, Path]:
    root = Path(git(repo, "rev-parse", "--show-toplevel")).resolve()
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    return root, common

def status(repo: Path) -> str:
    return git(repo, "status", "--porcelain=v2", "--untracked-files=all")

def lock_path(repo: Path) -> Path:
    return Path(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index.lock")).resolve()

def write_receipt(path: Path, payload: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") != encoded:
        raise LifecycleError(f"immutable receipt already exists with different content: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(encoded, encoding="utf-8")

def listed(repo: Path) -> list[dict[str, str]]:
    rows, row = [], {}
    for line in [*git(repo, "worktree", "list", "--porcelain").splitlines(), ""]:
        if not line:
            if row: rows.append(row); row = {}
        else:
            key, _, value = line.partition(" "); row[key] = value or "true"
    return rows

def measure_capacity(path: Path) -> dict[str, Any]:
    try:
        usage = shutil.disk_usage(path if path.exists() else path.parent)
        return {"available": True, "free_bytes": usage.free}
    except OSError as exc:
        return {"available": False, "error": type(exc).__name__}

def create(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repository.resolve(); root, common = identity(repo)
    target_ref = full_ref(args.target_ref)
    if args.fetch:
        remote, separator, ref = args.fetch.partition(",")
        if not separator or not remote or not ref: raise LifecycleError("--fetch must be REMOTE,REF")
        # Fetch only into FETCH_HEAD. Creation must never advance the approved
        # local integration target as a side effect of discovering its base.
        git(repo, "fetch", "--no-tags", remote, ref)
        base = git(repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}")
    else:
        base = git(repo, "rev-parse", "--verify", f"{target_ref}^{{commit}}")
    if args.expected_base and base != args.expected_base: raise LifecycleError(f"base_mismatch expected={args.expected_base} actual={base}")
    path = args.path.resolve(); branch = branch_ref(args.branch_ref)
    capacity = measure_capacity(path)
    if args.hard_min_free_bytes is not None and args.hard_min_free_bytes < 0:
        raise LifecycleError("--hard-min-free-bytes must be non-negative")
    if args.hard_min_free_bytes is not None and capacity["available"] and capacity["free_bytes"] < args.hard_min_free_bytes:
        raise LifecycleError(f"capacity_below_hard_threshold threshold={args.hard_min_free_bytes} observed={capacity['free_bytes']} recovery=free_space")
    if lock_path(repo).exists(): raise LifecycleError(f"git_index_lock_present: {lock_path(repo)}")
    matches = [row for row in listed(repo) if Path(row["worktree"]).resolve() == path]
    if matches:
        row = matches[0]
        if row.get("branch") != branch or row.get("HEAD") != base: raise LifecycleError("existing_worktree_identity_mismatch")
        if status(path): raise LifecycleError("existing_worktree_dirty")
        outcome = "verified_existing"
    else:
        if path.exists(): raise LifecycleError("worktree_path_collision")
        if git(repo, "show-ref", "--verify", "--quiet", branch, check=False): raise LifecycleError("branch_ref_collision")
        git(repo, "worktree", "add", "-b", branch.removeprefix("refs/heads/"), str(path), base)
        outcome = "created"
    payload = {"schema_version": SCHEMA, "operation": "create", "outcome": outcome, "repository_root": str(root),
               "git_common_dir": str(common), "target_ref": target_ref, "base_sha": base, "task_id": args.task_id,
               "branch_ref": branch, "worktree": str(path), "expected_paths": sorted(set(args.expected_path)),
               "validation_commands": args.validation_command, "cleanup_owner": args.cleanup_owner,
               "capacity": capacity, "clean": status(path) == ""}
    write_receipt(args.output, payload); return payload

def verify(args: argparse.Namespace) -> dict[str, Any]:
    receipt = json.loads(args.manifest.read_text(encoding="utf-8"))
    if receipt.get("schema_version") != SCHEMA or receipt.get("operation") != "create":
        raise LifecycleError("invalid create manifest")
    display_path = args.path or Path(receipt["worktree"]); refusals: list[str] = []
    try: expected_path = Path(receipt["worktree"]).resolve(strict=True)
    except OSError: expected_path = None; refusals.append("manifest_worktree_missing")
    try: actual_path = display_path.resolve(strict=True)
    except OSError: actual_path = None; refusals.append("path_missing_or_dangling")
    actual: dict[str, Any] = {"head": None, "branch_ref": None, "clean": False,
                              "worktree": None if actual_path is None else str(actual_path), "git_common_dir": None}
    if expected_path is not None and actual_path is not None:
        if expected_path != actual_path: refusals.append("canonical_path_mismatch")
        try:
            root, common = identity(actual_path)
            actual.update({"head": git(actual_path, "rev-parse", "HEAD"),
                           "branch_ref": git(actual_path, "symbolic-ref", "-q", "HEAD", check=False),
                           "clean": status(actual_path) == "", "worktree": str(root), "git_common_dir": str(common)})
            if root != actual_path: refusals.append("path_is_not_worktree_root")
            if actual["head"] != receipt["base_sha"]: refusals.append("unexpected_head")
            if actual["branch_ref"] != receipt["branch_ref"]: refusals.append("unexpected_branch")
            if not actual["clean"]: refusals.append("dirty")
            if actual["git_common_dir"] != receipt["git_common_dir"]: refusals.append("git_common_dir_mismatch")
            if display_path.resolve(strict=True) != actual_path: refusals.append("canonical_path_resolution_changed")
        except LifecycleError: refusals.append("path_is_not_registered_git_worktree")
    passed = not refusals
    payload = {"schema_version": SCHEMA, "operation": "verify", "passed": passed,
               "manifest_sha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
               "display_path": str(display_path), "expected_canonical_path": None if expected_path is None else str(expected_path),
               "actual": actual, "refusals": refusals}
    write_receipt(args.output, payload)
    if not passed: raise LifecycleError("worktree_verification_refused: " + ",".join(refusals))
    return payload

def active(path: Path) -> bool:
    try: result = subprocess.run(["lsof", "+D", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired): return True
    return result.returncode == 0

def active_cwd_processes(path: Path) -> tuple[bool, list[dict[str, Any]]]:
    try:
        result = subprocess.run(["lsof", "-n", "-P", "-a", "-d", "cwd", "-Fpn"], text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return True, [{"probe_error": type(exc).__name__}]
    root = path.resolve(); processes: list[dict[str, Any]] = []; pid: int | None = None
    for line in result.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit(): pid = int(line[1:])
        elif line.startswith("n") and pid is not None:
            cwd = Path(line[1:]).resolve()
            if cwd == root or root in cwd.parents: processes.append({"pid": pid, "cwd": str(cwd)})
    return bool(processes), processes

def audit(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repository.resolve(); target = full_ref(args.target_ref)
    target_exists = run_returncode(repo, "rev-parse", "--verify", target) == 0
    rows = []
    for row in listed(repo):
        path = Path(row["worktree"]); exists = path.exists(); dirt = None if not exists else status(path)
        reachable = target_exists and run_returncode(repo, "merge-base", "--is-ancestor", row["HEAD"], target) == 0
        rows.append({**row, "exists": exists, "clean": dirt == "" if dirt is not None else False,
                     "reachable_from_target": reachable,
                     "cleanup_eligible": exists and dirt == "" and reachable and "locked" not in row and "prunable" not in row})
    payload = {"schema_version": SCHEMA, "operation": "audit", "repository": str(repo), "target_ref": target,
               "target_exists": target_exists, "worktrees": rows,
               "prune_dry_run": git(repo, "worktree", "prune", "--dry-run", "--verbose", check=False).splitlines()}
    write_receipt(args.output, payload); return payload

def run_returncode(repo: Path, *args: str) -> int:
    return subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL).returncode

def controller_topology(controller: Path, path: Path, expected: str) -> tuple[dict[str, Any], list[str]]:
    controller = controller.resolve(); controller_root, _ = identity(controller); refusals: list[str] = []
    if controller_root != controller: refusals.append("controller_checkout_is_not_git_root")
    try: relative = path.relative_to(controller_root)
    except ValueError:
        return {"classification": "auxiliary_integration_owner", "controller_root": str(controller_root)}, refusals
    if not relative.parts: refusals.append("controller_root_cannot_be_target_owner")
    entry = git(controller_root, "ls-tree", "HEAD", "--", relative.as_posix()).split(None, 3)
    if len(entry) < 3 or entry[0] != "160000":
        refusals.append("controller_nested_owner_is_not_bound_gitlink"); gitlink_sha = None
    else: gitlink_sha = entry[2]
    if gitlink_sha != expected: refusals.append("controller_gitlink_sha_mismatch")
    path_status = git(controller_root, "status", "--porcelain=v2", "--untracked-files=all", "--", relative.as_posix())
    if path_status: refusals.append("controller_gitlink_dirty")
    return {"classification": "controller_nested_integration_owner", "controller_root": str(controller_root),
            "controller_head": git(controller_root, "rev-parse", "HEAD"), "gitlink_path": relative.as_posix(),
            "gitlink_sha": gitlink_sha, "gitlink_clean": path_status == ""}, refusals

def release_target(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repository.resolve(); path = args.path.resolve(); target = full_ref(args.target_ref)
    if not target.startswith("refs/heads/"):
        raise LifecycleError("target release requires a full refs/heads/... name")
    expected = args.expected_head
    topology: dict[str, Any] | None = None
    target_sha = git(repo, "rev-parse", "--verify", f"{target}^{{commit}}", check=False)
    rows = listed(repo); matches = [row for row in rows if Path(row["worktree"]).resolve() == path]
    refusals: list[str] = []; embedded_primary = False; active_process_evidence: list[dict[str, Any]] = []
    if args.controller_checkout:
        topology, topology_refusals = controller_topology(args.controller_checkout, path, expected); refusals.extend(topology_refusals)
        if topology.get("classification") == "controller_nested_integration_owner" and args.disposition != "detach_same_sha":
            refusals.append("controller_nested_owner_requires_detach_same_sha")
    if topology and topology.get("classification") == "controller_nested_integration_owner" and not matches and path.exists():
        path_root, path_common = identity(path)
        embedded = [row for row in rows if Path(row["worktree"]).resolve() == path_common and row.get("HEAD") == expected and row.get("branch") == target]
        if path_root == path and len(embedded) == 1: matches = embedded; embedded_primary = True
    if target_sha != expected: refusals.append(f"target_sha_mismatch expected={expected} actual={target_sha or 'missing'}")
    if len(matches) > 1: refusals.append("duplicate_worktree_registration")
    row = matches[0] if len(matches) == 1 else None
    already_released = False
    before_branch = None if row is None else row.get("branch", "DETACHED")
    before_head = None if row is None else row.get("HEAD")
    if row is None:
        if path.exists(): refusals.append("path_exists_but_unregistered")
        elif args.disposition == "remove" and target_sha == expected: already_released = True
        else: refusals.append("worktree_not_registered")
    else:
        if not path.exists(): refusals.append("worktree_missing_but_registered")
        else:
            _, path_common = identity(path); _, repo_common = identity(repo)
            if path_common != repo_common: refusals.append("git_common_dir_mismatch")
            if before_head != expected: refusals.append("unexpected_head")
            if lock_path(path).exists(): refusals.append("index_lock_present")
            if status(path): refusals.append("dirty")
            if (path / ".gitmodules").exists():
                nested = git(path, "submodule", "status", "--recursive", check=False).splitlines()
                if args.disposition != "detach_same_sha" and any(line and not line.startswith("-") for line in nested): refusals.append("nested_repository_initialized")
            has_active_cwd, active_process_evidence = active_cwd_processes(path)
            if has_active_cwd: refusals.append("active_process")
            if args.disposition == "detach_same_sha":
                if before_branch == "DETACHED" and before_head == expected: already_released = True
                elif before_branch != target: refusals.append("worktree_does_not_own_target_ref")
            elif before_branch != target:
                refusals.append("worktree_does_not_own_target_ref")
    outcome = "refused"
    if not refusals and git(repo, "rev-parse", "--verify", f"{target}^{{commit}}", check=False) != expected:
        refusals.append("target_sha_changed_before_release")
    if not refusals:
        if already_released: outcome = "already_released"
        elif args.disposition == "detach_same_sha":
            git(path, "checkout", "--detach", expected); outcome = "detached_same_sha"
        else:
            git(repo, "worktree", "remove", str(path)); outcome = "removed"
        if git(repo, "rev-parse", "--verify", f"{target}^{{commit}}") != expected:
            raise LifecycleError("target_ref_changed_during_release")
        if args.controller_checkout and topology and topology.get("classification") == "controller_nested_integration_owner":
            final_topology, final_topology_refusals = controller_topology(args.controller_checkout, path, expected)
            if final_topology_refusals: raise LifecycleError("controller_topology_changed_during_release:" + ",".join(final_topology_refusals))
            topology = final_topology
    final_rows = listed(repo)
    final = next((item for item in final_rows if Path(item["worktree"]).resolve() == path), None)
    if embedded_primary and path.exists():
        final = {"worktree": str(path), "HEAD": git(path, "rev-parse", "HEAD"),
                 "branch": git(path, "symbolic-ref", "-q", "HEAD", check=False) or "DETACHED"}
    payload = {"schema_version": SCHEMA, "operation": "release-target", "passed": not refusals,
               "outcome": outcome, "repository_root": str(identity(repo)[0]), "git_common_dir": str(identity(repo)[1]),
               "target_ref": target, "expected_head": expected, "worktree": str(path), "disposition": args.disposition,
               "task_id": args.task_id, "owner": args.owner, "before_branch": before_branch, "before_head": before_head,
               "after_branch": None if final is None else final.get("branch", "DETACHED"),
               "after_head": None if final is None else final.get("HEAD"), "target_sha_after": git(repo, "rev-parse", target, check=False),
               "already_released": already_released, "registration_kind": "embedded_submodule_primary" if embedded_primary else "worktree_list",
               "topology": topology, "active_processes": active_process_evidence, "refusals": refusals, "inventory": final_rows}
    write_receipt(args.output, payload)
    if refusals: raise LifecycleError("target_release_refused: " + ",".join(refusals))
    return payload

def cleanup(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repository.resolve(); path = args.path.resolve(); target = full_ref(args.target_ref); branch = branch_ref(args.branch_ref, allow_detached=True)
    expected = args.expected_head
    refusals: list[str] = []; deinitialized: list[dict[str, Any]] = []; admins_to_remove: list[Path] = []
    approved = dict(args.deinitialized_submodule)
    if len(approved) != len(args.deinitialized_submodule): refusals.append("duplicate_deinitialized_submodule_path")
    if args.delete_branch and branch == "DETACHED": refusals.append("detached_has_no_branch")
    registered = any(Path(row["worktree"]).resolve() == path for row in listed(repo))
    already_removed = not path.exists() and not registered
    if not path.exists() and registered: refusals.append("worktree_missing_but_registered")
    elif not path.exists() and run_returncode(repo, "merge-base", "--is-ancestor", expected, target):
        refusals.append("unreachable_from_target")
    elif path.exists():
        if lock_path(path).exists(): refusals.append("index_lock_present")
        if status(path): refusals.append("dirty")
        if git(path, "rev-parse", "HEAD") != expected: refusals.append("unexpected_head")
        actual_branch = git(path, "symbolic-ref", "-q", "HEAD", check=False) or "DETACHED"
        if actual_branch != branch: refusals.append("unexpected_branch")
        if run_returncode(repo, "merge-base", "--is-ancestor", expected, target):
            refusals.append("unreachable_from_target")
        if (path / ".gitmodules").exists():
            nested = git(path, "submodule", "status", "--recursive", check=False).splitlines()
            if any(line and not line.startswith("-") for line in nested): refusals.append("nested_repository_initialized")
        worktree_git_dir = Path(git(path, "rev-parse", "--absolute-git-dir")).resolve()
        modules_root = worktree_git_dir / "modules"
        discovered: dict[str, Path] = {}; invalid_admin_paths: set[str] = set()
        if modules_root.is_dir():
            modules_canonical = modules_root.resolve()
            for current, directories, files in os.walk(modules_root):
                current_path = Path(current)
                for directory in list(directories):
                    candidate_child = current_path / directory
                    if candidate_child.is_symlink():
                        relative_child = candidate_child.relative_to(modules_root).as_posix(); invalid_admin_paths.add(relative_child)
                        refusals.append(f"deinitialized_submodule_admin_symlink_or_escape:{relative_child}"); directories.remove(directory)
                candidate = current_path; candidate_canonical = candidate.resolve()
                if candidate_canonical != modules_canonical and modules_canonical not in candidate_canonical.parents:
                    relative_escape = candidate.relative_to(modules_root).as_posix(); invalid_admin_paths.add(relative_escape)
                    refusals.append(f"deinitialized_submodule_admin_symlink_or_escape:{relative_escape}"); directories[:] = []; continue
                if "HEAD" in files and "config" in files and (candidate / "objects").is_dir():
                    discovered[candidate.relative_to(modules_root).as_posix()] = candidate_canonical; directories[:] = []
        if discovered and not approved: refusals.append("deinitialized_submodule_admin_requires_approval")
        for relative in sorted(set(discovered) | set(approved)):
            if relative in invalid_admin_paths: continue
            admin = discovered.get(relative); approved_repo = approved.get(relative)
            if admin is None: refusals.append(f"approved_submodule_admin_missing:{relative}"); continue
            if approved_repo is None: refusals.append(f"unapproved_deinitialized_submodule_admin:{relative}"); continue
            if not approved_repo.exists(): refusals.append(f"approved_submodule_repository_missing:{relative}"); continue
            if (path / relative / ".git").exists(): refusals.append(f"submodule_still_initialized:{relative}"); continue
            sub_status = git(path, "submodule", "status", "--", relative, check=False)
            if not sub_status.startswith("-"): refusals.append(f"submodule_not_deinitialized:{relative}"); continue
            entry = git(path, "ls-tree", expected, "--", relative).split(None, 3)
            if len(entry) < 3 or entry[0] != "160000": refusals.append(f"expected_gitlink_missing:{relative}"); continue
            gitlink_sha = entry[2]
            admin_head = subprocess.run(["git", f"--git-dir={admin}", "rev-parse", "HEAD"], text=True, capture_output=True, stdin=subprocess.DEVNULL).stdout.strip()
            approved_git_dir = Path(git(approved_repo, "rev-parse", "--absolute-git-dir")).resolve()
            if approved_git_dir == admin or admin in approved_git_dir.parents: refusals.append(f"approved_repository_is_stale_admin:{relative}"); continue
            object_exists = run_returncode(approved_repo, "cat-file", "-e", f"{gitlink_sha}^{{commit}}") == 0
            containing_refs = git(approved_repo, "for-each-ref", "--contains", gitlink_sha, "--format=%(refname)", check=False).splitlines()
            if admin_head != gitlink_sha: refusals.append(f"stale_admin_head_mismatch:{relative}")
            if not object_exists or not containing_refs: refusals.append(f"gitlink_unreachable_from_approved_repository:{relative}")
            deinitialized.append({"path": relative, "gitlink_sha": gitlink_sha, "stale_admin": str(admin),
                                  "admin_head": admin_head, "approved_repository": str(approved_repo),
                                  "approved_git_dir": str(approved_git_dir), "containing_refs": containing_refs,
                                  "reachable": object_exists and bool(containing_refs)})
            admins_to_remove.append(admin)
        if active(path): refusals.append("active_process")
    removed = already_removed; removed_admin_paths: list[str] = []
    if not refusals and not already_removed:
        for admin in admins_to_remove:
            shutil.rmtree(admin); removed_admin_paths.append(str(admin))
            parent = admin.parent
            while parent != worktree_git_dir and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir(); removed_admin_paths.append(str(parent)); parent = parent.parent
        removal = subprocess.run(["git", "-C", str(repo), "worktree", "remove", str(path)], text=True, capture_output=True, stdin=subprocess.DEVNULL,
                                 env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
        removed = removal.returncode == 0 and not path.exists()
        if removal.returncode: refusals.append("ordinary_worktree_remove_failed:" + removal.stderr.strip().replace("\n", " "))
        elif not removed: refusals.append("expected_removal_failed")
    if not refusals and args.delete_branch:
        existing = git(repo, "rev-parse", "--verify", branch, check=False)
        if existing and existing != expected: refusals.append("branch_tip_mismatch")
        elif existing: git(repo, "update-ref", "-d", branch, expected)
    inventory = listed(repo); prune = git(repo, "worktree", "prune", "--dry-run", "--verbose", check=False).splitlines()
    payload = {"schema_version": SCHEMA, "operation": "cleanup", "passed": removed and not refusals,
               "removed": removed, "already_removed": already_removed, "refusals": refusals, "worktree": str(path), "expected_head": expected,
               "target_ref": target, "branch_ref": branch, "deinitialized_submodules": deinitialized,
               "removed_admin_paths": removed_admin_paths, "inventory": inventory, "prune_dry_run": prune}
    write_receipt(args.output, payload)
    if refusals: raise LifecycleError("cleanup_refused: " + ",".join(refusals))
    return payload

def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__, allow_abbrev=False); sub = root.add_subparsers(dest="command", required=True)
    create_p = sub.add_parser("create", allow_abbrev=False); create_p.set_defaults(func=create)
    create_p.add_argument("--repository", type=Path, required=True); create_p.add_argument("--target-ref", required=True); create_p.add_argument("--expected-base")
    create_p.add_argument("--fetch"); create_p.add_argument("--path", type=Path, required=True); create_p.add_argument("--branch-ref", required=True)
    create_p.add_argument("--task-id", required=True); create_p.add_argument("--expected-path", action="append", default=[]); create_p.add_argument("--validation-command", action="append", default=[])
    create_p.add_argument("--cleanup-owner", required=True); create_p.add_argument("--hard-min-free-bytes", type=int); create_p.add_argument("--output", type=Path, required=True)
    verify_p = sub.add_parser("verify", allow_abbrev=False); verify_p.set_defaults(func=verify); verify_p.add_argument("--manifest", type=Path, required=True); verify_p.add_argument("--path", type=Path); verify_p.add_argument("--output", type=Path, required=True)
    audit_p = sub.add_parser("audit", allow_abbrev=False); audit_p.set_defaults(func=audit); audit_p.add_argument("--repository", type=Path, required=True); audit_p.add_argument("--target-ref", required=True); audit_p.add_argument("--output", type=Path, required=True)
    release_p = sub.add_parser("release-target", allow_abbrev=False); release_p.set_defaults(func=release_target)
    for name in ("repository", "path", "output"): release_p.add_argument(f"--{name}", type=Path, required=True)
    release_p.add_argument("--target-ref", required=True); release_p.add_argument("--expected-head", required=True)
    release_p.add_argument("--disposition", choices=("detach_same_sha", "remove"), required=True)
    release_p.add_argument("--task-id", required=True); release_p.add_argument("--owner", required=True)
    release_p.add_argument("--controller-checkout", type=Path)
    clean_p = sub.add_parser("cleanup", allow_abbrev=False); clean_p.set_defaults(func=cleanup)
    for name in ("repository", "path", "output"): clean_p.add_argument(f"--{name}", type=Path, required=True)
    clean_p.add_argument("--target-ref", required=True); clean_p.add_argument("--branch-ref", required=True); clean_p.add_argument("--expected-head", required=True); clean_p.add_argument("--delete-branch", action="store_true")
    clean_p.add_argument("--deinitialized-submodule", action="append", type=submodule_repository, default=[], metavar="RELATIVE_PATH=APPROVED_REPOSITORY")
    return root

def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try: payload = args.func(args); print(json.dumps({"schema_version": SCHEMA, "operation": payload["operation"], "passed": payload.get("passed", True)}, sort_keys=True)); return 0
    except (LifecycleError, OSError, json.JSONDecodeError) as exc: print(f"worktree_lifecycle: error: {exc}", file=sys.stderr); return 2
if __name__ == "__main__": raise SystemExit(main())
