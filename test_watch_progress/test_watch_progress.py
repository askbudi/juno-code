import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "src/templates/scripts/watch_progress.py"
VALID_FOOTER = (
    b"schema_version=juno.watch-footer.v1\n"
    b"exit_code=7\n"
    b"completed_utc=2026-08-12T21:09:28.123Z\n"
)


def load_watcher():
    spec = importlib.util.spec_from_file_location("watch_progress_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class WatchProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
        self.temp.cleanup()

    def atomic_write(self, path, data):
        temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
        temporary.write_bytes(data)
        temporary.replace(path)

    def producer(self, seconds=5):
        child = subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({seconds})"])
        self.children.append(child)
        temporary = self.root / "pid.tmp"
        temporary.write_text(f"{child.pid}\n")
        temporary.replace(self.root / "pid")
        return child

    def command(self, *extra, root=None):
        root = root or self.root
        return [
            sys.executable,
            str(SCRIPT),
            "--pid-file", str(root / "pid"),
            "--log-file", str(root / "log"),
            "--footer-file", str(root / "footer"),
            "--poll-interval", "0.05",
            "--snapshot-interval", "10",
            "--footer-grace", "0.4",
            *extra,
        ]

    def invoke(self, *extra, timeout=4, root=None):
        return subprocess.run(self.command(*extra, root=root), capture_output=True, timeout=timeout)

    def events(self, output):
        result = []
        offset = 0
        while offset < len(output):
            end = output.find(b"\n", offset)
            self.assertNotEqual(end, -1, output[offset:])
            event = json.loads(output[offset:end])
            result.append(event)
            offset = end + 1
            if event["event"] == "payload_begin":
                length = event["byte_length"]
                payload = output[offset:offset + length]
                offset += length
                end = output.find(b"\n", offset)
                self.assertNotEqual(end, -1)
                closing = json.loads(output[offset:end])
                result.append({**closing, "payload": payload})
                offset = end + 1
        return result

    def payload(self, output, name):
        matches = [event for event in self.events(output) if event.get("event") == "payload_end" and event.get("payload_name") == name]
        self.assertEqual(len(matches), 1, self.events(output))
        return matches[0]["payload"]

    def test_template_and_installed_runtime_are_byte_identical(self):
        runtime = Path(__file__).parents[2] / ".juno_task/scripts/watch_progress.py"
        self.assertEqual(SCRIPT.read_bytes(), runtime.read_bytes())

    def test_every_timing_argument_requires_a_finite_positive_value(self):
        flags = ("--poll-interval", "--snapshot-interval", "--footer-grace")
        invalid_values = ("nan", "inf", "-inf", "0")
        (self.root / "pid").write_text("999999\n")
        (self.root / "footer").write_bytes(VALID_FOOTER)

        for flag in flags:
            for value in invalid_values:
                with self.subTest(flag=flag, value=value):
                    result = self.invoke(f"{flag}={value}")
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    errors = [event for event in self.events(result.stdout) if event["event"] == "error"]
                    self.assertEqual(len(errors), 1, self.events(result.stdout))
                    self.assertEqual(
                        errors[0]["message"],
                        f"{flag} must be finite and greater than zero",
                    )

            with self.subTest(flag=flag, value="ordinary positive"):
                result = self.invoke(f"{flag}=0.125")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("footer_valid", [event["event"] for event in self.events(result.stdout)])

    def test_valid_existing_footer_is_terminal_truth_after_process_exit(self):
        (self.root / "pid").write_text("999999\n")
        (self.root / "footer").write_bytes(VALID_FOOTER)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = self.events(result.stdout)
        self.assertIn("footer_valid", [event["event"] for event in events])
        self.assertEqual(self.payload(result.stdout, "footer"), VALID_FOOTER)

    def test_strict_footer_contract_rejects_empty_partial_duplicate_unknown_invalid_and_arbitrary(self):
        invalid = {
            "empty": b"",
            "partial": b"schema_version=juno.watch-footer.v1\nexit_code=0\n",
            "duplicate": VALID_FOOTER.replace(b"exit_code=7\n", b"exit_code=7\nexit_code=0\n"),
            "unknown": VALID_FOOTER + b"message=done\n",
            "version": VALID_FOOTER.replace(b"v1", b"v2"),
            "negative_exit": VALID_FOOTER.replace(b"exit_code=7", b"exit_code=-1"),
            "large_exit": VALID_FOOTER.replace(b"exit_code=7", b"exit_code=256"),
            "float_exit": VALID_FOOTER.replace(b"exit_code=7", b"exit_code=1.0"),
            "invalid_time": VALID_FOOTER.replace(b"2026-08-12T21:09:28.123Z", b"2026-02-30T21:09:28Z"),
            "offset_time": VALID_FOOTER.replace(b"2026-08-12T21:09:28.123Z", b"2026-08-12T21:09:28+01:00"),
            "arbitrary": b"done\n\x00bytes",
        }
        for name, footer in invalid.items():
            with self.subTest(name=name):
                case = self.root / name
                case.mkdir()
                (case / "pid").write_text("999999\n")
                (case / "footer").write_bytes(footer)
                result = self.invoke("--footer-grace", "0.05", root=case)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("malformed_footer", [event["event"] for event in self.events(result.stdout)])
                self.assertEqual(self.payload(result.stdout, "malformed_footer"), footer)

    def test_malformed_live_footer_can_be_atomically_replaced_before_exit(self):
        self.producer()
        (self.root / "footer").write_bytes(b"partial")
        threading.Timer(0.12, lambda: self.atomic_write(self.root / "footer", VALID_FOOTER)).start()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        names = [event["event"] for event in self.events(result.stdout)]
        self.assertIn("footer_malformed_waiting", names)
        self.assertIn("footer_valid", names)

    def test_footer_appears_live_and_is_detected_without_long_poll_lag(self):
        self.producer()
        threading.Timer(0.15, lambda: self.atomic_write(self.root / "footer", VALID_FOOTER)).start()
        started = time.monotonic()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertLess(time.monotonic() - started, 0.7)
        self.assertEqual(self.payload(result.stdout, "footer"), VALID_FOOTER)

    def test_quiet_live_process_emits_bounded_snapshots_with_missing_log(self):
        self.producer()
        threading.Timer(0.32, lambda: self.atomic_write(self.root / "footer", VALID_FOOTER)).start()
        result = self.invoke("--snapshot-interval", "0.1", "--tail-lines", "2")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        snapshots = [event for event in self.events(result.stdout) if event["event"] == "snapshot"]
        self.assertTrue(snapshots)
        self.assertEqual(snapshots[0]["log_bytes"], 0)

    def test_process_exit_then_valid_footer_during_grace(self):
        self.producer(0.12)
        threading.Timer(0.28, lambda: self.atomic_write(self.root / "footer", VALID_FOOTER)).start()
        result = self.invoke("--footer-grace", "0.8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("process_exited", [event["event"] for event in self.events(result.stdout)])

    def test_process_exit_without_footer_prints_bounded_final_tail(self):
        self.producer(0.1)
        (self.root / "log").write_text("one\ntwo\nthree\n")
        result = self.invoke("--tail-lines", "2")
        self.assertEqual(result.returncode, 2)
        self.assertIn("missing_footer", [event["event"] for event in self.events(result.stdout)])
        self.assertEqual(self.payload(result.stdout, "final_tail"), b"two\nthree\n")

    def test_jsonl_metadata_and_length_framing_escape_control_sensitive_values(self):
        odd = self.root / "space = and\nnewline"
        odd.mkdir()
        (odd / "pid").write_text("999999\n")
        (odd / "footer").write_bytes(VALID_FOOTER.replace(b"exit_code=7", b"exit_code=0"))
        result = self.invoke(root=odd)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = self.events(result.stdout)
        self.assertTrue(all(event["schema_version"] == "juno.watch-event.v1" for event in events))
        footer_event = next(event for event in events if event["event"] == "footer_valid")
        self.assertEqual(footer_event["footer_path"], str(odd / "footer"))
        self.assertEqual(self.payload(result.stdout, "footer"), (odd / "footer").read_bytes())

    def test_invalid_and_stale_reused_pid_are_rejected(self):
        (self.root / "pid").write_text("not-a-pid\n")
        invalid = self.invoke()
        self.assertEqual(invalid.returncode, 2)
        self.assertTrue(any("positive numeric PID" in event.get("message", "") for event in self.events(invalid.stdout)))

        child = self.producer()
        os.utime(self.root / "pid", (1, 1))
        stale = self.invoke()
        self.assertEqual(stale.returncode, 2)
        self.assertIn(b"stale/reused PID", stale.stdout)
        self.assertIsNone(child.poll())

    def test_empty_log_is_safe_on_missing_footer(self):
        self.producer(0.1)
        (self.root / "log").write_bytes(b"")
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        missing = next(event for event in self.events(result.stdout) if event["event"] == "missing_footer")
        self.assertEqual(missing["log_bytes"], 0)

    def test_interrupt_stops_only_watcher(self):
        producer = self.producer()
        watcher = subprocess.Popen(self.command(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(0.15)
        watcher.send_signal(signal.SIGINT)
        stdout, _ = watcher.communicate(timeout=2)
        self.assertEqual(watcher.returncode, 130)
        interrupted = next(event for event in self.events(stdout) if event["event"] == "interrupted")
        self.assertEqual(interrupted["producer_action"], "none")
        self.assertIsNone(producer.poll())

    def test_monotonic_deadline_subtracts_slow_identity_work(self):
        watcher = load_watcher()
        clock = SimpleNamespace(value=0.0, sleeps=[])

        def monotonic():
            return clock.value

        def sleep(seconds):
            clock.sleeps.append(seconds)
            clock.value += seconds

        calls = 0

        def identity(_pid):
            nonlocal calls
            calls += 1
            if calls > 1:
                clock.value += 0.08
            if calls == 3:
                (self.root / "footer").write_bytes(VALID_FOOTER)
            return watcher.ProcessIdentity("identity with spaces\nand controls", 0.0, "S")

        (self.root / "pid").write_text("123\n")
        os.utime(self.root / "pid", (1, 1))
        args = SimpleNamespace(
            pid_file=str(self.root / "pid"), log_file=str(self.root / "log"),
            footer_file=str(self.root / "footer"), poll_interval=0.1,
            snapshot_interval=10.0, footer_grace=0.4, tail_lines=2,
        )
        with mock.patch.object(watcher, "process_identity", identity), \
             mock.patch.object(watcher, "pid_exists", return_value=True), \
             mock.patch.object(watcher, "emit"), mock.patch.object(watcher, "print_payload"):
            result = watcher.watch(args, monotonic=monotonic, sleep=sleep)
        self.assertEqual(result, 0)
        self.assertAlmostEqual(clock.sleeps[0], 0.02, places=6)
        self.assertNotIn(0.1, clock.sleeps)

    def test_documented_private_run_directories_are_concurrently_isolated(self):
        command = 'mktemp -d "${TMPDIR:-/tmp}/yy-TASK_ID-run.XXXXXX"'
        first = subprocess.check_output(["sh", "-c", command], text=True).strip()
        second = subprocess.check_output(["sh", "-c", command], text=True).strip()
        try:
            self.assertNotEqual(first, second)
            self.assertEqual(os.stat(first).st_mode & 0o077, 0)
            self.assertEqual(os.stat(second).st_mode & 0o077, 0)
        finally:
            os.rmdir(first)
            os.rmdir(second)


if __name__ == "__main__":
    unittest.main()
