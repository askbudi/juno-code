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

    def fake_worker_yy(self, directory: Path) -> Path:
        path=directory/"yy";path.write_text('''#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys,time
args=sys.argv[1:];mode=os.environ.get("WORKER_MODE","allowed");capture=pathlib.Path(os.environ["JUNO_SUBAGENT_CAPTURE_PATH"])
prompt_file=pathlib.Path(args[args.index("-f")+1]);prompt=prompt_file.read_text();authority_path=pathlib.Path(os.environ["JUNO_LIFECYCLE_AUTHORITY_MAP"]);authority=json.loads(authority_path.read_text())
repo=pathlib.Path(authority["repositories"][0]["root"]);base=authority["repositories"][0]["approved_base_sha"];allowed=repo/authority["repositories"][0]["paths"][0]
config=pathlib.Path(args[args.index("--config")+1]);controller=config.parents[1]
if mode in {"allowed","controller","prompt-tamper"}: allowed.write_text("worker change\\n");subprocess.run(["git","-C",str(repo),"add",str(allowed)]);subprocess.run(["git","-C",str(repo),"commit","-m","fake worker"])
elif mode=="unadmitted": (repo/"forbidden.txt").write_text("bad\\n");subprocess.run(["git","-C",str(repo),"add","forbidden.txt"]);subprocess.run(["git","-C",str(repo),"commit","-m","bad"])
elif mode=="dirty": allowed.write_text("dirty\\n")
elif mode=="wrong-branch": subprocess.run(["git","-C",str(repo),"checkout","-b","wrong"])
elif mode=="rewritten": subprocess.run(["git","-C",str(repo),"checkout","--detach",base]);allowed.write_text("rewrite\\n");subprocess.run(["git","-C",str(repo),"add",str(allowed)]);subprocess.run(["git","-C",str(repo),"commit","-m","rewrite"])
if mode=="controller": (controller/"controller-dirt.txt").write_text("bad")
if mode=="prompt-tamper": prompt_file.write_text(prompt+"tampered")
observed={"argv":args,"cwd":os.getcwd(),"stdin":sys.stdin.read(),"prompt":prompt,"keys":sorted(k for k in os.environ if k.startswith(("PI_","JUNO_")) or k=="TASK_ROOT"),"values":{k:os.environ.get(k) for k in ("TASK_ROOT","JUNO_TASK_ROOT","JUNO_CONTROLLER_BRANCH","JUNO_WORKSPACE_ROLE","JUNO_WORKSPACE_ENFORCEMENT","JUNO_LIFECYCLE_AUTHORITY_MAP")},"model":os.environ.get("PI_MODEL"),"provider":os.environ.get("PI_PROVIDER")}
payload={"result":"fake worker response","session_id":"worker-session","observed":observed}
if mode=="process-fail": raise SystemExit(7)
if mode=="missing": raise SystemExit(0)
if mode=="no-session": payload.pop("session_id")
capture.write_text(json.dumps(payload))
if mode=="stale": os.utime(capture,(1,1))
''');path.chmod(0o755);return path

    def worker_fixture(self, mode: str = "allowed", repair: bool = False):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=Path(temporary.name)
        controller,_=self.repo(root,"controller");(controller/".juno_task").mkdir();(controller/".juno_task/config.json").write_text("{}\n");self.git(controller,"add",".");self.git(controller,"commit","-m","controller config")
        repo,base=self.repo(root,"repo");plan=self.plan(root,[("root",repo,base)],"high");plan["controller_root"]=str(controller);plan["controller_branch"]="refs/heads/main";plan["expected_controller_head"]=self.git(controller,"rev-parse","HEAD")
        state=self.state(plan);ns=root/"ns";life.prepare_worktrees(plan,ns,state)
        task=Path(plan["repositories"][0]["task_worktree"]);self.git(task,"config","user.name","Worker");self.git(task,"config","user.email","worker@example.com")
        if repair: (ns/"repair-packet.json").write_text(json.dumps({"findings":["fix"]}))
        bin_dir=root/"bin";bin_dir.mkdir();self.fake_worker_yy(bin_dir)
        env={**os.environ,"PATH":str(bin_dir)+os.pathsep+os.environ["PATH"],"WORKER_MODE":mode}
        return root,plan,state,ns,env

    def dispatch_fake_worker(self, mode: str = "allowed", repair: bool = False, state_hook=None):
        root,plan,state,ns,env=self.worker_fixture(mode,repair)
        if state_hook: state_hook(state)
        poisoned={key:"outer-secret" for key in life.REVIEW_ENV_BLOCKED};poisoned.update({"PI_FUTURE_OVERRIDE":"outer","JUNO_FUTURE_STATE":"outer","TASK_ROOT":"outer"})
        with mock.patch.object(life,"product_dispatch_preflight",side_effect=lambda _root,_op,path:path.write_text('{"passed":true}\n')), \
             mock.patch.dict(os.environ,{**env,**poisoned},clear=True):
            life.dispatch_worker(plan,ns,state,repair)
        return root,plan,state,ns

    def test_worker_launch_provenance_sanitation_prompt_file_roots_capture_and_audit(self):
        root,plan,state,ns=self.dispatch_fake_worker()
        receipt=json.loads((ns/"worker-1/receipt.json").read_text());capture=json.loads(Path(receipt["capture"]["path"]).read_text());observed=capture["observed"]
        self.assertIsNone(observed["model"]);self.assertIsNone(observed["provider"]);self.assertEqual("",observed["stdin"])
        self.assertEqual(sorted(life.WORKER_ENV_SET),observed["keys"])
        self.assertNotIn("-p",observed["argv"]);self.assertIn("-f",observed["argv"]);self.assertEqual(str(Path(plan["repositories"][0]["task_worktree"]).resolve()),observed["values"]["TASK_ROOT"])
        self.assertEqual("task",observed["values"]["JUNO_WORKSPACE_ROLE"]);self.assertEqual(Path(receipt["launcher_cwd"]).resolve(),Path(observed["cwd"]).resolve());self.assertEqual(receipt["prompt"]["echo"],observed["prompt"])
        self.assertEqual(receipt["prompt"]["sha256"],life.file_digest(Path(receipt["prompt"]["path"])));self.assertEqual("worker-session",receipt["session_id"])
        self.assertTrue(receipt["capture"]["created_after_dispatch"]);self.assertTrue(receipt["changed_path_audit"]["root"]["passed"]);self.assertFalse(receipt["changed_path_audit"]["root"]["unexpected_paths"])
        self.assertEqual(set(life.WORKER_ENV_SET)|{"PYTHONUNBUFFERED"},set(receipt["environment_contract"]["explicitly_set_key_names"]));self.assertIn("PI_FUTURE_OVERRIDE",receipt["environment_contract"]["removed_key_names"])
        authority=json.loads(Path(receipt["authority_map"]["path"]).read_text());self.assertTrue(authority["repositories"][0]["create_receipt"]["sha256"])
        self.assertEqual("implementation",receipt["kind"]);self.assertEqual(1,state["worker_count"]);self.assertEqual("worker-session",state["worker_launches"][0]["session_id"])

    def test_worker_allowed_commit_and_repair_share_canonical_launcher_and_evidence(self):
        _,_,_,ns1=self.dispatch_fake_worker();_,_,_,ns2=self.dispatch_fake_worker(repair=True)
        a=json.loads((ns1/"worker-1/receipt.json").read_text());b=json.loads((ns2/"worker-1/receipt.json").read_text())
        self.assertEqual("implementation",a["kind"]);self.assertEqual("repair",b["kind"]);self.assertIsNone(a["repair_packet"]);self.assertIsNotNone(b["repair_packet"])
        self.assertEqual(["yy","pi","--config"],a["command"][:3]);self.assertEqual(a["command"][:3],b["command"][:3]);self.assertEqual(set(a),set(b))

    def test_worker_unadmitted_controller_branch_rewrite_dirty_no_commit_prompt_and_capture_refuse(self):
        cases=(("unadmitted","authority"),("controller","controller"),("wrong-branch","authority"),("rewritten","authority"),
               ("dirty","authority"),("no-commit","no descendant commit"),("prompt-tamper","prompt"),("process-fail","exited 7"),
               ("missing","capture"),("no-session","session"),("stale","stale"))
        for mode,pattern in cases:
            root,plan,state,ns,env=self.worker_fixture(mode)
            with self.subTest(mode=mode), mock.patch.object(life,"product_dispatch_preflight",side_effect=lambda _root,_op,path:path.write_text('{"passed":true}\n')), \
                 mock.patch.dict(os.environ,env,clear=True), self.assertRaisesRegex(life.LifecycleError,pattern):
                life.dispatch_worker(plan,ns,state)

    def test_worker_duplicate_session_forbidden_argv_and_wrong_common_refuse(self):
        root,plan,state,ns,env=self.worker_fixture("allowed");state["worker_sessions"]=["worker-session"]
        with mock.patch.object(life,"product_dispatch_preflight",side_effect=lambda _root,_op,path:path.write_text('{"passed":true}\n')),mock.patch.dict(os.environ,env,clear=True),self.assertRaisesRegex(life.LifecycleError,"duplicate"):
            life.dispatch_worker(plan,ns,state)
        root,plan,state,ns,env=self.worker_fixture("allowed");plan["worker_command"]=["yy","pi","--model","bad"]
        with mock.patch.object(life,"product_dispatch_preflight",side_effect=lambda _root,_op,path:path.write_text('{"passed":true}\n')),mock.patch.dict(os.environ,env,clear=True),self.assertRaisesRegex(life.LifecycleError,"noncanonical|forbidden"):
            life.dispatch_worker(plan,ns,state)
        root,plan,state,ns,env=self.worker_fixture("allowed");original=life.worktree_identity
        def wrong_common(path):
            value=original(path)
            if Path(path).resolve()==Path(plan["repositories"][0]["task_worktree"]).resolve(): value["git_common_dir"]="/wrong/common"
            return value
        with mock.patch.object(life,"product_dispatch_preflight",side_effect=lambda _root,_op,path:path.write_text('{"passed":true}\n')),mock.patch.object(life,"worktree_identity",side_effect=wrong_common),mock.patch.dict(os.environ,env,clear=True),self.assertRaisesRegex(life.LifecycleError,"identity|common"):
            life.dispatch_worker(plan,ns,state)

    def fake_yy(self, directory: Path) -> Path:
        path=directory/"yy";path.write_text('''#!/usr/bin/env python3
import json,os,pathlib,re,subprocess,sys
args=sys.argv[1:];capture=pathlib.Path(os.environ["JUNO_SUBAGENT_CAPTURE_PATH"]);mode=os.environ.get("REVIEW_MODE","pass");reviewer=os.environ["JUNO_TOOL_ID"].rsplit("_",1)[-1]
prompt_file=pathlib.Path(args[args.index("-f")+1]);prompt=prompt_file.read_text();match=re.search(r"Frozen exact-tip checkouts: (.+)",prompt);checkouts=json.loads(match.group(1));product=pathlib.Path(checkouts[sorted(checkouts)[0]])
config=pathlib.Path(args[args.index("--config")+1]);controller=config.parents[1]
if mode=="tracked": (product/"product.txt").write_text("mutated\\n")
elif mode=="staged": (product/"product.txt").write_text("mutated\\n");subprocess.run(["git","-C",str(product),"add","product.txt"])
elif mode=="untracked": (product/"untracked.txt").write_text("x")
elif mode=="head":
 subprocess.run(["git","-C",str(product),"config","user.name","Review"]);subprocess.run(["git","-C",str(product),"config","user.email","review@example.com"]);(product/"product.txt").write_text("head\\n");subprocess.run(["git","-C",str(product),"add","."]);subprocess.run(["git","-C",str(product),"commit","-m","bad"])
elif mode=="controller": (controller/"controller-dirt.txt").write_text("bad")
elif mode=="prompt-tamper": prompt_file.write_text(prompt+"tampered")
response="JUNO_REVIEW_VERDICT: PASS"
if mode=="echo": response="prompt JUNO_REVIEW_VERDICT: PASS\\nJUNO_REVIEW_FINDING: high; trust; echo; reject"
if mode=="contradict": response="JUNO_REVIEW_VERDICT: PASS\\nJUNO_REVIEW_FINDING: high; trust; x; y"
session="same" if mode=="duplicate" else f"session-{reviewer}"
observed={"argv":args,"cwd":os.getcwd(),"stdin":sys.stdin.read(),"prompt":prompt,"pi_juno_keys":sorted(k for k in os.environ if k.startswith(("PI_","JUNO_"))),"model":os.environ.get("PI_MODEL"),"provider":os.environ.get("PI_PROVIDER")}
payload={"result":response,"observed":observed}
if mode!="missing": payload["session_id"]=session
capture.write_text(json.dumps(payload))
''');path.chmod(0o755);return path

    def review_fixture(self, mode: str, wrong_head: bool = False):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=Path(temporary.name)
        controller,_=self.repo(root,"controller");(controller/".juno_task").mkdir();(controller/".juno_task/config.json").write_text("{}\\n");self.git(controller,"add",".");self.git(controller,"commit","-m","controller config")
        repo,base=self.repo(root,"repo");tip=self.commit(repo,"candidate\n");plan=self.plan(root,[("root",repo,base)],"high")
        plan["controller_root"]=str(controller);plan["controller_branch"]="refs/heads/main";plan["expected_controller_head"]=self.git(controller,"rev-parse","HEAD")
        state=self.state(plan);state["candidate_shas"]={"root":tip};state["receipts"]["candidate_gate"]={"path":str(root/"gate.json"),"sha256":"x"};(root/"candidate.json").write_text("{}")
        candidate={"candidate_digest":"digest","candidate_shas":{"root":base if wrong_head else tip},"changed_paths":{"root":["product.txt"]}}
        bin_dir=root/"bin";bin_dir.mkdir();self.fake_yy(bin_dir)
        env={**os.environ,"PATH":str(bin_dir)+os.pathsep+os.environ["PATH"],"REVIEW_MODE":mode}
        return root,plan,state,candidate,env

    def test_review_response_only_sessions_and_same_frozen_checkout(self):
        root,plan,state,candidate,env=self.review_fixture("pass")
        with mock.patch.dict(os.environ,env,clear=True): outcomes=life.review_pipeline(plan,candidate,root/"ns",state)
        self.assertEqual(["session-A","session-B"],[x["session_id"] for x in outcomes]);self.assertEqual(outcomes[0]["frozen_checkout_identity"],outcomes[1]["frozen_checkout_identity"])
        self.assertFalse((root/"ns/review-pre_cas-1/frozen-checkout").exists())

    def test_review_launch_sanitizes_env_uses_prompt_file_devnull_and_neutral_roots(self):
        root,plan,state,candidate,env=self.review_fixture("pass")
        poisoned={key:"outer-secret" for key in life.REVIEW_ENV_BLOCKED};poisoned.update({"PI_FUTURE_OVERRIDE":"outer","JUNO_FUTURE_STATE":"outer"})
        with mock.patch.dict(os.environ,{**env,**poisoned},clear=True): outcomes=life.review_pipeline(plan,candidate,root/"ns",state)
        first=outcomes[0];capture=json.loads(Path(first["capture"]["path"]).read_text());observed=capture["observed"]
        self.assertIsNone(observed["model"]);self.assertIsNone(observed["provider"]);self.assertEqual("",observed["stdin"])
        self.assertNotIn("-p",observed["argv"]);self.assertIn("-f",observed["argv"]);self.assertNotIn("--model",observed["argv"]);self.assertNotIn("--provider",observed["argv"])
        self.assertEqual(Path(first["launcher_cwd"]).resolve(),Path(observed["cwd"]).resolve());self.assertFalse((Path(first["launcher_cwd"])/".git").exists());self.assertFalse((Path(first["agent_cwd"])/".juno_task").exists())
        self.assertEqual(first["prompt"]["echo"],observed["prompt"]);self.assertEqual(first["prompt"]["sha256"],life.file_digest(Path(first["prompt"]["path"])))
        self.assertIn(str(root/"ns/review-pre_cas-1/frozen-checkout/root"),first["prompt"]["echo"])
        self.assertEqual(set(life.REVIEW_ENV_SET)|{"PYTHONUNBUFFERED"},set(first["environment_contract"]["explicitly_set_key_names"]));self.assertIn("PI_FUTURE_OVERRIDE",first["environment_contract"]["removed_key_names"])
        self.assertEqual(set(life.REVIEW_ENV_SET),set(observed["pi_juno_keys"]));self.assertNotIn("-p",first["command"])
        self.assertEqual(first["command_sha256"],life.hashlib.sha256(life.shlex.join(first["command"]).encode()).hexdigest())
        process=json.loads(Path(first["process_receipt"]["path"]).read_text());self.assertEqual(first["command_sha256"],process["command_sha256"]);self.assertEqual(Path(first["launcher_cwd"]).resolve(),Path(process["cwd"]).resolve())

    def test_review_prompt_controller_mutation_and_noncanonical_command_refuse(self):
        for mode,pattern in (("prompt-tamper","prompt"),("controller","controller")):
            root,plan,state,candidate,env=self.review_fixture(mode)
            with mock.patch.dict(os.environ,env,clear=True),self.assertRaisesRegex(life.LifecycleError,pattern):life.review_pipeline(plan,candidate,root/"ns",state)
        root,plan,state,candidate,env=self.review_fixture("pass");plan["review_command"]=["yy","pi","--model","bad"]
        with mock.patch.dict(os.environ,env,clear=True),self.assertRaisesRegex(life.LifecycleError,"noncanonical|forbidden"):life.review_pipeline(plan,candidate,root/"ns",state)

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
