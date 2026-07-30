#!/usr/bin/env python3
"""Create, verify, audit, and safely clean exact-base named Git worktrees."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA = "juno_worktree_lifecycle.v5"
SPARSE_POLICY_HEADER = "# juno-worktree-lifecycle sparse-v1"
DEFAULT_ACTIVITY_PROBE_TIMEOUT_SECONDS = 5
MAX_ACTIVITY_PROBE_TIMEOUT_SECONDS = 60

class LifecycleError(Exception): pass

class DetachRefusal(LifecycleError):
    def __init__(self, message: str, evidence: dict[str, Any]):
        super().__init__(message)
        self.evidence = evidence

def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, stdin=subprocess.DEVNULL,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if check and result.returncode:
        raise LifecycleError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()

def full_ref(value: str) -> str:
    if not value.startswith("refs/"):
        raise LifecycleError("refs must be full names beginning with refs/")
    return value

def branch_ref(value: str, *, allow_detached: bool = False) -> str:
    if allow_detached and value == "DETACHED":
        return value
    if not value.startswith("refs/heads/"):
        raise LifecycleError("branch refs must be full refs/heads/... names" + (" or DETACHED" if allow_detached else ""))
    return value

def submodule_repository(value: str) -> tuple[str, Path]:
    relative, separator, repository = value.partition("=")
    path = Path(relative)
    if not separator or not relative or not repository or path.is_absolute() or ".." in path.parts:
        raise argparse.ArgumentTypeError("deinitialized submodule must be RELATIVE_PATH=APPROVED_REPOSITORY")
    return path.as_posix(), Path(repository).expanduser().resolve()

def identity(repo: Path) -> tuple[Path, Path]:
    root = Path(git(repo, "rev-parse", "--show-toplevel")).resolve()
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    return root, common

def status(repo: Path) -> str:
    return git(repo, "status", "--porcelain=v2", "--untracked-files=all")

def lock_path(repo: Path) -> Path:
    return Path(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index.lock")).resolve()

def write_receipt(path: Path, payload: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") != encoded:
        raise LifecycleError(f"immutable receipt already exists with different content: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(encoded, encoding="utf-8")

def listed(repo: Path) -> list[dict[str, str]]:
    rows, row = [], {}
    for line in [*git(repo, "worktree", "list", "--porcelain").splitlines(), ""]:
        if not line:
            if row: rows.append(row); row = {}
        else:
            key, _, value = line.partition(" "); row[key] = value or "true"
    return rows

def measure_capacity(path: Path) -> dict[str, Any]:
    try:
        usage = shutil.disk_usage(path if path.exists() else path.parent)
        return {"available": True, "free_bytes": usage.free}
    except OSError as exc:
        return {"available": False, "error": type(exc).__name__}

def normalize_sparse_paths(values: list[str]) -> list[str]:
    normalized: set[str] = set()
    for value in values:
        candidate = value.replace(os.sep, "/")
        path = PurePosixPath(candidate)
        if (not candidate or value != value.strip() or candidate != path.as_posix() or path.is_absolute() or candidate in {".", ".git"}
                or ".." in path.parts or ".git" in path.parts or "\\" in candidate
                or any(ord(character) < 32 or ord(character) == 127 for character in candidate)
                or any(character in candidate for character in "*?[") or candidate.startswith(("!", "#"))):
            raise LifecycleError(f"invalid_sparse_path: {value!r}")
        normalized.add(candidate.rstrip("/"))
    return sorted(normalized)

def sparse_patterns(paths: list[str]) -> list[str]:
    patterns = [SPARSE_POLICY_HEADER]
    for path in paths:
        patterns.extend((f"/{path}", f"/{path}/**"))
    return patterns

def parse_sparse_patterns(patterns: list[str]) -> list[str] | None:
    if not patterns or patterns[0] != SPARSE_POLICY_HEADER or (len(patterns) - 1) % 2:
        return None
    paths: list[str] = []
    for index in range(1, len(patterns), 2):
        exact, recursive = patterns[index:index + 2]
        if not exact.startswith("/") or exact.endswith("/**") or recursive != exact + "/**":
            return None
        paths.append(exact[1:])
    try:
        return normalize_sparse_paths(paths) if paths == sorted(set(paths)) else None
    except LifecycleError:
        return None

def git_nul_records(path: Path, *args: str) -> list[bytes]:
    result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, stdin=subprocess.DEVNULL,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if result.returncode:
        raise LifecycleError(f"git {' '.join(args)} failed: {result.stderr.decode(errors='replace').strip()}")
    return [record for record in result.stdout.split(b"\0") if record]

def materialized_tracked_paths(path: Path) -> list[str]:
    tracked_paths = [record.decode(errors="surrogateescape") for record in git_nul_records(path, "ls-files", "-z")]
    return [tracked for tracked in tracked_paths if os.path.lexists(path / tracked)]

def skip_worktree_paths(path: Path) -> list[str]:
    return sorted(record[2:].decode(errors="surrogateescape") for record in git_nul_records(path, "ls-files", "-t", "-z")
                  if record.startswith(b"S "))

def path_set_evidence(paths: list[str]) -> dict[str, Any]:
    encoded = b"\0".join(path.encode(errors="surrogateescape") for path in paths)
    return {"count": len(paths), "sha256": hashlib.sha256(encoded).hexdigest()}

def config_bool(path: Path, key: str, *, worktree: bool = False) -> tuple[bool | None, bool]:
    scope = ["--worktree"] if worktree else []
    result = subprocess.run(["git", "-C", str(path), "config", *scope, "--bool", "--get", key], text=True,
                            capture_output=True, stdin=subprocess.DEVNULL,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if result.returncode == 1:
        return None, True
    value = result.stdout.strip()
    if result.returncode != 0 or value not in {"true", "false"}:
        return None, False
    return value == "true", True

def path_is_selected(tracked: str, selected: list[str]) -> bool:
    return any(tracked == prefix or tracked.startswith(prefix + "/") for prefix in selected)

def checkout_policy(path: Path) -> dict[str, Any]:
    enabled, enabled_valid = config_bool(path, "core.sparseCheckout")
    cone, cone_valid = config_bool(path, "core.sparseCheckoutCone")
    sparse_index, sparse_index_valid = config_bool(path, "index.sparse")
    scoped_enabled, scoped_enabled_valid = config_bool(path, "core.sparseCheckout", worktree=True)
    scoped_cone, scoped_cone_valid = config_bool(path, "core.sparseCheckoutCone", worktree=True)
    scoped_sparse_index, scoped_sparse_index_valid = config_bool(path, "index.sparse", worktree=True)
    worktree_config = {"core.sparseCheckout": scoped_enabled, "core.sparseCheckoutCone": scoped_cone,
                       "index.sparse": scoped_sparse_index,
                       "valid": scoped_enabled_valid and scoped_cone_valid and scoped_sparse_index_valid}
    skipped = skip_worktree_paths(path)
    if enabled is not True:
        consistent = enabled_valid and cone_valid and sparse_index_valid and cone is not True and sparse_index is not True and not skipped
        return {"mode": "full", "style": None, "enabled": enabled, "cone": cone, "sparse_index": sparse_index,
                "config_valid": enabled_valid and cone_valid and sparse_index_valid, "worktree_config": worktree_config,
                "skip_worktree": path_set_evidence(skipped),
                "expected_skip_worktree": path_set_evidence([]), "paths": [], "patterns": [], "materialized_tracked_paths": [],
                "unexpected_materialized_paths": [], "consistent": consistent}
    sparse_file = Path(git(path, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"))
    sparse_bytes = sparse_file.read_bytes() if sparse_file.is_file() else b""
    try:
        patterns = sparse_bytes.decode("utf-8").splitlines(); patterns_valid = True
    except UnicodeDecodeError:
        patterns = []; patterns_valid = False
    selected = parse_sparse_patterns(patterns) if patterns_valid else None
    tracked = [record.decode(errors="surrogateescape") for record in git_nul_records(path, "ls-files", "-z")]
    expected_skipped = [] if selected is None else sorted(item for item in tracked if not path_is_selected(item, selected))
    materialized = materialized_tracked_paths(path)
    unexpected = materialized if selected is None else [item for item in materialized if not path_is_selected(item, selected)]
    return {"mode": "sparse", "style": "non-cone", "enabled": enabled, "cone": cone, "sparse_index": sparse_index,
            "config_valid": enabled_valid and cone_valid and sparse_index_valid, "worktree_config": worktree_config,
            "patterns_valid_utf8": patterns_valid,
            "skip_worktree": path_set_evidence(skipped), "expected_skip_worktree": path_set_evidence(expected_skipped),
            "paths": [] if selected is None else selected, "patterns": patterns,
            "sparse_file_sha256": hashlib.sha256(sparse_bytes).hexdigest() if sparse_bytes else None,
            "materialized_tracked_paths": materialized, "unexpected_materialized_paths": unexpected,
            "consistent": enabled_valid and cone_valid and sparse_index_valid and worktree_config["valid"]
                          and scoped_enabled is True and scoped_cone is False and scoped_sparse_index is False
                          and cone is False and sparse_index is False and patterns_valid and selected is not None
                          and skipped == expected_skipped and not unexpected}

def configure_sparse_checkout(path: Path, paths: list[str], base: str) -> None:
    patterns = sparse_patterns(paths)
    result = subprocess.run(["git", "-C", str(path), "sparse-checkout", "set", "--no-cone", "--no-sparse-index", "--stdin"],
                            input="\n".join(patterns) + "\n", text=True, capture_output=True,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if result.returncode:
        raise LifecycleError(f"git sparse-checkout set failed: {result.stderr.strip()}")
    git(path, "reset", "--hard", base)

def rollback_failed_create(repo: Path, path: Path, branch: str, base: str) -> dict[str, Any]:
    registration = [row for row in listed(repo) if Path(row["worktree"]).resolve() == path]
    evidence: dict[str, Any] = {"registered_before": registration, "removed": False, "branch_deleted": False}
    if len(registration) == 1 and registration[0].get("HEAD") == base and registration[0].get("branch") == branch:
        removal = subprocess.run(["git", "-C", str(repo), "worktree", "remove", str(path)], text=True,
                                 capture_output=True, stdin=subprocess.DEVNULL,
                                 env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
        evidence.update({"remove_returncode": removal.returncode, "remove_stderr": removal.stderr.strip(),
                         "removed": removal.returncode == 0 and not path.exists()})
    if evidence["removed"] and git(repo, "rev-parse", "--verify", branch, check=False) == base:
        git(repo, "update-ref", "-d", branch, base); evidence["branch_deleted"] = True
    evidence["registration_after"] = [row for row in listed(repo) if Path(row["worktree"]).resolve() == path]
    return evidence

def create(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repository.resolve(); root, common = identity(repo)
    target_ref = full_ref(args.target_ref)
    target_sha_at_create = git(repo, "rev-parse", "--verify", f"{target_ref}^{{commit}}")
    if args.fetch:
        remote, separator, ref = args.fetch.partition(",")
        if not separator or not remote or not ref: raise LifecycleError("--fetch must be REMOTE,REF")
        # Fetch only into FETCH_HEAD. Creation must never advance the approved
        # local integration target as a side effect of discovering its base.
        git(repo, "fetch", "--no-tags", remote, ref)
        base = git(repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}")
    else:
        base = git(repo, "rev-parse", "--verify", f"{target_ref}^{{commit}}")
    if args.expected_base and base != args.expected_base: raise LifecycleError(f"base_mismatch expected={args.expected_base} actual={base}")
    path = args.path.resolve(); branch = branch_ref(args.branch_ref)
    if args.sparse_tooling_path and not args.sparse:
        raise LifecycleError("--sparse-tooling-path requires --sparse")
    expected_paths = normalize_sparse_paths(args.expected_path) if args.sparse else sorted(set(args.expected_path))
    sparse_tooling_paths = normalize_sparse_paths(args.sparse_tooling_path) if args.sparse else []
    requested_sparse_paths = sorted(set(expected_paths) | set(sparse_tooling_paths))
    if args.sparse and not requested_sparse_paths:
        raise LifecycleError("--sparse requires at least one --expected-path or --sparse-tooling-path")
    capacity = measure_capacity(path)
    if args.hard_min_free_bytes is not None and args.hard_min_free_bytes < 0:
        raise LifecycleError("--hard-min-free-bytes must be non-negative")
    if args.hard_min_free_bytes is not None and capacity["available"] and capacity["free_bytes"] < args.hard_min_free_bytes:
        raise LifecycleError(f"capacity_below_hard_threshold threshold={args.hard_min_free_bytes} observed={capacity['free_bytes']} recovery=free_space")
    if lock_path(repo).exists(): raise LifecycleError(f"git_index_lock_present: {lock_path(repo)}")
    matches = [row for row in listed(repo) if Path(row["worktree"]).resolve() == path]
    if matches:
        row = matches[0]
        if row.get("branch") != branch or row.get("HEAD") != base: raise LifecycleError("existing_worktree_identity_mismatch")
        if status(path): raise LifecycleError("existing_worktree_dirty")
        policy = checkout_policy(path)
        requested_mode = "sparse" if args.sparse else "full"
        if (not policy["consistent"] or policy["mode"] != requested_mode
                or (args.sparse and policy["paths"] != requested_sparse_paths)):
            raise LifecycleError("existing_worktree_checkout_policy_mismatch")
        outcome = "verified_existing"
    else:
        if path.exists(): raise LifecycleError("worktree_path_collision")
        if run_returncode(repo, "show-ref", "--verify", "--quiet", branch) == 0: raise LifecycleError("branch_ref_collision")
        try:
            if args.sparse:
                git(repo, "worktree", "add", "--no-checkout", "-b", branch.removeprefix("refs/heads/"), str(path), base)
                configure_sparse_checkout(path, requested_sparse_paths, base)
            else:
                git(repo, "worktree", "add", "-b", branch.removeprefix("refs/heads/"), str(path), base)
            policy = checkout_policy(path)
            actual_head = git(path, "rev-parse", "HEAD")
            actual_branch = git(path, "symbolic-ref", "-q", "HEAD", check=False)
            actual_target = git(repo, "rev-parse", "--verify", f"{target_ref}^{{commit}}", check=False)
            if (actual_head != base or actual_branch != branch or actual_target != target_sha_at_create
                    or not policy["consistent"] or policy["mode"] != ("sparse" if args.sparse else "full")
                    or (args.sparse and policy["paths"] != requested_sparse_paths)):
                raise LifecycleError("created_worktree_identity_or_checkout_policy_mismatch")
        except (LifecycleError, OSError) as exc:
            rollback = rollback_failed_create(repo, path, branch, base)
            raise LifecycleError(f"create_failed: {exc}; rollback={json.dumps(rollback, sort_keys=True)}") from exc
        outcome = "created"
    payload = {"schema_version": SCHEMA, "operation": "create", "outcome": outcome, "repository_root": str(root),
               "git_common_dir": str(common), "target_ref": target_ref, "target_sha_at_create": target_sha_at_create,
               "base_sha": base, "task_id": args.task_id,
               "branch_ref": branch, "worktree": str(path), "expected_paths": expected_paths,
               "sparse_tooling_paths": sparse_tooling_paths, "checkout_policy": policy,
               "validation_commands": args.validation_command, "cleanup_owner": args.cleanup_owner,
               "capacity": capacity, "clean": status(path) == ""}
    write_receipt(args.output, payload); return payload

def verify(args: argparse.Namespace) -> dict[str, Any]:
    receipt = json.loads(args.manifest.read_text(encoding="utf-8"))
    if receipt.get("schema_version") != SCHEMA or receipt.get("operation") != "create":
        raise LifecycleError("invalid create manifest")
    display_path = args.path or Path(receipt["worktree"]); refusals: list[str] = []
    try: expected_path = Path(receipt["worktree"]).resolve(strict=True)
    except OSError: expected_path = None; refusals.append("manifest_worktree_missing")
    try: actual_path = display_path.resolve(strict=True)
    except OSError: actual_path = None; refusals.append("path_missing_or_dangling")
    actual: dict[str, Any] = {"head": None, "branch_ref": None, "target_sha": None, "clean": False,
                              "worktree": None if actual_path is None else str(actual_path), "git_common_dir": None,
                              "checkout_policy": None}
    if expected_path is not None and actual_path is not None:
        if expected_path != actual_path: refusals.append("canonical_path_mismatch")
        try:
            root, common = identity(actual_path)
            actual.update({"head": git(actual_path, "rev-parse", "HEAD"),
                           "branch_ref": git(actual_path, "symbolic-ref", "-q", "HEAD", check=False),
                           "target_sha": git(actual_path, "rev-parse", "--verify", f"{receipt['target_ref']}^{{commit}}", check=False) or None,
                           "clean": status(actual_path) == "", "worktree": str(root), "git_common_dir": str(common),
                           "checkout_policy": checkout_policy(actual_path)})
            if root != actual_path: refusals.append("path_is_not_worktree_root")
            if actual["head"] != receipt["base_sha"]: refusals.append("unexpected_head")
            if actual["branch_ref"] != receipt["branch_ref"]: refusals.append("unexpected_branch")
            if actual["target_sha"] != receipt["target_sha_at_create"]: refusals.append("target_ref_moved_or_missing")
            if not actual["clean"]: refusals.append("dirty")
            if actual["git_common_dir"] != receipt["git_common_dir"]: refusals.append("git_common_dir_mismatch")
            if actual["checkout_policy"] != receipt.get("checkout_policy"): refusals.append("checkout_policy_mismatch")
            if not actual["checkout_policy"]["consistent"]: refusals.append("checkout_policy_inconsistent")
            if display_path.resolve(strict=True) != actual_path: refusals.append("canonical_path_resolution_changed")
        except LifecycleError: refusals.append("path_is_not_registered_git_worktree")
    passed = not refusals
    payload = {"schema_version": SCHEMA, "operation": "verify", "passed": passed,
               "manifest_sha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
               "display_path": str(display_path), "expected_canonical_path": None if expected_path is None else str(expected_path),
               "actual": actual, "refusals": refusals}
    write_receipt(args.output, payload)
    if not passed: raise LifecycleError("worktree_verification_refused: " + ",".join(refusals))
    return payload

def validate_activity_probe_timeout(value: int) -> int:
    if value < 1 or value > MAX_ACTIVITY_PROBE_TIMEOUT_SECONDS:
        raise LifecycleError(
            "activity_probe_timeout_out_of_bounds "
            f"minimum=1 maximum={MAX_ACTIVITY_PROBE_TIMEOUT_SECONDS} observed={value}"
        )
    return value

def cleanup_activity(path: Path, timeout_seconds: int = DEFAULT_ACTIVITY_PROBE_TIMEOUT_SECONDS) -> dict[str, Any]:
    timeout_seconds = validate_activity_probe_timeout(timeout_seconds)
    command = ["lsof", "-n", "-P", "+D", str(path)]
    started = time.monotonic()
    evidence: dict[str, Any] = {
        "command": command, "timeout_seconds": timeout_seconds,
        "maximum_timeout_seconds": MAX_ACTIVITY_PROBE_TIMEOUT_SECONDS,
    }
    try:
        result = subprocess.run(command, text=True, capture_output=True, stdin=subprocess.DEVNULL,
                                timeout=timeout_seconds)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return {**evidence, "probe_status": "unknown", "blocking": True, "error": type(exc).__name__,
                "elapsed_seconds": round(time.monotonic() - started, 6)}
    evidence["elapsed_seconds"] = round(time.monotonic() - started, 6)
    if result.returncode == 0:
        return {**evidence, "probe_status": "active", "blocking": True, "returncode": 0,
                "observed_lines": result.stdout.splitlines()[:100]}
    if result.returncode == 1:  # lsof's documented no-match result
        return {**evidence, "probe_status": "none", "blocking": False, "returncode": 1,
                "observed_lines": []}
    return {**evidence, "probe_status": "unknown", "blocking": True, "returncode": result.returncode,
            "error": "lsof_probe_failed", "stderr": result.stderr.splitlines()[:20],
            "observed_lines": result.stdout.splitlines()[:100]}

def active_cwd_processes(path: Path) -> tuple[str, list[dict[str, Any]]]:
    """Read-only process discovery. Unknown is evidence, never absence."""
    try:
        result = subprocess.run(["lsof", "-n", "-P", "-a", "-d", "cwd", "-Fpn"], text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return "unknown", [{"probe_error": type(exc).__name__}]
    if result.returncode not in (0, 1):
        return "unknown", [{"probe_error": "lsof_probe_failed", "probe_returncode": result.returncode,
                            "stderr": result.stderr.splitlines()[:20]}]
    root = path.resolve(); processes: list[dict[str, Any]] = []; pid: int | None = None
    for line in result.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit(): pid = int(line[1:])
        elif line.startswith("n") and pid is not None:
            cwd = Path(line[1:]).resolve()
            if cwd == root or root in cwd.parents: processes.append({"pid": pid, "cwd": str(cwd)})
    return ("found" if processes else "none"), processes

def file_sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def detach_snapshot(path: Path) -> dict[str, Any]:
    index = Path(git(path, "rev-parse", "--path-format=absolute", "--git-path", "index")).resolve()
    return {"head": git(path, "rev-parse", "HEAD"),
            "branch": git(path, "symbolic-ref", "-q", "HEAD", check=False) or "DETACHED",
            "index_path": str(index), "index_sha256": file_sha256(index), "index_tree": git(path, "write-tree"),
            "tracked_status": git(path, "status", "--porcelain=v2", "--untracked-files=no"),
            "porcelain_status": status(path),
            "submodules": git(path, "submodule", "status", "--recursive", check=False).splitlines()}

def registration_identity(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Registration identity excludes only symbolic attachment, which detach intentionally changes."""
    return sorted(({key: value for key, value in row.items() if key not in {"branch", "detached"}} for row in rows),
                  key=lambda row: row.get("worktree", ""))

