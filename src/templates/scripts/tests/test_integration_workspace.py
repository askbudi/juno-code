#!/usr/bin/env python3
"""Real-Git contracts for guarded integration-owner synchronization."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "integration_workspace.py"
sys.path.insert(0, str(SCRIPT.parent))
import integration_workspace as runtime  # noqa: E402


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


def git(root: Path, *args: str) -> str:
    return run(["git", "-C", str(root), *args], root).stdout.strip()


class IntegrationWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "repo"
        self.controller = self.root / "controller"
        self.owner = self.root / "integration"
        git(self.root, "init", "--bare", str(self.remote))
        git(self.root, "init", "-b", "product", str(self.repo))
        git(self.repo, "config", "user.email", "test@example.com")
        git(self.repo, "config", "user.name", "Test")
        (self.repo / "src").mkdir()
        (self.repo / "src/base.txt").write_text("base\n")
        git(self.repo, "add", "src/base.txt")
        git(self.repo, "commit", "-m", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "remote", "add", "origin", str(self.remote))
        git(self.repo, "push", "-u", "origin", "product")
        git(self.repo, "branch", "controller")
        git(self.repo, "worktree", "add", str(self.controller), "controller")
        git(self.repo, "switch", "--detach")
        git(self.repo, "worktree", "add", "--detach", str(self.owner), self.base)
        git(self.repo, "config", "extensions.worktreeConfig", "true")
        git(self.owner, "config", "--worktree", "juno.workspace.role", "integration-owner")
        git(self.owner, "config", "--worktree", "juno.workspace.roleAuthority", runtime.AUTHORITY)
        config = self.controller / ".juno_task/config"
        config.mkdir(parents=True)
        (config / "task-workspace.json").write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1", "repository": ".",
            "target_ref": "refs/heads/product", "workspace_root": str(self.root / "tasks"),
            "branch_prefix": "refs/heads/task-", "allowed_paths": ["src"],
            "controller_private_paths": [".juno_task/tasks"],
            "focused_validation": [{"id": "ok", "cwd": "src", "argv": ["true"],
                                    "timeout_seconds": 5, "max_output_bytes": 1024}],
            "full_suite_validation": {"id": "all", "cwd": "src", "argv": ["true"],
                                      "timeout_seconds": 5, "max_output_bytes": 1024},
        }))
        (config / "integration-workspace.json").write_text(json.dumps({
            "schema_version": runtime.POLICY_SCHEMA, "remote": "origin",
            "owner_role_authority": runtime.AUTHORITY,
            "receipt_root": ".juno_task/runtime/integration/receipts",
        }))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def remote_advance(self, text: str = "remote") -> str:
        clone = self.root / f"clone-{text}"
        git(self.root, "clone", str(self.remote), str(clone))
        git(clone, "switch", "product")
        git(clone, "config", "user.email", "test@example.com")
        git(clone, "config", "user.name", "Test")
        (clone / "src/remote.txt").write_text(text + "\n")
        git(clone, "add", "src/remote.txt")
        git(clone, "commit", "-m", text)
        git(clone, "push", "origin", "product")
        return git(clone, "rev-parse", "HEAD")

    def local_advance(self) -> str:
        worktree = self.root / "local-advance"
        git(self.repo, "worktree", "add", str(worktree), "product")
        git(worktree, "config", "user.email", "test@example.com")
        git(worktree, "config", "user.name", "Test")
        (worktree / "src/local.txt").write_text("local\n")
        git(worktree, "add", "src/local.txt")
        git(worktree, "commit", "-m", "local")
        value = git(worktree, "rev-parse", "HEAD")
        git(self.repo, "worktree", "remove", str(worktree))
        return value

    def unpublished_submodule_fixture(self) -> tuple[Path, str, str, str]:
        child_remote = self.root / "child.git"
        child_source = self.root / "child-source"
        git(self.root, "init", "--bare", str(child_remote))
        git(self.root, "init", "-b", "main", str(child_source))
        git(child_source, "config", "user.email", "test@example.com")
        git(child_source, "config", "user.name", "Test")
        (child_source / "value.txt").write_text("base\n")
        git(child_source, "add", "value.txt")
        git(child_source, "commit", "-m", "child base")
        child_base = git(child_source, "rev-parse", "HEAD")
        git(child_source, "remote", "add", "origin", str(child_remote))
        git(child_source, "push", "-u", "origin", "main")
        git(child_remote, "symbolic-ref", "HEAD", "refs/heads/main")
        (child_source / "value.txt").write_text("advanced\n")
        git(child_source, "commit", "-am", "child advance")
        child_advanced = git(child_source, "rev-parse", "HEAD")
        git(child_source, "push", "origin", "main")

        root_worktree = self.root / "add-push-submodule"
        git(self.repo, "worktree", "add", str(root_worktree), "product")
        git(root_worktree, "config", "user.email", "test@example.com")
        git(root_worktree, "config", "user.name", "Test")
        run(["git", "-c", "protocol.file.allow=always", "-C", str(root_worktree),
             "submodule", "add", str(child_remote), "vendor/child"], root_worktree)
        git(root_worktree, "commit", "-am", "add advanced child")
        root_target = git(root_worktree, "rev-parse", "HEAD")
        git(root_worktree, "switch", "--detach")
        git(self.repo, "config", "protocol.file.allow", "always")
        runtime.register(self.controller, self.owner)
        with mock.patch.dict(os.environ, {"GIT_ALLOW_PROTOCOL": "file"}, clear=False):
            synced, sync_code = runtime.sync(self.controller)
        self.assertEqual(sync_code, 0, synced)
        self.assertEqual(git(self.owner / "vendor/child", "rev-parse", "HEAD"), child_advanced)
        git(child_remote, "update-ref", "refs/heads/main", child_base, child_advanced)
        return child_remote, child_base, child_advanced, root_target

    def test_status_is_offline_and_reports_stale_owner_as_data(self) -> None:
        remote_before = runtime.sha(self.repo, "refs/remotes/origin/product")
        self.remote_advance()
        status = runtime.status_payload(self.controller)
        self.assertTrue(status["offline"])
        self.assertEqual(status["remote"]["sha"], remote_before)
        self.assertEqual(status["integration"]["status"], "unique")
        self.assertTrue(status["integration"]["owner"]["full_checkout"])

    def test_sync_fast_forwards_target_and_detached_owner_with_receipt(self) -> None:
        advanced = self.remote_advance("fast-forward")
        result, code = runtime.sync(self.controller)
        self.assertEqual(code, 0)
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(git(self.repo, "rev-parse", "product"), advanced)
        self.assertEqual(git(self.owner, "rev-parse", "HEAD"), advanced)
        self.assertNotEqual(run(["git", "-C", str(self.owner), "symbolic-ref", "-q", "HEAD"],
                                self.owner, False).returncode, 0)
        receipt = json.loads(Path(result["receipt"]["path"]).read_text())
        self.assertEqual(receipt["outcome"], "completed")
        self.assertEqual(receipt["phase"], "complete")

    def test_sync_preserves_local_ahead_target(self) -> None:
        local = self.local_advance()
        result, code = runtime.sync(self.controller)
        self.assertEqual(code, 0)
        self.assertEqual(git(self.repo, "rev-parse", "product"), local)
        target_phase = next(row for row in json.loads(
            Path(result["receipt"]["path"]).read_text())["phases"] if row["phase"] == "target")
        self.assertEqual(target_phase["outcome"], "preserved_local_ahead")

    def test_sync_refuses_divergence_and_target_holder(self) -> None:
        self.local_advance()
        self.remote_advance("diverged")
        result, code = runtime.sync(self.controller)
        self.assertEqual(code, 2)
        self.assertIn("diverged", result["error"])
        receipt = json.loads(Path(result["receipt"]["path"]).read_text())
        self.assertEqual(receipt["outcome"], "failed")

        git(self.repo, "update-ref", "refs/heads/product", self.base)
        holder = self.root / "holder"
        git(self.repo, "worktree", "add", str(holder), "product")
        blocked, blocked_code = runtime.sync(self.controller)
        self.assertEqual(blocked_code, 2)
        self.assertIn("target_checked_out", blocked["error"])

    def test_sync_initializes_exact_submodule_and_refuses_dirty_submodule(self) -> None:
        sub_remote = self.root / "sub.git"
        sub_source = self.root / "sub-source"
        git(self.root, "init", "--bare", str(sub_remote))
        git(self.root, "init", "-b", "main", str(sub_source))
        git(sub_source, "config", "user.email", "test@example.com")
        git(sub_source, "config", "user.name", "Test")
        (sub_source / "value.txt").write_text("submodule\n")
        git(sub_source, "add", "value.txt")
        git(sub_source, "commit", "-m", "submodule base")
        sub_sha = git(sub_source, "rev-parse", "HEAD")
        git(sub_source, "remote", "add", "origin", str(sub_remote))
        git(sub_source, "push", "origin", "main")
        git(sub_remote, "symbolic-ref", "HEAD", "refs/heads/main")

        worktree = self.root / "add-submodule"
        git(self.repo, "worktree", "add", str(worktree), "product")
        git(worktree, "config", "user.email", "test@example.com")
        git(worktree, "config", "user.name", "Test")
        git(worktree, "config", "protocol.file.allow", "always")
        run(["git", "-c", "protocol.file.allow=always", "-C", str(worktree), "submodule",
             "add", str(sub_remote), "vendor/sub"], worktree)
        git(worktree, "commit", "-am", "add submodule")
        product_sha = git(worktree, "rev-parse", "HEAD")
        git(worktree, "push", "origin", "product")
        git(worktree, "switch", "--detach")
        git(self.repo, "config", "protocol.file.allow", "always")

        with mock.patch.dict(os.environ, {"GIT_ALLOW_PROTOCOL": "file"}, clear=False):
            result, code = runtime.sync(self.controller)
        self.assertEqual((code, result["outcome"]), (0, "completed"), json.dumps(result))
        self.assertEqual(git(self.repo, "rev-parse", "product"), product_sha)
        self.assertEqual(git(self.owner / "vendor/sub", "rev-parse", "HEAD"), sub_sha)
        self.assertEqual(result["status"]["integration"]["owner"]["submodules"], [{
            "path": "vendor/sub", "sha": sub_sha, "state": "exact",
        }])
        (self.owner / "vendor/sub/value.txt").write_text("dirty\n")
        refused, refused_code = runtime.sync(self.controller)
        self.assertEqual(refused_code, 2)
        self.assertIn("integration_owner_dirty", refused["error"])

    def test_failed_fetch_persists_the_last_completed_phase(self) -> None:
        original = runtime.run

        def fail_fetch(argv: list[str], cwd: Path, *, check: bool = True):
            if "fetch" in argv:
                raise runtime.IntegrationError("injected fetch interruption")
            return original(argv, cwd, check=check)

        with mock.patch.object(runtime, "run", side_effect=fail_fetch):
            result, code = runtime.sync(self.controller)
        self.assertEqual(code, 2)
        receipt = json.loads(Path(result["receipt"]["path"]).read_text())
        self.assertEqual(receipt["outcome"], "failed")
        self.assertEqual(receipt["phase"], "preflight")
        self.assertIn("injected fetch interruption", receipt["error"])

    def test_explicit_registration_selects_canonical_owner_and_reports_extra(self) -> None:
        extra = self.root / "stale-extra"
        git(self.repo, "worktree", "add", "--detach", str(extra), self.base)
        git(extra, "config", "--worktree", "juno.workspace.role", "integration-owner")
        git(extra, "config", "--worktree", "juno.workspace.roleAuthority", runtime.AUTHORITY)
        ambiguous = runtime.status_payload(self.controller)
        self.assertEqual(ambiguous["integration"]["status"], "multiple")
        self.assertIn("integration_owner_multiple",
                      {item["code"] for item in ambiguous["findings"]})

        registered, code = runtime.register(self.controller, self.owner)
        self.assertEqual((code, registered["outcome"]), (0, "completed"))
        status = registered["status"]
        self.assertEqual(status["integration"]["status"], "registered")
        self.assertEqual(status["integration"]["registered_path"], str(self.owner.resolve()))
        self.assertEqual(status["integration"]["owner"]["path"], str(self.owner.resolve()))
        self.assertIn("integration_owner_extra", {item["code"] for item in status["findings"]})
        self.assertTrue(status["healthy"])

        foreign, foreign_code = runtime.register(self.controller, self.root / "not-a-worktree")
        self.assertEqual(foreign_code, 2)
        self.assertEqual(foreign["outcome"], "failed")

    def test_repair_plan_detaches_safe_target_holder_and_refreshes_stale_owner(self) -> None:
        advanced = self.local_advance()
        registered, code = runtime.register(self.controller, self.owner)
        self.assertEqual((code, registered["outcome"]), (0, "completed"))
        holder = self.root / "target-holder"
        git(self.repo, "worktree", "add", str(holder), "product")

        planned, plan_code = runtime.repair(self.controller, dry_run=True, apply=None)
        self.assertEqual((plan_code, planned["outcome"]), (0, "planned"), planned)
        self.assertEqual([row["kind"] for row in planned["actions"]],
                         ["refresh_owner", "detach_target_holder"])
        before = git(holder, "symbolic-ref", "HEAD")
        self.assertEqual(before, "refs/heads/product")

        applied, apply_code = runtime.repair(
            self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual((apply_code, applied["outcome"]), (0, "completed"), applied)
        self.assertEqual(git(self.owner, "rev-parse", "HEAD"), advanced)
        self.assertNotEqual(run(["git", "-C", str(holder), "symbolic-ref", "-q", "HEAD"],
                                holder, False).returncode, 0)

    def test_repair_refuses_plan_identity_drift(self) -> None:
        runtime.register(self.controller, self.owner)
        planned, code = runtime.repair(self.controller, dry_run=True, apply=None)
        self.assertEqual(code, 0)
        self.local_advance()
        applied, apply_code = runtime.repair(
            self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual(apply_code, 2)
        self.assertIn("identity drifted", applied["error"])

    def test_repair_clears_only_a_stale_legacy_integration_registration(self) -> None:
        runtime.register(self.controller, self.owner)
        missing = self.root / "missing-legacy-owner"
        git(self.repo, "config", runtime.LEGACY_OWNER_CONFIG, str(missing))

        planned, plan_code = runtime.repair(self.controller, dry_run=True, apply=None)
        self.assertEqual((plan_code, planned["outcome"]), (0, "planned"), planned)
        self.assertEqual(planned["actions"], [{
            "kind": "clear_legacy_integration_registration",
            "repository": str(self.controller.resolve()),
            "key": runtime.LEGACY_OWNER_CONFIG,
            "before": str(missing.resolve()),
        }])
        self.assertEqual(git(self.repo, "config", "--get", runtime.LEGACY_OWNER_CONFIG),
                         str(missing))

        applied, apply_code = runtime.repair(
            self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual((apply_code, applied["outcome"]), (0, "completed"), applied)
        self.assertNotEqual(run(["git", "-C", str(self.repo), "config", "--get",
                                 runtime.LEGACY_OWNER_CONFIG], self.repo, False).returncode, 0)

    def test_push_dry_run_is_non_mutating_and_apply_is_idempotent(self) -> None:
        advanced = self.local_advance()
        runtime.register(self.controller, self.owner)
        synced, sync_code = runtime.sync(self.controller)
        self.assertEqual(sync_code, 0, synced)
        before_refs = git(self.repo, "show-ref")
        planned, plan_code = runtime.push(self.controller, dry_run=True, apply=None)
        self.assertEqual((plan_code, planned["outcome"]), (0, "planned"), planned)
        self.assertEqual(planned["actions"], [{
            "kind": "push_root", "repository": str(self.owner.resolve()), "remote": "origin",
            "ref": "refs/heads/product", "before": self.base, "after": advanced,
        }])
        self.assertEqual(git(self.repo, "show-ref"), before_refs)
        applied, apply_code = runtime.push(
            self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual((apply_code, applied["outcome"]), (0, "completed"), applied)
        self.assertEqual(git(self.remote, "rev-parse", "refs/heads/product"), advanced)
        self.assertEqual([row["outcome"] for row in applied["phases"]], ["pushed"])

        retried, retry_code = runtime.push(
            self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual((retry_code, retried["outcome"]), (0, "completed"), retried)
        self.assertEqual([row["outcome"] for row in retried["phases"]],
                         ["already_complete"])

    def test_push_apply_refuses_remote_race_without_overwrite(self) -> None:
        local = self.local_advance()
        runtime.register(self.controller, self.owner)
        synced, code = runtime.sync(self.controller)
        self.assertEqual(code, 0, synced)
        planned, plan_code = runtime.push(self.controller, dry_run=True, apply=None)
        self.assertEqual(plan_code, 0, planned)
        remote = self.remote_advance("push-race")

        applied, apply_code = runtime.push(
            self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual((apply_code, applied["outcome"]), (2, "failed"), applied)
        self.assertIn("remote changed", applied["error"])
        self.assertEqual(git(self.remote, "rev-parse", "refs/heads/product"), remote)
        self.assertNotEqual(remote, local)

    def test_push_persists_child_success_root_failure_and_retries_safely(self) -> None:
        child_remote, child_base, child_advanced, root_target = (
            self.unpublished_submodule_fixture()
        )
        planned, plan_code = runtime.push(self.controller, dry_run=True, apply=None)
        self.assertEqual((plan_code, planned["outcome"]), (0, "planned"), planned)
        self.assertEqual([row["kind"] for row in planned["actions"]],
                         ["push_submodule", "push_root"])
        self.assertEqual(planned["actions"][0]["before"], child_base)
        self.assertEqual(planned["actions"][0]["after"], child_advanced)
        self.assertEqual(planned["actions"][1]["after"], root_target)

        original = runtime.run

        def fail_root_push(argv: list[str], cwd: Path, *, check: bool = True):
            if "push" in argv and "--recurse-submodules=check" in argv:
                raise runtime.IntegrationError("injected root publication failure")
            return original(argv, cwd, check=check)

        with mock.patch.object(runtime, "run", side_effect=fail_root_push):
            failed, failed_code = runtime.push(
                self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual((failed_code, failed["outcome"]), (2, "failed"), failed)
        self.assertIn("injected root publication failure", failed["error"])
        self.assertEqual(git(child_remote, "rev-parse", "refs/heads/main"), child_advanced)
        self.assertEqual(git(self.remote, "rev-parse", "refs/heads/product"), self.base)
        persisted = json.loads(Path(failed["receipt"]["path"]).read_text())
        self.assertEqual([row["kind"] for row in persisted["phases"]], ["push_submodule"])

        retried, retry_code = runtime.push(
            self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual((retry_code, retried["outcome"]), (0, "completed"), retried)
        self.assertEqual([row["outcome"] for row in retried["phases"]],
                         ["already_complete", "pushed"])
        self.assertEqual(git(self.remote, "rev-parse", "refs/heads/product"), root_target)


if __name__ == "__main__":
    unittest.main()
