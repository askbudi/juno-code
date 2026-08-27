#!/usr/bin/env python3
from __future__ import annotations

import hashlib
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
                "complete_input_identity": "c" * 64,
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

    def test_epoch_seal_is_complete_immutable_and_idempotent(self) -> None:
        self.prepare_epoch()
        plan = runtime.build_epoch_plan(self.root, self.declaration)
        self.assertEqual(["OLD", "REQ"], [row["task_id"] for row in plan["members"]])
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
