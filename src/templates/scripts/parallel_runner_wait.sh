#!/usr/bin/env python3
"""Wait for a parallel_runner.sh run to complete.

The helper reads parallel_runner_status.json as the single source of truth for
completion and exit status. By default it is silent. Use --verbose (or
JUNO_PARALLEL_WAIT_VERBOSE=true) to stream parallel_runner.log while waiting.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
LOG_ROOT = SCRIPT_DIR / "logs"
STATUS_NAME = "parallel_runner_status.json"
LOG_NAME = "parallel_runner.log"


def _env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "verbose"}


def _positive_float(value, name):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError(f"{name} must be a number, got: {value}")
    if parsed < 0:
        raise argparse.ArgumentTypeError(f"{name} must be non-negative, got: {value}")
    return parsed


def parse_args():
    env_verbose = _env_bool("JUNO_PARALLEL_WAIT_VERBOSE", False)
    env_run_dir = os.environ.get("JUNO_PARALLEL_RUN_DIR")
    env_name = os.environ.get("JUNO_PARALLEL_RUN_NAME")
    env_timeout = os.environ.get("JUNO_PARALLEL_WAIT_TIMEOUT", "0")
    env_poll = os.environ.get("JUNO_PARALLEL_WAIT_POLL_INTERVAL", "2")

    parser = argparse.ArgumentParser(
        description="Wait until parallel_runner.sh completes, optionally streaming its combined log.",
    )
    parser.add_argument("--run-dir", default=env_run_dir, help="Explicit run artifact directory")
    parser.add_argument("--name", default=env_name, help="Select latest run with matching status session_name")
    parser.add_argument("--latest", action="store_true", help="Select latest run (default)")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--verbose", action="store_true", default=env_verbose, help="Stream parallel_runner.log while waiting")
    output.add_argument("--silent", action="store_true", help="Do not stream logs (default)")
    parser.add_argument("--timeout", type=lambda v: _positive_float(v, "--timeout"), default=_positive_float(env_timeout, "JUNO_PARALLEL_WAIT_TIMEOUT"), help="Timeout in seconds; 0 means no timeout")
    parser.add_argument("--poll-interval", type=lambda v: _positive_float(v, "--poll-interval"), default=_positive_float(env_poll, "JUNO_PARALLEL_WAIT_POLL_INTERVAL"), help="Polling interval in seconds")
    args = parser.parse_args()
    if args.silent:
        args.verbose = False
    if args.poll_interval == 0:
        args.poll_interval = 0.1
    return args


def _load_status(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        return None
    except OSError as exc:
        print(f"parallel_runner_wait: cannot read {path}: {exc}", file=sys.stderr)
        return None


def _candidate_status_files():
    if not LOG_ROOT.exists():
        return []
    return list(LOG_ROOT.glob(f"*/*/{STATUS_NAME}"))


def _select_run_dir(args, quiet=False):
    if args.run_dir:
        run_dir = Path(args.run_dir).expanduser()
        if not run_dir.is_absolute():
            run_dir = Path.cwd() / run_dir
        if not run_dir.exists():
            if quiet:
                return None
            print(f"parallel_runner_wait: --run-dir does not exist: {run_dir}", file=sys.stderr)
            sys.exit(2)
        return run_dir

    candidates = []
    for status_path in _candidate_status_files():
        status = _load_status(status_path) or {}
        if args.name and status.get("session_name") != args.name:
            continue
        try:
            sort_key = status_path.stat().st_mtime
        except OSError:
            sort_key = 0
        candidates.append((sort_key, status_path.parent))

    if not candidates:
        if quiet:
            return None
        qualifier = f" for name {args.name!r}" if args.name else ""
        print(
            f"parallel_runner_wait: no parallel_runner status files found{qualifier} under {LOG_ROOT}. "
            "Start parallel_runner.sh first, or pass --run-dir.",
            file=sys.stderr,
        )
        sys.exit(2)

    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _stream_new_log_bytes(log_path, offset):
    if not log_path.exists():
        return offset
    try:
        size = log_path.stat().st_size
        if size < offset:
            offset = 0
        with log_path.open("rb") as handle:
            handle.seek(offset)
            chunk = handle.read()
            offset = handle.tell()
    except OSError as exc:
        print(f"parallel_runner_wait: cannot stream {log_path}: {exc}", file=sys.stderr)
        return offset
    if chunk:
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
    return offset


def main():
    args = parse_args()
    start = time.monotonic()
    # In the common two-command workflow (`nohup parallel_runner.sh ... &` then
    # immediately `parallel_runner_wait.sh`), the runner may need a moment to
    # create its new status file. Give default latest-run discovery one short
    # grace interval so an older completed run is less likely to be selected.
    if not args.run_dir and not args.name and args.timeout:
        time.sleep(min(args.poll_interval, 1.0))
    run_dir = _select_run_dir(args, quiet=bool(args.timeout))
    if run_dir is None and not args.timeout:
        _select_run_dir(args, quiet=False)
    status_path = run_dir / STATUS_NAME if run_dir else None
    log_path = run_dir / LOG_NAME if run_dir else None
    offset = 0

    while True:
        if run_dir is None:
            run_dir = _select_run_dir(args, quiet=True)
            if run_dir is not None:
                status_path = run_dir / STATUS_NAME
                log_path = run_dir / LOG_NAME

        if args.verbose and log_path is not None:
            offset = _stream_new_log_bytes(log_path, offset)

        status = _load_status(status_path) if status_path is not None else None
        if status and status.get("state") == "completed":
            if args.verbose and log_path is not None:
                offset = _stream_new_log_bytes(log_path, offset)
            exit_code = status.get("exit_code")
            if isinstance(exit_code, int):
                sys.exit(exit_code)
            print(
                f"parallel_runner_wait: completed status missing integer exit_code in {status_path}",
                file=sys.stderr,
            )
            sys.exit(1)

        if args.timeout and time.monotonic() - start >= args.timeout:
            print(
                f"parallel_runner_wait: timed out after {args.timeout:g}s waiting for {status_path or LOG_ROOT}",
                file=sys.stderr,
            )
            sys.exit(124)

        time.sleep(args.poll_interval)


if __name__ == "__main__":
    main()
