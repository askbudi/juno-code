#!/usr/bin/env python3
"""Real-Git acceptance tests for the metadata-only controller boundary."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "metadata_controller.py"
POLICY = Path(__file__).resolve().parents[2] / "config/metadata-controller.json"
SPEC = importlib.util.spec_from_file_location("metadata_controller", SCRIPT)
assert SPEC and SPEC.loader
mc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mc)


def command(*argv: str, cwd: Path) -> str:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)


class MetadataControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="juno-metadata-controller-test-"))
        self.repo = self.temp / "repo"
        self.repo.mkdir()
        command("git", "init", "-b", "juno-mono-002", cwd=self.repo)
        command("git", "config", "user.name", "Test User", cwd=self.repo)
        command("git", "config", "user.email", "test@example.invalid", cwd=self.repo)
        write(self.repo / "README.md", "product\n")
        write(self.repo / "src/product.ts", "export const product = true;\n")
        command("git", "add", ".", cwd=self.repo)
        command("git", "commit", "-m", "product target", cwd=self.repo)
        self.product_head = command("git", "rev-parse", "HEAD", cwd=self.repo)

        command("git", "switch", "-c", "legacy-controller", cwd=self.repo)
        write(self.repo / ".juno_task/tasks/TASK.md", "task\n")
        write(self.repo / ".juno_task/ledger/2026.ndjson", "{}\n")
        write(self.repo / ".juno_task/specs/P1.md", "spec\n")
        write(self.repo / ".juno_task/specs/workflows/run/attempt.json", "{}\n")
        write(self.repo / ".juno_task/tasks.md", "index\n")
        write(self.repo / ".juno_task/cutover.json", "{}\n")
        write(self.repo / "juno-code/package.json", "{}\n")
        command("git", "add", ".", cwd=self.repo)
        command("git", "commit", "-m", "legacy full controller", cwd=self.repo)
        self.old_head = command("git", "rev-parse", "HEAD", cwd=self.repo)

        self.runtime = self.temp / "installed/bin/yy"
        write(self.runtime, "#!/bin/sh\nprintf 'juno-code 2.0.32\\n'\n")
        self.runtime.chmod(self.runtime.stat().st_mode | stat.S_IXUSR)
        self.new_controller = self.temp / "metadata-controller"
        self.policy = mc.load_policy(POLICY)
        self.plan_path = self.temp / "plan.json"

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def migration_args(self, **changes: object) -> argparse.Namespace:
        values: dict[str, object] = {
            "old_controller": self.repo,
            "old_branch": "refs/heads/legacy-controller",
            "expected_old_head": self.old_head,
            "new_controller": self.new_controller,
            "new_branch": "refs/heads/juno/controller-metadata-v1",
            "product_ref": "refs/heads/juno-mono-002",
            "expected_product_head": self.product_head,
            "runtime": self.runtime,
            "runtime_version": "2.0.32",
            "output": self.plan_path,
        }
        values.update(changes)
        return argparse.Namespace(**values)

    def prepare(self) -> dict[str, object]:
        mc.migration_plan(self.migration_args(), self.policy)
        return mc.prepare(
            argparse.Namespace(plan=self.plan_path, output=self.temp / "prepare.json"), self.policy
        )

    def test_prepare_creates_unrelated_metadata_only_controller_and_preserves_product(self) -> None:
        payload = self.prepare()
        self.assertTrue(payload["root_commit"])
        self.assertEqual(command("git", "rev-list", "--count", "HEAD", cwd=self.new_controller), "1")
        self.assertFalse((self.new_controller / "README.md").exists())
        self.assertFalse((self.new_controller / "juno-code").exists())
        self.assertTrue((self.new_controller / ".juno_task/tasks/TASK.md").is_file())
        self.assertFalse((self.new_controller / ".juno_task/specs/workflows").exists())
        self.assertTrue((self.new_controller / ".juno_task/runtime/identity.json").is_file())
        self.assertEqual(command("git", "status", "--porcelain", cwd=self.new_controller), "")
        self.assertEqual(
            command("git", "rev-parse", "refs/heads/juno-mono-002", cwd=self.repo),
            self.product_head,
        )

        product_worktree = self.temp / "feature-x"
        command("git", "worktree", "add", "--detach", str(product_worktree), self.product_head, cwd=self.repo)
        self.assertFalse((product_worktree / ".juno_task").exists())
        product_evidence = mc.product_boundary(
            product_worktree, "refs/heads/juno-mono-002", self.product_head, self.policy
        )
        self.assertTrue(product_evidence["passed"])

        # Controller metadata mutation has no effect on concurrently open product worktrees.
        write(self.new_controller / ".juno_task/tasks/TASK.md", "updated task\n")
        command("git", "add", ".juno_task/tasks/TASK.md", cwd=self.new_controller)
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "update task", cwd=self.new_controller)
        self.assertEqual(command("git", "status", "--porcelain", cwd=product_worktree), "")
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=product_worktree), self.product_head)

    def test_forbidden_product_path_and_wrong_identity_fail_closed(self) -> None:
        self.prepare()
        write(self.new_controller / "juno-code/package.json", "{}\n")
        command("git", "add", "juno-code/package.json", cwd=self.new_controller)
        evidence = mc.inspect(
            self.new_controller,
            self.policy,
            expected_branch="refs/heads/juno/controller-metadata-v1",
            require_active=False,
        )
        self.assertFalse(evidence["passed"])
        self.assertFalse(evidence["checks"]["staged_boundary"])

        with self.assertRaisesRegex(mc.BoundaryError, "reviewed policy"):
            mc.migration_plan(
                self.migration_args(new_branch="refs/heads/unreviewed-controller"), self.policy
            )

    def test_runtime_rebind_is_local_and_rollback_is_plan_only(self) -> None:
        self.prepare()
        before_head = command("git", "rev-parse", "HEAD", cwd=self.new_controller)
        before_tree = command("git", "write-tree", cwd=self.new_controller)
        newer = self.temp / "installed-2033/bin/yy"
        write(newer, "#!/bin/sh\nprintf 'juno-code 2.0.33\\n'\n")
        newer.chmod(newer.stat().st_mode | stat.S_IXUSR)
        receipt = mc.runtime_rebind(
            argparse.Namespace(
                root=self.new_controller,
                branch="refs/heads/juno/controller-metadata-v1",
                runtime=newer,
                runtime_version="2.0.33",
                output=self.temp / "runtime-rebind.json",
            ),
            self.policy,
        )
        self.assertFalse(receipt["tracked_changes"])
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=self.new_controller), before_head)
        self.assertEqual(command("git", "write-tree", cwd=self.new_controller), before_tree)

        cutover = mc.transition_plan(
            argparse.Namespace(plan=self.plan_path, output=self.temp / "cutover.json"),
            self.policy,
            False,
        )
        self.assertFalse(cutover["registration_change_authorized"])
        command("git", "config", "--worktree", "juno.workspace.role", "controller", cwd=self.new_controller)
        rollback = mc.transition_plan(
            argparse.Namespace(plan=self.plan_path, output=self.temp / "rollback.json"),
            self.policy,
            True,
        )
        self.assertEqual(rollback["outcome"], "planned_no_mutation")
        self.assertFalse(rollback["product_ref_mutation"])
        self.assertEqual(command("git", "rev-parse", "refs/heads/juno-mono-002", cwd=self.repo), self.product_head)


if __name__ == "__main__":
    unittest.main()
