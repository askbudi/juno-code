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
        progress = {"schema_version": "juno_merge_queue_review_progress.v2",
                    "attempt_counter": 0, "full_suite_receipt": None, "steps": [],
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
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)

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
        suite_ref = merge_runtime.full_suite_validation(
            config, candidate, plan, identity, self.root / "seed-full-suite.json")
        reviews = [self.fake_review(self.controller, candidate, plan, "X", "reviewer_a", 1, None, 1)]
        reviews.append(self.fake_review(
            self.controller, candidate, plan, "X", "reviewer_b", 2,
            Path(reviews[0]["runner_receipt_path"]), 1))
        forged = risk_runtime.finalize(
            plan, request, affected_tests_passed=True, full_suite_receipt=suite_ref,
            reviews=reviews, metrics={"model_calls": 2, "affected_test_runs": 1,
                                      "full_suite_runs": 1}, policy=policy)
        forged["validation"]["full_suite_receipt"] = None
        seed_path = merge_runtime.evidence_path(self.controller.resolve(), "X", tip)
        risk_runtime.atomic_receipt(seed_path, forged, policy)
        self.full_counter.write_text("")
        self.assertEqual(self.queue_payload("next")["outcome"], "AWAITING_RISK")
        with mock.patch.object(merge_runtime, "dispatch_reviewer", side_effect=self.fake_review):
            ready = merge_runtime.merge_review(self.controller.resolve(), "X")
        self.assertEqual(ready["outcome"], "RISK_EVIDENCE_READY")
        self.assertEqual(self.full_counter.read_text().splitlines(), ["run"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)

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
