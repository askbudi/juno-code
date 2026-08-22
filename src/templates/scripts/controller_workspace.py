#!/usr/bin/env python3
"""Canonical sparse-controller ownership, creation, admission, and cutover planning.

This is the single deterministic authority for controller workspace policy.  It
protects managed workflows from role/path mistakes; it is not an OS sandbox.
Live registration and ref mutation are deliberately emitted as plans and are
never performed by this helper.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

sys.dont_write_bytecode = True

SCHEMA = "juno_controller_workspace.v1"
RECEIPT_SCHEMA = "juno_controller_workspace_receipt.v1"
OWNERSHIP_SCHEMA = "juno_workspace_ownership.v1"
PATTERN_HEADER = "# juno-controller-workspace sparse-v1"
CLASSES = ("controller_canonical", "shared_managed_distribution", "product_canonical", "local_ignored")
# Task-scope records predate the metadata-only controller cutover. Retired sparse
# policies omitted this controller-private root even though task_workspace.py
# persisted records there. Keep this fallback exact and narrow: unknown sibling
# paths remain unclassified, and an explicit policy classification wins.
LEGACY_CONTROLLER_PREFIXES = (".juno_task/task-scopes",)
AGENT_SURFACE_ROOTS = ("AGENTS.md", "CLAUDE.md", ".agents", ".claude", ".pi")
REQUIRED_ROOT_IGNORES = ("/AGENTS.md", "/CLAUDE.md", "/.agents/", "/.claude/", "/.pi/")
SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")

class WorkspaceError(RuntimeError):
    pass

def run(argv: list[str], cwd: Path, check: bool = True, *, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, input=input_text, capture_output=True,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if check and result.returncode:
        raise WorkspaceError(result.stderr.strip() or result.stdout.strip() or f"command failed: {argv}")
    return result

def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check).stdout.strip()

def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()

def atomic_receipt(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve(); path.parent.mkdir(parents=True, exist_ok=True)
    data = canonical_json(value)
    if path.exists() and path.read_bytes() != data:
        raise WorkspaceError(f"immutable receipt collision: {path}")
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_bytes(data); os.replace(temporary, path)

def safe_path(value: Any) -> str:
    if not isinstance(value, str) or value != value.strip() or not value:
        raise WorkspaceError("ownership paths must be non-empty normalized strings")
    path = PurePosixPath(value)
    if (path.is_absolute() or value != path.as_posix() or value in {".", ".git"} or ".git" in path.parts
            or ".." in path.parts or "\\" in value or any(c in value for c in "*?[]{}!#")
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise WorkspaceError(f"unsafe workspace path: {value!r}")
    return value.rstrip("/")

def concrete_path(value: Any) -> str:
    """Validate a literal Git path without treating route brackets as patterns."""
    if not isinstance(value, str) or value != value.strip() or not value:
        raise WorkspaceError("tracked paths must be non-empty normalized strings")
    path = PurePosixPath(value)
    if (path.is_absolute() or value != path.as_posix() or value in {".", ".git"} or ".git" in path.parts
            or ".." in path.parts or "\\" in value or any(c in value for c in "*?{}!#")
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise WorkspaceError(f"unsafe tracked path: {value!r}")
    return value.rstrip("/")


def overlap(left: str, right: str) -> bool:
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")

def normalize(values: Any, label: str, *, nonempty: bool = True) -> list[str]:
    if not isinstance(values, list) or (nonempty and not values):
        raise WorkspaceError(f"{label} must be a{' non-empty' if nonempty else 'n'} array")
    result = sorted(safe_path(value) for value in values)
    if result != sorted(set(result)):
        raise WorkspaceError(f"{label} contains duplicate paths")
    for index, left in enumerate(result):
        for right in result[index + 1:]:
            if overlap(left, right):
                raise WorkspaceError(f"{label} contains overlap: {left}, {right}")
    return result

def load_policy(path: Path) -> dict[str, Any]:
    try: value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc: raise WorkspaceError(f"invalid controller policy: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA:
        raise WorkspaceError(f"controller policy must use {SCHEMA}")
    if set(value) != {"schema_version", "controller_branch", "ownership", "sparse_policy", "generation"}:
        raise WorkspaceError("controller policy has unknown or missing top-level fields")
    branch = value["controller_branch"]
    if not isinstance(branch, str) or not branch.startswith("refs/heads/") or any(c in branch for c in " \t\r\n~^:?*[\\"):
        raise WorkspaceError("controller_branch must be a safe full local branch ref")
    ownership = value["ownership"]
    if not isinstance(ownership, dict) or set(ownership) != {"schema_version", *CLASSES} or ownership.get("schema_version") != OWNERSHIP_SCHEMA:
        raise WorkspaceError("ownership manifest must contain exactly four versioned classes")
    normalized: dict[str, list[str]] = {name: normalize(ownership[name], f"ownership.{name}") for name in CLASSES}
    for i, left_name in enumerate(CLASSES):
        for right_name in CLASSES[i + 1:]:
            collisions = [(a, b) for a in normalized[left_name] for b in normalized[right_name] if overlap(a, b)]
            if collisions: raise WorkspaceError(f"ownership overlap {left_name}/{right_name}: {collisions[:3]}")
    sparse = value["sparse_policy"]
    if not isinstance(sparse, dict) or set(sparse) != {"style", "index_sparse", "selected_paths", "required_paths"}:
        raise WorkspaceError("sparse_policy has unknown or missing fields")
    if sparse["style"] != "non-cone" or sparse["index_sparse"] is not False:
        raise WorkspaceError("canonical controller requires non-cone sparse checkout and index.sparse=false")
    selected = normalize(sparse["selected_paths"], "sparse_policy.selected_paths")
    required = normalize(sparse["required_paths"], "sparse_policy.required_paths")
    if ".gitignore" not in normalized["controller_canonical"]:
        raise WorkspaceError("metadata-controller .gitignore must be controller_canonical")
    misplaced_agent_roots = [root for root in AGENT_SURFACE_ROOTS if root not in normalized["local_ignored"]]
    if misplaced_agent_roots:
        raise WorkspaceError("metadata-controller agent surface must be local_ignored: " + ", ".join(misplaced_agent_roots))
    allowed = normalized["controller_canonical"] + normalized["shared_managed_distribution"]
    for item in selected + required:
        if not any(item == prefix or item.startswith(prefix + "/") for prefix in allowed):
            raise WorkspaceError(f"controller sparse path is not controller/shared owned: {item}")
    for required_path in required:
        if not any(required_path == item or required_path.startswith(item + "/") for item in selected):
            raise WorkspaceError(f"required path is not selected: {required_path}")
    if ".gitignore" not in selected or ".gitignore" not in required:
        raise WorkspaceError("metadata-controller .gitignore must be selected and required")
    generation = value["generation"]
    if (not isinstance(generation, dict) or set(generation) != {"package_name", "package_version", "managed_assets_schema"}
            or generation["package_name"] != "@yylo/cli" or not isinstance(generation["package_version"], str)
            or generation["managed_assets_schema"] != 1):
        raise WorkspaceError("invalid managed generation identity")
    return {**value, "ownership": {"schema_version": OWNERSHIP_SCHEMA, **normalized},
            "sparse_policy": {**sparse, "selected_paths": selected, "required_paths": required}}

def under(value: str, prefixes: list[str] | tuple[str, ...]) -> bool:
    return any(value == prefix or value.startswith(prefix + "/") for prefix in prefixes)


def classify(policy: dict[str, Any], relative: str) -> str:
    value = concrete_path(relative)
    matches = [name for name in CLASSES for prefix in policy["ownership"][name]
               if value == prefix or value.startswith(prefix + "/")]
    if not matches and under(value, LEGACY_CONTROLLER_PREFIXES):
        matches = ["controller_canonical"]
    if len(matches) != 1: raise WorkspaceError(f"path must have exactly one ownership class: {relative} ({matches})")
    return matches[0]


def selected(policy: dict[str, Any], relative: str) -> bool:
    value = concrete_path(relative)
    return under(value, policy["sparse_policy"]["selected_paths"]) or under(value, LEGACY_CONTROLLER_PREFIXES)


def patterns(selected: list[str]) -> list[str]:
    output = [PATTERN_HEADER]
    for value in selected: output.extend((f"/{value}", f"/{value}/**"))
    return output

def policy_identity(policy: dict[str, Any]) -> dict[str, Any]:
    selected = policy["sparse_policy"]["selected_paths"]
    pattern_bytes = ("\n".join(patterns(selected)) + "\n").encode()
    ownership = policy["ownership"]
    return {"ownership_sha256": sha_bytes(canonical_json(ownership)),
            "selected_paths_sha256": sha_bytes(canonical_json(selected)),
            "sparse_patterns_sha256": sha_bytes(pattern_bytes), "selected_path_count": len(selected)}

def tracked(root: Path) -> list[str]:
    raw = run(["git", "-C", str(root), "ls-files", "-z"], root).stdout
    return sorted(item for item in raw.split("\0") if item)

def sparse_file(root: Path) -> Path:
    return Path(git(root, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"))

def bool_config(root: Path, key: str, worktree: bool = False) -> bool | None:
    args = ["config"] + (["--worktree"] if worktree else []) + ["--bool", "--get", key]
    result = run(["git", "-C", str(root), *args], root, False)
    if result.returncode == 1: return None
    if result.returncode or result.stdout.strip() not in {"true", "false"}: raise WorkspaceError(f"invalid Git bool config: {key}")
    return result.stdout.strip() == "true"

def configure(root: Path, policy: dict[str, Any], head: str) -> None:
    git(root, "config", "extensions.worktreeConfig", "true")
    wanted = "\n".join(patterns(policy["sparse_policy"]["selected_paths"])) + "\n"
    result = run(["git", "-C", str(root), "sparse-checkout", "set", "--no-cone", "--no-sparse-index", "--stdin"], root, False, input_text=wanted)
    if result.returncode: raise WorkspaceError(f"cannot apply sparse policy: {result.stderr.strip()}")
    git(root, "reset", "--hard", head)
    git(root, "config", "--worktree", "juno.workspace.role", "controller")
    git(root, "config", "--worktree", "juno.controller.policyIdentity", policy_identity(policy)["sparse_patterns_sha256"])
    git(root, "config", "--worktree", "juno.controller.generation", policy["generation"]["package_version"])

def inspect(root: Path, policy: dict[str, Any], *, require_branch: bool = True) -> dict[str, Any]:
    root = root.expanduser().resolve()
    actual_root = Path(git(root, "rev-parse", "--show-toplevel", check=False) or "/nonexistent").resolve()
    branch = git(root, "symbolic-ref", "-q", "HEAD", check=False) or None
    head = git(root, "rev-parse", "HEAD", check=False) or None
    common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir", check=False) or None
    wanted_patterns = patterns(policy["sparse_policy"]["selected_paths"])
    actual_bytes = sparse_file(root).read_bytes() if actual_root == root and sparse_file(root).is_file() else b""
    materialized = [item for item in tracked(root) if os.path.lexists(root / item)] if actual_root == root else []
    product_materialized = [item for item in materialized if classify(policy, item) == "product_canonical"]
    unexpected = [item for item in materialized if not selected(policy, item)]
    required_missing = [item for item in policy["sparse_policy"]["required_paths"] if not (root / item).exists()]
    classifications: dict[str, int] = {name: 0 for name in CLASSES}
    unclassified: list[str] = []
    tracked_paths = tracked(root) if actual_root == root else []
    tracked_agent_surface = [item for item in tracked_paths if any(
        item == prefix or item.startswith(prefix + "/") for prefix in AGENT_SURFACE_ROOTS)]
    ignore_lines: set[str] = set()
    if (root / ".gitignore").is_file():
        ignore_lines = {line.strip() for line in (root / ".gitignore").read_text().splitlines()
                        if line.strip() and not line.lstrip().startswith("#")}
    missing_root_ignores = [entry for entry in REQUIRED_ROOT_IGNORES if entry not in ignore_lines]
    if actual_root == root:
        for item in tracked_paths:
            try: classifications[classify(policy, item)] += 1
            except WorkspaceError: unclassified.append(item)
    generation = git(root, "config", "--worktree", "--get", "juno.controller.generation", check=False) or None
    role = git(root, "config", "--worktree", "--get", "juno.workspace.role", check=False) or None
    expected_identity = policy_identity(policy)
    persisted_identity = git(root, "config", "--worktree", "--get", "juno.controller.policyIdentity", check=False) or None
    tracked_dirty = bool(git(root, "diff", "--name-only", check=False) or git(root, "diff", "--cached", "--name-only", check=False))
    untracked = [item for item in run(["git", "-C", str(root), "ls-files", "--others", "--exclude-standard", "-z"], root, False).stdout.split("\0") if item]
    unsafe_untracked = []
    for item in untracked:
        try:
            if classify(policy, item) != "local_ignored": unsafe_untracked.append(item)
        except WorkspaceError:
            unsafe_untracked.append(item)
    checks = {
      "root_exact": actual_root == root, "named_controller_branch": (not require_branch) or branch == policy["controller_branch"],
      "head_readable": bool(head and SHA_RE.fullmatch(head)), "clean": not tracked_dirty and not unsafe_untracked,
      "sparse_enabled": bool_config(root, "core.sparseCheckout", True) is True,
      "non_cone": bool_config(root, "core.sparseCheckoutCone", True) is False,
      "sparse_index_disabled": bool_config(root, "index.sparse", True) is False,
      "patterns_exact": actual_bytes == ("\n".join(wanted_patterns) + "\n").encode(),
      "required_present": not required_missing, "gitignore_materialized": (root / ".gitignore").is_file(),
      "root_agent_ignores": not missing_root_ignores, "agent_surface_untracked": not tracked_agent_surface,
      "product_absent": not product_materialized,
      "unexpected_absent": not unexpected, "tracked_classified": not unclassified,
      "role_controller": role == "controller", "generation_current": generation == policy["generation"]["package_version"],
      "policy_identity_current": persisted_identity == expected_identity["sparse_patterns_sha256"],
    }
    return {"root": str(root), "branch_ref": branch, "head": head, "git_common_dir": common,
            "policy_identity": expected_identity, "generation": generation, "workspace_role": role,
            "checks": checks, "required_missing": required_missing, "product_materialized": product_materialized,
            "unexpected_materialized": unexpected, "unclassified_tracked": unclassified,
            "tracked_agent_surface": tracked_agent_surface, "missing_root_agent_ignores": missing_root_ignores,
            "unsafe_untracked": unsafe_untracked,
            "local_ignored_untracked": sorted(set(untracked) - set(unsafe_untracked)), "class_counts": classifications,
            "passed": all(checks.values())}

def create(args: argparse.Namespace, policy: dict[str, Any]) -> dict[str, Any]:
    repository = args.repository.resolve(); destination = args.path.resolve()
    expected = git(repository, "rev-parse", f"{args.controller_ref}^{{commit}}", check=False)
    if expected != args.expected_head: raise WorkspaceError("controller ref does not match expected HEAD")
    if destination.exists(): raise WorkspaceError("fresh sparse controller destination already exists")
    rollback = args.rollback_controller.resolve()
    if Path(git(rollback, "rev-parse", "--show-toplevel", check=False) or "/missing").resolve() != rollback:
        raise WorkspaceError("rollback controller is not an exact worktree")
    try:
        run(["git", "-C", str(repository), "worktree", "add", "--detach", "--no-checkout", str(destination), expected], repository)
        configure(destination, policy, expected)
        evidence = inspect(destination, policy, require_branch=False)
        # Prepared worktrees are detached until the expected-identity registration cutover.
        allowed_fail = {"named_controller_branch"}
        if any(not ok for name, ok in evidence["checks"].items() if name not in allowed_fail):
            raise WorkspaceError("fresh sparse controller verification failed")
    except Exception:
        if destination.exists() and git(destination, "status", "--porcelain", check=False) == "":
            run(["git", "-C", str(repository), "worktree", "remove", "--force", str(destination)], repository, False)
        raise
    payload = {"schema_version": RECEIPT_SCHEMA, "operation": "create", "outcome": "prepared",
               "controller_ref": args.controller_ref, "expected_head": expected, "registration_source": args.registration_source,
               "rollback_controller": str(rollback), "prepared_controller": str(destination), "policy": policy_identity(policy),
               "evidence": evidence, "cutover_required": True}
    atomic_receipt(args.output, payload); return payload

def cutover_plan(args: argparse.Namespace, policy: dict[str, Any], rollback: bool = False) -> dict[str, Any]:
    old = args.old_controller.resolve(); new = args.new_controller.resolve()
    common_old = git(old, "rev-parse", "--path-format=absolute", "--git-common-dir")
    common_new = git(new, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common_old != common_new: raise WorkspaceError("controllers are not linked to one repository")
    ref = policy["controller_branch"]; ref_head = git(old, "rev-parse", f"{ref}^{{commit}}")
    if ref_head != args.expected_head: raise WorkspaceError("expected controller HEAD changed")
    product_ref = args.product_ref; product_head = git(old, "rev-parse", f"{product_ref}^{{commit}}")
    if product_head != args.expected_product_head: raise WorkspaceError("product target changed")
    operation = "rollback-plan" if rollback else "cutover-plan"
    source, target = (new, old) if rollback else (old, new)
    payload = {"schema_version": RECEIPT_SCHEMA, "operation": operation, "outcome": "planned_no_mutation",
      "expected_controller_head": ref_head, "controller_ref": ref, "expected_product_head": product_head,
      "product_ref": product_ref, "source_controller": str(source), "target_controller": str(target),
      "git_common_dir": common_old, "policy": policy_identity(policy),
      "steps": ["freeze controller writers", "verify source identity and clean state", "detach source from controller ref",
                "attach target to exact controller ref", "verify canonical sparse policy and generation" if not rollback else "restore prior full-controller registration and generation",
                "switch registration by expected source identity", "read back controller and product refs"],
      "preserves_history": True, "deletes_worktree": False}
    atomic_receipt(args.output, payload); return payload

def dispatch_preflight(args: argparse.Namespace, policy: dict[str, Any]) -> dict[str, Any]:
    task_root = args.task_root.resolve(); cwd = args.cwd.resolve(); role = git(task_root, "config", "--worktree", "--get", "juno.workspace.role", check=False)
    checks = {"explicit_root": args.explicit, "root_exact": Path(git(task_root, "rev-parse", "--show-toplevel", check=False) or "/missing").resolve() == task_root,
              "role_allowed": role in args.allow_role, "full_checkout": (bool_config(task_root, "core.sparseCheckout", True) is not True)
                  if args.operation in {"candidate", "review", "integration", "release"} else True,
              "clean_when_required": (not args.require_clean) or git(task_root, "status", "--porcelain=v2", "--untracked-files=all", check=False) == "",
              "not_controller_cwd": task_root != cwd or role == "task"}
    if args.operation in {"edit", "build", "test", "commit", "candidate"}: checks["task_role"] = role == "task"
    if args.operation == "release": checks["integration_owner_role"] = role == "integration-owner"
    payload = {"schema_version": RECEIPT_SCHEMA, "operation": "dispatch-preflight", "managed_operation": args.operation,
               "task_root": str(task_root), "workspace_role": role, "checks": checks, "passed": all(checks.values())}
    atomic_receipt(args.output, payload)
    if not payload["passed"]: raise WorkspaceError("managed product dispatch refused before launch")
    return payload

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--policy", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify"); verify.add_argument("--root", type=Path, required=True); verify.add_argument("--output", type=Path, required=True)
    classify_p = sub.add_parser("classify"); classify_p.add_argument("paths", nargs="+")
    create_p = sub.add_parser("create"); create_p.add_argument("--repository", type=Path, required=True); create_p.add_argument("--path", type=Path, required=True); create_p.add_argument("--controller-ref", required=True); create_p.add_argument("--expected-head", required=True); create_p.add_argument("--registration-source", required=True); create_p.add_argument("--rollback-controller", type=Path, required=True); create_p.add_argument("--output", type=Path, required=True)
    for name in ("cutover-plan", "rollback-plan"):
        p = sub.add_parser(name); p.add_argument("--old-controller", type=Path, required=True); p.add_argument("--new-controller", type=Path, required=True); p.add_argument("--expected-head", required=True); p.add_argument("--product-ref", required=True); p.add_argument("--expected-product-head", required=True); p.add_argument("--output", type=Path, required=True)
    dispatch = sub.add_parser("dispatch-preflight"); dispatch.add_argument("--task-root", type=Path, required=True); dispatch.add_argument("--cwd", type=Path, default=Path.cwd()); dispatch.add_argument("--operation", choices=["edit", "build", "test", "commit", "candidate", "review", "integration", "release"], required=True); dispatch.add_argument("--allow-role", action="append", choices=["task", "integration-owner"], default=[]); dispatch.add_argument("--require-clean", action="store_true"); dispatch.add_argument("--explicit", action="store_true"); dispatch.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(); policy_path = (args.policy or Path(__file__).resolve().parents[1] / "config/controller-workspace.json").resolve(); policy = load_policy(policy_path)
    if args.command == "verify":
        payload = {"schema_version": RECEIPT_SCHEMA, "operation": "verify", **inspect(args.root, policy)}; atomic_receipt(args.output, payload)
        if not payload["passed"]: raise WorkspaceError("sparse controller verification refused")
    elif args.command == "classify": print(json.dumps({path: classify(policy, path) for path in args.paths}, sort_keys=True))
    elif args.command == "create": payload = create(args, policy); print(json.dumps({"outcome": payload["outcome"], "receipt": str(args.output.resolve())}, sort_keys=True))
    elif args.command == "cutover-plan": payload = cutover_plan(args, policy); print(json.dumps({"outcome": payload["outcome"]}, sort_keys=True))
    elif args.command == "rollback-plan": payload = cutover_plan(args, policy, True); print(json.dumps({"outcome": payload["outcome"]}, sort_keys=True))
    elif args.command == "dispatch-preflight": dispatch_preflight(args, policy); print(json.dumps({"passed": True}, sort_keys=True))

if __name__ == "__main__":
    try: main()
    except (WorkspaceError, OSError, json.JSONDecodeError) as exc:
        print(f"controller-workspace: {exc}", file=sys.stderr); raise SystemExit(2)
