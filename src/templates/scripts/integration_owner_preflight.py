#!/usr/bin/env python3
"""Prove clean, stable integration owners and optionally hold leases around a command."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised on non-POSIX platforms
    fcntl = None  # type: ignore[assignment]


SCHEMA_VERSION = "juno_integration_owner_preflight.v1"
WRITER_RE = re.compile(r"(?:^|[ /])(juno-code|yy|ypl|workflow_runner\.sh)(?:[ /]|$)")


class PreflightError(Exception):
    pass


def run_git(path: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(path), *args], text=True, capture_output=True)
    if check and result.returncode != 0:
        raise PreflightError(f"git[{path}] {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_repository(value: str) -> dict[str, Any]:
    if "=" not in value or "," not in value:
        raise argparse.ArgumentTypeError("repository must be NAME=PATH,TARGET_REF")
    name, remainder = value.split("=", 1)
    path_text, target_ref = remainder.rsplit(",", 1)
    if not name.strip() or not path_text.strip() or not target_ref.strip():
        raise argparse.ArgumentTypeError("repository must contain non-empty name, path, and target ref")
    return {"name": name.strip(), "path": Path(path_text).expanduser().resolve(), "target_ref": target_ref.strip()}


def repository_snapshot(repository: dict[str, Any]) -> dict[str, Any]:
    path = repository["path"]
    if not path.is_dir():
        raise PreflightError(f"repository[{repository['name']}].path missing: {path}")
    root = Path(run_git(path, "rev-parse", "--show-toplevel")).resolve()
    head = run_git(path, "rev-parse", "HEAD")
    checked_out_ref = run_git(path, "symbolic-ref", "-q", "HEAD", check=False)
    target_sha = run_git(path, "rev-parse", repository["target_ref"])
    status = run_git(path, "status", "--porcelain=v2", "--untracked-files=all")
    common_dir_raw = run_git(path, "rev-parse", "--git-common-dir")
    common_dir = Path(common_dir_raw)
    if not common_dir.is_absolute():
        common_dir = path / common_dir
    return {
        "name": repository["name"],
        "path": str(path),
        "root": str(root),
        "target_ref": repository["target_ref"],
        "target_sha": target_sha,
        "head": head,
        "checked_out_ref": checked_out_ref,
        "clean": status == "",
        "status_sha256": digest(status),
        "git_common_dir": str(common_dir.resolve()),
    }


def process_ancestry(pid: int) -> set[int]:
    ancestry: set[int] = set()
    current = pid
    while current > 0 and current not in ancestry:
        ancestry.add(current)
        result = subprocess.run(["ps", "-o", "ppid=", "-p", str(current)], text=True, capture_output=True)
        try:
            current = int(result.stdout.strip())
        except (TypeError, ValueError):
            break
    return ancestry


def process_cwd(pid: int) -> Path | None:
    proc_cwd = Path(f"/proc/{pid}/cwd")
    try:
        return proc_cwd.resolve(strict=True)
    except OSError:
        pass
    result = subprocess.run(
        ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
        text=True,
        capture_output=True,
    )
    for line in result.stdout.splitlines():
        if line.startswith("n/"):
            return Path(line[1:]).resolve()
    return None


def cwd_git_common_dir(cwd: Path | None) -> str | None:
    if cwd is None:
        return None
    result = subprocess.run(
        ["git", "-C", str(cwd), "rev-parse", "--path-format=absolute", "--git-common-dir"],
        text=True,
        capture_output=True,
    )
    return str(Path(result.stdout.strip()).resolve()) if result.returncode == 0 and result.stdout.strip() else None


def system_process_inventory() -> list[dict[str, Any]]:
    result = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], text=True, capture_output=True)
    if result.returncode != 0:
        raise PreflightError(f"process inventory failed: {result.stderr.strip()}")
    processes: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        command = parts[2]
        process: dict[str, Any] = {"pid": pid, "ppid": ppid, "command": command}
        if WRITER_RE.search(command):
            cwd = process_cwd(pid)
            process["cwd_git_common_dir"] = cwd_git_common_dir(cwd)
        processes.append(process)
    return processes


def classify_processes(
    repositories: list[dict[str, Any]], processes: list[dict[str, Any]], excluded_pids: set[int]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    classified: list[dict[str, Any]] = []
    writers: list[dict[str, Any]] = []
    for process in processes:
        pid = int(process.get("pid", -1))
        command = str(process.get("command") or "")
        explicit_writer = process.get("writer")
        matched = [repo["name"] for repo in repositories if str(repo["path"]) in command or str(repo.get("root")) in command]
        writer_command = bool(explicit_writer) if explicit_writer is not None else bool(WRITER_RE.search(command))
        process_common_dir = process.get("cwd_git_common_dir")
        repository_common_dirs = {repo["git_common_dir"] for repo in repositories}
        scope_known_elsewhere = bool(process_common_dir) and process_common_dir not in repository_common_dirs
        # Repository leases are authoritative for current Juno wrappers. Keep a
        # fail-closed process fallback for legacy/uninstrumented writers whose
        # repository cannot be resolved, but do not block a proven different repo.
        is_writer = writer_command and not scope_known_elsewhere
        excluded = pid in excluded_pids
        item = {
            "pid": pid,
            "ppid": int(process.get("ppid", -1)),
            "writer": is_writer,
            "excluded_as_caller_ancestry": excluded,
            "matched_repositories": matched,
            "command_sha256": digest(command),
        }
        classified.append(item)
        if is_writer and not excluded:
            writers.append(item)
    return classified, writers


def observe_repositories(
    repositories: list[dict[str, Any]],
    seconds: float,
    processes: list[dict[str, Any]],
    *,
    sleep_fn: Callable[[float], None] = time.sleep,
    excluded_pids: set[int] | None = None,
) -> dict[str, Any]:
    before = [repository_snapshot(repository) for repository in repositories]
    for snapshot in before:
        if snapshot["checked_out_ref"] != snapshot["target_ref"]:
            raise PreflightError(
                f"repository[{snapshot['name']}].checked_out_ref: expected={snapshot['target_ref']!r} actual={snapshot['checked_out_ref']!r}"
            )
        if snapshot["head"] != snapshot["target_sha"]:
            raise PreflightError(
                f"repository[{snapshot['name']}].head: expected target={snapshot['target_sha']} actual={snapshot['head']}"
            )
        if not snapshot["clean"]:
            raise PreflightError(f"repository[{snapshot['name']}].clean: expected=true actual=false")
    effective_excluded_pids = process_ancestry(os.getpid()) if excluded_pids is None else excluded_pids
    classified, writers = classify_processes(before, processes, effective_excluded_pids)
    if writers:
        raise PreflightError(f"other_write_capable_processes: expected=0 actual={len(writers)}")
    sleep_fn(seconds)
    after = [repository_snapshot(repository) for repository in repositories]
    for first, second in zip(before, after):
        for field in ("head", "target_sha", "checked_out_ref", "status_sha256", "clean"):
            if first[field] != second[field]:
                raise PreflightError(
                    f"repository[{first['name']}].stable[{field}]: expected={first[field]!r} actual={second[field]!r}"
                )
    candidates = [
        item
        for item in classified
        if item["writer"] or item["matched_repositories"] or item["excluded_as_caller_ancestry"]
    ]
    return {
        "before": before,
        "after": after,
        "process_inventory_count": len(classified),
        "process_candidates": candidates,
        "writers": writers,
    }


def acquire_leases(snapshots: list[dict[str, Any]]) -> list[Any]:
    if fcntl is None:
        raise PreflightError(
            "integration-owner leases require POSIX fcntl support; this helper currently supports macOS and Linux"
        )
    handles: list[Any] = []
    paths = sorted({Path(item["git_common_dir"]) / "juno-repository-writer.lock" for item in snapshots})
    try:
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            handle = path.open("a+", encoding="utf-8")
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                handle.close()
                raise PreflightError(f"integration lease busy: {path}") from exc
            handles.append(handle)
        return handles
    except Exception:
        for handle in handles:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()
        raise


def release_leases(handles: list[Any]) -> None:
    if fcntl is None:
        return
    for handle in reversed(handles):
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=os.getcwd(), help="Project root used only for receipt context")
    parser.add_argument("--repository", action="append", required=True, type=parse_repository, metavar="NAME=PATH,TARGET_REF")
    parser.add_argument("--quiescence-seconds", type=float, default=2.0)
    parser.add_argument(
        "--checkpoint-controller",
        metavar="PATH",
        help="Mandatory pre-integration controller root: checkpoint and prove clean before leases/preflight",
    )
    parser.add_argument("--process-inventory-json", help="Optional deterministic process inventory fixture")
    parser.add_argument("--output", help="Write JSON receipt to this path; stdout is always concise JSON")
    parser.add_argument("--exec-command", nargs=argparse.REMAINDER, help="Command to execute while leases remain held")
    args = parser.parse_args()
    if not 0 <= args.quiescence_seconds <= 300:
        parser.error("--quiescence-seconds must be between 0 and 300")
    if args.output:
        output_path = Path(args.output).expanduser().resolve()
        for repository in args.repository:
            try:
                output_path.relative_to(repository["path"])
            except ValueError:
                continue
            raise PreflightError(
                f"output receipt must be outside integration-owner checkout {repository['name']}: {output_path}"
            )
    if args.process_inventory_json:
        payload = json.loads(Path(args.process_inventory_json).read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise PreflightError("process inventory fixture must be a JSON list")
        processes = payload
    else:
        processes = system_process_inventory()

    checkpoint_result = None
    if args.checkpoint_controller:
        controller = Path(args.checkpoint_controller).expanduser().resolve()
        checkpoint_script = controller / ".juno_task/scripts/controller_checkpoint.py"
        if not checkpoint_script.is_file():
            raise PreflightError(f"controller checkpoint helper missing: {checkpoint_script}")
        completed = subprocess.run(
            [sys.executable, str(checkpoint_script), "--root", str(controller), "require-clean", "--checkpoint", "--json"],
            cwd=controller, text=True, capture_output=True, stdin=subprocess.DEVNULL,
        )
        if completed.returncode != 0:
            raise PreflightError(f"controller checkpoint failed before integration preflight: {completed.stderr.strip()}")
        try:
            checkpoint_result = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise PreflightError("controller checkpoint returned invalid evidence") from exc

    started = dt.datetime.now(dt.timezone.utc).isoformat()
    leases: list[Any] = []
    try:
        initial = [repository_snapshot(repository) for repository in args.repository]
        leases = acquire_leases(initial)
        observation = observe_repositories(
            args.repository,
            args.quiescence_seconds,
            processes,
            excluded_pids={os.getpid()} if args.process_inventory_json else None,
        )
        boundary_processes = processes if args.process_inventory_json else system_process_inventory()
        boundary_excluded = {os.getpid()} if args.process_inventory_json else process_ancestry(os.getpid())
        boundary_classified, boundary_writers = classify_processes(
            observation["after"], boundary_processes, boundary_excluded
        )
        observation["process_inventory_count_after"] = len(boundary_classified)
        observation["process_candidates_after"] = [
            item
            for item in boundary_classified
            if item["writer"] or item["matched_repositories"] or item["excluded_as_caller_ancestry"]
        ]
        observation["writers_after"] = boundary_writers
        if boundary_writers:
            raise PreflightError(
                f"other_write_capable_processes_after_window: expected=0 actual={len(boundary_writers)}"
            )
        command_result = None
        post_command = None
        exit_code = 0
        if args.exec_command:
            command = args.exec_command[1:] if args.exec_command[:1] == ["--"] else args.exec_command
            if not command:
                raise PreflightError("--exec-command requires a command")
            result = subprocess.run(command, cwd=str(Path(args.root).resolve()))
            exit_code = int(result.returncode)
            command_result = {"argv_sha256": digest(json.dumps(command)), "exit_code": exit_code}
            post_command = [repository_snapshot(repository) for repository in args.repository]
            for snapshot in post_command:
                if snapshot["checked_out_ref"] != snapshot["target_ref"]:
                    raise PreflightError(
                        f"repository[{snapshot['name']}].post_command_ref: expected={snapshot['target_ref']!r} actual={snapshot['checked_out_ref']!r}"
                    )
                if snapshot["head"] != snapshot["target_sha"] or not snapshot["clean"]:
                    raise PreflightError(
                        f"repository[{snapshot['name']}].post_command_state: expected=head_equals_target_and_clean actual=head={snapshot['head']} target={snapshot['target_sha']} clean={snapshot['clean']}"
                    )
        receipt = {
            "schema_version": SCHEMA_VERSION,
            "passed": exit_code == 0,
            "started_at": started,
            "completed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "quiescence_seconds": args.quiescence_seconds,
            "controller_checkpoint": checkpoint_result,
            "repositories": observation,
            "leases_held_through_command": bool(args.exec_command),
            "command": command_result,
            "post_command": post_command,
            "signals_sent": 0,
        }
    finally:
        release_leases(leases)
    encoded = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(encoded, encoding="utf-8")
    print(json.dumps({"schema_version": SCHEMA_VERSION, "passed": receipt["passed"], "output": args.output or "stdout"}))
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PreflightError, json.JSONDecodeError, OSError) as exc:
        print(f"integration_owner_preflight: error: {exc}", file=sys.stderr)
        raise SystemExit(2)
