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
    source = "environment" if explicit else "registration" if registered else "current-root"
    raw = explicit or registered or str(current_root)
    controller = canonical(raw, current_root)
    expected_branch = os.environ.get("JUNO_CONTROLLER_BRANCH", "").strip() or (
        config(cwd, "juno.controller.branch") if source == "registration" else None
    )
    role = os.environ.get("JUNO_WORKSPACE_ROLE", "").strip() or config(cwd, "juno.workspace.role") or (
        "controller" if controller == current_root else "task"
    )
    result: dict[str, object] = {
        "path": str(controller), "current_root": str(current_root), "resolver": "installed",
        "source": source, "expected_branch": expected_branch,
        "actual_branch": None, "role": role, "enforcement": enforcement,
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
        if source in {"environment", "registration"} and repo_root_text:
            current_identity = repository_identity(current_root)
            controller_identity = repository_identity(controller)
            if not current_identity or current_identity != controller_identity:
                label = "explicit" if source == "environment" else "registered"
                errors.append(f"{label} controller is not a linked worktree of the invoking repository")
        if expected_branch and actual_branch != expected_branch:
            errors.append(f"controller branch mismatch: expected {expected_branch!r}, found {actual_branch or 'detached HEAD'!r}")
    if role not in VALID_ROLES:
        errors.append(f"invalid workspace role {role!r}; expected controller, task, or integration-owner")

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
    parser.add_argument("--operation", choices=["diagnostic", "kanban", "orchestration", "session-write"], default="diagnostic")
    parser.add_argument("--format", choices=["json", "root", "shell"], default="json")
    parser.add_argument("--register", metavar="PATH")
    parser.add_argument("--branch")
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
