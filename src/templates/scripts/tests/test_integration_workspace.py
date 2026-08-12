#!/usr/bin/env python3
"""Real-Git contracts for guarded integration-owner synchronization."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
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
        self.runtime_refresh_patcher = mock.patch.object(
            runtime, "managed_runtime_refresh",
            return_value={"schema_version": "juno_managed_controller_runtime.v1",
                          "outcome": "completed"},
        )
        self.runtime_inspect_patcher = mock.patch.object(
            runtime, "managed_runtime_inspect",
            return_value={"schema_version": "juno_managed_controller_runtime.v1",
                          "operation": "doctor", "healthy": True, "findings": []},
        )
        self.runtime_refresh = self.runtime_refresh_patcher.start()
        self.runtime_inspect = self.runtime_inspect_patcher.start()
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
        git(self.owner, "config", "--worktree", "juno.workspace.roleBase", self.base)
        config = self.controller / ".juno_task/config"
        config.mkdir(parents=True)
        (config / "task-workspace.json").write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1", "repository": ".",
            "target_ref": "refs/heads/product", "workspace_root": str(self.root / "tasks"),
            "branch_prefix": "refs/heads/task-", "allowed_paths": ["src"],
            "selectable_paths": [],
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
        self.runtime_refresh_patcher.stop()
        self.runtime_inspect_patcher.stop()
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
        self.assertEqual(git(self.owner, "config", "--worktree", "--get",
                             "juno.workspace.roleBase"), advanced)
        self.assertNotEqual(run(["git", "-C", str(self.owner), "symbolic-ref", "-q", "HEAD"],
                                self.owner, False).returncode, 0)
        receipt = json.loads(Path(result["receipt"]["path"]).read_text())
        self.assertEqual(receipt["outcome"], "completed")
        self.assertEqual(receipt["phase"], "complete")
        self.runtime_refresh.assert_called_once_with(
            self.controller.resolve(), self.controller.resolve(), self.base, advanced,
            task_id="integration-sync")
        managed_phase = next(row for row in receipt["phases"]
                             if row["phase"] == "managed_runtime")
        self.assertEqual(managed_phase["result"]["outcome"], "completed")

    def test_sync_preserves_local_ahead_target(self) -> None:
        local = self.local_advance()
        result, code = runtime.sync(self.controller)
        self.assertEqual(code, 0)
        self.assertEqual(git(self.repo, "rev-parse", "product"), local)
        target_phase = next(row for row in json.loads(
            Path(result["receipt"]["path"]).read_text())["phases"] if row["phase"] == "target")
        self.assertEqual(target_phase["outcome"], "preserved_local_ahead")
        self.assertEqual(git(self.owner, "rev-parse", "HEAD"), local)
        self.assertEqual(git(self.owner, "config", "--worktree", "--get",
                             "juno.workspace.roleBase"), local)
        self.assertTrue(result["status"]["ready"])
        authority_phase = next(row for row in json.loads(
            Path(result["receipt"]["path"]).read_text())["phases"]
            if row["phase"] == "authority")
        self.assertEqual(authority_phase["after"], local)

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

    def test_sync_preflights_unpublished_gitlink_before_owner_mutation_and_retries(self) -> None:
        child_remote = self.root / "closure-child.git"
        child_source = self.root / "closure-child-source"
        git(self.root, "init", "--bare", str(child_remote))
        git(self.root, "init", "-b", "main", str(child_source))
        git(child_source, "config", "user.email", "test@example.com")
        git(child_source, "config", "user.name", "Test")
        (child_source / "value.txt").write_text("base\n")
        git(child_source, "add", "value.txt")
        git(child_source, "commit", "-m", "child base")
        git(child_source, "remote", "add", "origin", str(child_remote))
        git(child_source, "push", "-u", "origin", "main")
        git(child_remote, "symbolic-ref", "HEAD", "refs/heads/main")
        (child_source / "value.txt").write_text("unpublished\n")
        git(child_source, "commit", "-am", "unpublished child")
        unpublished = git(child_source, "rev-parse", "HEAD")

        target_worktree = self.root / "unpublished-root-source"
        git(self.repo, "worktree", "add", "--detach", str(target_worktree), self.base)
        git(target_worktree, "config", "user.email", "test@example.com")
        git(target_worktree, "config", "user.name", "Test")
        run(["git", "-c", "protocol.file.allow=always", "-C", str(target_worktree),
             "submodule", "add", str(child_remote), "vendor/child"], target_worktree)
        git(target_worktree / "vendor/child", "fetch", str(child_source), unpublished)
        git(target_worktree / "vendor/child", "checkout", "--detach", unpublished)
        git(target_worktree, "add", ".gitmodules", "vendor/child")
        git(target_worktree, "commit", "-m", "root references unpublished child")
        target = git(target_worktree, "rev-parse", "HEAD")
        git(self.repo, "update-ref", "refs/heads/product", target, self.base)
        before_owner = git(self.owner, "rev-parse", "HEAD")

        with mock.patch.dict(os.environ, {"GIT_ALLOW_PROTOCOL": "file"}, clear=False):
            refused, refused_code = runtime.sync(self.controller)
        self.assertEqual((refused_code, refused["outcome"]), (2, "failed"), refused)
        self.assertIn("nested_gitlink_unavailable", refused["error"])
        self.assertIn(unpublished, refused["error"])
        self.assertEqual(git(self.owner, "rev-parse", "HEAD"), before_owner)
        self.assertEqual(git(self.owner, "status", "--porcelain"), "")
        self.assertEqual(git(self.repo, "rev-parse", "refs/heads/product"), target)
        receipt = json.loads(Path(refused["receipt"]["path"]).read_text())
        closure = next(row for row in receipt["phases"]
                       if row["phase"] == "nested_gitlink_closure")
        self.assertFalse(closure["result"]["available"])
        self.assertEqual(receipt["recovery"]["retry"], "yy integration sync")
        self.assertTrue(receipt["recovery"]["owner_unchanged"])

        # Simulate the separately authorized child integration/publication. The
        # supported retry now hydrates the owner without raw object transfer.
        git(child_source, "push", "origin", "main")
        with mock.patch.dict(os.environ, {"GIT_ALLOW_PROTOCOL": "file"}, clear=False):
            retried, retry_code = runtime.sync(self.controller)
        self.assertEqual((retry_code, retried["outcome"]), (0, "completed"), retried)
        self.assertTrue(retried["status"]["ready"])
        self.assertEqual(git(self.owner / "vendor/child", "rev-parse", "HEAD"), unpublished)
        planned, plan_code = runtime.push(self.controller, dry_run=True, apply=None)
        self.assertEqual((plan_code, planned["outcome"]), (0, "planned"), planned)
        self.assertEqual([row["kind"] for row in planned["actions"]], ["push_root"])

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
                         ["refresh_owner", "advance_role_base", "detach_target_holder"])
        before = git(holder, "symbolic-ref", "HEAD")
        self.assertEqual(before, "refs/heads/product")

        applied, apply_code = runtime.repair(
            self.controller, dry_run=False, apply=Path(planned["receipt"]["path"]))
        self.assertEqual((apply_code, applied["outcome"]), (0, "completed"), applied)
        self.assertEqual(git(self.owner, "rev-parse", "HEAD"), advanced)
        self.assertEqual(git(self.owner, "config", "--worktree", "--get",
                             "juno.workspace.roleBase"), advanced)
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


class ManagedRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "fixture with spaces"
        self.root.mkdir()
        self.repo = self.root / "repo"
        git(self.root, "init", "-b", "product", str(self.repo))
        git(self.repo, "config", "user.email", "test@example.com")
        git(self.repo, "config", "user.name", "Test")
        assets = {"schemaVersion": 1, "assets": [
            {"source": "scripts/one.py", "destination": ".juno_task/scripts/one.py",
             "installClass": "script", "type": "script"},
            {"source": "scripts/two.py", "destination": ".juno_task/scripts/two.py",
             "installClass": "script", "type": "script"},
            {"source": "config/task-workspace.json", "destination": runtime.MANAGED_POLICY_PATH,
             "installClass": "project", "type": "config"},
        ]}
        self.policy = {"schema_version": "juno_task_workspace_config.v1",
                       "repository": ".", "workspace_root": "/tmp/default",
                       "allowed_paths": ["src"]}
        self.write("juno-code/src/templates/managed-assets.json", assets)
        self.write("juno-code/package.json", {"version": "9.0.0"})
        self.write(runtime.MANAGED_POLICY_PATH, self.policy)
        self.write(".juno_task/scripts/one.py", "old one\n")
        self.write(".juno_task/scripts/two.py", "old two\n")
        self.write("juno-code/src/templates/scripts/one.py", "installed prior one\n")
        self.write("juno-code/src/templates/scripts/two.py", "old two\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-m", "old generation")
        self.previous = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "branch", "controller")
        self.controller = self.root / "controller"
        git(self.repo, "worktree", "add", str(self.controller), "controller")
        controller_policy = dict(self.policy)
        controller_policy["workspace_root"] = "/private/controller-tasks"
        (self.controller / runtime.MANAGED_POLICY_PATH).write_text(json.dumps(controller_policy) + "\n")
        git(self.controller, "commit", "-am", "controller customization")

        self.write(".juno_task/scripts/one.py", "new one\n")
        target_policy = dict(self.policy)
        target_policy["selectable_paths"] = ["frontend"]
        self.write(runtime.MANAGED_POLICY_PATH, target_policy)
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-m", "new generation")
        self.target = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write(self, relative: str, value: object) -> None:
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text((json.dumps(value) + "\n") if not isinstance(value, str) else value)

    def test_refresh_uses_exact_target_preserves_policy_customization_and_receipts_log(self) -> None:
        result = runtime.managed_runtime_refresh(self.controller, self.repo, self.previous, self.target,
                                 task_id="UOsd11")
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual((self.controller / ".juno_task/scripts/one.py").read_text(), "new one\n")
        self.assertEqual((self.controller / ".juno_task/scripts/two.py").read_text(), "old two\n")
        policy = json.loads((self.controller / runtime.MANAGED_POLICY_PATH).read_text())
        self.assertEqual(policy["workspace_root"], "/private/controller-tasks")
        self.assertEqual(policy["selectable_paths"], ["frontend"])
        self.assertEqual(result["policy"]["changed_fields"], ["selectable_paths"])
        self.assertFalse(result["timed_out"])
        log = Path(result["log"]["path"])
        self.assertTrue(log.is_file())
        self.assertEqual(runtime.managed_sha256(log.read_bytes()), result["log"]["sha256"])
        receipt = Path(result["receipt"]["path"])
        self.assertEqual(runtime.managed_sha256(receipt.read_bytes()), result["receipt"]["sha256"])
        self.assertTrue(runtime.managed_runtime_inspect(self.controller, self.repo, self.target)["healthy"])
        # A crash after the generation marker but before the outer terminal
        # checkpoint can retry the exact transition despite expected policy dirt.
        retried = runtime.managed_runtime_refresh(self.controller, self.repo, self.previous, self.target,
                                  task_id="UOsd11-retry")
        self.assertEqual(retried["outcome"], "completed")

    def test_unchanged_source_customization_is_preserved_while_changed_runtime_refreshes(self) -> None:
        customized = self.controller / ".juno_task/scripts/two.py"
        customized.write_text("owner controller registration customization\n")
        actual_hash = runtime.managed_sha256(customized.read_bytes())

        result = runtime.managed_runtime_refresh(
            self.controller, self.repo, self.previous, self.target, task_id="live-shape")

        self.assertEqual((self.controller / ".juno_task/scripts/one.py").read_text(), "new one\n")
        self.assertEqual(customized.read_text(), "owner controller registration customization\n")
        rows = {row["path"]: row for row in result["scripts"]}
        self.assertEqual(rows[".juno_task/scripts/one.py"]["classification"], "exact")
        self.assertEqual(rows[".juno_task/scripts/two.py"]["outcome"], "preserved_customization")
        self.assertEqual(rows[".juno_task/scripts/two.py"]["actual_sha256"], actual_hash)
        generation = json.loads((self.controller / runtime.MANAGED_GENERATION_PATH).read_text())
        preserved = generation["scripts"][".juno_task/scripts/two.py"]
        self.assertEqual(preserved["classification"], "preserved_customization")
        self.assertEqual(preserved["actual_sha256"], actual_hash)
        self.assertNotEqual(preserved["actual_sha256"], preserved["source_sha256"])
        doctor = runtime.managed_runtime_inspect(self.controller, self.repo, self.target)
        self.assertTrue(doctor["healthy"], doctor)
        self.assertEqual(doctor["scripts"][".juno_task/scripts/two.py"]["classification"],
                         "preserved_customization")
        # Exact-transition recovery remains idempotent and does not overwrite it.
        retried = runtime.managed_runtime_refresh(
            self.controller, self.repo, self.previous, self.target, task_id="live-shape-retry")
        self.assertEqual(retried["outcome"], "completed")
        self.assertEqual(customized.read_text(), "owner controller registration customization\n")

    def test_doctor_detects_drift_from_bound_preserved_customization(self) -> None:
        customized = self.controller / ".juno_task/scripts/two.py"
        customized.write_text("intentional owner customization\n")
        runtime.managed_runtime_refresh(
            self.controller, self.repo, self.previous, self.target, task_id="doctor-drift")
        customized.write_text("later unreviewed drift\n")

        doctor = runtime.managed_runtime_inspect(self.controller, self.repo, self.target)

        self.assertFalse(doctor["healthy"])
        finding = next(row for row in doctor["findings"]
                       if row["code"] == "managed_preserved_customization_drift")
        self.assertEqual(finding["path"], ".juno_task/scripts/two.py")
        self.assertEqual(finding["classification"], "preserved_customization")
        self.assertNotEqual(finding["expected_sha256"], finding["actual_sha256"])
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "existing managed generation drift"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, self.previous, self.target, task_id="drift-retry")
        self.assertEqual(customized.read_text(), "later unreviewed drift\n")

    def test_receipt_bound_installed_prior_template_updates_when_admitted_source_changes(self) -> None:
        installed = self.controller / ".juno_task/scripts/one.py"
        installed.write_text("installed prior one\n")
        generation = {
            "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
            "target_sha": self.previous,
            "package_version": "9.0.0",
            "scripts": {
                ".juno_task/scripts/one.py": {
                    "classification": "preserved_customization",
                    "source_sha256": runtime.managed_sha256(b"old one\n"),
                    "actual_sha256": runtime.managed_sha256(installed.read_bytes()),
                },
                ".juno_task/scripts/two.py": {
                    "classification": "exact",
                    "source_sha256": runtime.managed_sha256(b"old two\n"),
                    "actual_sha256": runtime.managed_sha256(b"old two\n"),
                },
            },
            "policy_sha256": runtime.managed_sha256(
                (self.controller / runtime.MANAGED_POLICY_PATH).read_bytes()),
        }
        generation_path = self.controller / runtime.MANAGED_GENERATION_PATH
        generation_path.parent.mkdir(parents=True, exist_ok=True)
        generation_path.write_text(json.dumps(generation) + "\n")

        result = runtime.managed_runtime_refresh(
            self.controller, self.repo, self.previous, self.target, task_id="bound-prior")

        self.assertEqual(installed.read_text(), "new one\n")
        row = next(item for item in result["scripts"] if item["path"].endswith("one.py"))
        self.assertEqual(row["outcome"], "updated")
        self.assertEqual(row["classification"], "exact")
        self.assertEqual(row["prior_generation_classification"],
                         "receipt_bound_installed_template")

    def test_obsolete_exact_generation_restored_by_bootstrap_is_reactivated(self) -> None:
        # The admitted middle generation installed "new one", but a stale
        # bootstrap later restored bytes that an older successful receipt proves
        # were the exact managed source at self.previous.
        receipt_root = self.controller / runtime.MANAGED_RECEIPT_ROOT
        receipt_root.mkdir(parents=True, exist_ok=True)
        historical = {
            "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
            "operation": "refresh",
            "outcome": "completed",
            "target_sha": self.previous,
            "scripts": [{
                "path": ".juno_task/scripts/one.py",
                "classification": "exact",
                "source_sha256": runtime.managed_sha256(b"old one\n"),
                "actual_sha256": runtime.managed_sha256(b"old one\n"),
            }],
        }
        (receipt_root / "100-old.json").write_text(json.dumps(historical) + "\n")
        git(self.repo, "commit", "--allow-empty", "-m", "unchanged next generation")
        final = git(self.repo, "rev-parse", "HEAD")
        runtime.managed_runtime_refresh(
            self.controller, self.repo, self.target, final, task_id="installed-middle")
        installed = self.controller / ".juno_task/scripts/one.py"
        installed.write_text("old one\n")

        result = runtime.managed_runtime_refresh(
            self.controller, self.repo, self.target, final, task_id="obsolete-bootstrap")

        self.assertEqual(installed.read_text(), "new one\n")
        row = next(item for item in result["scripts"] if item["path"].endswith("one.py"))
        self.assertEqual(row["outcome"], "updated")
        self.assertEqual(row["classification"], "exact")
        self.assertEqual(row["prior_generation_classification"],
                         "receipt_bound_obsolete_generation")
        self.assertEqual(row["prior_generation_target_sha"], self.previous)
        self.assertEqual(Path(row["prior_generation_receipt"]),
                         (receipt_root / "100-old.json").resolve())

    def test_failed_or_incomplete_receipts_cannot_authorize_obsolete_generation(self) -> None:
        receipt_root = self.controller / runtime.MANAGED_RECEIPT_ROOT
        receipt_root.mkdir(parents=True, exist_ok=True)
        source_hash = runtime.managed_sha256(b"old one\n")
        for outcome in ("failed", "running"):
            with self.subTest(outcome=outcome):
                receipt = receipt_root / f"{outcome}.json"
                receipt.write_text(json.dumps({
                    "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
                    "operation": "refresh", "outcome": outcome,
                    "target_sha": self.previous,
                    "scripts": [{"path": ".juno_task/scripts/one.py", "classification": "exact",
                                 "source_sha256": source_hash, "actual_sha256": source_hash}],
                }) + "\n")
                self.assertIsNone(runtime.managed_obsolete_generation_binding(
                    self.controller, self.repo, ".juno_task/scripts/one.py",
                    b"old one\n", self.target))
                receipt.unlink()

    def test_receipt_target_outside_admitted_ancestry_cannot_authorize_replacement(self) -> None:
        receipt_root = self.controller / runtime.MANAGED_RECEIPT_ROOT
        receipt_root.mkdir(parents=True, exist_ok=True)
        tree = git(self.repo, "rev-parse", f"{self.previous}^{{tree}}")
        unrelated = git(self.repo, "commit-tree", tree, "-m", "unrelated exact source")
        source_hash = runtime.managed_sha256(b"old one\n")
        (receipt_root / "unrelated.json").write_text(json.dumps({
            "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
            "operation": "refresh", "outcome": "completed", "target_sha": unrelated,
            "scripts": [{"path": ".juno_task/scripts/one.py", "classification": "exact",
                         "source_sha256": source_hash, "actual_sha256": source_hash}],
        }) + "\n")

        self.assertIsNone(runtime.managed_obsolete_generation_binding(
            self.controller, self.repo, ".juno_task/scripts/one.py",
            b"old one\n", self.target))

    def test_preserved_customization_receipt_row_can_bind_immutable_historical_source(self) -> None:
        receipt_root = self.controller / runtime.MANAGED_RECEIPT_ROOT
        receipt_root.mkdir(parents=True, exist_ok=True)
        source_hash = runtime.managed_sha256(b"old one\n")
        (receipt_root / "preserved.json").write_text(json.dumps({
            "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
            "operation": "refresh", "outcome": "completed", "target_sha": self.previous,
            "scripts": [{"path": ".juno_task/scripts/one.py",
                         "classification": "preserved_customization",
                         "source_sha256": "f" * 64, "actual_sha256": source_hash}],
        }) + "\n")

        binding = runtime.managed_obsolete_generation_binding(
            self.controller, self.repo, ".juno_task/scripts/one.py",
            b"old one\n", self.target)
        self.assertEqual(binding["classification"], "receipt_bound_historical_generation")
        self.assertEqual(binding["target_sha"], self.previous)

    def test_preserved_receipt_recognizes_historical_template_bytes(self) -> None:
        receipt_root = self.controller / runtime.MANAGED_RECEIPT_ROOT
        receipt_root.mkdir(parents=True, exist_ok=True)
        current = b"installed prior one\n"
        current_hash = runtime.managed_sha256(current)
        (receipt_root / "template-history.json").write_text(json.dumps({
            "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
            "operation": "refresh", "outcome": "completed", "target_sha": self.previous,
            "scripts": [{"path": ".juno_task/scripts/one.py",
                         "classification": "preserved_customization",
                         "source_sha256": runtime.managed_sha256(b"old one\n"),
                         "actual_sha256": current_hash}],
        }) + "\n")

        binding = runtime.managed_obsolete_generation_binding(
            self.controller, self.repo, ".juno_task/scripts/one.py", current, self.target)

        self.assertEqual(binding["classification"], "receipt_bound_historical_generation")
        self.assertEqual(binding["source_path"], "juno-code/src/templates/scripts/one.py")
        self.assertEqual(binding["target_sha"], self.previous)
        installed = self.controller / ".juno_task/scripts/one.py"
        installed.write_bytes(current)
        result = runtime.managed_runtime_refresh(
            self.controller, self.repo, self.previous, self.target, task_id="historical-supersede")
        self.assertEqual(installed.read_bytes(), b"new one\n")
        row = next(item for item in result["scripts"] if item["path"].endswith("one.py"))
        self.assertEqual(row["prior_generation_classification"],
                         "receipt_bound_historical_generation")

    def test_preserved_receipt_cannot_bind_content_that_only_appears_later(self) -> None:
        receipt_root = self.controller / runtime.MANAGED_RECEIPT_ROOT
        receipt_root.mkdir(parents=True, exist_ok=True)
        unique = b"unique operator bytes that appear later\n"
        unique_hash = runtime.managed_sha256(unique)
        (receipt_root / "before-unique.json").write_text(json.dumps({
            "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
            "operation": "refresh", "outcome": "completed", "target_sha": self.previous,
            "scripts": [{"path": ".juno_task/scripts/one.py",
                         "classification": "preserved_customization",
                         "source_sha256": runtime.managed_sha256(b"old one\n"),
                         "actual_sha256": unique_hash}],
        }) + "\n")
        self.write("juno-code/src/templates/scripts/one.py", unique.decode())
        git(self.repo, "add", "juno-code/src/templates/scripts/one.py")
        git(self.repo, "commit", "-m", "later coincidental content")
        self.write(".juno_task/scripts/one.py", "final managed one\n")
        self.write("juno-code/src/templates/scripts/one.py", "final template one\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-m", "final generation")
        final = git(self.repo, "rev-parse", "HEAD")

        binding = runtime.managed_obsolete_generation_binding(
            self.controller, self.repo, ".juno_task/scripts/one.py", unique, final)

        self.assertIsNone(binding)

    def test_overlap_repair_plan_apply_preserves_prior_bytes_and_is_retry_safe(self) -> None:
        self.write(".juno_task/scripts/one.py", "first\na\nb\nc\nlast\n")
        git(self.repo, "add", ".juno_task/scripts/one.py")
        git(self.repo, "commit", "-m", "repair base")
        previous = git(self.repo, "rev-parse", "HEAD")
        self.write(".juno_task/scripts/one.py", "first\na\nb\nc\nnew last\n")
        git(self.repo, "add", ".juno_task/scripts/one.py")
        git(self.repo, "commit", "-m", "repair target")
        target = git(self.repo, "rev-parse", "HEAD")
        customized = self.controller / ".juno_task/scripts/one.py"
        customized.write_text("owner first\na\nb\nc\nlast\n")
        prior = customized.read_bytes()

        plan = runtime.managed_runtime_repair_plan(
            self.controller, self.repo, previous, target, task_id="repair")

        self.assertEqual(plan["outcome"], "planned", plan)
        row = next(item for item in plan["actions"] if item["path"].endswith("one.py"))
        self.assertEqual(row["resolution"], "preserve")
        self.assertEqual(row["current_sha256"], runtime.managed_sha256(prior))
        self.assertIn("old-source", row["semantic_diff"]["old_to_new"])
        result = runtime.managed_runtime_refresh(
            self.controller, self.repo, previous, target, task_id="repair-apply",
            repair_receipt=Path(plan["receipt"]["path"]))
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["repair_plan"]["sha256"], plan["receipt"]["sha256"])
        self.assertIn("owner first", customized.read_text())
        backups = list((self.controller / runtime.MANAGED_BACKUP_ROOT).rglob("*.bin"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), prior)
        retried = runtime.managed_runtime_refresh(
            self.controller, self.repo, previous, target, task_id="repair-retry")
        self.assertEqual(retried["outcome"], "completed")

    def test_overlap_repair_requires_exact_current_action_set(self) -> None:
        self.write(".juno_task/scripts/one.py", "first\na\nb\nc\nlast\n")
        git(self.repo, "add", ".juno_task/scripts/one.py")
        git(self.repo, "commit", "-m", "exact set base")
        previous = git(self.repo, "rev-parse", "HEAD")
        self.write(".juno_task/scripts/one.py", "first\na\nb\nc\nnew last\n")
        git(self.repo, "add", ".juno_task/scripts/one.py")
        git(self.repo, "commit", "-m", "exact set target")
        target = git(self.repo, "rev-parse", "HEAD")
        customized = self.controller / ".juno_task/scripts/one.py"
        customized.write_text("owner first\na\nb\nc\nlast\n")
        plan = runtime.managed_runtime_repair_plan(
            self.controller, self.repo, previous, target, task_id="exact-set")
        source = json.loads(Path(plan["receipt"]["path"]).read_text())

        def mutated(actions: list[dict[str, object]]) -> Path:
            value = {**source, "actions": actions}
            data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
            path = (self.controller / runtime.MANAGED_RECEIPT_ROOT /
                    f"{runtime.managed_sha256(data)}-repair-plan.json")
            path.write_bytes(data)
            return path

        extra = dict(source["actions"][0])
        extra["path"] = ".juno_task/scripts/two.py"
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "action set mismatch"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, previous, target,
                repair_receipt=mutated([source["actions"][0], extra]))
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "action set mismatch"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, previous, target, repair_receipt=mutated([]))
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "malformed managed runtime repair action"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, previous, target,
                repair_receipt=mutated([source["actions"][0], source["actions"][0]]))
        self.assertEqual(customized.read_text(), "owner first\na\nb\nc\nlast\n")
        self.assertFalse((self.controller / runtime.MANAGED_BACKUP_ROOT).exists())

    def test_overlap_repair_conflict_stale_and_malformed_receipts_fail_closed(self) -> None:
        customized = self.controller / ".juno_task/scripts/one.py"
        customized.write_text("owner replacement\n")
        plan = runtime.managed_runtime_repair_plan(
            self.controller, self.repo, self.previous, self.target, task_id="conflict")
        self.assertEqual(plan["outcome"], "conflict")
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "malformed or mismatched"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, self.previous, self.target,
                repair_receipt=Path(plan["receipt"]["path"]))

        self.write(".juno_task/scripts/one.py", "first\na\nb\nc\nlast\n")
        git(self.repo, "add", ".juno_task/scripts/one.py")
        git(self.repo, "commit", "-m", "stale repair base")
        previous = git(self.repo, "rev-parse", "HEAD")
        self.write(".juno_task/scripts/one.py", "first\na\nb\nc\nnew last\n")
        git(self.repo, "add", ".juno_task/scripts/one.py")
        git(self.repo, "commit", "-m", "stale repair target")
        target = git(self.repo, "rev-parse", "HEAD")
        customized.write_text("owner first\na\nb\nc\nlast\n")
        valid = runtime.managed_runtime_repair_plan(
            self.controller, self.repo, previous, target, task_id="stale")
        customized.write_text("changed after approval\n")
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "stale managed runtime repair identity"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, previous, target,
                repair_receipt=Path(valid["receipt"]["path"]))
        malformed = self.controller / runtime.MANAGED_RECEIPT_ROOT / "malformed.json"
        malformed.write_text("{}\n")
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "repair receipt"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, self.previous, self.target,
                repair_receipt=malformed)
        self.assertEqual(customized.read_text(), "changed after approval\n")

    def test_obsolete_receipt_cannot_authorize_bytes_that_do_not_match_git_source(self) -> None:
        receipt_root = self.controller / runtime.MANAGED_RECEIPT_ROOT
        receipt_root.mkdir(parents=True, exist_ok=True)
        customized = self.controller / ".juno_task/scripts/one.py"
        customized.write_text("genuine owner customization\n")
        forged_hash = runtime.managed_sha256(customized.read_bytes())
        (receipt_root / "forged.json").write_text(json.dumps({
            "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
            "operation": "refresh", "outcome": "completed", "target_sha": self.previous,
            "scripts": [{"path": ".juno_task/scripts/one.py", "classification": "exact",
                         "source_sha256": forged_hash, "actual_sha256": forged_hash}],
        }) + "\n")

        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "customized managed runtime"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, self.previous, self.target, task_id="forged-history")
        self.assertEqual(customized.read_text(), "genuine owner customization\n")

    def test_receipt_binding_never_authorizes_unrelated_customization(self) -> None:
        customized = self.controller / ".juno_task/scripts/one.py"
        customized.write_text("genuine owner customization\n")
        generation_path = self.controller / runtime.MANAGED_GENERATION_PATH
        generation_path.parent.mkdir(parents=True, exist_ok=True)
        generation_path.write_text(json.dumps({
            "schema_version": runtime.MANAGED_RUNTIME_SCHEMA,
            "target_sha": self.previous,
            "scripts": {".juno_task/scripts/one.py": {
                "classification": "preserved_customization",
                "source_sha256": runtime.managed_sha256(b"old one\n"),
                "actual_sha256": runtime.managed_sha256(customized.read_bytes()),
            }},
        }) + "\n")
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "customized managed runtime"):
            runtime.managed_runtime_refresh(
                self.controller, self.repo, self.previous, self.target, task_id="genuine-custom")
        self.assertEqual(customized.read_text(), "genuine owner customization\n")

    def test_refresh_refuses_changed_source_customization_and_rolls_back(self) -> None:
        customized = self.controller / ".juno_task/scripts/one.py"
        customized.write_text("owner customization\n")
        unchanged = self.controller / ".juno_task/scripts/two.py"
        before_unchanged = unchanged.read_bytes()
        before_policy = (self.controller / runtime.MANAGED_POLICY_PATH).read_bytes()
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "customized managed runtime") as caught:
            runtime.managed_runtime_refresh(self.controller, self.repo, self.previous, self.target, task_id="custom")
        self.assertEqual(customized.read_text(), "owner customization\n")
        self.assertEqual(unchanged.read_bytes(), before_unchanged)
        self.assertEqual((self.controller / runtime.MANAGED_POLICY_PATH).read_bytes(), before_policy)
        self.assertFalse((self.controller / runtime.MANAGED_GENERATION_PATH).exists())
        self.assertIsNotNone(caught.exception.receipt)
        persisted = json.loads(Path(caught.exception.receipt["path"]).read_text())
        self.assertEqual(persisted["outcome"], "failed")
        self.assertEqual(persisted["exit_code"], 2)

    def test_log_allocation_is_unique_for_concurrent_runs_and_fails_closed(self) -> None:
        def allocate(_: int) -> str:
            path, handle = runtime.managed_allocate_log("workflow with spaces", "task id")
            handle.close()
            return str(path)

        with ThreadPoolExecutor(max_workers=4) as pool:
            paths = list(pool.map(allocate, range(8)))
        self.assertEqual(len(paths), len(set(paths)))
        self.assertTrue(all(path.startswith("/tmp/yy-workflow-with-spaces-task-id-")
                            for path in paths))
        for value in paths:
            Path(value).unlink()
        with mock.patch.object(Path, "open", side_effect=OSError("read-only log root")):
            with self.assertRaisesRegex(runtime.ManagedRuntimeError, "log allocation failed"):
                runtime.managed_allocate_log("workflow", "task")

    def test_interruption_is_terminal_and_receipted(self) -> None:
        with mock.patch.object(runtime, "managed_runtime_plan", side_effect=KeyboardInterrupt()):
            with self.assertRaises(runtime.ManagedRuntimeError) as caught:
                runtime.managed_runtime_refresh(self.controller, self.repo, self.previous, self.target,
                                task_id="interrupt")
        persisted = json.loads(Path(caught.exception.receipt["path"]).read_text())
        self.assertEqual(persisted["termination"], "interrupted")
        self.assertIsNone(persisted["signal"])
        self.assertFalse(persisted["timed_out"])

    def test_refresh_refuses_dirty_or_overlapping_tracked_policy(self) -> None:
        policy_path = self.controller / runtime.MANAGED_POLICY_PATH
        value = json.loads(policy_path.read_text())
        value["workspace_root"] = "/tmp/uncommitted"
        policy_path.write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "uncommitted dirt"):
            runtime.managed_runtime_plan(self.controller, self.repo, self.previous, self.target)
        git(self.controller, "checkout", "--", runtime.MANAGED_POLICY_PATH)
        value = json.loads(policy_path.read_text())
        value["selectable_paths"] = ["different"]
        policy_path.write_text(json.dumps(value) + "\n")
        git(self.controller, "add", runtime.MANAGED_POLICY_PATH)
        git(self.controller, "commit", "-m", "overlap")
        with self.assertRaisesRegex(runtime.ManagedRuntimeError, "overlapping manual change"):
            runtime.managed_runtime_plan(self.controller, self.repo, self.previous, self.target)


if __name__ == "__main__":
    unittest.main()
