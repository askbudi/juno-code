#!/usr/bin/env python3
"""Watch an existing PID/log/footer producer without owning its lifecycle."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

MAX_TAIL_BYTES = 64 * 1024


class WatchError(Exception):
    pass


class WatchInterrupted(Exception):
    def __init__(self, signum: int):
        self.signum = signum


@dataclass(frozen=True)
class ProcessIdentity:
    token: str
    start_epoch: Optional[float]
    state: str


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def emit(kind: str, detail: str) -> None:
    print(f"{kind} utc={utc_now()} {detail}", flush=True)


def linux_identity(pid: int) -> Optional[ProcessIdentity]:
    stat_path = Path(f"/proc/{pid}/stat")
    try:
        raw = stat_path.read_text()
        close = raw.rfind(")")
        fields = raw[close + 2 :].split()
        state, start_ticks = fields[0], int(fields[19])
        clock_ticks = os.sysconf("SC_CLK_TCK")
        boot_epoch = None
        for line in Path("/proc/stat").read_text().splitlines():
            if line.startswith("btime "):
                boot_epoch = int(line.split()[1])
                break
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        start_epoch = None if boot_epoch is None else boot_epoch + start_ticks / clock_ticks
        return ProcessIdentity(f"linux:{boot_id}:{start_ticks}", start_epoch, state)
    except (FileNotFoundError, ProcessLookupError):
        return None
    except (OSError, ValueError, IndexError):
        return None


def ps_identity(pid: int) -> Optional[ProcessIdentity]:
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-o", "stat=", "-p", str(pid)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    line = result.stdout.strip()
    parts = line.split()
    if len(parts) < 6:
        return None
    start_text, state = " ".join(parts[:5]), parts[5]
    try:
        start_epoch = time.mktime(time.strptime(start_text, "%a %b %d %H:%M:%S %Y"))
    except ValueError:
        start_epoch = None
    return ProcessIdentity(f"ps:{start_text}", start_epoch, state)


def process_identity(pid: int) -> Optional[ProcessIdentity]:
    if sys.platform.startswith("linux"):
        identity = linux_identity(pid)
        if identity is not None:
            return identity
    return ps_identity(pid)


def pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def read_pid(pid_file: Path) -> int:
    try:
        text = pid_file.read_text(encoding="ascii").strip()
    except OSError as exc:
        raise WatchError(f"cannot read --pid-file {pid_file}: {exc}") from exc
    if not text.isdigit() or int(text) <= 0:
        raise WatchError(f"--pid-file {pid_file} must contain one positive numeric PID")
    return int(text)


def recent_output(log_file: Path, line_limit: int) -> tuple[bytes, int]:
    try:
        size = log_file.stat().st_size
        with log_file.open("rb") as handle:
            handle.seek(max(0, size - MAX_TAIL_BYTES))
            data = handle.read(MAX_TAIL_BYTES)
    except FileNotFoundError:
        return b"", 0
    except OSError as exc:
        raise WatchError(f"cannot read --log-file {log_file}: {exc}") from exc
    lines = data.splitlines(keepends=True)
    return b"".join(lines[-line_limit:]), size


def print_output(label: str, data: bytes) -> None:
    emit("WATCH_EVENT", f"event={label} bytes={len(data)}")
    if data:
        sys.stdout.flush()
        sys.stdout.buffer.write(data)
        if not data.endswith(b"\n"):
            sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()


def print_footer(footer_file: Path) -> int:
    try:
        data = footer_file.read_bytes()
    except OSError as exc:
        raise WatchError(f"cannot read --footer-file {footer_file}: {exc}") from exc
    emit("WATCH_EVENT", f"event=footer_present footer={footer_file} bytes={len(data)}")
    if data:
        sys.stdout.flush()
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    return 0


def validate_args(args: argparse.Namespace) -> tuple[Path, Path, Path]:
    paths = tuple(Path(value).expanduser() for value in (args.pid_file, args.log_file, args.footer_file))
    if len({str(path.absolute()) for path in paths}) != 3:
        raise WatchError("--pid-file, --log-file, and --footer-file must be distinct paths")
    for name in ("poll_interval", "snapshot_interval", "footer_grace"):
        if getattr(args, name) <= 0:
            raise WatchError(f"--{name.replace('_', '-')} must be greater than zero")
    if args.tail_lines <= 0:
        raise WatchError("--tail-lines must be greater than zero")
    for label, path in (("--log-file", paths[1]), ("--footer-file", paths[2])):
        if path.exists() and not path.is_file():
            raise WatchError(f"{label} must name a regular file when present: {path}")
    return paths  # type: ignore[return-value]


def watch(args: argparse.Namespace) -> int:
    pid_file, log_file, footer_file = validate_args(args)
    pid = read_pid(pid_file)

    # Footer is producer-owned terminal truth, including when attachment is late.
    if footer_file.is_file():
        emit("WATCH_STARTED", f"pid={pid} state=terminal_footer_already_present")
        return print_footer(footer_file)

    identity = process_identity(pid)
    if identity is None or not pid_exists(pid) or "Z" in identity.state.upper():
        raise WatchError(f"PID {pid} is not a live process and footer is absent: {footer_file}")
    try:
        pid_mtime = pid_file.stat().st_mtime
    except OSError as exc:
        raise WatchError(f"cannot stat --pid-file {pid_file}: {exc}") from exc
    if identity.start_epoch is not None and identity.start_epoch > pid_mtime:
        raise WatchError(
            f"PID {pid} started after the PID file was written; refusing a stale/reused PID attachment"
        )

    started = time.monotonic()
    next_snapshot = started + args.snapshot_interval
    exit_seen: Optional[float] = None
    emit("WATCH_STARTED", f"pid={pid} identity={identity.token} poll_seconds={args.poll_interval:g}")

    while True:
        if footer_file.is_file():
            return print_footer(footer_file)

        current = process_identity(pid)
        live = current is not None and pid_exists(pid) and "Z" not in current.state.upper()
        if live and (
            current.token != identity.token
            or (current.start_epoch is not None and current.start_epoch > pid_mtime)
        ):
            raise WatchError(
                f"PID {pid} identity changed from {identity.token} to {current.token}; refusing PID reuse"
            )
        now = time.monotonic()
        if not live and exit_seen is None:
            exit_seen = now
            emit("WATCH_EVENT", f"event=process_exited pid={pid} footer_grace_seconds={args.footer_grace:g}")
        if exit_seen is not None and now - exit_seen >= args.footer_grace:
            data, size = recent_output(log_file, args.tail_lines)
            emit("WATCH_EVENT", f"event=missing_footer pid={pid} log_bytes={size} tail_lines={args.tail_lines}")
            print_output("final_tail", data)
            return 2
        if exit_seen is None and now >= next_snapshot:
            data, size = recent_output(log_file, args.tail_lines)
            emit(
                "WATCH_SNAPSHOT",
                f"pid={pid} elapsed_seconds={now - started:.1f} state=active log_bytes={size} tail_lines={args.tail_lines}",
            )
            print_output("snapshot_tail", data)
            next_snapshot = now + args.snapshot_interval
        time.sleep(args.poll_interval)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Watch an existing producer's PID, combined log, and terminal footer."
    )
    result.add_argument("--pid-file", required=True)
    result.add_argument("--log-file", required=True)
    result.add_argument("--footer-file", required=True)
    result.add_argument("--poll-interval", type=float, default=1.0)
    result.add_argument("--snapshot-interval", type=float, default=60.0)
    result.add_argument("--tail-lines", type=int, default=40)
    result.add_argument("--footer-grace", type=float, default=3.0)
    return result


def main() -> int:
    def interrupted(signum: int, _frame: object) -> None:
        raise WatchInterrupted(signum)

    signal.signal(signal.SIGTERM, interrupted)
    try:
        return watch(parser().parse_args())
    except WatchError as exc:
        emit("WATCH_EVENT", f"event=error message={str(exc)!r}")
        return 2
    except WatchInterrupted as exc:
        name = signal.Signals(exc.signum).name
        emit("WATCH_EVENT", f"event=interrupted signal={name} producer_action=none")
        return 128 + exc.signum
    except KeyboardInterrupt:
        emit("WATCH_EVENT", "event=interrupted signal=SIGINT producer_action=none")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
