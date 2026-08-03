#!/usr/bin/env python3
"""Resolve the canonical Juno controller checkout without changing Git state."""
from __future__ import annotations

import argparse
import hashlib
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


class ResolverError(Exception):
    def __init__(self, message: str, result: dict[str, object]):
        super().__init__(message)
        self.result = result


def fail(message: str, result: dict[str, object]) -> None:
    result["valid"] = False
    result["diagnostics"] = [*result.get("diagnostics", []), message]
    raise ResolverError(message, result)


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
    create_receipt_sha256 = worktree_config(cwd, "juno.workspace.createReceiptSha256") if repo_root_text else None
    verify_receipt_sha256 = worktree_config(cwd, "juno.workspace.verifyReceiptSha256") if repo_root_text else None
    expected_paths_sha256 = worktree_config(cwd, "juno.workspace.expectedPathsSha256") if repo_root_text else None
    role_authority = worktree_config(cwd, "juno.workspace.roleAuthority") if repo_root_text else None
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
        "create_receipt_sha256": create_receipt_sha256, "verify_receipt_sha256": verify_receipt_sha256,
        "expected_paths_sha256": expected_paths_sha256, "role_authority": role_authority,
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
    task_authority = (task_id, manifest_identity, create_receipt_sha256, verify_receipt_sha256, expected_paths_sha256)
    if role == "task" and not all(task_authority):
        errors.append("task workspace registration is incomplete: exact lifecycle receipt identity is required")
    if role != "task" and any(task_authority):
        errors.append("non-task workspace carries task lifecycle identity")
    if role == "integration-owner" and role_authority not in {"eligible-candidate.v1", "protected-integration.v1"}:
        errors.append("integration-owner workspace lacks exact eligible/protected authority")
    if role != "integration-owner" and role_authority:
        errors.append("non-integration-owner workspace carries protected role authority")
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
    parser.add_argument("--create-receipt", type=Path)
    parser.add_argument("--verify-receipt", type=Path)
    parser.add_argument("--eligible-receipt", type=Path)
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
        task_authority: dict[str, str] | None = None
        integration_authority: dict[str, str] | None = None
        if args.register_workspace_role == "integration-owner":
            if not args.eligible_receipt or args.task_id or args.manifest_identity or args.create_receipt or args.verify_receipt:
                raise SystemExit("controller-resolver: integration-owner role/base requires exact eligible authority via --eligible-receipt")
            try:
                eligible_bytes = args.eligible_receipt.resolve().read_bytes()
                eligible = json.loads(eligible_bytes)
            except (OSError, json.JSONDecodeError) as exc:
                raise SystemExit(f"controller-resolver: eligible receipt read failed: {exc}") from exc
            validations = eligible.get("validation")
            matrix = eligible.get("pdr_matrix")
            candidate_path = Path(str(eligible.get("candidate_path") or "/nonexistent")).resolve()
            expected = str(eligible.get("expected_target_sha") or "")
            candidate = str(eligible.get("candidate_sha") or "")
            checks = {
                "schema": eligible.get("schema_version") == "juno_integration_candidate.v2" and eligible.get("operation") == "verify" and eligible.get("eligible") is True,
                "repository": Path(str(eligible.get("repository") or "/nonexistent")).resolve() == current_root,
                "target": git(cwd, "rev-parse", f"{eligible.get('target_ref')}^{{commit}}") == expected,
                "candidate": git(cwd, "rev-parse", f"{candidate}^{{commit}}") == candidate,
                "candidate_path": git(candidate_path, "rev-parse", "HEAD") == candidate and git(candidate_path, "status", "--porcelain=v2", "--untracked-files=all") == "",
                "validation": isinstance(validations, list) and bool(validations) and all(item.get("exit_code") == 0 for item in validations),
                "matrix": isinstance(matrix, dict) and bool(matrix) and all(value == "PASS" for value in matrix.values()),
                "receipt_hashes": all(len(str(eligible.get(field) or "")) == 64 and all(char in "0123456789abcdef" for char in str(eligible.get(field))) for field in ("premerge_review_sha256", "candidate_review_sha256", "candidate_receipt_sha256")),
            }
            failed = [name for name, passed in checks.items() if not passed]
            if failed:
                raise SystemExit("controller-resolver: exact eligible authority mismatch: " + ",".join(failed))
            integration_authority = {"base": expected, "receipt_sha256": hashlib.sha256(eligible_bytes).hexdigest()}
        if args.register_workspace_role == "task":
            if args.task_id or args.manifest_identity or not args.create_receipt or not args.verify_receipt:
                raise SystemExit("controller-resolver: task role registration requires exact --create-receipt and --verify-receipt authority; caller task/hash inputs are forbidden")
            try:
                create_bytes = args.create_receipt.resolve().read_bytes()
                verify_bytes = args.verify_receipt.resolve().read_bytes()
                create = json.loads(create_bytes)
                verification = json.loads(verify_bytes)
            except (OSError, json.JSONDecodeError) as exc:
                raise SystemExit(f"controller-resolver: lifecycle receipt read failed: {exc}") from exc
            create_hash = hashlib.sha256(create_bytes).hexdigest()
            expected_paths = create.get("expected_paths")
            expected_paths_hash = hashlib.sha256(json.dumps(expected_paths, sort_keys=True, separators=(",", ":")).encode()).hexdigest() if isinstance(expected_paths, list) else ""
            actual = verification.get("actual") if isinstance(verification.get("actual"), dict) else {}
            actual_common = repository_identity(current_root)
            actual_branch = git(cwd, "symbolic-ref", "-q", "HEAD")
            actual_base = git(cwd, "rev-parse", "HEAD")
            manifest_bound = {"task_id": create.get("task_id"), "branch_ref": create.get("branch_ref"),
                              "base_sha": create.get("base_sha"), "git_common_dir": create.get("git_common_dir"),
                              "expected_paths": expected_paths}
            manifest_identity = hashlib.sha256(json.dumps(manifest_bound, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            checks = {
                "create_schema": create.get("schema_version") == "juno_worktree_lifecycle.v5" and create.get("operation") == "create",
                "create_role": create.get("workspace_role") == "task",
                "create_common": create.get("git_common_dir") == actual_common,
                "create_path": Path(str(create.get("worktree") or "/nonexistent")).resolve() == current_root,
                "create_branch": create.get("branch_ref") == actual_branch,
                "create_base": create.get("base_sha") == actual_base,
                "create_task": isinstance(create.get("task_id"), str) and bool(create.get("task_id")),
                "create_expected_paths": isinstance(expected_paths, list) and all(isinstance(path, str) for path in expected_paths),
                "create_manifest_identity": create.get("workspace_manifest_identity") == manifest_identity,
                "verify_schema": verification.get("schema_version") == "juno_worktree_lifecycle.v5" and verification.get("operation") == "verify" and verification.get("passed") is True,
                "verify_manifest_sha256": verification.get("manifest_sha256") == create_hash,
                "verify_path": actual.get("worktree") == str(current_root) and verification.get("expected_canonical_path") == str(current_root),
                "verify_common": actual.get("git_common_dir") == actual_common,
                "verify_branch": actual.get("branch_ref") == actual_branch,
                "verify_base": actual.get("head") == actual_base,
                "verify_clean": actual.get("clean") is True and git(cwd, "status", "--porcelain=v2", "--untracked-files=all") == "",
                "verify_checkout_policy": actual.get("checkout_policy") == create.get("checkout_policy"),
                "verify_target": actual.get("target_sha") == create.get("target_sha_at_create"),
            }
            failed = [name for name, passed in checks.items() if not passed]
            if failed:
                raise SystemExit("controller-resolver: exact lifecycle receipt authority mismatch: " + ",".join(failed))
            task_authority = {"task_id": str(create["task_id"]), "manifest_identity": manifest_identity,
                              "create_receipt_sha256": create_hash, "verify_receipt_sha256": hashlib.sha256(verify_bytes).hexdigest(),
                              "expected_paths_sha256": expected_paths_hash}
        elif args.register_workspace_role != "integration-owner" and (args.task_id or args.manifest_identity or args.create_receipt or args.verify_receipt or args.eligible_receipt):
            raise SystemExit("controller-resolver: lifecycle authority does not apply to this role registration")
        base = integration_authority["base"] if integration_authority else git(cwd, "rev-parse", "HEAD")
        if not base:
            raise SystemExit("controller-resolver: role registration requires a readable HEAD")
        subprocess.run(["git", "-C", str(cwd), "config", "--local", "extensions.worktreeConfig", "true"], check=True)
        subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "juno.workspace.role", args.register_workspace_role], check=True)
        authority_keys = {"task_id": "taskId", "manifest_identity": "manifestIdentity",
                          "create_receipt_sha256": "createReceiptSha256", "verify_receipt_sha256": "verifyReceiptSha256",
                          "expected_paths_sha256": "expectedPathsSha256"}
        if args.register_workspace_role == "task" and task_authority:
            for field, key in authority_keys.items():
                subprocess.run(["git", "-C", str(cwd), "config", "--worktree", f"juno.workspace.{key}", task_authority[field]], check=True)
        else:
            for key in authority_keys.values():
                subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "--unset-all", f"juno.workspace.{key}"], check=False)
        if integration_authority:
            subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "juno.workspace.roleAuthority", "eligible-candidate.v1"], check=True)
            subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "juno.workspace.eligibleReceiptSha256", integration_authority["receipt_sha256"]], check=True)
        else:
            subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "--unset-all", "juno.workspace.roleAuthority"], check=False)
            subprocess.run(["git", "-C", str(cwd), "config", "--worktree", "--unset-all", "juno.workspace.eligibleReceiptSha256"], check=False)
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
    try:
        main()
    except ResolverError as exc:
        print(json.dumps(exc.result, sort_keys=True))
        print(f"controller-resolver: {exc}", file=sys.stderr)
        raise SystemExit(2)
