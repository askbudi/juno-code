#!/usr/bin/env python3
"""Create bounded local commits for durable controller state; never push or orchestrate refs."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shlex
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

sys.dont_write_bytecode = True
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from git_index_lock import IndexLockError, diagnose_index_lock, require_index_unlocked
import controller_resolver

SCHEMA_VERSION = "juno_controller_checkpoint.v1"
AGENT_SCHEMA_VERSION = "juno_controller_checkpoint_agent.v1"
BOUNDARY_SCHEMA_VERSION = "juno_workspace_commit_boundary.v1"
HOOK_MARKER = "# juno-controller-boundary-hook-v1"
DEFAULT_INCLUDE = (
    ".juno_task/tasks",
    ".juno_task/ledger",
    ".juno_task/wiki",
    ".juno_task/specs",
    ".juno_task/plan.md",
    ".juno_task/tasks.md",
)


class CheckpointError(Exception):
    pass


@dataclass(frozen=True)
class Dirty:
    kind: str
    xy: str
    path: str
    original: str | None = None
    submodule: str = "N..."

    @property
    def staged(self) -> bool:
        return self.xy[0] not in {".", "?", "!"}

    @property
    def conflicted(self) -> bool:
        return self.kind == "u" or self.xy in {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}

    @property
    def dirty_submodule(self) -> bool:
        return self.submodule != "N..."


def git(root: Path, *args: str, check: bool = True, text: bool = True) -> Any:
    env = dict(os.environ)
    # Read-only status/diff calls must not refresh the shared index. Git still
    # takes mandatory locks for add/commit when optional locks are disabled.
    env["GIT_OPTIONAL_LOCKS"] = "0"
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=text,
        stdin=subprocess.DEVNULL,
        env=env,
    )
    if check and result.returncode != 0:
        stderr = result.stderr.strip() if text else result.stderr.decode(errors="replace").strip()
        raise CheckpointError(f"git {' '.join(args)} failed: {stderr}")
    return result.stdout if text else result.stdout


def repo_root(value: str) -> Path:
    candidate = Path(value).expanduser().resolve()
    root = Path(git(candidate, "rev-parse", "--show-toplevel").strip()).resolve()
    if candidate != root:
        raise CheckpointError(f"--root must be the repository top level: expected {root}, got {candidate}")
    return root


def common_dir(root: Path) -> Path:
    value = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").strip()
    return Path(value).resolve()


def git_path(root: Path, name: str) -> Path:
    value = git(root, "rev-parse", "--path-format=absolute", "--git-path", name).strip()
    return Path(value).resolve()


def acquire_lease(root: Path):
    lease_path = common_dir(root) / "juno-repository-writer.lock"
    lease_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lease_path.open("a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        handle.close()
        raise CheckpointError(f"repository lease busy: {lease_path}") from exc
    return handle


def normalize_entry(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CheckpointError("unsafe allowlist entry: entries must be non-empty strings")
    value = value.replace("\\", "/").strip().rstrip("/")
    path = PurePosixPath(value)
    if path.is_absolute() or value.startswith("~") or any(part in {"", ".", "..", ".git"} for part in path.parts):
        raise CheckpointError(f"unsafe allowlist entry: {value!r}")
    if any(char in value for char in "*?[]{}"):
        raise CheckpointError(f"unsafe allowlist entry (globs are not supported): {value!r}")
    return path.as_posix()


def load_config(root: Path) -> tuple[tuple[str, ...], dict[str, Any]]:
    path = root / ".juno_task/config.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except (OSError, json.JSONDecodeError) as exc:
        raise CheckpointError(f"invalid checkpoint configuration: {exc}") from exc
    checkpoint = payload.get("gitCheckpoint", {})
    if not isinstance(checkpoint, dict):
        raise CheckpointError("invalid checkpoint configuration: gitCheckpoint must be an object")
    raw_include = checkpoint.get("include", list(DEFAULT_INCLUDE))
    if not isinstance(raw_include, list):
        raise CheckpointError("invalid checkpoint configuration: include must be an array")
    include = tuple(dict.fromkeys(normalize_entry(item) for item in raw_include))
    agent = checkpoint.get("agent", {})
    if not isinstance(agent, dict):
        raise CheckpointError("invalid checkpoint configuration: agent must be an object")
    return include, agent


def parse_status(root: Path) -> list[Dirty]:
    """Parse porcelain v2 so index, rename, conflict, and submodule state are explicit."""
    raw = git(root, "status", "--porcelain=v2", "-z", "--untracked-files=all", text=False)
    fields = raw.split(b"\0")
    dirty: list[Dirty] = []
    index = 0
    while index < len(fields) and fields[index]:
        field = fields[index]
        kind = field[:1].decode("ascii", errors="replace")
        try:
            if kind == "1":
                parts = field.split(b" ", 8)
                if len(parts) != 9:
                    raise ValueError
                dirty.append(Dirty(kind, parts[1].decode("ascii"), parts[8].decode("utf-8", errors="surrogateescape"), submodule=parts[2].decode("ascii")))
            elif kind == "2":
                parts = field.split(b" ", 9)
                if len(parts) != 10:
                    raise ValueError
                index += 1
                if index >= len(fields) or not fields[index]:
                    raise ValueError
                dirty.append(Dirty(kind, parts[1].decode("ascii"), parts[9].decode("utf-8", errors="surrogateescape"), fields[index].decode("utf-8", errors="surrogateescape"), parts[2].decode("ascii")))
            elif kind == "u":
                parts = field.split(b" ", 10)
                if len(parts) != 11:
                    raise ValueError
                dirty.append(Dirty(kind, parts[1].decode("ascii"), parts[10].decode("utf-8", errors="surrogateescape"), submodule=parts[2].decode("ascii")))
            elif kind in {"?", "!"}:
                dirty.append(Dirty(kind, kind * 2, field[2:].decode("utf-8", errors="surrogateescape")))
            else:
                raise ValueError
        except (UnicodeDecodeError, ValueError) as exc:
            raise CheckpointError("could not parse Git porcelain-v2 status") from exc
        index += 1
    return dirty


def selected(path: str, includes: tuple[str, ...]) -> bool:
    return any(path == entry or path.startswith(entry + "/") for entry in includes)


def status_names(item: Dirty) -> tuple[str, ...]:
    return (item.path, item.original) if item.original else (item.path,)


def inspect_boundary(root: Path, relative: str) -> None:
    candidate = root / relative
    current = root
    parts = PurePosixPath(relative).parts
    for part in parts:
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            break
        if stat.S_ISLNK(mode):
            raise CheckpointError(f"unsafe symlink path: {relative}")
        if current != root and (current / ".git").exists():
            raise CheckpointError(f"unsafe nested repository/submodule path: {relative}")
    try:
        candidate.resolve(strict=False).relative_to(root)
    except ValueError as exc:
        raise CheckpointError(f"unsafe path escape: {relative}") from exc


def branch_and_head(root: Path) -> tuple[str, str]:
    branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD", check=False).strip()
    if not branch:
        raise CheckpointError("checkpoint requires a named branch; detached HEAD is not allowed")
    return branch, git(root, "rev-parse", "HEAD").strip()


def fingerprint(root: Path, path: str) -> str:
    candidate = root / path
    digest = hashlib.sha256(path.encode("utf-8", errors="surrogateescape"))
    try:
        info = candidate.lstat()
    except FileNotFoundError:
        digest.update(b"\0deleted")
        return digest.hexdigest()
    digest.update(f"\0{info.st_mode}\0{info.st_size}".encode())
    if candidate.is_file():
        with candidate.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    else:
        digest.update(b"\0non-file")
    return digest.hexdigest()


def inspect(
    root: Path, includes: tuple[str, ...], *, recover_stale_lock: bool = True
) -> dict[str, Any]:
    if os.environ.get("GIT_INDEX_FILE"):
        raise CheckpointError("alternate GIT_INDEX_FILE is not allowed for controller checkpoints")
    try:
        index_lock = (
            require_index_unlocked(root) if recover_stale_lock else diagnose_index_lock(root)
        )
        if index_lock["lock_present"]:
            raise IndexLockError(
                "git_index_lock_present: "
                f"path={index_lock['lock_path']} safe_next_action=preserve_and_coordinate"
            )
    except IndexLockError as exc:
        raise CheckpointError(str(exc)) from exc
    branch, head = branch_and_head(root)
    dirt = parse_status(root)
    if any(item.conflicted for item in dirt):
        paths = [item.path for item in dirt if item.conflicted]
        raise CheckpointError(f"unmerged conflict paths block checkpoint: {paths}")
    if any(item.dirty_submodule for item in dirt):
        paths = [item.path for item in dirt if item.dirty_submodule]
        raise CheckpointError(f"dirty submodule state blocks checkpoint: {paths}")
    staged = sorted({name for item in dirt if item.staged for name in status_names(item)})
    if staged:
        raise CheckpointError(f"pre-existing staged index blocks checkpoint: {staged}")
    for item in dirt:
        for name in status_names(item):
            inspect_boundary(root, name)
    chosen = sorted({name for item in dirt for name in status_names(item) if selected(name, includes)})
    blocked = sorted({name for item in dirt for name in status_names(item) if not selected(name, includes)})
    if blocked:
        raise CheckpointError(f"blocked non-controller paths: {blocked}")
    return {
        "branch": branch,
        "head": head,
        "index_lock": index_lock,
        "selected": chosen,
        "fingerprints": {path: fingerprint(root, path) for path in chosen},
    }


def assert_frozen(root: Path, includes: tuple[str, ...], frozen: dict[str, Any], remaining: list[str]) -> None:
    current = inspect(root, includes)
    if current["branch"] != frozen["branch"] or current["head"] != frozen["head"]:
        raise CheckpointError("repository HEAD/ref changed during checkpoint")
    if current["selected"] != sorted(remaining):
        raise CheckpointError("dirty path set changed during checkpoint")
    expected = {path: frozen["fingerprints"][path] for path in remaining}
    if current["fingerprints"] != expected:
        raise CheckpointError("selected controller content changed during checkpoint")


def index_mode(root: Path, path: str) -> str | None:
    entry = git(root, "ls-files", "--stage", "--", path, check=False).strip().splitlines()
    return entry[0].split()[0] if len(entry) == 1 and entry[0].split() else None


def classify_paths(root: Path, includes: tuple[str, ...], paths: list[str], role: str, *, treeish: str | None = None) -> list[dict[str, str]]:
    """Single role/path classifier used by checkpoint, hooks, and independent checks."""
    offending: list[dict[str, str]] = []
    for path in sorted(set(paths)):
        reason: str | None = None
        if role == "integration-owner":
            reason = "integration_owner_commit_forbidden"
        elif role == "controller" and not selected(path, includes):
            reason = "product_path"
        if role == "controller":
            mode = None
            if treeish:
                row = git(root, "ls-tree", treeish, "--", path, check=False).strip().split(None, 3)
                mode = row[0] if row else None
            else:
                mode = index_mode(root, path)
            if mode == "160000":
                reason = "gitlink"
            try:
                inspect_boundary(root, path)
            except CheckpointError:
                if reason != "gitlink":
                    reason = "nested_repository_or_unsafe_boundary"
        if reason:
            offending.append({"path": path, "reason": reason})
    return offending


def resolve_role(root: Path) -> dict[str, Any]:
    return controller_resolver.resolve(root, "diagnostic")


def staged_paths(root: Path) -> list[str]:
    dirt = parse_status(root)
    return sorted({name for item in dirt if item.staged for name in status_names(item)})


def boundary_payload(root: Path, includes: tuple[str, ...], paths: list[str], *, treeish: str | None = None) -> dict[str, Any]:
    resolution = resolve_role(root)
    offending = classify_paths(root, includes, paths, str(resolution["role"]), treeish=treeish)
    return {"schema_version": BOUNDARY_SCHEMA_VERSION, "passed": not offending,
            "root": str(root), "branch": git(root, "symbolic-ref", "--quiet", "--short", "HEAD", check=False) or None,
            "head": git(root, "rev-parse", "HEAD"), "role": resolution["role"],
            "role_source": resolution.get("role_source"), "paths": paths, "offending": offending,
            "safe_next_action": "run worktree_lifecycle.py edit-preflight with the owner-approved full target ref/base, then create/verify the named exact-base task worktree"}


def require_boundary(payload: dict[str, Any]) -> None:
    if payload["passed"]:
        return
    details = ", ".join(f"{item['path']} ({item['reason']})" for item in payload["offending"])
    raise CheckpointError(
        f"workspace commit boundary refused role={payload['role']} branch={payload['branch'] or 'DETACHED'} "
        f"offending=[{details}]; safe_next_action={payload['safe_next_action']}"
    )


def assert_staged_boundary(
    root: Path,
    includes: tuple[str, ...],
    frozen: dict[str, Any],
    remaining: list[str],
    staged_paths: list[str],
) -> None:
    branch, head = branch_and_head(root)
    if branch != frozen["branch"] or head != frozen["head"]:
        raise CheckpointError("repository HEAD/ref changed after staging")
    dirt = parse_status(root)
    if any(item.conflicted for item in dirt):
        raise CheckpointError("conflict appeared during checkpoint staging")
    if any(item.dirty_submodule for item in dirt):
        raise CheckpointError("dirty submodule state appeared during checkpoint staging")
    blocked = sorted({name for item in dirt for name in status_names(item) if not selected(name, includes)})
    if blocked:
        raise CheckpointError(f"blocked non-controller paths appeared during checkpoint: {blocked}")
    actual_staged = sorted({name for item in dirt if item.staged for name in status_names(item)})
    if actual_staged != sorted(staged_paths):
        raise CheckpointError(
            f"staged path set escaped frozen group: expected={sorted(staged_paths)} actual={actual_staged}"
        )
    dirty_paths = sorted({name for item in dirt for name in status_names(item)})
    if dirty_paths != sorted(remaining):
        raise CheckpointError("dirty path set changed after staging")
    if any(fingerprint(root, path) != frozen["fingerprints"][path] for path in remaining):
        raise CheckpointError("selected controller content changed after staging")
    require_boundary(boundary_payload(root, includes, actual_staged))


def validate_message(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value or len(value) > 500:
        raise CheckpointError("agent proposal contains an invalid commit message")
    return value.strip()


def agent_groups(root: Path, frozen: dict[str, Any], config: dict[str, Any]) -> list[tuple[list[str], str]]:
    if os.environ.get("JUNO_CONTROLLER_CHECKPOINT_ACTIVE") == "1":
        raise CheckpointError("recursive controller checkpoint agent invocation rejected")
    timeout = config.get("timeoutSeconds", 120)
    if not isinstance(timeout, int) or not 1 <= timeout <= 600:
        raise CheckpointError("agent timeoutSeconds must be an integer from 1 to 600")
    context = {
        "schema_version": AGENT_SCHEMA_VERSION,
        "instruction": "Return JSON only. Group every supplied path exactly once and provide a concise local commit message.",
        "paths": frozen["selected"],
        "diff_stat": git(root, "diff", "--stat", "--", *frozen["selected"]),
    }
    override = os.environ.get("JUNO_CHECKPOINT_AGENT_COMMAND", "").strip()
    if override:
        command = shlex.split(override)
    else:
        service = str(config.get("service", "pi"))
        model = str(config.get("model", ":luna"))
        command = ["juno-code", service, "--no-hooks", "--allowed-tools", "Read,Grep,Glob", "--model", model, "-p", json.dumps(context)]
    env = dict(os.environ)
    env["JUNO_CONTROLLER_CHECKPOINT_ACTIVE"] = "1"
    try:
        result = subprocess.run(command, cwd=root, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as exc:
        raise CheckpointError(f"agent proposal timed out after {timeout}s") from exc
    if result.returncode != 0:
        raise CheckpointError(f"agent proposal failed with exit {result.returncode}")
    try:
        proposal = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise CheckpointError("agent proposal is not valid JSON") from exc
    if not isinstance(proposal, dict) or proposal.get("schema_version") != AGENT_SCHEMA_VERSION:
        raise CheckpointError("agent proposal has an invalid schema_version")
    if set(proposal) != {"schema_version", "groups"}:
        raise CheckpointError("agent proposal contains unknown top-level fields")
    groups = proposal.get("groups")
    if not isinstance(groups, list):
        raise CheckpointError("agent proposal groups must be an array")
    output: list[tuple[list[str], str]] = []
    flattened: list[str] = []
    allowed = set(frozen["selected"])
    for group in groups:
        if not isinstance(group, dict) or set(group) != {"paths", "message"}:
            raise CheckpointError("agent proposal group must contain only paths and message")
        if not isinstance(group.get("paths"), list) or not group["paths"]:
            raise CheckpointError("agent proposal contains an invalid group")
        paths = group["paths"]
        if any(not isinstance(path, str) or path not in allowed for path in paths):
            raise CheckpointError("agent proposal contains a path outside the frozen selection")
        flattened.extend(paths)
        output.append((paths, validate_message(group.get("message"))))
    if sorted(flattened) != sorted(frozen["selected"]) or len(flattened) != len(set(flattened)):
        raise CheckpointError("agent proposal must include every selected path exactly once")
    return output


def stage_and_commit(root: Path, includes: tuple[str, ...], frozen: dict[str, Any], groups: list[tuple[list[str], str]]) -> list[str]:
    remaining = list(frozen["selected"])
    commits: list[str] = []
    for paths, message in groups:
        assert_frozen(root, includes, frozen, remaining)
        staged_by_checkpoint = False
        try:
            git(root, "add", "--", *paths)
            staged_by_checkpoint = True
            staged_status = parse_status(root)
            staged = sorted({name for item in staged_status if item.staged for name in status_names(item)})
            if staged != sorted(paths):
                raise CheckpointError(f"staged path set escaped frozen group: expected={sorted(paths)} actual={staged}")
            # inspect() rejects any index ownership, so use the staging-aware
            # boundary check to catch blocked paths, conflicts, ref/content races,
            # and any path staged outside this explicit group.
            assert_staged_boundary(root, includes, frozen, remaining, paths)
            git(root, "commit", "--no-verify", "-m", message, "--", *paths)
            staged_by_checkpoint = False
        except BaseException:
            # A failed/raced commit must not strand checkpoint-owned index state.
            # Restore only the explicit group; worktree content remains untouched.
            if staged_by_checkpoint:
                git(root, "restore", "--staged", "--", *paths, check=False)
            raise
        commits.append(git(root, "rev-parse", "HEAD").strip())
        frozen["head"] = commits[-1]
        remaining = [path for path in remaining if path not in paths]
    post = inspect(root, includes)
    if post["selected"]:
        raise CheckpointError(f"checkpoint postcondition failed; selected dirt remains: {post['selected']}")
    return commits


def hook_paths(root: Path) -> tuple[Path, Path, Path]:
    raw = Path(git(root, "rev-parse", "--git-path", "hooks/pre-commit").strip())
    hook = (raw if raw.is_absolute() else root / raw).resolve()
    return hook, hook.with_name("pre-commit.juno-user"), hook.with_name("pre-commit.juno-metadata.json")


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def managed_hook(helper: Path, user_hook: Path | None, user_sha256: str | None) -> str:
    guard = f"python3 {shlex.quote(str(helper.resolve()))} --root \"$(git rev-parse --show-toplevel)\" staged-check\n"
    if user_hook is None:
        user = ""
    else:
        assert user_sha256 is not None
        quoted = shlex.quote(str(user_hook))
        digest = shlex.quote(user_sha256)
        user = (f"actual=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],\"rb\").read()).hexdigest())' {quoted})\n"
                f"if [ \"$actual\" != {digest} ]; then echo 'controller-checkpoint: approved user hook hash mismatch' >&2; exit 2; fi\n"
                f"if [ -x {quoted} ]; then exec {quoted} \"$@\"; fi\n")
    return "#!/bin/sh\nset -eu\n" + HOOK_MARKER + "\n" + guard + user


def load_hook_metadata(metadata: Path) -> dict[str, Any]:
    try:
        value = json.loads(metadata.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not value.get("helper"):
            raise ValueError("missing helper")
        if bool(value.get("user_hook")) != bool(value.get("user_sha256")):
            raise ValueError("incomplete user hook identity")
        return value
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise CheckpointError(f"managed hook metadata invalid: {exc}") from exc


def verify_managed_hook(hook: Path, metadata: Path) -> tuple[dict[str, Any], str]:
    if not metadata.is_file():
        raise CheckpointError("managed hook metadata missing; refuse operation")
    meta = load_hook_metadata(metadata)
    user = Path(meta["user_hook"]) if meta.get("user_hook") else None
    if user is not None:
        if not user.is_file() or file_sha(user) != meta["user_sha256"]:
            raise CheckpointError("approved user hook hash mismatch; refuse operation")
    expected = managed_hook(Path(meta["helper"]), user, meta.get("user_sha256"))
    if hook.read_text(encoding="utf-8") != expected:
        raise CheckpointError("managed hook drift; refuse operation")
    return meta, expected


def parse_approval(value: str | None) -> tuple[Path, str] | None:
    if not value:
        return None
    raw_path, separator, digest = value.rpartition("=")
    if not separator or not re_full_sha(digest):
        raise CheckpointError("--approve-existing must be exact PATH=SHA256")
    return Path(raw_path).expanduser().resolve(), digest


def re_full_sha(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def hook_command(root: Path, action: str, approval_value: str | None) -> dict[str, Any]:
    hook, user_hook, metadata = hook_paths(root)
    approval = parse_approval(approval_value)
    if action == "status":
        managed = hook.is_file() and HOOK_MARKER in hook.read_text(encoding="utf-8", errors="replace")
        healthy = False
        if managed:
            verify_managed_hook(hook, metadata)
            healthy = True
        return {"action": action, "hook": str(hook), "exists": hook.exists(), "sha256": file_sha(hook) if hook.is_file() else None,
                "managed": managed, "healthy": healthy}
    if action == "install":
        existing_managed = hook.is_file() and HOOK_MARKER in hook.read_text(encoding="utf-8", errors="replace")
        if existing_managed:
            verify_managed_hook(hook, metadata)
            return {"action": action, "outcome": "already_installed", "hook": str(hook)}
        if hook.exists():
            if approval is None or approval[0] != hook or approval[1] != file_sha(hook):
                raise CheckpointError(f"existing pre-commit hook requires explicit approval: --approve-existing {hook}={file_sha(hook)}")
            if user_hook.exists() or metadata.exists(): raise CheckpointError("hook composition sidecar collision")
        elif approval is not None:
            raise CheckpointError("--approve-existing supplied but no existing hook is present")
        helper = Path(__file__).resolve()
        approved_user_sha = approval[1] if hook.exists() and approval else None
        content = managed_hook(helper, user_hook if hook.exists() else None, approved_user_sha)
        hook.parent.mkdir(parents=True, exist_ok=True)
        if hook.exists(): hook.rename(user_hook)
        hook.write_text(content, encoding="utf-8"); hook.chmod(0o755)
        metadata.write_text(json.dumps({"helper": str(helper), "user_hook": str(user_hook) if user_hook.exists() else None,
                                        "user_sha256": approved_user_sha}, sort_keys=True) + "\n")
        return {"action": action, "outcome": "installed", "hook": str(hook), "user_hook": str(user_hook) if user_hook.exists() else None}
    if action == "remove":
        if not hook.is_file() or HOOK_MARKER not in hook.read_text(encoding="utf-8", errors="replace"):
            if metadata.exists() or user_hook.exists():
                raise CheckpointError("managed hook sidecars remain without an intact dispatcher; refuse removal")
            return {"action": action, "outcome": "not_managed_preserved" if hook.exists() else "already_absent", "hook": str(hook)}
        meta, _ = verify_managed_hook(hook, metadata)
        hook.unlink(); metadata.unlink()
        if user_hook.exists(): user_hook.rename(hook)
        return {"action": action, "outcome": "removed", "hook": str(hook)}
    raise CheckpointError(f"unknown hook action: {action}")


def emit(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, sort_keys=True))
    else:
        if "outcome" not in payload or "selected" not in payload:
            print(f"workspace boundary: {payload.get('action', 'passed')} passed={payload.get('passed', True)} role={payload.get('role', '')}")
            return
        selected_paths = payload.get("selected", [])
        print(f"controller checkpoint: {payload['outcome']} ({len(selected_paths)} selected)")
        for path in selected_paths:
            print(f"  {path}")
        for commit in payload.get("commits", []):
            print(f"  commit {commit}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=os.getcwd(), help="Exact repository top level")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="Inspect without mutation")
    plan.add_argument("--json", action="store_true")
    commit = sub.add_parser("commit", help="Create bounded local commit(s)")
    commit.add_argument("--message", default="chore(controller): checkpoint durable controller state")
    commit.add_argument("--agent", action="store_true")
    commit.add_argument("--json", action="store_true")
    clean = sub.add_parser("require-clean", help="Require clean state, optionally checkpoint first")
    clean.add_argument("--checkpoint", action="store_true")
    clean.add_argument("--message", default="chore(controller): checkpoint before integration")
    clean.add_argument("--json", action="store_true")
    staged = sub.add_parser("staged-check", help="Read-only pre-commit staged-tree boundary")
    staged.add_argument("--json", action="store_true")
    committed = sub.add_parser("committed-check", help="Independent committed-tree check for hook bypass")
    committed.add_argument("--base"); committed.add_argument("--json", action="store_true")
    hook = sub.add_parser("hook", help="Explicit managed pre-commit adoption")
    hook.add_argument("action", choices=["install", "status", "remove"]); hook.add_argument("--approve-existing"); hook.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = repo_root(args.root)
    includes, agent_config = load_config(root)
    if args.command == "staged-check":
        payload = boundary_payload(root, includes, staged_paths(root)); require_boundary(payload); emit(payload, args.json); return 0
    if args.command == "committed-check":
        resolution = resolve_role(root)
        requested_base = args.base or resolution.get("role_base")
        if not requested_base:
            raise CheckpointError("committed-check requires --base or persisted workspace roleBase evidence")
        base = git(root, "rev-parse", f"{requested_base}^{{commit}}").strip()
        paths = [value for value in git(root, "diff", "--name-only", "-z", base, "HEAD").split("\0") if value]
        payload = boundary_payload(root, includes, paths, treeish="HEAD"); payload["base"] = base
        require_boundary(payload); emit(payload, args.json); return 0
    if args.command == "hook":
        payload = hook_command(root, args.action, args.approve_existing); emit(payload, args.json); return 0
    should_commit = args.command == "commit" or (args.command == "require-clean" and args.checkpoint)
    lease = acquire_lease(root)
    try:
        frozen = inspect(root, includes, recover_stale_lock=should_commit)
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "root": str(root),
            "branch": frozen["branch"],
            "head": frozen["head"],
            "index_lock": frozen["index_lock"],
            "selected": frozen["selected"],
            "commits": [],
        }
        if not frozen["selected"]:
            payload["outcome"] = "noop"
        elif should_commit:
            groups = agent_groups(root, frozen, agent_config) if getattr(args, "agent", False) else [(frozen["selected"], validate_message(args.message))]
            # Agent is read-only: reject any repository mutation before staging.
            assert_frozen(root, includes, frozen, frozen["selected"])
            payload["commits"] = stage_and_commit(root, includes, frozen, groups)
            payload["outcome"] = "committed"
            payload["head"] = payload["commits"][-1]
        elif args.command == "require-clean":
            raise CheckpointError(f"controller is dirty; run checkpoint first: {frozen['selected']}")
        else:
            payload["outcome"] = "planned"
        emit(payload, getattr(args, "json", False))
        return 0
    finally:
        fcntl.flock(lease.fileno(), fcntl.LOCK_UN)
        lease.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CheckpointError, OSError) as exc:
        print(f"controller_checkpoint: error: {exc}", file=sys.stderr)
        raise SystemExit(2)
