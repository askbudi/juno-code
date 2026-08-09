#!/usr/bin/env python3
"""Contract and real-Git tests for the Glow lifecycle.

The tests deliberately exercise the backing Git/review operations rather than
only schema projections: safety claims are useful only when exact refs,
worktrees, captures, and dirty-state readback enforce them in a real repository.
"""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "task_lifecycle.py"
spec = importlib.util.spec_from_file_location("glow_lifecycle", SCRIPT)
assert spec and spec.loader
life = importlib.util.module_from_spec(spec); spec.loader.exec_module(life)


class Fixture(unittest.TestCase):
    def git(self, repo: Path, *args: str) -> str:
        result = subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True)
        self.assertEqual(0, result.returncode, result.stderr)
        return result.stdout.strip()

    def repo(self, root: Path, name: str) -> tuple[Path, str]:
        repo = root / name; repo.mkdir(parents=True)
        self.git(repo, "init", "-b", "main"); self.git(repo, "config", "user.name", "Test"); self.git(repo, "config", "user.email", "test@example.com")
        (repo / "product.txt").write_text("base\n"); self.git(repo, "add", "."); self.git(repo, "commit", "-m", "base")
        return repo, self.git(repo, "rev-parse", "HEAD")

    def commit(self, repo: Path, text: str) -> str:
        (repo / "product.txt").write_text(text); self.git(repo, "add", "product.txt"); self.git(repo, "commit", "-m", text.strip())
        return self.git(repo, "rev-parse", "HEAD")

    def plan(self, root: Path, repos: list[tuple[str, Path, str]], risk: str = "high") -> dict:
        values = []
        for index, (repo_id, repo, base) in enumerate(repos):
            values.append({"id": repo_id, "role": "root" if index == 0 else "child", "parent": None if index == 0 else repos[0][0],
                "mount_path": None, "path": str(repo), "git_common_dir": life.git_common(repo), "target_ref": "refs/heads/main",
                "approved_base_sha": base, "task_worktree": str(root / f"task-{repo_id}"), "task_branch_ref": f"refs/heads/task/{repo_id}",
                "expected_paths": ["product.txt"], "path_dispositions": {"product.txt": "existing"}})
        value = {"schema_version": life.PLAN_SCHEMA, "task_id": "T1", "controller_root": str(root), "controller_branch": "refs/heads/main",
                 "expected_controller_head": "a" * 40, "topology": "test", "root_repository": repos[0][0], "repositories": values,
                 "objective_risk": risk, "deterministic_risk": risk, "effective_risk": risk, "candidate_gate": [{"id":"one","command":"true"}],
                 "review_policy": {"round_limit":2,"reviewers":["A","B"] if risk == "high" else ["A"]}, "authorization_exclusions": [], "created_at": life.utc_now()}
        value["plan_sha256"] = life.digest(value); return value

    def state(self, plan: dict) -> dict:
        return {"schema_version": life.STATE_SCHEMA, "task_id":"T1", "phase":"PLANNED", "topology":"test", "effective_risk":plan["effective_risk"],
                "plan_sha256":plan["plan_sha256"], "expected_controller_head":plan["expected_controller_head"], "candidate_generation":0,
                "candidate_shas":{}, "receipts":{}, "attempt_count":0, "last_attempt_sha256":None, "worker_count":0, "review_round":0,
                "review_status":"not_started", "review_passed":False, "validation_status":"not_started", "integration_status":"not_started",
                "ref_movements":{}, "actual_target_verification":"not_started", "actual_target_review":"not_started", "controller_sync":"not_started",
                "controller_checkpoint":"not_started", "cleanup_status":"not_started", "release_status":"not_requested", "next_permitted_action":"prepare", "last_error":None}


