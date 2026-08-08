#!/usr/bin/env python3
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "task_lifecycle.py"
spec = importlib.util.spec_from_file_location("task_lifecycle", SCRIPT)
assert spec and spec.loader
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class TaskLifecycleContractTests(unittest.TestCase):
    def manifest(self, root: Path, paths: list[str], risk: str = "medium") -> dict:
        checklist = root / "requirements.md"; checklist.parent.mkdir(parents=True, exist_ok=True); checklist.write_text("requirements\n")
        return {
            "schema_version": "juno_task_lifecycle.v1",
            "task_id": "T1",
            "objective_risk": risk,
            "owner_risk_escalation": None,
            "repositories": [{
                "id": "root", "path": str(root), "target_ref": "refs/heads/main",
                "approved_base_sha": "a" * 40, "task_worktree": str(root / "task"),
                "task_branch_ref": "refs/heads/task/T1", "expected_paths": paths,
            }],
            "artifact_root": str(root / "artifacts"),
            "controller_root": str(root / "controller"),
            "requirements_checklist": str(checklist),
            "review": {"initial_pair_limit": 1, "replacement_pair_limit": 1},
        }

    def test_single_repository_and_risk_are_frozen(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = lifecycle.validate_manifest(self.manifest(root, ["src/value.ts"]))
            self.assertEqual("medium", value["effective_risk"])
            high = lifecycle.validate_manifest(self.manifest(root, ["src/templates/scripts/task.py"], "low"))
            self.assertEqual("high", high["deterministic_risk"])
            self.assertEqual("high", high["effective_risk"])
            ambiguous = lifecycle.validate_manifest(self.manifest(root, ["artifacts/change.bin"], "low"))
            self.assertEqual("high", ambiguous["deterministic_risk"])

    def test_owner_can_escalate_but_not_downgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = self.manifest(root, ["README.md"], "low")
            value["owner_risk_escalation"] = "high"
            self.assertEqual("high", lifecycle.validate_manifest(value)["effective_risk"])
            value = self.manifest(root, ["src/templates/scripts/task.py"], "high")
            value["owner_risk_escalation"] = "medium"
            with self.assertRaisesRegex(lifecycle.LifecycleError, "cannot downgrade"):
                lifecycle.validate_manifest(value)

    def test_ambiguous_and_multiple_repository_inputs_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = self.manifest(root, [], "low")
            with self.assertRaisesRegex(lifecycle.LifecycleError, "expected_paths"):
                lifecycle.validate_manifest(value)
            value = self.manifest(root, ["README.md"])
            value["requirements_checklist"] = str(root / "missing.md")
            with self.assertRaisesRegex(lifecycle.LifecycleError, "requirements_checklist"):
                lifecycle.validate_manifest(value)
            value = self.manifest(root, ["README.md"])
            value["review"]["owner_authorized_extension_pair_limit"] = 9
            with self.assertRaisesRegex(lifecycle.LifecycleError, "bounded count"):
                lifecycle.validate_manifest(value)
            value = self.manifest(root, ["README.md"])
            value["repositories"].append(dict(value["repositories"][0], id="child"))
            with self.assertRaisesRegex(lifecycle.LifecycleError, "exactly one"):
                lifecycle.validate_manifest(value)

    def test_resume_parser_uses_only_state_and_reads_frozen_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = lifecycle.validate_manifest(self.manifest(root, ["README.md"], "low"))
            manifest_path = root / "manifest.json"; lifecycle.atomic_json(manifest_path, manifest)
            state = lifecycle.new_state(manifest_path, manifest); state_path = root / "state.json"
            lifecycle.save_state(state_path, state, "COMPLETE")
            result = subprocess.run([sys.executable, str(SCRIPT), "resume", "--state", str(state_path)], text=True, capture_output=True)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual("COMPLETE", json.loads(result.stdout)["phase"])

    def test_strict_review_verdict_rejects_ambiguity(self):
        self.assertEqual(("PASS", []), lifecycle.strict_verdict("JUNO_REVIEW_VERDICT: PASS\n"))
        status, findings = lifecycle.strict_verdict(
            "JUNO_REVIEW_FINDING: high; CAS; file.py:2; bind expected SHA\n"
        )
        self.assertEqual("FINDINGS", status)
        self.assertEqual(1, len(findings))
        with self.assertRaisesRegex(lifecycle.LifecycleError, "contradictory"):
            lifecycle.strict_verdict(
                "JUNO_REVIEW_VERDICT: PASS\nJUNO_REVIEW_FINDING: high; CAS; x; fix\n"
            )
        echoed = (
            "Prompt example:\nJUNO_REVIEW_VERDICT: PASS\n\n"
            "Alternative example:\nJUNO_REVIEW_FINDING: <severity>; <requirement>; <evidence>; <acceptance>\n\n"
            "Semantic response:\nJUNO_REVIEW_FINDING: high; CAS; file.py:2; bind expected SHA\n"
        )
        self.assertEqual("FINDINGS", lifecycle.strict_verdict(echoed)[0])
        with self.assertRaisesRegex(lifecycle.LifecycleError, "contradictory"):
            lifecycle.strict_verdict("JUNO_REVIEW_VERDICT: PASS\nJUNO_REVIEW_FINDING: high; CAS; x; fix\n")
        with self.assertRaisesRegex(lifecycle.LifecycleError, "lacks"):
            lifecycle.strict_verdict("looks good")

    def _assert_review_identity_rejected(self, outputs: list[str], message: str) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); prompt = root / "prompt.md"; prompt.write_text("review\n")
            manifest = self.manifest(root, ["product.txt"], "high")
            manifest["timeouts"] = {"agent_seconds": 30}
            state = {"candidate_sha": "b" * 40, "effective_risk": "high", "review_round": 0,
                     "review_passed": False, "receipts": {}}
            results = iter(outputs)

            def fake_run(_command, _cwd, artifact, **_kwargs):
                artifact.mkdir(parents=True, exist_ok=True)
                (artifact / "receipt.json").write_text("{}\n")
                return {"timed_out": False, "exit_code": 0, "stdout_text": next(results), "stderr_text": ""}

            def fake_git(_repo, *args, **_kwargs):
                return "" if args and args[0] == "status" else "b" * 40

            with mock.patch.object(lifecycle, "git", side_effect=fake_git), \
                 mock.patch.object(lifecycle, "render_review", return_value=prompt), \
                 mock.patch.object(lifecycle, "run_command", side_effect=fake_run):
                with self.assertRaisesRegex(lifecycle.LifecycleError, message):
                    lifecycle.review_pair(manifest, state, root / "state.json")
            self.assertFalse(state["review_passed"])
            self.assertEqual(0, state["review_round"])
            self.assertFalse((root / "review-1" / "pair.json").exists())

    def test_high_risk_review_pair_rejects_missing_session_identity(self):
        self._assert_review_identity_rejected(["JUNO_REVIEW_VERDICT: PASS\n"], "lacks fresh session identity")

    def test_high_risk_review_pair_rejects_duplicate_session_identity(self):
        output = "JUNO_REVIEW_VERDICT: PASS\nsession_id: same-session\n"
        self._assert_review_identity_rejected([output, output], "reused review session identity")

    def test_one_time_review_extension_is_receipt_bound_and_capped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = self.manifest(root, ["README.md"], "high")
            manifest["review"]["owner_authorized_extension_pair_limit"] = 1
            manifest = lifecycle.validate_manifest(manifest); candidate = "b" * 40
            receipt = root / "extension.json"
            lifecycle.atomic_json(receipt, {"schema_version":"juno_review_budget_extension.v1","task_id":"T1",
                "candidate_sha":candidate,"additional_consolidated_repairs":1,"additional_replacement_pairs":1,"bounded":True})
            state = {"task_id":"T1","review_budget_extension_base_shas":{"1":candidate},"receipts":{
                "review_budget_extension_1":{"path":str(receipt),"sha256":lifecycle.file_digest(receipt)}}}
            self.assertEqual(3, lifecycle.maximum_review_round(manifest, state))
            state["review_budget_extension_base_shas"]["1"] = "c" * 40
            with self.assertRaisesRegex(lifecycle.LifecycleError, "extension 1 evidence"):
                lifecycle.maximum_review_round(manifest, state)

    def test_unsuccessful_controller_sync_outcomes_withhold_terminal_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = self.manifest(root, ["README.md"], "high")
            state = {"controller_sync":"not_enabled"}
            for outcome in ("not_enabled", "unknown", "failed_preserved"):
                state["controller_sync"] = outcome
                self.assertFalse(lifecycle.terminal_controller_readback(manifest, state, root / "state.json"))

    def test_compact_result_keeps_partial_dimensions_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_text("{}")
            state = lifecycle.new_state(manifest_path, {
                "task_id": "T1", "effective_risk": "high"
            })
            state.update({"phase": "ACTUAL_TARGET_VERIFIED", "candidate_sha": "a" * 40,
                          "integrated_sha": "b" * 40, "integration_status": "integrated",
                          "actual_target_verification": "passed", "cleanup_status": "not_started"})
            result = lifecycle.compact_result(state)
            self.assertEqual("integrated", result["integration_status"])
            self.assertEqual("not_started", result["cleanup_status"])
            self.assertIsNone(result["release_sha"])

    def test_owner_waiver_is_kanban_only_candidate_bound_and_never_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); controller = root / "controller"; scripts = controller / ".juno_task/scripts"
            scripts.mkdir(parents=True)
            candidate = "b" * 40
            payload = [{"id":"T1","fields":{"lifecycle_review":{"status":"waived_by_owner","candidate_sha":candidate,"reason":"owner decision"}}}]
            wrapper = scripts / "kanban.sh"
            wrapper.write_text("#!/bin/sh\nprintf '%s' '" + json.dumps(payload) + "'\n")
            wrapper.chmod(0o755)
            manifest = self.manifest(root, ["README.md"], "low"); manifest["controller_root"] = str(controller)
            state = {"candidate_sha": candidate, "effective_risk": "low"}
            waiver = lifecycle.owner_waiver(manifest, state)
            self.assertEqual("waived_by_owner", waiver["status"])
            self.assertFalse(waiver["review_passed"])
            self.assertEqual("low", waiver["objective_risk"])
            state["candidate_sha"] = "c" * 40
            self.assertIsNone(lifecycle.owner_waiver(manifest, state))

    def test_state_file_is_hash_bound_and_status_is_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text("{}")
            state = lifecycle.new_state(manifest_path, {"task_id": "T1", "effective_risk": "high"})
            state_path = root / "state.json"
            lifecycle.save_state(state_path, state, "PLANNED")
            before = state_path.read_bytes()
            loaded = lifecycle.load_state(state_path)
            lifecycle.compact_result(loaded)
            self.assertEqual(before, state_path.read_bytes())
            self.assertEqual(lifecycle.digest({k: v for k, v in loaded.items() if k != "state_sha256"}), loaded["state_sha256"])


