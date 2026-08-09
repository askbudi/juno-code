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
import json
import os
import re
import subprocess
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
    selected_entries(old, old_head, policy)
    payload = {"schema_version": PLAN_SCHEMA, "operation": "migration-plan", "outcome": "planned_no_mutation",
               "old_controller": str(old), "old_branch": args.old_branch, "old_head": old_head,
               "new_controller": str(args.new_controller.expanduser().resolve()), "new_branch": args.new_branch,
               "product_ref": args.product_ref, "product_head": product_head, "git_common_dir": common_dir(old),
               "runtime": runtime, "policy_sha256": digest(policy),
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
                "policy_sha256": plan["policy_sha256"], "controller_commits_integrate_to_product": False,
                "preserved_metadata": {"entries": preserved_entries, "sha256": digest(preserved_entries)}}
    task_policy_path = Path(__file__).resolve().parents[1] / "config/task-workspace.json"
    try:
        task_policy_bytes = canonical(json.loads(task_policy_path.read_text()))
    except (OSError, json.JSONDecodeError) as exc:
        raise BoundaryError(f"installed task workspace policy is invalid: {exc}") from exc
    generated = {
        ".gitignore": b".env.juno\n.venv_juno/\n.juno_task/runtime/\n.juno_task/scripts/\n.juno_task/tmp/\n*.log\n__pycache__/\n",
        ".juno_task/config.json": canonical({"controllerWorkspace": {"mode": "metadata-only", "policy": ".juno_task/config/metadata-controller.json"}}),
        ".juno_task/config/metadata-controller.json": canonical(policy),
        ".juno_task/config/task-workspace.json": task_policy_bytes,
        ".juno_task/receipts/controller-boundary.json": canonical(boundary),
        ".juno_task/state/lifecycle.json": canonical({"schema_version": "juno_task_lifecycle_state.v1", "tasks": {}}),
        ".juno_task/state/queue.json": canonical({"schema_version": "juno_merge_queue_state.v1", "targets": {}}),
        ".juno_task/state/tasks.json": canonical({"schema_version": "juno_task_workspace_state.v1", "tasks": {}}),
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
        git(destination, "config", "extensions.worktreeConfig", "true")
        git(destination, "config", "--worktree", "juno.workspace.role", "controller-pending")
        git(destination, "config", "--worktree", "juno.controller.mode", "metadata-only")
        git(destination, "config", "--worktree", "juno.controller.runtimeVersion", identity["version"])
        git(destination, "config", "--worktree", "juno.controller.runtimeExecutable", identity["executable"])
        runtime_file = destination / policy["runtime"]["identity_file"]
        runtime_file.parent.mkdir(parents=True, exist_ok=True)
        runtime_file.write_bytes(canonical(identity))
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
    try:
        boundary = json.loads(root_boundary_text)
        if boundary.get("schema_version") != RECEIPT_SCHEMA or boundary.get("operation") != "controller-boundary":
            raise ValueError("invalid boundary receipt identity")
        preservation = boundary["preserved_metadata"]
        expected_entries = preservation["entries"]
        if not isinstance(expected_entries, list) or preservation["sha256"] != digest(expected_entries):
            raise ValueError("invalid preserved metadata digest")
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
            task_policy_value = json.loads(run(["git", "-C", str(root), "show", f"{head}:.juno_task/config/task-workspace.json"], root).stdout)
            lifecycle_value = json.loads(run(["git", "-C", str(root), "show", f"{head}:.juno_task/state/lifecycle.json"], root).stdout)
            queue_value = json.loads(run(["git", "-C", str(root), "show", f"{head}:.juno_task/state/queue.json"], root).stdout)
            tasks_value = json.loads(run(["git", "-C", str(root), "show", f"{head}:.juno_task/state/tasks.json"], root).stdout)
            generated_contract_ok = (
                config_value == {"controllerWorkspace": {"mode": "metadata-only", "policy": ".juno_task/config/metadata-controller.json"}}
                and policy_text == canonical(policy).decode()
                and task_policy_value.get("schema_version") == "juno_task_workspace_config.v1"
                and lifecycle_value.get("schema_version") == "juno_task_lifecycle_state.v1"
                and isinstance(lifecycle_value.get("tasks"), dict)
                and queue_value.get("schema_version") == "juno_merge_queue_state.v1"
                and isinstance(queue_value.get("targets"), dict)
                and tasks_value.get("schema_version") == "juno_task_workspace_state.v1"
                and isinstance(tasks_value.get("tasks"), dict)
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
