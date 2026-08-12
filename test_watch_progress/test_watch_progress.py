import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "src/templates/scripts/watch_progress.py"


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

    def producer(self, seconds=5):
        child = subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({seconds})"])
        self.children.append(child)
        (self.root / "pid").write_text(f"{child.pid}\n")
        return child

    def command(self, *extra):
        return [
            sys.executable,
            str(SCRIPT),
            "--pid-file", str(self.root / "pid"),
            "--log-file", str(self.root / "log"),
            "--footer-file", str(self.root / "footer"),
            "--poll-interval", "0.05",
            "--snapshot-interval", "10",
            "--footer-grace", "0.4",
            *extra,
        ]

    def invoke(self, *extra, timeout=4):
        return subprocess.run(self.command(*extra), capture_output=True, timeout=timeout)

    def test_template_and_installed_runtime_are_byte_identical(self):
        runtime = Path(__file__).parents[2] / ".juno_task/scripts/watch_progress.py"
        self.assertEqual(SCRIPT.read_bytes(), runtime.read_bytes())

    def test_footer_already_present_even_after_process_exit(self):
        (self.root / "pid").write_text("999999\n")
        footer = b"exit_code=7 completed_utc=2026-08-12T21:09:28Z\n"
        (self.root / "footer").write_bytes(footer)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(b"WATCH_STARTED", result.stdout)
        self.assertIn(b"event=footer_present", result.stdout)
        self.assertTrue(result.stdout.endswith(footer))

    def test_footer_appears_live_and_is_detected_without_long_poll_lag(self):
        self.producer()
        footer = b"exact live footer\n"
        threading.Timer(0.15, lambda: (self.root / "footer").write_bytes(footer)).start()
        started = time.monotonic()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertLess(time.monotonic() - started, 1.2)
        self.assertTrue(result.stdout.endswith(footer))

    def test_quiet_live_process_emits_bounded_snapshots_with_missing_log(self):
        self.producer()
        threading.Timer(0.32, lambda: (self.root / "footer").write_text("done\n")).start()
        result = self.invoke("--snapshot-interval", "0.1", "--tail-lines", "2")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(b"WATCH_SNAPSHOT", result.stdout)
        self.assertIn(b"state=active log_bytes=0", result.stdout)

    def test_process_exit_then_footer_during_grace(self):
        self.producer(0.12)
        threading.Timer(0.28, lambda: (self.root / "footer").write_text("late footer\n")).start()
        result = self.invoke("--footer-grace", "0.8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(b"event=process_exited", result.stdout)
        self.assertTrue(result.stdout.endswith(b"late footer\n"))

    def test_process_exit_without_footer_prints_bounded_final_tail(self):
        self.producer(0.1)
        (self.root / "log").write_text("one\ntwo\nthree\n")
        result = self.invoke("--tail-lines", "2")
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"event=missing_footer", result.stdout)
        self.assertNotIn(b"one\n", result.stdout)
        self.assertIn(b"two\nthree\n", result.stdout)

    def test_invalid_and_stale_reused_pid_are_rejected(self):
        (self.root / "pid").write_text("not-a-pid\n")
        invalid = self.invoke()
        self.assertEqual(invalid.returncode, 2)
        self.assertIn(b"positive numeric PID", invalid.stdout)

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
        self.assertIn(b"log_bytes=0", result.stdout)

    def test_interrupt_stops_only_watcher(self):
        producer = self.producer()
        watcher = subprocess.Popen(self.command(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(0.15)
        watcher.send_signal(signal.SIGINT)
        stdout, _ = watcher.communicate(timeout=2)
        self.assertEqual(watcher.returncode, 130)
        self.assertIn(b"event=interrupted", stdout)
        self.assertIsNone(producer.poll())


if __name__ == "__main__":
    unittest.main()
