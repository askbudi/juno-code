#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
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
        for name in ("release_train.py", "merge_queue.py"):
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


if __name__ == "__main__":
    unittest.main()
