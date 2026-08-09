#!/usr/bin/env python3
"""Executable closure for canonical sparse-controller policy and real-Git fixtures."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "controller_workspace.py"
POLICY = Path(__file__).resolve().parents[2] / "config/controller-workspace.json"
spec = importlib.util.spec_from_file_location("controller_workspace", SCRIPT)
assert spec and spec.loader
cw = importlib.util.module_from_spec(spec); spec.loader.exec_module(cw)

def run(*argv: str, cwd: Path, check: bool = True, env: dict[str, str] | None = None):
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, env=env)
    if check and result.returncode: raise AssertionError(result.stderr or result.stdout)
    return result

def git(repo: Path, *args: str, check: bool = True) -> str:
    return run("git", "-C", str(repo), *args, cwd=repo, check=check).stdout.strip()

class ControllerWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="juno-controller-workspace-"))
        self.repo = self.temp / "repo"; self.repo.mkdir()
        git(self.repo, "init", "-b", "controller")
        git(self.repo, "config", "user.email", "test@example.invalid"); git(self.repo, "config", "user.name", "Test")
        policy = json.loads(POLICY.read_text())
        policy["controller_branch"] = "refs/heads/controller"
        for relative in policy["sparse_policy"]["required_paths"]:
            path = self.repo / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(relative + "\n")
        # Ensure each ownership class has tracked evidence and product bytes can be proven absent.
        for relative in (".juno_task/tasks/T1.md", ".juno_task/ledger/T1.ndjson", ".juno_task/prompts/p.md",
                         ".juno_task/managed-assets.json", ".juno_task/managed-conflicts/2.0.31/prompt.candidate",
                         ".agents/skills/readme.md", "juno-code/package.json", "README.md",
                         "frontend/app/docs/juno-code/scripts/[slug]/page.tsx"):
            path = self.repo / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(relative + "\n")
        self.policy = self.repo / ".juno_task/config/controller-workspace.json"
        self.policy.write_text(json.dumps(policy, indent=2) + "\n")
        source_scripts = Path(__file__).resolve().parents[1]
        for name in ("controller_workspace.py", "controller_resolver.py", "task_lifecycle.py"):
            shutil.copy2(source_scripts / name, self.repo / ".juno_task/scripts" / name)
        (self.repo / ".juno_task/config.json").write_text(json.dumps({
            "controllerWorkspace": {"enabled": True, "policy": ".juno_task/config/controller-workspace.json"}
        }) + "\n")
        git(self.repo, "add", "."); git(self.repo, "commit", "-m", "fixture")
        self.head = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        shutil.rmtree(self.temp, ignore_errors=True)

    def cli(self, *args: str, check: bool = True):
        return run("python3", str(SCRIPT), "--policy", str(self.policy), *args, cwd=self.repo, check=check)

    def prepare_sparse(self) -> tuple[Path, Path]:
        sparse = self.temp / "sparse"; receipt = self.temp / "create.json"
        self.cli("create", "--repository", str(self.repo), "--path", str(sparse), "--controller-ref", "refs/heads/controller",
                 "--expected-head", self.head, "--registration-source", "fixture-registration-v1",
                 "--rollback-controller", str(self.repo), "--output", str(receipt))
        return sparse, receipt

    def test_manifest_is_four_class_strict_normalized_and_digest_bound(self):
        policy = cw.load_policy(self.policy)
        self.assertEqual(set(policy["ownership"]), {"schema_version", *cw.CLASSES})
        identities = cw.policy_identity(policy)
        self.assertEqual(identities["selected_path_count"], len(policy["sparse_policy"]["selected_paths"]))
        self.assertRegex(identities["sparse_patterns_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(cw.classify(policy, "juno-code/package.json"), "product_canonical")
        self.assertEqual(cw.classify(policy, "frontend/app/docs/[slug]/page.tsx"), "product_canonical")
        self.assertEqual(cw.classify(policy, ".juno_task/managed-assets.json"), "controller_canonical")
        self.assertEqual(cw.classify(policy, ".juno_task/managed-conflicts/2.0.31/prompt.candidate"), "controller_canonical")
        bad = json.loads(self.policy.read_text()); bad["ownership"]["product_canonical"].append(".juno_task")
        path = self.temp / "bad.json"; path.write_text(json.dumps(bad))
        with self.assertRaisesRegex(cw.WorkspaceError, "overlap"):
            cw.load_policy(path)
        for unsafe in ("../escape", ".git/config", "/absolute", "x/*"):
            with self.assertRaises(cw.WorkspaceError): cw.classify(policy, unsafe)

    def test_fresh_exact_ref_sparse_creation_has_canonical_config_and_omits_product(self):
        sparse, receipt = self.prepare_sparse(); payload = json.loads(receipt.read_text()); evidence = payload["evidence"]
        self.assertEqual(payload["expected_head"], self.head); self.assertEqual(payload["outcome"], "prepared")
        self.assertTrue(evidence["checks"]["product_absent"]); self.assertTrue(evidence["checks"]["required_present"])
        self.assertTrue(evidence["checks"]["patterns_exact"]); self.assertTrue(evidence["checks"]["sparse_index_disabled"])
        self.assertFalse((sparse / "juno-code/package.json").exists()); self.assertFalse((sparse / "README.md").exists())
        self.assertFalse((sparse / "frontend/app/docs/juno-code/scripts/[slug]/page.tsx").exists())
        self.assertTrue((sparse / ".juno_task/managed-assets.json").exists())
        self.assertTrue((sparse / ".juno_task/managed-conflicts/2.0.31/prompt.candidate").exists())
        self.assertTrue(evidence["checks"]["tracked_classified"])
        self.assertEqual(git(sparse, "config", "--worktree", "--bool", "--get", "core.sparseCheckout"), "true")
        self.assertEqual(git(sparse, "config", "--worktree", "--bool", "--get", "core.sparseCheckoutCone"), "false")
        self.assertNotEqual(git(sparse, "rev-parse", "--git-dir"), git(sparse, "rev-parse", "--git-common-dir"))

    def test_wrong_branch_detached_generation_missing_expansion_and_pattern_drift_refuse(self):
        sparse, _ = self.prepare_sparse(); policy = cw.load_policy(self.policy)
        evidence = cw.inspect(sparse, policy)
        self.assertFalse(evidence["passed"]); self.assertFalse(evidence["checks"]["named_controller_branch"])
        # Verification after cutover must require the named branch; detached is explicit refusal evidence.
        git(sparse, "config", "--worktree", "juno.controller.generation", "stale")
        (sparse / "juno-code").mkdir(); (sparse / "juno-code/manual.txt").write_text("unsafe")
        sparse_file = Path(git(sparse, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"))
        sparse_file.write_text(sparse_file.read_text() + "/README.md\n")
        evidence = cw.inspect(sparse, policy, require_branch=False)
        self.assertFalse(evidence["passed"]); self.assertFalse(evidence["checks"]["generation_current"])
        self.assertFalse(evidence["checks"]["patterns_exact"]); self.assertFalse(evidence["checks"]["clean"])
        required = sparse / policy["sparse_policy"]["required_paths"][0]; required.unlink()
        self.assertFalse(cw.inspect(sparse, policy, require_branch=False)["checks"]["required_present"])

    def test_dispatch_requires_explicit_full_admitted_role_and_release_owner(self):
        output = self.temp / "dispatch.json"
        refused = self.cli("dispatch-preflight", "--task-root", str(self.repo), "--cwd", str(self.repo), "--operation", "edit",
                           "--allow-role", "task", "--output", str(output), check=False)
        self.assertEqual(refused.returncode, 2); self.assertFalse(json.loads(output.read_text())["passed"])
        git(self.repo, "config", "extensions.worktreeConfig", "true"); git(self.repo, "config", "--worktree", "juno.workspace.role", "task")
        output.unlink(); self.cli("dispatch-preflight", "--task-root", str(self.repo), "--cwd", str(self.temp), "--operation", "build",
                                  "--allow-role", "task", "--explicit", "--output", str(output))
        self.assertTrue(json.loads(output.read_text())["passed"])
        git(self.repo, "config", "--worktree", "juno.workspace.role", "integration-owner")
        output.unlink(); self.cli("dispatch-preflight", "--task-root", str(self.repo), "--cwd", str(self.temp), "--operation", "release",
                                  "--allow-role", "integration-owner", "--require-clean", "--explicit", "--output", str(output))
        self.assertTrue(json.loads(output.read_text())["passed"])

    def test_sparse_controller_resolver_supports_orchestration_operations_after_fixture_cutover(self):
        sparse, _ = self.prepare_sparse()
        git(self.repo, "switch", "--detach")
        git(sparse, "switch", "controller")
        git(sparse, "config", "--local", "juno.controller.path", str(sparse))
        git(sparse, "config", "--local", "juno.controller.branch", "controller")
        resolver = Path(__file__).resolve().parents[1] / "controller_resolver.py"
        clean_env = {key: value for key, value in os.environ.items()
                     if key not in {"JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT"}}
        for operation in ("diagnostic", "kanban", "orchestration", "session-write"):
            result = run("python3", str(resolver), "--cwd", str(sparse), "--operation", operation,
                         "--format", "json", cwd=sparse, env=clean_env)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["valid"]); self.assertEqual(payload["role"], "controller")
            self.assertTrue(payload["controller_workspace"]["passed"])
        self.assertFalse((sparse / "juno-code").exists())

    def test_built_public_lifecycle_status_runs_from_sparse_controller(self):
        sparse, _ = self.prepare_sparse(); git(self.repo, "switch", "--detach"); git(sparse, "switch", "controller")
        git(sparse, "config", "--local", "juno.controller.path", str(sparse)); git(sparse, "config", "--local", "juno.controller.branch", "controller")
        cli = Path(__file__).resolve().parents[3] / "juno-code/dist/bin/cli.mjs"
        self.assertTrue(cli.is_file(), "build the public CLI before dogfood")
        clean_env = {key: value for key, value in os.environ.items()
                     if key not in {"JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT"}}
        result = run("node", str(cli), "lifecycle", "status", "--task", "SPARSE_DOGFOOD", cwd=sparse, env=clean_env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout + "\nSTATUS=" + git(sparse, "status", "--porcelain=v2", "--untracked-files=all"))
        self.assertIn('"phase": "NOT_STARTED"', result.stdout)

    def test_sparse_checkpoint_rejects_materialized_staged_and_no_verify_product_bytes(self):
        sparse, _ = self.prepare_sparse(); git(self.repo, "switch", "--detach"); git(sparse, "switch", "controller")
        checkpoint = Path(__file__).resolve().parents[1] / "controller_checkpoint.py"
        clean_env = {key: value for key, value in os.environ.items()
                     if key not in {"JUNO_TASK_ROOT", "JUNO_CONTROLLER_BRANCH", "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT"}}
        product = sparse / "juno-code/package.json"
        git(sparse, "update-index", "--no-skip-worktree", "juno-code/package.json")
        product.parent.mkdir(parents=True, exist_ok=True); product.write_text("unsafe\n")
        git(sparse, "add", "--sparse", "juno-code/package.json")
        staged = run("python3", str(checkpoint), "--root", str(sparse), "staged-check", cwd=sparse,
                     check=False, env=clean_env)
        self.assertEqual(staged.returncode, 2); self.assertIn("product", staged.stderr)
        git(sparse, "commit", "--no-verify", "-m", "managed bypass")
        bypass = run("python3", str(checkpoint), "--root", str(sparse), "committed-check", "--base", self.head,
                     cwd=sparse, check=False, env=clean_env)
        self.assertEqual(bypass.returncode, 2)
        self.assertRegex(bypass.stderr, "product_absent|product_path")

    def test_cutover_and_rollback_plans_preserve_refs_and_never_mutate(self):
        sparse, _ = self.prepare_sparse(); product = self.head
        before = git(self.repo, "show-ref")
        cut = self.temp / "cut.json"
        self.cli("cutover-plan", "--old-controller", str(self.repo), "--new-controller", str(sparse), "--expected-head", self.head,
                 "--product-ref", "refs/heads/controller", "--expected-product-head", product, "--output", str(cut))
        roll = self.temp / "rollback.json"
        self.cli("rollback-plan", "--old-controller", str(self.repo), "--new-controller", str(sparse), "--expected-head", self.head,
                 "--product-ref", "refs/heads/controller", "--expected-product-head", product, "--output", str(roll))
        self.assertEqual(git(self.repo, "show-ref"), before)
        self.assertEqual(json.loads(cut.read_text())["outcome"], "planned_no_mutation")
        self.assertTrue(json.loads(roll.read_text())["preserves_history"])

if __name__ == "__main__": unittest.main(verbosity=2)
