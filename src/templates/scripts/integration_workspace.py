#!/usr/bin/env python3
"""Offline integration-owner diagnostics and guarded target synchronization."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import task_workspace

SCHEMA = "juno_integration_workspace.v1"
POLICY_SCHEMA = "juno_integration_workspace_policy.v1"
AUTHORITY = "protected-integration.v1"
OWNER_CONFIG = "juno.integration.ownerPath"
LEGACY_OWNER_CONFIG = "juno.gitFlow.integrationCheckout"
SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")


MANAGED_RUNTIME_SCHEMA = "juno_managed_controller_runtime.v1"
MANAGED_MANIFEST_PATH = "juno-code/src/templates/managed-assets.json"
MANAGED_POLICY_PATH = ".juno_task/config/task-workspace.json"
MANAGED_GENERATION_PATH = ".juno_task/runtime/managed-controller/generation.json"
MANAGED_RECEIPT_ROOT = ".juno_task/runtime/managed-controller/receipts"
MANAGED_SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")


class ManagedRuntimeError(RuntimeError):
    def __init__(self, message: str, receipt: dict[str, str] | None = None):
        super().__init__(message)
        self.receipt = receipt


def managed_run(argv: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        detail = (result.stderr or result.stdout).decode(errors="replace").strip()
        raise ManagedRuntimeError(detail or f"command failed: {argv!r}")
    return result


def git_bytes(repository: Path, *args: str) -> bytes:
    return managed_run(["git", "-C", str(repository), *args], repository).stdout


def managed_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def managed_exact_commit(repository: Path, value: str, label: str) -> str:
    if not MANAGED_SHA_RE.fullmatch(value):
        raise ManagedRuntimeError(f"{label} is not a full commit SHA")
    observed = git_bytes(repository, "rev-parse", "--verify", f"{value}^{{commit}}").decode().strip()
    if observed != value:
        raise ManagedRuntimeError(f"{label} does not resolve exactly")
    return value


def managed_source_bytes(repository: Path, commit: str, relative: str) -> bytes:
    if relative.startswith("/") or ".." in Path(relative).parts or ".git" in Path(relative).parts:
        raise ManagedRuntimeError(f"unsafe managed source path: {relative}")
    return git_bytes(repository, "show", f"{commit}:{relative}")


def managed_source_json(repository: Path, commit: str, relative: str) -> Any:
    try:
        return json.loads(managed_source_bytes(repository, commit, relative))
    except json.JSONDecodeError as exc:
        raise ManagedRuntimeError(f"invalid target JSON at {relative}: {exc}") from exc


def managed_script_destinations(repository: Path, commit: str) -> list[str]:
    manifest = managed_source_json(repository, commit, MANAGED_MANIFEST_PATH)
    assets = manifest.get("assets") if isinstance(manifest, dict) else None
    if manifest.get("schemaVersion") != 1 or not isinstance(assets, list):
        raise ManagedRuntimeError("target managed asset definition is invalid")
    result = []
    for asset in assets:
        if not isinstance(asset, dict) or asset.get("installClass") not in {"project", "script"}:
            raise ManagedRuntimeError("target managed asset entry is invalid")
        if asset["installClass"] != "script":
            continue
        destination = asset.get("destination")
        source = asset.get("source")
        expected_source = destination.removeprefix(".juno_task/")
        if (not isinstance(destination, str) or not destination.startswith(".juno_task/scripts/")
                or source != expected_source):
            raise ManagedRuntimeError("managed script source/destination mapping is ambiguous")
        result.append(destination)
    if not result or len(result) != len(set(result)):
        raise ManagedRuntimeError("target managed script set is empty or duplicated")
    return sorted(result)


def managed_package_version(repository: Path, commit: str) -> str:
    package = managed_source_json(repository, commit, "juno-code/package.json")
    version = package.get("version") if isinstance(package, dict) else None
    if not isinstance(version, str) or not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+-]*", version):
        raise ManagedRuntimeError("target package version is invalid")
    return version


def managed_safe_path(controller: Path, relative: str) -> Path:
    destination = (controller / relative).resolve()
    try:
        destination.relative_to(controller.resolve())
    except ValueError as exc:
        raise ManagedRuntimeError(f"managed destination escapes controller: {relative}") from exc
    cursor = controller.resolve()
    for part in Path(relative).parts:
        cursor /= part
        if cursor.is_symlink():
            raise ManagedRuntimeError(f"managed destination contains a symbolic link: {relative}")
    return destination


def managed_policy_projection(previous: dict[str, Any], target: dict[str, Any], current: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    if not all(isinstance(value, dict) for value in (previous, target, current)):
        raise ManagedRuntimeError("task policy generations must be JSON objects")
    result = dict(current)
    changed: list[str] = []
    missing = object()
    for key in sorted(set(previous) | set(target)):
        old = previous.get(key, missing)
        new = target.get(key, missing)
        if old == new:
            continue
        observed = current.get(key, missing)
        if observed == new:
            continue
        if observed != old:
            raise ManagedRuntimeError(f"tracked task policy has an overlapping manual change: {key}")
        if new is missing:
            result.pop(key, None)
        else:
            result[key] = new
        changed.append(key)
    return result, changed


def managed_canonical_json(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=False) + "\n").encode()


def managed_atomic_write(path: Path, data: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def managed_receipt_write(path: Path, value: dict[str, Any]) -> dict[str, str]:
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    managed_atomic_write(path, data, 0o600)
    return {"path": str(path.resolve()), "sha256": managed_sha256(data)}


def managed_allocate_log(workflow: str, task_id: str) -> tuple[Path, Any]:
    safe_workflow = re.sub(r"[^A-Za-z0-9_.-]+", "-", workflow).strip("-") or "runtime"
    safe_task = re.sub(r"[^A-Za-z0-9_.-]+", "-", task_id).strip("-") or "target"
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    for sequence in range(1000):
        suffix = "" if sequence == 0 else f"-{sequence}"
        path = Path("/tmp") / f"yy-{safe_workflow}-{safe_task}-{stamp}-{os.getpid()}{suffix}.log"
        try:
            handle = path.open("x", encoding="utf-8")
            return path, handle
        except FileExistsError:
            continue
        except OSError as exc:
            raise ManagedRuntimeError(f"managed runtime log allocation failed: {exc}") from exc
    raise ManagedRuntimeError("managed runtime log namespace exhausted")


def managed_tracked_policy_dirty(controller: Path) -> bool:
    tracked = managed_run(["git", "-C", str(controller), "ls-files", "--error-unmatch", "--", MANAGED_POLICY_PATH],
                  controller, check=False)
    if tracked.returncode:
        raise ManagedRuntimeError("tracked task policy is absent or ambiguous")
    dirty = managed_run(["git", "-C", str(controller), "status", "--porcelain=v1", "--", MANAGED_POLICY_PATH],
                controller).stdout
    return bool(dirty)


def managed_runtime_plan(controller: Path, repository: Path, previous_sha: str, target_sha: str) -> dict[str, Any]:
    controller = controller.resolve(); repository = repository.resolve()
    previous_sha = managed_exact_commit(repository, previous_sha, "previous generation")
    target_sha = managed_exact_commit(repository, target_sha, "target generation")
    if managed_run(["git", "-C", str(repository), "merge-base", "--is-ancestor", previous_sha, target_sha],
           repository, check=False).returncode:
        raise ManagedRuntimeError("target generation does not descend from previous generation")
    policy_dirty = managed_tracked_policy_dirty(controller)
    scripts = set(managed_script_destinations(repository, target_sha))
    prior_scripts = set(managed_script_destinations(repository, previous_sha))
    actions = []
    for relative in sorted(scripts | prior_scripts):
        destination = managed_safe_path(controller, relative)
        old = managed_source_bytes(repository, previous_sha, relative) if relative in prior_scripts else None
        new = managed_source_bytes(repository, target_sha, relative) if relative in scripts else None
        current = destination.read_bytes() if destination.exists() else None
        classification = "exact"
        if new is None:
            if current is not None and current != old:
                raise ManagedRuntimeError(f"customized retired managed runtime is preserved: {relative}")
            outcome = "unchanged" if current is None else "removed"
            classification = "retired"
            actual = None
        elif current is not None and current not in {old, new}:
            if old != new:
                raise ManagedRuntimeError(f"customized managed runtime overlaps changed source: {relative}")
            # The packaged source is identical on both sides of the admitted
            # transition, so this owner customization is unrelated to it.
            outcome = "preserved_customization"
            classification = "preserved_customization"
            actual = current
        else:
            outcome = "unchanged" if current == new else "installed" if current is None else "updated"
            actual = new
        actions.append({"path": relative, "classification": classification,
                        "before_sha256": managed_sha256(current) if current is not None else None,
                        "actual_sha256": managed_sha256(actual) if actual is not None else None,
                        "source_sha256": managed_sha256(new) if new is not None else None, "bytes": new,
                        "outcome": outcome})
    # A retry may upgrade the original exact-only generation format, but it must
    # never reclassify drift after a terminal generation as a new customization.
    generation_path = managed_safe_path(controller, MANAGED_GENERATION_PATH)
    try:
        existing_generation = json.loads(generation_path.read_text())
    except FileNotFoundError:
        existing_generation = None
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagedRuntimeError(f"managed generation receipt is invalid: {exc}") from exc
    if isinstance(existing_generation, dict) and existing_generation.get("target_sha") == target_sha:
        existing_scripts = existing_generation.get("scripts")
        if not isinstance(existing_scripts, dict):
            raise ManagedRuntimeError("existing managed generation identity has drifted")
        for row in actions:
            if row["source_sha256"] is None:
                continue
            entry = existing_scripts.get(row["path"])
            bound_actual = entry if isinstance(entry, str) else (
                entry.get("actual_sha256") if isinstance(entry, dict)
                and entry.get("source_sha256") == row["source_sha256"]
                and entry.get("classification") in {"exact", "preserved_customization"} else None)
            if bound_actual != row["before_sha256"]:
                raise ManagedRuntimeError(f"existing managed generation drift: {row['path']}")
    previous_policy = managed_source_json(repository, previous_sha, MANAGED_POLICY_PATH)
    target_policy = managed_source_json(repository, target_sha, MANAGED_POLICY_PATH)
    policy_path = managed_safe_path(controller, MANAGED_POLICY_PATH)
    try:
        current_policy_bytes = policy_path.read_bytes()
        current_policy = json.loads(current_policy_bytes)
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagedRuntimeError(f"controller task policy is invalid: {exc}") from exc
    projected, changed_fields = managed_policy_projection(previous_policy, target_policy, current_policy)
    if policy_dirty:
        generation_path = managed_safe_path(controller, MANAGED_GENERATION_PATH)
        try:
            generation = json.loads(generation_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ManagedRuntimeError("tracked task policy has uncommitted dirt") from exc
        if (not isinstance(generation, dict) or generation.get("schema_version") != MANAGED_RUNTIME_SCHEMA
                or generation.get("target_sha") != target_sha
                or generation.get("policy_sha256") != managed_sha256(current_policy_bytes)):
            raise ManagedRuntimeError("tracked task policy has uncommitted dirt")
    # A no-op target transition must not normalize owner formatting and create
    # tracked dirt. Canonical bytes are emitted only when admitted fields change.
    projected_bytes = managed_canonical_json(projected) if changed_fields else current_policy_bytes
    return {"controller": str(controller), "repository": str(repository),
            "previous_sha": previous_sha, "target_sha": target_sha,
            "package_version": managed_package_version(repository, target_sha), "scripts": actions,
            "policy": {"path": MANAGED_POLICY_PATH, "before_sha256": managed_sha256(current_policy_bytes),
                       "after_sha256": managed_sha256(projected_bytes), "changed_fields": changed_fields,
                       "bytes": projected_bytes}}


def managed_runtime_refresh(controller: Path, repository: Path, previous_sha: str, target_sha: str,
            *, task_id: str = "target") -> dict[str, Any]:
    started = time.time(); started_mono = time.monotonic()
    log_path, log = managed_allocate_log("managed-runtime-refresh", task_id)
    print(f"yy managed-runtime-refresh log: {log_path}", file=sys.stderr, flush=True)
    receipt_path = managed_safe_path(controller.resolve(), f"{MANAGED_RECEIPT_ROOT}/{time.time_ns()}-{os.getpid()}.json")
    receipt: dict[str, Any] = {"schema_version": MANAGED_RUNTIME_SCHEMA, "operation": "refresh",
                              "outcome": "running", "previous_sha": previous_sha,
                              "target_sha": target_sha, "task_id": task_id}
    backups: dict[Path, tuple[bool, bytes, int]] = {}
    reference: dict[str, str] | None = None
    try:
        operation = managed_runtime_plan(controller, repository, previous_sha, target_sha)
        log.write(f"source target={target_sha} package={operation['package_version']}\n"); log.flush()
        writes = [(managed_safe_path(controller, row["path"]), row["bytes"],
                   None if row["outcome"] == "removed" else 0o755)
                  for row in operation["scripts"]
                  if row["outcome"] in {"installed", "updated", "removed"}]
        if operation["policy"]["before_sha256"] != operation["policy"]["after_sha256"]:
            writes.append((managed_safe_path(controller, MANAGED_POLICY_PATH), operation["policy"]["bytes"], 0o644))
        generation_path = managed_safe_path(controller, MANAGED_GENERATION_PATH)
        generation = {"schema_version": MANAGED_RUNTIME_SCHEMA, "target_sha": target_sha,
                      "package_version": operation["package_version"],
                      "scripts": {row["path"]: {
                          "classification": row["classification"],
                          "source_sha256": row["source_sha256"],
                          "actual_sha256": row["actual_sha256"],
                      } for row in operation["scripts"] if row["source_sha256"] is not None},
                      "policy_sha256": operation["policy"]["after_sha256"]}
        writes.append((generation_path, managed_canonical_json(generation), 0o600))
        for destination, _, _ in writes:
            backups[destination] = (destination.exists(), destination.read_bytes() if destination.exists() else b"",
                                    destination.stat().st_mode & 0o777 if destination.exists() else 0)
        for destination, data, mode in writes:
            if data is None:
                destination.unlink(missing_ok=True)
                log.write(f"remove {destination}\n")
            else:
                managed_atomic_write(destination, data, mode)
                log.write(f"write {destination} sha256={managed_sha256(data)}\n")
            log.flush()
        doctor = managed_runtime_inspect(controller, repository, target_sha)
        if not doctor["healthy"]:
            raise ManagedRuntimeError("post-refresh doctor did not reach a coherent generation")
        receipt.update({"outcome": "completed", "package_version": operation["package_version"],
                        "scripts": [{key: value for key, value in row.items() if key != "bytes"}
                                    for row in operation["scripts"]],
                        "policy": {key: value for key, value in operation["policy"].items() if key != "bytes"},
                        "doctor": doctor})
    except BaseException as exc:
        for destination, (existed, data, mode) in reversed(list(backups.items())):
            try:
                if existed: managed_atomic_write(destination, data, mode)
                else: destination.unlink(missing_ok=True)
            except OSError:
                pass
        receipt.update({"outcome": "failed", "error": str(exc),
                        "termination": "interrupted" if isinstance(exc, KeyboardInterrupt)
                        else "failure"})
    finally:
        finish = time.time(); duration = time.monotonic() - started_mono
        log.write(f"finish outcome={receipt['outcome']} duration_seconds={duration:.6f}\n")
        log.flush(); os.fsync(log.fileno()); log.close()
        log_data = log_path.read_bytes()
        receipt.setdefault("termination", "success")
        receipt.update({"start_time": started, "finish_time": finish,
                        "duration_seconds": duration, "exit_code": 0 if receipt["outcome"] == "completed" else 2,
                        "signal": None, "timed_out": False,
                        "log": {"path": str(log_path), "sha256": managed_sha256(log_data)}})
        reference = managed_receipt_write(receipt_path, receipt)
    result = {**receipt, "receipt": reference}
    if receipt["outcome"] != "completed":
        raise ManagedRuntimeError(receipt.get("error", "managed runtime refresh failed"), reference)
    return result


def managed_runtime_inspect(controller: Path, repository: Path, target_sha: str) -> dict[str, Any]:
    controller = controller.resolve(); repository = repository.resolve()
    target_sha = managed_exact_commit(repository, target_sha, "doctor target generation")
    findings = []
    generation_path = managed_safe_path(controller, MANAGED_GENERATION_PATH)
    generation = None
    try:
        generation = json.loads(generation_path.read_text())
    except (OSError, json.JSONDecodeError):
        findings.append({"code": "managed_generation_receipt_missing_or_invalid", "path": MANAGED_GENERATION_PATH})
    policy_path = managed_safe_path(controller, MANAGED_POLICY_PATH)
    policy_hash = managed_sha256(policy_path.read_bytes()) if policy_path.is_file() else None
    expected_paths = managed_script_destinations(repository, target_sha)
    generation_scripts = generation.get("scripts") if isinstance(generation, dict) else None
    identity_valid = (isinstance(generation, dict)
                      and generation.get("schema_version") == MANAGED_RUNTIME_SCHEMA
                      and generation.get("target_sha") == target_sha
                      and generation.get("package_version") == managed_package_version(repository, target_sha)
                      and generation.get("policy_sha256") == policy_hash
                      and isinstance(generation_scripts, dict)
                      and set(generation_scripts) == set(expected_paths))
    scripts: dict[str, dict[str, Any]] = {}
    for relative in expected_paths:
        source_hash = managed_sha256(managed_source_bytes(repository, target_sha, relative))
        destination = managed_safe_path(controller, relative)
        actual_hash = managed_sha256(destination.read_bytes()) if destination.is_file() else None
        entry = generation_scripts.get(relative) if isinstance(generation_scripts, dict) else None
        entry_valid = (isinstance(entry, dict)
                       and set(entry) == {"classification", "source_sha256", "actual_sha256"}
                       and entry.get("classification") in {"exact", "preserved_customization"}
                       and entry.get("source_sha256") == source_hash
                       and isinstance(entry.get("actual_sha256"), str)
                       and bool(re.fullmatch(r"[0-9a-f]{64}", entry["actual_sha256"])))
        if entry_valid and entry["classification"] == "exact" and entry["actual_sha256"] != source_hash:
            entry_valid = False
        if (entry_valid and entry["classification"] == "preserved_customization"
                and entry["actual_sha256"] == source_hash):
            entry_valid = False
        identity_valid = identity_valid and entry_valid
        classification = entry["classification"] if entry_valid else "unbound"
        bound_actual = entry["actual_sha256"] if entry_valid else source_hash
        scripts[relative] = {"classification": classification, "source_sha256": source_hash,
                             "actual_sha256": actual_hash, "bound_actual_sha256": bound_actual}
        if actual_hash != bound_actual:
            if classification == "preserved_customization":
                code = "managed_preserved_customization_drift"
            else:
                code = "managed_runtime_missing" if actual_hash is None else "managed_runtime_drift"
            findings.append({"code": code, "path": relative, "expected_sha256": bound_actual,
                             "source_sha256": source_hash, "actual_sha256": actual_hash,
                             "classification": classification})
    if not identity_valid:
        findings.append({"code": "managed_generation_identity_drift", "path": MANAGED_GENERATION_PATH})
    return {"schema_version": MANAGED_RUNTIME_SCHEMA, "operation": "doctor", "target_sha": target_sha,
            "package_version": managed_package_version(repository, target_sha),
            "policy_sha256": policy_hash, "scripts": scripts,
            "findings": findings, "healthy": not findings}


class IntegrationError(RuntimeError):
    pass


def run(argv: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True,
                            stdin=subprocess.DEVNULL,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if check and result.returncode:
        raise IntegrationError(result.stderr.strip() or result.stdout.strip()
                               or f"command failed: {argv!r}")
    return result


def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check=check).stdout.strip()


def exact_root(path: Path, label: str) -> Path:
    candidate = path.expanduser().resolve()
    top = git(candidate, "rev-parse", "--show-toplevel", check=False)
    if not top or Path(top).resolve() != candidate:
        raise IntegrationError(f"{label} is not an exact Git worktree: {candidate}")
    return candidate


def load_policy(controller: Path) -> tuple[dict[str, Any], dict[str, Any], Path]:
    policy_path = controller / ".juno_task/config/integration-workspace.json"
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IntegrationError(f"invalid integration workspace policy: {exc}") from exc
    required = {"schema_version", "remote", "owner_role_authority", "receipt_root"}
    if (not isinstance(policy, dict) or set(policy) != required
            or policy.get("schema_version") != POLICY_SCHEMA):
        raise IntegrationError(f"integration policy must contain exactly the {POLICY_SCHEMA} fields")
    if (not isinstance(policy["remote"], str) or not policy["remote"]
            or policy["owner_role_authority"] != AUTHORITY):
        raise IntegrationError("integration policy remote or role authority is invalid")
    receipt_root = Path(policy["receipt_root"])
    if receipt_root.is_absolute() or ".." in receipt_root.parts:
        raise IntegrationError("integration receipt_root must stay inside the controller")
    task_policy = task_workspace.load_config(controller)
    return policy, task_policy, policy_path


def parse_worktrees(repository: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    row: dict[str, Any] = {}
    for line in [*git(repository, "worktree", "list", "--porcelain").splitlines(), ""]:
        if not line:
            if row:
                rows.append(row); row = {}
            continue
        key, _, value = line.partition(" ")
        row[key] = value or True
    return rows


def worktree_config(root: Path, key: str) -> str | None:
    value = git(root, "config", "--worktree", "--get", key, check=False)
    return value or None


def advance_owner_role_base(owner: Path, before: str | None, after: str) -> dict[str, Any]:
    """Advance only the protected owner's exact worktree-local authority baseline."""
    if not SHA_RE.fullmatch(after) or sha(owner, after) != after:
        raise IntegrationError("integration owner roleBase target is not an exact commit")
    observed = worktree_config(owner, "juno.workspace.roleBase")
    if observed != before:
        raise IntegrationError("integration owner roleBase changed under lock")
    if worktree_config(owner, "juno.workspace.role") != "integration-owner":
        raise IntegrationError("integration owner role is not registered")
    if worktree_config(owner, "juno.workspace.roleAuthority") != AUTHORITY:
        raise IntegrationError("integration owner does not carry protected authority")
    git(owner, "config", "--worktree", "juno.workspace.roleBase", after)
    if worktree_config(owner, "juno.workspace.roleBase") != after:
        raise IntegrationError("integration owner roleBase readback failed")
    return {"kind": "advance_role_base", "path": str(owner),
            "before": before, "after": after}


