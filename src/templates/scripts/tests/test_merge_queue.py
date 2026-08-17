#!/usr/bin/env python3
"""Real-Git canaries for the Bolt per-target merge queue."""
from __future__ import annotations

import fcntl
import hashlib
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

SCRIPTS = Path(__file__).resolve().parents[1]
TASK = SCRIPTS / "task_workspace.py"
QUEUE = SCRIPTS / "merge_queue.py"
sys.path.insert(0, str(SCRIPTS))
import merge_queue as merge_runtime  # noqa: E402
import risk_policy as risk_runtime  # noqa: E402
import task_workspace as task_runtime  # noqa: E402
try:
    _fixture = task_runtime.load_package_bound_test_fixture(__file__, "real_git_fixture.py")
except task_runtime.TaskWorkspaceError as exc:
    print(f"merge queue test setup: {exc}", file=sys.stderr)
    raise SystemExit(2)
install_juno_admission_fixture = _fixture.install_juno_admission_fixture


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check).stdout.strip()


class MergeQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime_refresh_patcher = mock.patch.object(
            merge_runtime, "refresh_managed_controller",
            return_value={"schema_version": "juno_managed_controller_runtime.v1",
                          "outcome": "completed"},
        )
        self.runtime_refresh = self.runtime_refresh_patcher.start()
        self.kanban_finalization_patcher = mock.patch.object(
            merge_runtime, "finalize_kanban_task",
            wraps=merge_runtime.finalize_kanban_task,
        )
        self.kanban_finalization = self.kanban_finalization_patcher.start()
        self.temporary = tempfile.TemporaryDirectory()
        # Keep fixture records on the physical macOS temp identity; production
        # exact-root guards must continue rejecting lexical symlink aliases.
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / "repo"
        self.controller = self.root / "controller"
        self.workspaces = self.root / "features"
        self.counter = self.root / "validation.log"
        self.full_counter = self.root / "full-validation.log"
        self.repository.mkdir()
        git(self.repository, "init", "-b", "product")
        git(self.repository, "config", "user.email", "test@example.com")
        git(self.repository, "config", "user.name", "Test")
        target_task_runtime = self.repository / ".juno_task/scripts/task_workspace.py"
        target_task_runtime.parent.mkdir(parents=True)
        target_task_runtime.write_bytes(TASK.read_bytes())
        target_policy = self.repository / ".juno_task/config/task-workspace.json"
        target_policy.parent.mkdir(parents=True)
        target_policy.write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1",
            "repository": ".", "target_ref": "refs/heads/product",
            "workspace_root": str(self.workspaces), "branch_prefix": "refs/heads/task-",
            "allowed_paths": ["src", "docs"], "selectable_paths": [],
            "controller_private_paths": [".juno_task/tasks", ".juno_task/state", ".juno_task/specs"],
            "focused_validation": [{"id": "affected", "cwd": "src",
                                    "argv": [sys.executable, "-c", f"from pathlib import Path; Path({str(self.counter)!r}).open('a').write('run\\n')"],
                                    "timeout_seconds": 10, "max_output_bytes": 4096}],
            "full_suite_validation": {"id": "full-suite", "cwd": "src",
                                      "argv": [sys.executable, "-c", f"from pathlib import Path; Path({str(self.full_counter)!r}).open('a').write('run\\n')"],
                                      "timeout_seconds": 10, "max_output_bytes": 4096},
        }) + "\n")
        managed_definition = self.repository / "juno-code/src/templates/managed-assets.json"
        managed_definition.parent.mkdir(parents=True)
        managed_definition.write_text(json.dumps({"schemaVersion": 1, "assets": [{
            "source": "scripts/task_workspace.py",
            "destination": ".juno_task/scripts/task_workspace.py",
            "installClass": "script", "type": "script",
        }], "admissionOutputs": []}) + "\n")
        implementation_contract = self.repository / "juno-code/scripts/implementation-contract.json"
        implementation_contract.parent.mkdir(parents=True)
        implementation_contract.write_text(json.dumps({
            "schema_version": "juno_generated_output_contract.v1",
            "source": "fixtures/canonical.txt",
            "destinations": ["fixtures/generated.txt"],
        }) + "\n")
        package = self.repository / "juno-code/package.json"
        package.write_text(json.dumps({"name": "juno-code", "version": "9.0.0"}) + "\n")
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
        fake_board = self.controller / ".juno_task/runtime/fake-kanban.json"
        fake_board.parent.mkdir(parents=True, exist_ok=True)
        fake_board.write_text(json.dumps({task_id: {
            "id": task_id, "status": "in_progress", "commit_hash": None,
            "agent_response": f"evidence for {task_id}",
        } for task_id in ("A", "B", "X", "Y", "Z")}) + "\n")
        wrapper = self.controller / ".juno_task/scripts/kanban.sh"
        wrapper.write_text(f"""#!/usr/bin/env python3
import json, pathlib, sys
board = pathlib.Path({str(fake_board)!r})
value = json.loads(board.read_text())
if 'get' in sys.argv:
    task_id = sys.argv[sys.argv.index('get') + 1]
    print(json.dumps([value[task_id]])); raise SystemExit(0)
if 'mark' in sys.argv:
    task_id = sys.argv[sys.argv.index('--id') + 1]
    value[task_id]['status'] = 'done'
    value[task_id]['commit_hash'] = sys.argv[sys.argv.index('--commit') + 1]
    value[task_id]['agent_response'] = pathlib.Path(sys.argv[sys.argv.index('--response-file') + 1]).read_text()
    value[task_id]['mutation_count'] = value[task_id].get('mutation_count', 0) + 1
    board.write_text(json.dumps(value) + '\\n')
    receipt = pathlib.Path(sys.argv[sys.argv.index('--receipt-file') + 1])
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({{'outcome': 'completed'}}) + '\\n')
    raise SystemExit(0)
raise SystemExit(2)
""")
        wrapper.chmod(0o755)
        self.write_policy()
        risk_path = self.controller / ".juno_task/config/risk-policy.json"
        risk_path.write_bytes((SCRIPTS.parent / "config/risk-policy.json").read_bytes())
        git(self.controller, "add", ".")
        git(self.controller, "commit", "-m", "controller")
        # Queue CAS targets must not be owned by any checkout.
        git(self.repository, "switch", "--detach", self.base)

    def tearDown(self) -> None:
        self.kanban_finalization_patcher.stop()
        self.runtime_refresh_patcher.stop()
        self.temporary.cleanup()

    def write_policy(self, code: Optional[str] = None, full_code: Optional[str] = None) -> None:
        if code is None:
            code = f"from pathlib import Path; Path({str(self.counter)!r}).open('a').write('run\\n')"
        path = self.controller / ".juno_task/config/task-workspace.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1",
            "repository": ".", "target_ref": "refs/heads/product",
            "workspace_root": str(self.workspaces), "branch_prefix": "refs/heads/task-",
            "allowed_paths": ["src", "docs"],
            "selectable_paths": [],
            "controller_private_paths": [".juno_task/tasks", ".juno_task/state", ".juno_task/specs"],
            "focused_validation": [{"id": "affected", "cwd": "src", "argv": [sys.executable, "-c", code],
                                    "timeout_seconds": 10, "max_output_bytes": 4096}],
            "full_suite_validation": {"id": "full-suite", "cwd": "src",
                                       "argv": [sys.executable, "-c", full_code or
                                                f"from pathlib import Path; Path({str(self.full_counter)!r}).open('a').write('run\\n')"],
                                       "timeout_seconds": 10, "max_output_bytes": 4096},
        }) + "\n")
        relative = str(path.relative_to(self.controller))
        if git(self.controller, "status", "--porcelain=v1", "--", relative):
            git(self.controller, "add", relative)
            git(self.controller, "commit", "-m", "test validation policy")

    def add_validation_dependency_base(self) -> None:
        setup = self.root / "dependency-base"
        git(self.repository, "worktree", "add", str(setup), "product")
        (setup / "src/.gitignore").write_text("node_modules/\n")
        (setup / "src/package-lock.json").write_text('{"lockfileVersion":3}\n')
        git(setup, "add", "src/.gitignore", "src/package-lock.json")
        git(setup, "commit", "-m", "add validation lock")
        git(self.repository, "worktree", "remove", str(setup))

    def add_package_pair_base(self) -> None:
        setup = self.root / "package-pair-base"
        git(self.repository, "worktree", "add", str(setup), "product")
        (setup / "src/.gitignore").write_text("node_modules/\n")
        (setup / "src/package.json").write_text(json.dumps({
            "name": "fixture", "version": "1.0.0", "dependencies": {},
        }) + "\n")
        (setup / "src/package-lock.json").write_text(json.dumps({
            "name": "fixture", "version": "1.0.0", "lockfileVersion": 3,
            "packages": {"": {"name": "fixture", "version": "1.0.0",
                              "dependencies": {}}},
        }) + "\n")
        git(setup, "add", "src/.gitignore", "src/package.json", "src/package-lock.json")
        git(setup, "commit", "-m", "add package pair")
        git(self.repository, "worktree", "remove", str(setup))

    def write_feature_package_pair(self, task_id: str, *, malformed: bool = False,
                                   include_manifest: bool = True) -> None:
        worktree = self.workspaces / task_id
        dependencies = {"yaml": "^2.9.0"}
        if include_manifest:
            (worktree / "src/package.json").write_text(json.dumps({
                "name": "fixture", "version": "1.0.0", "dependencies": dependencies,
            }) + "\n")
        (worktree / "src/package-lock.json").write_text(
            "{malformed\n" if malformed else json.dumps({
                "name": "fixture", "version": "1.0.0", "lockfileVersion": 3,
                "packages": {"": {"name": "fixture", "version": "1.0.0",
                                  "dependencies": dependencies},
                             "node_modules/yaml": {"version": "2.9.0"}},
            }) + "\n")
        git(worktree, "add", "src/package-lock.json",
            *(["src/package.json"] if include_manifest else []))
        git(worktree, "commit", "-m", "update package pair")
        (worktree / "src/node_modules").mkdir(exist_ok=True)

    def test_guarded_cas_advances_exact_registered_integration_owner_role_base(self) -> None:
        owner = self.root / "integration-owner"
        git(self.repository, "worktree", "add", "--detach", str(owner), self.base)
        git(self.repository, "config", "extensions.worktreeConfig", "true")
        git(owner, "config", "--worktree", "juno.workspace.role", "integration-owner")
        git(owner, "config", "--worktree", "juno.workspace.roleAuthority",
            merge_runtime.INTEGRATION_OWNER_AUTHORITY)
        git(owner, "config", "--worktree", "juno.workspace.roleBase", self.base)
        git(self.repository, "config", merge_runtime.INTEGRATION_OWNER_CONFIG, str(owner))

        candidate_worktree = self.root / "candidate"
        git(self.repository, "worktree", "add", "-b", "candidate", str(candidate_worktree), self.base)
        (candidate_worktree / "src/candidate.txt").write_text("candidate\n")
        git(candidate_worktree, "add", "src/candidate.txt")
        git(candidate_worktree, "commit", "-m", "candidate")
        candidate = git(candidate_worktree, "rev-parse", "HEAD")
        git(candidate_worktree, "switch", "--detach")
        git(self.repository, "worktree", "remove", str(candidate_worktree))

        authority = merge_runtime.cas_target(
            self.repository, "refs/heads/product", candidate, self.base
        )
        self.assertEqual(authority["status"], "advanced")
        self.assertEqual(git(owner, "config", "--worktree", "--get",
                             "juno.workspace.roleBase"), candidate)
        self.assertEqual(git(owner, "rev-parse", "HEAD"), candidate)
        self.assertEqual(authority["after"]["head"], candidate)
        self.assertTrue(authority["after"]["clean"])
        self.assertTrue(authority["after"]["detached"])

    def test_guarded_cas_reports_owner_checkout_readback_not_advanced_target_ref(self) -> None:
        owner = self.root / "integration-owner-race"
        git(self.repository, "worktree", "add", "--detach", str(owner), self.base)
        git(self.repository, "config", "extensions.worktreeConfig", "true")
        git(owner, "config", "--worktree", "juno.workspace.role", "integration-owner")
        git(owner, "config", "--worktree", "juno.workspace.roleAuthority",
            merge_runtime.INTEGRATION_OWNER_AUTHORITY)
        git(owner, "config", "--worktree", "juno.workspace.roleBase", self.base)
        git(self.repository, "config", merge_runtime.INTEGRATION_OWNER_CONFIG, str(owner))

        candidate_worktree = self.root / "candidate-race"
        git(self.repository, "worktree", "add", "-b", "candidate-race",
            str(candidate_worktree), self.base)
        (candidate_worktree / "src/race.txt").write_text("candidate\n")
        git(candidate_worktree, "add", "src/race.txt")
        git(candidate_worktree, "commit", "-m", "candidate race")
        candidate = git(candidate_worktree, "rev-parse", "HEAD")
        git(candidate_worktree, "switch", "--detach")
        git(self.repository, "worktree", "remove", str(candidate_worktree))

        original_run = merge_runtime.task_runtime.run

        def race_after_cas(argv: list[str], cwd: Path, **kwargs: object) -> subprocess.CompletedProcess[str]:
            result = original_run(argv, cwd, **kwargs)
            if "update-ref" in argv and argv[-3:] == [
                    "refs/heads/product", candidate, self.base]:
                Path(git(owner, "rev-parse", "--git-path", "index.lock")).touch()
            return result

        with mock.patch.object(merge_runtime.task_runtime, "run", side_effect=race_after_cas):
            authority = merge_runtime.cas_target(
                self.repository, "refs/heads/product", candidate, self.base)

        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), candidate)
        self.assertEqual(git(owner, "rev-parse", "HEAD"), self.base)
        self.assertEqual(authority["status"], "partial")
        self.assertEqual(authority["target_sha"], candidate)
        self.assertEqual(authority["after"]["head"], self.base)
        self.assertNotEqual(authority["after"]["head"], authority["target_sha"])
        self.assertEqual(authority["recovery_command"], "yy integration sync")
        with self.assertRaisesRegex(
                merge_runtime.IntegrationOwnerAdvancementError,
                "recover with: yy integration sync"):
            merge_runtime.require_owner_advancement(authority)

    def test_managed_review_prompt_resolves_from_bound_runtime(self) -> None:
        executable = self.root / "installed/dist/bin/juno-code.sh"
        prompt = self.root / "installed/dist/templates/prompts/review_commit_parallel_runner.md"
        executable.parent.mkdir(parents=True)
        prompt.parent.mkdir(parents=True)
        executable.write_text("#!/bin/sh\n")
        prompt.write_text("read-only reviewer\n")
        identity = self.controller / ".juno_task/runtime/identity.json"
        identity.parent.mkdir(parents=True, exist_ok=True)
        identity.write_text(json.dumps({
            "executable": str(executable),
            "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
        }))

        self.assertEqual(merge_runtime.managed_review_prompt(self.controller), prompt.resolve())

    def test_managed_review_prompt_rejects_runtime_hash_drift(self) -> None:
        executable = self.root / "installed/dist/bin/juno-code.sh"
        prompt = self.root / "installed/dist/templates/prompts/review_commit_parallel_runner.md"
        executable.parent.mkdir(parents=True)
        prompt.parent.mkdir(parents=True)
        executable.write_text("#!/bin/sh\n")
        prompt.write_text("read-only reviewer\n")
        identity = self.controller / ".juno_task/runtime/identity.json"
        identity.parent.mkdir(parents=True, exist_ok=True)
        identity.write_text(json.dumps({
            "executable": str(executable),
            "executable_sha256": "0" * 64,
        }))

        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "hash drifted"):
            merge_runtime.managed_review_prompt(self.controller)

    def test_rendered_reviewer_prompt_contains_exact_queue_bound_context(self) -> None:
        template = SCRIPTS.parent / "prompts/review_commit_parallel_runner.md"
        candidate_sha = "b" * 40
        base_sha = "a" * 40
        plan = {
            "tier": "high", "full_suite_required": False,
            "evidence_limits": {"max_receipt_bytes": 65536},
            "candidate": {"base_sha": base_sha, "candidate_sha": candidate_sha},
        }
        record = {
            "task_id": "A", "state": "AWAITING_RISK",
            "queue_attempt": {
                "candidate_sha": candidate_sha,
                "validation": [{"id": "affected", "exit_code": 0}],
                "risk": {"plan": plan, "review_progress": {"full_suite_admission": None}},
            },
        }
        output = self.root / "rendered-review.md"
        with (mock.patch.object(merge_runtime, "managed_review_prompt", return_value=template),
              mock.patch.object(merge_runtime.task_runtime, "read_state",
                                return_value={"tasks": {"A": record}})):
            rendered = merge_runtime.render_managed_review_prompt(
                self.controller, self.repository, plan, "A", "reviewer_a", 1, output)
        text = rendered.read_text()
        self.assertIn(f"Task: `A`", text)
        self.assertIn(f"Base: `{base_sha}`", text)
        self.assertIn(f"Tip: `{candidate_sha}`", text)
        self.assertIn("Reviewer: `1:reviewer_a`", text)
        self.assertIn("Queue-bound risk plan", text)
        self.assertIn('"affected_validation":[{"exit_code":0,"id":"affected"}]', text)
        self.assertIn("No prior reviewed candidate is bound", text)
        for field in merge_runtime.REVIEW_PROMPT_FIELDS:
            self.assertNotRegex(text, r"{{\s*" + field + r"\s*}}")

    def test_rendered_reviewer_prompt_rejects_template_placeholder_drift(self) -> None:
        fields = {name: name for name in merge_runtime.REVIEW_PROMPT_FIELDS}
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "placeholder contract drifted"):
            merge_runtime.render_review_template("Task {{ task_id }} {{ unknown }}", fields)

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

    def candidate_artifacts(self) -> list[Path]:
        root = self.controller / ".juno_task/runtime/merge-queue/candidates"
        return sorted(root.iterdir()) if root.exists() else []

    def assert_malformed_admission_states_refuse(self, canonical_state: dict) -> None:
        state_path = self.controller / ".juno_task/state/tasks.json"
        expected_target = git(self.repository, "rev-parse", "refs/heads/product")
        expected_suite_runs = (self.full_counter.read_text().splitlines()
                               if self.full_counter.exists() else [])
        for mutation in ("unsupported", "missing", "nonstring"):
            with self.subTest(mutation=mutation):
                state = json.loads(json.dumps(canonical_state))
                admission = state["tasks"]["X"]["queue_attempt"]["risk"] \
                    ["review_progress"]["full_suite_admission"]
                review_admission = state["tasks"]["X"]["queue_attempt"]["review"] \
                    ["review_progress"]["full_suite_admission"]
                if mutation == "unsupported":
                    admission["state"] = "BROKEN"
                    review_admission["state"] = "BROKEN"
                elif mutation == "missing":
                    admission.pop("state")
                    review_admission.pop("state")
                else:
                    admission["state"] = ["FAILED"]
                    review_admission["state"] = ["FAILED"]
                state_path.write_text(
                    json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
                before = state_path.read_bytes()
                with (mock.patch.object(merge_runtime, "full_suite_validation") as suite,
                      mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch,
                      mock.patch.object(merge_runtime, "cas_target") as cas):
                    with self.assertRaisesRegex(
                            merge_runtime.MergeQueueError,
                            "admission state is malformed or unsupported"):
                        merge_runtime.merge_review(self.controller.resolve(), "X")
                suite.assert_not_called()
                dispatch.assert_not_called()
                cas.assert_not_called()
                self.assertEqual(state_path.read_bytes(), before)
                self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"),
                                 expected_target)
                self.assertEqual(
                    self.full_counter.read_text().splitlines()
                    if self.full_counter.exists() else [], expected_suite_runs)

    def registered_candidate_paths(self) -> list[Path]:
        root = (self.controller / ".juno_task/runtime/merge-queue/candidates").resolve()
        result = []
        for row in merge_runtime.registered_worktrees(self.controller):
            path = Path(row.get("worktree", "")).resolve()
            try:
                path.relative_to(root)
            except ValueError:
                continue
            result.append(path)
        return sorted(result)

    def bootstrap_policyless_product_generation(self, version: str) -> str:
        checkout = self.root / "policyless-installed-product"
        git(self.repository, "worktree", "add", str(checkout), "product")
        script = checkout / ".juno_task/scripts/task_workspace.py"
        digest = hashlib.sha256(script.read_bytes()).hexdigest()
        manifest = {
            "schemaVersion": 1, "packageName": "juno-code", "packageVersion": version,
            "assets": {".juno_task/scripts/task_workspace.py": {
                "type": "script", "templateVersion": version,
                "sourceSha256": digest, "installedSha256": digest,
            }},
        }
        (checkout / ".juno_task/managed-assets.json").write_text(json.dumps(manifest) + "\n")
        git(checkout, "rm", "-r", "juno-code", ".juno_task/config/task-workspace.json")
        git(checkout, "add", ".juno_task/managed-assets.json")
        git(checkout, "commit", "-m", f"supported runtime bootstrap to {version}")
        generation = git(checkout, "rev-parse", "HEAD")
        git(self.repository, "worktree", "remove", str(checkout))
        return generation

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

    def install_merge_planner_runtime(self) -> None:
        target = self.controller / ".juno_task/scripts/merge_queue.py"
        target.write_bytes(QUEUE.read_bytes())

    def advance_target(self, path: str = ".juno_task/state/target.json",
                       text: str = "target\n") -> str:
        checkout = self.root / f"target-{len(list(self.root.glob('target-*')))}"
        git(self.repository, "worktree", "add", str(checkout), "product")
        target = checkout / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        git(checkout, "add", path)
        git(checkout, "commit", "-m", "advance protected target")
        sha = git(checkout, "rev-parse", "HEAD")
        git(self.repository, "worktree", "remove", str(checkout))
        return sha

    def merge_target_into(self, task_id: str) -> str:
        worktree = self.workspaces / task_id
        git(worktree, "merge", "--no-edit", "refs/heads/product")
        return git(worktree, "rev-parse", "HEAD")

    def prepare_terminal_reconciliation(self, task_id: str = "X",
                                        state_name: str = "REVIEW_FINDINGS") -> tuple[str, str, dict]:
        tip = self.commit_feature(task_id, f"docs/{task_id}.txt", "feature\n")
        checkout = self.root / f"cumulative-{task_id}"
        git(self.repository, "worktree", "add", str(checkout), "product")
        git(checkout, "merge", "--no-ff", "--no-edit", tip)
        target = git(checkout, "rev-parse", "HEAD")
        git(self.repository, "worktree", "remove", str(checkout))
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        record = state["tasks"][task_id]
        record["state"] = state_name
        record["review_round"] = 2
        record["last_queue_outcome"] = state_name
        record["queue_attempt"] = {
            "schema_version": merge_runtime.ATTEMPT_SCHEMA,
            "task_id": task_id, "target_ref": "refs/heads/product",
            "expected_target_sha": self.base, "feature_sha": tip,
            "candidate_sha": tip, "outcome": state_name,
            "risk": {"review_progress": {"review_attempt_counter": 2,
                                           "steps": [{"reviewer": "reviewer_a"}]}},
        }
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        board_path = self.controller / ".juno_task/runtime/fake-kanban.json"
        board = json.loads(board_path.read_text())
        board[task_id].update({"status": "done", "commit_hash": target})
        board_path.write_text(json.dumps(board) + "\n")
        return tip, target, json.loads(json.dumps(record))

    def test_terminal_findings_reconciliation_is_receipt_bound_idempotent_and_review_free(self) -> None:
        tip, target, before = self.prepare_terminal_reconciliation()
        validation_before = self.counter.read_bytes()
        with (mock.patch.object(merge_runtime, "validation_rows") as validation,
              mock.patch.object(merge_runtime, "review_candidate") as review,
              mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch):
            plan = merge_runtime.persist_terminal_reconciliation_plan(
                self.controller.resolve(), "X")
            applied = merge_runtime.apply_terminal_reconciliation(
                self.controller.resolve(), "X", plan["receipt"]["path"],
                plan["receipt"]["sha256"])
            state_before_retry = (self.controller / ".juno_task/state/tasks.json").read_bytes()
            retried = merge_runtime.apply_terminal_reconciliation(
                self.controller.resolve(), "X", plan["receipt"]["path"],
                plan["receipt"]["sha256"])
        self.assertEqual((plan["tip_sha"], plan["target_sha"]), (tip, target))
        self.assertEqual(applied["outcome"], "TERMINAL_RECONCILIATION_APPLIED")
        self.assertEqual(retried["outcome"], "TERMINAL_RECONCILIATION_ALREADY_APPLIED")
        self.assertEqual((self.controller / ".juno_task/state/tasks.json").read_bytes(),
                         state_before_retry)
        self.assertEqual(applied["queue_attempt"], before["queue_attempt"])
        self.assertEqual(applied["review_round"], before["review_round"])
        self.assertEqual(self.counter.read_bytes(), validation_before)
        self.assertTrue(Path(plan["receipt"]["path"]).is_file())
        validation.assert_not_called(); review.assert_not_called(); dispatch.assert_not_called()

    def test_reconcile_cli_forwards_plan_and_apply_with_orchestration_audits(self) -> None:
        _, _, before = self.prepare_terminal_reconciliation()
        validation_before = self.counter.read_bytes()

        planned = json.loads(self.command(QUEUE, ["reconcile", "plan", "X"]).stdout)
        applied = json.loads(self.command(QUEUE, [
            "reconcile", "apply", "X",
            "--receipt", planned["receipt"]["path"],
            "--receipt-sha256", planned["receipt"]["sha256"],
        ]).stdout)

        self.assertEqual(applied["outcome"], "TERMINAL_RECONCILIATION_APPLIED")
        for result in (planned, applied):
            reference = result["control_audit"]
            receipt = json.loads(Path(reference["path"]).read_text())
            self.assertEqual(
                (receipt["surface"], receipt["operation"], receipt["policy_operation"],
                 receipt["task_id"]),
                ("merge", "reconcile", "orchestration", "X"),
            )
        self.assertEqual(applied["queue_attempt"], before["queue_attempt"])
        self.assertEqual(applied["review_round"], before["review_round"])
        self.assertEqual(self.counter.read_bytes(), validation_before)

    def test_terminal_reconciliation_supports_exhausted_but_refuses_nonancestor_and_nonterminal(self) -> None:
        self.prepare_terminal_reconciliation(state_name="REVIEW_FINDINGS_EXHAUSTED")
        exhausted = merge_runtime.persist_terminal_reconciliation_plan(
            self.controller.resolve(), "X")
        self.assertEqual(exhausted["source_state"], "REVIEW_FINDINGS_EXHAUSTED")

        tip = self.commit_feature("Y", "docs/Y.txt", "not integrated\n")
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        state["tasks"]["Y"]["state"] = "REVIEW_FINDINGS"
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        board_path = self.controller / ".juno_task/runtime/fake-kanban.json"
        board = json.loads(board_path.read_text())
        board["Y"].update({"status": "done", "commit_hash": tip})
        board_path.write_text(json.dumps(board) + "\n")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "not an ancestor"):
            merge_runtime.persist_terminal_reconciliation_plan(self.controller.resolve(), "Y")
        board["Y"]["status"] = "in_progress"
        board_path.write_text(json.dumps(board) + "\n")
        # Even a contained tip cannot bypass canonical terminal Kanban truth.
        git(self.repository, "update-ref", "refs/heads/product", tip)
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "not terminal done"):
            merge_runtime.persist_terminal_reconciliation_plan(self.controller.resolve(), "Y")

    def test_terminal_reconciliation_refuses_stale_tampered_and_concurrent_apply(self) -> None:
        self.prepare_terminal_reconciliation()
        plan = merge_runtime.persist_terminal_reconciliation_plan(self.controller.resolve(), "X")
        receipt = Path(plan["receipt"]["path"])
        original = receipt.read_bytes()
        receipt.write_bytes(original.replace(b'"source_state":"REVIEW_FINDINGS"',
                                             b'"source_state":"REVIEW_FINDINGS_EXHAUSTED"'))
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "forged or tampered"):
            merge_runtime.apply_terminal_reconciliation(
                self.controller.resolve(), "X", str(receipt), plan["receipt"]["sha256"])
        receipt.write_bytes(original)
        common = Path(git(self.repository, "rev-parse", "--path-format=absolute",
                          "--git-common-dir")).resolve()
        key = merge_runtime.target_key(self.repository, "refs/heads/product")
        lock = common / "juno-locks/merge-queue" / f"{key}.lock"
        with lock.open("a+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "another worker owns"):
                merge_runtime.apply_terminal_reconciliation(
                    self.controller.resolve(), "X", str(receipt), plan["receipt"]["sha256"])
        self.advance_target("src/later.txt", "later\n")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "target moved"):
            merge_runtime.apply_terminal_reconciliation(
                self.controller.resolve(), "X", str(receipt), plan["receipt"]["sha256"])

    def test_terminal_reconciliation_refuses_queue_and_kanban_drift_and_is_crash_atomic(self) -> None:
        self.prepare_terminal_reconciliation()
        plan = merge_runtime.persist_terminal_reconciliation_plan(self.controller.resolve(), "X")
        state_path = self.controller / ".juno_task/state/tasks.json"
        before = state_path.read_bytes()
        with mock.patch.object(merge_runtime.task_runtime.os, "replace",
                               side_effect=OSError("injected crash")):
            with self.assertRaisesRegex(OSError, "injected crash"):
                merge_runtime.apply_terminal_reconciliation(
                    self.controller.resolve(), "X", plan["receipt"]["path"],
                    plan["receipt"]["sha256"])
        self.assertEqual(state_path.read_bytes(), before)

        state = json.loads(before)
        state["tasks"]["X"]["review_round"] = 99
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "queue identity drifted"):
            merge_runtime.apply_terminal_reconciliation(
                self.controller.resolve(), "X", plan["receipt"]["path"],
                plan["receipt"]["sha256"])
        state_path.write_bytes(before)
        board_path = self.controller / ".juno_task/runtime/fake-kanban.json"
        board = json.loads(board_path.read_text())
        board["X"]["agent_response"] = "changed terminal identity"
        board_path.write_text(json.dumps(board) + "\n")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "Kanban identity"):
            merge_runtime.apply_terminal_reconciliation(
                self.controller.resolve(), "X", plan["receipt"]["path"],
                plan["receipt"]["sha256"])

    def test_target_refresh_direct_apply_preserves_admission_and_queue_evidence(self) -> None:
        self.install_merge_planner_runtime()
        old_tip = self.commit_feature("X", "docs/feature.txt", "feature\n")
        state_path = self.controller / ".juno_task/state/tasks.json"
        before = json.loads(state_path.read_text())["tasks"]["X"]
        target = self.advance_target()
        refreshed = self.merge_target_into("X")
        planned = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "X")
        classes = {row["path"]: row["classification"] for row in planned["classifications"]}
        self.assertEqual(classes["docs/feature.txt"], "feature-authored")
        self.assertEqual(classes[".juno_task/state/target.json"], "unchanged-target-derived")
        applied = merge_runtime.apply_target_refresh(
            self.controller.resolve(), "X", planned["receipt"]["path"],
            planned["receipt"]["sha256"])
        self.assertEqual((applied["outcome"], applied["tip_sha"]),
                         ("TARGET_REFRESH_APPLIED", refreshed))
        self.assertEqual(applied["changed_paths"], ["docs/feature.txt"])
        self.assertEqual(applied["creation_receipt"], before["creation_receipt"])
        self.assertEqual(applied.get("queue_attempt"), before.get("queue_attempt"))
        reference = applied["target_refreshes"][0]
        self.assertEqual((reference["source_tip"], reference["target_sha"]), (old_tip, target))
        self.assertTrue(Path(reference["receipt_path"]).is_file())

    def test_target_refresh_admits_valid_task_authored_package_pair(self) -> None:
        self.install_merge_planner_runtime()
        self.add_package_pair_base()
        self.task("start", "X")
        self.write_feature_package_pair("X")
        self.task("finish", "X")
        self.advance_target("src/target.txt", "target\n")
        refreshed = self.merge_target_into("X")

        planned = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "X")
        applied = merge_runtime.apply_target_refresh(
            self.controller.resolve(), "X", planned["receipt"]["path"],
            planned["receipt"]["sha256"])

        self.assertEqual((applied["outcome"], applied["tip_sha"]),
                         ("TARGET_REFRESH_APPLIED", refreshed))
        self.assertEqual(set(applied["changed_paths"]),
                         {"src/package.json", "src/package-lock.json"})

    def test_target_refresh_rejects_malformed_task_authored_package_lock(self) -> None:
        self.install_merge_planner_runtime()
        self.add_package_pair_base()
        self.task("start", "X")
        self.write_feature_package_pair("X", malformed=True)
        self.task("finish", "X")
        self.advance_target("src/target.txt", "target\n")
        self.merge_target_into("X")
        planned = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "X")

        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "package.lock_diverged"):
            merge_runtime.apply_target_refresh(
                self.controller.resolve(), "X", planned["receipt"]["path"],
                planned["receipt"]["sha256"])

    def test_target_refresh_rejects_lock_without_task_authored_manifest_pair(self) -> None:
        self.install_merge_planner_runtime()
        self.add_package_pair_base()
        self.task("start", "X")
        self.write_feature_package_pair("X", include_manifest=False)
        self.task("finish", "X")
        self.advance_target("src/target.txt", "target\n")
        self.merge_target_into("X")
        planned = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "X")

        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "package.lock_diverged"):
            merge_runtime.apply_target_refresh(
                self.controller.resolve(), "X", planned["receipt"]["path"],
                planned["receipt"]["sha256"])

    def test_next_reconciles_fifo_tip_already_integrated_in_target_without_validation(self) -> None:
        tip = self.commit_feature("X", "docs/feature.txt", "feature\n")
        checkout = self.root / "external-integration"
        git(self.repository, "worktree", "add", str(checkout), "product")
        git(checkout, "merge", "--no-ff", "--no-edit", tip)
        target = git(checkout, "rev-parse", "HEAD")
        git(self.repository, "worktree", "remove", str(checkout))
        validation_before = self.counter.read_bytes()

        reconciled = merge_runtime.merge_next(self.controller.resolve())

        self.assertEqual(reconciled["outcome"], "ALREADY_IN_TARGET")
        self.assertEqual(reconciled["strategy"], "already_in_target")
        self.assertEqual((reconciled["feature_sha"], reconciled["candidate_sha"]),
                         (tip, target))
        self.assertEqual(reconciled["validation"], [])
        self.assertEqual(self.task("status", "X")["state"], "MERGED")
        self.assertEqual(self.counter.read_bytes(), validation_before)

    def test_target_refresh_composed_authored_repair_and_retry_are_idempotent(self) -> None:
        self.install_merge_planner_runtime()
        self.commit_feature("X", "docs/feature.txt", "v1\n")
        self.advance_target("src/target.txt")
        self.merge_target_into("X")
        worktree = self.workspaces / "X"
        (worktree / "docs/feature.txt").write_text("v2\n")
        git(worktree, "add", "docs/feature.txt")
        git(worktree, "commit", "-m", "compose authored repair after refresh")
        planned = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "X")
        first = merge_runtime.apply_target_refresh(
            self.controller.resolve(), "X", planned["receipt"]["path"],
            planned["receipt"]["sha256"])
        state_before = (self.controller / ".juno_task/state/tasks.json").read_bytes()
        second = merge_runtime.apply_target_refresh(
            self.controller.resolve(), "X", planned["receipt"]["path"],
            planned["receipt"]["sha256"])
        self.assertEqual(second["outcome"], "TARGET_REFRESH_ALREADY_APPLIED")
        self.assertEqual(len(first["target_refreshes"]), 1)
        self.assertEqual((self.controller / ".juno_task/state/tasks.json").read_bytes(), state_before)

    def test_target_refresh_accepts_only_exact_inherited_target_bytes_on_second_refresh(self) -> None:
        self.install_merge_planner_runtime()
        self.commit_feature("X", "docs/feature.txt", "feature\n")
        self.advance_target("src/first-target.txt", "first\n")
        first_refreshed = self.merge_target_into("X")
        first_plan = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "X")
        with mock.patch.object(merge_runtime, "validation_rows", return_value=[]):
            merge_runtime.apply_target_refresh(
                self.controller.resolve(), "X", first_plan["receipt"]["path"],
                first_plan["receipt"]["sha256"])

        self.advance_target("src/second-target.txt", "second\n")
        second_refreshed = self.merge_target_into("X")
        second_plan = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "X")
        classes = {row["path"]: row["classification"]
                   for row in second_plan["classifications"]}

        self.assertNotEqual(first_refreshed, second_refreshed)
        self.assertEqual(classes["src/first-target.txt"], "inherited-target-derived")
        self.assertEqual(classes["src/second-target.txt"], "unchanged-target-derived")
        self.assertEqual(second_plan["authored_paths"], ["docs/feature.txt"])

    def test_target_refresh_reopen_candidate_preserves_evidence_and_cleans_exact_owner(self) -> None:
        self.install_merge_planner_runtime()
        checkout, marker = self.prepare_moved_finding_reopen()
        state_path = self.controller / ".juno_task/state/tasks.json"
        old_attempt = json.loads(state_path.read_text())["tasks"]["Y"]["queue_attempt"]
        self.advance_target("src/target.txt")
        self.merge_target_into("Y")
        planned = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "Y")
        self.assertEqual(planned["evidence"]["queue_attempt"], old_attempt)
        applied = merge_runtime.apply_target_refresh(
            self.controller.resolve(), "Y", planned["receipt"]["path"],
            planned["receipt"]["sha256"])
        self.assertEqual(applied["state"], "QUEUED")
        self.assertNotIn("queue_attempt", applied)
        self.assertFalse(checkout.exists())
        self.assertFalse(marker.exists())
        self.assertEqual(json.loads(Path(planned["receipt"]["path"]).read_text())
                         ["evidence"]["queue_attempt"], old_attempt)

    def test_target_refresh_rejects_altered_private_dirty_and_non_descendant_tips(self) -> None:
        self.install_merge_planner_runtime()
        self.commit_feature("X", "docs/feature.txt", "feature\n")
        self.advance_target()
        self.merge_target_into("X")
        worktree = self.workspaces / "X"
        (worktree / ".juno_task/state").mkdir(parents=True, exist_ok=True)
        (worktree / ".juno_task/state/target.json").write_text("altered\n")
        git(worktree, "add", ".juno_task/state/target.json")
        git(worktree, "commit", "-m", "alter inherited private bytes")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "altered-target-derived-byte"):
            merge_runtime.target_refresh_plan(self.controller.resolve(), "X")
        git(worktree, "reset", "--hard", "HEAD^")
        (worktree / "dirty.txt").write_text("dirty\n")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "must be clean"):
            merge_runtime.target_refresh_plan(self.controller.resolve(), "X")
        (worktree / "dirty.txt").unlink()
        git(worktree, "reset", "--hard", "HEAD^")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "protected target.*non-descendant"):
            merge_runtime.target_refresh_plan(self.controller.resolve(), "X")

    def test_target_refresh_rejects_tampered_receipt_and_target_or_plan_drift(self) -> None:
        self.install_merge_planner_runtime()
        self.commit_feature("X", "docs/feature.txt", "feature\n")
        self.advance_target("src/one.txt")
        self.merge_target_into("X")
        planned = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "X")
        receipt = Path(planned["receipt"]["path"])
        original = receipt.read_bytes()
        receipt.write_bytes(original.replace(b'"operation":"target-refresh"',
                                             b'"operation":"target-forged"'))
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "forged or tampered"):
            merge_runtime.apply_target_refresh(
                self.controller.resolve(), "X", str(receipt), planned["receipt"]["sha256"])
        receipt.write_bytes(original)
        self.advance_target("src/two.txt")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "drifted"):
            merge_runtime.apply_target_refresh(
                self.controller.resolve(), "X", str(receipt), planned["receipt"]["sha256"])
        outside = self.root / "copied-receipt.json"
        outside.write_bytes(original)
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "unauthorized"):
            merge_runtime.apply_target_refresh(
                self.controller.resolve(), "X", str(outside),
                hashlib.sha256(original).hexdigest())

    def test_feasibility_plan_clean_ready_is_stable_and_byte_non_mutating(self) -> None:
        self.install_merge_planner_runtime()
        self.commit_feature("X", "docs/plan.txt", "ready\n")
        state_path = self.controller / ".juno_task/state/tasks.json"
        before = {
            "state": state_path.read_bytes(),
            "target": git(self.repository, "rev-parse", "refs/heads/product"),
            "worktrees": git(self.repository, "worktree", "list", "--porcelain"),
            "status": git(self.controller, "status", "--porcelain=v1", "--untracked-files=all"),
        }
        first = merge_runtime.merge_plan(self.controller.resolve(), "X")
        second = merge_runtime.merge_plan(self.controller.resolve(), "X")
        self.assertTrue(first["ready"])
        self.assertEqual(merge_runtime.canonical(first), merge_runtime.canonical(second))
        self.assertEqual(first["schema_version"], merge_runtime.PLAN_SCHEMA)
        self.assertEqual([row["id"] for row in first["validation_commands"]],
                         ["affected", "full-suite"])
        self.assertEqual(state_path.read_bytes(), before["state"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), before["target"])
        self.assertEqual(git(self.repository, "worktree", "list", "--porcelain"), before["worktrees"])
        self.assertEqual(git(self.controller, "status", "--porcelain=v1", "--untracked-files=all"),
                         before["status"])

    def test_feasibility_semver_literal_is_scoped_advisory_not_global_blocker(self) -> None:
        self.install_merge_planner_runtime()
        self.commit_feature("X", "src/version.test.ts", 'expect(version).toBe("2.1.2")\n')

        report = merge_runtime.merge_plan(self.controller.resolve(), "X")
        finding = next(row for row in report["findings"]
                       if row["code"] == "validation.hardcoded_semver_fixture")

        self.assertTrue(report["ready"])
        self.assertEqual(finding["severity"], "warning")
        self.assertTrue(finding["tests_safe_before_repair"])
        self.assertEqual(finding["evidence"]["matches"], [
            {"path": "src/version.test.ts", "literal": "2.1.2"},
        ])

    def test_feasibility_plan_aggregates_conflict_topology_lock_and_semver(self) -> None:
        self.install_merge_planner_runtime()
        self.add_validation_dependency_base()
        self.task("start", "A")
        self.task("start", "B")
        a_worktree = self.workspaces / "A"
        (a_worktree / "src/shared.txt").write_text("target side\n")
        git(a_worktree, "add", "src/shared.txt")
        git(a_worktree, "commit", "-m", "target side")
        self.task("finish", "A")
        (a_worktree / "src/node_modules").mkdir()
        self.queue_payload("next")
        worktree = self.workspaces / "B"
        (worktree / "src/shared.txt").write_text("feature side\n")
        (worktree / "src/package-lock.json").write_text('{"lockfileVersion":2}\n')
        (worktree / "src/package.json").write_text('{"version":"01.2.3"}\n')
        git(worktree, "add", "src")
        git(worktree, "commit", "-m", "conflicting stale package")
        self.task("finish", "B")
        holder = self.root / "target-holder"
        git(self.repository, "worktree", "add", str(holder), "product")
        validation_before = self.counter.read_bytes()
        report = merge_runtime.merge_plan(self.controller.resolve(), "B")
        codes = {row["code"] for row in report["findings"]}
        self.assertTrue({"composition.conflicts", "topology.target_checked_out",
                         "package.invalid_semver"}.issubset(codes))
        self.assertIn("src/shared.txt", report["composition"]["conflict_paths"])
        self.assertFalse(report["ready"])
        self.assertEqual(self.counter.read_bytes(), validation_before)

    def test_feasibility_plan_missing_runtime_malformed_policy_and_stale_identity_fail_closed(self) -> None:
        self.commit_feature("X", "docs/plan.txt", "ready\n")
        missing = merge_runtime.merge_plan(self.controller.resolve(), "X")
        self.assertIn("runtime.missing", {row["code"] for row in missing["findings"]})
        self.install_merge_planner_runtime()
        current = merge_runtime.merge_plan(self.controller.resolve(), "X")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "plan is stale"):
            merge_runtime.assert_static_plan(self.controller.resolve(), "X", "next", "0" * 64)
        self.assertNotEqual(current["plan_id"], "0" * 64)
        policy = self.controller / ".juno_task/config/task-workspace.json"
        policy.write_text("{malformed\n")
        malformed = merge_runtime.merge_plan(self.controller.resolve(), "X")
        self.assertEqual(malformed["findings"][0]["code"], "policy.malformed")
        self.assertFalse(malformed["ready"])

    def test_execution_shared_gate_runs_before_validation_and_rejects_stale_plan(self) -> None:
        self.install_merge_planner_runtime()
        self.commit_feature("X", "docs/plan.txt", "ready\n")
        report = merge_runtime.merge_plan(self.controller.resolve(), "X")
        with mock.patch.object(merge_runtime, "validation_rows") as validation:
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "plan is stale"):
                merge_runtime.merge_next(self.controller.resolve(), expected_plan_id="0" * 64)
        validation.assert_not_called()
        self.assertEqual(report["plan_id"],
                         merge_runtime.assert_static_plan(
                             self.controller.resolve(), "X", "next", report["plan_id"]
                         )["plan_id"])

    def test_feasibility_plan_cli_json_projects_same_schema(self) -> None:
        self.install_merge_planner_runtime()
        self.commit_feature("X", "docs/plan.txt", "ready\n")
        result = self.command(QUEUE, ["plan", "X", "--json"])
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], merge_runtime.PLAN_SCHEMA)
        self.assertEqual(payload["plan_id"],
                         merge_runtime.merge_plan(self.controller.resolve(), "X")["plan_id"])
        human = self.command(QUEUE, ["plan", "X"]).stdout
        self.assertIn(payload["plan_id"], human)
        self.assertIn("validation commands:", human)

    def object_file(self, name: str, value: dict) -> tuple[str, str]:
        path = self.root / "fake-reviews" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        data = risk_runtime.canonical(value)
        path.write_bytes(data)
        return str(path), hashlib.sha256(data).hexdigest()

    def fake_review(self, _controller: Path, _candidate: Path, plan: dict,
                    _task_id: str, reviewer: str, sequence: int,
                    predecessor_receipt: Optional[Path], _attempt_number: int,
                    *, findings: bool = False) -> dict[str, str]:
        predecessor = None
        if predecessor_receipt is not None:
            prior = json.loads(predecessor_receipt.read_text())
            predecessor = {
                "receipt_sha256": hashlib.sha256(predecessor_receipt.read_bytes()).hexdigest(),
                "tool_id": prior["tool_id"], "session_id": prior["session_id"],
                "completed_at": prior["completed_at"],
                "binding_sha256": prior["review_binding"]["binding_sha256"],
            }
        binding = {"schema_version": risk_runtime.REVIEW_BINDING_SCHEMA,
                   "candidate_sha": plan["candidate"]["candidate_sha"],
                   "policy_identity": plan["policy_identity"], "reviewer_role": reviewer,
                   "sequence": sequence, "predecessor": predecessor}
        binding["binding_sha256"] = risk_runtime.digest(binding)
        result = {"schema_version": risk_runtime.REVIEW_RESULT_SCHEMA,
                  "candidate_sha": binding["candidate_sha"],
                  "policy_identity": binding["policy_identity"], "reviewer_role": reviewer,
                  "sequence": sequence, "verdict": "findings" if findings else "pass",
                  "findings": ([{"code": "SEC", "severity": "high", "summary": "finding"}]
                               if findings else [])}
        result_path, result_sha = self.object_file(f"result-{reviewer}-{sequence}.json", result)
        receipt = {"schema_version": risk_runtime.MANAGED_RUNNER_SCHEMA, "mode": "reviewer",
                   "state": "succeeded", "semantic_outcome": "completed",
                   "session_id": f"session-{reviewer}-{sequence}",
                   "tool_id": f"bolt_{reviewer}",
                   "completed_at": f"2026-08-09T00:00:0{sequence}Z",
                   "identity": {"candidate_sha": binding["candidate_sha"]},
                   "review_binding": binding,
                   "artifacts": {"response": {"path": result_path,
                                                "bytes": Path(result_path).stat().st_size,
                                                "sha256": result_sha}}}
        receipt_path, receipt_sha = self.object_file(f"runner-{reviewer}-{sequence}.json", receipt)
        return {"runner_receipt_path": receipt_path, "runner_receipt_sha256": receipt_sha}

    def external_full_suite_admission(self, plan: dict, identity: dict,
                                      command: dict) -> dict:
        claim_path = (self.root / "attacker-claim.json").resolve()
        receipt_path = (self.root / "attacker-receipt.json").resolve()
        token = "a" * 48
        claim = {"schema_version": risk_runtime.FULL_SUITE_CLAIM_SCHEMA,
                 "producer": {"schema_version": risk_runtime.FULL_SUITE_PRODUCER_SCHEMA,
                              "tool_id": risk_runtime.FULL_SUITE_TOOL_ID},
                 "task_id": "X",
                 "candidate": {"candidate_sha": plan["candidate"]["candidate_sha"],
                               "candidate_tree": plan["candidate"]["candidate_tree"]},
                 "policy_identity": plan["policy_identity"],
                 "validation_identity": identity, "command": command,
                 "token": token, "attempt_number": 1,
                 "expected_receipt_path": str(receipt_path)}
        claim_path.write_bytes(risk_runtime.canonical(claim))
        claim_ref = {"claim_path": str(claim_path),
                     "claim_sha256": hashlib.sha256(claim_path.read_bytes()).hexdigest()}
        digest = hashlib.sha256(b"external-full-suite-fixture").hexdigest()
        resource = command.get("resource")
        receipt = {"schema_version": risk_runtime.FULL_SUITE_SCHEMA,
                   "producer": {"schema_version": risk_runtime.FULL_SUITE_PRODUCER_SCHEMA,
                                "tool_id": risk_runtime.FULL_SUITE_TOOL_ID},
                   "candidate": claim["candidate"], "policy_identity": plan["policy_identity"],
                   "claim": {**claim_ref, "token": token, "attempt_number": 1},
                   "validation_identity": identity, "command": command,
                   "started_at": "2026-08-09T00:00:00Z",
                   "completed_at": "2026-08-09T00:00:01Z",
                   "timing": {
                       "schema_version": risk_runtime.VALIDATION_TIMING_SCHEMA,
                       "states": [
                           {"state": "WAITING_FOR_RESOURCE", "duration_ms": 0},
                           {"state": "SETUP", "duration_ms": 0},
                           {"state": "RUNNING", "duration_ms": 1},
                           {"state": "TEARDOWN", "duration_ms": 0},
                           {"state": "PASSED", "duration_ms": 0},
                       ],
                       "wall_duration_ms": 1, "critical_path_contribution_ms": 1,
                   },
                   "resource": {
                       "id": resource["id"] if resource else None,
                       "lock_identity_sha256": digest if resource else None,
                       "wait_timeout_seconds": (resource["wait_timeout_seconds"]
                                                if resource else None),
                       "owner_diagnostics": None,
                   },
                   "identity": {
                       "command_sha256": digest, "cwd_sha256": digest,
                       "policy_sha256": digest,
                       "candidate_sha": claim["candidate"]["candidate_sha"],
                       "candidate_tree": claim["candidate"]["candidate_tree"],
                   },
                   "result": {"exit_code": 0, "timed_out": False,
                              "stdout": {"sha256": hashlib.sha256(b"").hexdigest(),
                                         "tail": "", "truncated_bytes": 0},
                              "stderr": {"sha256": hashlib.sha256(b"").hexdigest(),
                                         "tail": "", "truncated_bytes": 0}}}
        receipt_path.write_bytes(risk_runtime.canonical(receipt))
        return {"schema_version": risk_runtime.FULL_SUITE_ADMISSION_SCHEMA,
                "state": "COMPLETE", "attempt_number": 1, "token": token,
                "claim": claim_ref,
                "receipt": {"receipt_path": str(receipt_path),
                            "receipt_sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest()}}

    def prepare_failed_resolved_candidate(self) -> tuple[Path, Path, str]:
        self.commit_feature("A", "src/shared.txt", "A\n")
        old_feature = self.commit_feature("B", "src/shared.txt", "B\n")
        self.queue_payload("next")
        conflict = self.queue_payload("next")
        checkout = Path(conflict["candidate_checkout"])
        (checkout / "src/shared.txt").write_text("A+B\n")
        git(checkout, "add", "src/shared.txt")
        self.write_policy("raise SystemExit(13)")
        with self.assertRaises(merge_runtime.MergeValidationError):
            merge_runtime.merge_resolve(self.controller.resolve(), "B")
        status = self.task("status", "B")
        self.assertEqual((status["state"], status["last_queue_outcome"]),
                         ("CONFLICT_RESOLVED", "FAILED_TEST"))
        return checkout, merge_runtime.owner_marker(self.controller.resolve(), checkout), old_feature

    def prepare_legacy_stale_resolved_candidate(self) -> tuple[Path, Path, str, dict]:
        checkout, marker, old_feature = self.prepare_failed_resolved_candidate()
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        attempt = state["tasks"]["B"]["queue_attempt"]
        attempt["outcome"] = "STALE_TARGET"
        attempt.pop("dependency_lock_refusal", None)
        state["tasks"]["B"]["last_queue_outcome"] = "STALE_TARGET"
        historical_attempt = json.loads(json.dumps(attempt))
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        return checkout, marker, old_feature, historical_attempt

    def commit_resolved_repair(self, text: str = "repaired\n") -> str:
        worktree = self.workspaces / "B"
        (worktree / "src/shared.txt").write_text(text)
        git(worktree, "add", "src/shared.txt")
        git(worktree, "commit", "-m", "repair resolved candidate validation")
        self.write_policy()
        return git(worktree, "rev-parse", "HEAD")

    def prepare_moved_finding_reopen(self) -> tuple[Path, Path]:
        self.commit_feature("X", "src/x.py", "x\n")
        self.commit_feature("Y", "src/security/auth.py", "bad\n")
        self.queue_payload("next")
        waiting = self.queue_payload("next")
        checkout = Path(waiting["candidate_checkout"])
        with mock.patch.object(
            merge_runtime, "dispatch_reviewer",
            side_effect=lambda *args, **kwargs: self.fake_review(*args, **kwargs, findings=True),
        ):
            merge_runtime.merge_review(self.controller.resolve(), "Y")
        worktree = self.workspaces / "Y"
        (worktree / "src/security/auth.py").write_text("fixed\n")
        git(worktree, "add", "."); git(worktree, "commit", "-m", "fix findings")
        return checkout, merge_runtime.owner_marker(self.controller.resolve(), checkout)

    def test_security_candidate_awaits_exact_risk_evidence_and_fake_reviews_resume_cas(self) -> None:
        tip = self.commit_feature("X", "src/security/auth.py", "secure = True\n")
        self.counter.write_text("")
        waiting = self.queue_payload("next")
        self.assertEqual(waiting["outcome"], "AWAITING_RISK")
        self.assertEqual(waiting["candidate_sha"], tip)
        self.assertEqual(waiting["risk"]["plan"]["tier"], "high")
        self.assertEqual(waiting["risk"]["plan"]["reviewer_sequence"], ["reviewer_a", "reviewer_b"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertIsNone(waiting["candidate_checkout"])
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review) as dispatch:
            reviewed = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(reviewed["outcome"], "RISK_EVIDENCE_READY")
        self.assertEqual(dispatch.call_count, 2)
        merged = merge_runtime.merge_next(self.controller.resolve(), "X")
        self.assertEqual(merged["candidate_sha"], tip)
        self.assertEqual(merged["outcome"], "MERGED")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), tip)
        self.assertEqual(self.counter.read_text().splitlines(), ["run"])
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])

    def test_merge_status_returns_a_durable_controller_audit_receipt(self) -> None:
        result = self.queue_payload("status")
        reference = result["control_audit"]
        path = Path(reference["path"])
        data = path.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), reference["sha256"])
        receipt = json.loads(data)
        self.assertEqual((receipt["surface"], receipt["operation"], receipt["task_id"]),
                         ("merge", "status", None))
        self.assertEqual(receipt["routing"], {
            "invocation_root": str(self.controller.resolve()), "invocation_role": "controller",
            "effective_root": str(self.controller.resolve()),
        })

    def test_forged_pass_and_absent_evidence_never_authorize_security_cas(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "secure = False\n")
        self.queue_payload("next")
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        attempt = state["tasks"]["X"]["queue_attempt"]
        attempt["risk"]["evidence"] = {"status": "PASS", "candidate_sha": attempt["candidate_sha"]}
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        failed = self.queue("next", "X", check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("canonical receipt reference", failed.stderr)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertEqual(self.task("status", "X")["state"], "AWAITING_RISK")

    def test_low_risk_docs_candidate_uses_zero_review_canonical_evidence(self) -> None:
        tip = self.commit_feature("X", "docs/flow.md", "flow\n")
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            merged = merge_runtime.merge_next(self.controller.resolve())
        self.assertEqual(merged["outcome"], "MERGED")
        self.assertEqual(merged["candidate_sha"], tip)
        self.assertEqual(merged["risk"]["plan"]["tier"], "low")
        self.assertEqual(merged["risk"]["plan"]["reviewer_sequence"], [])
        dispatch.assert_not_called()

    def test_merge_next_persists_truthful_partial_owner_advancement_after_cas(self) -> None:
        owner = self.root / "merge-next-integration-owner"
        git(self.repository, "worktree", "add", "--detach", str(owner), self.base)
        git(self.repository, "config", "extensions.worktreeConfig", "true")
        git(owner, "config", "--worktree", "juno.workspace.role", "integration-owner")
        git(owner, "config", "--worktree", "juno.workspace.roleAuthority",
            merge_runtime.INTEGRATION_OWNER_AUTHORITY)
        git(owner, "config", "--worktree", "juno.workspace.roleBase", self.base)
        git(self.repository, "config", merge_runtime.INTEGRATION_OWNER_CONFIG, str(owner))
        candidate = self.commit_feature("X", "docs/owner-race.md", "race\n")
        original_run = merge_runtime.task_runtime.run

        def race_after_cas(argv: list[str], cwd: Path, **kwargs: object) -> subprocess.CompletedProcess[str]:
            result = original_run(argv, cwd, **kwargs)
            if "update-ref" in argv and argv[-3:] == [
                    "refs/heads/product", candidate, self.base]:
                Path(git(owner, "rev-parse", "--git-path", "index.lock")).touch()
            return result

        with (mock.patch.object(merge_runtime.task_runtime, "run", side_effect=race_after_cas),
              self.assertRaisesRegex(merge_runtime.PostIntegrationError,
                                     "recover with: yy merge next")):
            merge_runtime.merge_next(self.controller.resolve())

        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), candidate)
        self.assertEqual(git(owner, "rev-parse", "HEAD"), self.base)
        state = json.loads((self.controller / ".juno_task/state/tasks.json").read_text())
        record = state["tasks"]["X"]
        attempt = record["queue_attempt"]
        last_attempt = next(iter(state["queues"].values()))["last_attempt"]
        for persisted in (attempt, last_attempt):
            self.assertEqual(persisted["outcome"], "POST_INTEGRATION_OWNER_FAILED")
            self.assertEqual(persisted["recovery_command"], "yy merge next")
            authority = persisted["integration_owner_authority"]
            self.assertEqual(authority["status"], "partial")
            self.assertEqual(authority["target_sha"], candidate)
            self.assertEqual(authority["after"]["head"], self.base)
            self.assertNotEqual(authority["after"]["head"], authority["target_sha"])
        self.assertEqual(record["state"], "MERGING")
        self.assertEqual(record["last_queue_outcome"],
                         "POST_INTEGRATION_OWNER_FAILED")

    def test_target_advanced_refresh_failure_retries_only_incomplete_post_integration_phases(self) -> None:
        candidate = self.commit_feature("X", "docs/post-integration.md", "recover\n")
        completed_refresh = {"schema_version": "juno_managed_controller_runtime.v1",
                             "outcome": "completed", "receipt": {"sha256": "a" * 64}}
        self.runtime_refresh.side_effect = [
            merge_runtime.MergeQueueError("injected managed runtime refresh failure receipt=/tmp/failure.json"),
            completed_refresh,
        ]
        original_cas = merge_runtime.cas_target
        with mock.patch.object(merge_runtime, "cas_target", wraps=original_cas) as cas:
            with self.assertRaisesRegex(merge_runtime.PostIntegrationError,
                                        "recover with: yy merge next"):
                merge_runtime.merge_next(self.controller.resolve())
            self.assertEqual(cas.call_count, 1)
            self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), candidate)
            failed = self.task("status", "X")
            self.assertEqual((failed["state"], failed["last_queue_outcome"]),
                             ("MERGING", "POST_INTEGRATION_RUNTIME_FAILED"))
            phases = failed["queue_attempt"]["post_integration"]
            self.assertEqual(phases["target_advancement"]["status"], "complete")
            self.assertEqual(phases["integration_owner"]["status"], "complete")
            self.assertEqual(phases["managed_runtime_refresh"]["status"], "failed")
            self.assertEqual(phases["kanban_finalization"]["status"], "pending")
            self.assertEqual(phases["recovery_command"], "yy merge next")
            status_row = next(row for row in merge_runtime.status(self.controller.resolve())["tasks"]
                              if row["task_id"] == "X")
            self.assertEqual(status_row["outcome"], "POST_INTEGRATION_RUNTIME_FAILED")
            self.assertEqual(status_row["recovery_command"], "yy merge next")
            self.assertEqual(status_row["post_integration"]["managed_runtime_refresh"]["status"],
                             "failed")

            recovered = merge_runtime.merge_next(self.controller.resolve())

        self.assertEqual(cas.call_count, 1)
        self.assertEqual(recovered["outcome"], "MERGED")
        self.assertTrue(recovered["recovered"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), candidate)
        self.assertEqual(self.runtime_refresh.call_count, 2)
        self.kanban_finalization.assert_called_once()
        final = self.task("status", "X")
        self.assertEqual(final["state"], "MERGED")
        final_phases = final["queue_attempt"]["post_integration"]
        self.assertEqual(final_phases["managed_runtime_refresh"]["status"], "complete")
        self.assertEqual(final_phases["kanban_finalization"]["status"], "complete")

    def test_public_next_recovers_rc32_bootstrap_post_cas_idempotently(self) -> None:
        previous = self.bootstrap_policyless_product_generation("2.1.3-rc.0.32")
        candidate = self.commit_feature("X", "docs/policyless-recovery.md", "recover\n")
        self.runtime_refresh.side_effect = merge_runtime.MergeQueueError(
            "injected post-CAS runtime interruption")

        with self.assertRaisesRegex(merge_runtime.PostIntegrationError,
                                    "recover with: yy merge next"):
            merge_runtime.merge_next(self.controller.resolve())
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), candidate)
        failed = self.task("status", "X")
        self.assertEqual(failed["last_queue_outcome"], "POST_INTEGRATION_RUNTIME_FAILED")
        self.assertEqual(failed["queue_attempt"]["expected_target_sha"], previous)

        # The script CLI is the public yy merge-next implementation. Its fresh
        # process uses the real compatibility engine, not this test's mock.
        recovered = self.queue_payload("next")
        self.assertEqual((recovered["task_id"], recovered["outcome"]), ("X", "MERGED"))
        board_path = self.controller / ".juno_task/runtime/fake-kanban.json"
        board = json.loads(board_path.read_text())
        self.assertEqual((board["X"]["status"], board["X"]["mutation_count"]), ("done", 1))

        successor = self.commit_feature("Y", "docs/policyless-successor.md", "advance\n")
        advanced = self.queue_payload("next")
        self.assertEqual((advanced["task_id"], advanced["outcome"]), ("Y", "MERGED"))
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), successor)
        board = json.loads(board_path.read_text())
        self.assertEqual((board["Y"]["status"], board["Y"]["mutation_count"]), ("done", 1))
        self.assertEqual(board["X"]["mutation_count"], 1)

    def test_kanban_finalization_is_readback_idempotent_and_preserves_response(self) -> None:
        board = self.controller / ".juno_task/runtime/fake-board.json"
        board.parent.mkdir(parents=True, exist_ok=True)
        board.write_text(json.dumps({
            "id": "X", "status": "in_progress", "commit_hash": None,
            "agent_response": "reviewed implementation evidence",
        }))
        wrapper = self.controller / ".juno_task/scripts/kanban.sh"
        wrapper.write_text(f"""#!/usr/bin/env python3
import json, pathlib, sys
board = pathlib.Path({str(board)!r})
value = json.loads(board.read_text())
if 'get' in sys.argv:
    print(json.dumps([value])); raise SystemExit(0)
if 'mark' in sys.argv:
    value['status'] = 'done'
    value['commit_hash'] = sys.argv[sys.argv.index('--commit') + 1]
    value['agent_response'] = pathlib.Path(sys.argv[sys.argv.index('--response-file') + 1]).read_text()
    value['mutation_count'] = value.get('mutation_count', 0) + 1
    board.write_text(json.dumps(value))
    receipt = pathlib.Path(sys.argv[sys.argv.index('--receipt-file') + 1])
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({{'outcome': 'completed'}}) + '\\n')
    raise SystemExit(0)
raise SystemExit(2)
""")
        wrapper.chmod(0o755)
        attempt = {"task_id": "X", "candidate_sha": self.base}

        first = merge_runtime.finalize_kanban_task(self.controller, attempt)
        second = merge_runtime.finalize_kanban_task(self.controller, attempt)

        self.assertEqual(first["outcome"], "completed")
        self.assertEqual(second["outcome"], "already_complete")
        persisted = json.loads(board.read_text())
        self.assertEqual(persisted["mutation_count"], 1)
        self.assertEqual(persisted["agent_response"], "reviewed implementation evidence")
        self.assertEqual(persisted["commit_hash"], self.base)

    def test_multi_commit_direct_candidate_is_planned_from_full_target_diff(self) -> None:
        self.task("start", "X")
        worktree = self.workspaces / "X"
        (worktree / "src/one.py").write_text("one\n")
        git(worktree, "add", "."); git(worktree, "commit", "-m", "one")
        (worktree / "src/two.py").write_text("two\n")
        git(worktree, "add", "."); git(worktree, "commit", "-m", "two")
        tip = git(worktree, "rev-parse", "HEAD")
        self.task("finish", "X")
        merged = self.queue_payload("next")
        self.assertEqual(merged["candidate_sha"], tip)
        self.assertEqual(merged["risk"]["plan"]["candidate"]["changed_paths"],
                         ["src/one.py", "src/two.py"])

    def test_moved_high_risk_candidate_preserves_one_checkout_and_invalidates_on_target_move(self) -> None:
        self.commit_feature("X", "src/x.py", "x\n")
        self.commit_feature("Y", "src/security/auth.py", "auth\n")
        x = self.queue_payload("next")["candidate_sha"]
        waiting = self.queue_payload("next")
        checkout = Path(waiting["candidate_checkout"])
        candidate = waiting["candidate_sha"]
        self.assertTrue(checkout.is_dir())
        self.assertEqual(git(checkout, "rev-parse", "HEAD"), candidate)
        tree = git(self.repository, "rev-parse", "refs/heads/product^{tree}")
        moved = git(self.repository, "commit-tree", tree, "-p", x, "-m", "external")
        git(self.repository, "update-ref", "refs/heads/product", moved, x)
        invalidated = self.queue_payload("next", "Y")
        self.assertEqual(invalidated["outcome"], "RISK_TARGET_MOVED")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), moved)
        self.assertFalse(checkout.exists())
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])
        self.assertEqual(self.task("status", "Y")["state"], "QUEUED")
        waiting_again = self.queue_payload("next")
        checkout_again = Path(waiting_again["candidate_checkout"])
        current = git(self.repository, "rev-parse", "refs/heads/product")
        tree = git(self.repository, "rev-parse", "refs/heads/product^{tree}")
        moved_again = git(self.repository, "commit-tree", tree, "-p", current, "-m", "external again")
        git(self.repository, "update-ref", "refs/heads/product", moved_again, current)
        self.assertEqual(self.queue_payload("next", "Y")["outcome"], "RISK_TARGET_MOVED")
        self.assertFalse(checkout_again.exists())
        self.assertEqual(self.registered_candidate_paths(), [])

    def test_review_finding_preserves_awaiting_truth_and_does_zero_cas(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        def finding(*args: object, **kwargs: object) -> dict[str, str]:
            return self.fake_review(*args, **kwargs, findings=True)
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=finding):
            reviewed = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(reviewed["outcome"], "REVIEW_FINDINGS")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertEqual(self.task("status", "X")["state"], "REVIEW_FINDINGS")

    def test_one_repair_round_exhausts_instead_of_starting_an_unbounded_review_loop(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "broken\n")
        self.queue_payload("next")
        finding = lambda *args, **kwargs: self.fake_review(*args, **kwargs, findings=True)
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=finding):
            first = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(first["outcome"], "REVIEW_FINDINGS")
        self.assertEqual(self.task("status", "X")["review_round"], 1)

        worktree = self.workspaces / "X"
        (worktree / "src/security/auth.py").write_text("repair\n")
        git(worktree, "add", ".")
        git(worktree, "commit", "-m", "consolidated repair")
        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "X")
        self.assertEqual(reopened["review_round"], 2)
        self.queue_payload("next")
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=finding):
            second = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(second["outcome"], "REVIEW_FINDINGS_EXHAUSTED")
        self.assertEqual(self.task("status", "X")["state"],
                         "REVIEW_FINDINGS_EXHAUSTED")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError,
                                    "review budget exhausted"):
            merge_runtime.merge_reopen(self.controller.resolve(), "X")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)

    def test_review_findings_clear_stale_failure_from_an_earlier_attempt(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with mock.patch.object(
                merge_runtime, "dispatch_reviewer",
                side_effect=merge_runtime.MergeQueueError("transport down")):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "transport down"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        failed = self.task("status", "X")["queue_attempt"]
        self.assertEqual(failed["outcome"], "REVIEW_FAILED")
        self.assertEqual(failed["risk_failure"], "transport down")

        with mock.patch.object(
                merge_runtime, "dispatch_reviewer",
                side_effect=lambda *args, **kwargs: self.fake_review(
                    *args, **kwargs, findings=True)):
            finding = merge_runtime.merge_review(self.controller.resolve(), "X")

        self.assertEqual(finding["outcome"], "REVIEW_FINDINGS")
        self.assertNotIn("risk_failure", finding)
        persisted = self.task("status", "X")["queue_attempt"]
        self.assertEqual(persisted["outcome"], "REVIEW_FINDINGS")
        self.assertNotIn("risk_failure", persisted)

    def test_reviewer_a_pass_b_transport_failure_retries_only_b_in_fresh_namespace(self) -> None:
        tip = self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        calls: list[tuple[str, int]] = []
        def fail_b(*args: object, **kwargs: object) -> dict[str, str]:
            reviewer, attempt_number = str(args[4]), int(args[7])
            calls.append((reviewer, attempt_number))
            if reviewer == "reviewer_b":
                raise merge_runtime.MergeQueueError("transport down")
            return self.fake_review(*args, **kwargs)
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=fail_b):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "transport down"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        progress = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        self.assertEqual(progress["attempt_counter"], 1)
        self.assertEqual([step["reviewer"] for step in progress["steps"]], ["reviewer_a"])
        retry_calls: list[tuple[str, int]] = []
        def retry(*args: object, **kwargs: object) -> dict[str, str]:
            retry_calls.append((str(args[4]), int(args[7])))
            return self.fake_review(*args, **kwargs)
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=retry):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(calls, [("reviewer_a", 1), ("reviewer_b", 1)])
        self.assertEqual(retry_calls, [("reviewer_b", 2)])
        self.assertEqual(ready["outcome"], "RISK_EVIDENCE_READY")
        status_row = next(row for row in self.queue_payload("status")["tasks"]
                          if row["task_id"] == "X")
        self.assertEqual(status_row["review_attempt_counter"], 2)
        self.assertEqual(merge_runtime.merge_next(self.controller.resolve(), "X")["candidate_sha"], tip)

    def test_reviewer_a_transport_failure_retries_fresh_a_then_b(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with mock.patch.object(
            merge_runtime, "dispatch_reviewer",
            side_effect=merge_runtime.MergeQueueError("A transport down"),
        ):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "A transport down"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        progress = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        self.assertEqual((progress["attempt_counter"], progress["steps"]), (1, []))
        calls: list[tuple[str, int]] = []
        def retry(*args: object, **kwargs: object) -> dict[str, str]:
            calls.append((str(args[4]), int(args[7])))
            return self.fake_review(*args, **kwargs)
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=retry):
            merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(calls, [("reviewer_a", 2), ("reviewer_b", 2)])

    def test_changed_failing_validation_identity_stops_b_and_zero_cas(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        def fail_b(*args: object, **kwargs: object) -> dict[str, str]:
            if args[4] == "reviewer_b":
                raise merge_runtime.MergeQueueError("B down")
            return self.fake_review(*args, **kwargs)
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=fail_b):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "B down"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        self.write_policy(full_code="import sys; sys.exit(17)")
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaises(merge_runtime.MergeValidationError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        progress = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        self.assertNotIn("full_validation_passed", progress)
        self.assertEqual([step["reviewer"] for step in progress["steps"]], ["reviewer_a"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)

    def test_forged_boolean_cache_runs_failing_suite_and_dispatches_no_reviewer(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        progress = {"schema_version": "juno_merge_queue_review_progress.v3",
                    "attempt_counter": 0, "full_suite_admission": None, "steps": [],
                    "full_validation_passed": True,
                    "validation_identity": {"sha256": "f" * 64}}
        state["tasks"]["X"]["queue_attempt"]["risk"]["review_progress"] = progress
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        fail = (f"from pathlib import Path; Path({str(self.full_counter)!r}).open('a').write('run\\n'); "
                "raise SystemExit(19)")
        self.write_policy(full_code=fail)
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaises(merge_runtime.MergeValidationError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])
        admission = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        self.assertEqual(admission["full_suite_admission"]["state"], "FAILED")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)

    def test_failed_suite_then_success_uses_fresh_attempt_and_reaches_reviewers(self) -> None:
        flaky = (f"from pathlib import Path; import sys; p=Path({str(self.full_counter)!r}); "
                 "n=len(p.read_text().splitlines()) if p.exists() else 0; "
                 "p.open('a').write('run\\n'); sys.exit(23 if n == 0 else 0)")
        self.write_policy(full_code=flaky)
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        affected_validation = self.task("status", "X")["queue_attempt"]["validation"]
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaises(merge_runtime.MergeValidationError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        failed_attempt = self.task("status", "X")["queue_attempt"]
        self.assertEqual(failed_attempt["validation"], affected_validation)
        failed = failed_attempt["risk"]["review_progress"]
        self.assertEqual((failed["full_suite_admission"]["state"],
                          failed["full_suite_admission"]["attempt_number"]), ("FAILED", 1))
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review) as dispatch:
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual((ready["outcome"], dispatch.call_count), ("RISK_EVIDENCE_READY", 2))
        self.assertEqual(ready["validation"], affected_validation)
        self.assertTrue(all(row["id"] != "full-suite" for row in ready["validation"]))
        complete = ready["risk"]["review_progress"]["full_suite_admission"]
        self.assertEqual((complete["state"], complete["attempt_number"]), ("COMPLETE", 2))
        receipt = json.loads(Path(complete["receipt"]["receipt_path"]).read_text())
        self.assertEqual(receipt["timing"]["schema_version"], "juno_validation_timing.v1")
        self.assertEqual([item["state"] for item in receipt["timing"]["states"]],
                         ["WAITING_FOR_RESOURCE", "SETUP", "RUNNING", "TEARDOWN", "PASSED"])
        self.assertEqual(set(receipt["identity"]), {"command_sha256", "cwd_sha256",
                                                   "policy_sha256", "candidate_sha", "candidate_tree"})
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run", "run"])

    def test_failed_suite_new_tip_reopens_and_requeues_the_repair(self) -> None:
        self.write_policy(full_code="raise SystemExit(23)")
        self.commit_feature("X", "src/security/auth.py", "broken\n")
        self.queue_payload("next")
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaises(merge_runtime.MergeValidationError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        worktree = self.workspaces / "X"
        (worktree / "src/security/auth.py").write_text("fixed\n")
        git(worktree, "add", ".")
        git(worktree, "commit", "-m", "repair full suite")
        repaired_tip = git(worktree, "rev-parse", "HEAD")

        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "X")

        self.assertEqual(reopened["outcome"], "REQUEUED_AFTER_FULL_SUITE_FAILURE")
        self.assertEqual((reopened["state"], reopened["tip_sha"]), ("QUEUED", repaired_tip))
        self.assertEqual(self.queue_payload("next")["candidate_sha"], repaired_tip)

    def test_failed_affected_validation_new_tip_reopens_and_requeues_the_repair(self) -> None:
        self.commit_feature("X", "src/x.py", "broken\n")
        self.write_policy(code="raise SystemExit(17)")
        with self.assertRaises(merge_runtime.MergeValidationError):
            merge_runtime.merge_next(self.controller.resolve())
        failed = self.task("status", "X")
        self.assertEqual((failed["state"], failed["last_queue_outcome"]),
                         ("QUEUED", "FAILED_TEST"))
        worktree = self.workspaces / "X"
        (worktree / "src/x.py").write_text("fixed\n")
        git(worktree, "add", ".")
        git(worktree, "commit", "-m", "repair affected validation")
        repaired_tip = git(worktree, "rev-parse", "HEAD")
        self.write_policy()

        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "X")

        self.assertEqual(reopened["outcome"], "REQUEUED_AFTER_VALIDATION_FAILURE")
        self.assertEqual((reopened["state"], reopened["tip_sha"]), ("QUEUED", repaired_tip))

    def test_queued_task_new_tip_refreshes_without_manufacturing_a_failure(self) -> None:
        old_tip = self.commit_feature("X", "src/x.py", "first\n")
        worktree = self.workspaces / "X"
        (worktree / "src/x.py").write_text("second\n")
        git(worktree, "add", ".")
        git(worktree, "commit", "-m", "follow-up")
        new_tip = git(worktree, "rev-parse", "HEAD")

        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "X")

        self.assertNotEqual(old_tip, new_tip)
        self.assertEqual(reopened["outcome"], "REQUEUED_AFTER_TIP_REFRESH")
        self.assertEqual((reopened["state"], reopened["tip_sha"]), ("QUEUED", new_tip))
        self.assertEqual(reopened["reopened_from_candidate_sha"], old_tip)
        self.assertNotIn("queue_attempt", reopened)
        self.assertEqual(self.counter.read_text().splitlines(), ["run", "run"])

    def test_queued_target_refresh_validates_only_target_to_refreshed_tip(self) -> None:
        self.commit_feature("X", "src/x.py", "feature\n")
        self.advance_target("target-derived/outside-task-admission.txt")
        refreshed_tip = self.merge_target_into("X")

        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "X")

        self.assertEqual((reopened["state"], reopened["tip_sha"]),
                         ("QUEUED", refreshed_tip))
        self.assertEqual(reopened["changed_paths"], ["src/x.py"])

    def test_prior_findings_survive_repairs_and_legacy_nonreviewed_refresh_links(self) -> None:
        findings_tip = self.commit_feature("X", "src/security/auth.py", "broken\n")
        self.queue_payload("next")
        with mock.patch.object(
                merge_runtime, "dispatch_reviewer",
                side_effect=lambda *args, **kwargs: self.fake_review(
                    *args, **kwargs, findings=True)):
            finding = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(finding["outcome"], "REVIEW_FINDINGS")

        worktree = self.workspaces / "X"
        (worktree / "src/security/auth.py").write_text("fixed\n")
        git(worktree, "add", ".")
        git(worktree, "commit", "-m", "repair findings")
        repaired = merge_runtime.merge_reopen(self.controller.resolve(), "X")
        repaired_tip = repaired["tip_sha"]
        self.assertEqual(repaired["prior_findings_candidate_sha"], findings_tip)

        (worktree / "src/security/auth.py").write_text("fixed again\n")
        git(worktree, "add", ".")
        git(worktree, "commit", "-m", "queued follow-up")
        refreshed = merge_runtime.merge_reopen(self.controller.resolve(), "X")
        self.assertEqual(refreshed["prior_findings_candidate_sha"], findings_tip)
        self.queue_payload("next")
        record = self.task("status", "X")
        plan = record["queue_attempt"]["risk"]["plan"]

        summary, references = merge_runtime.prior_findings_summary(
            self.controller.resolve(), record, plan)
        self.assertIn(findings_tip, summary)
        self.assertIn("SEC [high]: finding", summary)
        self.assertIn(findings_tip, references)

        legacy = dict(record)
        legacy.pop("prior_findings_candidate_sha")
        legacy["reopened_from_candidate_sha"] = repaired_tip
        legacy_evidence = (self.controller / ".juno_task/runtime/merge-queue/evidence/X"
                           / f"{repaired_tip}.attempt-1.json")
        legacy_evidence.write_text(json.dumps({
            "candidate": {
                "candidate_sha": repaired_tip,
                "base_sha": plan["candidate"]["base_sha"],
                "target_ref": plan["candidate"]["target_ref"],
            },
            "created_at": "2099-01-01T00:00:00Z",
            "reviews": [{"verdict": "pass"}],
        }))
        recovered, _ = merge_runtime.prior_findings_summary(
            self.controller.resolve(), legacy, plan)
        self.assertIn(findings_tip, recovered)
        self.assertIn("SEC [high]: finding", recovered)

    def test_full_suite_receipt_fits_tails_inside_the_whole_artifact_bound(self) -> None:
        stdout = ("large output ☃\n" * 8000)
        stderr = ("warning\n" * 2000)
        receipt = {"metadata": "kept", "result": {
            "stdout": {"tail": stdout, "truncated_bytes": 11},
            "stderr": {"tail": stderr, "truncated_bytes": 7},
        }}

        fitted = merge_runtime.fit_full_suite_receipt(receipt, 65_536)

        self.assertLessEqual(len(risk_runtime.canonical(fitted)), 65_536)
        for name, original, prior in (("stdout", stdout, 11), ("stderr", stderr, 7)):
            tail = fitted["result"][name]["tail"]
            self.assertTrue(original.endswith(tail))
            self.assertEqual(
                fitted["result"][name]["truncated_bytes"] + len(tail.encode()),
                prior + len(original.encode()),
            )

    def test_timeout_then_success_uses_fresh_attempt(self) -> None:
        self.write_policy(full_code="import time; time.sleep(3)")
        config_path = self.controller / ".juno_task/config/task-workspace.json"
        config = json.loads(config_path.read_text()); config["full_suite_validation"]["timeout_seconds"] = 1
        config_path.write_text(json.dumps(config) + "\n")
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaises(merge_runtime.MergeValidationError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        failed = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        self.assertTrue(failed["full_suite_admission"]["failure"]["timed_out"])
        self.write_policy()
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(ready["outcome"], "RISK_EVIDENCE_READY")
        self.assertEqual(ready["risk"]["review_progress"]["full_suite_admission"]["attempt_number"], 2)

    def test_repeated_failed_suites_keep_distinct_immutable_attempts(self) -> None:
        fail = (f"from pathlib import Path; Path({str(self.full_counter)!r}).open('a').write('run\\n'); "
                "raise SystemExit(19)")
        self.write_policy(full_code=fail)
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            for _ in range(2):
                with self.assertRaises(merge_runtime.MergeValidationError):
                    merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        root = self.controller / ".juno_task/state/merge-queue/full-suite/X"
        attempts = sorted(path.name for path in next(root.iterdir()).iterdir())
        self.assertEqual(attempts, ["attempt-1", "attempt-2"])
        for name in attempts:
            self.assertTrue((next(root.iterdir()) / name / "claim.json").is_file())
            self.assertTrue((next(root.iterdir()) / name / "receipt.json").is_file())
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run", "run"])

    def test_restart_from_claimed_failed_receipt_marks_failed_without_reviewer(self) -> None:
        self.write_policy(full_code="raise SystemExit(31)")
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        original = merge_runtime.persist_attempt
        def crash_failed_write(*args: object, **kwargs: object) -> None:
            admission = ((((args[1].get("risk") or {}).get("review_progress") or {})
                          .get("full_suite_admission")) or {})
            if admission.get("state") == "FAILED":
                raise OSError("crash before failed admission")
            original(*args, **kwargs)
        with mock.patch.object(merge_runtime, "persist_attempt", side_effect=crash_failed_write):
            with self.assertRaisesRegex(OSError, "crash before failed admission"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
                         ["full_suite_admission"]["state"], "CLAIMED")
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaises(merge_runtime.MergeValidationError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        recovered = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        self.assertEqual(recovered["full_suite_admission"]["state"], "FAILED")
        self.assertEqual((recovered["attempt_counter"],
                          recovered["full_suite_admission"]["attempt_number"]), (1, 1))
        self.write_policy()
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        complete = ready["risk"]["review_progress"]["full_suite_admission"]
        self.assertEqual((complete["state"], complete["attempt_number"]), ("COMPLETE", 2))

    def test_tampered_claimed_failed_receipt_fails_closed_without_retry(self) -> None:
        self.write_policy(full_code="raise SystemExit(31)")
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        original = merge_runtime.persist_attempt
        def crash_failed_write(*args: object, **kwargs: object) -> None:
            admission = ((((args[1].get("risk") or {}).get("review_progress") or {})
                          .get("full_suite_admission")) or {})
            if admission.get("state") == "FAILED":
                raise OSError("crash before failed admission")
            original(*args, **kwargs)
        with mock.patch.object(merge_runtime, "persist_attempt", side_effect=crash_failed_write):
            with self.assertRaises(OSError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        claimed = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        Path(claimed["full_suite_admission"]["expected_receipt_path"]).write_text("{}\n")
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaises(merge_runtime.MergeQueueError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        current = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        self.assertEqual(current["full_suite_admission"]["state"], "CLAIMED")

    def test_tampered_failed_token_digest_and_result_hard_refuse_without_fresh_attempt(self) -> None:
        fail = (f"from pathlib import Path; Path({str(self.full_counter)!r}).open('a').write('run\\n'); "
                "raise SystemExit(19)")
        self.write_policy(full_code=fail)
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with self.assertRaises(merge_runtime.MergeValidationError):
            merge_runtime.merge_review(self.controller.resolve(), "X")
        state_path = self.controller / ".juno_task/state/tasks.json"
        canonical_state = json.loads(state_path.read_text())
        for mutation in ("token", "digest", "result"):
            with self.subTest(mutation=mutation):
                state = json.loads(json.dumps(canonical_state))
                admission = state["tasks"]["X"]["queue_attempt"]["risk"] \
                    ["review_progress"]["full_suite_admission"]
                if mutation == "token": admission["token"] = "b" * 48
                elif mutation == "digest": admission["claim"]["claim_sha256"] = "f" * 64
                else: admission["failure"]["exit_code"] = 0
                state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
                with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
                    with self.assertRaises(merge_runtime.MergeQueueError):
                        merge_runtime.merge_review(self.controller.resolve(), "X")
                dispatch.assert_not_called()
        state_path.write_text(json.dumps(canonical_state, sort_keys=True, separators=(",", ":")) + "\n")
        progress = canonical_state["tasks"]["X"]["queue_attempt"]["risk"]["review_progress"]
        self.assertEqual(progress["attempt_counter"], 1)
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])

    def test_malformed_failed_admission_state_hard_refuses_without_work(self) -> None:
        self.write_policy(full_code="raise SystemExit(19)")
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with self.assertRaises(merge_runtime.MergeValidationError):
            merge_runtime.merge_review(self.controller.resolve(), "X")
        state_path = self.controller / ".juno_task/state/tasks.json"
        canonical_state = json.loads(state_path.read_text())
        admission = canonical_state["tasks"]["X"]["queue_attempt"]["risk"] \
            ["review_progress"]["full_suite_admission"]
        self.assertEqual(admission["state"], "FAILED")
        self.assert_malformed_admission_states_refuse(canonical_state)

    def test_malformed_complete_admission_state_hard_refuses_without_work(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with mock.patch.object(
                merge_runtime, "dispatch_reviewer",
                side_effect=merge_runtime.MergeQueueError("stop after complete")):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "stop after complete"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        state_path = self.controller / ".juno_task/state/tasks.json"
        canonical_state = json.loads(state_path.read_text())
        admission = canonical_state["tasks"]["X"]["queue_attempt"]["risk"] \
            ["review_progress"]["full_suite_admission"]
        self.assertEqual(admission["state"], "COMPLETE")
        self.assert_malformed_admission_states_refuse(canonical_state)

    def test_malformed_claimed_admission_state_hard_refuses_without_work(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with mock.patch.object(
                merge_runtime, "full_suite_validation", side_effect=OSError("crash after claim")):
            with self.assertRaisesRegex(OSError, "crash after claim"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        state_path = self.controller / ".juno_task/state/tasks.json"
        canonical_state = json.loads(state_path.read_text())
        admission = canonical_state["tasks"]["X"]["queue_attempt"]["risk"] \
            ["review_progress"]["full_suite_admission"]
        self.assertEqual(admission["state"], "CLAIMED")
        self.assert_malformed_admission_states_refuse(canonical_state)

    def test_external_boolean_only_risk_receipt_is_replaced_by_real_full_suite(self) -> None:
        tip = self.commit_feature("X", "src/security/auth.py", "auth\n")
        config = merge_runtime.task_runtime.load_config(self.controller.resolve())
        record = merge_runtime.task_runtime.read_state(self.controller.resolve())["tasks"]["X"]
        policy = risk_runtime.load_policy(self.controller / ".juno_task/config/risk-policy.json")
        request = merge_runtime.risk_request(
            self.repository.resolve(), tip, config["target_ref"], self.base)
        plan = risk_runtime.classify(policy, request, [])
        candidate = (self.workspaces / "X").resolve()
        identity = merge_runtime.full_validation_identity(
            self.controller.resolve(), config, record, candidate, tip)
        admission = self.external_full_suite_admission(
            plan, identity, merge_runtime.full_suite_command(config))
        reviews = [self.fake_review(self.controller, candidate, plan, "X", "reviewer_a", 1, None, 1)]
        reviews.append(self.fake_review(
            self.controller, candidate, plan, "X", "reviewer_b", 2,
            Path(reviews[0]["runner_receipt_path"]), 1))
        forged = risk_runtime.finalize(
            plan, request, affected_tests_passed=True, full_suite_admission=admission,
            reviews=reviews, metrics={"model_calls": 2, "affected_test_runs": 1,
                                      "full_suite_runs": 1}, policy=policy)
        seed_path = merge_runtime.evidence_path(self.controller.resolve(), "X", tip)
        risk_runtime.atomic_receipt(seed_path, forged, policy)
        self.full_counter.write_text("")
        self.assertEqual(self.queue_payload("next")["outcome"], "AWAITING_RISK")
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(ready["outcome"], "RISK_EVIDENCE_READY")
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)

    def test_external_state_admission_is_ignored_and_queue_suite_runs_once(self) -> None:
        tip = self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        config = merge_runtime.task_runtime.load_config(self.controller.resolve())
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        record = state["tasks"]["X"]
        plan = record["queue_attempt"]["risk"]["plan"]
        identity = merge_runtime.full_validation_identity(
            self.controller.resolve(), config, record, (self.workspaces / "X").resolve(), tip)
        external = self.external_full_suite_admission(
            plan, identity, merge_runtime.full_suite_command(config))
        record["queue_attempt"]["risk"]["review_progress"] = {
            "schema_version": "juno_merge_queue_review_progress.v3",
            "attempt_counter": 0, "full_suite_admission": external, "steps": []}
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(ready["outcome"], "RISK_EVIDENCE_READY")
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])
        admitted = ready["risk"]["review_progress"]["full_suite_admission"]
        self.assertIn("/.juno_task/state/merge-queue/full-suite/", admitted["claim"]["claim_path"])

    def test_preexisting_canonical_claim_collision_refuses_then_fresh_attempt_succeeds(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        waiting = self.queue_payload("next")
        claim, _ = merge_runtime.full_suite_attempt_paths(
            self.controller.resolve(), "X", waiting["candidate_sha"], 1)
        claim.parent.mkdir(parents=True, exist_ok=True); claim.write_text("attacker\n")
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "already exists"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        self.assertFalse(self.full_counter.exists())
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(ready["outcome"], "RISK_EVIDENCE_READY")
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])
        self.assertEqual(ready["risk"]["review_progress"]["full_suite_admission"]["attempt_number"], 2)

    def test_claimed_receipt_crash_recovers_without_rerunning_suite(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        original = merge_runtime.persist_attempt
        failed = False
        def fail_complete(*args: object, **kwargs: object) -> None:
            nonlocal failed
            attempt = args[1]
            admission = ((attempt.get("risk") or {}).get("review_progress") or {}).get(
                "full_suite_admission")
            if not failed and isinstance(admission, dict) and admission.get("state") == "COMPLETE":
                failed = True
                raise OSError("complete state crash")
            original(*args, **kwargs)
        with mock.patch.object(merge_runtime, "persist_attempt", side_effect=fail_complete):
            with self.assertRaisesRegex(OSError, "complete state crash"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        status = self.task("status", "X")
        self.assertEqual(status["queue_attempt"]["risk"]["review_progress"]
                         ["full_suite_admission"]["state"], "CLAIMED")
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(ready["outcome"], "RISK_EVIDENCE_READY")
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])

    def test_claimed_without_receipt_retries_at_fresh_attempt(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        with mock.patch.object(
            merge_runtime, "full_suite_validation",
            side_effect=merge_runtime.MergeQueueError("crash before suite"),
        ):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "crash before suite"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        claimed = self.task("status", "X")["queue_attempt"]["risk"]["review_progress"]
        self.assertEqual(claimed["full_suite_admission"]["state"], "CLAIMED")
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        complete = ready["risk"]["review_progress"]["full_suite_admission"]
        self.assertEqual((complete["state"], complete["attempt_number"]), ("COMPLETE", 1))
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])

    def test_missing_risk_policy_fails_closed_before_reviewer(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        self.queue_payload("next")
        (self.controller / ".juno_task/config/risk-policy.json").unlink()
        with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
            with self.assertRaises(merge_runtime.MergeQueueError):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)

    def test_awaiting_risk_does_not_starve_low_risk_fifo_work(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        y_tip = self.commit_feature("Y", "docs/y.md", "y\n")
        self.assertEqual(self.queue_payload("next")["outcome"], "AWAITING_RISK")
        merged = self.queue_payload("next")
        self.assertEqual((merged["task_id"], merged["candidate_sha"]), ("Y", y_tip))
        self.assertEqual(self.task("status", "X")["state"], "AWAITING_RISK")

    def test_bare_next_preserves_enqueue_fifo_not_task_id_order(self) -> None:
        y_tip = self.commit_feature("Y", "docs/y.md", "y\n")
        self.commit_feature("X", "docs/x.md", "x\n")
        first = self.queue_payload("next")
        self.assertEqual((first["task_id"], first["candidate_sha"]), ("Y", y_tip))

    def test_awaiting_release_does_not_starve_queued_work(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        y_tip = self.commit_feature("Y", "docs/y.md", "y\n")
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        state["tasks"]["X"]["risk_flags"] = ["release"]
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        self.assertEqual(self.queue_payload("next")["outcome"], "AWAITING_RELEASE")
        merged = self.queue_payload("next")
        self.assertEqual((merged["task_id"], merged["candidate_sha"]), ("Y", y_tip))
        self.assertEqual(self.task("status", "X")["state"], "AWAITING_RELEASE")

    def test_long_x_review_does_not_hold_target_lock_and_moved_x_cleans_safely(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        y_tip = self.commit_feature("Y", "docs/y.md", "y\n")
        waiting = self.queue_payload("next")
        self.assertEqual(waiting["task_id"], "X")
        started, release = threading.Event(), threading.Event()
        calls: list[str] = []
        def blocked(*args: object, **kwargs: object) -> dict[str, str]:
            calls.append(str(args[4]))
            if args[4] == "reviewer_a":
                started.set()
                if not release.wait(10):
                    raise AssertionError("test reviewer was not released")
            return self.fake_review(*args, **kwargs)
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=blocked):
            with ThreadPoolExecutor(max_workers=2) as pool:
                future = pool.submit(merge_runtime.merge_review, self.controller.resolve(), "X")
                self.assertTrue(started.wait(10))
                with self.assertRaisesRegex(merge_runtime.MergeQueueError, "another reviewer owns"):
                    merge_runtime.merge_review(self.controller.resolve(), "X")
                merged_y = merge_runtime.merge_next(self.controller.resolve())
                self.assertEqual(merged_y["candidate_sha"], y_tip)
                release.set()
                moved_x = future.result(timeout=20)
        self.assertEqual(moved_x["outcome"], "RISK_TARGET_MOVED")
        self.assertEqual(calls, ["reviewer_a"])
        self.assertEqual(self.task("status", "X")["state"], "QUEUED")
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])

    def test_target_move_during_full_suite_dispatches_zero_reviewers_and_cleans(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "auth\n")
        y_tip = self.commit_feature("Y", "docs/y.md", "y\n")
        waiting = self.queue_payload("next")
        self.assertEqual(waiting["task_id"], "X")
        original = merge_runtime.full_suite_validation
        def suite_then_move(*args: object, **kwargs: object) -> dict[str, str]:
            reference = original(*args, **kwargs)
            self.assertEqual(merge_runtime.merge_next(self.controller.resolve())["candidate_sha"], y_tip)
            return reference
        with mock.patch.object(merge_runtime, "full_suite_validation", side_effect=suite_then_move):
            with mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch:
                moved = merge_runtime.merge_review(self.controller.resolve(), "X")
        dispatch.assert_not_called()
        self.assertEqual(moved["outcome"], "RISK_TARGET_MOVED")
        self.assertEqual(self.task("status", "X")["state"], "QUEUED")
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])

    def test_finding_reopen_new_tip_discards_exact_owned_moved_candidate_and_requeues(self) -> None:
        checkout, marker = self.prepare_moved_finding_reopen()
        old_candidate = git(checkout, "rev-parse", "HEAD")
        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        self.assertEqual(reopened["outcome"], "REQUEUED_AFTER_FINDINGS")
        self.assertFalse(checkout.exists())
        self.assertFalse(marker.exists())
        self.assertEqual(self.task("status", "Y")["state"], "QUEUED")
        again = self.queue_payload("next")
        self.assertEqual(again["outcome"], "AWAITING_RISK")
        self.assertNotEqual(again["candidate_sha"], old_candidate)

    def test_finding_reopen_admits_byte_exact_managed_destination_bound_to_admitted_source(self) -> None:
        self.commit_feature("X", "src/security/auth.py", "bad\n")
        self.queue_payload("next")
        with mock.patch.object(
            merge_runtime, "dispatch_reviewer",
            side_effect=lambda *args, **kwargs: self.fake_review(
                *args, **kwargs, findings=True),
        ):
            merge_runtime.merge_review(self.controller.resolve(), "X")

        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        state["tasks"]["X"]["creation_receipt"]["generated_output_admission"] = {
            "schema_version": "juno_task_generated_output_admission.v1",
            "bindings": [{
                "kind": "managed",
                "source": "src/security/auth.py",
                "destination": "docs/generated-auth.py",
            }],
        }
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")

        worktree = self.workspaces / "X"
        (worktree / "src/security/auth.py").write_text("fixed\n")
        (worktree / "docs").mkdir(exist_ok=True)
        (worktree / "docs/generated-auth.py").write_text("fixed\n")
        git(worktree, "add", ".")
        git(worktree, "commit", "-m", "repair source and managed destination")

        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "X")

        self.assertEqual(reopened["outcome"], "REQUEUED_AFTER_FINDINGS")
        self.assertEqual(
            reopened["changed_paths"],
            ["docs/generated-auth.py", "src/security/auth.py"],
        )

    def test_failed_resolved_validation_descendant_repair_reopens_and_requeues(self) -> None:
        checkout, marker, old_feature = self.prepare_failed_resolved_candidate()
        old_candidate = git(checkout, "rev-parse", "HEAD")
        repaired_tip = self.commit_resolved_repair()
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        state["tasks"]["B"]["prior_findings_candidate_sha"] = "f" * 40
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")

        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        original_policy = policy_path.read_bytes()
        narrowed = json.loads(original_policy)
        narrowed["allowed_paths"] = ["current-policy-no-longer-admits-src"]
        policy_path.write_text(json.dumps(narrowed, indent=2) + "\n")
        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "B")
        policy_path.write_bytes(original_policy)

        self.assertEqual(reopened["outcome"],
                         "REQUEUED_AFTER_RESOLVED_VALIDATION_FAILURE")
        self.assertEqual((reopened["state"], reopened["tip_sha"]), ("QUEUED", repaired_tip))
        self.assertTrue(merge_runtime.task_runtime.run([
            "git", "-C", str(self.repository), "merge-base", "--is-ancestor",
            old_feature, repaired_tip], self.repository, check=False).returncode == 0)
        self.assertFalse(checkout.exists()); self.assertFalse(marker.exists())
        self.assertEqual(reopened["prior_findings_candidate_sha"], "f" * 40)
        failure = reopened["prior_queue_failure"]
        self.assertEqual((failure["outcome"], failure["candidate_sha"]),
                         ("FAILED_TEST", old_candidate))
        self.assertEqual(failure["validation"][0]["exit_code"], 13)
        state = json.loads(state_path.read_text())
        queue = next(value for value in state["queues"].values()
                     if isinstance(value, dict) and "conflicts" in value)
        self.assertNotIn("B", queue["conflicts"])
        conflict = merge_runtime.merge_next(self.controller.resolve())
        self.assertEqual((conflict["task_id"], conflict["feature_sha"]), ("B", repaired_tip))

    def test_lock_divergence_is_reported_before_validation_or_candidate_mutation(self) -> None:
        self.install_merge_planner_runtime()
        self.add_validation_dependency_base()
        self.task("start", "A")
        worktree = self.workspaces / "A"
        (worktree / "src/package-lock.json").write_text(
            '{"lockfileVersion":3,"target":"feature"}\n')
        git(worktree, "add", "src/package-lock.json")
        git(worktree, "commit", "-m", "feature lock drift")
        (worktree / "src/node_modules").mkdir()
        self.task("finish", "A")
        report = merge_runtime.merge_plan(self.controller.resolve(), "A")
        self.assertIn("package.lock_diverged", {row["code"] for row in report["findings"]})
        before = self.counter.read_bytes() if self.counter.exists() else b""
        with mock.patch.object(merge_runtime, "validation_rows") as validation:
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "package.lock_diverged"):
                merge_runtime.merge_next(self.controller.resolve())
        validation.assert_not_called()
        self.assertEqual(self.counter.read_bytes() if self.counter.exists() else b"", before)
        self.assertEqual(self.task("status", "A")["state"], "QUEUED")
        self.assertEqual(self.candidate_artifacts(), [])

    def test_legacy_stale_resolved_candidate_requeues_then_descendant_reopens(self) -> None:
        checkout, marker, old_feature, historical_attempt = \
            self.prepare_legacy_stale_resolved_candidate()
        old_candidate = git(checkout, "rev-parse", "HEAD")
        repaired_tip = self.commit_resolved_repair()
        current = git(self.repository, "rev-parse", "refs/heads/product")
        tree = git(self.repository, "rev-parse", "refs/heads/product^{tree}")
        moved = git(self.repository, "commit-tree", tree, "-p", current, "-m", "external")
        git(self.repository, "update-ref", "refs/heads/product", moved, current)

        stale = merge_runtime.merge_reopen(self.controller.resolve(), "B")

        self.assertEqual((stale["state"], stale["outcome"], stale["tip_sha"]),
                         ("QUEUED", "RISK_TARGET_MOVED", old_feature))
        self.assertEqual(stale["observed_target_sha"], moved)
        failure = stale["prior_queue_failure"]
        self.assertEqual((failure["outcome"], failure["candidate_sha"]),
                         ("STALE_TARGET", old_candidate))
        self.assertEqual(failure["legacy_queue_attempt"], historical_attempt)
        self.assertNotIn("dependency_lock_refusal", failure)
        self.assertNotIn("dependency_lock_refusal", failure["legacy_queue_attempt"])
        self.assertFalse(checkout.exists()); self.assertFalse(marker.exists())

        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "B")

        self.assertEqual((reopened["state"], reopened["tip_sha"], reopened["outcome"]),
                         ("QUEUED", repaired_tip, "REQUEUED_AFTER_TIP_REFRESH"))
        self.assertEqual(reopened["prior_queue_failure"]["legacy_queue_attempt"],
                         historical_attempt)
        conflict = merge_runtime.merge_next(self.controller.resolve())
        self.assertEqual((conflict["task_id"], conflict["feature_sha"]), ("B", repaired_tip))

    def test_legacy_stale_resolved_candidate_refuses_exact_ownership_mismatch(self) -> None:
        checkout, marker, _, _ = self.prepare_legacy_stale_resolved_candidate()
        self.commit_resolved_repair()
        current = git(self.repository, "rev-parse", "refs/heads/product")
        tree = git(self.repository, "rev-parse", "refs/heads/product^{tree}")
        moved = git(self.repository, "commit-tree", tree, "-p", current, "-m", "external")
        git(self.repository, "update-ref", "refs/heads/product", moved, current)
        owner = json.loads(marker.read_text())
        owner["token"] = "0" * 48
        marker.write_text(json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n")

        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "ownership mismatched"):
            merge_runtime.merge_reopen(self.controller.resolve(), "B")

        status = self.task("status", "B")
        self.assertEqual((status["state"], status["last_queue_outcome"]),
                         ("CONFLICT_RESOLVED", "STALE_TARGET"))
        self.assertTrue(checkout.exists()); self.assertTrue(marker.exists())

    def test_legacy_stale_resolved_candidate_refuses_same_target_ambiguity(self) -> None:
        checkout, marker, _, historical_attempt = self.prepare_legacy_stale_resolved_candidate()
        self.commit_resolved_repair()

        with self.assertRaisesRegex(merge_runtime.MergeQueueError,
                                    "ambiguous while target has not moved"):
            merge_runtime.merge_reopen(self.controller.resolve(), "B")

        status = self.task("status", "B")
        self.assertEqual((status["state"], status["queue_attempt"]),
                         ("CONFLICT_RESOLVED", historical_attempt))
        self.assertTrue(checkout.exists()); self.assertTrue(marker.exists())

    def test_stale_failed_resolved_candidate_requeues_then_descendant_reopens(self) -> None:
        checkout, marker, old_feature = self.prepare_failed_resolved_candidate()
        old_candidate = git(checkout, "rev-parse", "HEAD")
        repaired_tip = self.commit_resolved_repair()
        current = git(self.repository, "rev-parse", "refs/heads/product")
        tree = git(self.repository, "rev-parse", "refs/heads/product^{tree}")
        moved = git(self.repository, "commit-tree", tree, "-p", current, "-m", "external")
        git(self.repository, "update-ref", "refs/heads/product", moved, current)

        stale = merge_runtime.merge_reopen(self.controller.resolve(), "B")

        self.assertEqual((stale["state"], stale["outcome"], stale["tip_sha"]),
                         ("QUEUED", "RISK_TARGET_MOVED", old_feature))
        self.assertEqual(stale["observed_target_sha"], moved)
        self.assertEqual((stale["prior_queue_failure"]["outcome"],
                          stale["prior_queue_failure"]["candidate_sha"]),
                         ("FAILED_TEST", old_candidate))
        self.assertEqual(stale["prior_queue_failure"]["validation"][0]["exit_code"], 13)
        self.assertEqual(git(self.workspaces / "B", "rev-parse", "HEAD"), repaired_tip)
        self.assertFalse(checkout.exists()); self.assertFalse(marker.exists())
        state = json.loads((self.controller / ".juno_task/state/tasks.json").read_text())
        queue = next(value for value in state["queues"].values()
                     if isinstance(value, dict) and "conflicts" in value)
        self.assertNotIn("B", queue["conflicts"])

        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "B")

        self.assertEqual((reopened["state"], reopened["tip_sha"], reopened["outcome"]),
                         ("QUEUED", repaired_tip, "REQUEUED_AFTER_TIP_REFRESH"))
        self.assertEqual(reopened["prior_queue_failure"]["candidate_sha"], old_candidate)
        conflict = merge_runtime.merge_next(self.controller.resolve())
        self.assertEqual((conflict["task_id"], conflict["feature_sha"]), ("B", repaired_tip))

    def test_stale_failed_resolved_candidate_refuses_ownership_mismatch(self) -> None:
        checkout, marker, _ = self.prepare_failed_resolved_candidate()
        self.commit_resolved_repair()
        current = git(self.repository, "rev-parse", "refs/heads/product")
        tree = git(self.repository, "rev-parse", "refs/heads/product^{tree}")
        moved = git(self.repository, "commit-tree", tree, "-p", current, "-m", "external")
        git(self.repository, "update-ref", "refs/heads/product", moved, current)
        owner = json.loads(marker.read_text())
        owner["task_id"] = "attacker"
        marker.write_text(json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n")

        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "ownership mismatched"):
            merge_runtime.merge_reopen(self.controller.resolve(), "B")

        self.assertEqual(self.task("status", "B")["state"], "CONFLICT_RESOLVED")
        self.assertTrue(checkout.exists()); self.assertTrue(marker.exists())

    def test_stale_failed_resolved_requeue_interruption_recovers_idempotently(self) -> None:
        checkout, marker, old_feature = self.prepare_failed_resolved_candidate()
        repaired_tip = self.commit_resolved_repair()
        current = git(self.repository, "rev-parse", "refs/heads/product")
        tree = git(self.repository, "rev-parse", "refs/heads/product^{tree}")
        moved = git(self.repository, "commit-tree", tree, "-p", current, "-m", "external")
        git(self.repository, "update-ref", "refs/heads/product", moved, current)
        original = merge_runtime.task_runtime.write_state
        writes = 0
        def fail_final(controller: Path, state: dict) -> None:
            nonlocal writes
            writes += 1
            if writes == 2:
                raise OSError("interrupted after stale cleanup")
            original(controller, state)
        with mock.patch.object(merge_runtime.task_runtime, "write_state", side_effect=fail_final):
            with self.assertRaisesRegex(OSError, "interrupted after stale cleanup"):
                merge_runtime.merge_reopen(self.controller.resolve(), "B")
        self.assertEqual(self.task("status", "B")["state"], "REQUEUING_STALE")
        self.assertFalse(checkout.exists()); self.assertFalse(marker.exists())

        recovered = merge_runtime.merge_reopen(self.controller.resolve(), "B")

        self.assertEqual((recovered["state"], recovered["tip_sha"]), ("QUEUED", old_feature))
        self.assertEqual(recovered["observed_target_sha"], moved)
        reopened = merge_runtime.merge_reopen(self.controller.resolve(), "B")
        self.assertEqual((reopened["state"], reopened["tip_sha"]), ("QUEUED", repaired_tip))

    def test_failed_resolved_repair_refuses_dirty_tip(self) -> None:
        checkout, marker, _ = self.prepare_failed_resolved_candidate()
        worktree = self.workspaces / "B"
        (worktree / "src/shared.txt").write_text("committed repair\n")
        git(worktree, "add", "src/shared.txt")
        git(worktree, "commit", "-m", "repair then drift")
        (worktree / "src/shared.txt").write_text("dirty repair\n")
        self.write_policy()
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "must be clean"):
            merge_runtime.merge_reopen(self.controller.resolve(), "B")
        self.assertTrue(checkout.exists()); self.assertTrue(marker.exists())

    def test_failed_resolved_repair_refuses_non_descendant_tip(self) -> None:
        checkout, marker, _ = self.prepare_failed_resolved_candidate()
        worktree = self.workspaces / "B"
        git(worktree, "reset", "--hard", self.base)
        (worktree / "src/shared.txt").write_text("replacement\n")
        git(worktree, "add", "src/shared.txt")
        git(worktree, "commit", "-m", "non descendant repair")
        self.write_policy()
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "must descend"):
            merge_runtime.merge_reopen(self.controller.resolve(), "B")
        self.assertTrue(checkout.exists()); self.assertTrue(marker.exists())

    def test_failed_resolved_repair_refuses_candidate_ownership_mismatch(self) -> None:
        checkout, marker, _ = self.prepare_failed_resolved_candidate()
        self.commit_resolved_repair()
        owner = json.loads(marker.read_text())
        owner["task_id"] = "attacker"
        marker.write_text(json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n")

        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "ownership mismatched"):
            merge_runtime.merge_reopen(self.controller.resolve(), "B")

        self.assertEqual(self.task("status", "B")["state"], "CONFLICT_RESOLVED")
        self.assertTrue(checkout.exists()); self.assertTrue(marker.exists())

    def test_failed_resolved_repair_interrupted_cleanup_retry_is_idempotent(self) -> None:
        checkout, marker, _ = self.prepare_failed_resolved_candidate()
        repaired_tip = self.commit_resolved_repair()
        original = merge_runtime.task_runtime.write_state
        writes = 0
        def fail_final(controller: Path, state: dict) -> None:
            nonlocal writes
            writes += 1
            if writes == 2:
                raise OSError("interrupted after cleanup")
            original(controller, state)
        with mock.patch.object(merge_runtime.task_runtime, "write_state", side_effect=fail_final):
            with self.assertRaisesRegex(OSError, "interrupted after cleanup"):
                merge_runtime.merge_reopen(self.controller.resolve(), "B")
        self.assertEqual(self.task("status", "B")["state"], "REOPENING")
        self.assertFalse(checkout.exists()); self.assertFalse(marker.exists())

        recovered = merge_runtime.merge_reopen(self.controller.resolve(), "B")

        self.assertEqual((recovered["state"], recovered["tip_sha"]),
                         ("QUEUED", repaired_tip))
        self.assertEqual(recovered["prior_queue_failure"]["outcome"], "FAILED_TEST")

    def test_target_refresh_recovers_reopening_after_target_moves_during_validation(self) -> None:
        checkout, marker, _ = self.prepare_failed_resolved_candidate()
        self.commit_resolved_repair()
        self.write_policy()

        def validate_then_move(*_args: object, **_kwargs: object) -> list[dict[str, object]]:
            self.advance_target("src/reopen-target.txt")
            return []

        with mock.patch.object(merge_runtime, "validation_rows", side_effect=validate_then_move):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError,
                                        "target moved during resolved candidate reopen"):
                merge_runtime.merge_reopen(self.controller.resolve(), "B")
        self.assertEqual(self.task("status", "B")["state"], "REOPENING")
        worktree = self.workspaces / "B"
        authored = (worktree / "src/shared.txt").read_bytes()
        merged = run(["git", "-C", str(worktree), "merge", "--no-edit",
                      "refs/heads/product"], worktree, check=False)
        self.assertNotEqual(merged.returncode, 0)
        (worktree / "src/shared.txt").write_bytes(authored)
        git(worktree, "add", "src/shared.txt")
        git(worktree, "commit", "--no-edit")
        refreshed_tip = git(worktree, "rev-parse", "HEAD")

        planned = merge_runtime.persist_target_refresh_plan(self.controller.resolve(), "B")
        self.assertEqual(planned["source_state"], "REOPENING")
        with mock.patch.object(merge_runtime, "validation_rows", return_value=[]):
            recovered = merge_runtime.apply_target_refresh(
                self.controller.resolve(), "B", planned["receipt"]["path"],
                planned["receipt"]["sha256"])

        self.assertEqual((recovered["state"], recovered["tip_sha"]),
                         ("QUEUED", refreshed_tip))
        self.assertNotIn("reopen_attempt", recovered)
        self.assertFalse(checkout.exists()); self.assertFalse(marker.exists())

    def test_reopen_first_state_write_failure_keeps_findings_and_owned_candidate(self) -> None:
        checkout, marker = self.prepare_moved_finding_reopen()
        with mock.patch.object(merge_runtime.task_runtime, "write_state", side_effect=OSError("first write")):
            with self.assertRaisesRegex(OSError, "first write"):
                merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        self.assertEqual(self.task("status", "Y")["state"], "REVIEW_FINDINGS")
        self.assertTrue(checkout.exists()); self.assertTrue(marker.exists())

    def test_reopen_cleanup_failure_is_durable_and_retry_safe(self) -> None:
        checkout, marker = self.prepare_moved_finding_reopen()
        with mock.patch.object(
            merge_runtime, "rollback_unadmitted_candidate",
            side_effect=merge_runtime.MergeQueueError("cleanup failed"),
        ):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "cleanup failed"):
                merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        self.assertEqual(self.task("status", "Y")["state"], "REOPENING")
        self.assertTrue(checkout.exists()); self.assertTrue(marker.exists())
        self.assertEqual(merge_runtime.merge_reopen(self.controller.resolve(), "Y")["state"], "QUEUED")
        self.assertFalse(checkout.exists()); self.assertFalse(marker.exists())

    def test_reopen_final_state_write_failure_recovers_after_cleanup(self) -> None:
        checkout, marker = self.prepare_moved_finding_reopen()
        original = merge_runtime.task_runtime.write_state
        calls = 0
        def fail_second(controller: Path, state: dict) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("final write")
            original(controller, state)
        with mock.patch.object(merge_runtime.task_runtime, "write_state", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "final write"):
                merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        self.assertEqual(self.task("status", "Y")["state"], "REOPENING")
        self.assertFalse(checkout.exists()); self.assertFalse(marker.exists())
        recovered = merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        self.assertEqual(recovered["state"], "QUEUED")

    def test_reopen_recovers_exact_marker_after_remove_succeeds_and_unlink_crashes(self) -> None:
        checkout, marker = self.prepare_moved_finding_reopen()
        original_unlink = Path.unlink
        def fail_exact_marker(path: Path, *args: object, **kwargs: object) -> None:
            if path.resolve() == marker.resolve():
                raise OSError("marker unlink crash")
            original_unlink(path, *args, **kwargs)
        with mock.patch.object(Path, "unlink", new=fail_exact_marker):
            with self.assertRaisesRegex(OSError, "marker unlink crash"):
                merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        self.assertEqual(self.task("status", "Y")["state"], "REOPENING")
        self.assertFalse(checkout.exists()); self.assertTrue(marker.exists())
        recovered = merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        self.assertEqual(recovered["state"], "QUEUED")
        self.assertFalse(marker.exists())

    def test_reopen_mismatched_orphan_marker_refuses_and_preserves_it(self) -> None:
        checkout, marker = self.prepare_moved_finding_reopen()
        original_unlink = Path.unlink
        def fail_exact_marker(path: Path, *args: object, **kwargs: object) -> None:
            if path.resolve() == marker.resolve():
                raise OSError("marker unlink crash")
            original_unlink(path, *args, **kwargs)
        with mock.patch.object(Path, "unlink", new=fail_exact_marker):
            with self.assertRaisesRegex(OSError, "marker unlink crash"):
                merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        value = json.loads(marker.read_text())
        value["token"] = "0" * 48
        marker.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "ownership mismatched"):
            merge_runtime.merge_reopen(self.controller.resolve(), "Y")
        self.assertEqual(self.task("status", "Y")["state"], "REOPENING")
        self.assertTrue(marker.exists()); self.assertFalse(checkout.exists())

    def test_parallel_x_y_then_moved_target_uses_one_two_parent_composition(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            x = pool.submit(self.commit_feature, "X", "src/x.txt", "x\n")
            y = pool.submit(self.commit_feature, "Y", "src/y.txt", "y\n")
            x_tip, y_tip = x.result(), y.result()
        first = self.queue_payload("next")
        self.assertIn(first["task_id"], {"X", "Y"})
        self.assertEqual(first["strategy"], "direct")
        tips = {"X": x_tip, "Y": y_tip}
        self.assertEqual(first["candidate_sha"], tips[first["task_id"]])
        second = self.queue_payload("next")
        self.assertEqual({first["task_id"], second["task_id"]}, {"X", "Y"})
        self.assertEqual(second["strategy"], "merge_both_parents")
        merged = git(self.repository, "rev-parse", "refs/heads/product")
        self.assertEqual(merged, second["candidate_sha"])
        self.assertEqual(git(self.repository, "show", "-s", "--format=%P", merged).split(),
                         [tips[first["task_id"]], tips[second["task_id"]]])
        self.assertEqual(git(self.repository, "show", "refs/heads/product:src/x.txt"), "x")
        self.assertEqual(git(self.repository, "show", "refs/heads/product:src/y.txt"), "y")
        self.assertEqual(len(self.counter.read_text().splitlines()), 4)  # finish + final candidate, once each
        status = self.queue_payload("status")
        self.assertEqual([row["state"] for row in status["tasks"]], ["MERGED", "MERGED"])

    def test_composition_candidate_disables_inherited_common_sparse_checkout(self) -> None:
        # Reproduce a migrated repository whose common config still enables
        # sparse checkout while the controller owns worktree-local patterns.
        git(self.repository, "config", "extensions.worktreeConfig", "true")
        git(self.repository, "config", "core.sparseCheckout", "true")
        git(self.controller, "config", "--worktree", "core.sparseCheckout", "true")
        git(self.controller, "config", "--worktree", "core.sparseCheckoutCone", "false")
        sparse = Path(git(self.controller, "rev-parse", "--git-path", "info/sparse-checkout"))
        sparse.parent.mkdir(parents=True, exist_ok=True)
        sparse.write_text("/.juno_task/\n")
        git(self.controller, "read-tree", "-mu", "HEAD")
        self.assertFalse((self.controller / "src").exists())

        self.commit_feature("X", "src/x.txt", "x\n")
        self.commit_feature("Y", "src/y.txt", "y\n")
        first = self.queue_payload("next")
        second = self.queue_payload("next")

        self.assertEqual(first["strategy"], "direct")
        self.assertEqual(second["strategy"], "merge_both_parents")
        self.assertEqual(git(self.repository, "show", "refs/heads/product:src/x.txt"), "x")
        self.assertEqual(git(self.repository, "show", "refs/heads/product:src/y.txt"), "y")
        self.assertEqual(len(self.counter.read_text().splitlines()), 4)

    def test_direct_hydrated_review_reuses_dependencies_and_retries_prior_failed_claim(self) -> None:
        self.add_validation_dependency_base()
        full_code = ("from pathlib import Path; "
                     "assert Path('node_modules/probe.txt').read_text() == 'ready\\n'; "
                     f"Path({str(self.full_counter)!r}).open('a').write('run\\n')")
        self.write_policy(full_code=full_code)
        self.task("start", "X")
        worktree = self.workspaces / "X"
        security = worktree / "src/security/auth.py"
        security.parent.mkdir(parents=True)
        security.write_text("auth\n")
        modules = worktree / "src/node_modules"
        modules.mkdir()
        (modules / "probe.txt").write_text("ready\n")
        provenance = (modules.resolve(), modules.stat().st_dev, modules.stat().st_ino)
        git(worktree, "add", "src/security/auth.py")
        git(worktree, "commit", "-m", "high risk feature")
        self.task("finish", "X")
        self.assertEqual(self.queue_payload("next")["outcome"], "AWAITING_RISK")

        with mock.patch.object(
                merge_runtime, "validation_dependencies",
                side_effect=merge_runtime.MergeQueueError(
                    "candidate validation dependency path already exists")):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError,
                                        "dependency path already exists"):
                merge_runtime.merge_review(self.controller.resolve(), "X")
        failed = self.task("status", "X")["queue_attempt"]
        claim = failed["risk"]["review_progress"]["full_suite_admission"]
        self.assertEqual((failed["outcome"], claim["state"], claim["attempt_number"]),
                         ("REVIEW_FAILED", "CLAIMED", 1))

        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        admission = ready["risk"]["review_progress"]["full_suite_admission"]
        self.assertEqual((ready["outcome"], admission["state"], admission["attempt_number"]),
                         ("RISK_EVIDENCE_READY", "COMPLETE", 1))
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])
        self.assertEqual((modules.resolve(), modules.stat().st_dev, modules.stat().st_ino),
                         provenance)
        self.assertFalse(modules.is_symlink())
        self.assertEqual((modules / "probe.txt").read_text(), "ready\n")
        self.assertEqual(git(worktree, "status", "--porcelain=v1", "--untracked-files=all"), "")

    def test_direct_unhydrated_review_refuses_without_creating_dependencies(self) -> None:
        self.add_validation_dependency_base()
        self.task("start", "X")
        worktree = self.workspaces / "X"
        security = worktree / "src/security/auth.py"
        security.parent.mkdir(parents=True)
        security.write_text("auth\n")
        git(worktree, "add", "src/security/auth.py")
        git(worktree, "commit", "-m", "unhydrated high risk feature")
        self.task("finish", "X")
        with (mock.patch.object(merge_runtime, "validation_rows") as validation,
              mock.patch.object(merge_runtime, "dispatch_reviewer") as dispatch):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError,
                                        "validation.dependencies_missing"):
                merge_runtime.merge_next(self.controller.resolve())
        validation.assert_not_called()
        dispatch.assert_not_called()
        self.assertEqual(self.task("status", "X")["state"], "QUEUED")
        self.assertFalse((worktree / "src/node_modules").exists())
        self.assertEqual(git(worktree, "status", "--porcelain=v1", "--untracked-files=all"), "")

    def test_composition_candidate_uses_only_lock_compatible_feature_dependencies(self) -> None:
        self.add_validation_dependency_base()
        code = ("from pathlib import Path; "
                "assert Path('node_modules/probe.txt').read_text() == 'ready\\n'; "
                f"Path({str(self.counter)!r}).open('a').write('run\\n')")
        self.write_policy(code)

        for task_id, path in (("X", "src/x.txt"), ("Y", "src/y.txt")):
            self.task("start", task_id)
            worktree = self.workspaces / task_id
            (worktree / path).write_text(f"{task_id}\n")
            modules = worktree / "src/node_modules"
            modules.mkdir()
            (modules / "probe.txt").write_text("ready\n")
            git(worktree, "add", path)
            git(worktree, "commit", "-m", f"feature {task_id}")
            self.task("finish", task_id)

        self.assertEqual(self.queue_payload("next")["strategy"], "direct")
        composed = self.queue_payload("next")
        self.assertEqual(composed["strategy"], "merge_both_parents")
        self.assertEqual(len(self.counter.read_text().splitlines()), 4)
        self.assertEqual(self.registered_candidate_paths(), [])
        for task_id in ("X", "Y"):
            modules = self.workspaces / task_id / "src/node_modules"
            self.assertTrue(modules.is_dir())
            self.assertFalse(modules.is_symlink())
            self.assertEqual((modules / "probe.txt").read_text(), "ready\n")
            self.assertEqual(git(self.workspaces / task_id, "status", "--porcelain=v1",
                                 "--untracked-files=all"), "")

    def test_candidate_dependency_bridge_refuses_package_lock_drift(self) -> None:
        source = self.root / "dependency-source"
        candidate = self.root / "dependency-candidate"
        for root, value in ((source, "source"), (candidate, "candidate")):
            root.mkdir()
            git(root, "init")
            git(root, "config", "user.email", "test@example.com")
            git(root, "config", "user.name", "Test")
            (root / ".gitignore").write_text("node_modules/\n")
            (root / "package-lock.json").write_text(f'{{"name":"{value}"}}\n')
            git(root, "add", ".")
            git(root, "commit", "-m", value)
        (source / "node_modules").mkdir()
        with self.assertRaisesRegex(
            merge_runtime.DependencyLockMismatchError, "package lock differs"
        ) as raised:
            with merge_runtime.validation_dependencies(candidate, candidate, source):
                self.fail("lock drift must refuse before validation")
        evidence = raised.exception.evidence
        self.assertEqual((evidence["schema_version"], evidence["lock_path"]),
                         ("juno_merge_queue_dependency_lock_refusal.v1", "package-lock.json"))
        self.assertNotEqual(evidence["candidate_sha256"], evidence["source_sha256"])
        self.assertFalse((candidate / "node_modules").exists())

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
        lock = common / "juno-locks/merge-queue" / f"{key}.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        before_state = (self.controller / ".juno_task/state/tasks.json").read_bytes()
        with lock.open("a+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            failed = self.queue("next", check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("another worker owns", failed.stderr)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertEqual((self.controller / ".juno_task/state/tasks.json").read_bytes(), before_state)

    def test_distinct_controllers_share_the_git_common_dir_target_lock(self) -> None:
        other_controller = self.root / "other-controller"
        git(self.repository, "branch", "controller-two", self.base)
        run(["git", "-C", str(self.repository), "worktree", "add", str(other_controller), "controller-two"], self.repository)
        with merge_runtime.target_lock(self.controller, self.controller, "refs/heads/product"):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "another worker owns"):
                with merge_runtime.target_lock(other_controller, self.controller, "refs/heads/product"):
                    self.fail("second controller unexpectedly acquired the shared target lock")

    def test_checked_out_target_ref_fails_closed_before_cas(self) -> None:
        self.commit_feature("X", "src/x.txt", "x\n")
        git(self.repository, "switch", "product")
        failed = self.queue("next", check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("target ref is checked out", failed.stderr)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertEqual(self.task("status", "X")["state"], "QUEUED")

    def test_moved_candidate_checked_out_target_ref_rolls_back_then_retries_once(self) -> None:
        self.commit_feature("X", "src/x.txt", "x\n")
        self.commit_feature("Y", "src/y.txt", "y\n")
        self.queue_payload("next")
        git(self.repository, "switch", "product")
        failed = self.queue("next", check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("target ref is checked out", failed.stderr)
        self.assertEqual(self.task("status", "Y")["state"], "QUEUED")
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])
        git(self.repository, "switch", "--detach", "refs/heads/product")
        merged = self.queue_payload("next")
        self.assertEqual(merged["outcome"], "MERGED")
        self.assertEqual(merged["strategy"], "merge_both_parents")
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])

    def test_generic_pre_cas_policy_refusal_rolls_back_unadmitted_candidate(self) -> None:
        self.commit_feature("X", "src/x.txt", "x\n")
        self.commit_feature("Y", "src/y.txt", "y\n")
        self.queue_payload("next")
        with mock.patch.object(
            merge_runtime, "review_candidate", side_effect=merge_runtime.MergeQueueError("injected policy refusal")
        ):
            with self.assertRaisesRegex(merge_runtime.MergeQueueError, "injected policy refusal"):
                merge_runtime.merge_next(self.controller.resolve())
        self.assertEqual(self.task("status", "Y")["state"], "QUEUED")
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])
        self.assertEqual(self.queue_payload("next")["outcome"], "MERGED")

    def test_durable_resolved_conflict_is_preserved_across_pre_cas_refusal(self) -> None:
        self.commit_feature("A", "src/shared.txt", "A\n")
        self.commit_feature("B", "src/shared.txt", "B\n")
        self.queue_payload("next")
        conflict = self.queue_payload("next")
        checkout = Path(conflict["candidate_checkout"])
        (checkout / "src/shared.txt").write_text("kept\n")
        git(checkout, "add", "src/shared.txt")
        before_registered = self.registered_candidate_paths()
        git(self.repository, "switch", "product")
        failed = self.queue("resolve", "B", check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("target ref is checked out", failed.stderr)
        status = self.task("status", "B")
        self.assertEqual(status["state"], "CONFLICT_RESOLVED")
        candidate = status["queue_attempt"]["candidate_sha"]
        self.assertEqual(self.registered_candidate_paths(), before_registered)
        self.assertTrue(checkout.is_dir())
        self.assertTrue(merge_runtime.owner_marker(self.controller.resolve(), checkout).is_file())
        git(self.repository, "switch", "--detach", "refs/heads/product")
        resolved = self.queue_payload("resolve", "B")
        self.assertEqual(resolved["candidate_sha"], candidate)
        self.assertEqual(resolved["outcome"], "MERGED")
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])

    def test_atomic_state_write_failure_preserves_task_and_queue_truth_together(self) -> None:
        tip = self.commit_feature("X", "src/x.txt", "x\n")
        path = self.controller / ".juno_task/state/tasks.json"
        before = path.read_bytes()
        attempt = {"task_id": "X", "feature_sha": tip, "outcome": "MERGING"}
        with mock.patch.object(merge_runtime.task_runtime.os, "replace", side_effect=OSError("injected")):
            with self.assertRaisesRegex(OSError, "injected"):
                merge_runtime.persist_attempt(self.controller, attempt, state_name="MERGING")
        self.assertEqual(path.read_bytes(), before)
        state = merge_runtime.task_runtime.read_state(self.controller)
        self.assertEqual(state["tasks"]["X"]["state"], "QUEUED")
        self.assertEqual(state["queues"], {
            "task_workspace_fifo": {"schema_version": "juno_task_workspace_fifo.v1", "next": 2},
            "umbrella_child_reservations": {
                "schema_version": "juno_task_umbrella_child_reservations.v1", "owners": {}
            },
        })
        self.assertFalse((self.controller / ".juno_task/state/queue.json").exists())

    def test_conflict_first_admission_failure_rolls_back_dirty_internal_checkout_then_retries_once(self) -> None:
        self.commit_feature("A", "src/shared.txt", "A\n")
        self.commit_feature("B", "src/shared.txt", "B\n")
        self.queue_payload("next")
        before_registered = self.registered_candidate_paths()
        with mock.patch.object(merge_runtime.task_runtime, "write_state", side_effect=OSError("injected conflict admission")):
            with self.assertRaisesRegex(OSError, "injected conflict admission"):
                merge_runtime.merge_next(self.controller.resolve())
        self.assertEqual(self.registered_candidate_paths(), before_registered)
        self.assertEqual(self.candidate_artifacts(), [])
        self.assertEqual(self.task("status", "B")["state"], "QUEUED")
        conflict = self.queue_payload("next")
        self.assertEqual(conflict["outcome"], "CONFLICT")
        self.assertEqual(len(self.registered_candidate_paths()), 1)
        self.assertEqual(len([path for path in self.candidate_artifacts() if path.is_dir()]), 1)

    def test_clean_candidate_pre_cas_admission_failure_rolls_back_then_retry_merges_once(self) -> None:
        self.commit_feature("X", "src/x.txt", "x\n")
        self.commit_feature("Y", "src/y.txt", "y\n")
        self.queue_payload("next")
        with mock.patch.object(
            merge_runtime, "rollback_unadmitted_candidate", wraps=merge_runtime.rollback_unadmitted_candidate
        ) as rollback:
            with mock.patch.object(
                merge_runtime.task_runtime, "write_state", side_effect=OSError("injected merging admission")
            ):
                with self.assertRaisesRegex(OSError, "injected merging admission"):
                    merge_runtime.merge_next(self.controller.resolve())
            rollback.assert_called_once()
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])
        self.assertEqual(self.task("status", "Y")["state"], "QUEUED")
        merged = self.queue_payload("next")
        self.assertEqual(merged["outcome"], "MERGED")
        self.assertEqual(merged["strategy"], "merge_both_parents")
        self.assertEqual(self.registered_candidate_paths(), [])
        self.assertEqual(self.candidate_artifacts(), [])

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

        checkout, token = merge_runtime.create_candidate_checkout(
            self.controller, self.controller, "Z", "refs/heads/product",
            result["candidate_sha"], result["candidate_sha"]
        )
        (checkout / "dirty.txt").write_text("preserve\n")
        cleanup = merge_runtime.cleanup_candidate(
            self.controller, self.controller, checkout, "refs/heads/product", result["candidate_sha"], token
        )
        self.assertEqual(cleanup["outcome"], "preserved")
        self.assertEqual(cleanup["reason"], "dirty")
        self.assertTrue(checkout.is_dir())

    def test_cleanup_refuses_unreachable_candidate(self) -> None:
        checkout, token = merge_runtime.create_candidate_checkout(
            self.controller, self.controller, "Z", "refs/heads/product", self.base, self.base
        )
        (checkout / "src/unreachable.txt").write_text("candidate\n")
        git(checkout, "add", ".")
        git(checkout, "commit", "-m", "unreachable candidate")
        candidate = git(checkout, "rev-parse", "HEAD")
        result = merge_runtime.cleanup_candidate(
            self.controller, self.controller, checkout, "refs/heads/product", candidate, token
        )
        self.assertEqual(result["outcome"], "preserved")
        self.assertEqual(result["reason"], "candidate_unreachable_from_target")
        self.assertTrue(checkout.is_dir())

    def test_cleanup_refuses_an_unrelated_registered_checkout(self) -> None:
        checkout = self.root / "unrelated-checkout"
        run(["git", "-C", str(self.repository), "worktree", "add", "--detach", str(checkout), self.base], self.repository)
        result = merge_runtime.cleanup_candidate(
            self.controller, self.controller, checkout, "refs/heads/product", self.base, None
        )
        self.assertEqual(result["outcome"], "preserved")
        self.assertEqual(result["reason"], "ownership_mismatch")
        self.assertTrue(checkout.is_dir())

    def test_failed_resolved_candidate_retries_same_commit_without_remerge(self) -> None:
        self.commit_feature("A", "src/shared.txt", "A\n")
        self.commit_feature("B", "src/shared.txt", "B\n")
        self.queue_payload("next")
        conflict = self.queue_payload("next")
        checkout = Path(conflict["candidate_checkout"])
        (checkout / "src/shared.txt").write_text("A+B\n")
        git(checkout, "add", "src/shared.txt")
        self.write_policy("import sys; sys.exit(13)")
        failed = self.queue("resolve", "B", check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("affected validation failed", failed.stderr)
        status = self.task("status", "B")
        self.assertEqual(status["state"], "CONFLICT_RESOLVED")
        candidate = status["queue_attempt"]["candidate_sha"]
        self.assertEqual(git(checkout, "rev-parse", "HEAD"), candidate)
        self.assertTrue(checkout.is_dir())
        self.write_policy()
        resolved = self.queue_payload("resolve", "B")
        self.assertEqual(resolved["candidate_sha"], candidate)
        self.assertEqual(resolved["outcome"], "MERGED")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), candidate)

    def test_resolution_state_write_failure_adopts_exact_committed_candidate_on_retry(self) -> None:
        self.commit_feature("A", "src/shared.txt", "A\n")
        self.commit_feature("B", "src/shared.txt", "B\n")
        self.queue_payload("next")
        conflict = self.queue_payload("next")
        checkout = Path(conflict["candidate_checkout"])
        (checkout / "src/shared.txt").write_text("recovered\n")
        git(checkout, "add", "src/shared.txt")
        with mock.patch.object(merge_runtime.task_runtime, "write_state", side_effect=OSError("injected")):
            with self.assertRaisesRegex(OSError, "injected"):
                merge_runtime.merge_resolve(self.controller, "B")
        candidate = git(checkout, "rev-parse", "HEAD")
        self.assertEqual(self.task("status", "B")["state"], "CONFLICT")
        self.assertNotEqual(run(["git", "-C", str(checkout), "rev-parse", "MERGE_HEAD"], checkout, False).returncode, 0)
        recovered = self.queue_payload("resolve", "B")
        self.assertEqual(recovered["candidate_sha"], candidate)
        self.assertEqual(recovered["outcome"], "MERGED")

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
