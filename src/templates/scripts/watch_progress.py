#!/usr/bin/env python3
"""Watch an existing PID/log/footer producer without owning its lifecycle."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

MAX_TAIL_BYTES = 64 * 1024
EVENT_SCHEMA = "juno.watch-event.v1"
FOOTER_SCHEMA = "juno.watch-footer.v1"
FOOTER_PATTERN = re.compile(
    rb"\Aschema_version=juno\.watch-footer\.v1\n"
    rb"exit_code=(0|[1-9][0-9]{0,2})\n"
    rb"completed_utc=([0-9]{4}-[0-9]{2}-[0-9]{2}T"
    rb"[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z)\n\Z"
)


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


@dataclass(frozen=True)
class FooterObservation:
    data: Optional[bytes]
    exit_code: Optional[int]
    completed_utc: Optional[str]
    error: Optional[str]

    @property
    def valid(self) -> bool:
        return self.data is not None and self.error is None


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def emit(event: str, **fields: object) -> None:
    record = {"schema_version": EVENT_SCHEMA, "event": event, "utc": utc_now(), **fields}
    print(json.dumps(record, ensure_ascii=True, separators=(",", ":")), flush=True)


def print_payload(name: str, data: bytes) -> None:
    """Frame exact bytes by length; no newline is inserted into the payload."""
    emit("payload_begin", payload_name=name, byte_length=len(data))
    sys.stdout.flush()
    if data:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    emit("payload_end", payload_name=name, byte_length=len(data))


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
    except (OSError, UnicodeError) as exc:
        raise WatchError(f"cannot read --pid-file {pid_file}: {exc}") from exc
    if not text.isdigit() or int(text) <= 0:
        raise WatchError(f"--pid-file {pid_file} must contain one positive numeric PID")
    return int(text)


def observe_footer(footer_file: Path) -> FooterObservation:
    try:
        data = footer_file.read_bytes()
    except FileNotFoundError:
        return FooterObservation(None, None, None, None)
    except OSError as exc:
        raise WatchError(f"cannot read --footer-file {footer_file}: {exc}") from exc
    match = FOOTER_PATTERN.fullmatch(data)
    if match is None:
        return FooterObservation(data, None, None, "footer does not match the exact v1 schema")
    exit_code = int(match.group(1))
    if exit_code > 255:
        return FooterObservation(data, None, None, "exit_code is outside the supported 0..255 range")
    completed_utc = match.group(2).decode("ascii")
    try:
        datetime.fromisoformat(completed_utc[:-1] + "+00:00")
    except ValueError:
        return FooterObservation(data, None, None, "completed_utc is not a valid UTC timestamp")
    return FooterObservation(data, exit_code, completed_utc, None)


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


def print_valid_footer(footer_file: Path, observation: FooterObservation) -> int:
    assert observation.data is not None and observation.exit_code is not None
    emit(
        "footer_valid",
        footer_path=str(footer_file),
        byte_length=len(observation.data),
        footer_schema=FOOTER_SCHEMA,
        producer_exit_code=observation.exit_code,
        completed_utc=observation.completed_utc,
    )
    print_payload("footer", observation.data)
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


def watch(
    args: argparse.Namespace,
    *,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    pid_file, log_file, footer_file = validate_args(args)
    pid = read_pid(pid_file)

    # Footer is checked before liveness. Only a valid footer is terminal truth.
    footer = observe_footer(footer_file)
    if footer.valid:
        emit("watch_started", pid=pid, state="valid_footer_already_present")
        return print_valid_footer(footer_file, footer)

    identity = process_identity(pid)
    live = identity is not None and pid_exists(pid) and "Z" not in identity.state.upper()
    if footer.data is None and not live:
        raise WatchError(f"PID {pid} is not a live process and footer is absent: {footer_file}")
    try:
        pid_mtime = pid_file.stat().st_mtime
    except OSError as exc:
        raise WatchError(f"cannot stat --pid-file {pid_file}: {exc}") from exc
    if live and identity is not None and identity.start_epoch is not None and identity.start_epoch > pid_mtime:
        raise WatchError(f"PID {pid} started after the PID file was written; refusing a stale/reused PID attachment")

    started = monotonic()
    next_poll = started + args.poll_interval
    next_snapshot = started + args.snapshot_interval
    exit_seen: Optional[float] = None if live else started
    malformed_signature: Optional[tuple[int, int]] = None
    emit(
        "watch_started",
        pid=pid,
        state="active" if live else "malformed_footer_after_process_exit",
        identity=None if identity is None else identity.token,
        poll_seconds=args.poll_interval,
    )
    if not live:
        emit("process_exited", pid=pid, footer_grace_seconds=args.footer_grace)

    while True:
        footer = observe_footer(footer_file)
        if footer.valid:
            return print_valid_footer(footer_file, footer)
        if footer.data is not None:
            signature = (len(footer.data), hash(footer.data))
            if signature != malformed_signature:
                emit(
                    "footer_malformed_waiting",
                    footer_path=str(footer_file),
                    byte_length=len(footer.data),
                    reason=footer.error,
                    policy="wait_while_live_then_fail_after_exit_grace",
                )
                malformed_signature = signature

        current = process_identity(pid) if live else None
        currently_live = (
            current is not None and pid_exists(pid) and "Z" not in current.state.upper()
        )
        if currently_live and identity is not None and (
            current.token != identity.token
            or (current.start_epoch is not None and current.start_epoch > pid_mtime)
        ):
            raise WatchError(
                f"PID {pid} identity changed from {identity.token} to {current.token}; refusing PID reuse"
            )
        now = monotonic()
        if live and not currently_live:
            live = False
            exit_seen = now
            emit("process_exited", pid=pid, footer_grace_seconds=args.footer_grace)
        if exit_seen is not None and now - exit_seen >= args.footer_grace:
            data, size = recent_output(log_file, args.tail_lines)
            if footer.data is not None:
                emit(
                    "malformed_footer",
                    pid=pid,
                    footer_path=str(footer_file),
                    byte_length=len(footer.data),
                    reason=footer.error,
                    log_bytes=size,
                    tail_lines=args.tail_lines,
                )
                print_payload("malformed_footer", footer.data)
            else:
                emit("missing_footer", pid=pid, log_bytes=size, tail_lines=args.tail_lines)
            print_payload("final_tail", data)
            return 2
        if exit_seen is None and now >= next_snapshot:
            data, size = recent_output(log_file, args.tail_lines)
            emit(
                "snapshot",
                pid=pid,
                elapsed_seconds=round(now - started, 1),
                state="active",
                log_bytes=size,
                tail_lines=args.tail_lines,
            )
            print_payload("snapshot_tail", data)
            while next_snapshot <= now:
                next_snapshot += args.snapshot_interval

        # Deadline scheduling subtracts identity/snapshot work instead of adding a full interval.
        now = monotonic()
        if now < next_poll:
            sleep(next_poll - now)
        after_sleep = monotonic()
        while next_poll <= after_sleep:
            next_poll += args.poll_interval


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Watch an existing producer's PID, combined log, and strict terminal footer."
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
        emit("error", message=str(exc))
        return 2
    except WatchInterrupted as exc:
        emit(
            "interrupted",
            signal=signal.Signals(exc.signum).name,
            producer_action="none",
        )
        return 128 + exc.signum
    except KeyboardInterrupt:
        emit("interrupted", signal="SIGINT", producer_action="none")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
