#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
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
        (self.root / ".gitignore").write_text(
            ".juno_task/runtime/\n.juno_task/config/controller-registration.json\n"
            ".agents/\n.claude/\n.pi/\n__pycache__/\n")
        (self.root / ".juno_task/scripts").mkdir(parents=True)
        for source in SCRIPTS.glob("*.py"):
            (self.root / ".juno_task/scripts" / source.name).write_bytes(source.read_bytes())
        template_scripts = self.root / "juno-code/src/templates/scripts"
        (template_scripts / "tests").mkdir(parents=True)
        (template_scripts / "release_train.py").write_bytes((SCRIPTS / "release_train.py").read_bytes())
        (self.root / ".juno_task/scripts/tests").mkdir(parents=True)
        test_bytes = Path(__file__).read_bytes()
        (self.root / ".juno_task/scripts/tests/test_release_train.py").write_bytes(test_bytes)
        (template_scripts / "tests/test_release_train.py").write_bytes(test_bytes)
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
        (self.root / "juno-code").mkdir(exist_ok=True)
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

    def prepare_serial_conflict_epoch(self, *, preserve_runtime: bool = False) -> tuple[str, str, list[str]]:
        """Build the portable six-member rc7/rc8 order and two-conflict topology."""
        runtime_name = "release_train-fixture.py" if preserve_runtime else "release_train.py"
        conflict_paths = [".juno_task/managed-assets.json", f".juno_task/scripts/{runtime_name}",
            "juno-code/src/cli/__tests__/release-command.test.ts",
            "juno-code/src/cli/commands/release.ts",
            f"juno-code/src/templates/scripts/{runtime_name}"]
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
        self.authorize_conflict_envelope()
        return first, second, conflict_paths

    def authorize_conflict_envelope(self) -> tuple[dict, Path]:
        initial = runtime.build_epoch_plan(self.root, self.declaration)
        envelope = initial["conflict_manifest"]["conservative_envelope"]
        authority_path = self.root / "conflict-authority.json"
        authority = {"schema_version": runtime.CONFLICT_AUTHORITY_SCHEMA, "revision": 1,
            "train_id": initial["epoch_id"],
            "input_identity_sha256": runtime.digest(runtime._forecast_input_identity(initial)),
            "logical_sets": [{"set_id": "rc7-rc8-serial", "ordered_task_ids":
                [row["task_id"] for row in envelope["ordered_members"]],
                "permitted_paths": sorted({path for row in envelope["ordered_members"]
                                           for path in row["possible_conflict_paths"]}),
                "classification": "authorization_neutral"}],
            "repair_budget": 1, "grouped_worker": True,
            "risk": {"ambiguous": False, "sensitive": False, "destructive": False,
                     "scope_expansion": False}}
        authority_path.write_text(json.dumps(authority, sort_keys=True) + "\n")
        declaration = json.loads(self.declaration.read_text())
        declaration["conflict_authority"] = {"path": str(authority_path),
            "sha256": hashlib.sha256(authority_path.read_bytes()).hexdigest()}
        self.declaration.write_text(json.dumps(declaration, sort_keys=True) + "\n")
        return authority, authority_path

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

    def test_conflict_authority_refuses_missing_ambiguous_sensitive_scope_and_identity(self) -> None:
        self.prepare_serial_conflict_epoch()
        plan = runtime.build_epoch_plan(self.root, self.declaration)
        envelope = plan["conflict_manifest"]["conservative_envelope"]
        authority_path = Path(plan["conflict_authority"]["path"])
        original = json.loads(authority_path.read_text())
        missing_plan = {**plan, "conflict_authority": None}
        self.assertEqual(["authority.missing"], runtime._conflict_authority(missing_plan, envelope)[1])
        variants = {
            "authority.logical_sets": {**original, "logical_sets": original["logical_sets"] * 2},
            "authority.risk": {**original, "risk": {**original["risk"], "sensitive": True}},
            "authority.scope": {**original, "logical_sets": [{**original["logical_sets"][0],
                "permitted_paths": []}]},
            "authority.input_identity": {**original, "input_identity_sha256": "0" * 64},
        }
        for expected, value in variants.items():
            with self.subTest(expected=expected):
                authority_path.write_text(json.dumps(value, sort_keys=True) + "\n")
                candidate = {**plan, "conflict_authority": {"path": str(authority_path),
                    "sha256": hashlib.sha256(authority_path.read_bytes()).hexdigest()}}
                binding, reasons = runtime._conflict_authority(candidate, envelope)
                self.assertIsNone(binding)
                self.assertIn(expected, reasons)
        authority_path.write_text(json.dumps(original, sort_keys=True) + "\n")

    def test_phase1_acceptance_cli_replays_semantics_and_correlates_watched_producer(self) -> None:
        self.prepare_serial_conflict_epoch(preserve_runtime=True)
        plan = runtime.build_epoch_plan(self.root, self.declaration)
        manifest = plan["conflict_manifest"]
        evidence_root = self.root / ".juno_task/runtime/phase-evidence/V9vE0X"
        evidence_root.mkdir(parents=True)
        proven = next(row for row in manifest["compositions"]
                      if row.get("decision") == "conflict_replayed")
        receipt_path = Path(proven["proven_composition"]["receipt_path"])
        receipt = json.loads(receipt_path.read_text())
        fixture = {"schema_version": "juno_release_epoch_portable_topology.v2",
            "base_sha": plan["base_sha"], "order": plan["order"],
            "members": [{"task_id": row["task_id"], "tip_sha": row["tip_sha"],
                         "tree_sha": row["tree_sha"]} for row in plan["members"]],
            "serial_conflicts": [row["task_id"] for row in manifest["conflicts"]],
            "proven_compositions": [{"task_id": proven["task_id"],
                "commit": proven["post_sha"], "tree": proven["post_tree"],
                "receipt": receipt, "receipt_bytes_b64": base64.b64encode(receipt_path.read_bytes()).decode(),
                "receipt_sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest()}]}
        fixture_path = evidence_root / "portable.json"
        fixture_path.write_text(runtime.canonical(fixture) + "\n")
        tip_sha = run(self.root, "git", "rev-parse", "HEAD")
        tree_sha = run(self.root, "git", "rev-parse", "HEAD^{tree}")
        script_path = self.root / ".juno_task/scripts/release_train.py"
        executable = str(Path(sys.executable).resolve())
        declaration_ref, authority_ref = runtime._phase1_publish_declaration(
            self.root, "V9vE0X", self.declaration)
        fixture_ref = runtime._phase1_publish_input(self.root, "V9vE0X", "fixture", fixture_path)
        repository_snapshot = runtime._phase1_repository_snapshot(self.root)
        input_identity = runtime.phase1_input_identity("V9vE0X", self.root, tip_sha, tree_sha,
            declaration_ref, fixture_ref, executable, script_path, repository_snapshot)
        proof_path = evidence_root / f'phase1-proof-{tip_sha}-{input_identity["input_sha256"]}.json'
        command = [executable, str(script_path), "--controller", str(self.root),
            "phase1-prove", "--declaration", str(self.declaration), "--fixture", str(fixture_path),
            "--task-id", "V9vE0X", "--worktree", str(self.root), "--output", str(proof_path)]
        yy = shutil.which("yy")
        self.assertIsNotNone(yy, "yy watch is required for Phase-1 evidence tests")
        watch_env = {key: value for key, value in os.environ.items()
                     if key not in {"JUNO_TASK_ROOT", "JUNO_CONTROLLER_SOURCE",
                                    "JUNO_WORKSPACE_ROLE", "JUNO_WORKSPACE_ENFORCEMENT"}
                     and not key.startswith("JUNO_CONTROL_")}
        watched = subprocess.run([yy, "watch", "exec", "--timeout", "30", "--", *command],
            cwd=self.root, env=watch_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        records = [json.loads(line) for line in watched.stdout.splitlines()
                   if line.startswith("{") and line.endswith("}")]
        watch_record = next(row for row in reversed(records)
                            if row.get("schema_version") == "juno.watch-run.v1")
        inner_log = (self.root / ".juno_task/runtime/watch-runs" /
                     watch_record["run_id"] / "combined.log")
        diagnostic = inner_log.read_text() if inner_log.is_file() else "inner watch log unavailable"
        if proof_path.is_file() and watched.returncode:
            failed_proof = json.loads(proof_path.read_text())
            actual_snapshot = (failed_proof.get("input_identity") or {}).get("repository_snapshot")
            changed_snapshot_fields = sorted(key for key in repository_snapshot
                                             if repository_snapshot.get(key) != (actual_snapshot or {}).get(key))
            diagnostic += "\nrepository snapshot drift fields=" + ",".join(changed_snapshot_fields)
        self.assertEqual(0, watched.returncode, watched.stderr + watched.stdout + diagnostic)
        proof = json.loads(proof_path.read_text())
        self.assertEqual("PASS", proof["decision"])
        self.assertEqual(input_identity, proof["input_identity"])
        self.assertIn(input_identity["input_sha256"], proof_path.name)
        self.assertTrue(all(row["working_sha256"] == row["blob_sha256"]
                            for row in proof["input_identity"]["committed_files"]))
        self.assertEqual(executable, proof["input_identity"]["runtime"]["executable_path"])
        run_id = watch_record["run_id"]
        watch_root = self.root / ".juno_task/runtime/watch-runs" / run_id
        self.assertTrue((watch_root / "run.json").is_file())
        self.assertTrue((watch_root / "footer").is_file())
        footer = (watch_root / "footer").read_text()
        def ref(path: Path) -> dict[str, str]:
            return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        def watch_ref(record: dict[str, object]) -> dict[str, str]:
            root = self.root / ".juno_task/runtime/watch-runs" / str(record["run_id"])
            return {"run_id": str(record["run_id"]),
                    "footer_sha256": hashlib.sha256((root / "footer").read_bytes()).hexdigest()}
        # The watched producer executes the exact committed focused suite and owns all
        # result/runtime/environment fields. The closure carries references only.
        suite_env = {**watch_env, "JUNO_TASK_ROOT": str(self.root),
                     "JUNO_WORKSPACE_ROLE": "controller", "JUNO_WORKSPACE_ENFORCEMENT": "strict"}
        test_blob = runtime._git_blob_hash(self.root, tip_sha, runtime.PHASE1_COMMITTED_PATHS[1])
        suite_manifest = {**runtime.PHASE1_SUITE_MANIFEST, "test_blob_sha256": test_blob}
        evidence_context = runtime.digest(watch_ref(watch_record))
        suite_identity = runtime.digest({"tip_sha": tip_sha, "tree_sha": tree_sha,
            "manifest_sha256": runtime.digest(suite_manifest),
            "evidence_context": evidence_context})
        suite_path = evidence_root / f"phase1-suite-{suite_identity}.json"
        suite_command = runtime._phase1_suite_argv(
            self.root, self.root, suite_path, evidence_context)
        suite_watch = subprocess.run([yy, "watch", "exec", "--timeout", "120", "--", *suite_command],
            cwd=self.root, env=suite_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        suite_records = [json.loads(line) for line in suite_watch.stdout.splitlines()
                         if line.startswith("{") and line.endswith("}")]
        suite_record = next(row for row in reversed(suite_records)
                            if row.get("schema_version") == "juno.watch-run.v1")
        suite_root = self.root / ".juno_task/runtime/watch-runs" / suite_record["run_id"]
        self.assertEqual(0, suite_watch.returncode, suite_watch.stderr + suite_watch.stdout
                         + ((suite_root / "combined.log").read_text() if suite_root.is_dir() else ""))
        suite_receipt = json.loads(suite_path.read_text())
        self.assertEqual("PASS", suite_receipt["decision"])
        self.assertEqual(len(runtime.PHASE1_SUITE_TESTS), suite_receipt["result"]["test_count"])
        self.assertEqual(suite_manifest, suite_receipt["suite_manifest"])
        self.assertEqual(set(runtime.PHASE1_ENV_KEYS), set(suite_receipt["observed_environment"]))
        self.assertEqual(sorted([*runtime.PHASE1_SUITE_TESTS, runtime.PHASE1_ORCHESTRATION_TEST]),
                         suite_receipt["discovered_tests"])
        self.assertFalse((self.root / ".juno_task/scripts/tests/.juno_task/runtime/watch-runs"
                          / suite_record["run_id"]).exists())
        closure = {"schema_version": runtime.PHASE1_CLOSURE_SCHEMA, "proof": ref(proof_path),
            "watch": {"run_id": run_id, "footer_sha256": hashlib.sha256(footer.encode()).hexdigest()},
            "suite": {"watch": watch_ref(suite_record), "receipt": ref(suite_path)}}
        checked = {"proof_sha256": proof["proof_sha256"],
            "input_sha256": proof["input_identity"]["input_sha256"],
            "declaration": proof["declaration"], "authority": proof["authority"],
            "fixture": proof["fixture"], "manifest_sha256": proof["manifest"]["manifest_sha256"],
            "proof_watch": closure["watch"], "suite_receipt_sha256": suite_receipt["receipt_sha256"],
            "suite_watch": closure["suite"]["watch"], "suite_argv": suite_receipt["producer_argv"],
            "suite_command": suite_receipt["suite_command"], "suite_cwd": suite_receipt["suite_cwd"],
            "suite_manifest": suite_receipt["suite_manifest"],
            "suite_manifest_sha256": suite_receipt["suite_manifest_sha256"],
            "suite_runtime": suite_receipt["runtime"],
            "suite_environment": suite_receipt["observed_environment"],
            "suite_environment_sha256": suite_receipt["environment_sha256"],
            "suite_result": suite_receipt["result"]}
        closure_sha = runtime.digest(checked)
        closure_path = evidence_root / "closure.json"; closure_path.write_text(runtime.canonical(closure) + "\n")
        evaluation = evidence_root / f"phase1-evaluation-{closure_sha}.json"
        accept = [executable, str(script_path), "--controller", str(self.root),
            "phase1-accept", "--closure", str(closure_path), "--output", str(evaluation)]
        acceptance_watch = subprocess.run([yy, "watch", "exec", "--timeout", "30", "--", *accept],
            cwd=self.root, env=suite_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        acceptance_records = [json.loads(line) for line in acceptance_watch.stdout.splitlines()
                              if line.startswith("{") and line.endswith("}")]
        acceptance_record = next(row for row in reversed(acceptance_records)
                                 if row.get("schema_version") == "juno.watch-run.v1")
        acceptance_log = (self.root / ".juno_task/runtime/watch-runs" /
                          acceptance_record["run_id"] / "combined.log")
        self.assertEqual(0, acceptance_watch.returncode,
                         acceptance_watch.stderr + acceptance_watch.stdout
                         + (acceptance_log.read_text() if acceptance_log.is_file() else ""))
        evaluation_receipt = json.loads(evaluation.read_text())
        self.assertEqual("PASS", evaluation_receipt["decision"], evaluation_receipt)
        output = evidence_root / f"phase1-acceptance-{closure_sha}.json"
        receipt_result = runtime.phase1_finalize_acceptance(
            self.root, ref(evaluation), watch_ref(acceptance_record), output)
        self.assertEqual("PASS", receipt_result["decision"], receipt_result)
        self.assertEqual(receipt_result, runtime.phase1_finalize_acceptance(
            self.root, ref(evaluation), watch_ref(acceptance_record), output))

        # An unrelated successful command cannot substitute for the suite even with
        # caller-forged PASS/count/blob/environment fields.
        help_command = [executable, str(script_path), "--help"]
        help_watch = subprocess.run([yy, "watch", "exec", "--timeout", "30", "--", *help_command],
            cwd=self.root, env=suite_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        help_records = [json.loads(line) for line in help_watch.stdout.splitlines()
                        if line.startswith("{") and line.endswith("}")]
        help_record = next(row for row in reversed(help_records)
                           if row.get("schema_version") == "juno.watch-run.v1")
        self.assertEqual(0, help_watch.returncode)
        forged_suite = json.loads(suite_path.read_text())
        forged_suite["producer_argv"] = help_command
        forged_suite["result"] = {"outcome": "PASS", "test_count": len(runtime.PHASE1_SUITE_TESTS),
            "exit_code": 0, "output_sha256": hashlib.sha256(
                (self.root / ".juno_task/runtime/watch-runs" / help_record["run_id"] /
                 "combined.log").read_bytes()).hexdigest()}
        forged_body = {key: value for key, value in forged_suite.items() if key != "receipt_sha256"}
        forged_suite["receipt_sha256"] = runtime.digest(forged_body)
        forged_suite_path = evidence_root / "forged-suite.json"
        forged_suite_path.write_text(runtime.canonical(forged_suite) + "\n")
        forged_closure = {**closure, "suite": {"watch": watch_ref(help_record),
                                                "receipt": ref(forged_suite_path)}}
        forged_closure_path = evidence_root / "forged-closure.json"
        forged_closure_path.write_text(runtime.canonical(forged_closure) + "\n")
        rejected = runtime.phase1_acceptance_receipt(self.root, forged_closure_path, evaluation, accept)
        self.assertEqual("FAIL", rejected["decision"])
        self.assertIn("suite.closure", rejected["blocking_reason_codes"])

        original_suite = suite_path.read_bytes()
        environment = suite_receipt["observed_environment"]
        missing_environment = dict(environment); missing_environment.pop("PYTHONHASHSEED")
        substitutions = {
            "runtime": {**suite_receipt, "runtime": {**suite_receipt["runtime"],
                "executable_sha256": "0" * 64}},
            "argv": {**suite_receipt, "producer_argv": help_command},
            "cwd": {**suite_receipt, "suite_cwd": str(self.root)},
            "command": {**suite_receipt, "suite_command": help_command},
            "manifest_membership": {**suite_receipt, "suite_manifest": {
                **suite_receipt["suite_manifest"],
                "tests": suite_receipt["suite_manifest"]["tests"][:-1]}},
            "result_count": {**suite_receipt, "result": {
                **suite_receipt["result"], "test_count": len(runtime.PHASE1_SUITE_TESTS) - 1}},
            "environment_extra": {**suite_receipt, "observed_environment": {
                **environment, "UNAPPROVED_SECRET": "redacted"}},
            "environment_missing": {**suite_receipt, "observed_environment": missing_environment},
            "environment_git": {**suite_receipt, "observed_environment": {
                **environment, "GIT_CONFIG_GLOBAL": str(self.root / "substitute")}},
            "environment_python": {**suite_receipt, "observed_environment": {
                **environment, "PYTHONHASHSEED": "random"}},
            "environment_locale": {**suite_receipt, "observed_environment": {
                **environment, "LC_ALL": "en_US.UTF-8"}},
            "environment_temp": {**suite_receipt, "observed_environment": {
                **environment, "TMPDIR": str(self.root / "other-tmp")}},
            "environment_path": {**suite_receipt, "observed_environment": {
                **environment, "PATH": "/arbitrary"}},
        }
        for name, candidate in substitutions.items():
            with self.subTest(substitution=name):
                if "observed_environment" in candidate:
                    candidate["environment_sha256"] = runtime.digest(candidate["observed_environment"])
                candidate_body = {key: value for key, value in candidate.items()
                                  if key != "receipt_sha256"}
                candidate["receipt_sha256"] = runtime.digest(candidate_body)
                suite_path.write_text(runtime.canonical(candidate) + "\n")
                refused = runtime.phase1_acceptance_receipt(
                    self.root, closure_path, evaluation, accept)
                self.assertEqual("FAIL", refused["decision"])
                self.assertIn("suite.closure", refused["blocking_reason_codes"])
        suite_path.write_bytes(original_suite)
        original_proof = proof_path.read_bytes(); original_closure = closure_path.read_bytes()
        forged = json.loads(original_proof); forged["manifest"]["operator_state"] = "FEASIBLE_FORGED"
        forged_body = {key: value for key, value in forged.items() if key != "proof_sha256"}
        forged["proof_sha256"] = runtime.digest(forged_body)
        proof_path.write_text(runtime.canonical(forged) + "\n")
        closure["proof"] = ref(proof_path); closure_path.write_text(runtime.canonical(closure) + "\n")
        replayed = runtime.phase1_acceptance_receipt(
            self.root, closure_path, evaluation, accept)
        self.assertEqual("FAIL", replayed["decision"])
        self.assertIn("manifest.replay", replayed["blocking_reason_codes"])
        proof_path.write_bytes(original_proof); closure_path.write_bytes(original_closure)

        external_authority = evidence_root / "external-authority.json"
        external_authority.write_bytes(Path(proof["authority"]["path"]).read_bytes())
        substituted_declaration = json.loads(Path(proof["declaration"]["path"]).read_text())
        substituted_declaration["conflict_authority"] = {
            "path": str(external_authority), "sha256": proof["authority"]["sha256"]}
        substituted_declaration_path = evidence_root / "substituted-declaration.json"
        substituted_declaration_path.write_text(runtime.canonical(substituted_declaration) + "\n")
        substituted_proof = json.loads(original_proof)
        substituted_proof["declaration"] = ref(substituted_declaration_path)
        substituted_body = {key: value for key, value in substituted_proof.items()
                            if key != "proof_sha256"}
        substituted_proof["proof_sha256"] = runtime.digest(substituted_body)
        proof_path.write_text(runtime.canonical(substituted_proof) + "\n")
        closure["proof"] = ref(proof_path); closure_path.write_text(runtime.canonical(closure) + "\n")
        authority_refused = runtime.phase1_acceptance_receipt(
            self.root, closure_path, evaluation, accept)
        self.assertEqual("FAIL", authority_refused["decision"])
        self.assertIn("authority.path_substitution", authority_refused["blocking_reason_codes"])
        proof_path.write_bytes(original_proof); closure_path.write_bytes(original_closure)
        durable_fixture = Path(proof["fixture"]["path"])
        original = durable_fixture.read_bytes(); durable_fixture.write_bytes(original + b"tamper\n")
        failed = subprocess.run(accept, cwd=self.root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(2, failed.returncode)
        durable_fixture.write_bytes(original)
        role_roots = {"proof": watch_root, "suite": suite_root,
                      "evaluation": self.root / ".juno_task/runtime/watch-runs" /
                      acceptance_record["run_id"]}
        matrix = [(role, field) for role in role_roots for field in ("argv", "cwd", "footer")]
        self.assertEqual({(role, field) for role in ("proof", "suite", "evaluation")
                          for field in ("argv", "cwd", "footer")}, set(matrix))
        for role, field in matrix:
            with self.subTest(role=role, field=field):
                role_root = role_roots[role]
                run_path = role_root / "run.json"; footer_path = role_root / "footer"
                original_run = run_path.read_bytes(); original_footer = footer_path.read_bytes()
                if field == "footer":
                    footer_path.write_text("schema_version=juno.watch-footer.v1\nexit_code=1\n")
                else:
                    record = json.loads(original_run)
                    record["argv_sha256" if field == "argv" else "cwd"] = (
                        "0" * 64 if field == "argv" else str(self.root / "substituted-cwd"))
                    run_path.write_text(json.dumps(record) + "\n")
                try:
                    if role == "evaluation":
                        correlated = runtime.phase1_finalize_acceptance(
                            self.root, ref(evaluation), watch_ref(acceptance_record), output)
                    else:
                        correlated = runtime.phase1_acceptance_receipt(
                            self.root, closure_path, evaluation, accept)
                    self.assertEqual("FAIL", correlated["decision"])
                    self.assertIn(f"{role}.watch.identity", correlated["blocking_reason_codes"])
                finally:
                    run_path.write_bytes(original_run); footer_path.write_bytes(original_footer)
        committed_path = self.root / ".juno_task/scripts/tests/test_release_train.py"
        committed_bytes = committed_path.read_bytes()
        committed_path.write_bytes(committed_bytes + b"\n# tracked drift\n")
        drifted = runtime.phase1_acceptance_receipt(
            self.root, closure_path, evaluation, accept)
        self.assertEqual("FAIL", drifted["decision"])
        self.assertIn("task.committed_bytes", drifted["blocking_reason_codes"])
        committed_path.write_bytes(committed_bytes)
        orchestrate = [executable, str(script_path), "--controller", str(self.root),
            "phase1-orchestrate", "--declaration", str(self.declaration),
            "--fixture", str(fixture_path), "--task-id", "V9vE0X",
            "--worktree", str(self.root)]
        orchestrated = subprocess.run(orchestrate, cwd=self.root, env=suite_env, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=480)
        self.assertEqual(0, orchestrated.returncode, orchestrated.stderr + orchestrated.stdout)
        projection = json.loads(orchestrated.stdout.splitlines()[-1])
        self.assertEqual("PASS", projection["decision"])
        self.assertEqual({"proof", "suite", "evaluation"},
                         set(projection["stage_watch_run_ids"]))
        self.assertEqual("V9vE0X", projection["task_id"])
        final_receipt = json.loads(Path(projection["receipt"]["path"]).read_text())
        self.assertEqual(list(runtime.PHASE1_SUITE_TESTS),
                         final_receipt["checked_closure"]["suite_manifest"]["tests"])
        source = (SCRIPTS / "release_train.py").read_text()
        self.assertEqual(1, source.count("def phase1_acceptance_receipt("))

    def test_phase1_substitution_matrix_is_complete_and_receipt_bound(self) -> None:
        """Exercise the non-recursive role/environment matrix named by the suite manifest."""
        test_path = Path(__file__).resolve()
        discovered = runtime._phase1_discovered_tests(test_path)
        self.assertEqual(sorted([*runtime.PHASE1_SUITE_TESTS, runtime.PHASE1_ORCHESTRATION_TEST]),
                         discovered)
        self.assertIn(
            "ReleaseTrainTests.test_phase1_substitution_matrix_is_complete_and_receipt_bound",
            runtime.PHASE1_SUITE_MANIFEST["tests"])
        self.assertEqual([runtime.PHASE1_ORCHESTRATION_TEST],
                         runtime.PHASE1_SUITE_MANIFEST["excluded_recursive_tests"])

        required_matrix = {(role, field) for role in ("proof", "suite", "evaluation")
                           for field in ("argv", "cwd", "footer")}
        exercised: set[tuple[str, str]] = set()
        expected_argv = [str(Path(sys.executable).resolve()), "producer.py", "--structured"]
        for role, field in sorted(required_matrix):
            with self.subTest(role=role, field=field):
                run_id = f"matrix-{role}-{field}"
                run_root = self.root / ".juno_task/runtime/watch-runs" / run_id
                run_root.mkdir(parents=True, exist_ok=True)
                footer = ("schema_version=juno.watch-footer.v1\nexit_code=0\n"
                          "completed_utc=2026-08-28T00:00:00Z\n")
                (run_root / "footer").write_text(footer)
                (run_root / "combined.log").write_text("structured PASS\n")
                record = {"run_id": run_id, "state": "COMPLETED", "exit_code": 0,
                    "cwd": str(self.root), "argv_sha256": hashlib.sha256(
                        json.dumps(expected_argv, separators=(",", ":")).encode()).hexdigest()}
                (run_root / "run.json").write_text(json.dumps(record) + "\n")
                reference = {"run_id": run_id,
                    "footer_sha256": hashlib.sha256(footer.encode()).hexdigest()}
                self.assertEqual([], runtime._phase1_watch_correlation(
                    self.root, reference, expected_argv))
                if field == "footer":
                    (run_root / "footer").write_text(
                        "schema_version=juno.watch-footer.v1\nexit_code=1\n")
                else:
                    record["argv_sha256" if field == "argv" else "cwd"] = (
                        "0" * 64 if field == "argv" else str(self.root / "substituted-cwd"))
                    (run_root / "run.json").write_text(json.dumps(record) + "\n")
                self.assertIn("watch.identity", runtime._phase1_watch_correlation(
                    self.root, reference, expected_argv))
                exercised.add((role, field))
        self.assertEqual(required_matrix, exercised)

        required_suite_substitutions = {
            "help", "arbitrary_success", "forged_result", "result_count", "argv", "cwd",
            "runtime", "footer", "environment", "authority_path", "manifest_membership",
        }
        suite_contract = {"producer_argv": expected_argv, "suite_command": ["python", "tests"],
            "suite_cwd": str(self.root / "tests"), "runtime": {"executable_sha256": "a" * 64},
            "result": {"outcome": "PASS", "test_count": len(runtime.PHASE1_SUITE_TESTS),
                       "exit_code": 0},
            "suite_manifest": runtime.PHASE1_SUITE_MANIFEST,
            "observed_environment": {key: "bound" for key in runtime.PHASE1_ENV_KEYS}}
        suite_substitutions = {
            "help": {**suite_contract, "producer_argv": [*expected_argv[:2], "--help"]},
            "arbitrary_success": {**suite_contract, "producer_argv": ["true"]},
            "forged_result": {**suite_contract, "result": {"outcome": "PASS"}},
            "result_count": {**suite_contract, "result": {
                **suite_contract["result"], "test_count": len(runtime.PHASE1_SUITE_TESTS) - 1}},
            "argv": {**suite_contract, "producer_argv": ["substituted"]},
            "cwd": {**suite_contract, "suite_cwd": "/substituted"},
            "runtime": {**suite_contract, "runtime": {"executable_sha256": "0" * 64}},
            "footer": {**suite_contract, "footer_sha256": "0" * 64},
            "environment": {**suite_contract, "observed_environment": {}},
            "authority_path": {**suite_contract, "authority": {"path": "/substituted"}},
            "manifest_membership": {**suite_contract, "suite_manifest": {
                **runtime.PHASE1_SUITE_MANIFEST,
                "tests": runtime.PHASE1_SUITE_MANIFEST["tests"][:-1]}},
        }
        self.assertEqual(required_suite_substitutions, set(suite_substitutions))
        for name, candidate in suite_substitutions.items():
            with self.subTest(suite_substitution=name):
                self.assertNotEqual(runtime.digest(suite_contract), runtime.digest(candidate))

        output = self.root / ".juno_task/runtime/phase-evidence/V9vE0X/matrix.json"
        ambient = {"GIT_CONFIG_GLOBAL": "/ambient/gitconfig", "PYTHONPATH": "/ambient/python",
                   "LC_ALL": "en_US.UTF-8", "TMPDIR": "/ambient/tmp",
                   "YYLO_SECRET_TOKEN": "must-not-cross"}
        with mock.patch.dict(os.environ, ambient, clear=False):
            environment = runtime._phase1_suite_environment(self.root, output)
        self.assertEqual(set(runtime.PHASE1_ENV_KEYS), set(environment))
        self.assertFalse(set(environment) & {"PYTHONPATH", "YYLO_SECRET_TOKEN"})
        self.assertEqual("/dev/null", environment["GIT_CONFIG_GLOBAL"])
        self.assertEqual("C", environment["LC_ALL"])
        self.assertNotEqual("/ambient/tmp", environment["TMPDIR"])
        environment_substitutions = {
            "missing_required": {key: value for key, value in environment.items()
                                 if key != "PYTHONHASHSEED"},
            "git": {**environment, "GIT_CONFIG_GLOBAL": "/substituted"},
            "python": {**environment, "PYTHONHASHSEED": "random"},
            "locale": {**environment, "LC_ALL": "en_US.UTF-8"},
            "temp": {**environment, "TMPDIR": "/substituted"},
            "configuration": {**environment, "JUNO_TASK_ROOT": "/substituted"},
            "secret_extra": {**environment, "YYLO_SECRET_TOKEN": "redacted"},
        }
        for name, candidate in environment_substitutions.items():
            with self.subTest(environment=name):
                self.assertNotEqual(environment, candidate)
                self.assertNotEqual(runtime.digest(environment), runtime.digest(candidate))

        self.prepare_serial_conflict_epoch(preserve_runtime=True)
        declaration_ref, authority_ref = runtime._phase1_publish_declaration(
            self.root, "V9vE0X", self.declaration)
        canonical_root = self.root / ".juno_task/runtime/phase-evidence/V9vE0X/inputs"
        self.assertEqual(canonical_root, Path(declaration_ref["path"]).parent)
        self.assertEqual(canonical_root, Path(authority_ref["path"]).parent)
        external_authority = self.root / "external-authority.json"
        external_authority.write_bytes(Path(authority_ref["path"]).read_bytes())
        substituted = {"path": str(external_authority), "sha256": authority_ref["sha256"]}
        self.assertNotEqual(authority_ref, substituted)

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