class RealGitLifecycleCanaryTests(unittest.TestCase):
    def git(self, repo: Path, *args: str) -> str:
        result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True)
        self.assertEqual(0, result.returncode, result.stderr)
        return result.stdout.strip()

    def write_executable(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o755)

    def run_canary(self, risk: str, mode: str = "pass") -> tuple[dict, list[dict]]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        repo = root / "repo"; controller = repo
        repo.mkdir()
        self.git(repo, "init", "-b", "main")
        self.git(repo, "config", "user.name", "Test")
        self.git(repo, "config", "user.email", "test@example.com")
        (repo / "product.txt").write_text("base\n")
        (repo / ".juno_task/prompts").mkdir(parents=True)
        (repo / ".juno_task/prompts/review_commit_parallel_runner.md").write_text(
            "Task {{ task_id }} Reviewer {{ reviewer_index }} Base {{ base_sha }} Tip {{ tip_sha }} "
            "Repository {{ repository }} Checklist {{ checklist_path }} Prior {{ findings_summary_path }} "
            "Validation {{ validation_evidence_path }} Bundle {{ requirements_bundle }} PriorBody {{ findings_summary }}\n"
            "JUNO_REVIEW_VERDICT: PASS is the only passing class.\n"
        )
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "base")
        base = self.git(repo, "rev-parse", "HEAD")
        scripts = repo / ".juno_task/scripts"
        scripts.mkdir(parents=True)
        self.write_executable(scripts / "controller_checkpoint.py", "#!/usr/bin/env python3\n")
        self.write_executable(scripts / "kanban.sh", '''#!/usr/bin/env python3
import json,subprocess,sys
refs=subprocess.check_output(["git","for-each-ref","--format=%(refname)","refs/heads/task/"],text=True).splitlines()
tip=subprocess.check_output(["git","rev-parse",refs[0]],text=True).strip() if refs else None
print(json.dumps({"id":sys.argv[2],"status":"in_progress","commit_hash":tip,"fields":{}}))
''')
        self.write_executable(scripts / "worktree_lifecycle.py", '''#!/usr/bin/env python3
import argparse,json,subprocess
from pathlib import Path
p=argparse.ArgumentParser();s=p.add_subparsers(dest="cmd",required=True)
for name in ("create","verify","edit-preflight","cleanup"):
 q=s.add_parser(name);q.add_argument("--output",type=Path,required=True);q.add_argument("--repository",type=Path);q.add_argument("--path",type=Path);q.add_argument("--manifest",type=Path);q.add_argument("--verify-receipt",type=Path);q.add_argument("--target-ref");q.add_argument("--expected-base");q.add_argument("--approved-base");q.add_argument("--branch-ref");q.add_argument("--task-id");q.add_argument("--expected-path",action="append");q.add_argument("--cleanup-owner");q.add_argument("--expected-head");q.add_argument("--task-worktree");q.add_argument("--task-branch-ref");q.add_argument("--next-receipt");q.add_argument("--delete-branch",action="store_true")
a=p.parse_args()
if a.cmd=="create": subprocess.run(["git","-C",str(a.repository),"worktree","add","-b",a.branch_ref.removeprefix("refs/heads/"),str(a.path),a.expected_base],check=True);v={"schema_version":"fixture","operation":"create","worktree":str(a.path),"base_sha":a.expected_base}
elif a.cmd=="verify": v={"schema_version":"fixture","operation":"verify","passed":True}
elif a.cmd=="edit-preflight": v={"schema_version":"fixture","operation":"edit_preflight","passed":True,"expected_path_dispositions":{x:"planned_new" for x in a.expected_path or []}}
else:
 head=subprocess.check_output(["git","-C",str(a.path),"rev-parse","HEAD"],text=True).strip()
 if head!=a.expected_head: raise SystemExit("unexpected_head")
 subprocess.run(["git","-C",str(a.repository),"worktree","remove",str(a.path)],check=True)
 if a.delete_branch: subprocess.run(["git","-C",str(a.repository),"branch","-D",a.branch_ref.removeprefix("refs/heads/")],check=True)
 v={"schema_version":"fixture","operation":"cleanup","passed":True,"removed":True,"expected_head":a.expected_head}
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(v));print(json.dumps(v))
''')
        self.write_executable(scripts / "integration_candidate.py", '''#!/usr/bin/env python3
import argparse,json,subprocess
from pathlib import Path
p=argparse.ArgumentParser();s=p.add_subparsers(dest="cmd",required=True)
q=s.add_parser("target-preflight");q.add_argument("--repository",type=Path,required=True);q.add_argument("--target-ref",required=True);q.add_argument("--approved-base",required=True);q.add_argument("--output",type=Path,required=True)
q=s.add_parser("plan");q.add_argument("--repository",type=Path,required=True);q.add_argument("--target-ref",required=True);q.add_argument("--base-sha",required=True);q.add_argument("--reviewed-tip",required=True);q.add_argument("--task-worktree",type=Path,required=True);q.add_argument("--task-id");q.add_argument("--expected-path",action="append");q.add_argument("--premerge-review");q.add_argument("--owner-waiver");q.add_argument("--pdr-matrix");q.add_argument("--target-channel-owner");q.add_argument("--output",type=Path,required=True)
q=s.add_parser("build");q.add_argument("--plan",type=Path,required=True);q.add_argument("--candidate-path",type=Path);q.add_argument("--validation-command");q.add_argument("--output",type=Path,required=True)
q=s.add_parser("verify");q.add_argument("--candidate",type=Path,required=True);q.add_argument("--candidate-review");q.add_argument("--output",type=Path,required=True)
a=p.parse_args()
if a.cmd=="target-preflight": v={"schema_version":"fixture","operation":"target_preflight","passed":True,"classification":"exact"}
elif a.cmd=="plan": v={"schema_version":"fixture","operation":"plan","repository":str(a.repository),"target_ref":a.target_ref,"expected_target_sha":subprocess.check_output(["git","-C",str(a.repository),"rev-parse",a.target_ref],text=True).strip(),"reviewed_tip":a.reviewed_tip,"task_worktree":str(a.task_worktree)}
elif a.cmd=="build":
 v=json.loads(a.plan.read_text());candidate=v["reviewed_tip"];candidate_path=Path(v["task_worktree"])
 ancestor=subprocess.run(["git","-C",v["repository"],"merge-base","--is-ancestor",v["expected_target_sha"],candidate]).returncode==0
 if not ancestor:
  candidate_path=a.candidate_path;subprocess.run(["git","-C",v["repository"],"worktree","add","--detach",str(candidate_path),v["expected_target_sha"]],check=True);subprocess.run(["git","-C",str(candidate_path),"merge","--no-ff","--no-edit",candidate],check=True);candidate=subprocess.check_output(["git","-C",str(candidate_path),"rev-parse","HEAD"],text=True).strip()
 v.update({"operation":"build","candidate_sha":candidate,"candidate_path":str(candidate_path),"candidate_bytes_changed_by_composition":candidate!=v["reviewed_tip"],"validation":[{"exit_code":0}],"eligible":False})
else:
 v=json.loads(a.candidate.read_text());v.update({"operation":"verify","eligible":True})
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(v));print(json.dumps(v))
''')
        self.write_executable(scripts / "integration_owner_preflight.py", '''#!/usr/bin/env python3
import argparse,json,os,shlex,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument("integrate",nargs="?");p.add_argument("--repository",required=True);p.add_argument("--candidate-receipt");p.add_argument("--resume-receipt");p.add_argument("--risk-tier");p.add_argument("--checked-out-target");p.add_argument("--validation-command");p.add_argument("--task-id");p.add_argument("--output",type=Path,required=True);p.add_argument("--require-actual-review",action="store_true");p.add_argument("--actual-review-command");p.add_argument("--actual-review-receipt")
a=p.parse_args();name,rest=a.repository.split("=",1);repo,target,expected,candidate=rest.split(",",3)
if not a.resume_receipt:
 r=subprocess.run(["git","-C",repo,"update-ref",target,candidate,expected],capture_output=True,text=True)
 if r.returncode: raise SystemExit(2)
 if os.environ.get("CANARY_MODE")=="partial":
  v={"schema_version":"juno_local_integration.v3","outcome":"partial_local_integration","passed":False,"error":"actual_target_review_command_failed","resume_stage":"actual_target_validation","updates":[{"status":"moved","after_sha":candidate}]};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(v));raise SystemExit(2)
actual="not_required_by_effective_tier"
if a.actual_review_command:
 tokens=shlex.split(a.actual_review_command)
 if len(tokens)<2 or tokens[0]!="yy" or tokens[1]!="pi": raise SystemExit("actual review was not canonical yy pi")
 child_env={k:v for k,v in os.environ.items() if k not in {"JUNO_TASK_ROOT","JUNO_CONTROLLER_BRANCH","JUNO_WORKSPACE_ROLE","JUNO_WORKSPACE_ENFORCEMENT","TASK_ROOT"}}
 r=subprocess.run(tokens,cwd=repo,env=child_env)
 if r.returncode: raise SystemExit(r.returncode)
 actual="performed"
v={"schema_version":"juno_local_integration.v3","outcome":"integrated","passed":True,"actual_semantic_review":actual,"actual_target":{"deterministic_actual_target_validation":"passed"}}
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(v));print(json.dumps({"outcome":"integrated","controller_sync":{"outcome":"synced_local","candidateSha":candidate}}))
''')
        fake_bin = root / "bin"; fake_bin.mkdir()
        review_log = root / "reviews.jsonl"
        self.write_executable(fake_bin / "yy", '''#!/usr/bin/env python3
import json,os,pathlib,re,subprocess,sys
prompt=sys.argv[-1]
if "Implement Kanban task" in prompt or "Repair the complete" in prompt:
 assert os.environ.get("JUNO_WORKSPACE_ROLE")=="task"
 p=pathlib.Path("product.txt");p.write_text(p.read_text()+("repaired\\n" if "Repair" in prompt else "implemented\\n"));subprocess.run(["git","add","product.txt"],check=True);subprocess.run(["git","commit","-m","repair" if "Repair" in prompt else "implement"],check=True)
 if os.environ.get("CANARY_MODE")=="descendant":
  repo=pathlib.Path(os.environ["CANARY_REPO"]);(repo/"target.txt").write_text("advanced\\n");subprocess.run(["git","-C",str(repo),"add","target.txt"],check=True);subprocess.run(["git","-C",str(repo),"commit","-m","advance target"],check=True)
 print("REVIEW_READY")
else:
 is_actual=os.environ.get("JUNO_WORKSPACE_ROLE") is None
 assert is_actual or os.environ.get("JUNO_WORKSPACE_ROLE")=="controller"
 log=pathlib.Path(os.environ["CANARY_REVIEW_LOG"]);count=len(log.read_text().splitlines()) if log.exists() else 0
 m={k:(re.search(k+r" ([0-9a-f]{40})",prompt).group(1) if re.search(k+r" ([0-9a-f]{40})",prompt) else None) for k in ("Base","Tip")};m["count"]=count;m["requirements_rendered"]="lifecycle reaches COMPLETE" in prompt;m["prior_finding_rendered"]="repair all findings" in prompt;m["canonical_resolved"]="{{" not in prompt
 with log.open("a") as f:f.write(json.dumps(m)+"\\n")
 mode=os.environ.get("CANARY_MODE","pass")
 if mode=="exhaust" or mode=="repair" and count==0: print("JUNO_REVIEW_FINDING: high; review flow; candidate; repair all findings")
 else: print("JUNO_REVIEW_VERDICT: PASS")
 print(f"session_id: session-canary-{count}")
''')
        checklist = root / "requirements.md"; checklist.write_text("- lifecycle reaches COMPLETE\n")
        task = root / f"task-{risk}"
        if mode == "waiver":
            self.write_executable(controller / ".juno_task/scripts/kanban.sh", f'''#!/usr/bin/env python3
import json,subprocess
candidate=subprocess.check_output(["git","-C",{str(task)!r},"rev-parse","HEAD"],text=True).strip()
print(json.dumps([{{"id":"CANARY_{risk.upper()}","status":"in_progress","commit_hash":candidate,"fields":{{"lifecycle_review":{{"status":"waived_by_owner","candidate_sha":candidate,"reason":"fixture owner decision"}}}}}}]))
''')
        manifest = {
            "schema_version": "juno_task_lifecycle.v1", "task_id": f"CANARY_{risk.upper()}",
            "controller_root": str(controller), "objective_risk": risk, "owner_risk_escalation": None,
            "repositories": [{"id":"root","path":str(repo),"target_ref":"refs/heads/main","approved_base_sha":base,
                              "task_worktree":str(task),"task_branch_ref":f"refs/heads/task/{risk}","expected_paths":["product.txt"]}],
            "artifact_root": str(root / f"artifacts-{risk}"), "cleanup_owner": "test",
            "requirements_checklist": str(checklist), "validation_commands": ["git diff --check"],
            "review": {"initial_pair_limit":1,"replacement_pair_limit":1},
            "controller_checkpoint_command": ["python3","-c","raise SystemExit(0)"],
            "timeouts": {"agent_seconds":30,"validation_seconds":30},
        }
        manifest_path=root/f"manifest-{risk}.json";manifest_path.write_text(json.dumps(manifest))
        env={**os.environ,"PATH":str(fake_bin)+os.pathsep+os.environ["PATH"],"CANARY_REVIEW_LOG":str(review_log),"CANARY_CONTROLLER":str(controller),"CANARY_REPO":str(repo),"CANARY_MODE":mode}
        result=subprocess.run([sys.executable,str(SCRIPT),"run","--manifest",str(manifest_path)],cwd=repo,text=True,capture_output=True,env=env)
        if mode == "partial":
            self.assertEqual(2,result.returncode,result.stderr+result.stdout)
            partial=json.loads((root/f"artifacts-{risk}/state.json").read_text())
            self.assertEqual("PARTIAL_INTEGRATION",partial["phase"]);self.assertEqual("partial_local_integration",partial["integration_status"])
            self.assertEqual("passed",partial["actual_target_verification"]);self.assertEqual("failed",partial["actual_target_review"])
            self.assertEqual(partial["candidate_sha"],self.git(repo,"rev-parse","refs/heads/main"))
            result=subprocess.run([sys.executable,str(SCRIPT),"resume","--state",str(root/f"artifacts-{risk}/state.json")],cwd=repo,text=True,capture_output=True,env=env)
        self.assertEqual(3 if mode=="exhaust" else 0,result.returncode,result.stderr+result.stdout)
        state=json.loads((root/f"artifacts-{risk}/state.json").read_text())
        reviews=[json.loads(line) for line in review_log.read_text().splitlines()]
        if mode == "exhaust":
            self.assertEqual("REVIEW_BUDGET_EXHAUSTED",state["phase"]);self.assertTrue(task.exists())
        else:
            self.assertEqual("COMPLETE",state["phase"]);self.assertEqual("complete",state["cleanup_status"])
            self.assertEqual(state["candidate_sha"],self.git(repo,"rev-parse","refs/heads/main"));self.assertFalse(task.exists())
        return state,reviews

    def test_medium_risk_one_command_canary_uses_one_review(self):
        state,reviews=self.run_canary("medium")
        self.assertEqual("passed",state["review_status"]);self.assertEqual(1,len(reviews))

    def test_high_risk_one_command_canary_uses_same_tip_sequential_pair_and_actual_review(self):
        state,reviews=self.run_canary("high")
        self.assertEqual(3,len(reviews))
        self.assertEqual(reviews[0]["Tip"],reviews[1]["Tip"])
        self.assertEqual("passed",state["actual_target_review"])

    def test_findings_wait_for_both_reviewers_then_use_one_consolidated_repair(self):
        state,reviews=self.run_canary("high", "repair")
        self.assertEqual(5,len(reviews))
        self.assertEqual(reviews[0]["Tip"],reviews[1]["Tip"])
        self.assertNotEqual(reviews[1]["Tip"],reviews[2]["Tip"])
        self.assertEqual(reviews[2]["Tip"],reviews[3]["Tip"])
        self.assertTrue(all(review["requirements_rendered"] for review in reviews))
        self.assertTrue(reviews[2]["prior_finding_rendered"]);self.assertTrue(reviews[3]["prior_finding_rendered"])
        self.assertEqual("passed",state["review_status"])

    def test_replacement_findings_stop_at_review_budget_without_integration(self):
        state,reviews=self.run_canary("high", "exhaust")
        self.assertEqual(4,len(reviews))
        self.assertEqual("budget_exhausted",state["review_status"])
        self.assertEqual("not_started",state["integration_status"])

    def test_post_cas_review_failure_persists_and_resumes_partial_integration(self):
        state,reviews=self.run_canary("high", "partial")
        self.assertEqual("COMPLETE",state["phase"])
        self.assertEqual("integrated",state["integration_status"])
        self.assertEqual(3,len(reviews))

    def test_owner_waiver_integrates_without_fictional_pre_cas_pass(self):
        state,reviews=self.run_canary("high", "waiver")
        self.assertEqual("waived_by_owner",state["review_status"])
        self.assertFalse(state["review_passed"])
        self.assertEqual("high",state["effective_risk"])
        self.assertEqual(1,len(reviews))  # delivery-sensitive actual-target review only

    def test_descendant_target_composition_cleans_both_worktrees_and_completes(self):
        state,reviews=self.run_canary("medium", "descendant")
        self.assertTrue(reviews[1]["requirements_rendered"])
        self.assertTrue(reviews[1]["canonical_resolved"])
        self.assertTrue(state["candidate_composed"])
        self.assertNotEqual(state["candidate_sha"], state["reviewed_task_tip_sha"])
        cleanup_root=Path(state["manifest"]["path"]).parent / "artifacts-medium" / "cleanup"
        candidate=json.loads((cleanup_root/"candidate.json").read_text())
        task=json.loads((cleanup_root/"receipt.json").read_text())
        self.assertEqual(state["candidate_sha"],candidate["expected_head"])
        self.assertEqual(state["reviewed_task_tip_sha"],task["expected_head"])


if __name__ == "__main__":
    unittest.main()
