#!/usr/bin/env python3
from __future__ import annotations

import json
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "controller_registration.py"
RESOLVER = Path(__file__).resolve().parents[1] / "controller_resolver.py"


def command(*args: str, cwd: Path, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(list(args), cwd=cwd, text=True, capture_output=True,
                            env={**os.environ, **(env or {})}, timeout=15)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


class ProtectedRegistrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = Path(tempfile.mkdtemp(prefix="juno-registration-test-"))
        self.product = self.temporary / "product"
        self.source = self.temporary / "old-controller"
        self.target = self.temporary / "metadata-controller"
        self.receipts = self.temporary / "receipts"
        self.receipts.mkdir()
        command("git", "init", "-b", "main", str(self.product), cwd=self.temporary)
        command("git", "config", "user.name", "Test", cwd=self.product)
        command("git", "config", "user.email", "test@example.invalid", cwd=self.product)
        (self.product / "app.txt").write_text("product\n")
        command("git", "add", "app.txt", cwd=self.product); command("git", "commit", "-m", "product", cwd=self.product)
        self.product_head = command("git", "rev-parse", "HEAD", cwd=self.product).stdout.strip()
        command("git", "branch", "old-controller", cwd=self.product)
        command("git", "worktree", "add", str(self.source), "old-controller", cwd=self.product)
        (self.source / ".juno_task").mkdir(); (self.source / ".juno_task" / "old.txt").write_text("old\n")
        command("git", "add", ".juno_task/old.txt", cwd=self.source); command("git", "commit", "-m", "old controller", cwd=self.source)
        self.source_head = command("git", "rev-parse", "HEAD", cwd=self.source).stdout.strip()
        command("git", "worktree", "add", "-b", "controller-new", str(self.target), "main", cwd=self.product)
        (self.target / ".juno_task").mkdir(); (self.target / ".juno_task" / "metadata.txt").write_text("metadata\n")
        self.target_config = self.target / ".juno_task/config.json"
        self.target_config.write_text(json.dumps({
            "gitCheckpoint": {"include": [".juno_task/tasks"]},
            "promptMacros": {"global": {"owner": "preserved"}},
            "controllerWorkspace": {"mode": "metadata-only", "policy": ".juno_task/config/metadata-controller.json"},
        }, indent=2) + "\n")
        command("git", "add", ".juno_task/metadata.txt", ".juno_task/config.json", cwd=self.target)
        command("git", "commit", "-m", "metadata controller", cwd=self.target)
        self.target_head = command("git", "rev-parse", "HEAD", cwd=self.target).stdout.strip()
        command("git", "config", "extensions.worktreeConfig", "true", cwd=self.product)
        command("git", "config", "--worktree", "juno.workspace.role", "controller", cwd=self.source)
        command("git", "config", "--worktree", "juno.workspace.role", "controller-pending", cwd=self.target)
        command("git", "config", "--local", "juno.controller.path", str(self.source), cwd=self.product)
        command("git", "config", "--local", "juno.controller.branch", "old-controller", cwd=self.product)
        self.runtime = self.temporary / "yy"; self.runtime.write_text("#!/bin/sh\necho 2.1.1\n"); self.runtime.chmod(0o755)
        runtime_sha = hashlib.sha256(self.runtime.read_bytes()).hexdigest()
        self.inventory = self.receipts / "inventory.json"
        self.inventory.write_text(json.dumps({"schema_version": "juno_migration_inventory.v1",
            "git": {"root": str(self.product), "selected_product_ref": "refs/heads/main",
                    "selected_product_head": self.product_head},
            "runtime": {"selected": str(self.runtime), "sha256": runtime_sha}}))
        inventory_sha = hashlib.sha256(self.inventory.read_bytes()).hexdigest()
        self.policy = self.receipts / "policy.json"
        self.policy.write_text(json.dumps({
            "schema_version": "juno_migration_policy_bundle.v1", "operation": "generate-policy",
            "outcome": "generated_from_reviewed_answers", "migration_authorized": False,
            "inventory_sha256": inventory_sha,
            "selected_paths": {"controller": str(self.target), "integration": str(self.product)},
            "policies": {"metadata_controller": {"controller_branch": "refs/heads/controller-new", "product_ref": "refs/heads/main"}},
        }))
        self.pending = self.receipts / "pending-verify.json"
        checks = {name: True for name in ("branch_exact", "single_root_ancestry", "root_boundary", "root_preservation",
            "canonical_metadata_present", "required_generated_present", "generated_contract",
            "gitignore_materialized", "root_agent_ignores", "agent_surface_untracked", "tracked_boundary",
            "product_absent", "regular_files_only", "staged_boundary", "runtime_bound", "runtime_untracked", "role", "clean")}
        self.pending.write_text(json.dumps({
            "schema_version": "juno_metadata_controller_receipt.v1", "operation": "verify", "passed": True,
            "root": str(self.target), "branch_ref": "refs/heads/controller-new", "head": self.target_head,
            "checks": checks,
        }))
        self.plan = self.receipts / "plan.json"

    def tearDown(self) -> None:
        shutil.rmtree(self.temporary, ignore_errors=True)

    def invoke(self, *args: str, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return command("python3", str(SCRIPT), *args, cwd=self.product, check=check, env=env)

    def make_plan(self) -> None:
        self.invoke("plan", "--source-controller", str(self.source), "--source-ref", "refs/heads/old-controller",
                    "--expected-source-head", self.source_head, "--target-controller", str(self.target),
                    "--target-ref", "refs/heads/controller-new", "--expected-target-head", self.target_head,
                    "--product-root", str(self.product), "--product-ref", "refs/heads/main",
                    "--expected-product-head", self.product_head, "--runtime", str(self.runtime),
                    "--runtime-version", "2.1.1", "--inventory", str(self.inventory), "--policy-bundle", str(self.policy),
                    "--pending-verification", str(self.pending), "--output", str(self.plan))

    def test_plan_apply_reapply_verify_and_rollback_are_exact_and_idempotent(self) -> None:
        self.make_plan()
        before_product = command("git", "rev-parse", "refs/heads/main", cwd=self.product).stdout
        apply = self.receipts / "apply.json"
        self.invoke("apply", "--plan", str(self.plan), "--output", str(apply), "--authorize-apply")
        first = apply.read_bytes()
        self.invoke("apply", "--plan", str(self.plan), "--output", str(apply), "--authorize-apply")
        self.assertEqual(apply.read_bytes(), first)
        self.assertTrue((self.receipts / "apply.json.intent.json").is_file())
        self.assertTrue(json.loads(apply.read_text())["evidence"]["passed"])
        evidence = json.loads(apply.read_text())["evidence"]
        self.assertTrue(evidence["strict_product_kanban_refusal"]["passed"])
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.workspace.role", cwd=self.product).stdout.strip(), "integration-owner")
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.workspace.roleAuthority", cwd=self.product).stdout.strip(), "protected-integration.v1")
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.workspace.roleBase", cwd=self.product).stdout.strip(), self.product_head)
        strict = command("python3", str(RESOLVER), "--cwd", str(self.product), "--operation", "kanban",
                         cwd=self.product, check=False, env={**os.environ, "JUNO_WORKSPACE_ENFORCEMENT": "strict"})
        self.assertNotEqual(strict.returncode, 0); self.assertIn("refuses kanban writes", strict.stderr)
        retired = command("python3", str(RESOLVER), "--cwd", str(self.source), "--operation", "kanban", cwd=self.source, check=False)
        self.assertNotEqual(retired.returncode, 0); self.assertIn("read-only", retired.stderr)
        rollback = self.receipts / "rollback.json"
        self.invoke("rollback", "--plan", str(self.plan), "--output", str(rollback), "--authorize-rollback")
        self.assertEqual(command("git", "config", "--local", "--get", "juno.controller.path", cwd=self.product).stdout.strip(), str(self.source))
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.workspace.role", cwd=self.target).stdout.strip(), "controller-pending")
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.workspace.role", cwd=self.source).stdout.strip(), "controller")
        for key in ("juno.workspace.role", "juno.workspace.roleAuthority", "juno.workspace.roleBase"):
            self.assertNotEqual(command("git", "config", "--worktree", "--get", key, cwd=self.product, check=False).returncode, 0)
        self.assertEqual(command("git", "rev-parse", "refs/heads/main", cwd=self.product).stdout, before_product)

    def test_plan_admits_canonical_workspace_with_realistic_extra_config_fields(self) -> None:
        before = json.loads(self.target_config.read_text())
        self.make_plan()
        self.assertTrue(self.plan.is_file())
        self.assertEqual(json.loads(self.target_config.read_text()), before)

    def test_plan_refuses_retired_lifecycle_and_unknown_workspace_shapes(self) -> None:
        shapes = (
            {"enabled": True, "policy": ".juno_task/config/controller-workspace.json"},
            {"mode": "metadata-only", "policy": "foreign.json"},
        )
        for index, workspace in enumerate(shapes):
            value = {"promptMacros": {"global": {"owner": "preserved"}},
                     "controllerWorkspace": workspace}
            if index == 0: value["lifecycle"] = {"enabled": True}
            self.target_config.write_text(json.dumps(value) + "\n")
            command("git", "add", ".juno_task/config.json", cwd=self.target)
            command("git", "commit", "-m", f"invalid controller config {index}", cwd=self.target)
            self.target_head = command("git", "rev-parse", "HEAD", cwd=self.target).stdout.strip()
            pending = json.loads(self.pending.read_text()); pending["head"] = self.target_head
            self.pending.write_text(json.dumps(pending))
            self.plan = self.receipts / f"invalid-plan-{index}.json"
            refused = self.invoke(
                "plan", "--source-controller", str(self.source), "--source-ref", "refs/heads/old-controller",
                "--expected-source-head", self.source_head, "--target-controller", str(self.target),
                "--target-ref", "refs/heads/controller-new", "--expected-target-head", self.target_head,
                "--product-root", str(self.product), "--product-ref", "refs/heads/main",
                "--expected-product-head", self.product_head, "--runtime", str(self.runtime),
                "--runtime-version", "2.1.1", "--inventory", str(self.inventory),
                "--policy-bundle", str(self.policy), "--pending-verification", str(self.pending),
                "--output", str(self.plan), check=False)
            self.assertIn("exact canonical metadata-only workspace shape", refused.stderr)
            self.assertFalse(self.plan.exists())

    def test_plan_refuses_missing_gitignore_or_tracked_agent_surface_verification(self) -> None:
        original_path = command("git", "config", "--local", "--get", "juno.controller.path",
                                cwd=self.product).stdout.strip()
        for check in ("gitignore_materialized", "root_agent_ignores", "agent_surface_untracked"):
            pending = json.loads(self.pending.read_text())
            pending["checks"][check] = False
            self.pending.write_text(json.dumps(pending))
            self.plan = self.receipts / f"refused-{check}.json"
            refused = self.invoke(
                "plan", "--source-controller", str(self.source), "--source-ref", "refs/heads/old-controller",
                "--expected-source-head", self.source_head, "--target-controller", str(self.target),
                "--target-ref", "refs/heads/controller-new", "--expected-target-head", self.target_head,
                "--product-root", str(self.product), "--product-ref", "refs/heads/main",
                "--expected-product-head", self.product_head, "--runtime", str(self.runtime),
                "--runtime-version", "2.1.1", "--inventory", str(self.inventory),
                "--policy-bundle", str(self.policy), "--pending-verification", str(self.pending),
                "--output", str(self.plan), check=False)
            self.assertIn("pending controller verification receipt", refused.stderr)
            self.assertFalse(self.plan.exists())
            pending["checks"][check] = True
            self.pending.write_text(json.dumps(pending))
        self.assertEqual(command("git", "config", "--local", "--get", "juno.controller.path",
                                 cwd=self.product).stdout.strip(), original_path)

    def test_legacy_source_role_may_be_absent_only_with_exact_registered_resolver_evidence(self) -> None:
        command("git", "config", "--worktree", "--unset-all", "juno.workspace.role", cwd=self.source)
        self.make_plan()
        before = json.loads(self.plan.read_text())["before"]
        self.assertEqual(before["source_role"], {"present": False, "value": None})
        apply = self.receipts / "legacy-apply.json"
        self.invoke("apply", "--plan", str(self.plan), "--output", str(apply), "--authorize-apply")
        rollback = self.receipts / "legacy-rollback.json"
        self.invoke("rollback", "--plan", str(self.plan), "--output", str(rollback), "--authorize-rollback")
        self.assertNotEqual(command("git", "config", "--worktree", "--get", "juno.workspace.role", cwd=self.source, check=False).returncode, 0)

    def test_preauthorized_product_refuses_planning_without_mutation(self) -> None:
        command("git", "config", "--worktree", "juno.workspace.roleAuthority", "protected-integration.v1", cwd=self.product)
        refused = self.invoke("plan", "--source-controller", str(self.source), "--source-ref", "refs/heads/old-controller",
            "--expected-source-head", self.source_head, "--target-controller", str(self.target),
            "--target-ref", "refs/heads/controller-new", "--expected-target-head", self.target_head,
            "--product-root", str(self.product), "--product-ref", "refs/heads/main", "--expected-product-head", self.product_head,
            "--runtime", str(self.runtime), "--runtime-version", "2.1.1", "--inventory", str(self.inventory),
            "--policy-bundle", str(self.policy), "--pending-verification", str(self.pending),
            "--output", str(self.receipts / "preauthorized.json"), check=False)
        self.assertIn("must be fresh", refused.stderr)
        self.assertFalse((self.receipts / "preauthorized.json").exists())

    def test_authority_dirt_detached_stale_and_foreign_config_fail_closed(self) -> None:
        self.make_plan()
        refused = self.invoke("apply", "--plan", str(self.plan), "--output", str(self.receipts / "noauth.json"), check=False)
        self.assertNotEqual(refused.returncode, 0)
        collision = self.receipts / "collision.json"; collision.write_text('{"foreign":true}\n')
        refused = self.invoke("apply", "--plan", str(self.plan), "--output", str(collision), "--authorize-apply", check=False)
        self.assertIn("collides", refused.stderr)
        self.assertEqual(command("git", "config", "--local", "--get", "juno.controller.path", cwd=self.product).stdout.strip(), str(self.source))
        (self.target / "dirty.tmp").write_text("dirty")
        refused = self.invoke("apply", "--plan", str(self.plan), "--output", str(self.receipts / "dirty.json"), "--authorize-apply", check=False)
        self.assertIn("must be clean", refused.stderr); (self.target / "dirty.tmp").unlink()
        command("git", "checkout", "--detach", cwd=self.target)
        refused = self.invoke("apply", "--plan", str(self.plan), "--output", str(self.receipts / "detached.json"), "--authorize-apply", check=False)
        self.assertIn("must be attached", refused.stderr)
        command("git", "switch", "controller-new", cwd=self.target)
        command("git", "config", "--local", "juno.controller.path", str(self.temporary / "foreign"), cwd=self.product)
        refused = self.invoke("apply", "--plan", str(self.plan), "--output", str(self.receipts / "foreign.json"), "--authorize-apply", check=False)
        self.assertIn("differs from both frozen endpoints", refused.stderr)

    def test_interrupted_apply_is_truthfully_detected_and_recoverable(self) -> None:
        self.make_plan(); output = self.receipts / "crashed.json"
        env = {"JUNO_CONTROLLER_REGISTRATION_TEST_MODE": "1", "JUNO_CONTROLLER_REGISTRATION_CRASH_AFTER": "controller-path"}
        crashed = self.invoke("apply", "--plan", str(self.plan), "--output", str(output), "--authorize-apply", check=False, env=env)
        self.assertNotEqual(crashed.returncode, 0); self.assertFalse(output.exists())
        self.assertTrue((self.receipts / "crashed.json.intent.json").exists())
        diagnostic = self.invoke("verify", "--plan", str(self.plan), "--output", str(self.receipts / "partial.json"), check=False)
        self.assertIn("partial", diagnostic.stderr)
        self.assertEqual(json.loads((self.receipts / "partial.json").read_text())["evidence"]["registration"]["classification"], "recoverable_partial")
        self.invoke("apply", "--plan", str(self.plan), "--output", str(output), "--authorize-apply")
        self.assertEqual(json.loads(output.read_text())["outcome"], "registered")

    def test_interrupted_product_authority_registration_is_recoverable(self) -> None:
        self.make_plan(); output = self.receipts / "authority-crashed.json"
        env = {"JUNO_CONTROLLER_REGISTRATION_TEST_MODE": "1", "JUNO_CONTROLLER_REGISTRATION_CRASH_AFTER": "product-authority"}
        crashed = self.invoke("apply", "--plan", str(self.plan), "--output", str(output), "--authorize-apply", check=False, env=env)
        self.assertNotEqual(crashed.returncode, 0); self.assertFalse(output.exists())
        diagnostic = self.invoke("verify", "--plan", str(self.plan), "--output", str(self.receipts / "authority-partial.json"), check=False)
        self.assertIn("partial", diagnostic.stderr)
        state = json.loads((self.receipts / "authority-partial.json").read_text())["evidence"]["registration"]
        self.assertEqual(state["classification"], "recoverable_partial")
        self.invoke("apply", "--plan", str(self.plan), "--output", str(output), "--authorize-apply")

    def test_stale_ref_fails_before_registration_mutation(self) -> None:
        self.make_plan()
        (self.target / "advance.txt").write_text("advance\n")
        command("git", "add", "advance.txt", cwd=self.target); command("git", "commit", "-m", "advance", cwd=self.target)
        refused = self.invoke("apply", "--plan", str(self.plan), "--output", str(self.receipts / "stale.json"), "--authorize-apply", check=False)
        self.assertIn("moved", refused.stderr)
        self.assertEqual(command("git", "config", "--local", "--get", "juno.controller.path", cwd=self.product).stdout.strip(), str(self.source))
        self.assertFalse((self.receipts / "stale.json.intent.json").exists())

    def test_duplicate_registration_values_refuse_lossy_planning(self) -> None:
        command("git", "config", "--local", "--add", "juno.controller.branch", "old-controller", cwd=self.product)
        refused = self.invoke("plan", "--source-controller", str(self.source), "--source-ref", "refs/heads/old-controller",
            "--expected-source-head", self.source_head, "--target-controller", str(self.target),
            "--target-ref", "refs/heads/controller-new", "--expected-target-head", self.target_head,
            "--product-root", str(self.product), "--product-ref", "refs/heads/main", "--expected-product-head", self.product_head,
            "--runtime", str(self.runtime), "--runtime-version", "2.1.1", "--inventory", str(self.inventory),
            "--policy-bundle", str(self.policy), "--pending-verification", str(self.pending),
            "--output", str(self.receipts / "duplicate.json"), check=False)
        self.assertIn("duplicate Git config", refused.stderr)


if __name__ == "__main__":
    unittest.main()