def detach_same_sha(repository: Path, path: Path, target: str, expected: str,
                    *, controller: Path | None = None) -> dict[str, Any]:
    """Detach HEAD metadata only; preserve processes and every worktree/index byte."""
    repository = repository.resolve(); path = path.resolve(); target = full_ref(target)
    root, path_common = identity(path); _, repo_common = identity(repository); refusals: list[str] = []
    rows = listed(repository); inventory_before = rows
    matches = [row for row in rows if Path(row["worktree"]).resolve() == path]
    embedded_primary = False
    if not matches and path.exists():
        candidate = [row for row in rows if Path(row["worktree"]).resolve() == path_common and row.get("HEAD") == expected]
        if os.path.samefile(root, path) and len(candidate) == 1: matches = candidate; embedded_primary = True
    if not os.path.samefile(root, path): refusals.append("path_is_not_worktree_root")
    if path_common != repo_common: refusals.append("git_common_dir_mismatch")
    if len(matches) != 1: refusals.append("duplicate_worktree_registration" if len(matches) > 1 else "worktree_not_registered")
    target_owners = [row for row in rows if row.get("branch") == target]
    target_sha = git(repository, "rev-parse", "--verify", f"{target}^{{commit}}", check=False)
    if target_sha != expected: refusals.append(f"target_sha_mismatch expected={expected} actual={target_sha or 'missing'}")
    before = detach_snapshot(path)
    already = before["branch"] == "DETACHED" and before["head"] == expected
    expected_owner_count = 0 if already else 1
    if len(target_owners) != expected_owner_count:
        refusals.append("target_ref_owner_count_mismatch")
    elif not already and Path(target_owners[0]["worktree"]).resolve() != Path(matches[0]["worktree"]).resolve():
        refusals.append("target_ref_owned_by_different_worktree")
    if before["head"] != expected: refusals.append("unexpected_head")
    if not already and before["branch"] != target: refusals.append("worktree_does_not_own_target_ref")
    if lock_path(path).exists(): refusals.append("index_lock_present")
    if run_returncode(path, "diff", "--quiet"): refusals.append("tracked_worktree_dirty")
    if run_returncode(path, "diff", "--cached", "--quiet"): refusals.append("index_dirty")
    topology = None
    if controller:
        topology, topology_refusals = controller_topology(controller, path, expected); refusals.extend(topology_refusals)
    probe_status, processes = active_cwd_processes(path)
    process_evidence = {"probe_status": probe_status, "processes": processes,
                        "classification": "preserved_non_blocking" if probe_status == "found" else
                                          "preserved_unknown_non_blocking" if probe_status == "unknown" else "none_found_non_blocking",
                        "policy": "preserved_no_signal"}
    evidence: dict[str, Any] = {"before": before, "after": None, "target_sha_after": target_sha or None,
        "registration_kind": "embedded_submodule_primary" if embedded_primary else "worktree_list",
        "registration_before": registration_identity(rows), "registration_after": None,
        "inventory_before": inventory_before, "inventory_after": None,
        "target_owner_count_before": len(target_owners), "target_owner_count_after": None,
        "topology": topology, "process_evidence": process_evidence, "refusals": refusals}
    # Bind the complete registration and controller composition at the final mutation boundary.
    boundary_rows = listed(repository)
    if boundary_rows != rows: refusals.append("worktree_inventory_changed_before_release")
    if git(repository, "rev-parse", "--verify", f"{target}^{{commit}}", check=False) != expected:
        refusals.append("target_sha_changed_before_release")
    if controller:
        boundary_topology, boundary_refusals = controller_topology(controller, path, expected)
        if boundary_topology != topology: refusals.append("controller_topology_changed_before_release")
        refusals.extend(boundary_refusals)
    if refusals:
        evidence["refusals"] = refusals
        raise DetachRefusal("target_release_refused: " + ",".join(refusals), evidence)
    if not already: git(path, "update-ref", "--no-deref", "HEAD", expected, target)
    after = detach_snapshot(path); after_rows = listed(repository)
    evidence.update({"after": after, "inventory_after": after_rows,
                     "registration_after": registration_identity(after_rows),
                     "target_owner_count_after": len([row for row in after_rows if row.get("branch") == target]),
                     "target_sha_after": git(repository, "rev-parse", target, check=False) or None})
    immutable_fields = ("head", "index_path", "index_sha256", "index_tree", "tracked_status", "porcelain_status", "submodules")
    changed = [field for field in immutable_fields if after[field] != before[field]]
    post_refusals = []
    if after["branch"] != "DETACHED" or changed: post_refusals.append("metadata_detach_postcondition_failed:" + ",".join(changed))
    if evidence["target_sha_after"] != expected: post_refusals.append("target_ref_changed_during_release")
    if evidence["registration_after"] != evidence["registration_before"]: post_refusals.append("worktree_registration_changed_during_release")
    if evidence["target_owner_count_after"] != 0: post_refusals.append("target_ref_owner_remained_after_release")
    if controller:
        final_topology, final_refusals = controller_topology(controller, path, expected)
        if final_topology != topology: post_refusals.append("controller_topology_changed_during_release")
        post_refusals.extend(final_refusals)
    if post_refusals:
        evidence["refusals"] = post_refusals
        raise DetachRefusal("target_release_postcondition_refused: " + ",".join(post_refusals), evidence)
    evidence.update({"outcome": "already_released" if already else "detached_same_sha", "refusals": []})
    return evidence