class SchemaAndPublicTests(Fixture):
    def config(self, root: Path, child: bool = False) -> dict:
        repos = {"root":{"path":".","target_ref":"refs/heads/main","parent":None,"expected_paths":["product.txt"]}}
        children = []
        if child:
            repos["child"]={"path":"child","target_ref":"refs/heads/main","parent":"root","mount_path":"child","expected_paths":["product.txt"]}; children=["child"]
        return {"schema_version":life.CONFIG_SCHEMA,"default_topology":"default","repositories":repos,"topologies":{"default":{"root":"root","children":children}},
                "candidate_gate":{"rows":[{"id":"contract","command":"true"}]}}

    def test_public_parser_is_task_only_and_old_execution_is_rejected(self):
        for operation in ("run", "resume", "status"):
            args = life.parser().parse_args([operation, "--task", "T1"]); self.assertEqual("T1", args.task)
        with self.assertRaises(SystemExit): life.parser().parse_args(["run", "--manifest", "old.json"])
        result = subprocess.run([sys.executable, str(SCRIPT), "resume", "--state", "old.json"], text=True, capture_output=True)
        self.assertNotEqual(0, result.returncode)

    def test_status_is_read_only_and_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.repo(Path(directory), "project"); (root / ".juno_task").mkdir()
            before = set(root.rglob("*"))
            with mock.patch.object(life, "project_root", return_value=root):
                output = []
                with mock.patch("builtins.print", side_effect=lambda value, **_: output.append(value)):
                    self.assertEqual(0, life.public("T1", "status"))
            self.assertEqual("NOT_STARTED", json.loads(output[-1])["phase"]); self.assertEqual(before, set(root.rglob("*")))

    def test_root_plus_n_and_deeper_nesting_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.repo(Path(directory), "project"); child, _ = self.repo(root, "child")
            value = life.validate_config(self.config(root, True), root); self.assertEqual(["child"], value["topologies"]["default"]["children"])
            value["repositories"]["grand"]={"path":str(child),"target_ref":"refs/heads/main","parent":"child","expected_paths":["product.txt"]}
            value["topologies"]["default"]["children"].append("grand")
            with self.assertRaisesRegex(life.LifecycleError, "deeper|ambiguous"): life.validate_config(value, root)

    def test_malformed_ambiguous_topology_and_risk_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.repo(Path(directory), "project")
            value=self.config(root);value["topologies"]["default"]["children"]=["missing"]
            with self.assertRaises(life.LifecycleError): life.validate_config(value, root)
            self.assertEqual(("high","high"), life.objective_risk([], "medium", None))
            with self.assertRaisesRegex(life.LifecycleError, "cannot downgrade"): life.objective_risk(["lifecycle.py"], "high", "medium")

    def test_task_derived_plan_freezes_refs_paths_and_future_dispositions(self):
        with tempfile.TemporaryDirectory() as directory:
            root, base = self.repo(Path(directory), "project")
            config=life.validate_config(self.config(root), root)
            task={"id":"T1","last_modified":"now","fields":{"lifecycle":{"repositories":{"root":{"expected_paths":["product.txt"],"future_paths":["new/exact.txt"]}},"objective_risk":"medium"}}}
            plan=life.derive_plan(root,task,config);repo=plan["repositories"][0]
            self.assertEqual(base,repo["approved_base_sha"]);self.assertEqual("future",repo["path_dispositions"]["new/exact.txt"])
            self.assertNotIn(str(root / "new"), repo["expected_paths"]);self.assertEqual(life.digest({k:v for k,v in plan.items() if k!="plan_sha256"}),plan["plan_sha256"])

    def test_attempts_are_hash_chained_and_namespace_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);ns=root/"T1";state={"task_id":"T1","phase":"PLANNED","attempt_count":0,"last_attempt_sha256":None,"candidate_generation":0,"candidate_shas":{},"expected_controller_head":"a"*40,"next_permitted_action":"prepare"}
            life.save_state(ns,state,"PLANNED");life.save_state(ns,state,"PREPARED");life.verify_attempt_chain(ns,state)
            other=root/"T2";self.assertFalse(other.exists())
            first=ns/"attempts/000001.json";value=json.loads(first.read_text());value["summary"]={"tampered":True};first.write_text(json.dumps(value))
            with self.assertRaisesRegex(life.LifecycleError,"chain"):life.verify_attempt_chain(ns,state)

    def test_empty_and_all_not_applicable_gate_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);repo,base=self.repo(root,"repo");tip=self.commit(repo,"tip\n");plan=self.plan(root,[("root",repo,base)],"medium");state=self.state(plan);state["candidate_shas"]={"root":tip}
            candidate={"generation":1,"candidate_digest":"d","candidate_shas":{"root":tip},"changed_paths":{"root":["product.txt"]}}
            plan["candidate_gate"]=[]
            with self.assertRaisesRegex(life.LifecycleError,"empty"):life.candidate_gate(plan,candidate,root/"ns",state)
            plan["candidate_gate"]=[{"id":"high-only","command":"true","applies":"high"}]
            with self.assertRaisesRegex(life.LifecycleError,"no applicable"):life.candidate_gate(plan,candidate,root/"ns2",state)