def owner_candidates(repository: Path) -> list[dict[str, Any]]:
    candidates = []
    for row in parse_worktrees(repository):
        raw = row.get("worktree")
        if not isinstance(raw, str) or row.get("prunable") is True:
            continue
        root = Path(raw).resolve()
        if not root.is_dir():
            continue
        if worktree_config(root, "juno.workspace.role") == "integration-owner":
            candidates.append({"path": str(root), "authority": worktree_config(
                root, "juno.workspace.roleAuthority")})
    return sorted(candidates, key=lambda item: item["path"])


def registered_owner(repository: Path) -> str | None:
    value = git(repository, "config", "--local", "--get", OWNER_CONFIG, check=False)
    return str(Path(value).expanduser().resolve()) if value else None


def sha(repository: Path, ref: str) -> str | None:
    value = git(repository, "rev-parse", "--verify", f"{ref}^{{commit}}", check=False)
    return value if SHA_RE.fullmatch(value) else None


def relation(repository: Path, left: str | None, right: str | None) -> dict[str, int | None]:
    if not left or not right:
        return {"ahead": None, "behind": None}
    value = git(repository, "rev-list", "--left-right", "--count", f"{left}...{right}", check=False)
    match = re.fullmatch(r"(\d+)\s+(\d+)", value)
    return ({"ahead": int(match.group(1)), "behind": int(match.group(2))}
            if match else {"ahead": None, "behind": None})


