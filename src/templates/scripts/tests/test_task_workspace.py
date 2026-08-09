#!/usr/bin/env python3
"""Real-Git contract tests for the small Bolt task-worktree interface."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "task_workspace.py"


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


def git(root: Path, *args: str) -> str:
    return run(["git", "-C", str(root), *args], root).stdout.strip()


class TaskWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repository = self.root / "repo"
        self.controller = self.root / "controller"
        self.workspaces = self.root / "workspaces"
        self.repository.mkdir()
        git(self.repository, "init", "-b", "product")
        git(self.repository, "config", "user.email", "test@example.com")
        git(self.repository, "config", "user.name", "Test")
        (self.repository / "src").mkdir()
        (self.repository / "src/base.txt").write_text("base\n")
        git(self.repository, "add", "src/base.txt")
        git(self.repository, "commit", "-m", "product base")
        self.base = git(self.repository, "rev-parse", "HEAD")
        git(self.repository, "branch", "controller")
        run(["git", "-C", str(self.repository), "worktree", "add", str(self.controller), "controller"], self.repository)
        # The controller branch is metadata-only and unrelated product paths are removed.
        git(self.controller, "rm", "-r", "src")
        self.write_policy()
        for task_id in ("X", "Y", "Z"):
            task = self.controller / ".juno_task/tasks" / task_id[:2].lower() / f"{task_id}.md"
            task.parent.mkdir(parents=True, exist_ok=True)
            task.write_text(f"---\nid: {task_id}\nstatus: todo\n---\n")
        git(self.controller, "add", ".")
        git(self.controller, "commit", "-m", "metadata controller")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_policy(self, *, validation_ok: bool = True) -> None:
        config = self.controller / ".juno_task/config/task-workspace.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        code = "import sys; sys.exit(0)" if validation_ok else "import sys; sys.exit(7)"
        config.write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1",
            "repository": ".",
            "target_ref": "refs/heads/product",
            "workspace_root": str(self.workspaces),
            "branch_prefix": "refs/heads/task-",
            "allowed_paths": ["src"],
            "controller_private_paths": [".juno_task/tasks", ".juno_task/state", ".juno_task/specs", ".juno_task/ledger"],
            "focused_validation": [{"id": "focused", "cwd": "src", "argv": ["python3", "-c", code]}],
        }, indent=2) + "\n")

    def command(self, operation: str, task_id: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return run(["python3", str(SCRIPT), operation, "--task", task_id, "--controller", str(self.controller)], self.controller, check)

    def payload(self, operation: str, task_id: str) -> dict:
        return json.loads(self.command(operation, task_id).stdout)

    def commit_task(self, task_id: str, relative: str = "src/feature.txt") -> str:
        worktree = self.workspaces / task_id
        target = worktree / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"{task_id}\n")
        git(worktree, "add", relative)
        git(worktree, "commit", "-m", f"feature {task_id}")
        return git(worktree, "rev-parse", "HEAD")

    def advance_target(self) -> str:
        (self.repository / "src/target.txt").write_text("advanced\n")
        git(self.repository, "add", "src/target.txt")
        git(self.repository, "commit", "-m", "advance target")
        return git(self.repository, "rev-parse", "HEAD")

    def test_concurrent_tasks_share_frozen_base_without_controller_data(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.payload, "start", task_id) for task_id in ("X", "Y")]
            x, y = [future.result() for future in futures]
        self.assertEqual(x["base_sha"], self.base)
        self.assertEqual(y["base_sha"], self.base)
        self.assertNotEqual(x["branch_ref"], y["branch_ref"])
        self.assertNotEqual(x["worktree"], y["worktree"])
        for task_id in ("X", "Y"):
            self.assertFalse((self.workspaces / task_id / ".juno_task").exists())

    def test_start_is_idempotent_only_for_unchanged_clean_identity(self) -> None:
        self.assertEqual(self.payload("start", "X")["outcome"], "started")
        self.assertEqual(self.payload("start", "X")["outcome"], "already_started")
        (self.workspaces / "X/src/dirty.txt").write_text("dirty\n")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("identity drifted", failed.stderr)
        self.assertTrue((self.workspaces / "X").is_dir())

    def test_unrecorded_branch_and_path_collisions_refuse(self) -> None:
        git(self.repository, "branch", "task-X", self.base)
        branch = self.command("start", "X", False)
        self.assertEqual(branch.returncode, 2)
        self.assertIn("branch already exists", branch.stderr)
        git(self.repository, "branch", "-D", "task-X")
        (self.workspaces / "X").mkdir(parents=True)
        path = self.command("start", "X", False)
        self.assertEqual(path.returncode, 2)
        self.assertIn("path already exists", path.stderr)

    def test_moved_target_is_reported_and_does_not_rebase_task(self) -> None:
        self.payload("start", "X")
        advanced = self.advance_target()
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        status = self.payload("status", "X")
        self.assertTrue(status["target_moved"])
        self.assertEqual(status["current_target_sha"], advanced)
        self.assertEqual(git(self.workspaces / "X", "rev-parse", "HEAD"), self.base)

    def test_finish_refuses_dirty_and_preserves_worktree(self) -> None:
        self.payload("start", "X")
        self.commit_task("X")
        (self.workspaces / "X/src/untracked.txt").write_text("dirty\n")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("dirty", failed.stderr)
        self.assertTrue((self.workspaces / "X/src/untracked.txt").exists())
        self.assertEqual(self.payload("status", "X")["state"], "WORKING")

    def test_finish_refuses_disallowed_path_and_preserves_commit(self) -> None:
        self.payload("start", "X")
        tip = self.commit_task("X", "outside.txt")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("disallowed paths: outside.txt", failed.stderr)
        self.assertEqual(git(self.workspaces / "X", "rev-parse", "HEAD"), tip)
        self.assertTrue((self.workspaces / "X").is_dir())

    def test_finish_refuses_failed_focused_validation_without_state_advance(self) -> None:
        self.payload("start", "X")
        self.commit_task("X")
        self.write_policy(validation_ok=False)
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("focused validation failed", failed.stderr)
        self.assertEqual(self.payload("status", "X")["state"], "WORKING")
        self.assertTrue((self.workspaces / "X").is_dir())

    def test_finish_queues_clean_committed_tip_without_merging_or_cleanup(self) -> None:
        self.payload("start", "X")
        tip = self.commit_task("X")
        queued = self.payload("finish", "X")
        self.assertEqual(queued["state"], "QUEUED")
        self.assertEqual(queued["tip_sha"], tip)
        self.assertEqual(queued["changed_paths"], ["src/feature.txt"])
        self.assertEqual(queued["validation"][0]["exit_code"], 0)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertTrue((self.workspaces / "X").is_dir())
        self.assertEqual(self.payload("finish", "X")["outcome"], "already_queued")

    def test_product_tree_with_controller_private_data_refuses_before_creation(self) -> None:
        private = self.repository / ".juno_task/tasks/xx/X.md"
        private.parent.mkdir(parents=True)
        private.write_text("controller data\n")
        git(self.repository, "add", ".juno_task/tasks/xx/X.md")
        git(self.repository, "commit", "-m", "bad product metadata")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("controller-private data", failed.stderr)
        self.assertFalse((self.workspaces / "X").exists())


if __name__ == "__main__":
    unittest.main()