def audit(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repository.resolve(); target = full_ref(args.target_ref)
    target_exists = run_returncode(repo, "rev-parse", "--verify", target) == 0
    rows = []
    for row in listed(repo):
        path = Path(row["worktree"]); exists = path.exists(); dirt = None if not exists else status(path)
        reachable = target_exists and run_returncode(repo, "merge-base", "--is-ancestor", row["HEAD"], target) == 0
        policy = checkout_policy(path) if exists else None
        rows.append({**row, "exists": exists, "clean": dirt == "" if dirt is not None else False,
                     "reachable_from_target": reachable, "checkout_policy": policy,
                     "cleanup_eligible": exists and dirt == "" and reachable and policy is not None and policy["consistent"]
                                         and "locked" not in row and "prunable" not in row})
    payload = {"schema_version": SCHEMA, "operation": "audit", "repository": str(repo), "target_ref": target,
               "target_exists": target_exists, "worktrees": rows,
               "prune_dry_run": git(repo, "worktree", "prune", "--dry-run", "--verbose", check=False).splitlines()}
    write_receipt(args.output, payload); return payload

def run_returncode(repo: Path, *args: str) -> int:
    return subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL).returncode

def controller_topology(controller: Path, path: Path, expected: str) -> tuple[dict[str, Any], list[str]]:
    controller = controller.resolve(); controller_root, _ = identity(controller); refusals: list[str] = []
    if controller_root != controller: refusals.append("controller_checkout_is_not_git_root")
    try: relative = path.relative_to(controller_root)
    except ValueError:
        return {"classification": "auxiliary_integration_owner", "controller_root": str(controller_root)}, refusals
    if not relative.parts: refusals.append("controller_root_cannot_be_target_owner")
    entry = git(controller_root, "ls-tree", "HEAD", "--", relative.as_posix()).split(None, 3)
    if len(entry) < 3 or entry[0] != "160000":
        refusals.append("controller_nested_owner_is_not_bound_gitlink"); gitlink_sha = None
    else: gitlink_sha = entry[2]
    if gitlink_sha != expected: refusals.append("controller_gitlink_sha_mismatch")
    path_status = git(controller_root, "status", "--porcelain=v2", "--untracked-files=all", "--", relative.as_posix())
    if path_status: refusals.append("controller_gitlink_dirty")
    return {"classification": "controller_nested_integration_owner", "controller_root": str(controller_root),
            "controller_head": git(controller_root, "rev-parse", "HEAD"), "gitlink_path": relative.as_posix(),
            "gitlink_sha": gitlink_sha, "gitlink_clean": path_status == ""}, refusals

