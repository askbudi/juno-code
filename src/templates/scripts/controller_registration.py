#!/usr/bin/env python3
"""Protected, receipt-bound metadata-controller registration and rollback.

This helper is deliberately narrower than controller preparation.  It changes
only repository-local controller routing and the prepared controller's
worktree role.  Product refs, controller refs, tracked files, and worktrees are
read-only inputs.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

os.environ.setdefault("GIT_OPTIONAL_LOCKS", "0")
sys.dont_write_bytecode = True

PLAN_SCHEMA = "juno_controller_registration_plan.v1"
RECEIPT_SCHEMA = "juno_controller_registration_receipt.v1"
POLICY_SCHEMA = "juno_migration_policy_bundle.v1"
SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")


class RegistrationError(RuntimeError):
    pass


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, env=os.environ.copy())
    if check and result.returncode:
        raise RegistrationError(result.stderr.strip() or result.stdout.strip() or f"command failed: {argv}")
    return result


def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check).stdout.strip()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def file_sha256(path: Path) -> str:
    if not path.is_file():
        raise RegistrationError(f"required artifact is not a regular file: {path}")
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def exact_worktree(path: Path, label: str) -> Path:
    root = path.expanduser().resolve()
    found = git(root, "rev-parse", "--show-toplevel", check=False)
    if not found or Path(found).resolve() != root:
        raise RegistrationError(f"{label} must be an exact Git worktree root")
    return root


def common_dir(root: Path) -> Path:
    return Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()


def full_ref(value: str, label: str) -> str:
    if not value.startswith("refs/heads/") or run(["git", "check-ref-format", value], Path.cwd(), False).returncode:
        raise RegistrationError(f"{label} must be a valid full local branch ref")
    return value


def exact_head(root: Path, ref: str, expected: str, label: str) -> str:
    if not SHA_RE.fullmatch(expected):
        raise RegistrationError(f"{label} expected HEAD is not a full object id")
    observed = git(root, "rev-parse", f"{ref}^{{commit}}", check=False)
    if observed != expected:
        raise RegistrationError(f"{label} moved: expected {expected}, found {observed or 'missing'}")
    return observed


def attached(root: Path, ref: str, label: str) -> None:
    observed = git(root, "symbolic-ref", "-q", "HEAD", check=False)
    if observed != ref:
        raise RegistrationError(f"{label} must be attached to {ref}; found {observed or 'detached HEAD'}")


def clean(root: Path, label: str) -> None:
    if git(root, "status", "--porcelain=v2", "--untracked-files=all", check=False):
        raise RegistrationError(f"{label} must be clean")


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise RegistrationError(f"invalid {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise RegistrationError(f"invalid {label}: expected object")
    return value


def config(root: Path, key: str, *, worktree: bool = False) -> tuple[bool, str | None]:
    args = ["config", "--worktree" if worktree else "--local", "--get", key]
    result = run(["git", "-C", str(root), *args], root, False)
    return (result.returncode == 0, result.stdout.rstrip("\n") if result.returncode == 0 else None)


def single_config(root: Path, key: str, *, worktree: bool = False) -> tuple[bool, str | None]:
    args = ["config", "--worktree" if worktree else "--local", "--get-all", key]
    result = run(["git", "-C", str(root), *args], root, False)
    values = result.stdout.splitlines() if result.returncode == 0 else []
    if len(values) > 1:
        raise RegistrationError(f"duplicate Git config values refuse lossless registration: {key}")
    return (bool(values), values[0] if values else None)


def set_config(root: Path, key: str, value: str, *, worktree: bool = False) -> None:
    git(root, "config", "--worktree" if worktree else "--local", "--replace-all", key, value)


def restore_config(root: Path, key: str, snapshot: dict[str, Any], *, worktree: bool = False) -> None:
    if snapshot["present"]:
        set_config(root, key, snapshot["value"], worktree=worktree)
    else:
        git(root, "config", "--worktree" if worktree else "--local", "--unset-all", key, check=False)


def snapshot(pair: tuple[bool, str | None]) -> dict[str, Any]:
    return {"present": pair[0], "value": pair[1]}


def immutable(path: Path, payload: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = canonical(payload)
    if path.exists():
        if path.read_bytes() != data:
            raise RegistrationError(f"immutable receipt collision: {path}")
        return
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("xb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def outside_repositories(path: Path, roots: list[Path], common: Path) -> None:
    output = path.expanduser().resolve()
    for protected in [common, *roots]:
        try:
            output.relative_to(protected.resolve())
            raise RegistrationError("receipts must be outside all protected worktrees and Git administration")
        except ValueError:
            pass


def runtime_identity(path: Path, version: str) -> dict[str, str]:
    executable = path.expanduser().resolve()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise RegistrationError("runtime version must be exact semver")
    return {"path": str(executable), "version": version, "sha256": file_sha256(executable)}


def policy_identity(path: Path, inventory_path: Path, target: Path, product: Path, target_ref: str,
                    product_ref: str, product_head: str, runtime: dict[str, str]) -> dict[str, str]:
    value = read_json(path, "migration policy bundle")
    if (value.get("schema_version") != POLICY_SCHEMA or value.get("operation") != "generate-policy"
            or value.get("outcome") != "generated_from_reviewed_answers"):
        raise RegistrationError("registration requires a reviewed migration policy bundle")
    if value.get("migration_authorized") is not False:
        raise RegistrationError("migration policy authority field is malformed")
    selected = value.get("selected_paths", {})
    policies = value.get("policies", {})
    metadata = policies.get("metadata_controller", {}) if isinstance(policies, dict) else {}
    if Path(str(selected.get("controller", ""))).expanduser().resolve() != target:
        raise RegistrationError("target controller differs from the reviewed policy")
    if Path(str(selected.get("integration", ""))).expanduser().resolve() != product:
        raise RegistrationError("integration owner differs from the reviewed policy")
    if metadata.get("controller_branch") != target_ref or metadata.get("product_ref") != product_ref:
        raise RegistrationError("controller/product refs differ from the reviewed policy")
    inventory = read_json(inventory_path, "migration inventory")
    frozen_git = inventory.get("git", {})
    frozen_runtime = inventory.get("runtime", {})
    if (value.get("inventory_sha256") != file_sha256(inventory_path)
            or Path(str(frozen_git.get("root", ""))).expanduser().resolve() != product
            or frozen_git.get("selected_product_ref") != product_ref
            or frozen_git.get("selected_product_head") != product_head
            or Path(str(frozen_runtime.get("selected", ""))).expanduser().resolve() != Path(runtime["path"])
            or frozen_runtime.get("sha256") != runtime["sha256"]):
        raise RegistrationError("policy/inventory/product/runtime identity chain is inconsistent")
    return {"path": str(path.resolve()), "sha256": file_sha256(path.resolve()),
            "inventory_path": str(inventory_path.resolve()), "inventory_sha256": file_sha256(inventory_path.resolve())}


def pending_verification_identity(path: Path, target: Path, target_ref: str, target_head: str) -> dict[str, str]:
    value = read_json(path, "pending controller verification receipt")
    checks = value.get("checks", {})
    required_checks = {"branch_exact", "single_root_ancestry", "root_boundary", "root_preservation",
                       "canonical_metadata_present", "required_generated_present", "generated_contract",
                       "tracked_boundary", "product_absent", "regular_files_only", "staged_boundary",
                       "runtime_bound", "runtime_untracked", "role", "clean"}
    if (value.get("schema_version") != "juno_metadata_controller_receipt.v1"
            or value.get("operation") != "verify" or value.get("passed") is not True
            or Path(str(value.get("root", ""))).expanduser().resolve() != target
            or value.get("branch_ref") != target_ref or value.get("head") != target_head
            or not isinstance(checks, dict) or not required_checks.issubset(checks)
            or any(checks.get(name) is not True for name in required_checks)):
        raise RegistrationError("pending controller verification receipt does not bind the exact clean target")
    return {"path": str(path.resolve()), "sha256": file_sha256(path.resolve())}


def registration_state(root: Path, plan: dict[str, Any]) -> dict[str, Any]:
    path_state = snapshot(single_config(root, "juno.controller.path"))
    branch_state = snapshot(single_config(root, "juno.controller.branch"))
    role_state = snapshot(single_config(Path(plan["target"]["path"]), "juno.workspace.role", worktree=True))
    source_role_state = snapshot(single_config(Path(plan["source"]["path"]), "juno.workspace.role", worktree=True))
    product_role_state = snapshot(single_config(root, "juno.workspace.role", worktree=True))
    product_authority_state = snapshot(single_config(root, "juno.workspace.roleAuthority", worktree=True))
    product_role_base_state = snapshot(single_config(root, "juno.workspace.roleBase", worktree=True))
    before = plan["before"]
    after = {"path": {"present": True, "value": plan["target"]["path"]},
             "branch": {"present": True, "value": plan["target"]["ref"]},
             "target_role": {"present": True, "value": "controller"},
             "source_role": {"present": True, "value": "controller-retired"},
             "product_role": {"present": True, "value": "integration-owner"},
             "product_authority": {"present": True, "value": "protected-integration.v1"},
             "product_role_base": {"present": True, "value": plan["product"]["head"]}}
    observed = {"path": path_state, "branch": branch_state, "target_role": role_state,
                "source_role": source_role_state, "product_role": product_role_state,
                "product_authority": product_authority_state, "product_role_base": product_role_base_state}
    before_state = {"path": before["path"], "branch": before["branch"], "target_role": before["target_role"],
                    "source_role": before["source_role"], "product_role": before["product_role"],
                    "product_authority": before["product_authority"],
                    "product_role_base": before["product_role_base"]}
    if observed == before_state:
        classification = "before"
    elif observed == after:
        classification = "after"
    elif all(observed[key] in (before_state[key], after[key]) for key in observed):
        classification = "recoverable_partial"
    else:
        classification = "foreign_mismatch"
    return {"classification": classification, "observed": observed, "before": before_state, "after": after}


def verify_frozen(plan: dict[str, Any]) -> tuple[Path, Path, Path, Path]:
    source = exact_worktree(Path(plan["source"]["path"]), "source controller")
    target = exact_worktree(Path(plan["target"]["path"]), "target controller")
    product = exact_worktree(Path(plan["product"]["path"]), "product integration owner")
    common = Path(plan["git_common_dir"]).resolve()
    if any(common_dir(root) != common for root in (source, target, product)):
        raise RegistrationError("worktree Git common directory changed")
    for root, record, label in ((source, plan["source"], "source controller"),
                                (target, plan["target"], "target controller"),
                                (product, plan["product"], "product integration owner")):
        attached(root, record["ref"], label)
        exact_head(root, record["ref"], record["head"], label)
        clean(root, label)
    runtime = plan["runtime"]
    if runtime_identity(Path(runtime["path"]), runtime["version"]) != runtime:
        raise RegistrationError("runtime artifact identity changed")
    policy = plan["policy"]
    if file_sha256(Path(policy["path"])) != policy["sha256"]:
        raise RegistrationError("migration policy bundle changed")
    if file_sha256(Path(policy["inventory_path"])) != policy["inventory_sha256"]:
        raise RegistrationError("migration inventory changed")
    pending = plan["pending_verification"]
    if file_sha256(Path(pending["path"])) != pending["sha256"]:
        raise RegistrationError("pending controller verification receipt changed")
    return source, target, product, common


def load_plan(path: Path) -> dict[str, Any]:
    value = read_json(path, "registration plan")
    if value.get("schema_version") != PLAN_SCHEMA or value.get("operation") != "registration-plan":
        raise RegistrationError("unsupported registration plan")
    if value.get("outcome") != "planned_no_mutation" or value.get("registration_authorized") is not False:
        raise RegistrationError("registration plan authority contract is invalid")
    return value


@contextmanager
def registration_lock(common: Path, refs: list[str]) -> Iterator[None]:
    identity_paths = []
    for ref in sorted(set(refs)):
        identity = f"{common}\0{ref}".encode()
        identity_paths.append(common / "juno-integration-channels" / (hashlib.sha256(identity).hexdigest() + ".lock"))
    paths = [common / "juno-repository-writer.lock", *identity_paths, common / "juno-controller-registration.lock"]
    streams = []
    try:
        for lock_path in paths:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            stream = lock_path.open("a+"); fcntl.flock(stream.fileno(), fcntl.LOCK_EX); streams.append(stream)
        yield
    finally:
        for stream in reversed(streams):
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN); stream.close()


def plan_command(args: argparse.Namespace) -> dict[str, Any]:
    source = exact_worktree(args.source_controller, "source controller")
    target = exact_worktree(args.target_controller, "target controller")
    product = exact_worktree(args.product_root, "product integration owner")
    refs = [full_ref(value, label) for value, label in
            ((args.source_ref, "source ref"), (args.target_ref, "target ref"), (args.product_ref, "product ref"))]
    source_ref, target_ref, product_ref = refs
    common = common_dir(source)
    if any(common_dir(root) != common for root in (target, product)):
        raise RegistrationError("all migration worktrees must share one Git common directory")
    for root, ref, expected, label in ((source, source_ref, args.expected_source_head, "source controller"),
                                       (target, target_ref, args.expected_target_head, "target controller"),
                                       (product, product_ref, args.expected_product_head, "product integration owner")):
        attached(root, ref, label); exact_head(root, ref, expected, label); clean(root, label)
    registered_path = snapshot(single_config(product, "juno.controller.path"))
    registered_branch = snapshot(single_config(product, "juno.controller.branch"))
    registered_path_matches = (registered_path["present"] and registered_path["value"] is not None
                               and Path(registered_path["value"]).expanduser().resolve() == source)
    registered_branch_matches = (registered_branch["present"] and registered_branch["value"] in
                                 {source_ref, source_ref.removeprefix("refs/heads/")})
    if not registered_path_matches or not registered_branch_matches:
        raise RegistrationError(f"source controller is not the exact current registration: path={registered_path!r} branch={registered_branch!r}")
    target_role = snapshot(single_config(target, "juno.workspace.role", worktree=True))
    if target_role != {"present": True, "value": "controller-pending"}:
        raise RegistrationError("target controller is not in the prepared pending role")
    source_role = snapshot(single_config(source, "juno.workspace.role", worktree=True))
    if source_role not in ({"present": True, "value": "controller"}, {"present": False, "value": None}):
        raise RegistrationError("source controller carries a foreign workspace role")
    source_routing = resolver_evidence(source)
    if source_routing != {"valid": True, "path": str(source), "role": "controller", "source": "registration", "operation": "kanban"}:
        raise RegistrationError("source controller does not pass active Kanban routing preflight")
    product_role = snapshot(single_config(product, "juno.workspace.role", worktree=True))
    product_authority = snapshot(single_config(product, "juno.workspace.roleAuthority", worktree=True))
    product_role_base = snapshot(single_config(product, "juno.workspace.roleBase", worktree=True))
    absent = {"present": False, "value": None}
    if any(value != absent for value in (product_role, product_authority, product_role_base)):
        raise RegistrationError("product integration owner must be fresh and carry no role, authority, or role base")
    output = args.output.resolve(); outside_repositories(output, [source, target, product], common)
    runtime = runtime_identity(args.runtime, args.runtime_version)
    payload = {
        "schema_version": PLAN_SCHEMA, "operation": "registration-plan", "outcome": "planned_no_mutation",
        "git_common_dir": str(common),
        "source": {"path": str(source), "ref": source_ref, "head": args.expected_source_head},
        "target": {"path": str(target), "ref": target_ref, "head": args.expected_target_head},
        "product": {"path": str(product), "ref": product_ref, "head": args.expected_product_head},
        "runtime": runtime,
        "policy": policy_identity(args.policy_bundle.resolve(), args.inventory.resolve(), target, product,
                                  target_ref, product_ref, args.expected_product_head, runtime),
        "pending_verification": pending_verification_identity(args.pending_verification.resolve(), target, target_ref, args.expected_target_head),
        "before": {"path": registered_path, "branch": registered_branch, "target_role": target_role,
                   "source_role": source_role, "product_role": product_role,
                   "product_authority": product_authority, "product_role_base": product_role_base},
        "registration_authorized": False, "product_ref_mutation": False,
        "preserve_source_controller": True, "source_routing": source_routing,
    }
    immutable(output, payload)
    return payload


def resolver_evidence(target: Path) -> dict[str, Any]:
    sibling = Path(__file__).resolve().with_name("controller_resolver.py")
    spec = importlib.util.spec_from_file_location("juno_registration_resolver", sibling)
    if spec is None or spec.loader is None:
        raise RegistrationError("packaged controller resolver is unavailable")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    saved = {key: os.environ.pop(key) for key in ("JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE") if key in os.environ}
    try:
        value = module.resolve(target, "kanban")
    except Exception as exc:
        raise RegistrationError(f"controller routing verification failed: {exc}") from exc
    finally:
        os.environ.update(saved)
    return {"valid": value.get("valid"), "path": value.get("path"), "role": value.get("role"),
            "source": value.get("source"), "operation": value.get("operation")}


def strict_product_kanban_refusal(product: Path, controller: Path) -> dict[str, Any]:
    """Prove the registered integration owner routes correctly but cannot write Kanban."""
    sibling = Path(__file__).resolve().with_name("controller_resolver.py")
    spec = importlib.util.spec_from_file_location("juno_registration_strict_resolver", sibling)
    if spec is None or spec.loader is None:
        raise RegistrationError("packaged controller resolver is unavailable")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    controlled = ("JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT")
    saved = {key: os.environ.pop(key) for key in controlled if key in os.environ}
    os.environ["JUNO_WORKSPACE_ENFORCEMENT"] = "strict"
    try:
        try:
            module.resolve(product, "kanban")
        except module.ResolverError as exc:
            value = exc.result
        else:
            raise RegistrationError("strict integration-owner Kanban write was not refused")
    finally:
        for key in controlled:
            os.environ.pop(key, None)
        os.environ.update(saved)
    diagnostics = value.get("diagnostics", [])
    expected_message = "integration-owner workspace refuses kanban writes"
    passed = (value.get("valid") is False and value.get("path") == str(controller)
              and value.get("source") == "registration" and value.get("role") == "integration-owner"
              and value.get("role_authority") == "protected-integration.v1"
              and value.get("role_base") == git(product, "rev-parse", "HEAD")
              and value.get("operation") == "kanban"
              and any(expected_message in str(message) for message in diagnostics))
    return {"passed": passed, "valid": value.get("valid"), "path": value.get("path"),
            "source": value.get("source"), "role": value.get("role"),
            "role_authority": value.get("role_authority"), "role_base": value.get("role_base"),
            "operation": value.get("operation"), "diagnostics": diagnostics}


def checkpoint_evidence(target: Path) -> dict[str, Any]:
    script = Path(__file__).resolve().with_name("controller_checkpoint.py")
    result = run([sys.executable, str(script), "--root", str(target), "require-clean", "--json"], target, False)
    if result.returncode:
        raise RegistrationError(f"controller checkpoint admission failed: {result.stderr.strip() or result.stdout.strip()}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RegistrationError("controller checkpoint returned malformed evidence") from exc
    return {"outcome": payload.get("outcome"), "head": payload.get("head"),
            "branch": payload.get("branch"), "selected_count": len(payload.get("selected", []))}


def verify_direction(plan: dict[str, Any], direction: str, *, run_checkpoint: bool = True) -> dict[str, Any]:
    source, target, product, _ = verify_frozen(plan)
    state = registration_state(product, plan)
    expected = "after" if direction == "apply" else "before"
    route_root = target if direction == "apply" else source
    routing = resolver_evidence(route_root) if state["classification"] == expected else None
    strict_refusal = (strict_product_kanban_refusal(product, target)
                      if direction == "apply" and state["classification"] == expected else None)
    checkpoint = checkpoint_evidence(route_root) if routing and run_checkpoint else None
    passed = state["classification"] == expected and routing == {
        "valid": True, "path": str(route_root), "role": "controller", "source": "registration", "operation": "kanban"
    } and (direction != "apply" or bool(strict_refusal and strict_refusal["passed"]))
    return {"direction": direction, "passed": passed, "registration": state,
            "routing": routing, "product_ref": plan["product"]["ref"],
            "product_head": git(product, "rev-parse", f"{plan['product']['ref']}^{{commit}}"),
            "controllers_clean": not git(source, "status", "--porcelain=v2", "--untracked-files=all", check=False)
                                 and not git(target, "status", "--porcelain=v2", "--untracked-files=all", check=False),
            "checkpoint_admission": checkpoint, "kanban_write_route_verified": bool(routing),
            "strict_product_kanban_refusal": strict_refusal,
            "kanban_mutation_performed": False}


def maybe_crash(boundary: str) -> None:
    if os.environ.get("JUNO_CONTROLLER_REGISTRATION_TEST_MODE") == "1" and os.environ.get("JUNO_CONTROLLER_REGISTRATION_CRASH_AFTER") == boundary:
        raise RegistrationError(f"simulated crash after {boundary}")


def transition(args: argparse.Namespace, direction: str) -> dict[str, Any]:
    if not args.authorize:
        raise RegistrationError(f"{direction} requires its explicit authorization flag")
    plan_path = args.plan.resolve(); plan = load_plan(plan_path)
    source, target, product, common = verify_frozen(plan)
    output = args.output.resolve(); outside_repositories(output, [source, target, product], common)
    intent = output.with_name(output.name + ".intent.json")
    protected_inputs = {plan_path, Path(plan["policy"]["path"]).resolve(), Path(plan["policy"]["inventory_path"]).resolve(),
                        Path(plan["runtime"]["path"]).resolve(),
                        Path(plan["pending_verification"]["path"]).resolve()}
    if output in protected_inputs or intent in protected_inputs:
        raise RegistrationError("transition receipts must be distinct from every immutable input")
    if output.exists():
        existing = read_json(output, f"registration {direction} receipt")
        if (existing.get("schema_version") != RECEIPT_SCHEMA
                or existing.get("operation") != f"registration-{direction}"
                or existing.get("plan_sha256") != file_sha256(plan_path)):
            raise RegistrationError("existing transition output collides with this operation")
    intent_payload = {"schema_version": RECEIPT_SCHEMA, "operation": f"registration-{direction}-intent",
                      "outcome": "intent_persisted_before_mutation", "plan_sha256": file_sha256(plan_path),
                      "desired_state": direction, "product_ref_mutation": False}
    immutable(intent, intent_payload)
    with registration_lock(common, [plan["source"]["ref"], plan["target"]["ref"], plan["product"]["ref"]]):
        verify_frozen(plan)
        state = registration_state(product, plan)
        if state["classification"] == "foreign_mismatch":
            raise RegistrationError("registration state differs from both frozen endpoints; refusing mutation")
        desired_classification = "after" if direction == "apply" else "before"
        if state["classification"] == desired_classification and output.exists():
            existing = read_json(output, f"registration {direction} receipt")
            if (existing.get("schema_version") != RECEIPT_SCHEMA
                    or existing.get("operation") != f"registration-{direction}"
                    or existing.get("plan_sha256") != file_sha256(plan_path)
                    or existing.get("evidence", {}).get("passed") is not True):
                raise RegistrationError("existing transition receipt does not bind the exact achieved state")
            return existing
        if direction == "apply":
            set_config(source, "juno.workspace.role", "controller-retired", worktree=True); maybe_crash("source-role")
            set_config(target, "juno.workspace.role", "controller", worktree=True); maybe_crash("target-role")
            set_config(product, "juno.controller.path", plan["target"]["path"]); maybe_crash("controller-path")
            set_config(product, "juno.controller.branch", plan["target"]["ref"]); maybe_crash("controller-branch")
            set_config(product, "juno.workspace.role", "integration-owner", worktree=True); maybe_crash("product-role")
            set_config(product, "juno.workspace.roleAuthority", "protected-integration.v1", worktree=True); maybe_crash("product-authority")
            set_config(product, "juno.workspace.roleBase", plan["product"]["head"], worktree=True); maybe_crash("product-role-base")
        else:
            restore_config(product, "juno.workspace.roleBase", plan["before"]["product_role_base"], worktree=True); maybe_crash("product-role-base")
            restore_config(product, "juno.workspace.roleAuthority", plan["before"]["product_authority"], worktree=True); maybe_crash("product-authority")
            restore_config(product, "juno.workspace.role", plan["before"]["product_role"], worktree=True); maybe_crash("product-role")
            restore_config(product, "juno.controller.path", plan["before"]["path"]); maybe_crash("controller-path")
            restore_config(product, "juno.controller.branch", plan["before"]["branch"]); maybe_crash("controller-branch")
            restore_config(target, "juno.workspace.role", plan["before"]["target_role"], worktree=True); maybe_crash("target-role")
            restore_config(source, "juno.workspace.role", plan["before"]["source_role"], worktree=True); maybe_crash("source-role")
        evidence = verify_direction(plan, direction, run_checkpoint=False)
        if not evidence["passed"]:
            raise RegistrationError(f"{direction} readback failed")
    route_root = target if direction == "apply" else source
    evidence["checkpoint_admission"] = checkpoint_evidence(route_root)
    payload = {"schema_version": RECEIPT_SCHEMA, "operation": f"registration-{direction}",
               "outcome": "registered" if direction == "apply" else "rolled_back",
               "plan_sha256": file_sha256(plan_path), "intent_sha256": file_sha256(intent),
               "product_ref_mutation": False, "source_controller_preserved": True,
               "evidence": evidence}
    immutable(output, payload)
    return payload


def verify_command(args: argparse.Namespace) -> dict[str, Any]:
    plan_path = args.plan.resolve(); plan = load_plan(plan_path)
    source, target, product, common = verify_frozen(plan)
    outside_repositories(args.output.resolve(), [source, target, product], common)
    state = registration_state(product, plan)
    direction = "apply" if state["classification"] == "after" else "rollback" if state["classification"] == "before" else None
    evidence = verify_direction(plan, direction) if direction else {
        "direction": None, "passed": False, "registration": state,
        "recovery": "rerun the authorized apply or rollback using the same immutable plan" if state["classification"] == "recoverable_partial" else "review foreign Git config before retrying",
    }
    payload = {"schema_version": RECEIPT_SCHEMA, "operation": "registration-verify",
               "outcome": "verified" if evidence["passed"] else "partial_or_mismatched",
               "plan_sha256": file_sha256(plan_path), "evidence": evidence}
    immutable(args.output.resolve(), payload)
    if not evidence["passed"]:
        raise RegistrationError("registration verification found partial or foreign state")
    return payload


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan")
    for name in ("source-controller", "target-controller", "product-root", "runtime", "inventory", "policy-bundle", "pending-verification", "output"):
        plan.add_argument(f"--{name}", type=Path, required=True)
    for name in ("source-ref", "expected-source-head", "target-ref", "expected-target-head", "product-ref", "expected-product-head", "runtime-version"):
        plan.add_argument(f"--{name}", required=True)
    for name in ("apply", "rollback"):
        item = sub.add_parser(name); item.add_argument("--plan", type=Path, required=True); item.add_argument("--output", type=Path, required=True)
        item.add_argument(f"--authorize-{name}", dest="authorize", action="store_true")
    verify = sub.add_parser("verify"); verify.add_argument("--plan", type=Path, required=True); verify.add_argument("--output", type=Path, required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    if args.command == "plan": payload = plan_command(args)
    elif args.command == "apply": payload = transition(args, "apply")
    elif args.command == "rollback": payload = transition(args, "rollback")
    else: payload = verify_command(args)
    print(json.dumps({"outcome": payload["outcome"], "receipt": str(args.output.resolve())}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (RegistrationError, OSError) as exc:
        print(f"controller-registration: {exc}", file=sys.stderr)
        raise SystemExit(2)
