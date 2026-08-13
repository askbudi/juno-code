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

        self.runtime = self.temp / "installed/dist/bin/yy"
        write(self.runtime, "#!/bin/sh\nprintf 'juno-code 2.0.32\\n'\n")
        self.runtime.chmod(self.runtime.stat().st_mode | stat.S_IXUSR)
        write(self.temp / "installed/dist/templates/scripts/controller_resolver.py", "# runtime resolver\n")
        write(self.temp / "installed/dist/templates/scripts/task_workspace.py", "# task workspace\n")
        self.new_controller = self.temp / "metadata-controller"
        self.policy = mc.load_policy(POLICY)
        self.plan_path = self.temp / "plan.json"
        self.task_policy = self.temp / "reviewed/task-workspace.json"
        self.integration_policy = self.temp / "reviewed/integration-workspace.json"
        self.risk_policy = self.temp / "reviewed/risk-policy.json"
        write(self.task_policy, (POLICY.parent / "task-workspace.json").read_text())
        write(self.integration_policy, (POLICY.parent / "integration-workspace.json").read_text())
        write(self.risk_policy, (POLICY.parent / "risk-policy.json").read_text())

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
            "policy_bundle": None,
            "task_workspace_policy": self.task_policy,
            "integration_workspace_policy": self.integration_policy,
            "risk_policy": self.risk_policy,
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
        self.assertTrue((self.new_controller / ".juno_task/scripts/controller_resolver.py").is_file())
        self.assertEqual(payload["runtime_scripts"]["file_count"], 2)
        self.assertTrue((self.new_controller / ".gitignore").is_file())
        self.assertTrue((self.new_controller / ".juno_task/state/tasks.json").is_file())
        self.assertTrue((self.new_controller / ".juno_task/receipts/controller-boundary.json").is_file())
        self.assertEqual(command("git", "config", "--worktree", "--get", "core.sparseCheckout",
                                 cwd=self.new_controller), "false")
        self.assertIn(".juno_task/scripts/", (self.new_controller / ".gitignore").read_text())
        self.assertIn(".juno_task/cache/", (self.new_controller / ".gitignore").read_text())
        self.assertIn(".juno_task/locks/", (self.new_controller / ".gitignore").read_text())
        self.assertIn("/AGENTS.md", (self.new_controller / ".gitignore").read_text())
        self.assertIn("/.agents/", (self.new_controller / ".gitignore").read_text())
        generated_config = json.loads((self.new_controller / ".juno_task/config.json").read_text())
        self.assertEqual(
            generated_config["controllerWorkspace"]["policy"],
            ".juno_task/config/metadata-controller.json",
        )
        self.assertTrue((self.new_controller / ".juno_task/config/metadata-controller.json").is_file())
        integration_policy = self.new_controller / ".juno_task/config/integration-workspace.json"
        self.assertEqual(json.loads(integration_policy.read_text()),
                         json.loads(self.integration_policy.read_text()))
        self.assertIn(".juno_task/config/integration-workspace.json",
                      command("git", "ls-files", cwd=self.new_controller).splitlines())
        risk_policy = self.new_controller / ".juno_task/config/risk-policy.json"
        self.assertTrue(risk_policy.is_file())
        self.assertEqual(json.loads(risk_policy.read_text()),
                         json.loads(self.risk_policy.read_text()))
        self.assertIn(".juno_task/config/risk-policy.json",
                      command("git", "ls-files", cwd=self.new_controller).splitlines())
        boundary = json.loads((self.new_controller / ".juno_task/receipts/controller-boundary.json").read_text())
        self.assertGreater(len(boundary["preserved_metadata"]["entries"]), 2)
        write(self.new_controller / ".juno_task/scripts/generated.py", "print('generated')\n")
        write(self.new_controller / ".juno_task/cache/kanban.sqlite3", "cache\n")
        write(self.new_controller / ".juno_task/locks/task.lock", "lock\n")
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

    def test_sparse_materialization_and_root_ignore_contract_fail_before_admission(self) -> None:
        self.prepare()
        command("git", "sparse-checkout", "set", "--no-cone", "/.juno_task/", cwd=self.new_controller)
        sparse = mc.inspect(self.new_controller, self.policy,
                            expected_branch="refs/heads/juno/controller-metadata-v1",
                            require_active=False)
        self.assertFalse(sparse["passed"])
        self.assertFalse(sparse["checks"]["gitignore_materialized"])
        command("git", "sparse-checkout", "disable", cwd=self.new_controller)

        ignore = self.new_controller / ".gitignore"
        ignore.write_text(ignore.read_text().replace("/.claude/\n", ""))
        command("git", "add", ".gitignore", cwd=self.new_controller)
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                "commit", "-m", "omit required root ignore", cwd=self.new_controller)
        missing = mc.inspect(self.new_controller, self.policy,
                             expected_branch="refs/heads/juno/controller-metadata-v1",
                             require_active=False)
        self.assertFalse(missing["passed"])
        self.assertFalse(missing["checks"]["root_agent_ignores"])
        self.assertEqual(missing["missing_root_agent_ignores"], ["/.claude/"])

    def test_agent_surface_repair_is_reviewed_hash_bound_and_preserves_committed_evidence(self) -> None:
        self.prepare()
        evidence = {
            "AGENTS.md": "owner agents evidence\n",
            "CLAUDE.md": "owner claude evidence\n",
            ".claude/skills/owner/SKILL.md": "owner skill evidence\n",
        }
        for relative, content in evidence.items():
            write(self.new_controller / relative, content)
        command("git", "add", "-f", *evidence, cwd=self.new_controller)
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                "commit", "-m", "retain tracked owner agent evidence", cwd=self.new_controller)
        evidence_head = command("git", "rev-parse", "HEAD", cwd=self.new_controller)
        inspected = mc.inspect(self.new_controller, self.policy,
                               expected_branch="refs/heads/juno/controller-metadata-v1",
                               require_active=False)
        self.assertFalse(inspected["passed"])
        self.assertFalse(inspected["checks"]["agent_surface_untracked"])
        self.assertEqual(inspected["tracked_agent_surface"], sorted(evidence))

        args = argparse.Namespace(
            root=self.new_controller, branch="refs/heads/juno/controller-metadata-v1",
            expected_head=evidence_head, product_ref="refs/heads/juno-mono-002",
            expected_product_head=self.product_head, disposition="keep",
            output=self.temp / "invalid-agent-plan.json")
        with self.assertRaisesRegex(mc.BoundaryError, "reviewed disposition"):
            mc.agent_surface_repair_plan(args, self.policy)
        args.disposition = "externalize"; args.output = self.temp / "agent-plan.json"
        plan = mc.agent_surface_repair_plan(args, self.policy)
        self.assertTrue(plan["evidence"]["preserved_in_parent_commit"])
        self.assertEqual(plan["changes"]["remove"], sorted(evidence))

        with self.assertRaisesRegex(mc.BoundaryError, "requires --authorize"):
            mc.agent_surface_repair_apply(argparse.Namespace(
                plan=args.output, output=self.temp / "noauth.json", authorize=False), self.policy)
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=self.new_controller), evidence_head)

        approved = args.output.read_bytes(); tampered = json.loads(approved)
        tampered["reviewed_disposition"] = "retire"; args.output.write_text(json.dumps(tampered))
        with self.assertRaisesRegex(mc.BoundaryError, "hash-bound"):
            mc.agent_surface_repair_apply(argparse.Namespace(
                plan=args.output, output=self.temp / "tampered.json", authorize=True), self.policy)
        args.output.write_bytes(approved)
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=self.new_controller), evidence_head)

        write(self.new_controller / "AGENTS.md", "drift must survive refusal\n")
        with self.assertRaisesRegex(mc.BoundaryError, "clean controller"):
            mc.agent_surface_repair_apply(argparse.Namespace(
                plan=args.output, output=self.temp / "dirty.json", authorize=True), self.policy)
        self.assertEqual((self.new_controller / "AGENTS.md").read_text(), "drift must survive refusal\n")
        command("git", "restore", "AGENTS.md", cwd=self.new_controller)

        collision = self.temp / "agent-collision.json"; collision.write_text("{}\n")
        with self.assertRaisesRegex(mc.BoundaryError, "fresh before mutation"):
            mc.agent_surface_repair_apply(argparse.Namespace(
                plan=args.output, output=collision, authorize=True), self.policy)
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=self.new_controller), evidence_head)
        self.assertEqual(collision.read_text(), "{}\n")

        receipt = mc.agent_surface_repair_apply(argparse.Namespace(
            plan=args.output, output=self.temp / "agent-apply.json", authorize=True), self.policy)
        self.assertTrue(receipt["evidence_preserved_in_parent_commit"])
        self.assertEqual(receipt["removed_paths"], sorted(evidence))
        for relative, content in evidence.items():
            self.assertFalse((self.new_controller / relative).exists())
            self.assertEqual(command("git", "show", f"{evidence_head}:{relative}", cwd=self.new_controller),
                             content.rstrip("\n"))
        verified = mc.agent_surface_repair_verify(argparse.Namespace(
            plan=args.output, output=self.temp / "agent-verify.json"), self.policy)
        self.assertTrue(verified["passed"])
        self.assertEqual(command("git", "rev-parse", "refs/heads/juno-mono-002", cwd=self.repo),
                         self.product_head)

    def test_policy_updated_controller_repairs_only_hash_bound_retired_config(self) -> None:
        self.prepare()
        config_path = self.new_controller / ".juno_task/config.json"
        retired_config = {
            "defaultSubagent": "pi",
            "gitCheckpoint": {"include": [".juno_task/tasks"]},
            "promptMacros": {"global": {"owner-instruction": "preserve this evidence"}},
            "controllerWorkspace": mc.RETIRED_CONTROLLER_WORKSPACE,
        }
        config_path.write_bytes(mc.canonical(retired_config))
        command("git", "add", ".juno_task/config.json", cwd=self.new_controller)
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                "commit", "-m", "retain retired generated config", cwd=self.new_controller)
        retired_head = command("git", "rev-parse", "HEAD", cwd=self.new_controller)
        preserved_before = command("git", "ls-tree", "-r", "HEAD", cwd=self.new_controller).splitlines()
        preserved_before = [row for row in preserved_before if not row.endswith("\t.juno_task/config.json")]
        evidence = mc.inspect(self.new_controller, self.policy,
                              expected_branch="refs/heads/juno/controller-metadata-v1",
                              require_active=False)
        self.assertFalse(evidence["passed"])
        self.assertFalse(evidence["checks"]["generated_contract"])

        repair_plan = self.temp / "config-repair-plan.json"
        plan_args = argparse.Namespace(
            root=self.new_controller, branch="refs/heads/juno/controller-metadata-v1",
            expected_head=retired_head, product_ref="refs/heads/juno-mono-002",
            expected_product_head=self.product_head, output=repair_plan)
        planned = mc.config_repair_plan(plan_args, self.policy)
        self.assertFalse(planned["apply_authorized"])
        self.assertFalse(planned["preservation"]["product_ref_mutation"])

        with self.assertRaisesRegex(mc.BoundaryError, "requires --authorize"):
            mc.config_repair_apply(argparse.Namespace(
                plan=repair_plan, output=self.temp / "noauth-apply.json", authorize=False), self.policy)
        self.assertFalse((self.temp / "noauth-apply.json.intent.json").exists())
        collision = self.temp / "collision-apply.json"; collision.write_text("{}\n")
        with self.assertRaisesRegex(mc.BoundaryError, "fresh before mutation"):
            mc.config_repair_apply(argparse.Namespace(
                plan=repair_plan, output=collision, authorize=True), self.policy)
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=self.new_controller), retired_head)

        config_path.write_text("{}\n")
        with self.assertRaisesRegex(mc.BoundaryError, "clean controller"):
            mc.config_repair_apply(argparse.Namespace(
                plan=repair_plan, output=self.temp / "dirty-apply.json", authorize=True), self.policy)
        command("git", "restore", ".juno_task/config.json", cwd=self.new_controller)

        task_path = self.new_controller / ".juno_task/tasks/TASK.md"
        task_path.write_text("new work after planning\n")
        command("git", "add", ".juno_task/tasks/TASK.md", cwd=self.new_controller)
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                "commit", "-m", "advance controller after plan", cwd=self.new_controller)
        with self.assertRaisesRegex(mc.BoundaryError, "neither the frozen"):
            mc.config_repair_apply(argparse.Namespace(
                plan=repair_plan, output=self.temp / "stale-apply.json", authorize=True), self.policy)
        retired_head = command("git", "rev-parse", "HEAD", cwd=self.new_controller)
        preserved_before = command("git", "ls-tree", "-r", "HEAD", cwd=self.new_controller).splitlines()
        preserved_before = [row for row in preserved_before if not row.endswith("\t.juno_task/config.json")]
        repair_plan = self.temp / "config-repair-plan-current.json"
        plan_args.expected_head = retired_head; plan_args.output = repair_plan
        mc.config_repair_plan(plan_args, self.policy)

        approved_bytes = repair_plan.read_bytes()
        tampered = json.loads(approved_bytes); tampered["correction"]["before_sha256"] = "0" * 64
        repair_plan.write_text(json.dumps(tampered))
        with self.assertRaisesRegex(mc.BoundaryError, "hash-bound"):
            mc.config_repair_apply(argparse.Namespace(
                plan=repair_plan, output=self.temp / "tampered-apply.json", authorize=True), self.policy)
        repair_plan.write_bytes(approved_bytes)

        apply_output = self.temp / "config-repair.json"
        receipt = mc.config_repair_apply(argparse.Namespace(
            plan=repair_plan, output=apply_output, authorize=True), self.policy)
        self.assertTrue(receipt["preservation_verified"])
        self.assertTrue((self.temp / "config-repair.json.intent.json").is_file())
        common = Path(command("git", "rev-parse", "--path-format=absolute", "--git-common-dir",
                              cwd=self.new_controller))
        self.assertTrue((common / "juno-repository-writer.lock").is_file())
        self.assertTrue((common / "juno-controller-config-repair.lock").is_file())
        self.assertEqual(receipt["changed_paths"], [".juno_task/config.json"])
        repaired_config = json.loads(config_path.read_text())
        self.assertEqual(repaired_config["controllerWorkspace"], mc.CANONICAL_CONTROLLER_WORKSPACE)
        for key in ("defaultSubagent", "gitCheckpoint", "promptMacros"):
            self.assertEqual(repaired_config[key], retired_config[key])
        self.assertEqual(json.loads(command(
            "git", "show", f"{retired_head}:.juno_task/config.json", cwd=self.new_controller)),
            retired_config)
        self.assertEqual(json.loads(repair_plan.read_text())["correction"]["before"], retired_config)
        first_receipt = apply_output.read_bytes(); apply_output.unlink()
        retried = mc.config_repair_apply(argparse.Namespace(
            plan=repair_plan, output=apply_output, authorize=True), self.policy)
        self.assertEqual(retried["new_head"], receipt["new_head"])
        self.assertEqual(apply_output.read_bytes(), first_receipt)
        preserved_after = command("git", "ls-tree", "-r", "HEAD", cwd=self.new_controller).splitlines()
        preserved_after = [row for row in preserved_after if not row.endswith("\t.juno_task/config.json")]
        self.assertEqual(preserved_after, preserved_before)
        self.assertEqual(command("git", "symbolic-ref", "HEAD", cwd=self.new_controller),
                         "refs/heads/juno/controller-metadata-v1")
        self.assertEqual(command("git", "rev-parse", "refs/heads/juno-mono-002", cwd=self.repo),
                         self.product_head)
        self.assertEqual(command("git", "status", "--porcelain", cwd=self.new_controller), "")
        admitted = mc.inspect(self.new_controller, self.policy,
                              expected_branch="refs/heads/juno/controller-metadata-v1",
                              require_active=False)
        self.assertTrue(admitted["passed"])

    def test_config_repair_refuses_lifecycle_and_unknown_workspace_shapes(self) -> None:
        self.prepare()
        config_path = self.new_controller / ".juno_task/config.json"
        for index, value in enumerate((
            {"lifecycle": {"enabled": True}, "controllerWorkspace": mc.RETIRED_CONTROLLER_WORKSPACE},
            {"controllerWorkspace": {"mode": "metadata-only", "policy": "foreign.json"}},
        )):
            config_path.write_bytes(mc.canonical(value))
            command("git", "add", ".juno_task/config.json", cwd=self.new_controller)
            command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                    "commit", "-m", f"invalid config {index}", cwd=self.new_controller)
            head = command("git", "rev-parse", "HEAD", cwd=self.new_controller)
            with self.assertRaisesRegex(mc.BoundaryError, "limited to the policy-updated"):
                mc.config_repair_plan(argparse.Namespace(
                    root=self.new_controller, branch="refs/heads/juno/controller-metadata-v1",
                    expected_head=head, product_ref="refs/heads/juno-mono-002",
                    expected_product_head=self.product_head,
                    output=self.temp / f"invalid-plan-{index}.json"), self.policy)

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

    def test_plan_binds_reviewed_policy_content_and_prepare_rejects_source_drift(self) -> None:
        planned = mc.migration_plan(self.migration_args(), self.policy)
        reviewed = planned["reviewed_policies"]
        self.assertEqual(reviewed["source"]["kind"], "explicit_paths")
        self.assertEqual(reviewed["task_workspace"]["sha256"],
                         mc.digest(json.loads(self.task_policy.read_text())))
        task = json.loads(self.task_policy.read_text())
        task["workspace_root"] = str(self.temp / "different-task-worktrees")
        self.task_policy.write_text(json.dumps(task))
        with self.assertRaisesRegex(mc.BoundaryError, "changed after planning"):
            mc.prepare(argparse.Namespace(plan=self.plan_path, output=self.temp / "prepare.json"), self.policy)
        self.assertFalse(self.new_controller.exists())

    def test_policy_bundle_is_accepted_and_missing_reviewed_policies_are_refused(self) -> None:
        bundle = self.temp / "reviewed/policy-bundle.json"
        bundle_value = {
            "schema_version": "juno_migration_policy_bundle.v1",
            "operation": "generate-policy",
            "outcome": "generated_from_reviewed_answers",
            "policies": {
                "metadata_controller": json.loads(json.dumps(self.policy)),
                "task_workspace": json.loads(self.task_policy.read_text()),
                "integration_workspace": json.loads(self.integration_policy.read_text()),
                "risk": json.loads(self.risk_policy.read_text()),
            },
        }
        bundle_value["policies"]["metadata_controller"]["generated_metadata"] = list(
            reversed(bundle_value["policies"]["metadata_controller"]["generated_metadata"])
        )
        bundle_value["policies"]["metadata_controller"]["runtime"]["ignored_roots"] = list(
            reversed(bundle_value["policies"]["metadata_controller"]["runtime"]["ignored_roots"])
        )
        write(bundle, json.dumps(bundle_value))
        planned = mc.migration_plan(self.migration_args(
            policy_bundle=bundle, task_workspace_policy=None,
            integration_workspace_policy=None, risk_policy=None), self.policy)
        self.assertEqual(planned["reviewed_policies"]["source"]["path"], str(bundle.resolve()))
        self.assertEqual(planned["reviewed_policies"]["source"]["kind"], "policy_bundle")
        self.assertEqual(mc.policy_from_plan_bundle(self.plan_path), self.policy)

        self.plan_path = self.temp / "missing-plan.json"
        with self.assertRaisesRegex(mc.BoundaryError, "requires --policy-bundle"):
            mc.migration_plan(self.migration_args(
                task_workspace_policy=None, integration_workspace_policy=None,
                risk_policy=None), self.policy)

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
        command(
            "git", "rm",
            ".juno_task/config/metadata-controller.json",
            ".juno_task/config/task-workspace.json",
            ".juno_task/config/integration-workspace.json",
            ".juno_task/config/risk-policy.json",
            ".juno_task/state/tasks.json",
            cwd=self.new_controller,
        )
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
            {
                ".juno_task/config/metadata-controller.json",
                ".juno_task/config/task-workspace.json",
                ".juno_task/config/integration-workspace.json",
                ".juno_task/config/risk-policy.json",
                ".juno_task/state/tasks.json",
            },
        )

    def test_verification_rejects_tracked_risk_policy_byte_drift(self) -> None:
        self.prepare()
        risk_path = self.new_controller / ".juno_task/config/risk-policy.json"
        value = json.loads(risk_path.read_text()); value["release_flags"] = ["forged-release"]
        risk_path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
        command("git", "add", ".juno_task/config/risk-policy.json", cwd=self.new_controller)
        command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                "commit", "-m", "drift risk policy", cwd=self.new_controller)
        evidence = mc.inspect(self.new_controller, self.policy,
                              expected_branch="refs/heads/juno/controller-metadata-v1",
                              require_active=False)
        self.assertFalse(evidence["passed"])
        self.assertFalse(evidence["checks"]["generated_contract"])

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

    def test_nvm_git_ancestor_uses_supported_fresh_prefix_install_and_rebind(self) -> None:
        self.prepare()
        nvm = self.temp / "home/.nvm"
        nvm.mkdir(parents=True)
        command("git", "init", cwd=nvm)
        nvm_runtime = nvm / "versions/node/v22/lib/node_modules/juno-code/dist/bin/cli.mjs"
        write(nvm_runtime, "#!/bin/sh\nprintf 'juno-code 2.0.33\\n'\n")
        nvm_runtime.chmod(nvm_runtime.stat().st_mode | stat.S_IXUSR)
        execution_marker = self.temp / "nvm-runtime-executed"
        write(nvm_runtime, f"#!/bin/sh\ntouch '{execution_marker}'\nprintf 'juno-code 2.0.33\\n'\n")
        with self.assertRaisesRegex(mc.BoundaryError, "runtime-install-rebind --help"):
            mc.runtime_identity(nvm_runtime, "2.0.33", self.new_controller)
        self.assertFalse(execution_marker.exists())

        prefix = self.temp / "durable-runtimes/2.0.33"
        receipt_path = self.temp / "nvm-install-rebind.json"
        fake_npm = self.temp / "nvm/versions/node/v22/bin/npm"
        write(fake_npm, "#!/bin/sh\nexit 99\n")
        fake_npm.chmod(fake_npm.stat().st_mode | stat.S_IXUSR)
        original_which = mc.shutil.which
        original_run = mc.run

        def install_fixture(argv: list[str], cwd: Path, check: bool = True, **kwargs: object) -> subprocess.CompletedProcess[str]:
            if argv and argv[0] == str(fake_npm):
                installed = prefix / "node_modules/juno-code"
                write(installed / "package.json", json.dumps({"name": "juno-code", "version": "2.0.33"}) + "\n")
                executable = installed / "dist/bin/cli.mjs"
                write(executable, "#!/bin/sh\nprintf 'juno-code 2.0.33\\n'\n")
                executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
                return subprocess.CompletedProcess(argv, 0, "installed\n", "")
            return original_run(argv, cwd, check, **kwargs)

        try:
            mc.shutil.which = lambda name: str(fake_npm) if name == "npm" else original_which(name)
            mc.run = install_fixture
            receipt = mc.runtime_install_rebind(argparse.Namespace(
                root=self.new_controller,
                branch="refs/heads/juno/controller-metadata-v1",
                runtime_version="2.0.33",
                install_prefix=prefix,
                output=receipt_path,
            ), self.policy)
        finally:
            mc.shutil.which = original_which
            mc.run = original_run

        expected_runtime = (prefix / "node_modules/juno-code/dist/bin/cli.mjs").resolve()
        self.assertEqual(receipt["runtime"]["executable"], str(expected_runtime))
        self.assertTrue(receipt_path.is_file())
        self.assertEqual(command("git", "status", "--porcelain", cwd=self.new_controller), "")
        self.assertEqual(command("git", "config", "--worktree", "--get", "juno.controller.runtimeExecutable", cwd=self.new_controller), str(expected_runtime))

    def test_runtime_install_rebind_removes_failed_fresh_prefix(self) -> None:
        self.prepare()
        prefix = self.temp / "failed-runtime"
        fake_npm = self.temp / "bin/npm"
        write(fake_npm, "#!/bin/sh\nexit 1\n")
        fake_npm.chmod(fake_npm.stat().st_mode | stat.S_IXUSR)
        original_which = mc.shutil.which
        try:
            mc.shutil.which = lambda name: str(fake_npm) if name == "npm" else original_which(name)
            with self.assertRaisesRegex(mc.BoundaryError, "exact runtime installation failed"):
                mc.runtime_install_rebind(argparse.Namespace(
                    root=self.new_controller,
                    branch="refs/heads/juno/controller-metadata-v1",
                    runtime_version="2.0.33",
                    install_prefix=prefix,
                    output=self.temp / "failed-runtime.json",
                ), self.policy)
        finally:
            mc.shutil.which = original_which
        self.assertFalse(prefix.exists())
        self.assertEqual(command("git", "status", "--porcelain", cwd=self.new_controller), "")

    def legacy_policy_controller(self) -> tuple[Path, bytes]:
        self.prepare()
        root = self.new_controller
        branch = "refs/heads/juno/controller-metadata-v1"
        command("git", "config", "--worktree", "juno.workspace.role", "controller", cwd=root)
        command("git", "config", "--local", "juno.controller.path", str(root), cwd=root)
        command("git", "config", "--local", "juno.controller.branch", branch, cwd=root)
        runtime_entrypoint = Path(__file__).resolve().parents[3] / "bin/cli.ts"
        package_source = mc.package_policy_source(root, str(runtime_entrypoint))
        command("git", "config", "--worktree", "juno.controller.runtimeVersion",
                package_source["version"], cwd=root)
        command("git", "config", "--worktree", "juno.controller.runtimeExecutable",
                package_source["runtime_entrypoint"], cwd=root)
        config_path = root / mc.CONFIG_PATH
        config = json.loads(config_path.read_bytes())
        config["gitCheckpoint"] = {"include": [".juno_task/tasks"]}
        config_path.write_text(json.dumps(config, separators=(",", ":")) + "\n")
        policy_path = root / mc.POLICY_PATH
        value = json.loads(policy_path.read_bytes())
        value["generated_metadata"].remove(mc.INTEGRATION_POLICY_PATH)
        value["tracked_exact"].remove(mc.INTEGRATION_POLICY_PATH)
        legacy = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        policy_path.write_bytes(legacy)
        (root / mc.INTEGRATION_POLICY_PATH).unlink()
        command("git", "add", "-A", "--", mc.CONFIG_PATH, mc.POLICY_PATH, mc.INTEGRATION_POLICY_PATH, cwd=root)
        command("git", "commit", "-m", "legacy metadata policy", cwd=root)
        return root, legacy

    def policy_plan(self, root: Path, name: str = "metadata-policy-plan.json") -> tuple[Path, dict[str, object]]:
        path = self.temp / name
        payload = mc.policy_migration_plan(argparse.Namespace(root=root, output=path))
        return path, payload

    def test_metadata_policy_plan_is_read_only_and_apply_creates_one_exact_clean_commit(self) -> None:
        root, legacy = self.legacy_policy_controller()
        before = command("git", "rev-parse", "HEAD", cwd=root)
        plan_path, plan = self.policy_plan(root)
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=root), before)
        self.assertEqual(command("git", "status", "--porcelain=v2", "--untracked-files=all", cwd=root), "")
        self.assertEqual(plan["policy_before_sha256"], mc.bytes_digest(legacy))
        self.assertEqual(plan["changed_paths"], sorted(mc.POLICY_MIGRATION_PATHS))
        self.assertEqual(plan["semantic_additions"], [
            {"field": "generated_metadata", "value": mc.INTEGRATION_POLICY_PATH},
            {"field": "tracked_exact", "value": mc.INTEGRATION_POLICY_PATH},
        ])
        receipt = mc.policy_migration_apply(argparse.Namespace(
            plan=plan_path, output=self.temp / "metadata-policy-apply.json", authorize=True))
        self.assertEqual(receipt["outcome"], "migrated")
        self.assertEqual(command("git", "rev-parse", "HEAD^", cwd=root), before)
        self.assertEqual(command("git", "diff", "--name-only", "HEAD^", "HEAD", cwd=root).splitlines(),
                         sorted(mc.POLICY_MIGRATION_PATHS))
        self.assertEqual(command("git", "status", "--porcelain=v2", "--untracked-files=all", cwd=root), "")
        migrated = (root / mc.POLICY_PATH).read_bytes()
        # The compact owner formatting remains compact; only two array strings were inserted.
        self.assertNotIn(b"\n  ", migrated)
        self.assertEqual(json.loads(migrated)["controller_branch"], "refs/heads/juno/controller-metadata-v1")
        self.assertEqual((root / mc.INTEGRATION_POLICY_PATH).read_bytes(),
                         (POLICY.parent / "integration-workspace.json").read_bytes())

        idempotent_plan, no_change = self.policy_plan(root, "metadata-policy-idempotent-plan.json")
        self.assertEqual(no_change["outcome"], "already_migrated_no_mutation")
        tip = command("git", "rev-parse", "HEAD", cwd=root)
        noop = mc.policy_migration_apply(argparse.Namespace(
            plan=idempotent_plan, output=self.temp / "metadata-policy-idempotent.json", authorize=True))
        self.assertEqual(noop["outcome"], "already_migrated_noop")
        replay = mc.policy_migration_apply(argparse.Namespace(
            plan=plan_path, output=self.temp / "metadata-policy-apply.json", authorize=True))
        self.assertEqual(replay["new_head"], tip)
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=root), tip)

    def test_metadata_policy_apply_refuses_stale_tampered_dirty_and_alternate_index(self) -> None:
        root, _ = self.legacy_policy_controller()
        plan_path, _ = self.policy_plan(root)
        original = plan_path.read_bytes()
        tampered = json.loads(original); tampered["policy_result_sha256"] = "0" * 64
        plan_path.write_text(json.dumps(tampered))
        with self.assertRaisesRegex(mc.BoundaryError, "hash-bound plan"):
            mc.policy_migration_apply(argparse.Namespace(
                plan=plan_path, output=self.temp / "tampered.json", authorize=True))
        plan_path.write_bytes(original)

        write(root / ".juno_task/tasks/unrelated.md", "dirt\n")
        with self.assertRaisesRegex(mc.BoundaryError, "clean controller"):
            mc.policy_migration_apply(argparse.Namespace(
                plan=plan_path, output=self.temp / "dirty.json", authorize=True))
        (root / ".juno_task/tasks/unrelated.md").unlink()

        previous = os.environ.get("GIT_INDEX_FILE")
        os.environ["GIT_INDEX_FILE"] = str(self.temp / "alternate-index")
        try:
            with self.assertRaisesRegex(mc.BoundaryError, "alternate GIT_INDEX_FILE"):
                mc.policy_migration_apply(argparse.Namespace(
                    plan=plan_path, output=self.temp / "alternate.json", authorize=True))
        finally:
            if previous is None: os.environ.pop("GIT_INDEX_FILE", None)
            else: os.environ["GIT_INDEX_FILE"] = previous

        write(root / ".juno_task/tasks/stale.md", "stale\n")
        command("git", "add", ".juno_task/tasks/stale.md", cwd=root)
        command("git", "commit", "-m", "move controller head", cwd=root)
        with self.assertRaisesRegex(mc.BoundaryError, "not the exact completed"):
            mc.policy_migration_apply(argparse.Namespace(
                plan=plan_path, output=self.temp / "stale-head.json", authorize=True))

    def test_metadata_policy_refuses_wrong_role_root_symlink_and_policy_runtime_product_drift(self) -> None:
        root, _ = self.legacy_policy_controller()
        command("git", "config", "--worktree", "juno.workspace.role", "task", cwd=root)
        with self.assertRaisesRegex(mc.BoundaryError, "active metadata-only controller role"):
            self.policy_plan(root)
        command("git", "config", "--worktree", "juno.workspace.role", "controller", cwd=root)
        runtime_version = command("git", "config", "--worktree", "--get",
                                  "juno.controller.runtimeVersion", cwd=root)
        command("git", "config", "--worktree", "juno.controller.runtimeVersion", "0.0.0", cwd=root)
        with self.assertRaisesRegex(mc.BoundaryError, "registered controller runtime differs"):
            self.policy_plan(root)
        command("git", "config", "--worktree", "juno.controller.runtimeVersion", runtime_version, cwd=root)
        link = self.temp / "controller-link"; link.symlink_to(root, target_is_directory=True)
        with self.assertRaisesRegex(mc.BoundaryError, "symbolic-link controller root"):
            self.policy_plan(link)
        nested = root / ".juno_task/config/.git"; nested.mkdir()
        with self.assertRaisesRegex(mc.BoundaryError, "nested repository"):
            self.policy_plan(root)
        nested.rmdir()
        command("git", "config", "--local", "juno.controller.path", str(self.repo), cwd=root)
        with self.assertRaisesRegex(mc.BoundaryError, "registration"):
            self.policy_plan(root)
        command("git", "config", "--local", "juno.controller.path", str(root), cwd=root)

        plan_path, _ = self.policy_plan(root)
        original_source = mc.package_policy_source
        try:
            mc.package_policy_source = lambda candidate, runtime=None: {
                **original_source(candidate, runtime), "version": "package-drift"}
            with self.assertRaisesRegex(mc.BoundaryError, "registered controller runtime differs"):
                mc.policy_migration_apply(argparse.Namespace(
                    plan=plan_path, output=self.temp / "package-drift.json", authorize=True))
        finally:
            mc.package_policy_source = original_source
        generation = root / ".juno_task/runtime/managed-controller/generation.json"
        write(generation, json.dumps({"schema_version": "juno_managed_controller_runtime.v1",
                                     "package_version": "9.9.9", "target_sha": "a" * 40, "scripts": {}}))
        with self.assertRaisesRegex(mc.BoundaryError, "generation does not match"):
            mc.policy_migration_apply(argparse.Namespace(
                plan=plan_path, output=self.temp / "runtime-drift.json", authorize=True))
        generation.unlink()

        (root / mc.POLICY_PATH).write_bytes((root / mc.POLICY_PATH).read_bytes() + b" ")
        with self.assertRaisesRegex(mc.BoundaryError, "clean controller"):
            mc.policy_migration_apply(argparse.Namespace(
                plan=plan_path, output=self.temp / "policy-drift.json", authorize=True))
        command("git", "restore", "--", mc.POLICY_PATH, cwd=root)

        tree = command("git", "rev-parse", "refs/heads/juno-mono-002^{tree}", cwd=root)
        moved = command("git", "commit-tree", tree, "-p", self.product_head, "-m", "move product", cwd=root)
        command("git", "update-ref", "refs/heads/juno-mono-002", moved, self.product_head, cwd=root)
        with self.assertRaisesRegex(mc.BoundaryError, "stale"):
            mc.policy_migration_apply(argparse.Namespace(
                plan=plan_path, output=self.temp / "product-drift.json", authorize=True))

    def test_metadata_policy_concurrent_worktree_mutation_fails_before_commit_and_checkpoint_still_refuses_policy(self) -> None:
        root, _ = self.legacy_policy_controller()
        plan_path, _ = self.policy_plan(root)
        pause = str(self.temp / "pause")
        env = {**os.environ, "JUNO_METADATA_POLICY_MIGRATION_TEST_PAUSE_FILE": pause}
        process = subprocess.Popen([
            "python3", str(SCRIPT), "metadata-policy-apply", "--plan", str(plan_path),
            "--output", str(self.temp / "race-apply.json"), "--authorize-metadata-policy-migration",
        ], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        for _ in range(500):
            if Path(pause + ".ready").exists(): break
            import time; time.sleep(0.01)
        else:
            process.kill(); self.fail("migration apply did not reach deterministic race seam")
        (root / mc.POLICY_PATH).write_bytes((root / mc.POLICY_PATH).read_bytes() + b" ")
        Path(pause + ".release").write_text("release\n")
        stdout, stderr = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, stdout)
        self.assertIn("clean controller", stderr)
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=root), json.loads(plan_path.read_text())["head"])
        self.assertEqual(command("git", "diff", "--cached", "--name-only", cwd=root), "")

        checkpoint = SCRIPT.with_name("controller_checkpoint.py")
        result = subprocess.run(["python3", str(checkpoint), "--root", str(root), "plan"],
                                text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("blocked non-controller paths", result.stderr)

    def test_metadata_policy_holds_real_index_lock_and_rejects_concurrent_staging_before_commit(self) -> None:
        root, _ = self.legacy_policy_controller()
        plan_path, plan = self.policy_plan(root)
        pause = str(self.temp / "index-pause")
        process = subprocess.Popen([
            "python3", str(SCRIPT), "metadata-policy-apply", "--plan", str(plan_path),
            "--output", str(self.temp / "index-race-apply.json"), "--authorize-metadata-policy-migration",
        ], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
           env={**os.environ, "JUNO_METADATA_POLICY_MIGRATION_TEST_INDEX_PAUSE_FILE": pause})
        for _ in range(500):
            if Path(pause + ".ready").exists(): break
            import time; time.sleep(0.01)
        else:
            process.kill(); self.fail("migration apply did not acquire the deterministic index lock")
        task = root / ".juno_task/tasks/TASK.md"; task.write_text("concurrent staging\n")
        staged = subprocess.run(["git", "add", ".juno_task/tasks/TASK.md"], cwd=root,
                                text=True, capture_output=True)
        self.assertNotEqual(staged.returncode, 0)
        self.assertIn("index.lock", staged.stderr)
        Path(pause + ".release").write_text("release\n")
        stdout, stderr = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, stdout)
        self.assertIn("clean controller", stderr)
        self.assertEqual(command("git", "rev-parse", "HEAD", cwd=root), plan["head"])
        self.assertEqual(command("git", "diff", "--cached", "--name-only", cwd=root), "")
        index_lock = Path(command("git", "rev-parse", "--path-format=absolute", "--git-path", "index.lock", cwd=root))
        self.assertFalse(index_lock.exists())

    def test_metadata_policy_same_plan_recovers_completed_commit_with_stranded_index_and_temp(self) -> None:
        root, _ = self.legacy_policy_controller()
        plan_path, plan = self.policy_plan(root)
        receipt_path = self.temp / "recovery-apply.json"
        mc.policy_migration_apply(argparse.Namespace(plan=plan_path, output=receipt_path, authorize=True))
        receipt_path.unlink()
        index = Path(command("git", "rev-parse", "--path-format=absolute", "--git-path", "index", cwd=root))
        Path(str(index) + ".lock").write_bytes(index.read_bytes())
        stale = root / ".juno_task/config/.metadata-controller.json.migration-999"
        stale.write_text("stranded\n")
        recovered = mc.policy_migration_apply(argparse.Namespace(
            plan=plan_path, output=receipt_path, authorize=True))
        self.assertEqual(recovered["new_head"], command("git", "rev-parse", "HEAD", cwd=root))
        self.assertFalse(Path(str(index) + ".lock").exists())
        self.assertFalse(stale.exists())
        self.assertEqual(command("git", "status", "--porcelain=v2", "--untracked-files=all", cwd=root), "")
        self.assertEqual(command("git", "rev-parse", "HEAD^", cwd=root), plan["head"])

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
