#!/usr/bin/env python3
"""Real-Git canaries for the Bolt per-target merge queue."""
from __future__ import annotations

import fcntl
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

SCRIPTS = Path(__file__).resolve().parents[1]
TASK = SCRIPTS / "task_workspace.py"
QUEUE = SCRIPTS / "merge_queue.py"
sys.path.insert(0, str(SCRIPTS))
import merge_queue as merge_runtime  # noqa: E402


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check).stdout.strip()


class MergeQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repository = self.root / "repo"
        self.controller = self.root / "controller"
        self.workspaces = self.root / "features"
        self.counter = self.root / "validation.log"
        self.repository.mkdir()
        git(self.repository, "init", "-b", "product")
        git(self.repository, "config", "user.email", "test@example.com")
        git(self.repository, "config", "user.name", "Test")
        (self.repository / "src").mkdir()
        (self.repository / "src/shared.txt").write_text("base\n")
        git(self.repository, "add", ".")
        git(self.repository, "commit", "-m", "base")
        self.base = git(self.repository, "rev-parse", "HEAD")
        git(self.repository, "branch", "controller")
        run(["git", "-C", str(self.repository), "worktree", "add", str(self.controller), "controller"], self.repository)
        git(self.controller, "rm", "-r", "src")
        for task_id in ("A", "B", "X", "Y", "Z"):
            task = self.controller / ".juno_task/tasks" / task_id.lower() / f"{task_id}.md"
            task.parent.mkdir(parents=True, exist_ok=True)
            task.write_text(f"---\nid: {task_id}\nstatus: todo\n---\n")
        self.write_policy()
        queue = self.controller / ".juno_task/state/queue.json"
        queue.parent.mkdir(parents=True, exist_ok=True)
        queue.write_text('{"schema_version":"juno_merge_queue_state.v1","targets":{}}\n')
        git(self.controller, "add", ".")
        git(self.controller, "commit", "-m", "controller")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_policy(self, code: Optional[str] = None) -> None:
        if code is None:
            code = f"from pathlib import Path; Path({str(self.counter)!r}).open('a').write('run\\n')"
        path = self.controller / ".juno_task/config/task-workspace.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1",
            "repository": ".", "target_ref": "refs/heads/product",
            "workspace_root": str(self.workspaces), "branch_prefix": "refs/heads/task-",
            "allowed_paths": ["src"],
            "controller_private_paths": [".juno_task/tasks", ".juno_task/state", ".juno_task/specs"],
            "focused_validation": [{"id": "affected", "cwd": "src", "argv": [sys.executable, "-c", code],
                                    "timeout_seconds": 10, "max_output_bytes": 4096}],
        }) + "\n")

    def command(self, script: Path, args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
        # Global argparse options precede merge subcommands.
        argv = ["python3", str(script)]
        if script == QUEUE:
            argv += ["--controller", str(self.controller), *args]
        else:
            argv += [*args, "--controller", str(self.controller)]
        return run(argv, self.controller, check)

    def task(self, operation: str, task_id: str) -> dict:
        return json.loads(self.command(TASK, [operation, "--task", task_id]).stdout)

    def queue(self, operation: str, task_id: Optional[str] = None, check: bool = True) -> subprocess.CompletedProcess[str]:
        return self.command(QUEUE, [operation, *([task_id] if task_id else [])], check)

    def queue_payload(self, operation: str, task_id: Optional[str] = None) -> dict:
        return json.loads(self.queue(operation, task_id).stdout)

    def commit_feature(self, task_id: str, path: str, text: str) -> str:
        self.task("start", task_id)
        worktree = self.workspaces / task_id
        target = worktree / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        git(worktree, "add", path)
        git(worktree, "commit", "-m", f"feature {task_id}")
        tip = git(worktree, "rev-parse", "HEAD")
        self.task("finish", task_id)
        return tip

    def test_parallel_x_y_then_moved_target_uses_one_two_parent_composition(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            x = pool.submit(self.commit_feature, "X", "src/x.txt", "x\n")
            y = pool.submit(self.commit_feature, "Y", "src/y.txt", "y\n")
            x_tip, y_tip = x.result(), y.result()
        first = self.queue_payload("next")
        self.assertEqual(first["task_id"], "X")
        self.assertEqual(first["strategy"], "direct")
        self.assertEqual(first["candidate_sha"], x_tip)
        second = self.queue_payload("next")
        self.assertEqual(second["task_id"], "Y")
        self.assertEqual(second["strategy"], "merge_both_parents")
        merged = git(self.repository, "rev-parse", "refs/heads/product")
        self.assertEqual(merged, second["candidate_sha"])
        self.assertEqual(git(self.repository, "show", "-s", "--format=%P", merged).split(), [x_tip, y_tip])
        self.assertEqual(git(self.repository, "show", "refs/heads/product:src/x.txt"), "x")
        self.assertEqual(git(self.repository, "show", "refs/heads/product:src/y.txt"), "y")
        self.assertEqual(len(self.counter.read_text().splitlines()), 4)  # finish + final candidate, once each
        status = self.queue_payload("status")
        self.assertEqual([row["state"] for row in status["tasks"]], ["MERGED", "MERGED"])

    def test_real_a_b_text_conflict_is_preserved_then_resolved_without_feature_recreation(self) -> None:
        a_tip = self.commit_feature("A", "src/shared.txt", "A\n")
        b_tip = self.commit_feature("B", "src/shared.txt", "B\n")
        self.assertEqual(self.queue_payload("next")["candidate_sha"], a_tip)
        conflict = self.queue_payload("next")
        self.assertEqual(conflict["outcome"], "CONFLICT")
        self.assertEqual(conflict["conflict_paths"], ["src/shared.txt"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), a_tip)
        checkout = Path(conflict["candidate_checkout"])
        self.assertTrue(checkout.is_dir())
        before_feature_path = self.workspaces / "B"
        (checkout / "src/shared.txt").write_text("A+B\n")
        git(checkout, "add", "src/shared.txt")
        resolved = self.queue_payload("resolve", "B")
        merged = resolved["candidate_sha"]
        self.assertEqual(git(self.repository, "show", "-s", "--format=%P", merged).split(), [a_tip, b_tip])
        self.assertEqual(git(self.repository, "show", "refs/heads/product:src/shared.txt"), "A+B")
        self.assertTrue(before_feature_path.is_dir())
        self.assertFalse(checkout.exists())
        self.assertEqual(self.queue_payload("status")["conflict_task_ids"], [])

    def test_resolve_rejects_unrelated_drift_and_preserves_conflict_checkout(self) -> None:
        self.commit_feature("A", "src/shared.txt", "A\n")
        self.commit_feature("B", "src/shared.txt", "B\n")
        self.queue_payload("next")
        conflict = self.queue_payload("next")
        checkout = Path(conflict["candidate_checkout"])
        (checkout / "src/unrelated.txt").write_text("drift\n")
        (checkout / "src/shared.txt").write_text("resolved\n")
        git(checkout, "add", "src/shared.txt")
        failed = self.queue("resolve", "B", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("unrelated drift", failed.stderr)
        self.assertTrue(checkout.is_dir())
        self.assertEqual(self.queue_payload("status")["conflict_task_ids"], ["B"])

    def test_nonblocking_target_lock_refuses_duplicate_worker_without_state_or_ref_change(self) -> None:
        self.commit_feature("X", "src/x.txt", "x\n")
        common = Path(git(self.repository, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
        key = hashlib.sha256(f"{common}\0refs/heads/product".encode()).hexdigest()
        lock = self.controller / ".juno_task/runtime/merge-queue" / f"{key}.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        before_state = (self.controller / ".juno_task/state/tasks.json").read_bytes()
        with lock.open("a+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            failed = self.queue("next", check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("another worker owns", failed.stderr)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertEqual((self.controller / ".juno_task/state/tasks.json").read_bytes(), before_state)

    def test_failed_validation_and_target_movement_do_zero_queue_cas(self) -> None:
        tip = self.commit_feature("X", "src/x.txt", "x\n")
        self.write_policy("import sys; sys.exit(9)")
        failed = self.queue("next", check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("affected validation failed", failed.stderr)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertEqual(self.task("status", "X")["state"], "QUEUED")

        # A successful retry uses the same frozen direct candidate.
        self.write_policy()
        self.assertEqual(self.queue_payload("next")["candidate_sha"], tip)

        self.commit_feature("Y", "src/y.txt", "y\n")
        tree = git(self.repository, "rev-parse", "refs/heads/product^{tree}")
        stale = git(self.repository, "commit-tree", tree, "-p", "refs/heads/product", "-m", "external move")
        code = ("import subprocess; subprocess.run([\"git\",\"update-ref\",\"refs/heads/product\","
                f"{stale!r}],check=True)")
        self.write_policy(code)
        moved = self.queue("next", check=False)
        self.assertEqual(moved.returncode, 2)
        self.assertIn("target moved", moved.stderr)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), stale)
        self.assertEqual(self.task("status", "Y")["state"], "QUEUED")

    def test_cleanup_refuses_dirty_reachable_checkout_and_target_readback_is_exact(self) -> None:
        self.commit_feature("X", "src/x.txt", "x\n")
        self.commit_feature("Y", "src/y.txt", "y\n")
        self.queue_payload("next")
        result = self.queue_payload("next")
        self.assertEqual(result["outcome"], "MERGED")
        self.assertEqual(result["cleanup"]["outcome"], "removed")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), result["readback_sha"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product^{tree}"), result["candidate_tree"])

        checkout = self.root / "dirty-reachable"
        run(["git", "-C", str(self.repository), "worktree", "add", "--detach", str(checkout), result["candidate_sha"]], self.repository)
        (checkout / "dirty.txt").write_text("preserve\n")
        cleanup = merge_runtime.cleanup_candidate(self.controller, checkout, "refs/heads/product", result["candidate_sha"])
        self.assertEqual(cleanup["outcome"], "preserved")
        self.assertEqual(cleanup["reason"], "dirty")
        self.assertTrue(checkout.is_dir())

    def test_cleanup_refuses_unreachable_candidate(self) -> None:
        checkout = self.root / "unreachable-candidate"
        run(["git", "-C", str(self.repository), "worktree", "add", "--detach", str(checkout), self.base], self.repository)
        (checkout / "src/unreachable.txt").write_text("candidate\n")
        git(checkout, "add", ".")
        git(checkout, "commit", "-m", "unreachable candidate")
        candidate = git(checkout, "rev-parse", "HEAD")
        result = merge_runtime.cleanup_candidate(self.controller, checkout, "refs/heads/product", candidate)
        self.assertEqual(result["outcome"], "preserved")
        self.assertEqual(result["reason"], "candidate_unreachable_from_target")
        self.assertTrue(checkout.is_dir())

    def test_durable_merging_window_recovers_landed_cas_without_revalidation(self) -> None:
        tip = self.commit_feature("X", "src/x.txt", "x\n")
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        attempt = {
            "schema_version": "juno_merge_queue_attempt.v1", "task_id": "X",
            "target_ref": "refs/heads/product", "expected_target_sha": self.base,
            "feature_sha": tip, "strategy": "direct", "candidate_sha": tip,
            "candidate_tree": git(self.repository, "rev-parse", f"{tip}^{{tree}}"),
            "candidate_checkout": None, "validation": [], "review": None, "outcome": "MERGING",
        }
        state["tasks"]["X"].update({"state": "MERGING", "queue_attempt": attempt,
                                     "last_queue_outcome": "MERGING"})
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        git(self.repository, "update-ref", "refs/heads/product", tip, self.base)
        result = self.queue_payload("next")
        self.assertTrue(result["recovered"])
        self.assertEqual(result["outcome"], "MERGED")
        self.assertEqual(self.task("status", "X")["state"], "MERGED")
        self.assertEqual(len(self.counter.read_text().splitlines()), 1)  # finish only; candidate was already validated


if __name__ == "__main__":
    unittest.main()
