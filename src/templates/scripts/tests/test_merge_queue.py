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


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


def git(root: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(root), *args], root, check).stdout.strip()


class MergeQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
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
        self.write_policy()
        risk_path = self.controller / ".juno_task/config/risk-policy.json"
        risk_path.write_bytes((SCRIPTS.parent / "config/risk-policy.json").read_bytes())
        git(self.controller, "add", ".")
        git(self.controller, "commit", "-m", "controller")
        # Queue CAS targets must not be owned by any checkout.
        git(self.repository, "switch", "--detach", self.base)

    def tearDown(self) -> None:
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
            "controller_private_paths": [".juno_task/tasks", ".juno_task/state", ".juno_task/specs"],
            "focused_validation": [{"id": "affected", "cwd": "src", "argv": [sys.executable, "-c", code],
                                    "timeout_seconds": 10, "max_output_bytes": 4096}],
            "full_suite_validation": {"id": "full-suite", "cwd": "src",
                                       "argv": [sys.executable, "-c", full_code or
                                                f"from pathlib import Path; Path({str(self.full_counter)!r}).open('a').write('run\\n')"],
                                       "timeout_seconds": 10, "max_output_bytes": 4096},
        }) + "\n")

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
        self.assertEqual(git(owner, "rev-parse", "HEAD"), self.base)

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
        receipt = {"schema_version": risk_runtime.FULL_SUITE_SCHEMA,
                   "producer": {"schema_version": risk_runtime.FULL_SUITE_PRODUCER_SCHEMA,
                                "tool_id": risk_runtime.FULL_SUITE_TOOL_ID},
                   "candidate": claim["candidate"], "policy_identity": plan["policy_identity"],
                   "claim": {**claim_ref, "token": token, "attempt_number": 1},
                   "validation_identity": identity, "command": command,
                   "started_at": "2026-08-09T00:00:00Z",
                   "completed_at": "2026-08-09T00:00:01Z",
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

    def test_composition_candidate_uses_only_lock_compatible_feature_dependencies(self) -> None:
        setup = self.root / "dependency-base"
        git(self.repository, "worktree", "add", str(setup), "product")
        (setup / "src/.gitignore").write_text("node_modules/\n")
        (setup / "src/package-lock.json").write_text('{"lockfileVersion":3}\n')
        git(setup, "add", "src/.gitignore", "src/package-lock.json")
        git(setup, "commit", "-m", "add validation lock")
        git(self.repository, "worktree", "remove", str(setup))
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
        with self.assertRaisesRegex(merge_runtime.MergeQueueError, "package lock differs"):
            with merge_runtime.validation_dependencies(candidate, candidate, source):
                self.fail("lock drift must refuse before validation")
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
            "task_workspace_fifo": {"schema_version": "juno_task_workspace_fifo.v1", "next": 2}
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