class RealGitLifecycleTests(Fixture):
    def test_composite_prepare_preflights_all_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);a,abase=self.repo(root,"a");b,bbase=self.repo(root,"b");plan=self.plan(root,[("root",a,abase),("child",b,bbase)]);state=self.state(plan);ns=root/"ns"
            self.commit(b,"target moved\n")
            with self.assertRaisesRegex(life.LifecycleError,"moved"):life.prepare_worktrees(plan,ns,state)
            self.assertFalse(Path(plan["repositories"][0]["task_worktree"]).exists())

    def test_future_path_creation_needs_no_worktree_recreation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);repo,base=self.repo(root,"repo");plan=self.plan(root,[("root",repo,base)]);item=plan["repositories"][0]
            item["expected_paths"].append("future/exact.txt");item["path_dispositions"]["future/exact.txt"]="future";state=self.state(plan);ns=root/"ns"
            life.prepare_worktrees(plan,ns,state);task=Path(item["task_worktree"]);(task/"future").mkdir();(task/"future/exact.txt").write_text("new\n");self.git(task,"add",".");self.git(task,"commit","-m","candidate")
            candidate=life.compose_candidate(plan,ns,state);self.assertIn("future/exact.txt",candidate["changed_paths"]["root"])
            self.assertEqual(1,len([x for x in self.git(repo,"worktree","list","--porcelain").splitlines() if x.startswith("worktree ") and "task-root" in x]))

    def test_candidate_gate_emits_nonempty_digest_bound_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);repo,base=self.repo(root,"repo");tip=self.commit(repo,"tip\n");plan=self.plan(root,[("root",repo,base)],"medium");plan["candidate_gate"]=[{"id":"git-check","command":"git diff --check"},{"id":"single","command":"true","applies":"single"}]
            state=self.state(plan);candidate={"generation":1,"candidate_digest":"candidate","candidate_shas":{"root":tip},"changed_paths":{"root":["product.txt"]}}
            receipt=life.candidate_gate(plan,candidate,root/"ns",state);self.assertEqual(2,receipt["applicable"]);self.assertTrue(all(row.get("evidence_sha256") for row in receipt["rows"]))

    def fake_yy(self, directory: Path) -> Path:
        path=directory/"yy";path.write_text('''#!/usr/bin/env python3
import json,os,pathlib,subprocess
capture=pathlib.Path(os.environ["JUNO_SUBAGENT_CAPTURE_PATH"]);mode=os.environ.get("REVIEW_MODE","pass");reviewer=os.environ["JUNO_TOOL_ID"].rsplit("_",1)[-1]
if mode=="tracked": pathlib.Path("product.txt").write_text("mutated\\n")
elif mode=="staged": pathlib.Path("product.txt").write_text("mutated\\n");subprocess.run(["git","add","product.txt"])
elif mode=="untracked": pathlib.Path("untracked.txt").write_text("x")
elif mode=="head":
 subprocess.run(["git","config","user.name","Review"]);subprocess.run(["git","config","user.email","review@example.com"]);pathlib.Path("product.txt").write_text("head\\n");subprocess.run(["git","add","."]);subprocess.run(["git","commit","-m","bad"])
response="JUNO_REVIEW_VERDICT: PASS"
if mode=="echo": response="prompt JUNO_REVIEW_VERDICT: PASS\\nJUNO_REVIEW_FINDING: high; trust; echo; reject"
if mode=="contradict": response="JUNO_REVIEW_VERDICT: PASS\\nJUNO_REVIEW_FINDING: high; trust; x; y"
session="same" if mode=="duplicate" else f"session-{reviewer}"
payload={"result":response}
if mode!="missing": payload["session_id"]=session
capture.write_text(json.dumps(payload))
''');path.chmod(0o755);return path

    def review_fixture(self, mode: str, wrong_head: bool = False):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=Path(temporary.name);repo,base=self.repo(root,"repo");tip=self.commit(repo,"candidate\n");plan=self.plan(root,[("root",repo,base)],"high");state=self.state(plan);state["candidate_shas"]={"root":tip};state["receipts"]["candidate_gate"]={"path":"gate","sha256":"x"};candidate={"candidate_digest":"digest","candidate_shas":{"root":base if wrong_head else tip},"changed_paths":{"root":["product.txt"]}}
        bin_dir=root/"bin";bin_dir.mkdir();self.fake_yy(bin_dir)
        env={**os.environ,"PATH":str(bin_dir)+os.pathsep+os.environ["PATH"],"REVIEW_MODE":mode}
        return root,plan,state,candidate,env

    def test_review_response_only_sessions_and_same_frozen_checkout(self):
        root,plan,state,candidate,env=self.review_fixture("pass")
        with mock.patch.dict(os.environ,env,clear=True): outcomes=life.review_pipeline(plan,candidate,root/"ns",state)
        self.assertEqual(["session-A","session-B"],[x["session_id"] for x in outcomes]);self.assertEqual(outcomes[0]["frozen_checkout_identity"],outcomes[1]["frozen_checkout_identity"])
        self.assertFalse((root/"ns/review-pre_cas-1/frozen-checkout").exists())

    def test_review_missing_duplicate_echo_contradiction_and_wrong_head_refuse(self):
        for mode,pattern in (("missing","session"),("duplicate","duplicate"),("echo","contradictory"),("contradict","contradictory")):
            root,plan,state,candidate,env=self.review_fixture(mode)
            with mock.patch.dict(os.environ,env,clear=True),self.assertRaisesRegex(life.LifecycleError,pattern):life.review_pipeline(plan,candidate,root/"ns",state)
        root,plan,state,candidate,env=self.review_fixture("pass",True)
        candidate["candidate_shas"]["root"]="f"*40
        with mock.patch.dict(os.environ,env,clear=True),self.assertRaisesRegex(life.LifecycleError,"wrong HEAD|checkout"):life.review_pipeline(plan,candidate,root/"ns",state)

    def test_review_tracked_staged_untracked_and_head_mutations_refuse(self):
        for mode in ("tracked","staged","untracked","head"):
            root,plan,state,candidate,env=self.review_fixture(mode)
            with mock.patch.dict(os.environ,env,clear=True),self.assertRaisesRegex(life.LifecycleError,"dirty|mutated|wrong HEAD"):life.review_pipeline(plan,candidate,root/"ns",state)

    def test_child_first_root_last_cas_partial_resume_and_no_repeat(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);r,rbase=self.repo(root,"root");a,abase=self.repo(root,"a");b,bbase=self.repo(root,"b");rtip=self.commit(r,"root tip\n");atip=self.commit(a,"a tip\n");btip=self.commit(b,"b tip\n")
            for repo,base in ((r,rbase),(a,abase),(b,bbase)):self.git(repo,"update-ref","refs/heads/main",base)
            plan=self.plan(root,[("root",r,rbase),("a",a,abase),("b",b,bbase)]);state=self.state(plan);candidate={"candidate_shas":{"root":rtip,"a":atip,"b":btip}}
            moved=[]
            def inject(repo):
                moved.append(repo["id"])
                if len(moved)==2:raise RuntimeError("injected root-after-child failure")
            with self.assertRaises(RuntimeError):life.integrate_refs(plan,candidate,root/"ns",state,inject)
            self.assertEqual(["a","b"],moved);self.assertEqual(atip,self.git(a,"rev-parse","refs/heads/main"));self.assertEqual(btip,self.git(b,"rev-parse","refs/heads/main"));self.assertEqual(rbase,self.git(r,"rev-parse","refs/heads/main"))
            resumed=[];life.integrate_refs(plan,candidate,root/"ns",state,lambda repo:resumed.append(repo["id"]))
            self.assertEqual(["root"],resumed);self.assertEqual(rtip,self.git(r,"rev-parse","refs/heads/main"))

    def test_root_target_mismatch_is_found_before_any_child_cas(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);r,rbase=self.repo(root,"root");child,cbase=self.repo(root,"child");rtip=self.commit(r,"root tip\n");ctip=self.commit(child,"child tip\n");stale=self.commit(r,"stale root\n")
            self.git(child,"update-ref","refs/heads/main",cbase);plan=self.plan(root,[("root",r,rbase),("child",child,cbase)]);state=self.state(plan)
            with self.assertRaisesRegex(life.LifecycleError,"CAS mismatch"):life.integrate_refs(plan,{"candidate_shas":{"root":rtip,"child":ctip}},root/"ns",state)
            self.assertEqual(cbase,self.git(child,"rev-parse","refs/heads/main"));self.assertEqual(stale,self.git(r,"rev-parse","refs/heads/main"))

    def test_candidate_bound_waiver_preserves_risk_and_requires_explicit_authorities(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);repo,base=self.repo(root,"repo");plan=self.plan(root,[("root",repo,base)]);candidate={"candidate_digest":"digest"}
            targets={"root":{"ref":"refs/heads/main","sha":base}}
            task={"fields":{"lifecycle_waiver":{"status":"waived_by_owner","candidate_digest":"digest","effective_risk":"high","targets":targets,
                "review_passed":False,"authorize_integration":True,"authorize_local_release":True,"packages":["juno-code"]}}}
            value=life.waiver(plan,candidate,task);self.assertIsNotNone(value);self.assertFalse(value["review_passed"]);self.assertEqual("high",value["effective_risk"])
            task["fields"]["lifecycle_waiver"]["candidate_digest"]="wrong";self.assertIsNone(life.waiver(plan,candidate,task))

    def test_target_mismatch_and_unreceipted_candidate_target_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);repo,base=self.repo(root,"repo");tip=self.commit(repo,"tip\n");other=self.commit(repo,"other\n");plan=self.plan(root,[("root",repo,base)]);state=self.state(plan);candidate={"candidate_shas":{"root":tip}}
            with self.assertRaisesRegex(life.LifecycleError,"CAS mismatch"):life.integrate_refs(plan,candidate,root/"ns",state)
            self.git(repo,"update-ref","refs/heads/main",tip,other);state=self.state(plan)
            with self.assertRaisesRegex(life.LifecycleError,"without a durable"):life.integrate_refs(plan,candidate,root/"ns2",state)

    def test_actual_target_verification_and_cleanup_expected_head_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);repo,base=self.repo(root,"repo");plan=self.plan(root,[("root",repo,base)]);state=self.state(plan);ns=root/"ns";life.prepare_worktrees(plan,ns,state);task=Path(plan["repositories"][0]["task_worktree"]);tip=self.commit(task,"tip\n");candidate={"candidate_shas":{"root":tip},"changed_paths":{"root":["product.txt"]}}
            self.git(repo,"update-ref","refs/heads/main",tip,base);self.assertFalse(life.verify_actual_targets(plan,candidate,ns,state))
            (task/"dirty.txt").write_text("dirty")
            with self.assertRaisesRegex(life.LifecycleError,"expected-head/clean"):life.cleanup_worktrees(plan,candidate,ns,state)

    def test_controller_expected_head_race_refuses_before_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root,base=self.repo(Path(directory),"controller");(root/".juno_task/scripts").mkdir(parents=True);script=root/".juno_task/scripts/controller_checkpoint.py";script.write_text("raise SystemExit(0)\n")
            plan=self.plan(root,[("root",root,base)]);state=self.state(plan);state["expected_controller_head"]="f"*40
            with self.assertRaisesRegex(life.LifecycleError,"expected controller HEAD"):life.controller_checkpoint(plan,root/"ns",state,"review-ready")


if __name__ == "__main__": unittest.main()
