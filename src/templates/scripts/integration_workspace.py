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

import merge_queue
import task_workspace

SCHEMA = "juno_integration_workspace.v1"
POLICY_SCHEMA = "juno_integration_workspace_policy.v1"
AUTHORITY = "protected-integration.v1"
OWNER_CONFIG = "juno.integration.ownerPath"
SHA_RE = re.compile(r"[0-9a-f]{40,64}\Z")


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


def sync(controller: Path) -> tuple[dict[str, Any], int]:
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
        with merge_queue.target_lock(controller, repository, target_ref):
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
            after = status_payload(controller)
            if (not after["ready"] or any(item["state"] != "exact"
                    for item in (after["integration"]["owner"] or {}).get("submodules", []))):
                raise IntegrationError("post-sync owner or submodule verification failed")
            receipt["phases"].append({"phase": "verify", "status": "complete", "status": after})
            receipt["phase"] = "complete"; receipt["outcome"] = "completed"
            reference = write_receipt(receipt_path, receipt)
            return {"schema_version": SCHEMA, "operation": "sync", "outcome": "completed",
                    "receipt": reference, "status": after}, 0
    except (IntegrationError, task_workspace.TaskWorkspaceError,
            merge_queue.MergeQueueError, OSError) as exc:
        receipt["outcome"] = "failed"; receipt["error"] = str(exc)
        reference = write_receipt(receipt_path, receipt)
        return {"schema_version": SCHEMA, "operation": "sync", "outcome": "failed",
                "error": str(exc), "receipt": reference}, 2


def register(controller: Path, owner_path: Path, *, replace: bool = False) -> tuple[dict[str, Any], int]:
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
        with merge_queue.target_lock(controller, repository, target_ref):
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
            merge_queue.MergeQueueError, OSError) as exc:
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
    register_command = commands.add_parser("register", allow_abbrev=False)
    register_command.add_argument("owner", type=Path)
    register_command.add_argument("--replace", action="store_true")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.operation == "status":
            payload, code = status_payload(args.controller, fetch=args.fetch), 0
        elif args.operation == "sync":
            payload, code = sync(args.controller)
        else:
            payload, code = register(args.controller, args.owner, replace=args.replace)
        print(json.dumps(payload, indent=2, sort_keys=True))
        return code
    except (IntegrationError, task_workspace.TaskWorkspaceError, OSError,
            json.JSONDecodeError) as exc:
        print(f"integration-workspace: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