def release_target(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repository.resolve(); path = args.path.resolve()
    base = {"schema_version": SCHEMA, "operation": "release-target", "passed": False,
            "repository": str(repo), "target_ref": args.target_ref, "expected_head": args.expected_head,
            "worktree": str(path), "disposition": args.disposition, "task_id": args.task_id, "owner": args.owner,
            "controller_checkout": None if args.controller_checkout is None else str(args.controller_checkout.resolve())}
    try:
        target = full_ref(args.target_ref)
        if not target.startswith("refs/heads/"): raise LifecycleError("target release requires a full refs/heads/... name")
        if args.disposition != "detach_same_sha": raise LifecycleError("release disposition must be detach_same_sha")
        evidence = detach_same_sha(repo, path, target, args.expected_head, controller=args.controller_checkout)
        payload = {**base, "passed": True, **evidence,
                   "repository_root": str(identity(repo)[0]), "git_common_dir": str(identity(repo)[1]),
                   "before_branch": evidence["before"]["branch"], "before_head": evidence["before"]["head"],
                   "after_branch": evidence["after"]["branch"], "after_head": evidence["after"]["head"],
                   "already_released": evidence["outcome"] == "already_released",
                   "active_processes": evidence["process_evidence"]["processes"], "inventory": listed(repo)}
    except (LifecycleError, OSError) as exc:
        evidence = exc.evidence if isinstance(exc, DetachRefusal) else {}
        fallback_inventory = evidence.get("inventory_before")
        if fallback_inventory is None:
            try: fallback_inventory = listed(repo) if repo.exists() else []
            except (LifecycleError, OSError): fallback_inventory = []
        payload = {**base, **evidence, "passed": False, "outcome": "refused",
                   "error": str(exc), "refusals": evidence.get("refusals", [str(exc)]),
                   "process_evidence": evidence.get("process_evidence", {"probe_status": "not_run", "classification": "unknown", "processes": []}),
                   "inventory_before": fallback_inventory}
        write_receipt(args.output, payload)
        raise
    write_receipt(args.output, payload); return payload

def cleanup(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repository.resolve(); path = args.path.resolve(); target = full_ref(args.target_ref); branch = branch_ref(args.branch_ref, allow_detached=True)
    expected = args.expected_head; policy: dict[str, Any] | None = None
    refusals: list[str] = []; deinitialized: list[dict[str, Any]] = []; admins_to_remove: list[Path] = []
    activity_evidence: dict[str, Any] = {
        "probe_status": "not_run", "blocking": True,
        "command": ["lsof", "-n", "-P", "+D", str(path)],
        "timeout_seconds": args.activity_probe_timeout_seconds,
        "maximum_timeout_seconds": MAX_ACTIVITY_PROBE_TIMEOUT_SECONDS,
    }
    try:
        activity_probe_timeout = validate_activity_probe_timeout(args.activity_probe_timeout_seconds)
    except LifecycleError as exc:
        activity_probe_timeout = None
        activity_evidence["error"] = str(exc)
        refusals.append("activity_probe_timeout_out_of_bounds")
    approved = dict(args.deinitialized_submodule)
    if len(approved) != len(args.deinitialized_submodule): refusals.append("duplicate_deinitialized_submodule_path")
    if args.delete_branch and branch == "DETACHED": refusals.append("detached_has_no_branch")
    registered = any(Path(row["worktree"]).resolve() == path for row in listed(repo))
    already_removed = not path.exists() and not registered
    if not path.exists() and registered: refusals.append("worktree_missing_but_registered")
    elif not path.exists() and run_returncode(repo, "merge-base", "--is-ancestor", expected, target):
        refusals.append("unreachable_from_target")
    elif path.exists():
        policy = checkout_policy(path)
        if not policy["consistent"]: refusals.append("checkout_policy_inconsistent")
        if lock_path(path).exists(): refusals.append("index_lock_present")
        if status(path): refusals.append("dirty")
        if git(path, "rev-parse", "HEAD") != expected: refusals.append("unexpected_head")
        actual_branch = git(path, "symbolic-ref", "-q", "HEAD", check=False) or "DETACHED"
        if actual_branch != branch: refusals.append("unexpected_branch")
        if run_returncode(repo, "merge-base", "--is-ancestor", expected, target):
            refusals.append("unreachable_from_target")
        if (path / ".gitmodules").exists():
            nested = git(path, "submodule", "status", "--recursive", check=False).splitlines()
            if any(line and not line.startswith("-") for line in nested): refusals.append("nested_repository_initialized")
        worktree_git_dir = Path(git(path, "rev-parse", "--absolute-git-dir")).resolve()
        modules_root = worktree_git_dir / "modules"
        discovered: dict[str, Path] = {}; invalid_admin_paths: set[str] = set()
        if modules_root.is_dir():
            modules_canonical = modules_root.resolve()
            for current, directories, files in os.walk(modules_root):
                current_path = Path(current)
                for directory in list(directories):
                    candidate_child = current_path / directory
                    if candidate_child.is_symlink():
                        relative_child = candidate_child.relative_to(modules_root).as_posix(); invalid_admin_paths.add(relative_child)
                        refusals.append(f"deinitialized_submodule_admin_symlink_or_escape:{relative_child}"); directories.remove(directory)
                candidate = current_path; candidate_canonical = candidate.resolve()
                if candidate_canonical != modules_canonical and modules_canonical not in candidate_canonical.parents:
                    relative_escape = candidate.relative_to(modules_root).as_posix(); invalid_admin_paths.add(relative_escape)
                    refusals.append(f"deinitialized_submodule_admin_symlink_or_escape:{relative_escape}"); directories[:] = []; continue
                if "HEAD" in files and "config" in files and (candidate / "objects").is_dir():
                    discovered[candidate.relative_to(modules_root).as_posix()] = candidate_canonical; directories[:] = []
        if discovered and not approved: refusals.append("deinitialized_submodule_admin_requires_approval")
        for relative in sorted(set(discovered) | set(approved)):
            if relative in invalid_admin_paths: continue
            admin = discovered.get(relative); approved_repo = approved.get(relative)
            if admin is None: refusals.append(f"approved_submodule_admin_missing:{relative}"); continue
            if approved_repo is None: refusals.append(f"unapproved_deinitialized_submodule_admin:{relative}"); continue
            if not approved_repo.exists(): refusals.append(f"approved_submodule_repository_missing:{relative}"); continue
            if (path / relative / ".git").exists(): refusals.append(f"submodule_still_initialized:{relative}"); continue
            sub_status = git(path, "submodule", "status", "--", relative, check=False)
            if not sub_status.startswith("-"): refusals.append(f"submodule_not_deinitialized:{relative}"); continue
            entry = git(path, "ls-tree", expected, "--", relative).split(None, 3)
            if len(entry) < 3 or entry[0] != "160000": refusals.append(f"expected_gitlink_missing:{relative}"); continue
            gitlink_sha = entry[2]
            admin_head = subprocess.run(["git", f"--git-dir={admin}", "rev-parse", "HEAD"], text=True, capture_output=True, stdin=subprocess.DEVNULL).stdout.strip()
            approved_git_dir = Path(git(approved_repo, "rev-parse", "--absolute-git-dir")).resolve()
            if approved_git_dir == admin or admin in approved_git_dir.parents: refusals.append(f"approved_repository_is_stale_admin:{relative}"); continue
            object_exists = run_returncode(approved_repo, "cat-file", "-e", f"{gitlink_sha}^{{commit}}") == 0
            containing_refs = git(approved_repo, "for-each-ref", "--contains", gitlink_sha, "--format=%(refname)", check=False).splitlines()
            approved_head = git(approved_repo, "rev-parse", "HEAD", check=False)
            if approved_head == gitlink_sha: containing_refs.append("HEAD")
            if admin_head != gitlink_sha: refusals.append(f"stale_admin_head_mismatch:{relative}")
            if not object_exists or not containing_refs: refusals.append(f"gitlink_unreachable_from_approved_repository:{relative}")
            deinitialized.append({"path": relative, "gitlink_sha": gitlink_sha, "stale_admin": str(admin),
                                  "admin_head": admin_head, "approved_repository": str(approved_repo),
                                  "approved_git_dir": str(approved_git_dir), "containing_refs": containing_refs,
                                  "reachable": object_exists and bool(containing_refs)})
            admins_to_remove.append(admin)
        if activity_probe_timeout is not None:
            activity_evidence = cleanup_activity(path, activity_probe_timeout)
            if activity_evidence["blocking"]:
                refusals.append("process_probe_unknown" if activity_evidence["probe_status"] == "unknown" else "active_process")
    removed = already_removed; removed_admin_paths: list[str] = []
    if not refusals and not already_removed:
        for admin in admins_to_remove:
            shutil.rmtree(admin); removed_admin_paths.append(str(admin))
            parent = admin.parent
            while parent != worktree_git_dir and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir(); removed_admin_paths.append(str(parent)); parent = parent.parent
        removal = subprocess.run(["git", "-C", str(repo), "worktree", "remove", str(path)], text=True, capture_output=True, stdin=subprocess.DEVNULL,
                                 env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
        removed = removal.returncode == 0 and not path.exists()
        if removal.returncode: refusals.append("ordinary_worktree_remove_failed:" + removal.stderr.strip().replace("\n", " "))
        elif not removed: refusals.append("expected_removal_failed")
    if not refusals and args.delete_branch:
        existing = git(repo, "rev-parse", "--verify", branch, check=False)
        if existing and existing != expected: refusals.append("branch_tip_mismatch")
        elif existing: git(repo, "update-ref", "-d", branch, expected)
    inventory = listed(repo); prune = git(repo, "worktree", "prune", "--dry-run", "--verbose", check=False).splitlines()
    payload = {"schema_version": SCHEMA, "operation": "cleanup", "passed": removed and not refusals,
               "removed": removed, "already_removed": already_removed, "refusals": refusals, "worktree": str(path), "expected_head": expected,
               "target_ref": target, "branch_ref": branch, "checkout_policy": policy if path.exists() or not already_removed else None,
               "activity_evidence": activity_evidence, "deinitialized_submodules": deinitialized,
               "removed_admin_paths": removed_admin_paths, "inventory": inventory, "prune_dry_run": prune}
    write_receipt(args.output, payload)
    if refusals: raise LifecycleError("cleanup_refused: " + ",".join(refusals))
    return payload

def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__, allow_abbrev=False); sub = root.add_subparsers(dest="command", required=True)
    create_p = sub.add_parser("create", allow_abbrev=False); create_p.set_defaults(func=create)
    create_p.add_argument("--repository", type=Path, required=True); create_p.add_argument("--target-ref", required=True); create_p.add_argument("--expected-base")
    create_p.add_argument("--fetch"); create_p.add_argument("--path", type=Path, required=True); create_p.add_argument("--branch-ref", required=True)
    create_p.add_argument("--task-id", required=True); create_p.add_argument("--expected-path", action="append", default=[]); create_p.add_argument("--validation-command", action="append", default=[])
    create_p.add_argument("--sparse", action="store_true", help="materialize only explicit expected and sparse-tooling paths using canonical non-cone patterns")
    create_p.add_argument("--sparse-tooling-path", action="append", default=[], metavar="RELATIVE_PATH")
    create_p.add_argument("--cleanup-owner", required=True); create_p.add_argument("--hard-min-free-bytes", type=int); create_p.add_argument("--output", type=Path, required=True)
    verify_p = sub.add_parser("verify", allow_abbrev=False); verify_p.set_defaults(func=verify); verify_p.add_argument("--manifest", type=Path, required=True); verify_p.add_argument("--path", type=Path); verify_p.add_argument("--output", type=Path, required=True)
    audit_p = sub.add_parser("audit", allow_abbrev=False); audit_p.set_defaults(func=audit); audit_p.add_argument("--repository", type=Path, required=True); audit_p.add_argument("--target-ref", required=True); audit_p.add_argument("--output", type=Path, required=True)
    release_p = sub.add_parser("release-target", allow_abbrev=False); release_p.set_defaults(func=release_target)
    for name in ("repository", "path", "output"): release_p.add_argument(f"--{name}", type=Path, required=True)
    release_p.add_argument("--target-ref", required=True); release_p.add_argument("--expected-head", required=True)
    release_p.add_argument("--disposition", required=True, help="only detach_same_sha is accepted; refusals are receipted")
    release_p.add_argument("--task-id", required=True); release_p.add_argument("--owner", required=True)
    release_p.add_argument("--controller-checkout", type=Path)
    clean_p = sub.add_parser("cleanup", allow_abbrev=False); clean_p.set_defaults(func=cleanup)
    for name in ("repository", "path", "output"): clean_p.add_argument(f"--{name}", type=Path, required=True)
    clean_p.add_argument("--target-ref", required=True); clean_p.add_argument("--branch-ref", required=True); clean_p.add_argument("--expected-head", required=True); clean_p.add_argument("--delete-branch", action="store_true")
    clean_p.add_argument("--activity-probe-timeout-seconds", type=int, default=DEFAULT_ACTIVITY_PROBE_TIMEOUT_SECONDS,
                         help=f"bounded lsof +D timeout (default: {DEFAULT_ACTIVITY_PROBE_TIMEOUT_SECONDS}; maximum: {MAX_ACTIVITY_PROBE_TIMEOUT_SECONDS})")
    clean_p.add_argument("--deinitialized-submodule", action="append", type=submodule_repository, default=[], metavar="RELATIVE_PATH=APPROVED_REPOSITORY")
    return root

def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try: payload = args.func(args); print(json.dumps({"schema_version": SCHEMA, "operation": payload["operation"], "passed": payload.get("passed", True)}, sort_keys=True)); return 0
    except (LifecycleError, OSError, json.JSONDecodeError) as exc: print(f"worktree_lifecycle: error: {exc}", file=sys.stderr); return 2
if __name__ == "__main__": raise SystemExit(main())
