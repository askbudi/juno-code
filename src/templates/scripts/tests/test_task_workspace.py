#!/usr/bin/env python3
"""Real-Git contract tests for the small Bolt task-worktree interface."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

SCRIPT = Path(__file__).resolve().parents[1] / "task_workspace.py"
sys.path.insert(0, str(SCRIPT.parent))
import task_workspace as task_runtime  # noqa: E402


RUNTIME_TEMPLATE_PARITY = (
    (".juno_task/scripts/workflow_runner.sh", "juno-code/src/templates/scripts/workflow_runner.sh"),
    (".juno_task/scripts/risk_policy.py", "juno-code/src/templates/scripts/risk_policy.py"),
    (".juno_task/scripts/controller_registration.py", "juno-code/src/templates/scripts/controller_registration.py"),
    (".juno_task/scripts/metadata_controller.py", "juno-code/src/templates/scripts/metadata_controller.py"),
    (".juno_task/scripts/tests/test_controller_registration.py", "juno-code/src/templates/scripts/tests/test_controller_registration.py"),
    (".juno_task/scripts/tests/test_metadata_controller.py", "juno-code/src/templates/scripts/tests/test_metadata_controller.py"),
)


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
        (self.repository / "optional").mkdir()
        (self.repository / "optional/base.txt").write_text("optional\n")
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.parent.mkdir(parents=True)
        runtime.write_bytes(SCRIPT.read_bytes())
        generated_declaration = self.repository / task_runtime.GENERATED_OUTPUT_DECLARATION
        generated_declaration.parent.mkdir(parents=True)
        generated_declaration.write_text(json.dumps({
            "schema_version": task_runtime.GENERATED_OUTPUT_SCHEMA,
            "source": "juno-code/unadmitted-canonical.txt",
            "destinations": [".agents/unadmitted-output.txt"],
        }) + "\n")
        managed_declaration = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        managed_declaration.parent.mkdir(parents=True)
        managed_declaration.write_text(json.dumps({
            "schemaVersion": 1, "admissionOutputs": [], "assets": [],
        }) + "\n")
        unadmitted_source = self.repository / "juno-code/unadmitted-canonical.txt"
        unadmitted_output = self.repository / ".agents/unadmitted-output.txt"
        unadmitted_source.parent.mkdir(parents=True, exist_ok=True)
        unadmitted_output.parent.mkdir(parents=True, exist_ok=True)
        unadmitted_source.write_text("unadmitted base\n")
        unadmitted_output.write_text("unadmitted base\n")
        git(self.repository, "add", "src/base.txt", "optional/base.txt", task_runtime.RUNTIME_PATH,
            task_runtime.GENERATED_OUTPUT_DECLARATION, task_runtime.MANAGED_OUTPUT_DECLARATION,
            "juno-code/unadmitted-canonical.txt", ".agents/unadmitted-output.txt")
        git(self.repository, "commit", "-m", "product base")
        self.base = git(self.repository, "rev-parse", "HEAD")
        git(self.repository, "branch", "controller")
        run(["git", "-C", str(self.repository), "worktree", "add", str(self.controller), "controller"], self.repository)
        # The controller branch is metadata-only and unrelated product paths are removed.
        git(self.controller, "rm", "-r", "src", "optional")
        self.write_policy()
        for task_id in ("X", "Y", "Z"):
            task = self.controller / ".juno_task/tasks" / task_id[:2].lower() / f"{task_id}.md"
            task.parent.mkdir(parents=True, exist_ok=True)
            task.write_text(f"---\nid: {task_id}\nstatus: todo\n---\n")
        git(self.controller, "add", ".")
        git(self.controller, "commit", "-m", "metadata controller")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_policy(self, *, validation_ok: bool = True, validation_code: Optional[str] = None,
                     timeout_seconds: int = 5, max_output_bytes: int = 1024,
                     extra_args: Optional[list[str]] = None) -> None:
        config = self.controller / ".juno_task/config/task-workspace.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        code = validation_code or ("import sys; sys.exit(0)" if validation_ok else "import sys; sys.exit(7)")
        config.write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1",
            "repository": ".",
            "target_ref": "refs/heads/product",
            "workspace_root": str(self.workspaces),
            "branch_prefix": "refs/heads/task-",
            "allowed_paths": ["src"],
            "selectable_paths": ["optional"],
            "controller_private_paths": [".juno_task/tasks", ".juno_task/state", ".juno_task/specs", ".juno_task/ledger"],
            "focused_validation": [{"id": "focused", "cwd": "src",
                                    "timeout_seconds": timeout_seconds, "max_output_bytes": max_output_bytes,
                                    "argv": [sys.executable, "-c", code, *(extra_args or [])]}],
            "full_suite_validation": {"id": "full-suite", "cwd": "src",
                                       "timeout_seconds": 10, "max_output_bytes": 4096,
                                       "argv": [sys.executable, "-c", "pass"]},
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

    def install_declared_output_fixtures(self, *, omit: Optional[str] = None) -> dict[str, list[str] | str]:
        generated_source = "juno-code/canonical/implement.md"
        generated_destinations = [
            "juno-code/generated/implement.md",
            ".agents/skills/ralph-loop/references/implement.md",
            ".claude/skills/ralph-loop/references/implement.md",
            ".pi/skills/ralph-loop/references/implement.md",
        ]
        managed = {
            "juno-code/src/templates/scripts/migration_inventory.py":
                ".juno_task/scripts/migration_inventory.py",
            "juno-code/src/templates/scripts/controller_workspace.py":
                ".juno_task/scripts/controller_workspace.py",
        }
        declaration = self.repository / task_runtime.GENERATED_OUTPUT_DECLARATION
        declaration.write_text(json.dumps({
            "schema_version": task_runtime.GENERATED_OUTPUT_SCHEMA,
            "source": generated_source, "destinations": generated_destinations,
        }) + "\n")
        manifest = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        manifest.write_text(json.dumps({
            "schemaVersion": 1,
            "assets": [{"source": "scripts/migration_inventory.py", "destination": managed[
                "juno-code/src/templates/scripts/migration_inventory.py"]}],
            "admissionOutputs": [{"source": "scripts/controller_workspace.py", "destination": managed[
                "juno-code/src/templates/scripts/controller_workspace.py"]}],
        }) + "\n")
        files = [generated_source, *generated_destinations, *managed.keys(), *managed.values()]
        for relative in files:
            if relative == omit:
                continue
            target = self.repository / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("contract base\n")
        git(self.repository, "add", ".")
        git(self.repository, "commit", "-m", "declare generated output fixtures")
        self.base = git(self.repository, "rev-parse", "HEAD")
        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        policy = json.loads(policy_path.read_text())
        policy["allowed_paths"].append("juno-code")
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")
        return {"source": generated_source, "destinations": generated_destinations,
                "managed_sources": list(managed), "managed_destinations": list(managed.values())}

    def test_declared_generator_and_managed_outputs_are_hash_bound_and_queue_at_byte_parity(self) -> None:
        fixtures = self.install_declared_output_fixtures()
        started = self.payload("start", "X")
        admission = started["creation_receipt"]["generated_output_admission"]
        exact_outputs = [*fixtures["destinations"], *fixtures["managed_destinations"]]
        admitted = started["creation_receipt"]["allowed_paths"]
        self.assertTrue(all(task_runtime.path_within(path, admitted) for path in exact_outputs))
        self.assertTrue(all(path in admitted for path in exact_outputs if path.startswith(".")))
        self.assertTrue(all(len(row["base_source_sha256"]) == 64 for row in admission["bindings"]))
        worktree = self.workspaces / "X"
        changed = [fixtures["source"], *fixtures["destinations"],
                   *fixtures["managed_sources"], *fixtures["managed_destinations"]]
        for relative in changed:
            (worktree / relative).write_text("contract updated\n")
        git(worktree, "add", *changed)
        git(worktree, "commit", "-m", "update declared outputs at parity")
        queued = self.payload("finish", "X")
        self.assertEqual(queued["state"], "QUEUED")
        self.assertEqual(queued["changed_paths"], sorted(changed))

    def test_changed_canonical_source_without_generated_outputs_refuses_finish(self) -> None:
        fixtures = self.install_declared_output_fixtures()
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        source = fixtures["source"]
        (worktree / source).write_text("canonical changed without generation\n")
        git(worktree, "add", source)
        git(worktree, "commit", "-m", "omit generated outputs")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("generated-output byte parity failed", failed.stderr)
        self.assertIn(".agents/skills/ralph-loop/references/implement.md", failed.stderr)

    def test_declared_output_omission_is_caught_at_start_with_exact_path(self) -> None:
        missing = ".pi/skills/ralph-loop/references/implement.md"
        self.install_declared_output_fixtures(omit=missing)
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("declared generated outputs are missing at task start", failed.stderr)
        self.assertIn(missing, failed.stderr)
        self.assertFalse((self.workspaces / "X").exists())

    def test_unrelated_dot_directory_change_is_not_admitted_by_declared_outputs(self) -> None:
        self.install_declared_output_fixtures()
        self.payload("start", "X")
        self.commit_task("X", ".agents/skills/unrelated/SKILL.md")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("disallowed paths: .agents/skills/unrelated/SKILL.md", failed.stderr)

    def test_unchanged_generated_contracts_do_not_expand_finish_requirements(self) -> None:
        self.install_declared_output_fixtures()
        self.payload("start", "X")
        self.commit_task("X")
        queued = self.payload("finish", "X")
        self.assertEqual(queued["changed_paths"], ["src/feature.txt"])

    def test_concurrent_tasks_share_frozen_base_without_controller_data(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.payload, "start", task_id) for task_id in ("X", "Y")]
            x, y = [future.result() for future in futures]
        self.assertEqual(x["base_sha"], self.base)
        self.assertEqual(y["base_sha"], self.base)
        self.assertNotEqual(x["branch_ref"], y["branch_ref"])
        self.assertNotEqual(x["worktree"], y["worktree"])
        for task_id in ("X", "Y"):
            worktree = self.workspaces / task_id
            self.assertTrue((worktree / task_runtime.RUNTIME_PATH).is_file())
            self.assertFalse((worktree / ".juno_task/tasks").exists())
            self.assertEqual(git(worktree, "config", "--worktree", "--get", "juno.workspace.role"), "task")
            self.assertEqual(git(worktree, "config", "--worktree", "--get", "juno.workspace.roleBase"), self.base)
            self.assertEqual(git(worktree, "config", "--worktree", "--get", "juno.workspace.taskId"), task_id)
            for key in ("manifestIdentity", "createReceiptSha256", "expectedPathsSha256",
                        "materializationSha256"):
                self.assertRegex(git(worktree, "config", "--worktree", "--get", f"juno.workspace.{key}"), r"^[0-9a-f]{64}$")
            status = self.payload("status", task_id)
            self.assertEqual(status["routing"], {
                "invocation_root": str(self.controller.resolve()), "invocation_role": "controller",
                "effective_root": str(self.controller.resolve()),
            })
            receipt_bytes = json.dumps(status["creation_receipt"], sort_keys=True,
                                       separators=(",", ":")).encode()
            self.assertEqual(hashlib.sha256(receipt_bytes).hexdigest(),
                             status["workspace_identity"]["create_receipt_sha256"])
            self.assertEqual(status["creation_receipt"]["materialization"], {
                "mode": "full", "sparse_checkout": False,
                "materialized_allowed_paths": ["src"],
            })

    def test_sparse_controller_starts_a_full_task_checkout(self) -> None:
        git(self.repository, "config", "extensions.worktreeConfig", "true")
        git(self.controller, "sparse-checkout", "init", "--no-cone")
        git(self.controller, "sparse-checkout", "set", "--no-cone", "/.juno_task/")
        self.assertEqual(git(self.controller, "config", "--worktree", "--bool", "--get",
                             "core.sparseCheckout"), "true")

        started = self.payload("start", "X")
        worktree = self.workspaces / "X"
        self.assertEqual(started["base_sha"], self.base)
        self.assertTrue((worktree / "src/base.txt").is_file())
        self.assertNotEqual(git(worktree, "config", "--worktree", "--bool", "--get",
                                "core.sparseCheckout"), "true")
        self.assertFalse(any(line.startswith("S ")
                             for line in git(worktree, "ls-files", "-t").splitlines()))
        self.assertEqual(git(worktree, "status", "--porcelain=v1", "--untracked-files=all"), "")
        self.assertEqual(started["creation_receipt"]["materialization"]["mode"], "full")

    def test_start_freezes_explicit_policy_admitted_paths(self) -> None:
        started = task_runtime.start(self.controller, "X", ["optional"])
        self.assertEqual(started["creation_receipt"]["requested_paths"], ["optional"])
        self.assertEqual(started["creation_receipt"]["allowed_paths"], ["src", "optional"])
        self.assertEqual(started["creation_receipt"]["selected_entries"]["optional"]["type"], "tree")
        self.assertTrue((self.workspaces / "X" / "optional/base.txt").is_file())
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "differ from the frozen"):
            task_runtime.start(self.controller, "X", [])

    def test_exact_runtime_parity_paths_queue_with_their_package_templates(self) -> None:
        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        policy = json.loads(policy_path.read_text())
        runtime_paths = [runtime for runtime, _ in RUNTIME_TEMPLATE_PARITY]
        policy["allowed_paths"].extend([*runtime_paths, "juno-code"])
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")

        for runtime, template in RUNTIME_TEMPLATE_PARITY:
            for relative in (runtime, template):
                target = self.repository / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(f"base {relative}\n")
        git(self.repository, "add", ".juno_task/scripts", "juno-code")
        git(self.repository, "commit", "-m", "add guarded parity fixtures")
        self.base = git(self.repository, "rev-parse", "HEAD")

        started = self.payload("start", "X")
        self.assertNotIn(".juno_task/scripts", started["creation_receipt"]["allowed_paths"])
        self.assertTrue(set(runtime_paths).issubset(started["creation_receipt"]["allowed_paths"]))
        worktree = self.workspaces / "X"
        changed = []
        for runtime, template in RUNTIME_TEMPLATE_PARITY:
            for relative in (runtime, template):
                (worktree / relative).write_text(f"paired update {relative}\n")
                changed.append(relative)
        git(worktree, "add", *changed)
        git(worktree, "commit", "-m", "update runtime template parity")

        queued = self.payload("finish", "X")
        self.assertEqual(queued["state"], "QUEUED")
        self.assertEqual(queued["changed_paths"], sorted(changed))

    def test_unadmitted_required_path_refuses_before_creation(self) -> None:
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "not admitted by policy"):
            task_runtime.start(self.controller, "X", ["unknown"])
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])

    def test_selected_gitlink_is_initialized_at_the_exact_target_object(self) -> None:
        child = self.root / "child"
        child.mkdir()
        git(child, "init", "-b", "main")
        git(child, "config", "user.email", "test@example.com")
        git(child, "config", "user.name", "Test")
        (child / "child.txt").write_text("child\n")
        git(child, "add", "child.txt")
        git(child, "commit", "-m", "child base")
        child_sha = git(child, "rev-parse", "HEAD")
        run(["git", "-c", "protocol.file.allow=always", "-C", str(self.repository),
             "submodule", "add", str(child), "nested"], self.repository)
        git(self.repository, "commit", "-am", "add nested product root")
        self.base = git(self.repository, "rev-parse", "HEAD")
        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        policy = json.loads(policy_path.read_text())
        policy["selectable_paths"].append("nested")
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")

        with mock.patch.dict(os.environ, {"GIT_ALLOW_PROTOCOL": "file"}, clear=False):
            started = task_runtime.start(self.controller, "X", ["nested"])
        nested = self.workspaces / "X" / "nested"
        self.assertEqual(git(nested, "rev-parse", "HEAD"), child_sha)
        self.assertEqual(started["creation_receipt"]["selected_entries"]["nested"], {
            "mode": "160000", "type": "commit", "object": child_sha,
        })

    def test_unavailable_selected_gitlink_leaves_no_task_artifacts(self) -> None:
        child = self.root / "child-missing"
        child.mkdir()
        git(child, "init", "-b", "main")
        git(child, "config", "user.email", "test@example.com")
        git(child, "config", "user.name", "Test")
        (child / "child.txt").write_text("child\n")
        git(child, "add", "child.txt")
        git(child, "commit", "-m", "child base")
        run(["git", "-c", "protocol.file.allow=always", "-C", str(self.repository),
             "submodule", "add", str(child), "missing-nested"], self.repository)
        unavailable = "f" * 40
        run(["git", "-C", str(self.repository), "update-index", "--cacheinfo",
             f"160000,{unavailable},missing-nested"], self.repository)
        git(self.repository, "commit", "-m", "record unavailable nested object")
        self.base = git(self.repository, "rev-parse", "HEAD")
        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        policy = json.loads(policy_path.read_text())
        policy["selectable_paths"].append("missing-nested")
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")

        with mock.patch.dict(os.environ, {"GIT_ALLOW_PROTOCOL": "file"}, clear=False):
            with self.assertRaises(task_runtime.TaskWorkspaceError):
                task_runtime.start(self.controller, "X", ["missing-nested"])
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])

    def test_stale_runtime_refuses_before_creating_branch_worktree_or_state(self) -> None:
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.write_text(runtime.read_text() + "\n# newer target generation\n")
        git(self.repository, "add", task_runtime.RUNTIME_PATH)
        git(self.repository, "commit", "-m", "new runtime generation")

        refused = self.command("start", "X", check=False)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("managed task runtime is stale", refused.stderr)
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])
        status = self.payload("status", "X")
        self.assertFalse(status["runtime_generation"]["current"])

    def test_sparse_disable_and_materialization_failures_leave_no_partial_workspace(self) -> None:
        original_run = task_runtime.run

        def fail_sparse_disable(argv: list[str], cwd: Path, *, check: bool = True):
            if argv[-2:] == ["sparse-checkout", "disable"]:
                raise task_runtime.TaskWorkspaceError("injected sparse disable failure")
            return original_run(argv, cwd, check=check)

        with mock.patch.object(task_runtime, "run", side_effect=fail_sparse_disable):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "injected sparse"):
                task_runtime.start(self.controller, "X")
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)

        with mock.patch.object(task_runtime, "require_full_task_materialization",
                               side_effect=task_runtime.TaskWorkspaceError("injected proof failure")):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "injected proof"):
                task_runtime.start(self.controller, "X")
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])

    def test_routing_audit_rejects_a_forwarded_identity_for_another_controller(self) -> None:
        with mock.patch.dict(os.environ, {
            "JUNO_CONTROL_INVOCATION_ROOT": "/outer/integration",
            "JUNO_CONTROL_INVOCATION_ROLE": "integration-owner",
            "JUNO_CONTROL_EFFECTIVE_ROOT": "/outer/controller",
            "JUNO_CONTROL_OPERATION": "kanban",
        }, clear=False):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "effective root mismatched"):
                task_runtime.routing_identity(self.controller)

    def test_control_audit_persists_validated_task_worktree_identity(self) -> None:
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        with mock.patch.dict(os.environ, {
            "JUNO_CONTROL_INVOCATION_ROOT": str(worktree),
            "JUNO_CONTROL_INVOCATION_ROLE": "task",
            "JUNO_CONTROL_EFFECTIVE_ROOT": str(self.controller),
            "JUNO_CONTROL_OPERATION": "kanban",
        }, clear=False):
            reference = task_runtime.record_control_audit(
                self.controller, "task", "status", "X")
        path = Path(reference["path"])
        data = path.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), reference["sha256"])
        receipt = json.loads(data)
        self.assertEqual((receipt["surface"], receipt["operation"], receipt["task_id"]),
                         ("task", "status", "X"))
        self.assertEqual(receipt["routing"], {
            "invocation_root": str(worktree.resolve()), "invocation_role": "task",
            "effective_root": str(self.controller.resolve()),
        })

    def test_task_mutations_preserve_atomic_queue_sections(self) -> None:
        self.payload("start", "X")
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        state["queues"]["fixture-target"] = {"last_attempt": {"task_id": "Q"}, "conflicts": {}}
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        self.payload("start", "Y")
        after = json.loads(state_path.read_text())
        self.assertEqual(after["queues"], state["queues"])
        self.assertEqual(set(after["tasks"]), {"X", "Y"})

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
        self.write_policy(validation_code="import sys; print('failure-out'); print('failure-err', file=sys.stderr); sys.exit(7)")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("focused validation failed", failed.stderr)
        status = self.payload("status", "X")
        self.assertEqual(status["state"], "WORKING")
        self.assertEqual(status["last_validation_outcome"], "FAILED")
        self.assertEqual(status["validation"][0]["exit_code"], 7)
        self.assertIn("failure-out", status["validation"][0]["stdout_tail"])
        self.assertIn("failure-err", status["validation"][0]["stderr_tail"])
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

    def test_empty_commit_is_not_a_finished_feature(self) -> None:
        self.payload("start", "X")
        git(self.workspaces / "X", "commit", "--allow-empty", "-m", "empty")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("no product diff", failed.stderr)
        self.assertEqual(self.payload("status", "X")["state"], "WORKING")

    def test_timeout_closes_stdin_and_persists_bounded_truncated_evidence(self) -> None:
        self.payload("start", "X")
        self.commit_task("X")
        code = ("import sys,time; assert sys.stdin.buffer.read() == b''; "
                "print('A'*5000,flush=True); print('B'*5000,file=sys.stderr,flush=True); time.sleep(5)")
        self.write_policy(validation_code=code, timeout_seconds=1, max_output_bytes=1024)
        started = time.monotonic()
        failed = self.command("finish", "X", False)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("timed out", failed.stderr)
        evidence = self.payload("status", "X")["validation"][0]
        self.assertTrue(evidence["timed_out"])
        self.assertGreater(evidence["stdout_truncated_bytes"], 0)
        self.assertGreater(evidence["stderr_truncated_bytes"], 0)
        self.assertLessEqual(len(evidence["stdout_tail"].encode()), 1024)
        self.assertLessEqual(len(evidence["stderr_tail"].encode()), 1024)
        self.assertTrue(evidence["log_path"].startswith("/tmp/yy-validation-"))
        self.assertEqual(hashlib.sha256(Path(evidence["log_path"]).read_bytes()).hexdigest(),
                         evidence["log_sha256"])

    def test_validation_can_stream_both_child_channels_without_losing_evidence(self) -> None:
        row = {
            "id": "observable",
            "argv": [sys.executable, "-c", "import sys; print('live-out'); print('live-err', file=sys.stderr)"],
            "timeout_seconds": 5,
            "max_output_bytes": 1024,
        }
        streamed = io.StringIO()
        with mock.patch.dict(os.environ, {"JUNO_VALIDATION_STREAM": "1"}), contextlib.redirect_stderr(streamed):
            evidence = task_runtime.run_validation(row, self.repository)

        self.assertEqual(evidence["exit_code"], 0)
        self.assertIn("live-out", evidence["stdout_tail"])
        self.assertIn("live-err", evidence["stderr_tail"])
        self.assertIn("live-out", streamed.getvalue())
        self.assertIn("live-err", streamed.getvalue())
        log = Path(evidence["log_path"])
        self.assertIn(b"live-out", log.read_bytes())
        self.assertIn(b"live-err", log.read_bytes())
        self.assertIn("timed_out=false", streamed.getvalue())

    def test_log_allocation_is_unique_sanitized_and_fails_closed(self) -> None:
        with ThreadPoolExecutor(max_workers=4) as pool:
            allocated = list(pool.map(
                lambda _: task_runtime.allocate_long_run_log("flow with spaces", "task path"),
                range(4),
            ))
        paths = [path for path, _ in allocated]
        for _, handle in allocated: handle.close()
        self.assertEqual(len(set(paths)), 4)
        self.assertTrue(all(str(path).startswith("/tmp/yy-flow-with-spaces-task-path-") for path in paths))
        with mock.patch.object(task_runtime.os, "open", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "cannot allocate long-run log"):
                task_runtime.allocate_long_run_log("validation", "failure")

        failed_path = self.root / "log write failure.log"
        failed_path.write_bytes(b"")
        class BrokenLog:
            def write(self, _data): raise OSError("disk full")
            def close(self): pass
        row = {"id": "write-failure", "argv": [sys.executable, "-c", "print('payload', flush=True)"],
               "timeout_seconds": 5, "max_output_bytes": 1024}
        with mock.patch.object(task_runtime, "allocate_long_run_log",
                               return_value=(failed_path, BrokenLog())):
            evidence = task_runtime.run_validation(row, self.repository)
        self.assertTrue(evidence["log_write_failed"])
        self.assertIn("disk full", evidence["log_write_error"])
        self.assertNotEqual(evidence["exit_code"], 0)

    def test_duplicate_finish_validates_once_but_different_tasks_finish_concurrently(self) -> None:
        counter = self.root / "validation-counter.txt"
        code = f"from pathlib import Path; import time; time.sleep(.8); p=Path({str(counter)!r}); p.open('a').write('run\\n')"
        self.write_policy(validation_code=code, timeout_seconds=5)
        self.payload("start", "X")
        self.payload("start", "Y")
        self.commit_task("X")
        self.commit_task("Y")
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=2) as pool:
            x, y = [future.result() for future in
                    [pool.submit(self.payload, "finish", task_id) for task_id in ("X", "Y")]]
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual({x["outcome"], y["outcome"]}, {"queued"})
        self.assertEqual(counter.read_text().splitlines(), ["run", "run"])

        # A fresh task receives two simultaneous finish requests. Its task lease
        # runs validation once and the follower reuses the durable queued result.
        self.payload("start", "Z")
        self.commit_task("Z")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [future.result() for future in
                       [pool.submit(self.payload, "finish", "Z") for _ in range(2)]]
        self.assertEqual({item["outcome"] for item in results}, {"queued", "already_queued"})
        self.assertEqual(counter.read_text().splitlines(), ["run", "run", "run"])

    def test_validation_argv_is_not_a_shell_and_policy_bounds_refuse(self) -> None:
        marker = self.root / "injected"
        self.write_policy(validation_code="import sys; assert sys.argv[1].startswith(';')",
                          extra_args=[f"; touch {marker}"])
        self.payload("start", "X")
        self.commit_task("X")
        self.assertEqual(self.payload("finish", "X")["outcome"], "queued")
        self.assertFalse(marker.exists())
        self.write_policy(timeout_seconds=0)
        failed = self.command("status", "Y", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("timeout_seconds", failed.stderr)

    def test_validation_drops_forwarded_control_audit_environment(self) -> None:
        row = {
            "id": "audit-isolation",
            "cwd": ".",
            "timeout_seconds": 5,
            "max_output_bytes": 4096,
            "argv": [sys.executable, "-c", (
                "import os; assert not any(key.startswith('JUNO_CONTROL_') "
                "for key in os.environ)"
            )],
        }
        with mock.patch.dict(os.environ, {
            "JUNO_CONTROL_INVOCATION_ROOT": str(self.repository),
            "JUNO_CONTROL_INVOCATION_ROLE": "task",
            "JUNO_CONTROL_EFFECTIVE_ROOT": str(self.controller),
            "JUNO_CONTROL_OPERATION": "orchestration",
        }):
            evidence = task_runtime.run_validation(row, self.repository)
        self.assertEqual(evidence["exit_code"], 0, evidence)
        self.assertFalse(evidence["timed_out"])

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

    def test_forbidden_tree_check_is_targeted_and_error_is_bounded(self) -> None:
        private = self.repository / ".juno_task/tasks/xx"
        private.mkdir(parents=True)
        for index in range(250):
            (private / f"task-{index:04d}-{'x' * 80}.md").write_text("controller data\n")
        git(self.repository, "add", ".juno_task/tasks")
        git(self.repository, "commit", "-m", "large forbidden tree")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn(".juno_task/tasks", failed.stderr)
        self.assertLess(len(failed.stderr), 1000)

    def test_status_reports_unavailable_target_without_calling_it_unmoved(self) -> None:
        self.payload("start", "X")
        git(self.repository, "checkout", "--detach", self.base)
        git(self.repository, "branch", "-D", "product")
        status = self.payload("status", "X")
        self.assertFalse(status["target_available"])
        self.assertIsNone(status["target_moved"])
        self.assertIsNone(status["current_target_sha"])
        self.assertEqual(status["target_error"], "target_ref_unavailable")


if __name__ == "__main__":
    unittest.main()
