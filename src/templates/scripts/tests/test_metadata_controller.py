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
        self.assertIn(".juno_task/scripts/", (self.new_controller / ".gitignore").read_text())
        generated_config = json.loads((self.new_controller / ".juno_task/config.json").read_text())
        self.assertEqual(
            generated_config["controllerWorkspace"]["policy"],
            ".juno_task/config/metadata-controller.json",
        )
        self.assertTrue((self.new_controller / ".juno_task/config/metadata-controller.json").is_file())
        boundary = json.loads((self.new_controller / ".juno_task/receipts/controller-boundary.json").read_text())
        self.assertGreater(len(boundary["preserved_metadata"]["entries"]), 2)
        write(self.new_controller / ".juno_task/scripts/generated.py", "print('generated')\n")
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
        descendant = mc.inspect(
            self.new_controller,
            self.policy,
            expected_branch="refs/heads/juno/controller-metadata-v1",
            require_active=False,
        )
        self.assertTrue(descendant["passed"])
        self.assertTrue(descendant["checks"]["root_boundary"])
        self.assertNotEqual(descendant["root_commit"], descendant["head"])
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

    def test_continuing_boundary_rejects_nested_specs_and_arbitrary_state_receipts(self) -> None:
        self.prepare()
        write(self.new_controller / ".juno_task/specs/workflows/run.json", "{}\n")
        write(self.new_controller / ".juno_task/state/arbitrary.json", "{}\n")
        write(self.new_controller / ".juno_task/receipts/nested/arbitrary.json", "{}\n")
        command("git", "add", "-f", ".juno_task/specs/workflows/run.json", ".juno_task/state/arbitrary.json",
                ".juno_task/receipts/nested/arbitrary.json", cwd=self.new_controller)
        staged = mc.inspect(
            self.new_controller,
            self.policy,
            expected_branch="refs/heads/juno/controller-metadata-v1",
            require_active=False,
        )
        self.assertFalse(staged["passed"])
        self.assertFalse(staged["checks"]["staged_boundary"])
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "invalid metadata", cwd=self.new_controller)
        committed = mc.inspect(
            self.new_controller,
            self.policy,
            expected_branch="refs/heads/juno/controller-metadata-v1",
            require_active=False,
        )
        self.assertFalse(committed["passed"])
        self.assertEqual(
            set(committed["forbidden_tracked"]),
            {
                ".juno_task/specs/workflows/run.json",
                ".juno_task/state/arbitrary.json",
                ".juno_task/receipts/nested/arbitrary.json",
            },
        )

    def test_verification_rejects_deletion_of_all_canonical_metadata(self) -> None:
        self.prepare()
        command("git", "rm", "-r", ".juno_task/tasks", ".juno_task/ledger", ".juno_task/specs", cwd=self.new_controller)
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "delete canonical metadata", cwd=self.new_controller)
        evidence = mc.inspect(
            self.new_controller,
            self.policy,
            expected_branch="refs/heads/juno/controller-metadata-v1",
            require_active=False,
        )
        self.assertFalse(evidence["passed"])
        self.assertFalse(evidence["checks"]["canonical_metadata_present"])
        self.assertEqual(
            set(evidence["missing_canonical_prefixes"]),
            {".juno_task/tasks", ".juno_task/ledger", ".juno_task/specs"},
        )

    def test_verification_rejects_required_generated_file_deletion(self) -> None:
        self.prepare()
        command("git", "rm", ".juno_task/config/metadata-controller.json", ".juno_task/state/tasks.json", cwd=self.new_controller)
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "delete generated controls", cwd=self.new_controller)
        evidence = mc.inspect(
            self.new_controller,
            self.policy,
            expected_branch="refs/heads/juno/controller-metadata-v1",
            require_active=False,
        )
        self.assertFalse(evidence["passed"])
        self.assertFalse(evidence["checks"]["required_generated_present"])
        self.assertEqual(
            set(evidence["missing_required_generated"]),
            {".juno_task/config/metadata-controller.json", ".juno_task/state/tasks.json"},
        )

    def test_prepare_receipt_collision_refuses_before_branch_or_worktree_mutation(self) -> None:
        mc.migration_plan(self.migration_args(), self.policy)
        prepare_output = self.temp / "prepare.json"
        prepare_output.write_text("{}\n")
        with self.assertRaisesRegex(mc.BoundaryError, "receipt path must be fresh"):
            mc.prepare(argparse.Namespace(plan=self.plan_path, output=prepare_output), self.policy)
        self.assertFalse(self.new_controller.exists())
        self.assertFalse(mc.ref_exists(self.repo, "refs/heads/juno/controller-metadata-v1"))
        self.assertEqual(command("git", "rev-parse", "refs/heads/juno-mono-002", cwd=self.repo), self.product_head)

    def test_runtime_inside_any_linked_worktree_is_rejected(self) -> None:
        linked = self.temp / "linked-product"
        command("git", "worktree", "add", "--detach", str(linked), self.product_head, cwd=self.repo)
        mutable_runtime = linked / "bin/yy"
        execution_marker = self.temp / "mutable-runtime-executed"
        write(mutable_runtime, f"#!/bin/sh\ntouch '{execution_marker}'\nprintf 'juno-code 2.0.32\\n'\n")
        mutable_runtime.chmod(mutable_runtime.stat().st_mode | stat.S_IXUSR)
        with self.assertRaisesRegex(mc.BoundaryError, "linked worktree|mutable Git worktree"):
            mc.runtime_identity(mutable_runtime, "2.0.32", self.repo)
        self.assertFalse(execution_marker.exists())

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

    def test_runtime_rebind_preflight_and_failure_restore_identity(self) -> None:
        self.prepare()
        runtime_file = self.new_controller / ".juno_task/runtime/identity.json"
        old_identity = runtime_file.read_bytes()
        old_version = command("git", "config", "--worktree", "--get", "juno.controller.runtimeVersion", cwd=self.new_controller)
        old_executable = command("git", "config", "--worktree", "--get", "juno.controller.runtimeExecutable", cwd=self.new_controller)
        newer = self.temp / "installed-transaction/bin/yy"
        write(newer, "#!/bin/sh\nprintf 'juno-code 2.0.33\\n'\n")
        newer.chmod(newer.stat().st_mode | stat.S_IXUSR)

        args = argparse.Namespace(
            root=self.new_controller,
            branch="refs/heads/juno/controller-metadata-v1",
            runtime=newer,
            runtime_version="2.0.33",
            output=self.temp / "rebind-collision.json",
        )
        write(self.new_controller / "dirty.txt", "dirty\n")
        with self.assertRaisesRegex(mc.BoundaryError, "requires a clean"):
            mc.runtime_rebind(args, self.policy)
        (self.new_controller / "dirty.txt").unlink()

        args.output.write_text("{}\n")
        with self.assertRaisesRegex(mc.BoundaryError, "immutable receipt collision"):
            mc.runtime_rebind(args, self.policy)
        self.assertEqual(runtime_file.read_bytes(), old_identity)
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.controller.runtimeVersion", cwd=self.new_controller), old_version)
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.controller.runtimeExecutable", cwd=self.new_controller), old_executable)

        failing_args = argparse.Namespace(**{**vars(args), "output": self.temp / "rebind-write-failure.json"})
        original_atomic = mc.atomic_receipt
        try:
            mc.atomic_receipt = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("receipt write failed"))
            with self.assertRaisesRegex(OSError, "receipt write failed"):
                mc.runtime_rebind(failing_args, self.policy)
        finally:
            mc.atomic_receipt = original_atomic
        self.assertEqual(runtime_file.read_bytes(), old_identity)
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.controller.runtimeVersion", cwd=self.new_controller), old_version)
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.controller.runtimeExecutable", cwd=self.new_controller), old_executable)
        self.assertEqual(command("git", "status", "--porcelain", cwd=self.new_controller), "")


if __name__ == "__main__":
    unittest.main()