def full_checkout(root: Path) -> tuple[bool, list[str]]:
    reasons = []
    if worktree_config(root, "core.sparseCheckout") == "true":
        reasons.append("sparse_checkout_enabled")
    if any(line.startswith("S ") for line in git(root, "ls-files", "-t", check=False).splitlines()):
        reasons.append("skip_worktree_paths_present")
    return not reasons, reasons


def submodule_state(owner: Path) -> list[dict[str, str]]:
    # The leading byte is semantic (` ` exact, `-`, `+`, or `U`), so do not use
    # the normalized git() helper which intentionally strips surrounding space.
    value = run(["git", "-C", str(owner), "submodule", "status", "--recursive"],
                owner, check=False).stdout.rstrip("\r\n")
    rows = []
    for line in value.splitlines():
        if not line:
            continue
        marker = line[0]
        parts = line[1:].strip().split()
        rows.append({"path": parts[1] if len(parts) > 1 else "",
                     "sha": parts[0] if parts else "",
                     "state": {"-": "uninitialized", "+": "wrong_gitlink",
                               "U": "conflict"}.get(marker, "exact")})
    return rows


def target_holders(repository: Path, target_ref: str) -> list[str]:
    return sorted(str(row["worktree"]) for row in parse_worktrees(repository)
                  if row.get("branch") == target_ref)


