#!/usr/bin/env python3
"""Small Git-flow compatibility surface for Bolt projects.

Feature delivery is owned by ``yy task`` and ``yy merge``.  This helper retains
only read-only status plus explicitly invoked integration-branch sync/push for
older projects.  It never reconciles product bytes into controller history.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
SCRIPT_DIR = Path(__file__).resolve().parent
SCHEMAS = {"juno_git_flow.v1", "juno_git_flow.v2"}


class FlowError(Exception):
    pass


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        capture_output=True,
        stdin=subprocess.DEVNULL,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
    )
    if check and result.returncode:
        raise FlowError(result.stderr.strip() or result.stdout.strip() or f"command failed: {' '.join(argv)}")
    return result


def git(repo: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(repo), *args], repo, check).stdout.strip()


def root(path: Path) -> Path:
    value = git(path, "rev-parse", "--show-toplevel", check=False)
    if not value:
        raise FlowError(f"not a Git worktree: {path}")
    return Path(value).resolve()


def common(path: Path) -> Path:
    return Path(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()


def full_ref(branch: str) -> str:
    value = branch if branch.startswith("refs/heads/") else f"refs/heads/{branch}"
    if not re.fullmatch(r"refs/heads/[A-Za-z0-9._/-]+", value):
        raise FlowError("branch must be an exact local head ref")
    return value


def short_ref(branch: str) -> str:
    return full_ref(branch).removeprefix("refs/heads/")


def resolve(repo: Path, ref: str) -> str:
    value = git(repo, "rev-parse", f"{ref}^{{commit}}", check=False)
    if not re.fullmatch(r"[0-9a-f]{40,64}", value):
        raise FlowError(f"missing commit ref: {ref}")
    return value


def clean(repo: Path) -> bool:
    return git(repo, "status", "--porcelain=v2", "--untracked-files=all") == ""


def attached(repo: Path) -> str | None:
    return git(repo, "symbolic-ref", "-q", "HEAD", check=False) or None


def controller(invocation: Path) -> Path:
    resolver = SCRIPT_DIR / "controller_resolver.py"
    result = run(
        [sys.executable, str(resolver), "--cwd", str(invocation), "--operation", "diagnostic", "--format", "json"],
        invocation,
        False,
    )
    try:
        payload = json.loads(result.stdout)
        candidate = Path(payload["path"]).resolve()
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise FlowError(result.stderr.strip() or "controller resolver returned invalid JSON") from exc
    if result.returncode or payload.get("valid") is not True:
        raise FlowError(result.stderr.strip() or "controller resolver refused Git-flow context")
    return candidate


def policy(controller_root: Path) -> tuple[dict[str, Any], Path]:
    main_path = controller_root / ".juno_task/config.json"
    try:
        main = json.loads(main_path.read_text(encoding="utf-8"))
        relative = main["gitFlow"]["policy"]
        value_path = (controller_root / relative).resolve()
        value = json.loads(value_path.read_text(encoding="utf-8"))
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise FlowError(f"cannot read Git-flow policy: {exc}") from exc
    if value.get("schemaVersion") not in SCHEMAS:
        raise FlowError("unsupported Git-flow policy; use `yy task` and `yy merge` for feature delivery")
    if value.get("controllerSync", {}).get("enabled") is True:
        raise FlowError("legacy controller synchronization is removed; disable it and use `yy task`/`yy merge`")
    for key in ("remote", "integrationBranch"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise FlowError(f"Git-flow policy requires {key}")
    return value, value_path


def integration(controller_root: Path) -> Path:
    value = git(controller_root, "config", "--local", "--get", "juno.gitFlow.integrationCheckout", check=False)
    if not value:
        raise FlowError("integration checkout is not registered")
    candidate = Path(value).expanduser().resolve()
    if common(candidate) != common(controller_root):
        raise FlowError("integration checkout is not linked to the registered repository")
    return candidate


def remote_ref(remote: str, branch: str) -> str:
    return f"refs/remotes/{remote}/{short_ref(branch)}"


def counts(repo: Path, left: str, right: str) -> tuple[int, int]:
    ahead, behind = git(repo, "rev-list", "--left-right", "--count", f"{left}...{right}").split()
    return int(ahead), int(behind)


def fetch(repo: Path, remote: str, branch: str) -> bool:
    result = run(["git", "-C", str(repo), "ls-remote", "--exit-code", "--heads", remote, full_ref(branch)], repo, False)
    if result.returncode == 2:
        return False
    if result.returncode:
        raise FlowError(result.stderr.strip() or "git ls-remote failed")
    git(repo, "fetch", "--no-tags", remote, f"+{full_ref(branch)}:{remote_ref(remote, branch)}")
    return True


def status_payload(invocation: Path, no_fetch: bool = False) -> dict[str, Any]:
    ctl = controller(invocation)
    config, config_path = policy(ctl)
    checkout = integration(ctl)
    branch_ref = full_ref(config["integrationBranch"])
    if attached(checkout):
        raise FlowError("integration checkout must be detached")
    remote_exists = False if no_fetch else fetch(ctl, config["remote"], branch_ref)
    tracking = remote_ref(config["remote"], branch_ref)
    if no_fetch:
        remote_exists = bool(git(ctl, "rev-parse", "--verify", tracking, check=False))
    branch_sha = resolve(ctl, branch_ref)
    checkout_sha = resolve(checkout, "HEAD")
    ahead = behind = None
    remote_sha = None
    if remote_exists:
        ahead, behind = counts(ctl, branch_ref, tracking)
        remote_sha = resolve(ctl, tracking)
    ready = clean(checkout) and checkout_sha == branch_sha
    return {
        "schemaVersion": config["schemaVersion"],
        "operation": "status",
        "policy": str(config_path),
        "integration": {
            "checkout": str(checkout),
            "branch": short_ref(branch_ref),
            "branchSha": branch_sha,
            "checkoutSha": checkout_sha,
            "clean": clean(checkout),
            "detached": True,
            "remoteExists": remote_exists,
            "remoteSha": remote_sha,
            "ahead": ahead,
            "behind": behind,
        },
        "integrationReady": ready,
        "integrationSynced": ready and remote_exists and ahead == 0 and behind == 0,
    }


@contextmanager
def lease(repo: Path):
    path = common(repo) / "juno-integration-owner.lock"
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise FlowError(f"Git-flow lease is busy: {path}") from exc
        yield


def sync(invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation)
    config, _ = policy(ctl)
    checkout = integration(ctl)
    with lease(ctl):
        if not clean(checkout) or attached(checkout):
            raise FlowError("integration checkout must be clean and detached")
        branch_ref = full_ref(config["integrationBranch"])
        if fetch(ctl, config["remote"], branch_ref):
            tracking = remote_ref(config["remote"], branch_ref)
            old, new = resolve(ctl, branch_ref), resolve(ctl, tracking)
            ahead, behind = counts(ctl, branch_ref, tracking)
            if ahead and behind:
                raise FlowError("integration branch diverged from remote")
            if behind:
                git(ctl, "update-ref", branch_ref, new, old)
        git(checkout, "switch", "--detach", resolve(ctl, branch_ref))
        git(checkout, "submodule", "sync", "--recursive")
        git(checkout, "submodule", "update", "--init", "--recursive", "--checkout", "--force")
    return {"operation": "sync", "status": status_payload(invocation)}


def push(invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation)
    config, _ = policy(ctl)
    checkout = integration(ctl)
    with lease(ctl):
        before = status_payload(invocation)
        item = before["integration"]
        if not before["integrationReady"] or item.get("behind"):
            raise FlowError("integration checkout is not eligible for push")
        branch_ref = full_ref(config["integrationBranch"])
        git(checkout, "push", "--recurse-submodules=check", config["remote"], f"{branch_ref}:{branch_ref}")
    return {"operation": "push", "status": status_payload(invocation)}


def configure(_: argparse.Namespace, __: Path) -> dict[str, Any]:
    raise FlowError("legacy Git-flow configuration is frozen; use `yy task` and `yy merge`")


def parser() -> argparse.ArgumentParser:
    root_parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    commands = root_parser.add_subparsers(dest="operation", required=True)
    commands.add_parser("configure", allow_abbrev=False)
    status = commands.add_parser("status", allow_abbrev=False)
    status.add_argument("--no-fetch", action="store_true")
    status.add_argument("--strict", action="store_true")
    status.add_argument("--json", action="store_true")
    for name in ("sync", "push"):
        command = commands.add_parser(name, allow_abbrev=False)
        command.add_argument("--json", action="store_true")
    removed = commands.add_parser("controller-sync", allow_abbrev=False)
    removed.add_argument("args", nargs=argparse.REMAINDER)
    return root_parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        if args.operation == "controller-sync":
            raise FlowError("legacy controller synchronization is removed; use `yy task` and `yy merge`")
        invocation = root(Path.cwd())
        if args.operation == "configure":
            result = configure(args, invocation)
        elif args.operation == "status":
            result = status_payload(invocation, args.no_fetch)
        elif args.operation == "sync":
            result = sync(invocation)
        else:
            result = push(invocation)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 3 if getattr(args, "strict", False) and not result["integrationSynced"] else 0
    except (FlowError, OSError, json.JSONDecodeError) as exc:
        print(f"git-flow: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
