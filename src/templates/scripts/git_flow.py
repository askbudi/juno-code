#!/usr/bin/env python3
"""Configured, fail-closed integration/controller Git synchronization for Juno projects."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA = "juno_git_flow.v1"
DEFAULT_PROTECTED = [
    ".juno_task/archive", ".juno_task/attachments", ".juno_task/ledger",
    ".juno_task/plan.md", ".juno_task/sessions", ".juno_task/specs",
    ".juno_task/tasks", ".juno_task/tmp", ".juno_task/workflows",
]
SHARED = [".juno_task/scripts", ".juno_task/config", ".juno_task/prompts", ".juno_task/wiki", "AGENTS.md"]


class FlowError(Exception):
    pass


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, stdin=subprocess.DEVNULL,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
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
    value = Path(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    return value.resolve()


def resolve(repo: Path, ref: str) -> str:
    return git(repo, "rev-parse", f"{ref}^{{commit}}")


def full_ref(branch: str) -> str:
    return branch if branch.startswith("refs/heads/") else f"refs/heads/{branch}"


def short_ref(branch: str) -> str:
    return full_ref(branch).removeprefix("refs/heads/")


def remote_ref(remote: str, branch: str) -> str:
    return f"refs/remotes/{remote}/{short_ref(branch)}"


def clean(repo: Path) -> bool:
    return git(repo, "status", "--porcelain=v2", "--untracked-files=all") == ""


def attached(repo: Path) -> str | None:
    return git(repo, "symbolic-ref", "-q", "HEAD", check=False) or None


def ancestor(repo: Path, old: str, new: str) -> bool:
    return run(["git", "-C", str(repo), "merge-base", "--is-ancestor", old, new], repo, False).returncode == 0


def counts(repo: Path, left: str, right: str) -> tuple[int, int]:
    a, b = git(repo, "rev-list", "--left-right", "--count", f"{left}...{right}").split()
    return int(a), int(b)


def controller(invocation: Path) -> Path:
    override = os.environ.get("JUNO_TASK_ROOT", "").strip()
    if override:
        candidate = Path(override).expanduser().resolve()
    else:
        registered = git(invocation, "config", "--local", "--get", "juno.controller.path", check=False)
        candidate = Path(registered).expanduser().resolve() if registered else invocation
    if not (candidate / ".juno_task").is_dir():
        raise FlowError(f"configured controller has no .juno_task directory: {candidate}")
    if common(candidate) != common(invocation):
        raise FlowError("controller is not a linked worktree of the invoking repository")
    return candidate


def safe_policy_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts or value in {".", ".git"} or path.parts[0] == ".git":
        raise FlowError(f"unsafe controller-owned path: {value!r}")
    return path


def validate_policy(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA:
        raise FlowError(f"Git-flow policy schema must be {SCHEMA}")
    for key in ("remote", "integrationBranch", "controllerBranch"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise FlowError(f"Git-flow policy requires {key}")
    if value.get("checkoutMode") != "detached":
        raise FlowError("Git-flow v1 requires checkoutMode=detached")
    sub = value.get("submodules")
    if not isinstance(sub, dict) or sub.get("mode") not in {"exact", "tracking"} or not isinstance(sub.get("advanceConfiguredBranches"), bool):
        raise FlowError("invalid submodules policy")
    paths = value.get("controllerOwnedPaths")
    if not isinstance(paths, list) or not paths:
        raise FlowError("controllerOwnedPaths must be a non-empty list")
    normalized = sorted({str(safe_policy_path(item)) for item in paths if isinstance(item, str)})
    if len(normalized) != len(paths):
        raise FlowError("controllerOwnedPaths must contain unique strings")
    for protected in normalized:
        if any(protected == shared or shared.startswith(protected + "/") for shared in SHARED):
            raise FlowError(f"controller-owned path would hide required shared path: {protected}")
    return {**value, "controllerOwnedPaths": normalized}


def config(controller_root: Path) -> tuple[dict[str, Any], Path]:
    main_path = controller_root / ".juno_task" / "config.json"
    try:
        main = json.loads(main_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FlowError(f"cannot read Juno config: {exc}") from exc
    flow = main.get("gitFlow")
    if not isinstance(flow, dict) or flow.get("enabled") is not True:
        raise FlowError("Git flow is disabled; run git-flow.sh configure")
    relative = safe_policy_path(str(flow.get("policy") or ""))
    policy_path = (controller_root / relative).resolve()
    try:
        policy_path.relative_to(controller_root)
        value = json.loads(policy_path.read_text(encoding="utf-8"))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise FlowError(f"cannot read Git-flow policy: {exc}") from exc
    return validate_policy(value), policy_path


def integration(controller_root: Path) -> Path:
    value = git(controller_root, "config", "--local", "--get", "juno.gitFlow.integrationCheckout", check=False)
    if not value:
        raise FlowError("integration checkout is not registered; run git-flow.sh configure")
    candidate = Path(value).expanduser().resolve()
    if common(candidate) != common(controller_root):
        raise FlowError("integration checkout is not linked to the controller repository")
    return candidate


def fetch(repo: Path, remote: str, branch: str, required: bool = True) -> bool:
    probe = run(["git", "-C", str(repo), "ls-remote", "--exit-code", "--heads", remote, full_ref(branch)], repo, False)
    if probe.returncode == 2:
        if required:
            raise FlowError(f"remote branch is missing: {remote}/{short_ref(branch)}")
        return False
    if probe.returncode:
        raise FlowError(probe.stderr.strip() or "git ls-remote failed")
    git(repo, "fetch", "--no-tags", remote, f"+{full_ref(branch)}:{remote_ref(remote, branch)}")
    return True


def tree_has(repo: Path, tree: str, path: str) -> bool:
    return bool(git(repo, "ls-tree", tree, "--", path))


def protected_violations(repo: Path, tree: str, policy: dict[str, Any]) -> list[str]:
    return [path for path in policy["controllerOwnedPaths"] if tree_has(repo, tree, path)]


def submodules(repo: Path, tree: str) -> list[dict[str, str]]:
    modules = repo / ".gitmodules"
    if not modules.exists():
        return []
    raw = git(repo, "config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$", check=False)
    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        key, path = line.split(None, 1)
        section = key[len("submodule."):-len(".path")]
        entry = git(repo, "ls-tree", tree, "--", path).split()
        if len(entry) < 3 or entry[0] != "160000":
            raise FlowError(f"missing gitlink at {tree}: {path}")
        branch = git(repo, "config", "-f", ".gitmodules", "--get", f"submodule.{section}.branch", check=False)
        rows.append({"path": path, "sha": entry[2], "branch": branch})
    return rows


def status_payload(invocation: Path, no_fetch: bool = False) -> dict[str, Any]:
    ctl = controller(invocation)
    policy, policy_path = config(ctl)
    source = integration(ctl)
    source_ref = full_ref(policy["integrationBranch"])
    target_ref = full_ref(policy["controllerBranch"])
    if attached(source):
        raise FlowError("integration checkout must be detached")
    if not no_fetch:
        fetch(ctl, policy["remote"], source_ref, False)
        fetch(ctl, policy["remote"], target_ref, False)
    source_tip, checkout_tip, target_tip = resolve(ctl, source_ref), resolve(source, "HEAD"), resolve(ctl, target_ref)
    source_remote = remote_ref(policy["remote"], source_ref)
    target_remote = remote_ref(policy["remote"], target_ref)
    def relation(local: str, remote: str) -> dict[str, Any]:
        if not git(ctl, "rev-parse", "--verify", remote, check=False):
            return {"remoteExists": False, "ahead": None, "behind": None, "remoteSha": None}
        ahead, behind = counts(ctl, local, remote)
        return {"remoteExists": True, "ahead": ahead, "behind": behind, "remoteSha": resolve(ctl, remote)}
    source_state = relation(source_ref, source_remote)
    target_state = relation(target_ref, target_remote)
    children = []
    for row in submodules(source, checkout_tip):
        child = source / row["path"]
        initialized = child.is_dir() and bool(git(child, "rev-parse", "--show-toplevel", check=False))
        item: dict[str, Any] = {**row, "initialized": initialized}
        if initialized:
            head = resolve(child, "HEAD")
            item.update({"checkoutSha": head, "detached": attached(child) is None, "clean": clean(child), "gitlinkMatch": head == row["sha"]})
        children.append(item)
    violations = protected_violations(ctl, source_tip, policy)
    checkout_ready = clean(source) and checkout_tip == source_tip and not violations
    children_ok = all(item.get("initialized") and item.get("clean") and item.get("detached") and item.get("gitlinkMatch") for item in children)
    remote_synced = source_state.get("remoteExists") is True and source_state.get("ahead") == 0 and source_state.get("behind") == 0
    return {
        "schemaVersion": SCHEMA, "operation": "status", "fetchPerformed": not no_fetch,
        "policy": str(policy_path), "remote": policy["remote"],
        "integration": {"checkout": str(source), "checkoutSha": checkout_tip, "branch": short_ref(source_ref),
                        "branchSha": source_tip, "detached": True, "clean": clean(source),
                        "protectedPathViolations": violations, **source_state},
        "controller": {"checkout": str(ctl), "branch": short_ref(target_ref), "branchSha": target_tip,
                       "clean": clean(ctl), "attachedRef": attached(ctl), **target_state},
        "submodules": children, "integrationReady": checkout_ready and children_ok,
        "integrationSynced": checkout_ready and children_ok and remote_synced,
        "allSynced": checkout_ready and children_ok and remote_synced and target_state.get("ahead") == 0 and target_state.get("behind") == 0,
    }


def render_status(payload: dict[str, Any]) -> str:
    source, target = payload["integration"], payload["controller"]
    relation = lambda item: "NOT PUBLISHED" if not item["remoteExists"] else f"ahead {item['ahead']}, behind {item['behind']}"
    lines = ["JUNO GIT FLOW STATUS", "", "INTEGRATION",
             f"  Checkout: {source['checkout']} @ {source['checkoutSha'][:9]} [DETACHED]",
             f"  Local:    {source['branch']} @ {source['branchSha'][:9]}",
             f"  Remote:   {payload['remote']}/{source['branch']} [{relation(source)}]",
             f"  State:    {'SYNCED' if payload['integrationSynced'] else 'ATTENTION REQUIRED'}", "", "CONTROLLER",
             f"  Checkout: {target['checkout']}", f"  Local:    {target['branch']} @ {target['branchSha'][:9]}",
             f"  Remote:   {payload['remote']}/{target['branch']} [{relation(target)}]", "",
             f"SUBMODULES: {len(payload['submodules'])}"]
    if source["protectedPathViolations"]:
        lines.append("PROTECTED PATH VIOLATIONS: " + ", ".join(source["protectedPathViolations"]))
    return "\n".join(lines)


@contextmanager
def lease(repo: Path):
    path = common(repo) / "juno-integration-owner.lock"
    handle = path.open("a+")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise FlowError(f"Git-flow lease is busy: {path}") from exc
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def configure(args: argparse.Namespace, invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation)
    source = root(args.integration_checkout.expanduser().resolve())
    if common(source) != common(ctl):
        raise FlowError("integration checkout and controller must be linked worktrees")
    if attached(source):
        raise FlowError("integration checkout must be detached")
    if attached(ctl) != full_ref(args.controller_branch):
        raise FlowError("controller checkout must be attached to the configured controller branch")
    resolve(ctl, full_ref(args.integration_branch)); resolve(ctl, full_ref(args.controller_branch))
    policy = validate_policy({"schemaVersion": SCHEMA, "remote": args.remote,
        "integrationBranch": short_ref(args.integration_branch), "controllerBranch": short_ref(args.controller_branch),
        "checkoutMode": "detached", "submodules": {"mode": args.submodules,
        "advanceConfiguredBranches": args.advance_submodule_branches}, "controllerOwnedPaths": DEFAULT_PROTECTED})
    policy_path = ctl / ".juno_task" / "config" / "git-flow.json"
    policy_path.parent.mkdir(parents=True, exist_ok=True)
    policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    main_path = ctl / ".juno_task" / "config.json"
    main = json.loads(main_path.read_text(encoding="utf-8"))
    main["gitFlow"] = {"enabled": True, "policy": ".juno_task/config/git-flow.json"}
    main_path.write_text(json.dumps(main, indent=2) + "\n", encoding="utf-8")
    git(ctl, "config", "--local", "juno.gitFlow.integrationCheckout", str(source))
    return {"operation": "configure", "policy": str(policy_path), "integrationCheckout": str(source),
            "status": status_payload(ctl, True)}


def sync(invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation); policy, _ = config(ctl); source = integration(ctl)
    with lease(ctl):
        if not clean(source): raise FlowError("integration checkout is dirty")
        if attached(source): raise FlowError("integration checkout must be detached")
        source_ref = full_ref(policy["integrationBranch"]); fetch(ctl, policy["remote"], source_ref, False)
        tracking = remote_ref(policy["remote"], source_ref)
        if git(ctl, "rev-parse", "--verify", tracking, check=False):
            local, remote = resolve(ctl, source_ref), resolve(ctl, tracking); ahead, behind = counts(ctl, source_ref, tracking)
            if ahead and behind: raise FlowError("integration branch diverged from remote")
            if behind: git(ctl, "update-ref", source_ref, remote, local)
        tip = resolve(ctl, source_ref); git(source, "switch", "--detach", tip)
        git(source, "submodule", "sync", "--recursive")
        git(source, "submodule", "update", "--init", "--recursive", "--checkout", "--force")
        advanced: list[str] = []
        if policy["submodules"]["advanceConfiguredBranches"]:
            for row in submodules(source, tip):
                if not row["branch"]: raise FlowError(f"submodule branch is not configured: {row['path']}")
                child = source / row["path"]
                if not clean(child): raise FlowError(f"dirty submodule: {row['path']}")
                fetch(child, policy["remote"], row["branch"])
                remote_tip = resolve(child, remote_ref(policy["remote"], row["branch"]))
                if row["sha"] != remote_tip:
                    if not ancestor(child, row["sha"], remote_tip): raise FlowError(f"submodule diverged: {row['path']}")
                    git(child, "switch", "--detach", remote_tip); git(source, "add", "--", row["path"]); advanced.append(row["path"])
            if advanced:
                old = tip; git(source, "commit", "-m", "chore(integration): update submodule pointers")
                tip = resolve(source, "HEAD"); git(ctl, "update-ref", source_ref, tip, old)
        for row in submodules(source, tip):
            child = source / row["path"]
            git(child, "switch", "--detach", row["sha"])
        if not clean(source): raise FlowError("post-sync integration checkout is dirty")
    return {"operation": "sync", "advancedSubmodules": advanced, "status": status_payload(invocation)}


def push(invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation); policy, _ = config(ctl); source = integration(ctl)
    with lease(ctl):
        before = status_payload(invocation)
        item = before["integration"]
        if not item["clean"] or item["checkoutSha"] != item["branchSha"] or item["protectedPathViolations"]:
            raise FlowError("integration checkout is not eligible for push; run status/sync")
        if item.get("behind"): raise FlowError("integration remote is ahead or divergent")
        pushed: list[str] = []
        if policy["submodules"]["advanceConfiguredBranches"]:
            for row in submodules(source, item["branchSha"]):
                child = source / row["path"]
                if not row["branch"]: raise FlowError(f"submodule branch missing: {row['path']}")
                fetch(child, policy["remote"], row["branch"])
                tracking = remote_ref(policy["remote"], row["branch"])
                ahead, behind = counts(child, row["sha"], tracking)
                if behind: raise FlowError(f"submodule remote is ahead/diverged: {row['path']}")
                if ahead:
                    git(child, "push", policy["remote"], f"{row['sha']}:{full_ref(row['branch'])}"); pushed.append(row["path"])
        git(source, "push", "--recurse-submodules=check", policy["remote"],
            f"{full_ref(policy['integrationBranch'])}:{full_ref(policy['integrationBranch'])}")
        pushed.append("root")
        after = status_payload(invocation)
        if not after["integrationSynced"]: raise FlowError("post-push integration parity verification failed")
    return {"operation": "push", "pushed": pushed, "status": after}


def controller_sync(invocation: Path) -> dict[str, Any]:
    ctl = controller(invocation); policy, _ = config(ctl); source = integration(ctl)
    source_ref, target_ref = full_ref(policy["integrationBranch"]), full_ref(policy["controllerBranch"])
    with lease(ctl):
        if attached(ctl) != target_ref or not clean(ctl): raise FlowError("controller checkout must be clean and attached to its configured branch")
        before = status_payload(invocation, True)
        if not before["integrationReady"]: raise FlowError("integration checkout is not ready; run status/sync")
        source_tip, target_tip = resolve(ctl, source_ref), resolve(ctl, target_ref)
        violations = protected_violations(ctl, source_tip, policy)
        if violations: raise FlowError("integration contains controller-owned paths: " + ", ".join(violations))
        temp = Path(tempfile.mkdtemp(prefix="juno-git-flow-candidate-"))
        candidate = temp / "candidate"
        try:
            git(ctl, "worktree", "add", "--detach", str(candidate), target_tip)
            merged = run(["git", "-C", str(candidate), "merge", "--no-ff", "--no-commit", source_tip], candidate, False)
            conflicts = git(candidate, "diff", "--name-only", "--diff-filter=U", check=False).splitlines()
            product_conflicts = [p for p in conflicts if not any(p == x or p.startswith(x + "/") for x in policy["controllerOwnedPaths"])]
            if product_conflicts: raise FlowError("controller-sync product conflicts: " + ", ".join(product_conflicts))
            for protected in policy["controllerOwnedPaths"]:
                if tree_has(ctl, target_tip, protected):
                    git(candidate, "checkout", target_tip, "--", protected)
                else:
                    run(["git", "-C", str(candidate), "rm", "-rf", "--ignore-unmatch", "--", protected], candidate, False)
            if merged.returncode and not conflicts: raise FlowError(merged.stderr.strip() or "controller candidate merge failed")
            git(candidate, "add", "-A")
            tree = git(candidate, "write-tree")
            message = f"chore(controller): sync {short_ref(source_ref)}"
            candidate_sha = run(["git", "-C", str(candidate), "commit-tree", tree, "-p", target_tip, "-p", source_tip, "-m", message], candidate).stdout.strip()
            parents = git(candidate, "show", "-s", "--format=%P", candidate_sha).split()
            if parents != [target_tip, source_tip]: raise FlowError("candidate parent identity mismatch")
            for protected in policy["controllerOwnedPaths"]:
                target_entry = git(ctl, "ls-tree", target_tip, "--", protected)
                candidate_entry = git(ctl, "ls-tree", candidate_sha, "--", protected)
                if target_entry != candidate_entry:
                    raise FlowError(f"controller-owned path changed: {protected}")
            if resolve(ctl, target_ref) != target_tip or resolve(ctl, "HEAD") != target_tip or not clean(ctl):
                raise FlowError("controller moved while candidate was built")
            # Use the canonical target-channel lock and exact expected-SHA update
            # primitive from integration_owner_preflight, then refresh the clean
            # checked-out controller without a check-then-merge race.
            scripts = Path(__file__).resolve().parent
            if str(scripts) not in sys.path:
                sys.path.insert(0, str(scripts))
            try:
                import integration_owner_preflight as authority
            except ImportError as exc:
                raise FlowError("controller-sync requires integration_owner_preflight.py") from exc
            authority_item = {"path": ctl, "target_ref": target_ref}
            lock_path = authority.lock_file(authority_item)
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            with lock_path.open("a+") as channel_lock:
                authority.acquire_bounded(channel_lock, 30)
                try:
                    if resolve(ctl, target_ref) != target_tip or resolve(ctl, "HEAD") != target_tip or not clean(ctl):
                        raise FlowError("controller moved before expected-SHA CAS")
                    git(ctl, "switch", "--detach", target_tip)
                    update = authority.run(ctl, "update-ref", target_ref, candidate_sha, target_tip, check=False)
                    if update.returncode:
                        git(ctl, "switch", short_ref(target_ref), check=False)
                        raise FlowError("controller expected-SHA CAS refused: " + update.stderr.strip())
                    git(ctl, "switch", short_ref(target_ref))
                finally:
                    fcntl.flock(channel_lock.fileno(), fcntl.LOCK_UN)
            if resolve(ctl, target_ref) != candidate_sha or resolve(ctl, "HEAD") != candidate_sha or not clean(ctl):
                raise FlowError("controller CAS readback failed")
        finally:
            git(ctl, "worktree", "remove", "--force", str(candidate), check=False)
            shutil.rmtree(temp, ignore_errors=True)
    return {"operation": "controller-sync", "before": target_tip, "integration": source_tip,
            "controller": candidate_sha, "remotePublished": False,
            "casAuthority": "integration_owner_preflight.target_channel_lock+update_ref"}


def parser() -> argparse.ArgumentParser:
    root_p = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    sub = root_p.add_subparsers(dest="operation", required=True)
    c = sub.add_parser("configure", allow_abbrev=False)
    c.add_argument("--integration-branch", required=True); c.add_argument("--controller-branch", required=True)
    c.add_argument("--integration-checkout", type=Path, required=True); c.add_argument("--remote", default="origin")
    c.add_argument("--submodules", choices=["exact", "tracking"], default="exact")
    c.add_argument("--advance-submodule-branches", action="store_true")
    s = sub.add_parser("status", allow_abbrev=False); s.add_argument("--no-fetch", action="store_true")
    s.add_argument("--details", action="store_true"); s.add_argument("--strict", action="store_true"); s.add_argument("--json", action="store_true")
    for name in ("sync", "push", "controller-sync"):
        p = sub.add_parser(name, allow_abbrev=False); p.add_argument("--json", action="store_true")
    return root_p


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        invocation = root(Path.cwd())
        if args.operation == "configure": result = configure(args, invocation)
        elif args.operation == "status": result = status_payload(invocation, args.no_fetch)
        elif args.operation == "sync": result = sync(invocation)
        elif args.operation == "push": result = push(invocation)
        else: result = controller_sync(invocation)
        as_json = getattr(args, "json", False)
        if args.operation == "status" and not as_json: print(render_status(result))
        else: print(json.dumps(result, indent=2, sort_keys=True))
        return 3 if getattr(args, "strict", False) and not result["integrationSynced"] else 0
    except (FlowError, OSError, json.JSONDecodeError) as exc:
        print(f"git-flow: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