def status_payload(controller: Path, *, fetch: bool = False) -> dict[str, Any]:
    controller = exact_root(controller, "controller")
    policy, task_policy, policy_path = load_policy(controller)
    repository = task_workspace.product_repository(controller, task_policy)
    target_ref = task_policy["target_ref"]
    remote_ref = f"refs/remotes/{policy['remote']}/{target_ref.removeprefix('refs/heads/')}"
    if fetch:
        run(["git", "-C", str(repository), "fetch", "--no-tags", policy["remote"],
             f"+{target_ref}:{remote_ref}"], repository)
    target_sha = sha(repository, target_ref)
    remote_sha = sha(repository, remote_ref)
    candidates = owner_candidates(repository)
    registered = registered_owner(repository)
    selected = [item for item in candidates if item["path"] == registered]
    owner: dict[str, Any] | None = None
    findings: list[dict[str, str]] = []
    if registered and len(selected) != 1:
        findings.append({"code": "integration_owner_registration_invalid", "severity": "error",
                         "message": "registered integration owner is missing or not protected"})
    elif not registered and len(candidates) != 1:
        findings.append({"code": "integration_owner_missing" if not candidates else "integration_owner_multiple",
                         "severity": "error", "message": f"found {len(candidates)} integration owners"})
    else:
        candidate = selected[0] if selected else candidates[0]
        extras = [item for item in candidates if item["path"] != candidate["path"]]
        if not registered:
            findings.append({"code": "integration_owner_registration_missing", "severity": "warning",
                             "message": "unique protected owner is not explicitly registered"})
        if extras:
            findings.append({"code": "integration_owner_extra", "severity": "warning",
                             "message": f"found {len(extras)} non-canonical protected owner(s)"})
        root = Path(candidate["path"])
        full, reasons = full_checkout(root)
        owner = {**candidate, "head": sha(root, "HEAD"),
                 "role_base": worktree_config(root, "juno.workspace.roleBase"),
                 "detached": git(root, "symbolic-ref", "-q", "HEAD", check=False) == "",
                 "clean": git(root, "status", "--porcelain=v1", "--untracked-files=all") == "",
                 "full_checkout": full, "full_checkout_reasons": reasons,
                 "submodules": submodule_state(root)}
        if candidate["authority"] != policy["owner_role_authority"]:
            findings.append({"code": "integration_owner_wrong_authority", "severity": "error",
                             "message": "integration owner authority is not protected"})
        for key, code in (("detached", "integration_owner_attached"),
                          ("clean", "integration_owner_dirty"),
                          ("full_checkout", "integration_owner_sparse")):
            if not owner[key]:
                findings.append({"code": code, "severity": "error", "message": code.replace("_", " ")})
        if owner["head"] != target_sha:
            findings.append({"code": "integration_owner_stale", "severity": "warning",
                             "message": "integration owner HEAD differs from target"})
        role_base = owner["role_base"]
        if not role_base or not sha(repository, role_base):
            findings.append({"code": "integration_owner_role_base_invalid", "severity": "error",
                             "message": "integration owner roleBase is missing or invalid"})
        elif role_base != target_sha:
            severity = ("warning" if target_sha and run([
                "git", "-C", str(repository), "merge-base", "--is-ancestor",
                role_base, target_sha], repository, check=False).returncode == 0 else "error")
            findings.append({"code": "integration_owner_role_base_stale" if severity == "warning"
                             else "integration_owner_role_base_diverged", "severity": severity,
                             "message": "integration owner roleBase differs from target"})
    holders = target_holders(repository, target_ref)
    if holders:
        findings.append({"code": "target_checked_out", "severity": "error",
                         "message": f"target ref is attached in {len(holders)} worktree(s)"})
    rel = relation(repository, target_sha, remote_sha)
    if rel["ahead"] and rel["behind"]:
        findings.append({"code": "remote_diverged", "severity": "error",
                         "message": "local target and cached remote diverged"})
    return {"schema_version": SCHEMA, "operation": "status", "offline": not fetch,
            "controller": str(controller), "repository": str(repository),
            "policy": str(policy_path), "target": {"ref": target_ref, "sha": target_sha,
            "holders": holders}, "remote": {"name": policy["remote"], "ref": remote_ref,
            "sha": remote_sha, **rel}, "integration": {"status": "registered" if registered and owner
            else "unique" if len(candidates) == 1 else "missing" if not candidates else "multiple",
            "registered_path": registered, "candidates": candidates, "owner": owner},
            "findings": findings, "healthy": not any(row["severity"] == "error" for row in findings),
            "ready": bool(owner and owner["head"] == target_sha
                          and not any(row["severity"] == "error" for row in findings))}


