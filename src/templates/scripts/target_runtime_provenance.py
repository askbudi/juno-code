#!/usr/bin/env python3
"""Receipt-bound provenance migration for legacy consumer task runtimes."""
from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA = "juno_target_runtime_provenance_migration.v1"
RUNTIME_PATH = ".juno_task/scripts/task_workspace.py"
INVENTORY_PATH = ".juno_task/managed-assets.json"
IDENTITY_PATH = ".juno_task/runtime/identity.json"
GENERATION_PATH = ".juno_task/runtime/managed-controller/generation.json"
TASK_POLICY_PATH = ".juno_task/config/task-workspace.json"
SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")
HASH_RE = re.compile(r"[0-9a-f]{64}\Z")


class ProvenanceError(RuntimeError):
    pass


def run(argv: list[str], cwd: Path, *, check: bool = True,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True,
                            stdin=subprocess.DEVNULL)
    if check and result.returncode:
        raise ProvenanceError(result.stderr.strip() or result.stdout.strip() or
                              f"command failed: {argv!r}")
    return result


def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check=check).stdout.strip()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def exact_root(path: Path, label: str) -> Path:
    lexical = path.expanduser().absolute()
    resolved = lexical.resolve(strict=True)
    if not resolved.is_dir() or lexical != resolved:
        raise ProvenanceError(f"{label} must be one exact physical directory")
    if not git(resolved, "rev-parse", "--is-inside-work-tree", check=False) == "true":
        raise ProvenanceError(f"{label} is not a Git worktree")
    return resolved


