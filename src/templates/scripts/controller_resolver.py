#!/usr/bin/env python3
"""Resolve the canonical Juno controller checkout without changing Git state."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Optional

VALID_ROLES = {"controller", "task", "integration-owner"}
VALID_ENFORCEMENT = {"off", "warn", "strict"}


def git(cwd: Path, *args: str) -> Optional[str]:
    result = subprocess.run(["git", "-C", str(cwd), *args], text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else None


def canonical(value: str, base: Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def repository_identity(path: Path) -> Optional[str]:
    common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return str(Path(common).resolve()) if common else None


def config(cwd: Path, key: str) -> Optional[str]:
    return git(cwd, "config", "--local", "--get", key)


def worktree_config(cwd: Path, key: str) -> Optional[str]:
    """Read checkout-specific persisted identity; never infer it from process env."""
    return git(cwd, "config", "--worktree", "--get", key)


def is_primary_worktree(cwd: Path) -> bool:
    git_dir = git(cwd, "rev-parse", "--path-format=absolute", "--git-dir")
    common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return bool(git_dir and common and Path(git_dir).resolve() == Path(common).resolve())


def fail(message: str, result: dict[str, object]) -> None:
    result["valid"] = False
    result["diagnostics"] = [*result.get("diagnostics", []), message]
    print(json.dumps(result, sort_keys=True))
    print(f"controller-resolver: {message}", file=sys.stderr)
    raise SystemExit(2)


def resolve(cwd: Path, operation: str) -> dict[str, object]:
    cwd = cwd.resolve()
    repo_root_text = git(cwd, "rev-parse", "--show-toplevel")
    current_root = Path(repo_root_text).resolve() if repo_root_text else cwd
    enforcement = os.environ.get("JUNO_WORKSPACE_ENFORCEMENT", "off").strip().lower()
    if enforcement not in VALID_ENFORCEMENT:
        enforcement = "strict"

    explicit = os.environ.get("JUNO_TASK_ROOT", "").strip()
    registered = config(cwd, "juno.controller.path") if repo_root_text else None
    # Environment is routing/assertion only. Persisted controller registration,
    # checkout registration, and primary-worktree topology determine identity.
    source = "registration" if registered else "primary-worktree"
    persisted_controller = canonical(registered, current_root) if registered else (
        current_root if repo_root_text and is_primary_worktree(current_root) else None
    )
    asserted_controller = canonical(explicit, current_root) if explicit else None
    controller = persisted_controller or asserted_controller or current_root
    expected_branch = config(cwd, "juno.controller.branch") if registered else None
    asserted_branch = os.environ.get("JUNO_CONTROLLER_BRANCH", "").strip() or None
    persisted_role = worktree_config(cwd, "juno.workspace.role") if repo_root_text else None
    role_base = worktree_config(cwd, "juno.workspace.roleBase") if repo_root_text else None
    task_id = worktree_config(cwd, "juno.workspace.taskId") if repo_root_text else None
    manifest_identity = worktree_config(cwd, "juno.workspace.manifestIdentity") if repo_root_text else None
    if not repo_root_text:
        role = "controller"
        role_source = "non-git-current-root"
    elif persisted_controller == current_root:
        role = "controller"
        role_source = "controller-registration" if registered else "primary-worktree"
    else:
        role = persisted_role or "unregistered"
        role_source = "worktree-registration" if persisted_role else "missing-worktree-registration"
    asserted_role = os.environ.get("JUNO_WORKSPACE_ROLE", "").strip() or None
    result: dict[str, object] = {
        "path": str(controller), "current_root": str(current_root), "resolver": "installed",
        "source": source, "expected_branch": expected_branch,
        "actual_branch": None, "role": role, "role_source": role_source, "role_base": role_base,
        "task_id": task_id, "manifest_identity": manifest_identity,
        "role_assertion": asserted_role, "enforcement": enforcement,
        "operation": operation, "valid": True, "diagnostics": [],
    }

    errors: list[str] = []
    if not controller.is_dir():
        errors.append(f"configured controller path does not exist: {controller}")
    elif not (controller / ".juno_task").is_dir():
        errors.append(f"configured controller has no .juno_task directory: {controller}")
    else:
        actual_branch = git(controller, "symbolic-ref", "--quiet", "--short", "HEAD")
        result["actual_branch"] = actual_branch
        if repo_root_text:
            current_identity = repository_identity(current_root)
            controller_identity = repository_identity(controller)
            if not current_identity or current_identity != controller_identity:
                errors.append("configured controller is not a linked worktree of the invoking repository")
        if expected_branch and actual_branch != expected_branch:
            errors.append(f"controller branch mismatch: expected {expected_branch!r}, found {actual_branch or 'detached HEAD'!r}")
    if asserted_controller and persisted_controller and asserted_controller != persisted_controller:
        errors.append(f"JUNO_TASK_ROOT assertion mismatch: persisted={persisted_controller} asserted={asserted_controller}")
    if asserted_branch and expected_branch and asserted_branch != expected_branch:
        errors.append(f"JUNO_CONTROLLER_BRANCH assertion mismatch: persisted={expected_branch!r} asserted={asserted_branch!r}")
    if role == "unregistered":
        errors.append("linked worktree has no persisted workspace role registration; register it through the lifecycle owner")
    elif role not in VALID_ROLES:
        errors.append(f"invalid persisted workspace role {role!r}; expected controller, task, or integration-owner")
    if role == "task" and (not task_id or not manifest_identity):
        errors.append("task workspace registration is incomplete: taskId and manifestIdentity are required")
    if role != "task" and (task_id or manifest_identity):
        errors.append("non-task workspace carries task lifecycle identity")
    if asserted_role and asserted_role not in VALID_ROLES:
        errors.append(f"invalid JUNO_WORKSPACE_ROLE assertion {asserted_role!r}")
    elif asserted_role and asserted_role != role:
        errors.append(f"JUNO_WORKSPACE_ROLE assertion mismatch: persisted={role!r} asserted={asserted_role!r}")

    role_problem = role == "integration-owner" and operation in {"kanban", "orchestration", "session-write"}
    if role_problem:
        message = f"integration-owner workspace refuses {operation} writes; launch from the controller and pass TASK_ROOT explicitly"
        if enforcement == "strict":
            errors.append(message)
        elif enforcement == "warn":
            result["diagnostics"] = [message]
            print(f"controller-resolver: warning: {message}", file=sys.stderr)

    # Explicit and registered settings are authoritative: invalid values never fall back.
    if errors:
        fail("; ".join(errors), result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--operation", choices=["diagnostic", "kanban", "orchestration", "session-write", "product-edit"], default="diagnostic")
    parser.add_argument("--format", choices=["json", "root", "shell"], default="json")
    parser.add_argument("--register", metavar="PATH")
    parser.add_argument("--branch")
    parser.add_argument("--register-workspace-role", choices=sorted(VALID_ROLES))
    parser.add_argument("--task-id")
    parser.add_argument("--manifest-identity")
    args = parser.parse_args()
    cwd = Path(args.cwd).resolve()
    if args.register:
        root = git(cwd, "rev-parse", "--show-toplevel")
        if not root:
            raise SystemExit("controller-resolver: registration requires a Git worktree")
        target = canonical(args.register, Path(root))
        branch = args.branch or git(target, "symbolic-ref", "--quiet", "--short", "HEAD")
        if not branch:
            raise SystemExit("controller-resolver: registration requires --branch for detached HEAD")
        subprocess.run(["git", "-C", str(cwd), "config", "--local", "juno.controller.path", str(target)], check=True)
        subprocess.run(["git", "-C", str(cwd), "config", "--local", "juno.controller.branch", branch], check=True)
    if args.register_workspace_role:
        if not (repo_root_text := git(cwd, "rev-parse", "--show-toplevel")):
            raise SystemExit("controller-resolver: role registration requires a Git worktree")
        current_root = Path(repo_root_text).resolve()
        registered_controller = config(cwd, "juno.controller.path")
        persisted_controller = canonical(registered_controller, current_root) if registered_controller else (
            current_root if is_primary_worktree(current_root) else None
        )
        if args.register_workspace_role == "controller" and persisted_controller != current_root:
            raise SystemExit("controller-resolver: controller role requires persisted controller identity")
        if args.register_workspace_role != "controller" and persisted_controller == current_root:
            raise SystemExit("controller-resolver: task/integration-owner role requires a linked non-controller worktree")
        if args.register_workspace_role == "task":
            if not args.task_id or not args.manifest_identity:
                raise SystemExit("controller-resolver: task role registration requires --task-id and --manifest-identity")
            if not (len(args.manifest_identity) == 64 and all(c in "0123456789abcdef" for c in args.manifest_identity)):
                raise SystemExit("controller-resolver: --manifest-identity must be a lowercase SHA-256")
        elif args.task_id or args.manifest_identity:
            raise SystemExit("controller-resolver: task lifecycle identity is valid only for task registration")
        base = git(cwd, "rev-parse", "HEAD")
        if not base:
            raise SystemExit("controller-resolver: role registration requires a readable HEAD")
        subprocess.run(["git", "-C", str(cwd), "config", "--local", "extensions.worktreeConfig", "true"], check=True)
        subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "juno.workspace.role", args.register_workspace_role], check=True)
        if args.register_workspace_role == "task":
            subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "juno.workspace.taskId", args.task_id], check=True)
            subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "juno.workspace.manifestIdentity", args.manifest_identity], check=True)
        else:
            subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "--unset-all", "juno.workspace.taskId"], check=False)
            subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "--unset-all", "juno.workspace.manifestIdentity"], check=False)
        subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "juno.workspace.roleBase", base], check=True)
    result = resolve(cwd, args.operation)
    if args.format == "root":
        print(result["path"])
    elif args.format == "shell":
        print(f"export JUNO_TASK_ROOT={shlex.quote(str(result['path']))}")
        print(f"export JUNO_CONTROLLER_SOURCE={shlex.quote(str(result['source']))}")
        print(f"export JUNO_WORKSPACE_ROLE={shlex.quote(str(result['role']))}")
    else:
        print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
