#!/usr/bin/env python3
"""Plan and prepare a metadata-only controller without moving live refs.

The helper creates a new, unrelated root commit and linked worktree.  It never
changes controller registration, the product target, or the rollback worktree.
Cutover and rollback are receipts only and require a separate owner-authorized
registrar.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

os.environ.setdefault("GIT_OPTIONAL_LOCKS", "0")
SCHEMA = "juno_metadata_controller_policy.v1"
PLAN_SCHEMA = "juno_metadata_controller_plan.v1"
RECEIPT_SCHEMA = "juno_metadata_controller_receipt.v1"
SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")
VERSION_RE = re.compile(r"(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+)(?![-+0-9A-Za-z.])")


class BoundaryError(RuntimeError):
    pass


def run(argv: list[str], cwd: Path, check: bool = True, *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, env={**os.environ, **(env or {})})
    if check and result.returncode:
        raise BoundaryError(result.stderr.strip() or result.stdout.strip() or f"command failed: {argv}")
    return result


def git(root: Path, *args: str, check: bool = True, env: dict[str, str] | None = None) -> str:
    return run(["git", "-C", str(root), *args], root, check, env=env).stdout.strip()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reviewed_path(path: Path, label: str) -> Path:
    try:
        resolved = path.expanduser().resolve(strict=True)
    except OSError as exc:
        raise BoundaryError(f"{label} does not resolve to a reviewed file: {exc}") from exc
    if not resolved.is_file():
        raise BoundaryError(f"{label} is not a regular file: {resolved}")
    return resolved


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BoundaryError(f"invalid {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise BoundaryError(f"{label} must be a JSON object")
    return value


def load_sibling(name: str) -> Any:
    path = Path(__file__).resolve().with_name(name)
    spec = importlib.util.spec_from_file_location(f"juno_metadata_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise BoundaryError(f"cannot load packaged policy validator: {name}")
    module = importlib.util.module_from_spec(spec)
    scripts = str(path.parent)
    sys.path.insert(0, scripts)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(scripts)
    return module


def validate_task_policy(value: dict[str, Any]) -> dict[str, Any]:
    validator = load_sibling("task_workspace.py")
    with tempfile.TemporaryDirectory(prefix="juno-task-policy-") as temporary:
        root = Path(temporary)
        path = root / ".juno_task/config/task-workspace.json"
        path.parent.mkdir(parents=True)
        path.write_bytes(canonical(value))
        try:
            return validator.load_config(root)
        except Exception as exc:
            raise BoundaryError(f"invalid reviewed task workspace policy: {exc}") from exc


def validate_risk_policy(value: dict[str, Any]) -> dict[str, Any]:
    validator = load_sibling("risk_policy.py")
    with tempfile.TemporaryDirectory(prefix="juno-risk-policy-") as temporary:
        path = Path(temporary) / "risk-policy.json"
        path.write_bytes(canonical(value))
        try:
            return validator.load_policy(path)
        except Exception as exc:
            raise BoundaryError(f"invalid reviewed risk policy: {exc}") from exc


def validate_integration_policy(value: dict[str, Any], task_policy: dict[str, Any]) -> dict[str, Any]:
    validator = load_sibling("integration_workspace.py")
    with tempfile.TemporaryDirectory(prefix="juno-integration-policy-") as temporary:
        root = Path(temporary); config = root / ".juno_task/config"; config.mkdir(parents=True)
        (config / "integration-workspace.json").write_bytes(canonical(value))
        (config / "task-workspace.json").write_bytes(canonical(task_policy))
        try:
            policy, _, _ = validator.load_policy(root)
            return policy
        except Exception as exc:
            raise BoundaryError(f"invalid reviewed integration workspace policy: {exc}") from exc


def reviewed_policies_from_sources(
        *, metadata_policy: dict[str, Any], policy_bundle: Path | None = None,
        task_policy: Path | None = None, integration_policy: Path | None = None,
        risk_policy: Path | None = None) -> dict[str, Any]:
    if policy_bundle is not None:
        if task_policy is not None or integration_policy is not None or risk_policy is not None:
            raise BoundaryError("use either --policy-bundle or all explicit policy paths, not both")
        bundle_path = reviewed_path(policy_bundle, "policy bundle")
        bundle = read_json(bundle_path, "policy bundle")
        if (bundle.get("schema_version") != "juno_migration_policy_bundle.v1"
                or bundle.get("operation") != "generate-policy"
                or bundle.get("outcome") != "generated_from_reviewed_answers"
                or not isinstance(bundle.get("policies"), dict)):
            raise BoundaryError("policy bundle is not a reviewed Juno migration policy bundle")
        policies = bundle["policies"]
        if set(policies) != {"metadata_controller", "task_workspace", "integration_workspace", "risk"}:
            raise BoundaryError("policy bundle must contain exactly metadata_controller, task_workspace, integration_workspace, and risk")
        if digest(metadata_policy_from_bundle(bundle_path)) != digest(metadata_policy):
            raise BoundaryError("policy bundle metadata controller policy differs from --policy")
        task_value = validate_task_policy(load_policy_value(policies["task_workspace"]))
        integration_value = validate_integration_policy(
            load_policy_value(policies["integration_workspace"]), task_value)
        risk_value = validate_risk_policy(load_policy_value(policies["risk"]))
        source = {"kind": "policy_bundle", "path": str(bundle_path), "sha256": file_digest(bundle_path)}
    else:
        if task_policy is None or integration_policy is None or risk_policy is None:
            raise BoundaryError("migration-plan requires --policy-bundle or all three workspace/risk policy paths")
        task_path = reviewed_path(task_policy, "task workspace policy")
        integration_path = reviewed_path(integration_policy, "integration workspace policy")
        risk_path = reviewed_path(risk_policy, "risk policy")
        task_value = validate_task_policy(read_json(task_path, "task workspace policy"))
        integration_value = validate_integration_policy(
            read_json(integration_path, "integration workspace policy"), task_value)
        risk_value = validate_risk_policy(read_json(risk_path, "risk policy"))
        source = {"kind": "explicit_paths", "task_workspace_path": str(task_path),
                  "task_workspace_file_sha256": file_digest(task_path),
                  "integration_workspace_path": str(integration_path),
                  "integration_workspace_file_sha256": file_digest(integration_path),
                  "risk_path": str(risk_path),
                  "risk_file_sha256": file_digest(risk_path)}
    return {"source": source, "metadata_controller_sha256": digest(metadata_policy),
            "task_workspace": {"sha256": digest(task_value), "content": task_value},
            "integration_workspace": {"sha256": digest(integration_value), "content": integration_value},
            "risk": {"sha256": digest(risk_value), "content": risk_value}}


def load_policy_value(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BoundaryError("reviewed policy content must be a JSON object")
    return json.loads(json.dumps(value))


def revalidate_planned_policies(plan: dict[str, Any], metadata_policy: dict[str, Any]) -> dict[str, Any]:
    expected = plan.get("reviewed_policies")
    if not isinstance(expected, dict) or not isinstance(expected.get("source"), dict):
        raise BoundaryError("migration plan does not bind reviewed task and risk policies")
    source = expected["source"]
    if source.get("kind") == "policy_bundle":
        actual = reviewed_policies_from_sources(metadata_policy=metadata_policy,
                                                policy_bundle=Path(source["path"]))
    elif source.get("kind") == "explicit_paths":
        actual = reviewed_policies_from_sources(
            metadata_policy=metadata_policy, task_policy=Path(source["task_workspace_path"]),
            integration_policy=Path(source["integration_workspace_path"]),
            risk_policy=Path(source["risk_path"]))
    else:
        raise BoundaryError("migration plan has an unsupported reviewed policy source")
    if digest(actual) != digest(expected):
        raise BoundaryError("reviewed task workspace or risk policy changed after planning")
    return expected


def atomic_receipt(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = canonical(value)
    if path.exists() and path.read_bytes() != data:
        raise BoundaryError(f"immutable receipt collision: {path}")
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def preflight_receipt(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    if path.exists() and path.read_bytes() != canonical(value):
        raise BoundaryError(f"immutable receipt collision: {path}")


def safe_relative(value: Any) -> str:
    if not isinstance(value, str) or value != value.strip() or not value:
        raise BoundaryError("policy paths must be non-empty normalized strings")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or value in {".", ".git"} or ".." in path.parts or ".git" in path.parts:
        raise BoundaryError(f"unsafe policy path: {value!r}")
    return value.rstrip("/")


def safe_ref(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.startswith("refs/heads/"):
        raise BoundaryError(f"{label} must be a full local branch ref")
    if run(["git", "check-ref-format", value], Path.cwd(), False).returncode:
        raise BoundaryError(f"unsafe {label}: {value!r}")
    return value


def load_policy(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise BoundaryError(f"invalid metadata controller policy: {exc}") from exc
    required = {"schema_version", "controller_branch", "product_ref", "spec_copy_mode", "copied_metadata", "generated_metadata", "product_forbidden", "tracked_exact", "tracked_recursive", "tracked_top_level_files", "runtime"}
    if not isinstance(value, dict) or set(value) != required or value.get("schema_version") != SCHEMA:
        raise BoundaryError(f"policy must contain exactly the {SCHEMA} fields")
    value["controller_branch"] = safe_ref(value["controller_branch"], "controller_branch")
    value["product_ref"] = safe_ref(value["product_ref"], "product_ref")
    if value["spec_copy_mode"] != "top_level_files_only":
        raise BoundaryError("spec_copy_mode must exclude nested workflow and lifecycle evidence")
    for field in ("copied_metadata", "generated_metadata", "product_forbidden", "tracked_exact", "tracked_recursive", "tracked_top_level_files"):
        items = value[field]
        if not isinstance(items, list) or not items:
            raise BoundaryError(f"{field} must be a non-empty array")
        normalized = sorted(safe_relative(item) for item in items)
        if len(normalized) != len(set(normalized)):
            raise BoundaryError(f"{field} contains duplicates")
        value[field] = normalized
    runtime = value["runtime"]
    if not isinstance(runtime, dict) or set(runtime) != {"package", "identity_file", "ignored_roots"} or runtime.get("package") != "juno-code":
        raise BoundaryError("invalid runtime policy")
    runtime["identity_file"] = safe_relative(runtime["identity_file"])
    runtime["ignored_roots"] = sorted(safe_relative(item) for item in runtime["ignored_roots"])
    for item in value["copied_metadata"] + value["generated_metadata"]:
        if not policy_path_allowed(item, value, container=True):
            raise BoundaryError(f"metadata path is outside tracked roots: {item}")
    return value


def metadata_policy_from_bundle(path: Path) -> dict[str, Any]:
    bundle_path = reviewed_path(path, "policy bundle")
    bundle = read_json(bundle_path, "policy bundle")
    policies = bundle.get("policies")
    if not isinstance(policies, dict) or not isinstance(policies.get("metadata_controller"), dict):
        raise BoundaryError("policy bundle does not contain a metadata controller policy")
    with tempfile.TemporaryDirectory(prefix="juno-metadata-policy-") as temporary:
        policy_path = Path(temporary) / "metadata-controller.json"
        policy_path.write_bytes(canonical(policies["metadata_controller"]))
        return load_policy(policy_path)


def policy_from_plan_bundle(path: Path) -> dict[str, Any] | None:
    plan = read_json(path.expanduser().resolve(), "migration plan")
    reviewed = plan.get("reviewed_policies")
    source = reviewed.get("source") if isinstance(reviewed, dict) else None
    if not isinstance(source, dict) or source.get("kind") != "policy_bundle":
        return None
    bundle_path = source.get("path")
    if not isinstance(bundle_path, str) or not bundle_path:
        raise BoundaryError("migration plan has an invalid reviewed policy bundle path")
    return metadata_policy_from_bundle(Path(bundle_path))


def ref_exists(root: Path, ref: str) -> bool:
    return run(["git", "-C", str(root), "show-ref", "--verify", "--quiet", ref], root, False).returncode == 0


def common_dir(root: Path) -> str:
    return str(Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve())


def exact_worktree(root: Path) -> Path:
    root = root.expanduser().resolve()
    actual = git(root, "rev-parse", "--show-toplevel", check=False)
    if not actual or Path(actual).resolve() != root:
        raise BoundaryError(f"not an exact Git worktree: {root}")
    return root


def resolve_commit(root: Path, ref: str, expected: str, label: str) -> str:
    actual = git(root, "rev-parse", f"{ref}^{{commit}}", check=False)
    if actual != expected or not SHA_RE.fullmatch(expected):
        raise BoundaryError(f"{label} changed: expected {expected}, found {actual or '<missing>'}")
    return actual


def runtime_identity(executable: Path, expected_version: str, repository: Path) -> dict[str, str]:
    executable = executable.expanduser().resolve()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", expected_version):
        raise BoundaryError("runtime version must be an exact released semantic version")
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise BoundaryError(f"runtime executable is not executable: {executable}")
    # A released installation must not resolve into this repository, any of its
    # linked worktrees, its administration directory, or another Git checkout.
    repo = repository.resolve()
    prohibited = {repo, Path(common_dir(repo)).resolve()}
    listing = run(["git", "-C", str(repo), "worktree", "list", "--porcelain", "-z"], repo)
    for record in listing.stdout.split("\0"):
        if record.startswith("worktree "):
            prohibited.add(Path(record.removeprefix("worktree ")).resolve())
    for root in prohibited:
        try:
            executable.relative_to(root)
        except ValueError:
            continue
        raise BoundaryError("runtime executable must be an installed distribution outside every linked worktree and Git administration directory")
    containing_repo = git(executable.parent, "rev-parse", "--show-toplevel", check=False)
    if containing_repo:
        raise BoundaryError("runtime executable must not come from a mutable Git worktree")
    result = run([str(executable), "--version"], executable.parent, False)
    match = VERSION_RE.search(result.stdout + "\n" + result.stderr)
    if result.returncode or not match or match.group(1) != expected_version:
        raise BoundaryError(f"runtime identity mismatch: expected juno-code {expected_version}")
    return {"package": "juno-code", "version": expected_version, "executable": str(executable),
            "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest()}


def install_runtime_scripts(executable: Path, controller: Path) -> dict[str, Any]:
    source = executable.expanduser().resolve().parent.parent / "templates/scripts"
    target = controller / ".juno_task/scripts"
    if not source.is_dir():
        raise BoundaryError(f"installed runtime is missing packaged controller scripts: {source}")
    if target.exists() or target.is_symlink():
        raise BoundaryError("fresh controller runtime script directory must not already exist")
    entries: list[dict[str, str]] = []
    for item in sorted(source.rglob("*")):
        if item.is_symlink():
            raise BoundaryError(f"packaged runtime scripts may not contain symlinks: {item}")
        if item.is_dir():
            continue
        if not item.is_file():
            raise BoundaryError(f"packaged runtime contains an unsafe script entry: {item}")
        entries.append({"path": item.relative_to(source).as_posix(),
                        "sha256": hashlib.sha256(item.read_bytes()).hexdigest()})
    if not entries or not any(entry["path"] == "controller_resolver.py" for entry in entries):
        raise BoundaryError("installed runtime script set is incomplete")
    shutil.copytree(source, target, copy_function=shutil.copy2)
    return {"source": str(source), "file_count": len(entries), "sha256": digest(entries)}


def listed_tree(root: Path, head: str) -> list[tuple[str, str, str]]:
    raw = git(root, "ls-tree", "-r", "-z", head)
    entries: list[tuple[str, str, str]] = []
    for record in raw.split("\0"):
        if not record:
            continue
        metadata, name = record.split("\t", 1)
        mode, kind, oid = metadata.split()
        if kind != "blob":
            continue
        entries.append((mode, oid, name))
    return entries


def copied_allowed(name: str, policy: dict[str, Any]) -> bool:
    if not any(name == prefix or name.startswith(prefix + "/") for prefix in policy["copied_metadata"]):
        return False
    if name.startswith(".juno_task/specs/") and policy["spec_copy_mode"] == "top_level_files_only":
        return "/" not in name.removeprefix(".juno_task/specs/")
    return True


def selected_entries(root: Path, head: str, policy: dict[str, Any]) -> list[tuple[str, str, str]]:
    selected = []
    for mode, oid, name in listed_tree(root, head):
        if copied_allowed(name, policy):
            if mode not in {"100644", "100755"}:
                raise BoundaryError(f"metadata may not contain symlinks or gitlinks: {name}")
            selected.append((mode, oid, name))
    required = (".juno_task/tasks", ".juno_task/ledger", ".juno_task/specs")
    for prefix in required:
        if not any(name == prefix or name.startswith(prefix + "/") for _, _, name in selected):
            raise BoundaryError(f"source controller is missing canonical metadata: {prefix}")
    return selected


def inventory(old: Path, old_head: str, product_head: str, policy: dict[str, Any], runtime: dict[str, str]) -> dict[str, Any]:
    entries = listed_tree(old, old_head)
    names = [name for _, _, name in entries]
    selected = [name for name in names if copied_allowed(name, policy)]
    categories = {
        "controller_data": [name for name in selected if name.startswith((".juno_task/tasks", ".juno_task/ledger"))],
        "task_specs": [name for name in selected if name.startswith(".juno_task/specs")],
        "minimal_project_configuration": [name for name in names if name in {".juno_task/config.json", ".gitignore"} or name.startswith(".juno_task/config/")],
        "product_documentation": [name for name in names if name == "README.md" or name.startswith(("docs/", "juno-code/docs/", "frontend/"))],
        "historical_evidence": [name for name in names if name.startswith((".juno_task/workflows", ".juno_task/artifacts", ".juno_task/logs"))
                                or (name.startswith(".juno_task/specs/") and not copied_allowed(name, policy))],
    }
    ignored = run(["git", "-C", str(old), "status", "--ignored", "--porcelain=v1", "-z"], old, False).stdout.split("\0")
    ignored_names = sorted(item[3:] for item in ignored if item.startswith("!! "))
    return {"old_controller_head": old_head, "product_head": product_head, "tracked_count": len(names),
            "copied_count": len(selected), "categories": {key: {"count": len(paths), "paths": paths} for key, paths in categories.items()},
            "installed_runtime": runtime, "local_ignored": ignored_names,
            "excluded_from_metadata_branch_count": len(set(names) - set(selected))}


def migration_plan(args: argparse.Namespace, policy: dict[str, Any]) -> dict[str, Any]:
    old = exact_worktree(args.old_controller)
    if git(old, "status", "--porcelain=v2", "--untracked-files=all"):
        raise BoundaryError("old controller must be clean before inventory freeze")
    if git(old, "symbolic-ref", "-q", "HEAD", check=False) != args.old_branch:
        raise BoundaryError("old controller worktree is not attached to the exact rollback branch")
    if args.new_branch != policy["controller_branch"] or args.product_ref != policy["product_ref"]:
        raise BoundaryError("requested controller/product refs do not match the reviewed policy")
    old_head = resolve_commit(old, args.old_branch, args.expected_old_head, "old controller ref")
    product_head = resolve_commit(old, args.product_ref, args.expected_product_head, "product target")
    if ref_exists(old, args.new_branch):
        raise BoundaryError("fresh metadata controller branch already exists")
    if args.new_controller.expanduser().resolve().exists():
        raise BoundaryError("fresh metadata controller path already exists")
    runtime = runtime_identity(args.runtime, args.runtime_version, old)
    reviewed_policies = reviewed_policies_from_sources(
        metadata_policy=policy, policy_bundle=args.policy_bundle,
        task_policy=args.task_workspace_policy, integration_policy=args.integration_workspace_policy,
        risk_policy=args.risk_policy)
    selected_entries(old, old_head, policy)
    payload = {"schema_version": PLAN_SCHEMA, "operation": "migration-plan", "outcome": "planned_no_mutation",
               "old_controller": str(old), "old_branch": args.old_branch, "old_head": old_head,
               "new_controller": str(args.new_controller.expanduser().resolve()), "new_branch": args.new_branch,
               "product_ref": args.product_ref, "product_head": product_head, "git_common_dir": common_dir(old),
               "runtime": runtime, "policy_sha256": digest(policy), "reviewed_policies": reviewed_policies,
               "inventory": inventory(old, old_head, product_head, policy, runtime),
               "cutover_authorized": False, "rollback": {"controller": str(old), "branch": args.old_branch, "head": old_head},
               "steps": ["freeze old controller identity", "prepare unrelated metadata-only root and worktree",
                         "install generated local runtime", "run canaries", "request owner-authorized registration cutover"],
               "forbidden": ["move product target", "switch live registration", "delete rollback controller", "push", "release"]}
    atomic_receipt(args.output, payload)
    return payload


def read_plan(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise BoundaryError(f"invalid migration plan: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != PLAN_SCHEMA or value.get("outcome") != "planned_no_mutation":
        raise BoundaryError("prepare requires a canonical no-mutation migration plan")
    return value


def add_blob(root: Path, index_env: dict[str, str], path: str, data: bytes, mode: str = "100644") -> None:
    result = subprocess.run(["git", "-C", str(root), "hash-object", "-w", "--stdin"], input=data,
                            capture_output=True, env={**os.environ, **index_env})
    if result.returncode:
        raise BoundaryError(result.stderr.decode().strip())
    oid = result.stdout.decode().strip()
    git(root, "update-index", "--add", "--cacheinfo", f"{mode},{oid},{path}", env=index_env)


def prepare(args: argparse.Namespace, policy: dict[str, Any]) -> dict[str, Any]:
    plan = read_plan(args.plan.resolve())
    if args.output.expanduser().resolve().exists():
        raise BoundaryError("prepare receipt path must be fresh before mutation")
    old = exact_worktree(Path(plan["old_controller"]))
    resolve_commit(old, plan["old_branch"], plan["old_head"], "old controller ref")
    resolve_commit(old, plan["product_ref"], plan["product_head"], "product target")
    if plan["policy_sha256"] != digest(policy):
        raise BoundaryError("metadata policy changed after planning")
    reviewed_policies = revalidate_planned_policies(plan, policy)
    runtime_identity(Path(plan["runtime"]["executable"]), plan["runtime"]["version"], old)
    destination = Path(plan["new_controller"])
    if plan["new_branch"] != policy["controller_branch"] or plan["product_ref"] != policy["product_ref"]:
        raise BoundaryError("migration plan refs no longer match the reviewed policy")
    if destination.exists() or ref_exists(old, plan["new_branch"]):
        raise BoundaryError("metadata destination or branch is no longer fresh")
    entries = selected_entries(old, plan["old_head"], policy)
    preserved_entries = [{"mode": mode, "oid": oid, "path": name} for mode, oid, name in entries]
    boundary = {"schema_version": RECEIPT_SCHEMA, "operation": "controller-boundary", "source_head": plan["old_head"],
                "product_ref": plan["product_ref"], "product_head_at_plan": plan["product_head"],
                "runtime": {"package": "juno-code", "version": plan["runtime"]["version"]},
                "policy_sha256": plan["policy_sha256"],
                "reviewed_policy_sha256": {
                    "task_workspace": reviewed_policies["task_workspace"]["sha256"],
                    "integration_workspace": reviewed_policies["integration_workspace"]["sha256"],
                    "risk": reviewed_policies["risk"]["sha256"],
                }, "controller_commits_integrate_to_product": False,
                "preserved_metadata": {"entries": preserved_entries, "sha256": digest(preserved_entries)}}
    task_policy_bytes = canonical(reviewed_policies["task_workspace"]["content"])
    integration_policy_bytes = canonical(reviewed_policies["integration_workspace"]["content"])
    risk_policy_bytes = canonical(reviewed_policies["risk"]["content"])
    generated = {
        ".gitignore": b".env.juno\n.venv_juno/\n.juno_task/runtime/\n.juno_task/scripts/\n.juno_task/tmp/\n.juno_task/cache/\n.juno_task/locks/\n/AGENTS.md\n/CLAUDE.md\n/.agents/\n/.claude/\n/.pi/\n*.log\n__pycache__/\n",
        ".juno_task/config.json": canonical({"controllerWorkspace": {"mode": "metadata-only", "policy": ".juno_task/config/metadata-controller.json"}}),
        ".juno_task/config/metadata-controller.json": canonical(policy),
        ".juno_task/config/task-workspace.json": task_policy_bytes,
        ".juno_task/config/integration-workspace.json": integration_policy_bytes,
        ".juno_task/config/risk-policy.json": risk_policy_bytes,
        ".juno_task/receipts/controller-boundary.json": canonical(boundary),
        ".juno_task/state/tasks.json": canonical({"schema_version": "juno_task_workspace_state.v1", "tasks": {}, "queues": {}}),
    }
    with tempfile.TemporaryDirectory(prefix="juno-metadata-index-") as temporary:
        index_env = {"GIT_INDEX_FILE": str(Path(temporary) / "index")}
        git(old, "read-tree", "--empty", env=index_env)
        for mode, oid, name in entries:
            git(old, "update-index", "--add", "--cacheinfo", f"{mode},{oid},{name}", env=index_env)
        for name, data in generated.items():
            add_blob(old, index_env, name, data)
        tree = git(old, "write-tree", env=index_env)
    identity = {"package": "juno-code", "version": plan["runtime"]["version"], "executable": plan["runtime"]["executable"],
                "executable_sha256": plan["runtime"]["executable_sha256"], "source": "installed-release", "tracked": False}
    commit_env = {"GIT_AUTHOR_NAME": "Juno Controller Migration", "GIT_AUTHOR_EMAIL": "juno-controller@local.invalid",
                  "GIT_COMMITTER_NAME": "Juno Controller Migration", "GIT_COMMITTER_EMAIL": "juno-controller@local.invalid"}
    commit = run(["git", "-C", str(old), "commit-tree", tree, "-m", "Initialize metadata-only controller"],
                 old, env=commit_env).stdout.strip()
    created = False
    try:
        branch_name = plan["new_branch"].removeprefix("refs/heads/")
        run(["git", "-C", str(old), "worktree", "add", "-b", branch_name, str(destination), commit], old)
        created = True
        # The repository may still carry the retired full-tree controller's
        # sparse-checkout setting.  This branch is already metadata-only, so
        # materialize its complete small tree and remove that hidden state.
        git(destination, "sparse-checkout", "disable")
        git(destination, "config", "extensions.worktreeConfig", "true")
        git(destination, "config", "--worktree", "juno.workspace.role", "controller-pending")
        git(destination, "config", "--worktree", "juno.controller.mode", "metadata-only")
        git(destination, "config", "--worktree", "juno.controller.runtimeVersion", identity["version"])
        git(destination, "config", "--worktree", "juno.controller.runtimeExecutable", identity["executable"])
        runtime_file = destination / policy["runtime"]["identity_file"]
        runtime_file.parent.mkdir(parents=True, exist_ok=True)
        runtime_file.write_bytes(canonical(identity))
        runtime_scripts = install_runtime_scripts(Path(identity["executable"]), destination)
        evidence = inspect(destination, policy, expected_branch=plan["new_branch"], require_active=False)
        if not evidence["passed"]:
            raise BoundaryError(f"prepared metadata controller failed verification: {evidence['checks']}")
    except Exception:
        if created:
            run(["git", "-C", str(old), "worktree", "remove", "--force", str(destination)], old, False)
            run(["git", "-C", str(old), "branch", "-D", plan["new_branch"].removeprefix("refs/heads/")], old, False)
        raise
    payload = {"schema_version": RECEIPT_SCHEMA, "operation": "prepare", "outcome": "prepared_not_registered",
               "plan_sha256": hashlib.sha256(args.plan.resolve().read_bytes()).hexdigest(), "new_controller": str(destination),
               "new_branch": plan["new_branch"], "new_head": commit, "new_tree": tree, "root_commit": True,
               "old_controller_preserved": True, "product_head": plan["product_head"], "evidence": evidence,
               "runtime_scripts": runtime_scripts,
               "cutover_authorized": False}
    atomic_receipt(args.output, payload)
    return payload


def policy_path_allowed(name: str, policy: dict[str, Any], *, container: bool = False) -> bool:
    if name in policy["tracked_exact"]:
        return True
    if any(name == root or name.startswith(root + "/") for root in policy["tracked_recursive"]):
        return True
    for root in policy["tracked_top_level_files"]:
        if name == root:
            return container
        if name.startswith(root + "/"):
            return "/" not in name.removeprefix(root + "/")
    return False


def tracked_allowed(name: str, policy: dict[str, Any]) -> bool:
    return policy_path_allowed(name, policy)


def product_boundary(root: Path, product_ref: str, expected_head: str, policy: dict[str, Any]) -> dict[str, Any]:
    root = exact_worktree(root)
    if product_ref != policy["product_ref"]:
        raise BoundaryError("product ref does not match the reviewed policy")
    head = resolve_commit(root, product_ref, expected_head, "product target")
    names = [name for _, _, name in listed_tree(root, head)]
    forbidden = [name for name in names if any(name == prefix or name.startswith(prefix + "/") for prefix in policy["product_forbidden"])]
    return {"product_ref": product_ref, "product_head": head, "forbidden_controller_paths": forbidden,
            "passed": not forbidden}


def inspect(root: Path, policy: dict[str, Any], *, expected_branch: str | None = None, require_active: bool = True) -> dict[str, Any]:
    root = exact_worktree(root)
    branch = git(root, "symbolic-ref", "-q", "HEAD", check=False) or None
    head = git(root, "rev-parse", "HEAD")
    ancestry_roots = git(root, "rev-list", "--max-parents=0", head).splitlines()
    current_entries = listed_tree(root, head)
    names = [name for _, _, name in current_entries]
    unsafe_modes = [name for mode, _, name in current_entries if mode not in {"100644", "100755"}]
    forbidden = [name for name in names if not tracked_allowed(name, policy)]
    root_names = [name for _, _, name in listed_tree(root, ancestry_roots[0])] if len(ancestry_roots) == 1 else []
    forbidden_root = [name for name in root_names if not tracked_allowed(name, policy)]
    root_entry_map = {name: {"mode": mode, "oid": oid} for mode, oid, name in listed_tree(root, ancestry_roots[0])} if len(ancestry_roots) == 1 else {}
    boundary_path = ".juno_task/receipts/controller-boundary.json"
    root_boundary_text = run(["git", "-C", str(root), "show", f"{ancestry_roots[0]}:{boundary_path}"], root, False).stdout if len(ancestry_roots) == 1 else ""
    current_boundary_text = run(["git", "-C", str(root), "show", f"{head}:{boundary_path}"], root, False).stdout
    preservation_receipt_ok = False
    preservation_missing: list[str] = []
    reviewed_policy_hashes: dict[str, str] = {}
    try:
        boundary = json.loads(root_boundary_text)
        if boundary.get("schema_version") != RECEIPT_SCHEMA or boundary.get("operation") != "controller-boundary":
            raise ValueError("invalid boundary receipt identity")
        preservation = boundary["preserved_metadata"]
        expected_entries = preservation["entries"]
        if not isinstance(expected_entries, list) or preservation["sha256"] != digest(expected_entries):
            raise ValueError("invalid preserved metadata digest")
        reviewed_policy_hashes = boundary["reviewed_policy_sha256"]
        if (set(reviewed_policy_hashes) != {"task_workspace", "integration_workspace", "risk"}
                or any(not re.fullmatch(r"[0-9a-f]{64}", value)
                       for value in reviewed_policy_hashes.values())):
            raise ValueError("invalid reviewed policy identity")
        for entry in expected_entries:
            if set(entry) != {"mode", "oid", "path"} or root_entry_map.get(entry["path"]) != {"mode": entry["mode"], "oid": entry["oid"]}:
                preservation_missing.append(entry.get("path", "<invalid>"))
        preservation_receipt_ok = not preservation_missing
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        preservation_receipt_ok = False
    canonical_prefixes = (".juno_task/tasks", ".juno_task/ledger", ".juno_task/specs")
    missing_canonical = [prefix for prefix in canonical_prefixes if not any(name.startswith(prefix + "/") for name in names)]
    missing_generated = [name for name in policy["generated_metadata"] if name not in names]
    generated_contract_ok = False
    if not missing_generated:
        try:
            config_value = json.loads(run(["git", "-C", str(root), "show", f"{head}:.juno_task/config.json"], root).stdout)
            policy_text = run(["git", "-C", str(root), "show", f"{head}:.juno_task/config/metadata-controller.json"], root).stdout
            task_policy_text = run(["git", "-C", str(root), "show", f"{head}:.juno_task/config/task-workspace.json"], root).stdout
            integration_policy_text = run(["git", "-C", str(root), "show", f"{head}:.juno_task/config/integration-workspace.json"], root).stdout
            risk_policy_text = run(["git", "-C", str(root), "show", f"{head}:.juno_task/config/risk-policy.json"], root).stdout
            task_policy_value = validate_task_policy(json.loads(task_policy_text))
            integration_policy_value = validate_integration_policy(
                json.loads(integration_policy_text), task_policy_value)
            risk_policy_value = validate_risk_policy(json.loads(risk_policy_text))
            tasks_value = json.loads(run(["git", "-C", str(root), "show", f"{head}:.juno_task/state/tasks.json"], root).stdout)
            generated_contract_ok = (
                config_value == {"controllerWorkspace": {"mode": "metadata-only", "policy": ".juno_task/config/metadata-controller.json"}}
                and policy_text == canonical(policy).decode()
                and task_policy_text == canonical(task_policy_value).decode()
                and integration_policy_text == canonical(integration_policy_value).decode()
                and risk_policy_text == canonical(risk_policy_value).decode()
                and digest(task_policy_value) == reviewed_policy_hashes.get("task_workspace")
                and digest(integration_policy_value) == reviewed_policy_hashes.get("integration_workspace")
                and digest(risk_policy_value) == reviewed_policy_hashes.get("risk")
                and tasks_value.get("schema_version") == "juno_task_workspace_state.v1"
                and isinstance(tasks_value.get("tasks"), dict)
                and isinstance(tasks_value.get("queues"), dict)
                and current_boundary_text == root_boundary_text
            )
        except (BoundaryError, KeyError, TypeError, json.JSONDecodeError):
            generated_contract_ok = False
    product_markers = [name for name in names if name == "README.md" or name.startswith(("juno-code/", "juno_kanban/", "frontend/", "scripts/", ".github/"))]
    staged = git(root, "diff", "--cached", "--name-only", check=False).splitlines()
    role = git(root, "config", "--worktree", "--get", "juno.workspace.role", check=False)
    runtime_version = git(root, "config", "--worktree", "--get", "juno.controller.runtimeVersion", check=False)
    runtime_executable = git(root, "config", "--worktree", "--get", "juno.controller.runtimeExecutable", check=False)
    runtime_file = root / policy["runtime"]["identity_file"]
    runtime_ok = False
    if runtime_file.is_file():
        try:
            identity = json.loads(runtime_file.read_text())
            checked = runtime_identity(Path(runtime_executable), runtime_version, root)
            runtime_ok = identity == {**checked, "source": "installed-release", "tracked": False}
        except (BoundaryError, OSError, json.JSONDecodeError):
            runtime_ok = False
    checks = {"branch_exact": expected_branch is None or branch == expected_branch, "single_root_ancestry": len(ancestry_roots) == 1,
              "root_boundary": not forbidden_root,
              "root_preservation": preservation_receipt_ok,
              "canonical_metadata_present": not missing_canonical,
              "required_generated_present": not missing_generated,
              "generated_contract": generated_contract_ok,
              "tracked_boundary": not forbidden, "product_absent": not product_markers,
              "regular_files_only": not unsafe_modes,
              "staged_boundary": all(tracked_allowed(name, policy) for name in staged),
              "runtime_bound": runtime_ok, "runtime_untracked": policy["runtime"]["identity_file"] not in names,
              "role": role == ("controller" if require_active else "controller-pending"),
              "clean": git(root, "status", "--porcelain=v2", "--untracked-files=all", check=False) == ""}
    return {"root": str(root), "branch_ref": branch, "head": head, "root_commit": ancestry_roots[0] if len(ancestry_roots) == 1 else None,
            "tracked_paths": names, "forbidden_tracked": forbidden,
            "forbidden_root_tracked": forbidden_root, "product_markers": product_markers,
            "unsafe_tracked_modes": unsafe_modes,
            "missing_preserved_root_paths": preservation_missing, "missing_canonical_prefixes": missing_canonical,
            "missing_required_generated": missing_generated,
            "checks": checks, "passed": all(checks.values())}


def runtime_rebind(args: argparse.Namespace, policy: dict[str, Any]) -> dict[str, Any]:
    root = exact_worktree(args.root)
    expected_branch = safe_ref(args.branch, "branch")
    if git(root, "symbolic-ref", "-q", "HEAD", check=False) != expected_branch:
        raise BoundaryError("runtime rebind refused for wrong controller branch")
    if git(root, "config", "--worktree", "--get", "juno.controller.mode", check=False) != "metadata-only":
        raise BoundaryError("runtime rebind refused for non-metadata controller")
    if git(root, "status", "--porcelain=v2", "--untracked-files=all", check=False):
        raise BoundaryError("runtime rebind requires a clean metadata controller")
    output = args.output.expanduser().resolve()
    try:
        output.relative_to(root)
    except ValueError:
        pass
    else:
        raise BoundaryError("runtime rebind receipt must be outside the controller worktree")
    before_head = git(root, "rev-parse", "HEAD")
    before_tree = git(root, "write-tree")
    identity = runtime_identity(args.runtime, args.runtime_version, root)
    local_identity = {**identity, "source": "installed-release", "tracked": False}
    runtime_file = root / policy["runtime"]["identity_file"]
    payload = {"schema_version": RECEIPT_SCHEMA, "operation": "runtime-rebind", "outcome": "local_runtime_rebound",
               "root": str(root), "branch": expected_branch, "head": before_head, "tree": before_tree,
               "runtime": identity, "tracked_changes": False, "product_ref_mutation": False}
    preflight_receipt(output, payload)
    old_version_result = run(["git", "-C", str(root), "config", "--worktree", "--get", "juno.controller.runtimeVersion"], root, False)
    old_executable_result = run(["git", "-C", str(root), "config", "--worktree", "--get", "juno.controller.runtimeExecutable"], root, False)
    old_identity = runtime_file.read_bytes() if runtime_file.exists() else None

    def restore_config(key: str, previous: subprocess.CompletedProcess[str]) -> None:
        if previous.returncode == 0:
            git(root, "config", "--worktree", key, previous.stdout.rstrip("\n"))
        else:
            git(root, "config", "--worktree", "--unset-all", key, check=False)

    try:
        git(root, "config", "--worktree", "juno.controller.runtimeVersion", identity["version"])
        git(root, "config", "--worktree", "juno.controller.runtimeExecutable", identity["executable"])
        runtime_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = runtime_file.with_name(f".{runtime_file.name}.tmp-{os.getpid()}")
        temporary.write_bytes(canonical(local_identity)); os.replace(temporary, runtime_file)
        if git(root, "rev-parse", "HEAD") != before_head or git(root, "write-tree") != before_tree or git(root, "status", "--porcelain=v2", "--untracked-files=all"):
            raise BoundaryError("runtime rebind created tracked controller synchronization work")
        atomic_receipt(output, payload)
    except Exception as exc:
        rollback_errors: list[str] = []
        try:
            restore_config("juno.controller.runtimeVersion", old_version_result)
            restore_config("juno.controller.runtimeExecutable", old_executable_result)
        except Exception as rollback_exc:
            rollback_errors.append(f"config: {rollback_exc}")
        try:
            if old_identity is None:
                runtime_file.unlink(missing_ok=True)
            else:
                runtime_file.parent.mkdir(parents=True, exist_ok=True)
                runtime_file.write_bytes(old_identity)
        except OSError as rollback_exc:
            rollback_errors.append(f"identity: {rollback_exc}")
        if rollback_errors:
            raise BoundaryError(f"runtime rebind failed ({exc}); rollback failed: {', '.join(rollback_errors)}") from exc
        raise
    return payload


def transition_plan(args: argparse.Namespace, policy: dict[str, Any], rollback: bool) -> dict[str, Any]:
    plan = read_plan(args.plan.resolve())
    old = exact_worktree(Path(plan["old_controller"])); new = exact_worktree(Path(plan["new_controller"]))
    if common_dir(old) != plan["git_common_dir"] or common_dir(new) != plan["git_common_dir"]:
        raise BoundaryError("controller worktrees are not linked to the planned repository")
    resolve_commit(old, plan["old_branch"], plan["old_head"], "rollback controller ref")
    resolve_commit(old, plan["product_ref"], plan["product_head"], "product target")
    new_head = git(new, "rev-parse", f"{plan['new_branch']}^{{commit}}", check=False)
    evidence = inspect(new, policy, expected_branch=plan["new_branch"], require_active=rollback)
    if not evidence["passed"]:
        raise BoundaryError("metadata controller identity verification refused")
    operation = "rollback-plan" if rollback else "cutover-plan"
    source, target = (str(new), str(old)) if rollback else (str(old), str(new))
    payload = {"schema_version": RECEIPT_SCHEMA, "operation": operation, "outcome": "planned_no_mutation",
               "source_controller": source, "target_controller": target, "old_branch": plan["old_branch"],
               "old_head": plan["old_head"], "new_branch": plan["new_branch"], "new_head": new_head,
               "product_ref": plan["product_ref"], "product_head": plan["product_head"],
               "registration_change_authorized": False, "product_ref_mutation": False, "history_rewrite": False,
               "deletes_worktree": False, "steps": ["freeze writers", "verify exact source registration",
                   "switch registration to exact target identity", "set target role controller", "set source role rollback-read-only",
                   "read back registration and unchanged product ref"]}
    atomic_receipt(args.output, payload)
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("migration-plan")
    plan.add_argument("--old-controller", type=Path, required=True); plan.add_argument("--old-branch", required=True)
    plan.add_argument("--expected-old-head", required=True); plan.add_argument("--new-controller", type=Path, required=True)
    plan.add_argument("--new-branch", required=True); plan.add_argument("--product-ref", required=True)
    plan.add_argument("--expected-product-head", required=True); plan.add_argument("--runtime", type=Path, required=True)
    plan.add_argument("--runtime-version", required=True); plan.add_argument("--output", type=Path, required=True)
    plan.add_argument("--policy-bundle", type=Path,
                      help="reviewed migration policy bundle containing metadata, task-workspace, and risk policies")
    plan.add_argument("--task-workspace-policy", type=Path,
                      help="reviewed task-workspace JSON (requires integration/risk paths; alternative to --policy-bundle)")
    plan.add_argument("--integration-workspace-policy", type=Path,
                      help="reviewed integration-workspace JSON (requires task/risk paths; alternative to --policy-bundle)")
    plan.add_argument("--risk-policy", type=Path,
                      help="reviewed risk-policy JSON (requires task/integration paths; alternative to --policy-bundle)")
    prep = sub.add_parser("prepare"); prep.add_argument("--plan", type=Path, required=True); prep.add_argument("--output", type=Path, required=True)
    verify = sub.add_parser("verify"); verify.add_argument("--root", type=Path, required=True); verify.add_argument("--branch", required=True)
    verify.add_argument("--pending", action="store_true"); verify.add_argument("--output", type=Path, required=True)
    product = sub.add_parser("verify-product"); product.add_argument("--root", type=Path, required=True)
    product.add_argument("--product-ref", required=True); product.add_argument("--expected-head", required=True)
    product.add_argument("--output", type=Path, required=True)
    rebind = sub.add_parser("runtime-rebind"); rebind.add_argument("--root", type=Path, required=True); rebind.add_argument("--branch", required=True)
    rebind.add_argument("--runtime", type=Path, required=True); rebind.add_argument("--runtime-version", required=True); rebind.add_argument("--output", type=Path, required=True)
    for name in ("cutover-plan", "rollback-plan"):
        item = sub.add_parser(name); item.add_argument("--plan", type=Path, required=True); item.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "migration-plan" and args.policy_bundle is not None and args.policy is None:
        policy = metadata_policy_from_bundle(args.policy_bundle)
    elif args.command in {"prepare", "cutover-plan", "rollback-plan"} and args.policy is None:
        policy = policy_from_plan_bundle(args.plan)
        if policy is None:
            policy = load_policy((Path(__file__).resolve().parents[1] / "config/metadata-controller.json").resolve())
    else:
        policy_path = (args.policy or Path(__file__).resolve().parents[1] / "config/metadata-controller.json").resolve()
        policy = load_policy(policy_path)
    if args.command == "migration-plan":
        for ref, label in ((args.old_branch, "old_branch"), (args.new_branch, "new_branch"), (args.product_ref, "product_ref")):
            safe_ref(ref, label)
        payload = migration_plan(args, policy)
    elif args.command == "prepare": payload = prepare(args, policy)
    elif args.command == "verify":
        safe_ref(args.branch, "branch")
        payload = {"schema_version": RECEIPT_SCHEMA, "operation": "verify", **inspect(args.root, policy, expected_branch=args.branch, require_active=not args.pending)}
        atomic_receipt(args.output, payload)
        if not payload["passed"]: raise BoundaryError("metadata controller verification refused")
    elif args.command == "verify-product":
        payload = {"schema_version": RECEIPT_SCHEMA, "operation": "verify-product",
                   **product_boundary(args.root, args.product_ref, args.expected_head, policy)}
        atomic_receipt(args.output, payload)
        if not payload["passed"]: raise BoundaryError("product tree still contains controller-private paths")
    elif args.command == "runtime-rebind": payload = runtime_rebind(args, policy)
    else: payload = transition_plan(args, policy, args.command == "rollback-plan")
    print(json.dumps({"outcome": payload.get("outcome", "verified"), "receipt": str(args.output.resolve())}, sort_keys=True))


if __name__ == "__main__":
    try: main()
    except (BoundaryError, OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"metadata-controller: {exc}", file=os.sys.stderr)
        raise SystemExit(2)