def blob(repository: Path, commit: str, relative: str) -> bytes | None:
    result = subprocess.run(["git", "-C", str(repository), "show", f"{commit}:{relative}"],
                            cwd=repository, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return result.stdout if result.returncode == 0 else None


def file_binding(path: Path, *, required: bool = False) -> dict[str, Any]:
    if not path.is_file():
        if required:
            raise ProvenanceError(f"required provenance file is missing: {path}")
        return {"present": False, "sha256": None, "bytes_base64": None}
    data = path.read_bytes()
    return {"present": True, "sha256": sha256(data),
            "bytes_base64": base64.b64encode(data).decode()}


def parse_binding(binding: Any, label: str) -> bytes | None:
    if not isinstance(binding, dict) or set(binding) != {"present", "sha256", "bytes_base64"}:
        raise ProvenanceError(f"{label} binding is invalid")
    if binding["present"] is False and binding["sha256"] is None and binding["bytes_base64"] is None:
        return None
    try:
        data = base64.b64decode(binding["bytes_base64"], validate=True)
    except (TypeError, ValueError) as exc:
        raise ProvenanceError(f"{label} binding bytes are invalid") from exc
    if binding["present"] is not True or not HASH_RE.fullmatch(str(binding["sha256"])) or sha256(data) != binding["sha256"]:
        raise ProvenanceError(f"{label} binding hash is invalid")
    return data


def load_task_runtime() -> Any:
    path = Path(__file__).resolve().with_name("task_workspace.py")
    spec = importlib.util.spec_from_file_location("juno_provenance_task_runtime", path)
    if spec is None or spec.loader is None:
        raise ProvenanceError("packaged task-workspace validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_json_binding(binding: dict[str, Any], label: str) -> dict[str, Any] | None:
    data = parse_binding(binding, label)
    if data is None:
        return None
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProvenanceError(f"{label} is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ProvenanceError(f"{label} must be a JSON object")
    return value


def worktree_records(repository: Path) -> list[dict[str, str | bool]]:
    records: list[dict[str, str | bool]] = []
    current: dict[str, str | bool] = {}
    for line in [*git(repository, "worktree", "list", "--porcelain").splitlines(), ""]:
        if not line:
            if current:
                records.append(current)
            current = {}
            continue
        key, _, value = line.partition(" ")
        if key in {"worktree", "HEAD", "branch", "locked", "prunable"}:
            current[key.lower()] = value or True
    return records


def assert_receipt_location(path: Path, repository: Path) -> Path:
    lexical = path.expanduser().absolute()
    if lexical.exists():
        raise ProvenanceError(f"receipt output already exists: {lexical}")
    parent = lexical.parent.resolve(strict=True)
    resolved = parent / lexical.name
    common = Path(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    forbidden = [common, *[Path(str(row["worktree"])).resolve()
                           for row in worktree_records(repository) if "worktree" in row]]
    for root in forbidden:
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        raise ProvenanceError("receipt output must be outside every worktree and Git administration directory")
    return resolved


def write_new(path: Path, payload: dict[str, Any]) -> None:
    data = canonical_json(payload)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data); handle.flush(); os.fsync(handle.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def controller_snapshot(controller: Path) -> dict[str, Any]:
    task_runtime = load_task_runtime()
    config = task_runtime.load_config(controller)
    controller_class = task_runtime.require_metadata_only_controller(controller, config)
    branch = git(controller, "symbolic-ref", "-q", "HEAD", check=False)
    head = git(controller, "rev-parse", "HEAD^{commit}")
    if branch != controller_class["controller_branch"]:
        raise ProvenanceError("controller is on the wrong role/ref")
    if git(controller, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ProvenanceError("metadata controller has tracked or untracked dirt")
    repository = task_runtime.product_repository(controller, config)
    common = str(Path(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve())
    target_ref = config["target_ref"]
    target_sha = task_runtime.ref_sha(repository, target_ref)
    target_tree = git(repository, "rev-parse", f"{target_sha}^{{tree}}")
    policy = file_binding(controller / TASK_POLICY_PATH, required=True)
    identity = file_binding(controller / IDENTITY_PATH, required=True)
    managed_inventory = file_binding(controller / INVENTORY_PATH)
    generation = file_binding(controller / GENERATION_PATH)
    return {
        "controller": {"path": str(controller), "ref": branch, "head": head,
                       "tree": git(controller, "rev-parse", "HEAD^{tree}"),
                       "class": controller_class},
        "repository": {"path": str(repository), "common_dir": common},
        "target": {"ref": target_ref, "sha": target_sha, "tree": target_tree},
        "task_policy": policy,
        "managed_runtime": {"identity": identity, "inventory": managed_inventory,
                            "generation": generation},
    }


def package_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    identity_binding = snapshot["managed_runtime"]["identity"]
    identity = validate_json_binding(identity_binding, "managed runtime identity")
    if identity is None or set(identity) != {
            "package", "version", "executable", "executable_sha256", "source", "tracked"}:
        raise ProvenanceError("managed runtime identity shape is invalid")
    executable = Path(str(identity.get("executable", ""))).expanduser().resolve(strict=True)
    executable_bytes = executable.read_bytes()
    if (identity.get("package") != "juno-code" or identity.get("source") != "installed-release"
            or identity.get("tracked") is not False
            or not load_task_runtime().is_valid_semver(identity.get("version"))
            or not HASH_RE.fullmatch(str(identity.get("executable_sha256", "")))
            or sha256(executable_bytes) != identity["executable_sha256"]):
        raise ProvenanceError("managed runtime identity does not prove an installed juno-code executable")
    package_root = executable.parents[2]
    package_path = package_root / "package.json"
    manifest_path = package_root / "dist/templates/managed-assets.json"
    runtime_source = package_root / "dist/templates/scripts/task_workspace.py"
    for required in (package_path, manifest_path, runtime_source):
        if not required.is_file():
            raise ProvenanceError(f"installed package provenance source is missing: {required}")
    package_bytes = package_path.read_bytes()
    manifest_bytes = manifest_path.read_bytes()
    runtime_bytes = runtime_source.read_bytes()
    try:
        package = json.loads(package_bytes)
        manifest = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProvenanceError("installed package provenance JSON is invalid") from exc
    assets = manifest.get("assets") if isinstance(manifest, dict) else None
    matches = [row for row in assets or [] if isinstance(row, dict)
               and row.get("destination") == RUNTIME_PATH]
    if (not isinstance(package, dict) or package.get("name") != identity["package"]
            or package.get("version") != identity["version"] or len(matches) != 1
            or matches[0].get("source") != "scripts/task_workspace.py"
            or matches[0].get("type") != "script"):
        raise ProvenanceError("installed package manifest/runtime source is ambiguous or identity-mismatched")
    managed_inventory = validate_json_binding(
        snapshot["managed_runtime"]["inventory"], "controller managed inventory")
    if managed_inventory is not None:
        entry = managed_inventory.get("assets", {}).get(RUNTIME_PATH) \
            if isinstance(managed_inventory.get("assets"), dict) else None
        if (managed_inventory.get("schemaVersion") != 1
                or managed_inventory.get("packageName") != identity["package"]
                or managed_inventory.get("packageVersion") != identity["version"]
                or not isinstance(entry, dict)
                or entry.get("sourceSha256") != sha256(runtime_bytes)
                or entry.get("installedSha256") != sha256(runtime_bytes)):
            raise ProvenanceError("controller managed inventory mismatches runtime/package identity")
    generation = validate_json_binding(snapshot["managed_runtime"]["generation"],
                                       "managed controller generation")
    if generation is not None and (generation.get("package_version") != identity["version"]
                                   or generation.get("schema_version") != "juno_managed_controller_runtime.v1"):
        raise ProvenanceError("managed controller generation mismatches runtime/package identity")
    return {
        "name": identity["package"], "version": identity["version"],
        "root": str(package_root), "executable": str(executable),
        "executable_sha256": sha256(executable_bytes),
        "package_json_sha256": sha256(package_bytes),
        "manifest_sha256": sha256(manifest_bytes),
        "manifest_asset": matches[0],
        "runtime_source": str(runtime_source),
        "runtime_sha256": sha256(runtime_bytes),
        "runtime_bytes_base64": base64.b64encode(runtime_bytes).decode(),
    }


def target_provenance(snapshot: dict[str, Any], package: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    repository = Path(snapshot["repository"]["path"])
    target_sha = snapshot["target"]["sha"]
    runtime = blob(repository, target_sha, RUNTIME_PATH)
    if runtime is None or sha256(runtime) != package["runtime_sha256"]:
        raise ProvenanceError("target runtime bytes do not match the exact installed package source")
    row = git(repository, "ls-tree", target_sha, "--", RUNTIME_PATH)
    if not row.startswith(("100644 blob ", "100755 blob ")):
        raise ProvenanceError("target runtime has an unsafe Git mode")
    policy = json.loads(parse_binding(snapshot["task_policy"], "task policy"))
    if policy.get("target_ref") != snapshot["target"]["ref"] or policy.get("repository") != ".":
        raise ProvenanceError("task-policy identity does not select the exact consumer repository/ref")
    prior_bytes = blob(repository, target_sha, INVENTORY_PATH)
    if prior_bytes is None:
        prior = {"classification": "missing", "mode": None, "sha256": None,
                 "bytes_base64": None}
        inventory = {"schemaVersion": 1, "packageName": package["name"],
                     "packageVersion": package["version"], "assets": {}}
        mode = "100644"
    else:
        try:
            inventory = json.loads(prior_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProvenanceError("target managed inventory is malformed") from exc
        assets = inventory.get("assets") if isinstance(inventory, dict) else None
        entries_valid = isinstance(assets, dict) and all(
            isinstance(path, str) and isinstance(entry, dict)
            and set(entry) == {"type", "templateVersion", "sourceSha256", "installedSha256"}
            and isinstance(entry.get("type"), str) and bool(entry["type"])
            and isinstance(entry.get("templateVersion"), str)
            and HASH_RE.fullmatch(str(entry.get("sourceSha256", ""))) is not None
            and HASH_RE.fullmatch(str(entry.get("installedSha256", ""))) is not None
            for path, entry in (assets or {}).items())
        if (not isinstance(inventory, dict) or set(inventory) != {
                "schemaVersion", "packageName", "packageVersion", "assets"}
                or inventory.get("schemaVersion") != 1
                or inventory.get("packageName") != package["name"]
                or inventory.get("packageVersion") != package["version"]
                or not entries_valid or RUNTIME_PATH in assets):
            raise ProvenanceError("target inventory is not an exact supported legacy provenance generation")
        inventory_row = git(repository, "ls-tree", target_sha, "--", INVENTORY_PATH)
        mode = inventory_row.split()[0] if inventory_row else ""
        if mode not in {"100644", "100755"}:
            raise ProvenanceError("target managed inventory has an unsafe Git mode")
        prior = {"classification": "legacy_missing_runtime_entry", "mode": mode,
                 "sha256": sha256(prior_bytes),
                 "bytes_base64": base64.b64encode(prior_bytes).decode()}
    inventory["assets"][RUNTIME_PATH] = {
        "type": "script", "templateVersion": package["version"],
        "sourceSha256": package["runtime_sha256"],
        "installedSha256": package["runtime_sha256"],
    }
    proposed_bytes = (json.dumps(inventory, indent=2) + "\n").encode()
    proposed = {"path": INVENTORY_PATH, "mode": mode, "sha256": sha256(proposed_bytes),
                "bytes_base64": base64.b64encode(proposed_bytes).decode()}
    required = {"path": RUNTIME_PATH, "mode": row.split()[0],
                "sha256": sha256(runtime)}
    return {"inventory": prior, "required_target_runtime_files": [required]}, proposed


def build_plan(controller: Path) -> dict[str, Any]:
    snapshot = controller_snapshot(controller)
    package = package_snapshot(snapshot)
    prior, proposed = target_provenance(snapshot, package)
    return {"schema_version": SCHEMA, "operation": "plan", **snapshot,
            "package": package, "prior": prior, "proposed": proposed}


def plan_command(controller_path: Path, output_path: Path) -> dict[str, Any]:
    controller = exact_root(controller_path, "controller")
    plan = build_plan(controller)
    output = assert_receipt_location(output_path, Path(plan["repository"]["path"]))
    write_new(output, plan)
    return {**plan, "receipt": {"path": str(output),
                                  "sha256": sha256(canonical_json(plan))}}


def load_plan(path: Path) -> tuple[dict[str, Any], bytes, str]:
    raw = path.expanduser().resolve(strict=True).read_bytes()
    try:
        plan = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProvenanceError("target-runtime provenance receipt is invalid") from exc
    if canonical_json(plan) != raw or not isinstance(plan, dict) or plan.get("schema_version") != SCHEMA \
            or plan.get("operation") != "plan":
        raise ProvenanceError("target-runtime provenance receipt is stale or tampered")
    return plan, raw, sha256(raw)


@contextmanager
def mutation_locks(controller: Path, repository: Path, target_ref: str) -> Iterator[None]:
    common = Path(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    key = sha256((str(common) + "\0" + target_ref).encode())
    paths = [controller / ".juno_task/runtime/task-workspace.lock",
             common / "juno-locks/merge-queue" / f"{key}.lock"]
    handles = []
    try:
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            handle = path.open("a+b")
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                handle.close()
                if exc.errno in (errno.EACCES, errno.EAGAIN):
                    raise ProvenanceError("concurrent controller/target update owns the migration lock") from exc
                raise
            handles.append(handle)
        yield
    finally:
        for handle in reversed(handles):
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN); handle.close()


def exact_applied(repository: Path, plan: dict[str, Any], commit: str) -> bool:
    if not SHA_RE.fullmatch(commit) or git(repository, "rev-parse", f"{commit}^", check=False) != plan["target"]["sha"]:
        return False
    proposed = base64.b64decode(plan["proposed"]["bytes_base64"], validate=True)
    return (blob(repository, commit, INVENTORY_PATH) == proposed
            and blob(repository, commit, RUNTIME_PATH) is not None
            and sha256(blob(repository, commit, RUNTIME_PATH) or b"") == plan["package"]["runtime_sha256"]
            and git(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines() == [INVENTORY_PATH]
            and f"Reviewed-Provenance-Plan: {sha256(canonical_json(plan))}" in
                git(repository, "show", "-s", "--format=%B", commit))


def create_commit(repository: Path, plan: dict[str, Any], digest: str) -> tuple[str, str]:
    proposed = base64.b64decode(plan["proposed"]["bytes_base64"], validate=True)
    with tempfile.TemporaryDirectory(prefix="juno-provenance-index-") as temporary:
        index = Path(temporary) / "index"
        env = {**os.environ, "GIT_INDEX_FILE": str(index)}
        run(["git", "-C", str(repository), "read-tree", plan["target"]["sha"]], repository, env=env)
        # hash-object receives bytes, so use a binary subprocess rather than the text helper.
        binary = subprocess.run(["git", "-C", str(repository), "hash-object", "-w", "--stdin"],
                                cwd=repository, env=env, input=proposed,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if binary.returncode:
            raise ProvenanceError(binary.stderr.decode(errors="replace").strip())
        object_id = binary.stdout.decode().strip()
        run(["git", "-C", str(repository), "update-index", "--add", "--cacheinfo",
             f"{plan['proposed']['mode']},{object_id},{INVENTORY_PATH}"], repository, env=env)
        tree = run(["git", "-C", str(repository), "write-tree"], repository, env=env).stdout.strip()
    message = ("chore(juno): record target runtime provenance\n\n"
               f"Reviewed-Provenance-Plan: {digest}\n"
               f"Juno-Package: {plan['package']['version']}\n")
    commit = run(["git", "-C", str(repository), "commit-tree", tree,
                  "-p", plan["target"]["sha"], "-m", message], repository).stdout.strip()
    return commit, tree


def apply_command(plan_path: Path, output_path: Path) -> dict[str, Any]:
    plan, _, digest = load_plan(plan_path)
    controller = exact_root(Path(plan.get("controller", {}).get("path", "")), "controller")
    repository = exact_root(Path(plan.get("repository", {}).get("path", "")), "consumer repository")
    output = assert_receipt_location(output_path, repository)
    with mutation_locks(controller, repository, str(plan.get("target", {}).get("ref", ""))):
        target_ref = plan.get("target", {}).get("ref", "")
        current_sha = git(repository, "rev-parse", f"{target_ref}^{{commit}}", check=False)
        if current_sha != plan.get("target", {}).get("sha"):
            if exact_applied(repository, plan, current_sha):
                result = {"schema_version": SCHEMA, "operation": "apply",
                          "outcome": "already_applied", "plan_sha256": digest,
                          "previous_sha": plan["target"]["sha"], "commit_sha": current_sha,
                          "target_ref": target_ref}
                write_new(output, result)
                return {**result, "receipt": {"path": str(output),
                                               "sha256": sha256(canonical_json(result))}}
            raise ProvenanceError("receipt target moved outside the exact migration result")
        current = build_plan(controller)
        if current != plan:
            raise ProvenanceError("receipt identities are stale, tampered, or mismatched under lock")
        holders = [row for row in worktree_records(repository)
                   if row.get("branch") == plan["target"]["ref"]]
        if holders:
            holder = exact_root(Path(str(holders[0]["worktree"])), "target owner")
            if len(holders) != 1 or git(holder, "status", "--porcelain=v1", "--untracked-files=all"):
                raise ProvenanceError("dirty or ambiguous target owner; refusing provenance migration")
            raise ProvenanceError("target owner must be detached before provenance migration")
        commit, tree = create_commit(repository, plan, digest)
        if not exact_applied(repository, plan, commit):
            raise ProvenanceError("prepared provenance commit has unexpected target changes")
        cas = run(["git", "-C", str(repository), "update-ref", plan["target"]["ref"],
                   commit, plan["target"]["sha"]], repository, check=False)
        if cas.returncode:
            raced = git(repository, "rev-parse", f"{plan['target']['ref']}^{{commit}}", check=False)
            if not exact_applied(repository, plan, raced):
                raise ProvenanceError("target ref concurrent update defeated the exact ref lease")
            commit = raced
        result = {"schema_version": SCHEMA, "operation": "apply", "outcome": "migrated",
                  "plan_sha256": digest, "previous_sha": plan["target"]["sha"],
                  "commit_sha": commit, "tree": git(repository, "rev-parse", f"{commit}^{{tree}}"),
                  "target_ref": plan["target"]["ref"], "changed_paths": [INVENTORY_PATH]}
        write_new(output, result)
    return {**result, "receipt": {"path": str(output),
                                   "sha256": sha256(canonical_json(result))}}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    sub = value.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("target-runtime-provenance-plan")
    plan.add_argument("--controller", type=Path, required=True)
    plan.add_argument("--output", type=Path, required=True)
    apply = sub.add_parser("target-runtime-provenance-apply")
    apply.add_argument("--plan", type=Path, required=True)
    apply.add_argument("--output", type=Path, required=True)
    apply.add_argument("--authorize-target-runtime-provenance", action="store_true")
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "target-runtime-provenance-plan":
            result = plan_command(args.controller, args.output)
        else:
            if not args.authorize_target_runtime_provenance:
                raise ProvenanceError("apply requires --authorize-target-runtime-provenance")
            result = apply_command(args.plan, args.output)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (ProvenanceError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"target runtime provenance: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
