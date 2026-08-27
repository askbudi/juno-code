#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
PROJECT_ROOT = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))
import release_train as runtime  # noqa: E402


def run(root: Path, *args: str) -> str:
    return subprocess.check_output(list(args), cwd=root, text=True).strip()


class ReleaseTrainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        subprocess.run(["git", "init", "-b", "product", str(self.root)], check=True, stdout=subprocess.DEVNULL)
        run(self.root, "git", "config", "user.email", "test@example.invalid")
        run(self.root, "git", "config", "user.name", "Test")
        (self.root / ".juno_task/scripts").mkdir(parents=True)
        for name in ("release_train.py", "merge_queue.py", "worktree_hydration.py"):
            (self.root / ".juno_task/scripts" / name).write_bytes((SCRIPTS / name).read_bytes())
        (self.root / ".juno_task/config").mkdir(parents=True)
        (self.root / ".juno_task/config/task-workspace.json").write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1", "repository": ".",
            "target_ref": "refs/heads/product", "workspace_root": str(self.root / "workspaces"),
            "branch_prefix": "refs/heads/task-", "allowed_paths": ["src"], "selectable_paths": [],
            "controller_private_paths": [".juno_task"],
            "focused_validation": [{"id": "focused", "cwd": "src", "argv": ["true"],
                                    "timeout_seconds": 10, "max_output_bytes": 1024}],
            "full_suite_validation": {"id": "full", "cwd": "src", "argv": ["true"],
                                      "timeout_seconds": 10, "max_output_bytes": 1024}}) + "\n")
        (self.root / ".juno_task/config/risk-policy.json").write_text("{}\n")
        (self.root / "src").mkdir()
        (self.root / "src/.keep").write_text("fixture\n")
        (self.root / "yylo").mkdir()
        (self.root / "juno-code").mkdir()
        (self.root / "juno-code/package.json").write_text('{"version":"1.0.0"}\n')
        (self.root / "juno-code/package-lock.json").write_text('{"version":"1.0.0","packages":{"":{"version":"1.0.0"}}}\n')
        (self.root / ".juno_task/state").mkdir()
        self.board_path = self.root / ".juno_task/board.json"
        for task_id in ("OLD", "REQ", "DEP"):
            task_path = self.root / ".juno_task/tasks" / task_id[:2].lower() / f"{task_id}.md"
            task_path.parent.mkdir(parents=True, exist_ok=True)
            task_path.write_text(f"---\nid: {task_id}\nstatus: todo\n---\n")
        self.board = {
            "OLD": {"id": "OLD", "status": "in_progress", "blocked_by": [], "last_modified": "1"},
            "REQ": {"id": "REQ", "status": "in_progress", "blocked_by": [], "last_modified": "1"},
            "DEP": {"id": "DEP", "status": "todo", "blocked_by": ["REQ"], "last_modified": "1"},
        }
        self.write_board()
        wrapper = self.root / ".juno_task/scripts/kanban.sh"
        wrapper.write_text("""#!/usr/bin/env python3
import json,pathlib,sys
board=json.loads(pathlib.Path(__file__).resolve().parents[1].joinpath('board.json').read_text())
if sys.argv[1]=='get' and sys.argv[2] in board: print(json.dumps([board[sys.argv[2]]])); raise SystemExit(0)
raise SystemExit(2)
""")
        wrapper.chmod(0o755)
        self.state = {"schema_version": "juno_task_workspace_state.v1", "queues": {}, "tasks": {
            "OLD": {"task_id": "OLD", "state": "QUEUED", "target_ref": "refs/heads/product",
                    "enqueue_sequence": 1, "changed_paths": ["src/old"]},
            "REQ": {"task_id": "REQ", "state": "QUEUED", "target_ref": "refs/heads/product",
                    "enqueue_sequence": 2, "changed_paths": ["src/req"]}}}
        self.write_state()
        run(self.root, "git", "add", ".")
        run(self.root, "git", "commit", "-m", "fixture")
        self.base = run(self.root, "git", "rev-parse", "HEAD")
        self.declaration = self.root / "train.json"
        self.write_declaration(["REQ", "DEP"], [{"before": "REQ", "after": "DEP"}])
        run(self.root, "git", "add", "train.json")
        run(self.root, "git", "commit", "-m", "train")
        # Planning base is the product target after committing the declaration.
        self.base = run(self.root, "git", "rev-parse", "HEAD")
        self.write_declaration(["REQ", "DEP"], [{"before": "REQ", "after": "DEP"}])
        self.feasible = mock.patch("merge_queue.merge_plan", return_value={"plan_id": "f" * 64, "ready": True, "findings": []})
        self.feasible.start()
        self.owner = mock.patch("merge_queue.integration_owner_readback", return_value={
            "clean": True, "detached": True, "full_checkout": True, "role": "integration-owner",
            "authority": "protected-integration.v1", "head": self.base, "role_base": self.base, "submodules": []})
        self.owner.start()
        run(self.root, "git", "config", "juno.integration.ownerPath", str(self.root))

    def tearDown(self) -> None:
        self.owner.stop(); self.feasible.stop(); self.temp.cleanup()

    def write_board(self) -> None:
        self.board_path.write_text(json.dumps(self.board) + "\n")

    def write_state(self) -> None:
        (self.root / ".juno_task/state/tasks.json").write_text(json.dumps(self.state) + "\n")

    def write_declaration(self, required: list[str], edges: list[dict[str, str]]) -> None:
        common = run(self.root, "git", "rev-parse", "--path-format=absolute", "--git-common-dir")
        value = {"schema_version": runtime.DECLARATION_SCHEMA, "train_id": "rc-1", "revision": 1,
                 "requested_version": "1.0.1", "target_ref": "refs/heads/product",
                 "planning_base_sha": getattr(self, "base", "0" * 40), "required_tasks": required,
                 "optional_tasks": [], "dependencies": edges, "gates": ["release-full"],
                 "authority": {"controller_common_dir": common,
                               "release_command": "./scripts/release-juno-code.sh --set 1.0.1"},
                 "exclusions": ["push", "publish", "deploy"]}
        self.declaration.write_text(json.dumps(value, sort_keys=True) + "\n")

    def write_bootstrap_declaration(self) -> Path:
        path = self.root / "bootstrap-repair.json"
        path.write_text(json.dumps({
            "schema_version": runtime.BOOTSTRAP_DECLARATION_SCHEMA,
            "operation_id": "bootstrap-1", "revision": 1,
            "target_ref": "refs/heads/product", "planning_base_sha": self.base,
            "authority_task": "OLD", "repair_task": "REQ", "affected_tasks": ["DEP"],
            "exclusions": ["release", "tag", "push", "publish", "deploy", "cleanup"],
        }, sort_keys=True) + "\n")
        return path

    def write_shadow_baseline(self) -> Path:
        path = self.root / "shadow-baseline.json"
        path.write_text(json.dumps({
            "schema_version": "juno_agent_session_telemetry_collection.v1", "session_count": 21,
            "scorecard": {"schema_version": "juno_agent_session_scorecard.v1",
                "session_count": 21, "duplicate_command_executions": 12,
                "model_lifecycle_calls": {"assistant_turns": 100, "model_changes": 2,
                                          "compactions": 3, "provider_errors": 4},
                "cas_count": 9, "cache_read_tokens": 362700000,
                "phase_seconds": {"implementation": 1000, "merge": 200},
                "wait_seconds_by_cause": {"polling": 500}},
        }, sort_keys=True) + "\n")
        return path

    def test_deterministic_non_mutating_json_and_human_projection(self) -> None:
        before = run(self.root, "git", "status", "--porcelain=v1", "--untracked-files=all")
        first = runtime.build_plan(self.root, self.declaration)
        second = runtime.build_plan(self.root, self.declaration)
        self.assertEqual(first, second)
        self.assertIn(first["plan_id"], runtime.human(first))
        self.assertEqual(before, run(self.root, "git", "status", "--porcelain=v1", "--untracked-files=all"))

    def test_fifo_conflict_dependency_blocker_and_parallel_lanes(self) -> None:
        report = runtime.build_plan(self.root, self.declaration)
        self.assertEqual(["OLD"], [row["task_id"] for row in report["fifo"]["older_unrelated"]])
        self.assertIn("queue.older_unrelated", [row["code"] for row in report["blockers"]])
        self.assertIn("dependency.unmet", [row["code"] for row in report["blockers"]])
        self.assertEqual("yy merge next", report["next_command"])
        self.board["DEP"]["blocked_by"] = []; self.write_board()
        self.write_declaration(["REQ", "DEP"], [])
        parallel = runtime.build_plan(self.root, self.declaration)
        self.assertEqual([["REQ", "DEP"]], parallel["parallel_lanes"])

    def test_cycle_is_explicit(self) -> None:
        self.board["REQ"]["blocked_by"] = ["DEP"]; self.write_board()
        self.write_declaration(["REQ", "DEP"], [{"before": "REQ", "after": "DEP"}, {"before": "DEP", "after": "REQ"}])
        report = runtime.build_plan(self.root, self.declaration)
        self.assertIn("dependency.cycle", [row["code"] for row in report["blockers"]])

    def test_stale_kanban_and_target_identity_refuse_shared_gate(self) -> None:
        plan = runtime.build_plan(self.root, self.declaration)
        plan_path = self.declaration.with_suffix(".plan.json"); plan_path.write_text(runtime.canonical(plan))
        self.assertEqual(plan, runtime.check_plan(self.root, plan_path, "merge"))
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "exact FIFO merge head"):
            runtime.check_plan(self.root, plan_path, "merge", "REQ")
        self.board["REQ"]["last_modified"] = "2"; self.write_board()
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "stale"):
            runtime.check_plan(self.root, plan_path, "merge", "REQ")
        self.board["REQ"]["last_modified"] = "1"; self.write_board()
        (self.root / "movement").write_text("x")
        run(self.root, "git", "add", "movement"); run(self.root, "git", "commit", "-m", "move")
        moved = runtime.build_plan(self.root, self.declaration)
        self.assertTrue(moved["target_moved"])

    def test_missing_runtime_blocks(self) -> None:
        (self.root / ".juno_task/scripts/release_train.py").unlink()
        report = runtime.build_plan(self.root, self.declaration)
        self.assertIn("runtime.missing", [row["code"] for row in report["blockers"]])

    def test_clean_ready_release_and_version_gate(self) -> None:
        self.board["REQ"].update(status="done", commit_hash=self.base, blocked_by=[])
        self.board["DEP"].update(status="done", commit_hash=self.base, blocked_by=[])
        self.write_board(); self.state["tasks"] = {}; self.write_state()
        report = runtime.build_plan(self.root, self.declaration)
        self.assertTrue(report["release_ready"])
        plan_path = self.declaration.with_suffix(".plan.json"); plan_path.write_text(runtime.canonical(report))
        self.assertEqual(report, runtime.check_plan(self.root, plan_path, "release", requested_version="1.0.1"))
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "version differs"):
            runtime.check_plan(self.root, plan_path, "release", requested_version="1.0.2")

    def lean_checkout(self) -> None:
        # A lean sparse controller: tracked product files are absent from the
        # working tree while the protected target still owns their content.
        run(self.root, "git", "sparse-checkout", "set", "--no-cone",
            "/.juno_task/**", "/src/**", "/yylo/**", "/train.json")
        self.assertFalse((self.root / "juno-code/package.json").exists())
        self.assertFalse((self.root / "juno-code/package-lock.json").exists())

    def finish_board(self) -> None:
        self.board["REQ"].update(status="done", commit_hash=self.base, blocked_by=[])
        self.board["DEP"].update(status="done", commit_hash=self.base, blocked_by=[])
        self.write_board(); self.state["tasks"] = {}; self.write_state()

    def test_lean_sparse_controller_plans_release_from_target_tree(self) -> None:
        # rejV9U: version identity must come from the protected target
        # generation, so a lean controller with absent product files still
        # reaches release_ready when package/lock identities are exact.
        self.lean_checkout()
        self.finish_board()
        report = runtime.build_plan(self.root, self.declaration)
        self.assertEqual([], report["blockers"])
        self.assertTrue(report["release_ready"])
        self.assertEqual("1.0.0", report["release_preconditions"]["current_version"])
        self.assertEqual({"juno-code/package.json", "juno-code/package-lock.json"},
                         set(report["identities"]["package_sha256"]))
        self.assertTrue(all(report["identities"]["package_sha256"].values()))
        plan_path = self.declaration.with_suffix(".plan.json"); plan_path.write_text(runtime.canonical(report))
        self.assertEqual(report, runtime.check_plan(self.root, plan_path, "release", requested_version="1.0.1"))

    def commit_target_drift(self, mutate) -> None:
        run(self.root, "git", "sparse-checkout", "disable")
        mutate()
        run(self.root, "git", "add", "-A", "juno-code")
        run(self.root, "git", "commit", "-m", "target drift")
        self.base = run(self.root, "git", "rev-parse", "HEAD")
        self.write_declaration(["REQ", "DEP"], [])
        self.lean_checkout()

    def prepare_epoch(self) -> tuple[str, str]:
        """Queue two immutable divergent candidates with exact closure evidence."""
        tree = run(self.root, "git", "rev-parse", f"{self.base}^{{tree}}")
        req = subprocess.check_output(["git", "commit-tree", tree, "-p", self.base], cwd=self.root,
                                      text=True, input="REQ candidate\n").strip()
        old = subprocess.check_output(["git", "commit-tree", tree, "-p", self.base], cwd=self.root,
                                      text=True, input="OLD candidate\n").strip()
        for sequence, (task_id, tip) in enumerate((("OLD", old), ("REQ", req)), 1):
            self.state["tasks"][task_id].update({
                "tip_sha": tip, "enqueue_sequence": sequence,
                "review_ready_closure": {"schema_version": "juno_task_review_ready_closure.v1",
                                         "closure_sha256": "c" * 64,
                                         "tip_sha": tip,
                                         "tree_sha": tree},
                "validation": [{"status": "passed", "receipt_id": task_id}],
            })
        self.write_state()
        self.board["OLD"].update(status="in_progress", blocked_by=[])
        self.board["REQ"].update(status="in_progress", blocked_by=[])
        self.write_board()
        self.write_declaration(["REQ"], [])
        declaration = json.loads(self.declaration.read_text())
        declaration["optional_tasks"] = ["OLD"]
        self.declaration.write_text(json.dumps(declaration, sort_keys=True) + "\n")
        return old, req

    def commit_files_tree(self, parent: str, paths: list[str], content: str, message: str) -> str:
        with tempfile.NamedTemporaryFile() as stream:
            index = stream.name
        environment = {**os.environ, "GIT_INDEX_FILE": index,
                       "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                       "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
                       "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z",
                       "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z"}
        subprocess.run(["git", "read-tree", parent], cwd=self.root, env=environment, check=True)
        for path in paths:
            blob = subprocess.check_output(["git", "hash-object", "-w", "--stdin"], cwd=self.root,
                                           env=environment, text=True, input=content).strip()
            subprocess.run(["git", "update-index", "--add", "--cacheinfo", "100644", blob, path],
                           cwd=self.root, env=environment, check=True)
        tree = subprocess.check_output(["git", "write-tree"], cwd=self.root,
                                       env=environment, text=True).strip()
        return subprocess.check_output(["git", "commit-tree", tree, "-p", parent], cwd=self.root,
                                       env=environment, text=True, input=message + "\n").strip()

    def prepare_serial_conflict_epoch(self) -> tuple[str, str, list[str]]:
        """Build the portable six-member rc7/rc8 order and two-conflict topology."""
        conflict_paths = [".juno_task/managed-assets.json", ".juno_task/scripts/release_train.py",
            "juno-code/src/cli/__tests__/release-command.test.ts",
            "juno-code/src/cli/commands/release.ts",
            "juno-code/src/templates/scripts/release_train.py"]
        for path in conflict_paths:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("rc7-rc8 base\n")
        run(self.root, "git", "add", *conflict_paths)
        run(self.root, "git", "commit", "-m", "rc7 rc8 conflict base")
        candidate_base = run(self.root, "git", "rev-parse", "HEAD")
        first = self.commit_files_tree(candidate_base, conflict_paths, "pA6M9l\n", "pA6M9l candidate")
        second = self.commit_files_tree(candidate_base, conflict_paths, "0y4ljs\n", "0y4ljs candidate")
        for path in conflict_paths:
            (self.root / path).write_text("protected target\n")
        run(self.root, "git", "add", *conflict_paths)
        run(self.root, "git", "commit", "-m", "protected target conflict")
        self.base = run(self.root, "git", "rev-parse", "HEAD")
        # Model the immutable rc7 receipt-bound pA6M9l both-parent composition.
        with tempfile.TemporaryDirectory() as temporary:
            clone = Path(temporary) / "composition"
            run(Path(temporary), "git", "clone", "--quiet", str(self.root), str(clone))
            run(clone, "git", "checkout", "--quiet", "--detach", self.base)
            merge = subprocess.run(["git", "merge", "--no-ff", "--no-commit", first], cwd=clone,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            self.assertNotEqual(0, merge.returncode)
            run(clone, "git", "checkout", "--theirs", "--", *conflict_paths)
            run(clone, "git", "add", "-A")
            run(clone, "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                "commit", "--quiet", "-m", "receipt-bound pA6M9l repair")
            proven = run(clone, "git", "rev-parse", "HEAD")
            run(self.root, "git", "fetch", "--quiet", str(clone), proven)
        proven_tree = run(self.root, "git", "rev-parse", f"{proven}^{{tree}}")
        epoch_root = self.root / ".juno_task/runtime/release-epochs/rc-0"
        receipt_path = epoch_root / "receipts/0003-repair_consumed.json"
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        receipt = {"schema_version": runtime.EPOCH_RECEIPT_SCHEMA, "epoch_id": "rc-0",
                   "transition": "REPAIR_CONSUMED", "detail": {"repair_commit": proven}}
        receipt_path.write_text(json.dumps(receipt, sort_keys=True) + "\n")
        receipt_sha = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
        state = {"epoch_id": "rc-0", "receipts": [{"transition": "REPAIR_CONSUMED",
                 "path": str(receipt_path), "sha256": receipt_sha}], "composition": {"commits": [{
                 "task_id": "pA6M9l", "pre_sha": self.base, "candidate_tip": first,
                 "merge_commit": proven, "post_tree": proven_tree}]}}
        (epoch_root / "state.json").write_text(json.dumps(state, sort_keys=True) + "\n")
        later_ids = ["U2rjMN", "znI3LO", "e99k0C", "GsKDx6"]
        later = []
        for task_id in later_ids:
            path = f"src/{task_id}.txt"
            later.append((task_id, self.commit_files_tree(
                candidate_base, [path], task_id + "\n", task_id + " candidate"), [path]))
        members = [("pA6M9l", first, conflict_paths), ("0y4ljs", second, conflict_paths), *later]
        self.state["tasks"] = {}
        for sequence, (task_id, tip, changed_paths) in enumerate(members, 1):
            task_path = self.root / ".juno_task/tasks" / task_id[:2].lower() / f"{task_id}.md"
            task_path.parent.mkdir(parents=True, exist_ok=True)
            task_path.write_text(f"---\nid: {task_id}\nstatus: in_progress\n---\n")
            self.board[task_id] = {"id": task_id, "status": "in_progress", "blocked_by": [],
                                   "last_modified": "rc7-rc8-fixture"}
            tree = run(self.root, "git", "rev-parse", f"{tip}^{{tree}}")
            self.state["tasks"][task_id] = {"task_id": task_id, "state": "QUEUED",
                "target_ref": "refs/heads/product", "enqueue_sequence": sequence,
                "changed_paths": changed_paths, "tip_sha": tip,
                "review_ready_closure": {"schema_version": "juno_task_review_ready_closure.v1",
                    "closure_sha256": hashlib.sha256(task_id.encode()).hexdigest(),
                    "tip_sha": tip, "tree_sha": tree},
                "validation": [{"status": "passed", "receipt_id": task_id}]}
        self.write_board(); self.write_state()
        self.assertIsNotNone(runtime._proven_forecast_composition(
            self.root, self.root, "pA6M9l", self.base, first, "rc-1"))
        order = [task_id for task_id, _, _ in members]
        self.write_declaration(order, [{"before": order[index], "after": order[index + 1]}
                                       for index in range(len(order) - 1)])
        return first, second, conflict_paths

    def test_epoch_seal_is_complete_immutable_and_idempotent(self) -> None:
        self.prepare_epoch()
        plan = runtime.build_epoch_plan(self.root, self.declaration)
        self.assertEqual(["OLD", "REQ"], [row["task_id"] for row in plan["members"]])
        self.assertEqual("c" * 64, plan["members"][0]["complete_input_identity"]["closure_sha256"])
        sealed = runtime.seal_epoch(self.root, self.declaration)
        self.assertEqual("sealed", sealed["outcome"])
        self.assertEqual("SEALED", sealed["epoch"]["state"])
        self.assertEqual("already_sealed", runtime.seal_epoch(self.root, self.declaration)["outcome"])
        # A post-cutoff queue candidate cannot grow the immutable seal.
        self.state["tasks"]["DEP"] = {"task_id": "DEP", "state": "QUEUED",
            "target_ref": "refs/heads/product", "enqueue_sequence": 3,
            "tip_sha": self.base, "complete_input_identity": "d" * 64,
            "validation": [{"status": "passed"}], "changed_paths": ["src/dep"]}
        self.write_state()
        current = runtime.read_epoch(self.root, "rc-1")
        self.assertEqual(["OLD", "REQ"], [row["task_id"] for row in current["seal"]["members"]])

    def test_epoch_seal_refuses_required_missing_closure_without_state(self) -> None:
        self.prepare_epoch()
        self.state["tasks"]["REQ"].pop("review_ready_closure")
        self.write_state()
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "candidate.complete_input_missing:REQ"):
            runtime.seal_epoch(self.root, self.declaration)
        self.assertFalse(runtime.epoch_state_path(self.root, "rc-1").exists())

    def test_rc7_rc8_serial_conflicts_fit_one_conservative_repair_set(self) -> None:
        first, second, conflict_paths = self.prepare_serial_conflict_epoch()
        before_status = run(self.root, "git", "status", "--porcelain=v1", "--untracked-files=all")
        before_refs = run(self.root, "git", "for-each-ref", "--format=%(refname) %(objectname)")
        before_objects = run(self.root, "git", "count-objects", "-v")
        plan = runtime.build_epoch_plan(self.root, self.declaration)
        repeated = runtime.build_epoch_plan(self.root, self.declaration)
        manifest = plan["conflict_manifest"]
        self.assertEqual(plan, repeated)
        self.assertEqual(["pA6M9l", "0y4ljs"], [row["task_id"] for row in manifest["conflicts"]])
        self.assertEqual([sorted(conflict_paths), sorted(conflict_paths)],
                         [row["conflict_paths"] for row in manifest["conflicts"]])
        self.assertEqual([first, second], [row["candidate_tip"] for row in manifest["conflicts"]])
        self.assertEqual(2, manifest["required_conflict_count"])
        self.assertTrue(manifest["member_accounting_complete"])
        self.assertTrue(manifest["forecast_complete"])
        self.assertFalse(manifest["exact_composition_complete"])
        self.assertTrue(manifest["policy_repair_budget_feasible"])
        self.assertTrue(manifest["repair_budget_feasible"])
        self.assertEqual(1, manifest["required_logical_repair_set_count"])
        self.assertEqual(["U2rjMN", "znI3LO", "e99k0C", "GsKDx6"],
                         [row["task_id"] for row in manifest["indeterminate_members"]])
        self.assertEqual(["pA6M9l", "0y4ljs", "U2rjMN", "znI3LO", "e99k0C", "GsKDx6"],
                         [row["task_id"] for row in manifest["compositions"]])
        self.assertEqual("0y4ljs", manifest["unresolved_boundary"]["task_id"])
        envelope = manifest["conservative_envelope"]
        self.assertEqual(["0y4ljs", "U2rjMN", "znI3LO", "e99k0C", "GsKDx6"],
                         [row["task_id"] for row in envelope["ordered_members"]])
        self.assertTrue(envelope["complete"])
        self.assertEqual("authorization_neutral_logical_conflict_set.v1",
                         manifest["identity"]["forecast_policy"]["repair_unit"])
        self.assertEqual("frozen_unknown_suffix.v1",
                         manifest["identity"]["forecast_policy"]["logical_conflict_set_grouping"])
        self.assertEqual("immutable_receipt_bound_composition",
                         manifest["conflicts"][0]["forecast_resolution"])
        self.assertEqual(runtime.digest({key: value for key, value in manifest.items()
                                         if key != "manifest_sha256"}), manifest["manifest_sha256"])
        self.assertEqual(before_status, run(self.root, "git", "status", "--porcelain=v1",
                                            "--untracked-files=all"))
        self.assertEqual(before_refs, run(self.root, "git", "for-each-ref",
                                          "--format=%(refname) %(objectname)"))
        self.assertEqual(before_objects, run(self.root, "git", "count-objects", "-v"))
        sealed = runtime.seal_epoch(self.root, self.declaration)
        self.assertEqual("sealed", sealed["outcome"])
        self.assertTrue(runtime.epoch_state_path(self.root, "rc-1").is_file())
        self.assertEqual(before_refs, run(self.root, "git", "for-each-ref",
                                          "--format=%(refname) %(objectname)"))

    def test_phase1_acceptance_predicate_emits_durable_pass_receipt(self) -> None:
        self.prepare_serial_conflict_epoch()
        before_status = run(self.root, "git", "status", "--porcelain=v1", "--untracked-files=all")
        before_refs = run(self.root, "git", "for-each-ref", "--format=%(refname) %(objectname)")
        before_objects = run(self.root, "git", "count-objects", "-v")
        manifest = runtime.build_epoch_plan(self.root, self.declaration)["conflict_manifest"]
        evidence = {"portable_topology": {"order": manifest["identity"]["order"],
            "serial_conflicts": [row["task_id"] for row in manifest["conflicts"]],
            "exact_parent_tree_receipts": bool(
                manifest["conflicts"][0].get("proven_composition")
                and manifest["conflicts"][0]["post_tree"]
                and manifest["conflicts"][1]["candidate_tree"])},
            "non_mutation": {
                "status": before_status == run(self.root, "git", "status", "--porcelain=v1",
                                                "--untracked-files=all"),
                "refs": before_refs == run(self.root, "git", "for-each-ref",
                                            "--format=%(refname) %(objectname)"),
                "objects": before_objects == run(self.root, "git", "count-objects", "-v")},
            "parity": {
                "runtime_template": ((PROJECT_ROOT / ".juno_task/scripts/release_train.py").read_bytes()
                    == (PROJECT_ROOT / "juno-code/src/templates/scripts/release_train.py").read_bytes()),
                "paired_tests": ((PROJECT_ROOT / ".juno_task/scripts/tests/test_release_train.py").read_bytes()
                    == (PROJECT_ROOT / "juno-code/src/templates/scripts/tests/test_release_train.py").read_bytes())}}
        receipt = runtime.phase1_acceptance_receipt(manifest, evidence)
        self.assertEqual("PASS", receipt["decision"])
        self.assertEqual([], receipt["blocking_reason_codes"])
        tampered = json.loads(json.dumps(manifest))
        tampered["conservative_envelope"]["ordered_members"].pop()
        envelope_body = {key: value for key, value in tampered["conservative_envelope"].items()
                         if key != "envelope_sha256"}
        tampered["conservative_envelope"]["envelope_sha256"] = runtime.digest(envelope_body)
        tampered["identity"]["conservative_envelope_sha256"] = tampered["conservative_envelope"]["envelope_sha256"]
        tampered["identity_sha256"] = runtime.digest(tampered["identity"])
        tampered["manifest_sha256"] = runtime.digest({key: value for key, value in tampered.items()
                                                       if key != "manifest_sha256"})
        refused = runtime.phase1_acceptance_receipt(tampered, evidence)
        self.assertEqual("FAIL", refused["decision"])
        self.assertIn("manifest.envelope_incomplete", refused["blocking_reason_codes"])
        output = os.environ.get("YYLO_PHASE1_ACCEPTANCE_RECEIPT")
        if output:
            Path(output).write_text(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n")

    def test_exact_rc7_rc8_receipts_cover_every_member_without_synthetic_repair(self) -> None:
        configured = os.environ.get("YYLO_RC_EVIDENCE_CONTROLLER")
        if not configured:
            self.skipTest("set YYLO_RC_EVIDENCE_CONTROLLER for the immutable rc7/rc8 canary")
        controller = Path(configured).expanduser().resolve()
        expected = {
            "sot-ledger-wave1-rc7": {
                "repair": "35e932529096d421d4c084fb63b1a4929fed2868de91a33fd8ddda53b17587cf",
                "conflict": "23b6ac9383c494de1a0ccf02457eb055d282e2df7abda31f88e65af164190a6b",
                "worker": "8c33108b5750d690a422fe447234fecd6000bf738f6ca7f72f4855e3df9d8ee0"},
            "sot-ledger-wave1-rc8": {
                "repair": "5d81ec668d92c31a7fe79d13be5bfb84c4d7c950f01be50305ca49c98aee48c4",
                "conflict": "71c4e636cd10697e72dde8ecfed5abb99dec07233be36cee039199ca0bdb2204",
                "worker": "45b02566b7e6ef08595785819e85fe23504b1f74bba0421fac6fd7ce6706f2e5"}}
        states = {}
        for epoch_id, identities in expected.items():
            state_path = controller / ".juno_task/runtime/release-epochs" / epoch_id / "state.json"
            state = json.loads(state_path.read_text())
            states[epoch_id] = state
            receipts = {row["transition"]: row for row in state["receipts"]}
            self.assertEqual(identities["repair"], receipts["REPAIR_CONSUMED"]["sha256"])
            self.assertEqual(identities["conflict"], state["receipts"][-1]["sha256"])
            worker = Path(state["conflict_repair"]["path"])
            self.assertEqual(identities["worker"], hashlib.sha256(worker.read_bytes()).hexdigest())
        rc8 = states["sot-ledger-wave1-rc8"]
        before_status = run(controller, "git", "status", "--porcelain=v1", "--untracked-files=all")
        before_refs = run(controller, "git", "for-each-ref", "--format=%(refname) %(objectname)")
        manifest = runtime.forecast_epoch_conflicts(controller, controller, rc8["seal"])
        self.assertEqual(rc8["seal"]["order"], [row["task_id"] for row in manifest["compositions"]])
        self.assertEqual(["pA6M9l", "0y4ljs"], [row["task_id"] for row in manifest["conflicts"]])
        self.assertEqual(["U2rjMN", "znI3LO", "e99k0C", "GsKDx6"],
                         [row["task_id"] for row in manifest["indeterminate_members"]])
        self.assertTrue(manifest["member_accounting_complete"])
        self.assertTrue(manifest["forecast_complete"])
        self.assertFalse(manifest["exact_composition_complete"])
        self.assertTrue(manifest["repair_budget_feasible"])
        self.assertEqual(1, manifest["required_logical_repair_set_count"])
        self.assertEqual(expected["sot-ledger-wave1-rc7"]["repair"],
                         manifest["conflicts"][0]["proven_composition"]["receipt_sha256"])
        self.assertEqual(before_status, run(controller, "git", "status", "--porcelain=v1",
                                            "--untracked-files=all"))
        self.assertEqual(before_refs, run(controller, "git", "for-each-ref",
                                          "--format=%(refname) %(objectname)"))

        # Receipt drift fails closed without touching the exhausted source epoch.
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            copied_root = evidence / ".juno_task/runtime/release-epochs/sot-ledger-wave1-rc7"
            copied_receipt = copied_root / "receipts/0003-repair_consumed.json"
            copied_receipt.parent.mkdir(parents=True)
            source_receipt = Path(states["sot-ledger-wave1-rc7"]["receipts"][2]["path"])
            copied_receipt.write_bytes(source_receipt.read_bytes())
            copied_state = json.loads(json.dumps(states["sot-ledger-wave1-rc7"]))
            copied_state["receipts"] = [{**states["sot-ledger-wave1-rc7"]["receipts"][2],
                "path": str(copied_receipt)}]
            (copied_root / "state.json").write_text(json.dumps(copied_state, sort_keys=True) + "\n")
            row = rc8["seal"]["members"][0]
            self.assertIsNotNone(runtime._proven_forecast_composition(
                evidence, controller, "pA6M9l", rc8["seal"]["base_sha"], row["tip_sha"],
                "sot-ledger-wave1-rc8"))
            copied_receipt.write_text(copied_receipt.read_text() + "tamper\n")
            self.assertIsNone(runtime._proven_forecast_composition(
                evidence, controller, "pA6M9l", rc8["seal"]["base_sha"], row["tip_sha"],
                "sot-ledger-wave1-rc8"))

    def test_bootstrap_repair_is_causal_fenced_preserves_queue_and_cas_once(self) -> None:
        old, req = self.prepare_epoch()
        self.board["REQ"]["blocked_by"] = ["OLD"]
        self.board["DEP"]["blocked_by"] = ["REQ"]
        self.write_board()
        declaration = self.write_bootstrap_declaration()
        plan = runtime.build_bootstrap_plan(self.root, declaration)
        self.assertEqual(["OLD", "REQ"], [row["task_id"] for row in plan["members"]])
        self.assertEqual([], plan["preserved_members"])
        sealed = runtime.seal_bootstrap(self.root, declaration)
        token = sealed["bootstrap_token"]
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "exact bootstrap-repair fencing token"):
            runtime.drive_bootstrap(self.root, "bootstrap-1", "wrong")
        cas_calls = 0
        def fixture_cas(repository: Path, target_ref: str, tip: str, expected: str) -> dict:
            nonlocal cas_calls
            cas_calls += 1
            run(repository, "git", "update-ref", target_ref, tip, expected)
            return {"fixture": "exact-owner-readback"}
        with mock.patch("merge_queue.cas_target", side_effect=fixture_cas), \
             mock.patch("merge_queue.refresh_managed_controller", return_value={"status": "complete"}), \
             mock.patch.object(runtime, "reconcile_bootstrap_members", side_effect=lambda _controller, state: state):
            complete = runtime.drive_bootstrap(self.root, "bootstrap-1", token)
            repeated = runtime.drive_bootstrap(self.root, "bootstrap-1", token)
        self.assertEqual("COMPLETE", complete["state"])
        self.assertEqual(complete, repeated)
        self.assertEqual(1, cas_calls)
        self.assertEqual(1, complete["cas"]["target_move_count"])
        for candidate in (old, req):
            subprocess.run(["git", "merge-base", "--is-ancestor", candidate,
                            complete["cas"]["tip"]], cwd=self.root, check=True)
        self.assertEqual("QUEUED", self.state["tasks"]["OLD"]["state"])
        self.assertEqual("QUEUED", self.state["tasks"]["REQ"]["state"])
        receipt = json.loads(Path(complete["receipt"]["path"]).read_text())
        self.assertEqual("bootstrap_repair_integrated", receipt["reason_code"])
        self.assertTrue(set(runtime.EXTERNAL_ACTIONS).issubset(receipt["excluded_actions"]))

    def test_bootstrap_reconciliation_finalizes_only_exact_ancestry_members(self) -> None:
        self.prepare_epoch()
        self.board["REQ"]["blocked_by"] = ["OLD"]
        self.board["DEP"]["blocked_by"] = ["REQ"]
        self.write_board()
        sealed = runtime.seal_bootstrap(self.root, self.write_bootstrap_declaration())
        state = sealed["state"]
        for member in state["seal"]["members"]:
            run(self.root, "git", "merge", "--no-ff", "--no-edit", member["tip_sha"])
        target = run(self.root, "git", "rev-parse", "HEAD")
        state.update({"state": "COMPLETE", "cas": {"readback": self.base},
                      "receipt": {"receipt_id": "r" * 64}})
        persisted = []
        with mock.patch("merge_queue.finalize_kanban_task", return_value={"outcome": "completed"}) as finalize, \
             mock.patch("merge_queue.persist_attempt", side_effect=lambda _c, attempt, **_k: persisted.append(attempt)):
            reconciled = runtime.reconcile_bootstrap_members(self.root, state)
        self.assertEqual(["OLD", "REQ"], [row["task_id"] for row in reconciled["reconciliation"]["members"]])
        self.assertEqual(self.base, reconciled["reconciliation"]["sealed_target_sha"])
        self.assertEqual(target, reconciled["reconciliation"]["observed_target_sha"])
        self.assertEqual(2, finalize.call_count)
        self.assertEqual(["OLD", "REQ"], [row["task_id"] for row in persisted])
        self.assertTrue(all(row["candidate_sha"] == target for row in persisted))

    def test_bootstrap_repair_refuses_missing_causal_dependency(self) -> None:
        self.prepare_epoch()
        self.board["DEP"]["blocked_by"] = ["REQ"]
        self.write_board()
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "causal chain"):
            runtime.build_bootstrap_plan(self.root, self.write_bootstrap_declaration())

    def test_epoch_composes_history_validates_once_and_cas_once(self) -> None:
        old, req = self.prepare_epoch()
        self.lean_checkout()
        sealed = runtime.seal_epoch(self.root, self.declaration)
        def fixture_cas(repository: Path, target_ref: str, tip: str, expected: str) -> dict:
            run(repository, "git", "update-ref", target_ref, tip, expected)
            return {"fixture": "exact-owner-readback"}
        with mock.patch("merge_queue.cas_target", side_effect=fixture_cas):
            state = runtime.drive_epoch(self.root, "rc-1", sealed["lease_token"])
        self.assertEqual("RELEASE_READY", state["state"])
        self.assertEqual(2, len(state["composition"]["commits"]))
        self.assertEqual(1, state["aggregate"]["aggregate_runs"])
        self.assertEqual(1, state["cas"]["target_move_count"])
        train_checkout = Path(state["composition"]["worktree"])
        self.assertTrue((train_checkout / "juno-code/package.json").is_file())
        self.assertNotEqual("true", run(train_checkout, "git", "config", "--bool", "core.sparseCheckout"))
        self.assertEqual(state["composition"]["tip_sha"], run(self.root, "git", "rev-parse", "refs/heads/product"))
        for tip in (old, req):
            subprocess.run(["git", "merge-base", "--is-ancestor", tip,
                            state["composition"]["tip_sha"]], cwd=self.root, check=True)
        # Retry is observation-only and cannot duplicate commits, validation, or CAS.
        self.assertEqual(state, runtime.drive_epoch(self.root, "rc-1", sealed["lease_token"]))

    def test_aggregate_exact_lock_hydrates_missing_dependencies_before_gate(self) -> None:
        package = {"name": "fixture", "version": "1.0.0", "private": True}
        lock = {"name": "fixture", "version": "1.0.0", "lockfileVersion": 3,
                "requires": True, "packages": {"": package}}
        (self.root / "juno-code/package.json").write_text(json.dumps(package) + "\n")
        (self.root / "juno-code/package-lock.json").write_text(json.dumps(lock) + "\n")
        (self.root / ".gitignore").write_text("juno-code/node_modules/\n")
        config_path = self.root / ".juno_task/config/task-workspace.json"
        config = json.loads(config_path.read_text())
        config["full_suite_validation"] = {"id": "full", "cwd": "juno-code",
            "argv": ["node", "-e", "process.exit(0)"], "timeout_seconds": 30,
            "max_output_bytes": 1024}
        config_path.write_text(json.dumps(config) + "\n")
        run(self.root, "git", "add", "juno-code", ".gitignore", ".juno_task/config/task-workspace.json")
        run(self.root, "git", "commit", "-m", "exact-lock aggregate fixture")
        self.base = run(self.root, "git", "rev-parse", "HEAD")
        self.prepare_epoch()
        sealed = runtime.seal_epoch(self.root, self.declaration)
        def fixture_cas(repository: Path, target_ref: str, tip: str, expected: str) -> dict:
            run(repository, "git", "update-ref", target_ref, tip, expected)
            return {"fixture": "exact-owner-readback"}
        with mock.patch("merge_queue.cas_target", side_effect=fixture_cas):
            state = runtime.drive_epoch(self.root, "rc-1", sealed["lease_token"])
        self.assertEqual("RELEASE_READY", state["state"], state.get("aggregate"))
        self.assertEqual("executed", state["aggregate"]["hydration"]["decision"])
        stamp = Path(state["composition"]["worktree"]) / "juno-code/node_modules/.yylo-package-lock.sha256"
        self.assertTrue(stamp.is_file())
        self.assertEqual(hashlib.sha256((self.root / "juno-code/package-lock.json").read_bytes()).hexdigest(),
                         stamp.read_text().strip())

    def test_failed_aggregate_has_fenced_receipt_retry_without_duplicate_merge_or_cas(self) -> None:
        self.prepare_epoch()
        marker = self.root / "aggregate-ready"
        config_path = self.root / ".juno_task/config/task-workspace.json"
        config = json.loads(config_path.read_text())
        config["full_suite_validation"]["argv"] = [
            sys.executable, "-c",
            f"import pathlib,sys; sys.exit(0 if pathlib.Path({str(marker)!r}).exists() else 7)",
        ]
        config_path.write_text(json.dumps(config) + "\n")
        sealed = runtime.seal_epoch(self.root, self.declaration)
        failed = runtime.drive_epoch(self.root, "rc-1", sealed["lease_token"])
        self.assertEqual("RECOVERING", failed["state"])
        self.assertEqual("command", failed["aggregate"]["stage"])
        merge_commits = list(failed["composition"]["commits"])
        marker.touch()
        validating = runtime.retry_epoch_aggregate(self.root, "rc-1", sealed["lease_token"])
        self.assertEqual("VALIDATING", validating["state"])
        self.assertEqual("AGGREGATE_RETRY_AUTHORIZED", validating["receipts"][-1]["transition"])
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "no failed aggregate"):
            runtime.retry_epoch_aggregate(self.root, "rc-1", sealed["lease_token"])
        cas_calls = 0
        def fixture_cas(repository: Path, target_ref: str, tip: str, expected: str) -> dict:
            nonlocal cas_calls
            cas_calls += 1
            run(repository, "git", "update-ref", target_ref, tip, expected)
            return {"fixture": "exact-owner-readback"}
        with mock.patch("merge_queue.cas_target", side_effect=fixture_cas):
            complete = runtime.drive_epoch(self.root, "rc-1", sealed["lease_token"])
        self.assertEqual("RELEASE_READY", complete["state"])
        self.assertEqual(2, complete["aggregate"]["aggregate_runs"])
        self.assertEqual(merge_commits, complete["composition"]["commits"])
        self.assertEqual(1, cas_calls)
        self.assertEqual(1, complete["cas"]["target_move_count"])

    def test_required_failure_pauses_and_shadow_is_read_only(self) -> None:
        self.prepare_epoch()
        sealed = runtime.seal_epoch(self.root, self.declaration)
        paused = runtime.eject_epoch_member(self.root, "rc-1", "REQ", "seeded failure", sealed["lease_token"])
        self.assertEqual("PAUSED_REQUIRED", paused["state"])
        # A production decision blocks until one exact installed instruction generation exists.
        missing = runtime.shadow_epoch(self.root, self.declaration, None)
        self.assertEqual("BLOCK", missing["decision"])
        self.assertIn("instruction_bundle.missing_or_invalid", missing["blocking_reason_codes"])
        destinations = ["AGENTS.md", "CLAUDE.md",
            ".agents/skills/example/SKILL.md", ".claude/skills/example/SKILL.md",
            ".pi/skills/example/SKILL.md", ".juno_task/prompts/example.md",
            ".juno_task/wiki/example.md", ".juno_task/workflows/example.yaml",
            ".juno_task/scripts/example.py", ".juno_task/scripts/task_workspace.py",
            ".juno_task/scripts/task_workspace_decisions.py"]
        assets = {}
        for destination in destinations:
            target = self.root / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            content = (destination + "\n").encode()
            target.write_bytes(content)
            digest = hashlib.sha256(content).hexdigest()
            assets[destination] = {"type": "fixture", "templateVersion": "1.0.0",
                "sourceSha256": digest, "installedSha256": digest}
        projected = [{"destination": destination, "type": record["type"],
                      "sourceSha256": record["sourceSha256"],
                      "installedSha256": record["installedSha256"]}
                     for destination, record in sorted(assets.items(), key=lambda item: (
                         0 if item[0].startswith(".") else 1,
                         "".join(char for char in item[0].lower() if char.isalnum()), item[0]))]
        assets_identity = hashlib.sha256(
            json.dumps(projected, separators=(",", ":")).encode()).hexdigest()
        bundle = {"schemaVersion": "juno_instruction_bundle.v1",
            "semanticVersion": "1.0.0", "packageVersion": "1.0.0",
            "assetCount": len(assets), "assetsSha256": assets_identity}
        bundle["bundleSha256"] = hashlib.sha256(
            json.dumps(bundle, separators=(",", ":")).encode()).hexdigest()
        (self.root / ".juno_task" / "managed-assets.json").write_text(json.dumps({
            "schemaVersion": 2, "packageName": "@yylo/cli", "packageVersion": "1.0.0",
            "instructionBundle": bundle, "assets": assets}, sort_keys=True) + "\n")
        baseline = self.write_shadow_baseline()
        before = run(self.root, "git", "status", "--porcelain=v1", "--untracked-files=all")
        report = runtime.shadow_epoch(self.root, self.declaration, baseline)
        self.assertEqual("PASS", report["decision"])
        self.assertEqual(105, report["baseline"]["model_lifecycle_calls"])
        self.assertEqual("juno_instruction_bundle.v1", report["instruction_bundle"]["schemaVersion"])
        self.assertEqual([], report["side_effects"])
        self.assertEqual(before, run(self.root, "git", "status", "--porcelain=v1", "--untracked-files=all"))

        state_path = self.root / ".juno_task/runtime/release-epochs/rc-1/state.json"
        historical = runtime.shadow_epoch(self.root, state_path, baseline)
        self.assertEqual("PASS", historical["decision"])
        self.assertEqual("historical_sealed_epoch", historical["replay_source"]["kind"])
        self.assertEqual("PAUSED_REQUIRED", historical["replay_source"]["state"])
        first_receipt = Path(paused["receipts"][0]["path"])
        first_receipt.write_text(first_receipt.read_text() + "tamper\n")
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "receipt identity"):
            runtime.shadow_epoch(self.root, state_path, baseline)

    def test_recovered_worker_receipt_requires_exact_failed_artifacts(self) -> None:
        source = self.root / "recovery-source"; source.mkdir()
        output = self.root / "recovery-output"; output.mkdir()
        session = "session-recovery"
        stdout = source / "stdout.log"; stdout.write_text("completed\n")
        live = source / "live.log"; live.write_text(f"completed\n{session}\n")
        continuity = source / "continuity.json"
        continuity.write_text(json.dumps({"version": 2, "scopes": {"S": {
            "active": "main", "branches": {"main": {"session_id": session}}}}}) + "\n")
        response = output / "response.txt"; response.write_bytes(stdout.read_bytes())
        identity = {"admission_kind": "sealed_release_epoch_conflict", "task_id": "REQ"}
        launch = {"identity": identity}; launch_path = source / "launch.json"
        launch_path.write_text(json.dumps(launch) + "\n")
        terminal = {"state": "failed", "exit_code": 0}; terminal_path = source / "terminal.json"
        terminal_path.write_text(json.dumps(terminal) + "\n")
        failed = {"schema_version": "juno_managed_agent_runner.v1", "mode": "worker",
                  "state": "failed", "failure": "capture is missing or stale", "exit_code": 0,
                  "timed_out": False, "termination_events": [], "identity": identity}
        failed_path = source / "receipt.json"; failed_path.write_text(json.dumps(failed) + "\n")

        def mark(path: Path) -> dict:
            data = path.read_bytes()
            return {"path": str(path), "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest()}

        receipt = {"capture_source": "receipt_bound_worker_recovery", "session_id": session,
                   "artifacts": {"response": mark(response)},
                   "recovery": {"schema_version": "juno_managed_agent_recovery.v1",
                       "kind": "capture_only_no_model_rerun", "validated_exit_code": 0,
                       "failed_receipt": mark(failed_path), "failed_terminal": mark(terminal_path),
                       "launch": mark(launch_path), "live_log": mark(live), "stdout": mark(stdout),
                       "continuity": mark(continuity)}}
        runtime.validate_recovered_worker_receipt(receipt)
        stdout.write_text("tampered\n")
        with self.assertRaisesRegex(runtime.ReleaseTrainError, "stdout identity mismatch"):
            runtime.validate_recovered_worker_receipt(receipt)

    def test_lean_target_drift_refuses_release(self) -> None:
        self.lean_checkout()
        self.finish_board()
        ready = runtime.build_plan(self.root, self.declaration)
        self.assertTrue(ready["release_ready"])

        def rebuild() -> dict:
            # The setUp owner mock stays bound to the original planning base,
            # so drifted generations also carry a topology blocker; the
            # version gates below must still refuse independently of it.
            return runtime.build_plan(self.root, self.declaration)

        # Real lock drift in the target tree must refuse and rebind the plan.
        self.commit_target_drift(lambda: (self.root / "juno-code/package-lock.json").write_text(
            '{"version":"0.9.9","packages":{"":{"version":"1.0.0"}}}\n'))
        mismatch = rebuild()
        self.assertIn("release.version_identity_mismatch", [row["code"] for row in mismatch["blockers"]])
        self.assertFalse(mismatch["release_ready"])
        self.assertNotEqual(ready["plan_id"], mismatch["plan_id"])
        # A target generation without the product manifest must refuse.
        self.commit_target_drift(lambda: (self.root / "juno-code/package.json").unlink())
        missing = rebuild()
        self.assertIn("release.version_missing", [row["code"] for row in missing["blockers"]])
        self.assertFalse(missing["release_ready"])
        # A target version that does not precede the request must refuse.
        self.commit_target_drift(lambda: (
            (self.root / "juno-code/package.json").write_text('{"version":"1.0.1"}\n'),
            (self.root / "juno-code/package-lock.json").write_text(
                '{"version":"1.0.1","packages":{"":{"version":"1.0.1"}}}\n')))
        not_greater = rebuild()
        self.assertIn("release.version_not_greater", [row["code"] for row in not_greater["blockers"]])
        self.assertFalse(not_greater["release_ready"])


if __name__ == "__main__":
    unittest.main()
