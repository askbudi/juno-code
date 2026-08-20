#!/usr/bin/env python3
"""Transient-blocker await helper: observe, stop on drift, never mutate."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import await_blocker as await_runtime  # noqa: E402


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def git_repo(path: Path) -> None:
    subprocess.run(["git", "init", "-q", "-b", "controller"], cwd=path, check=True)
    subprocess.run(["git", "-C", str(path), "commit", "--allow-empty", "-m", "base"],
                   check=True, capture_output=True)


class AwaitBlockerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="juno-await-")).resolve()
        self.controller = self.root / "controller"
        self.controller.mkdir()
        git_repo(self.controller)

    def test_controller_clean_waits_then_clears_without_mutation(self) -> None:
        tracked = self.controller / "note.txt"
        tracked.write_text("dirty\n")
        subprocess.run(["git", "-C", str(self.controller), "add", "note.txt"], check=True)
        subprocess.run(["git", "-C", str(self.controller), "commit", "-m", "base note"],
                       check=True)
        tracked.write_text("dirty again\n")
        clock = FakeClock()
        schedule = {"ticks": 0}

        def fake_probe(controller, baseline):
            schedule["ticks"] += 1
            if schedule["ticks"] < 3:
                return await_runtime._controller_clean(controller, baseline)
            tracked.write_text("dirty\n")  # owner reconciles the file
            return await_runtime._controller_clean(controller, baseline)

        with mock.patch.dict(await_runtime.PROBES, {"controller-clean": fake_probe}):
            result = await_runtime.await_condition(
                "controller-clean", self.controller, {}, timeout=60,
                sleep=clock.sleep, monotonic=clock.monotonic)
        self.assertEqual(result["outcome"], "cleared")
        self.assertEqual(schedule["ticks"], 3)

    def test_new_dirty_paths_stop_the_wait_with_drift(self) -> None:
        baseline = {"dirty_paths": ["state.json"]}
        controller = self.controller
        with mock.patch.object(await_runtime, "controller_dirty_paths",
                               return_value=["state.json", "ledger/x.ndjson"]):
            cleared, message = await_runtime._controller_clean(controller, baseline)
        self.assertFalse(cleared)
        self.assertIn("drifted", message)
        self.assertIn("ledger/x.ndjson", message)

    def test_lock_release_detects_identity_change_and_clears(self) -> None:
        lock = self.root / "shared.lock"
        lock.write_text("owner")
        baseline = await_runtime.fingerprint("lock-release", self.controller,
                                             {"path": str(lock)})
        cleared, _ = await_runtime._lock_released(self.controller, baseline)
        self.assertFalse(cleared)
        lock.unlink()
        cleared, message = await_runtime._lock_released(self.controller, baseline)
        self.assertTrue(cleared)
        self.assertIn("absent", message)
        # A replaced lock file (new inode) must stop rather than wait on it.
        lock.write_text("replacement")
        baseline2 = await_runtime.fingerprint("lock-release", self.controller,
                                              {"path": str(lock)})
        lock.unlink(); lock.write_text("different inode")
        cleared, message = await_runtime._lock_released(self.controller, baseline2)
        self.assertFalse(cleared)
        self.assertIn("changed identity", message)

    def test_process_exit_and_path_conditions(self) -> None:
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            baseline = {"pid": child.pid}
            cleared, _ = await_runtime._process_exited(self.controller, baseline)
            self.assertFalse(cleared)
        finally:
            child.kill(); child.wait()
        cleared, message = await_runtime._process_exited(self.controller, {"pid": child.pid})
        self.assertTrue(cleared)
        self.assertIn("exited", message)

        marker = self.root / "marker.json"
        baseline = {"path": str(marker)}
        cleared, _ = await_runtime._path_condition("path-exists")(self.controller, baseline)
        self.assertFalse(cleared)
        marker.write_text("{}")
        cleared, _ = await_runtime._path_condition("path-exists")(self.controller, baseline)
        self.assertTrue(cleared)
        cleared, _ = await_runtime._path_condition("path-gone")(self.controller, baseline)
        self.assertFalse(cleared)

    def test_task_state_waits_for_allowed_state(self) -> None:
        state_file = self.controller / ".juno_task/state/tasks.json"
        state_file.parent.mkdir(parents=True)
        state_file.write_text(json.dumps({"tasks": {"X": {"state": "AWAITING_RISK"}}}))
        baseline = {"task": "X", "expected_state": ["MERGED", "RISK_EVIDENCE_READY"]}
        cleared, message = await_runtime._task_state(self.controller, baseline)
        self.assertFalse(cleared)
        self.assertIn("AWAITING_RISK", message)
        state_file.write_text(json.dumps({"tasks": {"X": {"state": "MERGED"}}}))
        cleared, _ = await_runtime._task_state(self.controller, baseline)
        self.assertTrue(cleared)

    def test_timeout_is_bounded_and_reported(self) -> None:
        clock = FakeClock()
        with mock.patch.object(await_runtime, "controller_dirty_paths",
                               return_value=["state.json"]):
            baseline = await_runtime.fingerprint(
                "controller-clean", self.controller, {})
            with mock.patch.object(await_runtime, "_controller_clean",
                                   return_value=(False, "controller dirty: state.json")):
                result = await_runtime.await_condition(
                    "controller-clean", self.controller, {}, timeout=10,
                    sleep=clock.sleep, monotonic=clock.monotonic)
        self.assertEqual(result["outcome"], "timeout")
        self.assertGreaterEqual(result["waited_seconds"], 10)

    def test_cli_then_executes_after_clear(self) -> None:
        marker = self.root / "then-ran"
        argv = ["controller-clean", "--controller", str(self.controller),
                "--timeout", "30", "--then",
                sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"]
        with mock.patch.object(await_runtime, "controller_dirty_paths",
                               return_value=[]):
            exit_code = await_runtime.main(argv)
        self.assertEqual(exit_code, 0)
        self.assertTrue(marker.is_file())


if __name__ == "__main__":
    unittest.main()