def write_receipt(path: Path, value: dict[str, Any]) -> dict[str, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    return {"path": str(path.resolve()), "sha256": hashlib.sha256(data).hexdigest()}


def json_digest(value: Any) -> str:
    data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(data).hexdigest()


def operation_receipt_path(controller: Path, policy: dict[str, Any], operation: str) -> Path:
    return (controller / policy["receipt_root"] /
            f"{time.time_ns()}-{os.getpid()}-{operation}.json").resolve()


def worktree_identity(root: Path) -> dict[str, Any]:
    full, reasons = full_checkout(root)
    return {"path": str(root.resolve()), "head": sha(root, "HEAD"),
            "clean": git(root, "status", "--porcelain=v1", "--untracked-files=all") == "",
            "detached": git(root, "symbolic-ref", "-q", "HEAD", check=False) == "",
            "full_checkout": full, "full_checkout_reasons": reasons,
            "role": worktree_config(root, "juno.workspace.role"),
            "authority": worktree_config(root, "juno.workspace.roleAuthority")}


def repair_plan(controller: Path) -> dict[str, Any]:
    controller = exact_root(controller, "controller")
    policy, task_policy, policy_path = load_policy(controller)
    repository = task_workspace.product_repository(controller, task_policy)
    status = status_payload(controller)
    owner = status["integration"]["owner"]
    actions: list[dict[str, Any]] = []
    blockers: list[str] = []
    target_sha = status["target"]["sha"]
    if not owner:
        blockers.append("canonical_integration_owner_unavailable")
    else:
        if not owner["clean"] or not owner["full_checkout"] or not owner["detached"]:
            blockers.append("canonical_integration_owner_not_safe")
        if owner["head"] != target_sha:
            actions.append({"kind": "refresh_owner", "path": owner["path"],
                            "before": owner["head"], "after": target_sha})
        if owner["role_base"] != target_sha:
            actions.append({"kind": "advance_role_base", "path": owner["path"],
                            "before": owner["role_base"], "after": target_sha})
        if any(row["state"] != "exact" for row in owner["submodules"]):
            actions.append({"kind": "refresh_submodules", "path": owner["path"],
                            "target": target_sha})
    rows = {str(row.get("worktree")): row for row in parse_worktrees(repository)}
    legacy_owner = git(repository, "config", "--local", "--get",
                       LEGACY_OWNER_CONFIG, check=False)
    if legacy_owner:
        legacy_path = str(Path(legacy_owner).expanduser().resolve())
        legacy_row = rows.get(legacy_path)
        if legacy_row is None or legacy_row.get("prunable") is True:
            actions.append({"kind": "clear_legacy_integration_registration",
                            "repository": str(repository), "key": LEGACY_OWNER_CONFIG,
                            "before": legacy_path})
    for holder in status["target"]["holders"]:
        root = Path(holder)
        identity = worktree_identity(root)
        row = rows.get(holder, {})
        if (not identity["clean"] or identity["head"] != target_sha
                or identity["role"] in {"controller", "task"}):
            blockers.append(f"unsafe_target_holder:{holder}")
        else:
            actions.append({"kind": "detach_target_holder", "path": holder,
                            "branch": row.get("branch"), "head": identity["head"],
                            "role": identity["role"], "authority": identity["authority"]})
    ignored = {"target_checked_out", "integration_owner_stale",
               "integration_owner_role_base_stale"}
    blockers.extend(row["code"] for row in status["findings"]
                    if row["severity"] == "error" and row["code"] not in ignored)
    common = Path(git(repository, "rev-parse", "--path-format=absolute",
                      "--git-common-dir")).resolve()
    core = {"schema_version": SCHEMA, "operation": "repair", "controller": str(controller),
            "repository": str(repository), "git_common_dir": str(common),
            "policy": str(policy_path), "policy_sha256": hashlib.sha256(
                policy_path.read_bytes()).hexdigest(), "target": status["target"],
            "registered_owner": status["integration"]["registered_path"],
            "owner": owner, "actions": actions, "blockers": sorted(set(blockers))}
    return {**core, "plan_sha256": json_digest(core)}


def repair(controller: Path, *, dry_run: bool, apply: Path | None) -> tuple[dict[str, Any], int]:
    import merge_queue as merge_runtime
    controller = exact_root(controller, "controller")
    policy, task_policy, _ = load_policy(controller)
    repository = task_workspace.product_repository(controller, task_policy)
    if dry_run:
        plan = repair_plan(controller)
        receipt = {**plan, "outcome": "planned" if not plan["blockers"] else "refused"}
        reference = write_receipt(operation_receipt_path(controller, policy, "repair-plan"), receipt)
        return {**receipt, "receipt": reference}, 0 if not plan["blockers"] else 2
    if apply is None:
        raise IntegrationError("repair apply requires a plan receipt")
    try:
        approved = json.loads(apply.expanduser().resolve().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IntegrationError(f"invalid repair plan receipt: {exc}") from exc
    current = repair_plan(controller)
    if approved.get("operation") != "repair" or approved.get("blockers"):
        error = "repair plan was not eligible"
        failed = {"schema_version": SCHEMA, "operation": "repair",
                  "outcome": "failed", "error": error}
        reference = write_receipt(operation_receipt_path(
            controller, policy, "repair-refused"), failed)
        return {**failed, "receipt": reference}, 2
    if approved.get("plan_sha256") != current["plan_sha256"]:
        error = "repair plan identity drifted; generate a new dry-run receipt"
        failed = {"schema_version": SCHEMA, "operation": "repair",
                  "outcome": "failed", "error": error,
                  "approved_plan_sha256": approved.get("plan_sha256"),
                  "current_plan_sha256": current["plan_sha256"]}
        reference = write_receipt(operation_receipt_path(
            controller, policy, "repair-drift"), failed)
        return {**failed, "receipt": reference}, 2
    result_path = operation_receipt_path(controller, policy, "repair-apply")
    result = {**current, "outcome": "running", "phases": []}
    reference = write_receipt(result_path, result)
    try:
        with merge_runtime.target_lock(controller, repository, task_policy["target_ref"]):
            for action in current["actions"]:
                if action["kind"] == "detach_target_holder":
                    root = Path(action["path"])
                    git(root, "switch", "--detach", action["head"])
                elif action["kind"] == "refresh_owner":
                    root = Path(action["path"])
                    git(root, "switch", "--detach", action["after"])
                elif action["kind"] == "clear_legacy_integration_registration":
                    git(Path(action["repository"]), "config", "--local", "--unset-all",
                        action["key"])
                elif action["kind"] == "advance_role_base":
                    advance_owner_role_base(Path(action["path"]), action["before"], action["after"])
                result["phases"].append({**action, "status": "complete"})
                reference = write_receipt(result_path, result)
            owner = Path(current["registered_owner"])
            git(owner, "submodule", "sync", "--recursive")
            git(owner, "submodule", "update", "--init", "--recursive", "--checkout")
            after = status_payload(controller)
            if not after["ready"]:
                raise IntegrationError("repair verification did not reach ready state")
            result.update({"outcome": "completed", "status": after})
            reference = write_receipt(result_path, result)
            return {**result, "receipt": reference}, 0
    except (IntegrationError, task_workspace.TaskWorkspaceError,
            merge_runtime.MergeQueueError, OSError) as exc:
        result.update({"outcome": "failed", "error": str(exc)})
        reference = write_receipt(result_path, result)
        return {**result, "receipt": reference}, 2


def remote_ref_sha(root: Path, remote: str, ref: str) -> str | None:
    output = run(["git", "-C", str(root), "ls-remote", "--refs", remote, ref],
                 root, check=False).stdout.strip()
    match = re.fullmatch(r"([0-9a-f]{40,64})\s+.+", output)
    return match.group(1) if match else None


def remote_default_ref(root: Path, remote: str) -> str:
    output = run(["git", "-C", str(root), "ls-remote", "--symref", remote, "HEAD"],
                 root, check=False).stdout
    match = re.search(r"^ref:\s+(refs/heads/[^\s]+)\s+HEAD$", output, re.MULTILINE)
    if not match:
        raise IntegrationError(f"cannot resolve default branch for submodule remote {remote}")
    return match.group(1)


def push_plan(controller: Path) -> dict[str, Any]:
    """Create a network-read-only publication plan. Applying it is separately authorized."""
    controller = exact_root(controller, "controller")
    policy, task_policy, policy_path = load_policy(controller)
    repository = task_workspace.product_repository(controller, task_policy)
    status = status_payload(controller)
    blockers = [row["code"] for row in status["findings"] if row["severity"] == "error"]
    owner = status["integration"]["owner"]
    actions: list[dict[str, Any]] = []
    target_ref, target_sha = status["target"]["ref"], status["target"]["sha"]
    if not status["ready"] or not owner or not target_sha:
        blockers.append("integration_owner_not_ready")
    else:
        owner_root = Path(owner["path"])
        for item in owner["submodules"]:
            if item["state"] != "exact" or not item["path"]:
                blockers.append(f"submodule_not_exact:{item['path']}")
                continue
            child = owner_root / item["path"]
            remote, child_ref = "origin", remote_default_ref(child, "origin")
            remote_sha = remote_ref_sha(child, remote, child_ref)
            if remote_sha != item["sha"]:
                if remote_sha and run(["git", "-C", str(child), "merge-base", "--is-ancestor",
                                       remote_sha, item["sha"]], child, check=False).returncode:
                    blockers.append(f"submodule_remote_diverged:{item['path']}")
                actions.append({"kind": "push_submodule", "path": item["path"],
                                "repository": str(child), "remote": remote, "ref": child_ref,
                                "before": remote_sha, "after": item["sha"]})
        remote_sha = remote_ref_sha(repository, policy["remote"], target_ref)
        if remote_sha != target_sha:
            if remote_sha and run(["git", "-C", str(repository), "merge-base", "--is-ancestor",
                                   remote_sha, target_sha], repository, check=False).returncode:
                blockers.append("root_remote_diverged")
            actions.append({"kind": "push_root", "repository": str(owner_root),
                            "remote": policy["remote"], "ref": target_ref,
                            "before": remote_sha, "after": target_sha})
    core = {"schema_version": SCHEMA, "operation": "push", "controller": str(controller),
            "repository": str(repository), "policy": str(policy_path),
            "policy_sha256": hashlib.sha256(policy_path.read_bytes()).hexdigest(),
            "target_ref": target_ref, "target_sha": target_sha,
            "registered_owner": status["integration"]["registered_path"],
            "actions": actions, "blockers": sorted(set(blockers))}
    return {**core, "plan_sha256": json_digest(core)}


def push(controller: Path, *, dry_run: bool, apply: Path | None) -> tuple[dict[str, Any], int]:
    import merge_queue as merge_runtime
    controller = exact_root(controller, "controller")
    policy, task_policy, policy_path = load_policy(controller)
    repository = task_workspace.product_repository(controller, task_policy)
    if dry_run:
        plan = push_plan(controller)
        receipt = {**plan, "outcome": "planned" if not plan["blockers"] else "refused"}
        reference = write_receipt(operation_receipt_path(controller, policy, "push-plan"), receipt)
        return {**receipt, "receipt": reference}, 0 if not plan["blockers"] else 2
    if apply is None:
        raise IntegrationError("push apply requires a plan receipt")
    try:
        approved = json.loads(apply.expanduser().resolve().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IntegrationError(f"invalid push plan receipt: {exc}") from exc
    core_keys = {"schema_version", "operation", "controller", "repository", "policy",
                 "policy_sha256", "target_ref", "target_sha", "registered_owner",
                 "actions", "blockers"}
    if (not isinstance(approved, dict)
            or set(approved) != core_keys | {"plan_sha256", "outcome"}
            or approved.get("schema_version") != SCHEMA
            or approved.get("operation") != "push"
            or approved.get("outcome") != "planned"
            or approved.get("blockers")):
        raise IntegrationError("push plan receipt is not an eligible exact plan")
    core = {key: approved[key] for key in core_keys}
    if approved.get("plan_sha256") != json_digest(core):
        raise IntegrationError("push plan receipt digest is invalid")
    target_ref = task_policy["target_ref"]
    target_sha = sha(repository, target_ref)
    if (approved["controller"] != str(controller)
            or approved["repository"] != str(repository)
            or approved["policy"] != str(policy_path)
            or approved["policy_sha256"] != hashlib.sha256(policy_path.read_bytes()).hexdigest()
            or approved["target_ref"] != target_ref
            or approved["target_sha"] != target_sha
            or approved["registered_owner"] != registered_owner(repository)):
        raise IntegrationError("push plan local identity drifted; generate a new dry-run receipt")
    actions = approved["actions"]
    if not isinstance(actions, list):
        raise IntegrationError("push plan actions are invalid")
    seen_root = False
    child_paths: set[str] = set()
    for index, action in enumerate(actions):
        required = {"kind", "repository", "remote", "ref", "before", "after"}
        if not isinstance(action, dict) or set(action) not in (required, required | {"path"}):
            raise IntegrationError("push plan action shape is invalid")
        if action["kind"] == "push_submodule":
            if seen_root or set(action) != required | {"path"} or action["path"] in child_paths:
                raise IntegrationError("submodule push actions must be unique and precede root")
            child_paths.add(action["path"])
        elif action["kind"] == "push_root":
            if seen_root or index != len(actions) - 1 or set(action) != required:
                raise IntegrationError("exactly one root push action must be last")
            seen_root = True
        else:
            raise IntegrationError("unknown push plan action")
        if (not isinstance(action["repository"], str)
                or not isinstance(action["remote"], str) or not action["remote"]
                or not isinstance(action["ref"], str) or not action["ref"].startswith("refs/heads/")
                or action["before"] is not None and not SHA_RE.fullmatch(action["before"])
                or not isinstance(action["after"], str) or not SHA_RE.fullmatch(action["after"])):
            raise IntegrationError("push plan action identity is invalid")
    if actions and not seen_root:
        raise IntegrationError("push plan with publication actions must end in root push")
    result_path = operation_receipt_path(controller, policy, "push-apply")
    result = {**approved, "outcome": "running", "phases": []}
    reference = write_receipt(result_path, result)
    try:
        with merge_runtime.target_lock(controller, repository, target_ref):
            status = status_payload(controller)
            if (not status["ready"]
                    or status["integration"]["registered_path"] != approved["registered_owner"]
                    or status["target"]["sha"] != approved["target_sha"]):
                raise IntegrationError("push apply integration identity is no longer ready")
            for action in actions:
                action_root = exact_root(Path(action["repository"]), "push action repository")
                if sha(action_root, action["after"]) != action["after"]:
                    raise IntegrationError(f"push action commit is unavailable: {action['after']}")
                observed = remote_ref_sha(action_root, action["remote"], action["ref"])
                if observed == action["after"]:
                    outcome = "already_complete"
                elif observed != action["before"]:
                    raise IntegrationError(
                        f"remote changed for {action['kind']}:{action.get('path', '')}"
                    )
                else:
                    argv = ["git", "-C", str(action_root), "push", "--porcelain"]
                    if action["kind"] == "push_root":
                        argv.append("--recurse-submodules=check")
                    argv.extend([action["remote"], f"{action['after']}:{action['ref']}"])
                    run(argv, action_root)
                    if remote_ref_sha(action_root, action["remote"], action["ref"]) != action["after"]:
                        raise IntegrationError(
                            f"remote readback failed for {action['kind']}:{action.get('path', '')}"
                        )
                    outcome = "pushed"
                result["phases"].append({**action, "status": "complete", "outcome": outcome})
                reference = write_receipt(result_path, result)
            result["outcome"] = "completed"
            reference = write_receipt(result_path, result)
            return {**result, "receipt": reference}, 0
    except (IntegrationError, task_workspace.TaskWorkspaceError,
            merge_runtime.MergeQueueError, OSError) as exc:
        result.update({"outcome": "failed", "error": str(exc)})
        reference = write_receipt(result_path, result)
        return {**result, "receipt": reference}, 2


def sync(controller: Path) -> tuple[dict[str, Any], int]:
    import merge_queue as merge_runtime
    controller = exact_root(controller, "controller")
    policy, task_policy, _ = load_policy(controller)
    repository = task_workspace.product_repository(controller, task_policy)
    target_ref = task_policy["target_ref"]
    receipt_path = (controller / policy["receipt_root"] /
                    f"{time.time_ns()}-{os.getpid()}.json").resolve()
    receipt: dict[str, Any] = {"schema_version": SCHEMA, "operation": "sync",
        "outcome": "running", "phase": "created", "controller": str(controller),
        "repository": str(repository), "target_ref": target_ref, "phases": []}
    reference = write_receipt(receipt_path, receipt)
    try:
        with merge_runtime.target_lock(controller, repository, target_ref):
            before = status_payload(controller)
            owner = before["integration"]["owner"]
            blockers = [row for row in before["findings"] if row["severity"] == "error"]
            if not owner or blockers:
                raise IntegrationError("integration preflight refused: " +
                                       ", ".join(row["code"] for row in blockers))
            receipt["phases"].append({"phase": "preflight", "status": "complete", "status": before})
            receipt["phase"] = "preflight"; reference = write_receipt(receipt_path, receipt)
            owner_root = Path(owner["path"])
            remote_ref = before["remote"]["ref"]
            run(["git", "-C", str(repository), "fetch", "--no-tags", policy["remote"],
                 f"+{target_ref}:{remote_ref}"], repository)
            receipt["phases"].append({"phase": "fetch", "status": "complete",
                                      "remote_sha": sha(repository, remote_ref)})
            receipt["phase"] = "fetch"; reference = write_receipt(receipt_path, receipt)
            local = sha(repository, target_ref); remote = sha(repository, remote_ref)
            owner_role_base = worktree_config(owner_root, "juno.workspace.roleBase")
            rel = relation(repository, local, remote)
            if not local or not remote:
                raise IntegrationError("local target or fetched remote ref is unavailable")
            if rel["ahead"] and rel["behind"]:
                raise IntegrationError("local target and remote diverged")
            if rel["behind"]:
                git(repository, "update-ref", target_ref, remote, local)
                target_outcome = "fast_forwarded"
            else:
                target_outcome = "preserved_local_ahead" if rel["ahead"] else "unchanged"
            current = sha(repository, target_ref)
            receipt["phases"].append({"phase": "target", "status": "complete",
                                      "outcome": target_outcome, "before": local, "after": current})
            receipt["phase"] = "target"; reference = write_receipt(receipt_path, receipt)
            git(owner_root, "switch", "--detach", current or "")
            git(owner_root, "submodule", "sync", "--recursive")
            git(owner_root, "submodule", "update", "--init", "--recursive", "--checkout")
            if target_outcome == "fast_forwarded":
                if owner_role_base != local:
                    raise IntegrationError(
                        "remote fast-forward refuses a stale integration owner roleBase"
                    )
                authority = advance_owner_role_base(owner_root, owner_role_base, current or "")
                receipt["phases"].append({"phase": "authority", "status": "complete",
                                          **authority})
                receipt["phase"] = "authority"; reference = write_receipt(receipt_path, receipt)
            if current != local:
                runtime_refresh = managed_runtime_refresh(
                    controller, repository, local, current or "", task_id="integration-sync")
            else:
                runtime_refresh = managed_runtime_inspect(controller, repository, current or "")
                if not runtime_refresh["healthy"]:
                    raise IntegrationError(
                        "managed controller runtime doctor found drift without a new target transition"
                    )
            receipt["phases"].append({"phase": "managed_runtime", "status": "complete",
                                      "result": runtime_refresh})
            receipt["phase"] = "managed_runtime"; reference = write_receipt(receipt_path, receipt)
            after = status_payload(controller)
            if (not after["ready"] or any(item["state"] != "exact"
                    for item in (after["integration"]["owner"] or {}).get("submodules", []))):
                raise IntegrationError("post-sync owner or submodule verification failed")
            receipt["phases"].append({"phase": "verify", "status": "complete", "status": after})
            receipt["phase"] = "complete"; receipt["outcome"] = "completed"
            reference = write_receipt(receipt_path, receipt)
            return {"schema_version": SCHEMA, "operation": "sync", "outcome": "completed",
                    "receipt": reference, "status": after}, 0
    except (IntegrationError, ManagedRuntimeError,
            task_workspace.TaskWorkspaceError, merge_runtime.MergeQueueError, OSError) as exc:
        receipt["outcome"] = "failed"; receipt["error"] = str(exc)
        if isinstance(exc, ManagedRuntimeError) and exc.receipt:
            receipt["managed_runtime_receipt"] = exc.receipt
        reference = write_receipt(receipt_path, receipt)
        return {"schema_version": SCHEMA, "operation": "sync", "outcome": "failed",
                "error": str(exc), "receipt": reference}, 2


def register(controller: Path, owner_path: Path, *, replace: bool = False) -> tuple[dict[str, Any], int]:
    import merge_queue as merge_runtime
    controller = exact_root(controller, "controller")
    policy, task_policy, _ = load_policy(controller)
    repository = task_workspace.product_repository(controller, task_policy)
    target_ref = task_policy["target_ref"]
    receipt_path = (controller / policy["receipt_root"] /
                    f"{time.time_ns()}-{os.getpid()}-register.json").resolve()
    try:
        owner = exact_root(owner_path, "integration owner")
        common = Path(git(repository, "rev-parse", "--path-format=absolute",
                          "--git-common-dir")).resolve()
        owner_common = Path(git(owner, "rev-parse", "--path-format=absolute",
                                "--git-common-dir")).resolve()
        registered_paths = {str(item.get("worktree")) for item in parse_worktrees(repository)}
        if common != owner_common or str(owner) not in registered_paths:
            raise IntegrationError("integration owner is not a linked worktree of this repository")
        if worktree_config(owner, "juno.workspace.role") != "integration-owner":
            raise IntegrationError("integration owner role is not registered")
        if worktree_config(owner, "juno.workspace.roleAuthority") != policy["owner_role_authority"]:
            raise IntegrationError("integration owner does not carry protected authority")
        full, reasons = full_checkout(owner)
        if (git(owner, "symbolic-ref", "-q", "HEAD", check=False)
                or git(owner, "status", "--porcelain=v1", "--untracked-files=all") or not full):
            raise IntegrationError("integration owner must be clean, detached, and full: "
                                   + ", ".join(reasons))
        with merge_runtime.target_lock(controller, repository, target_ref):
            previous = registered_owner(repository)
            if previous and previous != str(owner) and not replace:
                raise IntegrationError(
                    "a different canonical integration owner is already registered; use --replace"
                )
            git(repository, "config", "--local", OWNER_CONFIG, str(owner))
            if registered_owner(repository) != str(owner):
                raise IntegrationError("canonical integration owner registration readback failed")
        receipt = {"schema_version": SCHEMA, "operation": "register", "outcome": "completed",
                   "repository": str(repository), "target_ref": target_ref, "previous": previous,
                   "owner": str(owner), "replace": replace}
        reference = write_receipt(receipt_path, receipt)
        return {**receipt, "receipt": reference, "status": status_payload(controller)}, 0
    except (IntegrationError, task_workspace.TaskWorkspaceError,
            merge_runtime.MergeQueueError, OSError) as exc:
        receipt = {"schema_version": SCHEMA, "operation": "register", "outcome": "failed",
                   "owner": str(owner_path.expanduser().resolve()), "error": str(exc)}
        reference = write_receipt(receipt_path, receipt)
        return {**receipt, "receipt": reference}, 2


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(allow_abbrev=False)
    root.add_argument("--controller", type=Path, default=Path.cwd())
    commands = root.add_subparsers(dest="operation", required=True)
    status = commands.add_parser("status", allow_abbrev=False)
    status.add_argument("--fetch", action="store_true")
    commands.add_parser("sync", allow_abbrev=False)
    runtime_doctor = commands.add_parser("runtime-doctor", allow_abbrev=False)
    runtime_doctor.add_argument("--target-sha")
    runtime_refresh = commands.add_parser("runtime-refresh", allow_abbrev=False)
    runtime_refresh.add_argument("--previous-sha", required=True)
    runtime_refresh.add_argument("--target-sha")
    register_command = commands.add_parser("register", allow_abbrev=False)
    register_command.add_argument("owner", type=Path)
    register_command.add_argument("--replace", action="store_true")
    for name in ("repair", "push"):
        command = commands.add_parser(name, allow_abbrev=False)
        mode = command.add_mutually_exclusive_group(required=True)
        mode.add_argument("--dry-run", action="store_true")
        mode.add_argument("--apply", type=Path)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.operation == "status":
            payload, code = status_payload(args.controller, fetch=args.fetch), 0
        elif args.operation == "sync":
            payload, code = sync(args.controller)
        elif args.operation in {"runtime-doctor", "runtime-refresh"}:
            controller = exact_root(args.controller, "controller")
            _, task_policy, _ = load_policy(controller)
            repository = task_workspace.product_repository(controller, task_policy)
            target_sha = args.target_sha or sha(repository, task_policy["target_ref"])
            if not target_sha:
                raise IntegrationError("managed runtime target commit is unavailable")
            if args.operation == "runtime-doctor":
                payload = managed_runtime_inspect(controller, repository, target_sha)
                code = 0 if payload["healthy"] else 2
            else:
                payload = managed_runtime_refresh(
                    controller, repository, args.previous_sha, target_sha, task_id="manual")
                code = 0
        elif args.operation == "register":
            payload, code = register(args.controller, args.owner, replace=args.replace)
        elif args.operation == "repair":
            payload, code = repair(args.controller, dry_run=args.dry_run, apply=args.apply)
        else:
            payload, code = push(args.controller, dry_run=args.dry_run, apply=args.apply)
        print(json.dumps(payload, indent=2, sort_keys=True))
        return code
    except (IntegrationError, ManagedRuntimeError,
            task_workspace.TaskWorkspaceError, OSError, json.JSONDecodeError) as exc:
        print(f"integration-workspace: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
