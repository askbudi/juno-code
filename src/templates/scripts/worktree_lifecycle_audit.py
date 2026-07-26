#!/usr/bin/env python3
"""Read-only, fail-closed Git worktree inventory and cleanup classification."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


SKIP_DIRS = {
    ".cache",
    ".git",
    ".next",
    ".pytest_cache",
    ".venv",
    ".venv_backend",
    ".venv_juno",
    "coverage",
    "node_modules",
}


def git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def repo_key(root: Path, repo: Path) -> str:
    try:
        relative = repo.resolve().relative_to(root.resolve())
    except ValueError:
        return str(repo.resolve())
    return "." if str(relative) == "." else str(relative)


def discover_repositories(root: Path) -> list[Path]:
    """Find the root repo, declared submodules, and embedded repositories."""
    root = root.resolve()
    found: set[Path] = set()
    for current, dirs, _files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in SKIP_DIRS]
        path = Path(current)
        if path == root or (path / ".git").exists():
            probe = git(path, "rev-parse", "--git-dir")
            if probe.returncode == 0:
                found.add(path.resolve())
                if path != root:
                    dirs[:] = []
    if root not in found:
        raise RuntimeError(f"not a Git repository: {root}")
    return sorted(found, key=lambda path: (path != root, str(path)))


def parse_worktree_porcelain(text: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    for line in [*text.splitlines(), ""]:
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key in {"detached", "bare"}:
            current[key] = True
        elif key in {"locked", "prunable"}:
            current[key] = value or True
        else:
            current[key] = value
    return records


def default_target(repo: Path) -> str | None:
    upstream = git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    if upstream.returncode == 0 and upstream.stdout.strip():
        return upstream.stdout.strip()
    remote_head = git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    if remote_head.returncode == 0 and remote_head.stdout.strip():
        return remote_head.stdout.strip()
    for ref in ("origin/main", "origin/master", "main", "master"):
        if git(repo, "rev-parse", "--verify", "--quiet", ref).returncode == 0:
            return ref
    return None


def initialized_nested_paths(worktree: Path) -> list[str]:
    listing = git(worktree, "ls-files", "--stage")
    if listing.returncode != 0:
        return []
    nested: list[str] = []
    for line in listing.stdout.splitlines():
        metadata, separator, path_text = line.partition("\t")
        if not separator or not metadata.startswith("160000 "):
            continue
        nested_path = worktree / path_text
        if nested_path.is_symlink() or (nested_path / ".git").exists():
            nested.append(path_text)

    # `git submodule deinit` clears the nested working directory but intentionally
    # retains worktree-specific Git metadata. Git refuses ordinary worktree
    # removal while this modules directory exists, so cleanup classification must
    # not claim the parent is an automatic candidate.
    git_dir_result = git(worktree, "rev-parse", "--git-dir")
    if git_dir_result.returncode == 0:
        git_dir = Path(git_dir_result.stdout.strip())
        if not git_dir.is_absolute():
            git_dir = (worktree / git_dir).resolve()
        modules_dir = git_dir / "modules"
        if modules_dir.is_dir():
            for entry in sorted(modules_dir.iterdir()):
                marker = f"git-metadata:{entry.name}"
                if entry.is_dir() and marker not in nested:
                    nested.append(marker)
    return nested


def classify_worktree(
    *,
    exists: bool,
    locked: bool,
    prunable: bool,
    status_error: bool,
    dirty: bool,
    target_exists: bool,
    reachability: str,
    nested: bool,
) -> tuple[str, bool]:
    """Return disposition and whether automatic cleanup may be proposed."""
    if not exists:
        return "stale_missing_path", False
    if locked:
        return "locked", False
    if prunable:
        return "prunable_registration", False
    if status_error:
        return "status_error", False
    if dirty:
        return "dirty", False
    if not target_exists:
        return "target_unknown", False
    if reachability == "integrated":
        return ("clean_integrated_nested" if nested else "clean_integrated"), not nested
    if reachability == "ahead":
        return "clean_unintegrated_ahead", False
    if reachability == "divergent":
        return "clean_divergent", False
    return "reachability_error", False


def audit_repository(repo: Path, root: Path, target: str | None) -> dict[str, Any]:
    listed = git(repo, "worktree", "list", "--porcelain")
    if listed.returncode != 0:
        return {
            "repository": repo_key(root, repo),
            "path": str(repo),
            "target": target,
            "error": "worktree_list_failed",
            "worktrees": [],
        }
    records = parse_worktree_porcelain(listed.stdout)
    target_exists = bool(target) and git(repo, "rev-parse", "--verify", "--quiet", str(target)).returncode == 0
    rows: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        path = Path(record["worktree"])
        exists = path.exists()
        status = git(path, "status", "--porcelain=v1", "--untracked-files=all") if exists else None
        status_error = bool(status and status.returncode != 0)
        dirty_entries = len(status.stdout.splitlines()) if status and status.returncode == 0 else None
        nested_paths = initialized_nested_paths(path) if exists else []
        reachability = "unknown"
        if exists and not status_error and target_exists:
            integrated = git(repo, "merge-base", "--is-ancestor", record["HEAD"], str(target))
            if integrated.returncode == 0:
                reachability = "integrated"
            else:
                ahead = git(repo, "merge-base", "--is-ancestor", str(target), record["HEAD"])
                reachability = "ahead" if ahead.returncode == 0 else "divergent"
        disposition, cleanup_candidate = classify_worktree(
            exists=exists,
            locked="locked" in record,
            prunable="prunable" in record,
            status_error=status_error,
            dirty=bool(dirty_entries),
            target_exists=bool(target_exists),
            reachability=reachability,
            nested=bool(nested_paths),
        )
        is_primary = index == 0
        rows.append(
            {
                "path": str(path),
                "head": record.get("HEAD"),
                "branch": record.get("branch"),
                "detached": bool(record.get("detached")),
                "primary": is_primary,
                "exists": exists,
                "locked": record.get("locked", False),
                "prunable": record.get("prunable", False),
                "dirty_entries": dirty_entries,
                "status_error": status.stderr.strip() if status_error and status else None,
                "initialized_nested_paths": nested_paths,
                "reachability": reachability,
                "disposition": disposition,
                "cleanup_candidate": cleanup_candidate and not is_primary,
            }
        )
    prune = git(repo, "worktree", "prune", "--dry-run", "--verbose")
    return {
        "repository": repo_key(root, repo),
        "path": str(repo),
        "target": target,
        "target_exists": bool(target_exists),
        "prune_dry_run": [line for line in (prune.stdout + prune.stderr).splitlines() if line],
        "worktrees": rows,
    }


def parse_targets(values: Iterable[str]) -> dict[str, str]:
    targets: dict[str, str] = {}
    for value in values:
        key, separator, ref = value.partition("=")
        if not separator or not key.strip() or not ref.strip():
            raise ValueError(f"invalid --target mapping: {value!r}; expected REPOSITORY=REF")
        targets[key.strip()] = ref.strip()
    return targets


def render_table(payload: dict[str, Any]) -> str:
    lines = ["repository\tprimary\tdisposition\tcleanup\tdirty\ttarget\tpath"]
    for repository in payload["repositories"]:
        for row in repository["worktrees"]:
            lines.append(
                "\t".join(
                    [
                        repository["repository"],
                        str(row["primary"]).lower(),
                        row["disposition"],
                        str(row["cleanup_candidate"]).lower(),
                        "error" if row["dirty_entries"] is None else str(row["dirty_entries"]),
                        str(repository["target"] or ""),
                        row["path"],
                    ]
                )
            )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--target",
        action="append",
        default=[],
        metavar="REPOSITORY=REF",
        help="Override the integration target for a repo key such as .=origin/feature or backend=origin/main.",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a tab-separated table.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    try:
        target_overrides = parse_targets(args.target)
        repositories = discover_repositories(root)
        audits = []
        for repo in repositories:
            key = repo_key(root, repo)
            target = target_overrides.get(key, default_target(repo))
            audits.append(audit_repository(repo, root, target))
    except (OSError, RuntimeError, ValueError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    rows = [row for repository in audits for row in repository["worktrees"]]
    payload = {
        "status": "ok",
        "contract": "worktree_lifecycle_audit_v1",
        "root": str(root),
        "summary": {
            "repositories": len(audits),
            "worktrees": len(rows),
            "auxiliary_worktrees": sum(not row["primary"] for row in rows),
            "cleanup_candidates": sum(row["cleanup_candidate"] for row in rows),
            "blocked_or_manual": sum(not row["primary"] and not row["cleanup_candidate"] for row in rows),
        },
        "repositories": audits,
    }
    print(json.dumps(payload, indent=2, sort_keys=True) if args.json else render_table(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
