#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, subprocess, sys, tempfile, unittest
os.environ.pop("JUNO_WORKFLOW_CHILD_EVIDENCE_DIR",None)
from unittest import mock
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
LIFE=ROOT/".juno_task/scripts/worktree_lifecycle.py"
CAND=ROOT/".juno_task/scripts/integration_candidate.py"
INTEGRATE=ROOT/".juno_task/scripts/integration_owner_preflight.py"

def run(*argv:str,cwd:Path|None=None,ok=True):
 r=subprocess.run(argv,cwd=cwd,text=True,capture_output=True)
 if ok and r.returncode: raise AssertionError(f"{argv}\n{r.stdout}\n{r.stderr}")
 return r

def git(repo:Path,*args:str)->str:return run("git","-C",str(repo),*args).stdout.strip()
class IntegrationConcurrencyTest(unittest.TestCase):
 def setUp(self):
  self.tmp=Path(tempfile.mkdtemp());self.repo=self.tmp/"controller";run("git","init",str(self.repo));git(self.repo,"config","user.email","test@example.com");git(self.repo,"config","user.name","Test")
  (self.repo/".juno_task").mkdir();(self.repo/".juno_task/config.json").write_text("{}\n");(self.repo/"base").write_text("base\n");git(self.repo,"add","base",".juno_task");git(self.repo,"commit","-m","base");git(self.repo,"branch","-M","main");self.base=git(self.repo,"rev-parse","HEAD")
 def actual_review_command(self,receipt:Path,reviewed_tip:str,delay:float=0)->str:
  executable=receipt.with_suffix("")/"yy";executable.parent.mkdir(parents=True,exist_ok=True)
  payload=json.dumps({"schema_version":"juno_review.v1","review_kind":"actual_target","passed":True,"reviewed_tip":reviewed_tip,"open_bugs":[]})+"\n"
  executable.write_text(f"#!/usr/bin/env python3\nimport pathlib,time\ntime.sleep({delay!r})\npathlib.Path({str(receipt)!r}).write_text({payload!r})\nprint('session_id=test-actual-review\\naccepted')\n");executable.chmod(0o755)
  return f"'{executable}' pi review"
 def test_actual_review_child_evidence_records_success_and_failure(self):
  import importlib.util,os
  spec=importlib.util.spec_from_file_location("integration_child_evidence",INTEGRATE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  fake_yy=self.tmp/"yy";fake_yy.write_text("#!/usr/bin/env python3\nimport json,os,pathlib,sys,time\nmode=sys.argv[2]\nif os.environ.get('JUNO_WORKFLOW_CHILD_EVIDENCE_DIR'):\n raise SystemExit('final child evidence capability leaked to reviewer')\nif mode=='success':\n final=pathlib.Path(sys.argv[5])\n if final.exists(): raise SystemExit('final child evidence published before validation')\n pathlib.Path(sys.argv[3]).write_text(sys.argv[4])\n print('accepted')\n print('\\n🔑 Session ID(s):\\n   019fb5e9-6bcb-7422-a4f3-44882da8b179    cost: $0.903701',file=sys.stderr)\nelif mode=='missing-session':\n pathlib.Path(sys.argv[3]).write_text(sys.argv[4])\n print('accepted without identity')\nelif mode=='fail':\n print('provider failed',file=sys.stderr);raise SystemExit(7)\nelse: time.sleep(1)\n");fake_yy.chmod(0o755)
  common_env={"JUNO_WORKFLOW_ID":"wf","JUNO_WORKFLOW_RUN_ID":"run","JUNO_WORKFLOW_STEP_ID":"integrate","JUNO_WORKFLOW_STEP_DIGEST":"d"*64}
  success_dir=self.tmp/"child-success";success_receipt=self.tmp/"actual-success.json"
  payload=json.dumps({"schema_version":"juno_review.v1","review_kind":"actual_target","passed":True,"reviewed_tip":self.base,"open_bugs":[]})
  command=f"'{fake_yy}' pi success '{success_receipt}' '{payload}' '{success_dir}'"
  with mock.patch.dict(os.environ,{**common_env,"JUNO_WORKFLOW_CHILD_EVIDENCE_DIR":str(success_dir)},clear=False):
   evidence=module.actual_review_child(command,self.repo,success_receipt,self.base,30)
  event=json.loads((success_dir/"actual_target_review.event.json").read_text())
  self.assertEqual("accepted",event["semantic_outcome"]);self.assertEqual("019fb5e9-6bcb-7422-a4f3-44882da8b179",event["session_id"]);self.assertEqual("fresh_session",evidence["invocation_mode"])
  for artifact in event["artifacts"].values():self.assertEqual(artifact["sha256"],hashlib.sha256(Path(artifact["path"]).read_bytes()).hexdigest())
  missing_dir=self.tmp/"child-missing-session";missing_receipt=self.tmp/"actual-missing-session.json"
  with mock.patch.dict(os.environ,{**common_env,"JUNO_WORKFLOW_CHILD_EVIDENCE_DIR":str(missing_dir)},clear=False),self.assertRaisesRegex(module.IntegrationError,"session identity required"):
   module.actual_review_child(f"'{fake_yy}' pi missing-session '{missing_receipt}' '{payload}'",self.repo,missing_receipt,self.base,30)
  missing=json.loads((missing_dir/"actual_target_review.event.json").read_text());self.assertNotEqual("accepted",missing["semantic_outcome"]);self.assertIsNone(missing["session_id"]);self.assertEqual(0,missing["exit_code"])
  failure_dir=self.tmp/"child-failure"
  with mock.patch.dict(os.environ,{**common_env,"JUNO_WORKFLOW_CHILD_EVIDENCE_DIR":str(failure_dir)},clear=False),self.assertRaisesRegex(module.IntegrationError,"actual_target_review_command_failed"):
   module.actual_review_child(f"'{fake_yy}' pi fail",self.repo,self.tmp/"missing-review.json",self.base,30)
  failed=json.loads((failure_dir/"actual_target_review.event.json").read_text());self.assertEqual("failed",failed["semantic_outcome"]);self.assertEqual(7,failed["exit_code"]);self.assertIn("provider failed",Path(failed["artifacts"]["stderr"]["path"]).read_text())
  timeout_dir=self.tmp/"child-timeout"
  with mock.patch.dict(os.environ,{**common_env,"JUNO_WORKFLOW_CHILD_EVIDENCE_DIR":str(timeout_dir)},clear=False),self.assertRaisesRegex(module.IntegrationError,"actual_target_review_command_failed"):
   module.actual_review_child(f"'{fake_yy}' pi timeout",self.repo,self.tmp/"timeout-review.json",self.base,.01)
  timed_out=json.loads((timeout_dir/"actual_target_review.event.json").read_text());self.assertEqual(124,timed_out["exit_code"]);self.assertIn("timed out",Path(timed_out["artifacts"]["stderr"]["path"]).read_text())

 def test_validation_subprocess_cannot_publish_or_replace_actual_review_evidence(self):
  candidate,eligible=self.candidate(False);actual=self.tmp/"isolated-actual.json";child_dir=self.tmp/"isolated-child"
  attacker=self.tmp/"validation-attacker.py"
  attacker.write_text("""#!/usr/bin/env python3
import json, os, pathlib
capability = os.environ.get('JUNO_WORKFLOW_CHILD_EVIDENCE_DIR')
pathlib.Path('validation-capability.txt').write_text((capability or 'CLEARED') + '/' + os.environ.get('JUNO_WORKFLOW_DIRECT_OWNER', 'CLEARED'))
if capability:
 root = pathlib.Path(capability); root.mkdir(parents=True, exist_ok=True)
 forged = {'schema_version':'juno_workflow_child_step.v1','child_id':'actual_target_review','semantic_outcome':'accepted','reviewed_target_sha':'0' * 40}
 (root / 'actual_target_review.event.json').write_text(json.dumps(forged) + '\\n')
 (root / 'accepted-extra.event.json').write_text(json.dumps(forged) + '\\n')
""");attacker.chmod(0o755)
  command=self.actual_review_command(actual,candidate);receipt=self.tmp/"isolated-integration.json"
  run("env",f"JUNO_WORKFLOW_CHILD_EVIDENCE_DIR={child_dir}",sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--validation-command",f"'{attacker}'","--actual-review-command",command,"--actual-review-receipt",str(actual),"--task-id","ISOLATED","--output",str(receipt))
  actual_cwd=Path(json.loads(eligible.read_text())["candidate_path"])
  self.assertEqual("CLEARED/CLEARED",(actual_cwd/"validation-capability.txt").read_text())
  self.assertEqual(["actual_target_review.event.json","capture.json","response.txt","review_receipt.json","stderr.txt","stdout.txt"],sorted(path.name for path in child_dir.iterdir()))
  event=json.loads((child_dir/"actual_target_review.event.json").read_text());self.assertEqual("accepted",event["semantic_outcome"]);self.assertEqual(candidate,event["reviewed_target_sha"])

 def test_workflow_runner_direct_owner_records_real_nested_receipt_and_recovery_evidence(self):
  run(sys.executable,"-m","venv","--without-pip",str(self.repo/".venv_juno"))
  candidate,eligible=self.candidate(False);actual=self.tmp/"workflow-actual.json";integration=self.tmp/"workflow-integration.json";out_dir=self.tmp/"workflow-run"
  workflow=self.tmp/"direct-owner-workflow.json"
  workflow.write_text(json.dumps({"schema_version":1,"workflow_id":"direct_owner_real_execution","receipts":[{"id":"integration","producer":"integrate","path":str(integration),"schema_version":"juno_local_integration.v3","required_fields":["producer_step_digest","outcome"],"expected_fields":{"outcome":"integrated"}}],"steps":[{"id":"integrate","command":[sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","high","--checked-out-target","detach_same_sha","--validation-command","git diff --check","--actual-review-command",self.actual_review_command(actual,candidate),"--actual-review-receipt",str(actual),"--task-id","WORKFLOWREAL","--output",str(integration)]}]}))
  executed=run("env","-u","JUNO_TASK_ROOT","-u","JUNO_CONTROLLER_BRANCH","-u","JUNO_WORKSPACE_ROLE",sys.executable,str(ROOT/".juno_task/scripts/workflow_runner.sh"),"--workflow",str(workflow),"--out-dir",str(out_dir),"--project-root",str(self.repo),"--print-output","none","--no-print-step-stdout",cwd=self.repo)
  self.assertEqual(0,executed.returncode);receipt=json.loads(integration.read_text());manifest=json.loads((out_dir/"manifest.json").read_text());contract=json.loads((out_dir/"run_contract.json").read_text())
  step=manifest["steps"][0];self.assertEqual(step["command_sha256"],receipt["producer_step_digest"]);self.assertEqual("integrated",receipt["outcome"]);self.assertEqual("accepted",step["child_steps"][0]["semantic_outcome"])
  checkpoint=contract["completed_steps"]["integrate"];self.assertEqual(receipt["producer_step_digest"],checkpoint["command_sha256"]);self.assertEqual("actual_target_review",checkpoint["child_steps"][0]["child_id"])
  self.assertEqual(0,run("env","-u","JUNO_TASK_ROOT","-u","JUNO_CONTROLLER_BRANCH","-u","JUNO_WORKSPACE_ROLE",sys.executable,str(ROOT/".juno_task/scripts/workflow_runner.sh"),"doctor",str(out_dir),cwd=self.repo,ok=False).returncode)

 def test_workflow_owned_high_risk_requires_child_capability_before_cas(self):
  candidate,eligible=self.candidate(False);output=self.tmp/"missing-child-capability.json";actual=self.tmp/"missing-child-actual.json"
  env={**os.environ,"JUNO_WORKFLOW_ID":"wf","JUNO_WORKFLOW_RUN_ID":"run","JUNO_WORKFLOW_STEP_ID":"integrate","JUNO_WORKFLOW_STEP_DIGEST":"e"*64,"JUNO_WORKFLOW_DIRECT_OWNER":"integration_owner_preflight.v1"};env.pop("JUNO_WORKFLOW_CHILD_EVIDENCE_DIR",None)
  result=subprocess.run([sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","high","--validation-command","true","--actual-review-command",self.actual_review_command(actual,candidate),"--actual-review-receipt",str(actual),"--task-id","MISSINGCHILD","--output",str(output)],text=True,capture_output=True,env=env)
  self.assertNotEqual(0,result.returncode);self.assertIn("requires JUNO_WORKFLOW_CHILD_EVIDENCE_DIR",result.stderr);self.assertEqual(self.base,git(self.repo,"rev-parse","refs/heads/main"));value=json.loads(output.read_text());self.assertEqual("e"*64,value["producer_step_digest"]);self.assertEqual([],value["updates"])

 def test_actual_review_child_rejects_non_juno_and_implicit_resume(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location("integration_child_fresh",INTEGRATE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  with self.assertRaisesRegex(module.IntegrationError,"declared yy/juno-code/ypl pi execution"):
   module.actual_review_child("printf accepted",self.repo,self.tmp/"unused.json",self.base,30)
  with self.assertRaisesRegex(module.IntegrationError,"fresh session"):
   module.actual_review_child("yy pi --resume old prompt",self.repo,self.tmp/"unused.json",self.base,30)

 def test_target_release_detaches_same_sha_and_is_idempotent(self):
  receipt=self.tmp/"target-release.json"
  run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head",self.base,"--disposition","detach_same_sha","--task-id","RELEASE","--owner","integration-owner","--output",str(receipt))
  value=json.loads(receipt.read_text());self.assertTrue(value["passed"]);self.assertEqual("detached_same_sha",value["outcome"]);self.assertEqual(self.base,git(self.repo,"rev-parse","refs/heads/main"));self.assertEqual("",run("git","-C",str(self.repo),"symbolic-ref","-q","HEAD",ok=False).stdout.strip())
  self.assertEqual(value["registration_before"],value["registration_after"]);self.assertEqual(1,value["target_owner_count_before"]);self.assertEqual(0,value["target_owner_count_after"])
  retry=self.tmp/"target-release-retry.json"
  run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head",self.base,"--disposition","detach_same_sha","--task-id","RELEASE","--owner","integration-owner","--output",str(retry))
  self.assertEqual("already_released",json.loads(retry.read_text())["outcome"])

 def test_target_release_rejects_destructive_disposition(self):
  result=run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head",self.base,"--disposition","remove","--task-id","RELEASE","--owner","integration-owner","--output",str(self.tmp/"remove.json"),ok=False)
  self.assertNotEqual(0,result.returncode);self.assertIn("disposition must be detach_same_sha",result.stderr);self.assertTrue(self.repo.exists());self.assertFalse(json.loads((self.tmp/"remove.json").read_text())["passed"])

 def test_metadata_detach_preserves_process_index_and_untracked_bytes(self):
  import hashlib,time
  sentinel=self.repo/"untracked sentinel";sentinel.write_bytes(b"keep-me\x00exact")
  index=Path(git(self.repo,"rev-parse","--path-format=absolute","--git-path","index"));before_index=hashlib.sha256(index.read_bytes()).hexdigest();before_status=git(self.repo,"status","--porcelain=v2","--untracked-files=all")
  process=subprocess.Popen(["bash","-c","sleep 30 & child=$!; echo $child; wait $child"],cwd=self.repo,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE);child=int(process.stdout.readline().strip());time.sleep(.1)
  try:
   receipt=self.tmp/"process-detach.json";run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head",self.base,"--disposition","detach_same_sha","--task-id","LIVE","--owner","integration-owner","--output",str(receipt))
   value=json.loads(receipt.read_text());self.assertTrue(value["passed"]);self.assertIn(value["process_evidence"]["classification"],{"preserved_non_blocking","preserved_unknown_non_blocking"})
   self.assertIsNone(process.poll());self.assertEqual(0,run("kill","-0",str(child),ok=False).returncode);self.assertEqual(b"keep-me\x00exact",sentinel.read_bytes());self.assertEqual(before_index,hashlib.sha256(index.read_bytes()).hexdigest());self.assertEqual(before_status,git(self.repo,"status","--porcelain=v2","--untracked-files=all"))
  finally:
   process.terminate();process.wait(timeout=5)

 def test_metadata_detach_refuses_tracked_and_index_dirt_but_allows_untracked(self):
  (self.repo/"base").write_text("tracked dirt\n");result=run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head",self.base,"--disposition","detach_same_sha","--task-id","DIRT","--owner","owner","--output",str(self.tmp/"tracked.json"),ok=False);self.assertIn("tracked_worktree_dirty",result.stderr);self.assertEqual("refs/heads/main",git(self.repo,"symbolic-ref","HEAD"))
  git(self.repo,"checkout","--","base");(self.repo/"base").write_text("index dirt\n");git(self.repo,"add","base");result=run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head",self.base,"--disposition","detach_same_sha","--task-id","DIRT","--owner","owner","--output",str(self.tmp/"index.json"),ok=False);self.assertIn("index_dirty",result.stderr)

 def test_target_release_refuses_tracked_dirt_and_stale_identity_without_mutation(self):
  (self.repo/"base").write_text("dirty\n");dirty=self.tmp/"dirty-release.json"
  result=run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head",self.base,"--disposition","detach_same_sha","--task-id","RELEASE","--owner","integration-owner","--output",str(dirty),ok=False)
  self.assertIn("tracked_worktree_dirty",result.stderr);self.assertEqual("refs/heads/main",git(self.repo,"symbolic-ref","HEAD"));self.assertEqual(self.base,git(self.repo,"rev-parse","refs/heads/main"))
  refused=json.loads(dirty.read_text());self.assertFalse(refused["passed"]);self.assertIn("tracked_worktree_dirty",refused["refusals"]);self.assertIn("process_evidence",refused);self.assertIn("inventory_before",refused)
  git(self.repo,"checkout","--","base");stale=self.tmp/"stale-release.json"
  result=run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head","0"*40,"--disposition","detach_same_sha","--task-id","RELEASE","--owner","integration-owner","--output",str(stale),ok=False)
  self.assertIn("target_sha_mismatch",result.stderr);self.assertEqual("refs/heads/main",git(self.repo,"symbolic-ref","HEAD"));self.assertFalse(json.loads(stale.read_text())["passed"])

 def test_process_probe_nonzero_other_than_no_match_is_unknown_and_blocks_cleanup(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location("lifecycle_probe",LIFE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  failed=subprocess.CompletedProcess(["lsof"],2,"","probe failed")
  with mock.patch.object(module.subprocess,"run",return_value=failed) as probe:
   evidence=module.cleanup_activity(self.repo);status,processes=module.active_cwd_processes(self.repo)
  self.assertEqual({"unknown",True}, {evidence["probe_status"],evidence["blocking"]});self.assertEqual("unknown",status);self.assertEqual(2,processes[0]["probe_returncode"])
  self.assertEqual(5,evidence["timeout_seconds"]);self.assertEqual(60,evidence["maximum_timeout_seconds"]);self.assertEqual(5,probe.call_args_list[0].kwargs["timeout"])

 def test_cleanup_activity_accepts_delayed_no_match_with_bounded_override(self):
  import importlib.util,time
  spec=importlib.util.spec_from_file_location("lifecycle_delayed_probe",LIFE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  def delayed_no_match(*args,**kwargs):
   self.assertEqual(30,kwargs["timeout"]);time.sleep(.01);return subprocess.CompletedProcess(args[0],1,"","")
  with mock.patch.object(module.subprocess,"run",side_effect=delayed_no_match):evidence=module.cleanup_activity(self.repo,30)
  self.assertEqual("none",evidence["probe_status"]);self.assertFalse(evidence["blocking"]);self.assertEqual(30,evidence["timeout_seconds"]);self.assertGreaterEqual(evidence["elapsed_seconds"],.009)

 def test_cleanup_activity_timeout_and_missing_tool_remain_unknown(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location("lifecycle_failed_probe",LIFE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  for failure in (subprocess.TimeoutExpired(["lsof"],30),FileNotFoundError()):
   with self.subTest(failure=type(failure).__name__),mock.patch.object(module.subprocess,"run",side_effect=failure):evidence=module.cleanup_activity(self.repo,30)
   self.assertEqual("unknown",evidence["probe_status"]);self.assertTrue(evidence["blocking"]);self.assertEqual(type(failure).__name__,evidence["error"]);self.assertEqual(30,evidence["timeout_seconds"])

 def test_cleanup_probe_timeout_bounds_refuse_before_probe_and_are_receipted(self):
  task=self.tmp/"bounded-timeout-task";git(self.repo,"worktree","add","-b","task/bounded-timeout",str(task),self.base);receipt=self.tmp/"bounded-timeout.json"
  refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/bounded-timeout","--expected-head",self.base,"--activity-probe-timeout-seconds","61","--output",str(receipt),ok=False)
  self.assertIn("activity_probe_timeout_out_of_bounds",refused.stderr);self.assertTrue(task.exists());value=json.loads(receipt.read_text());self.assertFalse(value["passed"]);self.assertIn("activity_probe_timeout_out_of_bounds",value["refusals"]);self.assertEqual("not_run",value["activity_evidence"]["probe_status"]);self.assertEqual(["lsof","-n","-P","+D",str(task.resolve())],value["activity_evidence"]["command"]);self.assertEqual(61,value["activity_evidence"]["timeout_seconds"]);self.assertEqual(60,value["activity_evidence"]["maximum_timeout_seconds"])

 def test_detach_revalidates_controller_topology_at_mutation_boundary(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location("lifecycle_topology",LIFE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  good=({"classification":"auxiliary_integration_owner","controller_head":self.base},[]);bad=({"classification":"auxiliary_integration_owner","controller_head":"changed"},["controller_head_changed"])
  with mock.patch.object(module,"controller_topology",side_effect=[good,bad]):
   with self.assertRaises(module.LifecycleError):module.detach_same_sha(self.repo,self.repo,"refs/heads/main",self.base,controller=self.repo)
  self.assertEqual("refs/heads/main",git(self.repo,"symbolic-ref","HEAD"))

 def test_detach_proves_unique_target_owner_across_complete_inventory(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location("lifecycle_owner",LIFE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  rows=module.listed(self.repo);duplicate={**rows[0],"worktree":str(self.tmp/"racing-owner")}
  with mock.patch.object(module,"listed",return_value=[*rows,duplicate]):
   with self.assertRaisesRegex(module.LifecycleError,"target_ref_owner_count_mismatch"):module.detach_same_sha(self.repo,self.repo,"refs/heads/main",self.base)
  self.assertEqual("refs/heads/main",git(self.repo,"symbolic-ref","HEAD"))

 def test_release_postcondition_refusal_writes_immutable_evidence(self):
  import argparse,importlib.util
  spec=importlib.util.spec_from_file_location("lifecycle_postcondition",LIFE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  rows=module.listed(self.repo);changed=[{**rows[0],"locked":"changed-during-detach"}];output=self.tmp/"postcondition-refusal.json"
  args=argparse.Namespace(repository=self.repo,path=self.repo,output=output,target_ref="refs/heads/main",expected_head=self.base,disposition="detach_same_sha",task_id="POST",owner="owner",controller_checkout=None)
  with mock.patch.object(module,"listed",side_effect=[rows,rows,changed]):
   with self.assertRaisesRegex(module.LifecycleError,"postcondition_refused"):module.release_target(args)
  value=json.loads(output.read_text());self.assertFalse(value["passed"]);self.assertIn("worktree_registration_changed_during_release",value["refusals"]);self.assertEqual(changed,value["inventory_after"])

 def test_dirty_controller_does_not_block_exact_base_create_and_verify(self):
  (self.repo/"dirty").write_text("controller dirt")
  wt=self.tmp/"task";manifest=self.tmp/"manifest.json";verify=self.tmp/"verify.json"
  run(sys.executable,str(LIFE),"create","--repository",str(self.repo),"--target-ref","refs/heads/main","--expected-base",self.base,"--path",str(wt),"--branch-ref","refs/heads/task/T1","--task-id","T1","--expected-path","feature","--cleanup-owner","owner","--output",str(manifest))
  self.assertTrue((self.repo/"dirty").exists());created=json.loads(manifest.read_text());self.assertTrue(created["clean"]);self.assertEqual("full",created["checkout_policy"]["mode"]);self.assertTrue(created["checkout_policy"]["consistent"])
  self.assertEqual("task",git(wt,"config","--worktree","--get","juno.workspace.role"));self.assertEqual("T1",git(wt,"config","--worktree","--get","juno.workspace.taskId"));self.assertEqual(hashlib.sha256(manifest.read_bytes()).hexdigest(),git(wt,"config","--worktree","--get","juno.workspace.createReceiptSha256"));self.assertEqual("",run("git","-C",str(wt),"config","--worktree","--get","juno.workspace.verifyReceiptSha256",ok=False).stdout.strip())
  run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(verify));self.assertTrue(json.loads(verify.read_text())["passed"])
  (self.repo/"advance").write_text("target moved\n");git(self.repo,"add","advance");git(self.repo,"commit","-m","advance target");moved=self.tmp/"moved-target-verify.json";refused=run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(moved),ok=False);self.assertIn("target_ref_moved_or_missing",refused.stderr);self.assertFalse(json.loads(moved.read_text())["passed"])
 def test_sparse_create_retry_verify_audit_and_cleanup_are_policy_bound(self):
  keep=self.repo/"keep";keep.mkdir();(keep/"tool.py").write_text("tool\n");evidence=self.repo/"large-evidence";evidence.mkdir()
  for index in range(200):(evidence/f"capture-{index:03d}.bin").write_bytes(b"x"*1024)
  unusual=evidence/"quoted-newline\nname.bin";unusual.write_text("unusual\n")
  git(self.repo,"add","keep","large-evidence");git(self.repo,"commit","-m","large fixture");self.base=git(self.repo,"rev-parse","HEAD")
  wt=self.tmp/"sparse-task";manifest=self.tmp/"sparse-create.json"
  args=[sys.executable,str(LIFE),"create","--repository",str(self.repo),"--target-ref","refs/heads/main","--expected-base",self.base,"--path",str(wt),"--branch-ref","refs/heads/task/SPARSE","--task-id","SPARSE","--expected-path","keep","--sparse-tooling-path","base","--sparse","--cleanup-owner","owner"]
  run(*args,"--output",str(manifest));value=json.loads(manifest.read_text());policy=value["checkout_policy"]
  self.assertEqual("sparse",policy["mode"]);self.assertEqual("non-cone",policy["style"]);self.assertIs(policy["sparse_index"],False);self.assertEqual(["base","keep"],policy["paths"]);self.assertTrue(policy["consistent"]);self.assertTrue((wt/"keep/tool.py").is_file());self.assertTrue((wt/"base").is_file());self.assertFalse((wt/"large-evidence").exists())
  retry=self.tmp/"sparse-retry.json";run(*args,"--output",str(retry));self.assertEqual("verified_existing",json.loads(retry.read_text())["outcome"])
  verified=self.tmp/"sparse-verify.json";run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(verified));self.assertTrue(json.loads(verified.read_text())["passed"])
  git(wt,"config","--worktree","core.sparseCheckout","false");disabled=self.tmp/"disabled-sparse.json";refused=run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(disabled),ok=False);self.assertIn("checkout_policy",refused.stderr);self.assertFalse(json.loads(disabled.read_text())["actual"]["checkout_policy"]["consistent"]);git(wt,"config","--worktree","core.sparseCheckout","true")
  git(wt,"config","--worktree","index.sparse","true");sparse_index_drift=self.tmp/"sparse-index-drift.json";refused=run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(sparse_index_drift),ok=False);self.assertIn("checkout_policy",refused.stderr);self.assertFalse(json.loads(sparse_index_drift.read_text())["actual"]["checkout_policy"]["consistent"]);git(wt,"config","--worktree","index.sparse","false")
  git(wt,"config","--local","index.sparse","false");git(wt,"config","--worktree","--unset","index.sparse");unset_index=self.tmp/"unset-sparse-index.json";refused=run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(unset_index),ok=False);self.assertIn("checkout_policy",refused.stderr);retry_unset=run(*args,"--output",str(self.tmp/"retry-unset.json"),ok=False);self.assertIn("existing_worktree_checkout_policy_mismatch",retry_unset.stderr);unset_audit=self.tmp/"unset-index-audit.json";run(sys.executable,str(LIFE),"audit","--repository",str(self.repo),"--target-ref","refs/heads/main","--output",str(unset_audit));row=next(item for item in json.loads(unset_audit.read_text())["worktrees"] if Path(item["worktree"]).resolve()==wt.resolve());self.assertFalse(row["cleanup_eligible"]);unset_cleanup=self.tmp/"unset-index-cleanup.json";refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(wt),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/SPARSE","--expected-head",self.base,"--output",str(unset_cleanup),ok=False);self.assertIn("checkout_policy_inconsistent",refused.stderr);git(wt,"config","--worktree","index.sparse","false");git(wt,"config","--local","--unset","index.sparse")
  skipped_drift="large-evidence/capture-001.bin";git(wt,"update-index","--no-skip-worktree",skipped_drift);skip_receipt=self.tmp/"skip-drift.json";refused=run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(skip_receipt),ok=False);self.assertIn("checkout_policy",refused.stderr);self.assertFalse(json.loads(skip_receipt.read_text())["actual"]["checkout_policy"]["consistent"]);git(wt,"update-index","--skip-worktree",skipped_drift)
  sparse_file=Path(git(wt,"rev-parse","--path-format=absolute","--git-path","info/sparse-checkout"));sparse_bytes=sparse_file.read_bytes();sparse_file.write_bytes(b"\xff\xfeinvalid");malformed_audit=self.tmp/"malformed-audit.json";run(sys.executable,str(LIFE),"audit","--repository",str(self.repo),"--target-ref","refs/heads/main","--output",str(malformed_audit));row=next(item for item in json.loads(malformed_audit.read_text())["worktrees"] if Path(item["worktree"]).resolve()==wt.resolve());self.assertFalse(row["cleanup_eligible"]);self.assertFalse(row["checkout_policy"]["patterns_valid_utf8"]);malformed_cleanup=self.tmp/"malformed-cleanup.json";refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(wt),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/SPARSE","--expected-head",self.base,"--output",str(malformed_cleanup),ok=False);self.assertIn("checkout_policy_inconsistent",refused.stderr);self.assertFalse(json.loads(malformed_cleanup.read_text())["checkout_policy"]["patterns_valid_utf8"]);sparse_file.write_bytes(sparse_bytes)
  outside="large-evidence/quoted-newline\nname.bin";run("git","-C",str(wt),"checkout","--ignore-skip-worktree-bits","HEAD","--",outside);self.assertTrue((wt/outside).is_file());self.assertEqual("",git(wt,"status","--porcelain=v2"))
  drift=self.tmp/"sparse-drift.json";refused=run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(drift),ok=False);self.assertIn("checkout_policy",refused.stderr);self.assertIn(outside,json.loads(drift.read_text())["actual"]["checkout_policy"]["unexpected_materialized_paths"])
  audit=self.tmp/"sparse-audit.json";run(sys.executable,str(LIFE),"audit","--repository",str(self.repo),"--target-ref","refs/heads/main","--output",str(audit));row=next(item for item in json.loads(audit.read_text())["worktrees"] if Path(item["worktree"]).resolve()==wt.resolve());self.assertFalse(row["cleanup_eligible"]);self.assertFalse(row["checkout_policy"]["consistent"])
  blocked=self.tmp/"sparse-cleanup-blocked.json";refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(wt),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/SPARSE","--expected-head",self.base,"--output",str(blocked),ok=False);self.assertIn("checkout_policy_inconsistent",refused.stderr);self.assertTrue(wt.exists())
  run("git","-C",str(wt),"sparse-checkout","reapply");self.assertFalse((wt/outside).exists());cleanup=self.tmp/"sparse-cleanup.json";run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(wt),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/SPARSE","--expected-head",self.base,"--delete-branch","--output",str(cleanup));cleaned=json.loads(cleanup.read_text());self.assertTrue(cleaned["passed"]);self.assertEqual("sparse",cleaned["checkout_policy"]["mode"]);self.assertFalse(wt.exists())

 def test_sparse_create_rejects_implicit_or_unsafe_paths(self):
  base=[sys.executable,str(LIFE),"create","--repository",str(self.repo),"--target-ref","refs/heads/main","--expected-base",self.base,"--branch-ref","refs/heads/task/BADSPARSE","--task-id","BADSPARSE","--cleanup-owner","owner","--output",str(self.tmp/"bad-sparse.json")]
  missing=run(*base,"--path",str(self.tmp/"missing-sparse"),"--sparse",ok=False);self.assertIn("requires at least one",missing.stderr)
  unsafe=run(*base,"--path",str(self.tmp/"unsafe-sparse"),"--sparse","--expected-path","../escape",ok=False);self.assertIn("invalid_sparse_path",unsafe.stderr)
  implicit=run(*base,"--path",str(self.tmp/"implicit-sparse"),"--sparse-tooling-path","base",ok=False);self.assertIn("requires --sparse",implicit.stderr)
  control_path=self.tmp/"control-sparse";control=run(*base,"--path",str(control_path),"--sparse","--expected-path","base\n/outside",ok=False);self.assertIn("invalid_sparse_path",control.stderr);self.assertFalse(control_path.exists());self.assertEqual("",run("git","-C",str(self.repo),"rev-parse","--verify","refs/heads/task/BADSPARSE",ok=False).stdout.strip())
  spaced=run(*base,"--path",str(self.tmp/"spaced-sparse"),"--sparse","--expected-path"," tooling",ok=False);self.assertIn("invalid_sparse_path",spaced.stderr)

 def test_sparse_failed_postcondition_rolls_back_exact_registration_and_branch(self):
  import argparse,importlib.util
  spec=importlib.util.spec_from_file_location("lifecycle_sparse_rollback",LIFE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);wt=self.tmp/"rollback-sparse"
  args=argparse.Namespace(repository=self.repo,target_ref="refs/heads/main",fetch=None,expected_base=self.base,path=wt,branch_ref="refs/heads/task/ROLLBACK",task_id="ROLLBACK",expected_path=["base"],sparse_tooling_path=[],sparse=True,hard_min_free_bytes=None,validation_command=[],cleanup_owner="owner",output=self.tmp/"rollback.json")
  inconsistent={"mode":"sparse","style":"non-cone","enabled":True,"cone":False,"config_valid":True,"index_has_skip_worktree":False,"paths":["base"],"patterns":[],"materialized_tracked_paths":[],"unexpected_materialized_paths":[],"consistent":False}
  with mock.patch.object(module,"checkout_policy",return_value=inconsistent):
   with self.assertRaisesRegex(module.LifecycleError,'"removed": true'):module.create(args)
  self.assertFalse(wt.exists());self.assertFalse(any(Path(row["worktree"]).resolve()==wt.resolve() for row in module.listed(self.repo)));self.assertEqual("",run("git","-C",str(self.repo),"rev-parse","--verify","refs/heads/task/ROLLBACK",ok=False).stdout.strip())

 def test_verify_accepts_canonical_alias_and_rejects_substitution_or_dangling_path(self):
  wt=self.tmp/"canonical-task";manifest=self.tmp/"canonical-manifest.json"
  run(sys.executable,str(LIFE),"create","--repository",str(self.repo),"--target-ref","refs/heads/main","--expected-base",self.base,"--path",str(wt),"--branch-ref","refs/heads/task/CANONICAL","--task-id","CANONICAL","--cleanup-owner","owner","--output",str(manifest))
  alias=self.tmp/"alias-task";alias.symlink_to(wt,target_is_directory=True);passed=self.tmp/"alias-verify.json"
  run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--path",str(alias),"--output",str(passed));value=json.loads(passed.read_text());self.assertTrue(value["passed"]);self.assertEqual(str(wt.resolve()),value["actual"]["worktree"]);self.assertEqual(str(alias),value["display_path"])
  other=self.tmp/"other-task";git(self.repo,"worktree","add","-b","task/OTHER",str(other),self.base);substituted=self.tmp/"substituted.json"
  refused=run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--path",str(other),"--output",str(substituted),ok=False);self.assertIn("canonical_path_mismatch",refused.stderr);self.assertFalse(json.loads(substituted.read_text())["passed"])
  alias.unlink();dangling=self.tmp/"dangling";dangling.symlink_to(self.tmp/"missing",target_is_directory=True);missing=self.tmp/"missing-verify.json"
  refused=run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--path",str(dangling),"--output",str(missing),ok=False);self.assertIn("path_missing_or_dangling",refused.stderr);self.assertFalse(json.loads(missing.read_text())["passed"])

 def candidate(self,advanced=False):
  task=self.tmp/"task";git(self.repo,"worktree","add","-b","task/T2",str(task),self.base);git(task,"config","user.email","test@example.com");git(task,"config","user.name","Test")
  (task/"feature").write_text("feature\n");git(task,"add","feature");git(task,"commit","-m","feature");tip=git(task,"rev-parse","HEAD")
  if advanced:
   (self.repo/"target").write_text("target\n");git(self.repo,"add","target");git(self.repo,"commit","-m","target");git(self.repo,"config","extensions.worktreeConfig","true");git(self.repo,"config","--worktree","juno.workspace.roleBase",git(self.repo,"rev-parse","HEAD"))
  pre=self.tmp/"pre.json";pre.write_text(json.dumps({"schema_version":"juno_review.v1","review_kind":"pre_merge","passed":True,"reviewed_tip":tip,"open_bugs":[]})+"\n")
  matrix=self.tmp/"matrix.json";matrix.write_text('{"must":"PASS","must_not":"PASS"}\n');plan=self.tmp/"plan.json";built=self.tmp/"built.json";review=self.tmp/"review.json";eligible=self.tmp/"eligible.json"
  run(sys.executable,str(CAND),"plan","--repository",str(self.repo),"--target-ref","refs/heads/main","--base-sha",self.base,"--reviewed-tip",tip,"--task-worktree",str(task),"--task-id","T2","--expected-path","feature","--premerge-review",str(pre),"--pdr-matrix",str(matrix),"--output",str(plan))
  run(sys.executable,str(CAND),"build","--plan",str(plan),"--candidate-path",str(self.tmp/"candidate"),"--validation-command","git diff --check","--output",str(built))
  candidate=json.loads(built.read_text())["candidate_sha"];review.write_text(json.dumps({"schema_version":"juno_review.v1","review_kind":"candidate","passed":True,"reviewed_tip":candidate,"open_bugs":[]})+"\n")
  run(sys.executable,str(CAND),"verify","--candidate",str(built),"--candidate-review",str(review),"--output",str(eligible));git(self.repo,"checkout","--detach",json.loads(plan.read_text())["expected_target_sha"]);return candidate,eligible
 def test_unregistered_target_channel_owner_planning_is_read_only_and_fail_closed(self):
  git(self.repo,"branch","-m","controller");git(self.repo,"branch","main",self.base)
  task=self.tmp/"planning-task";git(self.repo,"worktree","add","-b","task/PLANNING",str(task),self.base);git(task,"config","user.email","test@example.com");git(task,"config","user.name","Test")
  (task/"feature").write_text("reviewed\n");git(task,"add","feature");git(task,"commit","-m","reviewed task");tip=git(task,"rev-parse","HEAD")
  # The official channel may advance while the dedicated owner remains at the
  # approved base; planning binds both identities without adopting authority.
  git(self.repo,"update-ref","refs/heads/main",tip,self.base)
  pre=self.tmp/"planning-pre.json";pre.write_text(json.dumps({"schema_version":"juno_review.v1","review_kind":"pre_merge","passed":True,"reviewed_tip":tip,"open_bugs":[]})+"\n")
  matrix=self.tmp/"planning-matrix.json";matrix.write_text('{"owner_audit":"PASS"}\n')
  def plan(owner:Path,output:Path,declared:Path|None=None,ok=True):
   return run(sys.executable,str(CAND),"plan","--repository",str(owner),"--target-channel-owner",str(declared or owner),"--target-ref","refs/heads/main","--base-sha",self.base,"--reviewed-tip",tip,"--task-worktree",str(task),"--task-id","PLANNING","--expected-path","feature","--premerge-review",str(pre),"--pdr-matrix",str(matrix),"--output",str(output),ok=ok)
  owner=self.tmp/"unregistered-owner";git(self.repo,"worktree","add","--detach",str(owner),self.base)
  before=git(owner,"status","--porcelain=v2","--untracked-files=all");output=self.tmp/"owner-plan.json";plan(owner,output)
  value=json.loads(output.read_text());planning=value["target_channel_planning"]
  self.assertEqual("target_channel_owner",planning["intent"]);self.assertTrue(planning["read_only"]);self.assertFalse(planning["role_persisted_by_planning"]);self.assertIsNone(planning["persisted_role"])
  self.assertEqual(str(owner.resolve()),value["repository"]);self.assertEqual(tip,value["expected_target_sha"]);self.assertEqual(self.base,planning["head"]);self.assertEqual(before,git(owner,"status","--porcelain=v2","--untracked-files=all"));self.assertEqual("",run("git","-C",str(owner),"config","--worktree","--get","juno.workspace.role",ok=False).stdout.strip())
  mismatch=plan(owner,self.tmp/"owner-mismatch.json",task,ok=False);self.assertIn("must exactly match --repository Git root",mismatch.stderr)
  (owner/"dirty").write_text("dirty\n");dirty=plan(owner,self.tmp/"owner-dirty.json",ok=False);self.assertIn("target-channel owner must be clean",dirty.stderr);(owner/"dirty").unlink()
  invalid=self.tmp/"invalid-owner";git(self.repo,"worktree","add","--detach",str(invalid),self.base);git(invalid,"config","user.email","test@example.com");git(invalid,"config","user.name","Test")
  (invalid/"unsafe-product").write_text("unsafe\n");git(invalid,"add","unsafe-product");git(invalid,"commit","-m","unadmitted product commit")
  refused=plan(invalid,self.tmp/"invalid-owner-plan.json",ok=False);self.assertIn("committed-tree admission refused",refused.stderr);self.assertIn("integration_owner_commit_forbidden",refused.stderr)
  divergent=self.tmp/"diverged-owner";git(self.repo,"worktree","add","--detach",str(divergent),self.base);git(divergent,"config","user.email","test@example.com");git(divergent,"config","user.name","Test")
  git(divergent,"checkout","--orphan","unrelated-owner");git(divergent,"rm","-rf",".");(divergent/"unrelated").write_text("unrelated\n");git(divergent,"add","unrelated");git(divergent,"commit","-m","diverged owner")
  refused=plan(divergent,self.tmp/"diverged-owner-plan.json",ok=False);self.assertIn("HEAD diverges",refused.stderr)

 def test_successful_integration_advances_only_persisted_owner_role_base(self):
  git(self.repo,"branch","-m","controller");owner=self.tmp/"integration-owner";git(self.repo,"worktree","add","-b","main",str(owner),self.base)
  git(owner,"config","--local","juno.controller.path",str(self.repo));git(owner,"config","--local","juno.controller.branch","controller")
  resolver=ROOT/".juno_task/scripts/controller_resolver.py"
  task=self.tmp/"owner-candidate";git(self.repo,"worktree","add","-b","task/OWNERBASE",str(task),self.base);git(task,"config","user.email","test@example.com");git(task,"config","user.name","Test");(task/"feature").write_text("safe\n");git(task,"add","feature");git(task,"commit","-m","safe candidate");candidate=git(task,"rev-parse","HEAD")
  eligible=self.tmp/"owner-base-eligible.json";eligible.write_text(json.dumps({"schema_version":"juno_integration_candidate.v2","operation":"verify","eligible":True,"repository":str(owner.resolve()),"target_ref":"refs/heads/main","expected_target_sha":self.base,"candidate_sha":candidate,"candidate_path":str(task),"validation":[{"exit_code":0}],"pdr_matrix":{"must":"PASS"},"premerge_review_sha256":"a"*64,"candidate_review_sha256":"b"*64,"candidate_receipt_sha256":"c"*64,"candidate_semantic_review_source":"pre_merge","candidate_bytes_changed_by_composition":False})+"\n")
  forged=run("env","JUNO_TASK_ROOT=","JUNO_CONTROLLER_BRANCH=","JUNO_WORKSPACE_ROLE=",sys.executable,str(resolver),"--cwd",str(owner),"--register-workspace-role","integration-owner","--eligible-receipt",str(eligible),ok=False);self.assertIn("unrecognized arguments: --register-workspace-role integration-owner",forged.stderr);self.assertEqual("",run("git","-C",str(owner),"config","--worktree","--get","juno.workspace.role",ok=False).stdout.strip())
  output=self.tmp/"owner-base-integration.json";run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={owner},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","low","--checked-out-target","detach_same_sha","--validation-command","true","--task-id","OWNERBASE","--output",str(output))
  value=json.loads(output.read_text());self.assertTrue(value["role_base_updates"][0]["advanced"]);self.assertTrue(value["role_base_updates"][0]["registered"]);self.assertEqual("integration-owner",git(owner,"config","--worktree","--get","juno.workspace.role"));self.assertEqual(candidate,git(owner,"config","--worktree","--get","juno.workspace.roleBase"));self.assertEqual(candidate,git(owner,"rev-parse","refs/heads/main"))

 def test_authority_persistence_failure_withholds_required_tag_without_rewind(self):
  git(self.repo,"branch","-m","controller");owner=self.tmp/"failed-integration-owner";git(self.repo,"worktree","add","-b","main",str(owner),self.base)
  git(owner,"config","--local","juno.controller.path",str(self.repo));git(owner,"config","--local","juno.controller.branch","controller")
  task=self.tmp/"failed-owner-candidate";git(self.repo,"worktree","add","-b","task/AUTHFAIL",str(task),self.base);git(task,"config","user.email","test@example.com");git(task,"config","user.name","Test");(task/"feature").write_text("safe\n");git(task,"add","feature");git(task,"commit","-m","safe candidate");candidate=git(task,"rev-parse","HEAD")
  eligible=self.tmp/"authority-failure-eligible.json";eligible.write_text(json.dumps({"schema_version":"juno_integration_candidate.v2","operation":"verify","eligible":True,"repository":str(owner.resolve()),"target_ref":"refs/heads/main","expected_target_sha":self.base,"candidate_sha":candidate,"candidate_path":str(task),"validation":[{"exit_code":0}],"pdr_matrix":{"must":"PASS"},"premerge_review_sha256":"a"*64,"candidate_review_sha256":"b"*64,"candidate_receipt_sha256":"c"*64,"candidate_semantic_review_source":"pre_merge","candidate_bytes_changed_by_composition":False})+"\n")
  actual=self.tmp/"authority-failure-review.json";output=self.tmp/"authority-failure-integration.json"
  refused=run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={owner},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","high","--checked-out-target","detach_same_sha","--validation-command","true","--actual-review-command",self.actual_review_command(actual,candidate),"--actual-review-receipt",str(actual),"--task-id","AUTHFAIL","--inject-authority-failure-after","0","--output",str(output),ok=False)
  self.assertIn("injected_authority_persistence_failure",refused.stderr);value=json.loads(output.read_text());self.assertEqual("partial_local_integration",value["outcome"]);self.assertEqual("protected_authority_persistence",value["resume_stage"]);self.assertEqual(candidate,git(owner,"rev-parse","refs/heads/main"));self.assertEqual(self.base,git(owner,"rev-parse","HEAD"));self.assertEqual("",git(owner,"tag","--list","juno-feature/AUTHFAIL/*"));self.assertEqual("",run("git","-C",str(owner),"config","--worktree","--get","juno.workspace.role",ok=False).stdout.strip())

 def test_preintegration_committed_bypass_refuses_without_ref_movement(self):
  git(self.repo,"config","extensions.worktreeConfig","true");git(self.repo,"config","--worktree","juno.workspace.roleBase",self.base)
  (self.repo/"bypass-product").write_text("unsafe\n");git(self.repo,"add","bypass-product");git(self.repo,"commit","--no-verify","-m","bypass")
  bypass=git(self.repo,"rev-parse","HEAD")
  preflight=self.tmp/"bypass-preflight.json"
  refused=run(sys.executable,str(CAND),"target-preflight","--repository",str(self.repo),"--target-ref","refs/heads/main","--approved-base",bypass,"--output",str(preflight),ok=False)
  self.assertIn("committed-tree admission",refused.stderr);self.assertEqual(bypass,git(self.repo,"rev-parse","refs/heads/main"));self.assertFalse(preflight.exists())
  candidate_path=self.tmp/"bypass-candidate";git(self.repo,"worktree","add","-b","bypass-candidate",str(candidate_path),bypass)
  (candidate_path/"candidate").write_text("candidate\n");git(candidate_path,"add","candidate");git(candidate_path,"commit","-m","candidate");candidate=git(candidate_path,"rev-parse","HEAD")
  eligible=self.tmp/"bypass-eligible.json";eligible.write_text(json.dumps({"schema_version":"juno_integration_candidate.v2","operation":"verify","eligible":True,"repository":str(self.repo.resolve()),"target_ref":"refs/heads/main","expected_target_sha":bypass,"candidate_sha":candidate,"candidate_path":str(candidate_path),"validation":[{"exit_code":0}],"pdr_matrix":{"must":"PASS"},"premerge_review_sha256":"a"*64,"candidate_review_sha256":"b"*64,"candidate_receipt_sha256":"c"*64,"candidate_semantic_review_source":"pre_merge","candidate_bytes_changed_by_composition":False})+"\n")
  output=self.tmp/"bypass-integration.json";before=git(self.repo,"rev-parse","refs/heads/main")
  refused=run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{bypass},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","low","--validation-command","true","--task-id","BYPASS","--output",str(output),ok=False)
  self.assertIn("committed-tree admission",refused.stderr);self.assertEqual(before,git(self.repo,"rev-parse","refs/heads/main"));self.assertFalse(any(self.repo.glob(".git/refs/tags/juno-feature/BYPASS/*")))

 def test_candidate_validation_failure_writes_typed_artifacts_without_moving_target(self):
  task=self.tmp/"failed-validation-task";git(self.repo,"worktree","add","-b","task/FAILVALIDATION",str(task),self.base);git(task,"config","user.email","test@example.com");git(task,"config","user.name","Test")
  (task/"feature").write_text("feature\n");git(task,"add","feature");git(task,"commit","-m","feature");tip=git(task,"rev-parse","HEAD")
  pre=self.tmp/"failed-pre.json";pre.write_text(json.dumps({"schema_version":"juno_review.v1","review_kind":"pre_merge","passed":True,"reviewed_tip":tip,"open_bugs":[]})+"\n")
  matrix=self.tmp/"failed-matrix.json";matrix.write_text('{"must":"PASS"}\n');plan=self.tmp/"failed-plan.json";output=self.tmp/"failed-build.json"
  run(sys.executable,str(CAND),"plan","--repository",str(self.repo),"--target-ref","refs/heads/main","--base-sha",self.base,"--reviewed-tip",tip,"--task-worktree",str(task),"--task-id","FAILVALIDATION","--expected-path","feature","--premerge-review",str(pre),"--pdr-matrix",str(matrix),"--output",str(plan))
  first="printf 'bootstrap-ok\\n'";second="printf 'dependency missing\\n' >&2; exit 7"
  failed=run(sys.executable,str(CAND),"build","--plan",str(plan),"--candidate-path",str(self.tmp/"unused-candidate"),"--validation-command",first,"--validation-command",second,"--output",str(output),ok=False)
  self.assertIn("candidate_validation_failed: validation_index=2",failed.stderr);receipt=json.loads(output.read_text())
  self.assertEqual("build_failed",receipt["operation"]);self.assertFalse(receipt["eligible"]);self.assertEqual(tip,receipt["candidate_sha"]);self.assertEqual(self.base,git(self.repo,"rev-parse","refs/heads/main"));self.assertEqual(tip,git(task,"rev-parse","HEAD"))
  self.assertEqual({"code":"candidate_validation_failed","validation_index":2,"command_sha256":hashlib.sha256(second.encode()).hexdigest(),"exit_code":7,"timed_out":False},receipt["failure"])
  self.assertEqual([1,2],[item["index"] for item in receipt["validation"]]);self.assertEqual([0,7],[item["exit_code"] for item in receipt["validation"]])
  stdout=Path(receipt["validation"][0]["stdout"]["path"]);stderr=Path(receipt["validation"][1]["stderr"]["path"])
  self.assertEqual("bootstrap-ok\n",stdout.read_text());self.assertEqual("dependency missing\n",stderr.read_text());self.assertEqual(hashlib.sha256(stderr.read_bytes()).hexdigest(),receipt["validation"][1]["stderr"]["sha256"])
 def test_fetch_creation_uses_fetch_head_without_advancing_local_target(self):
  remote=self.tmp/"remote";run("git","clone",str(self.repo),str(remote));git(remote,"config","user.email","test@example.com");git(remote,"config","user.name","Test")
  (remote/"remote-change").write_text("remote\n");git(remote,"add","remote-change");git(remote,"commit","-m","remote");remote_tip=git(remote,"rev-parse","HEAD")
  git(self.repo,"remote","add","fixture",str(remote));wt=self.tmp/"fetched-task";manifest=self.tmp/"fetch-manifest.json"
  run(sys.executable,str(LIFE),"create","--repository",str(self.repo),"--target-ref","refs/heads/main","--fetch","fixture,refs/heads/main","--expected-base",remote_tip,"--path",str(wt),"--branch-ref","refs/heads/task/fetched","--task-id","FETCH","--cleanup-owner","owner","--output",str(manifest))
  self.assertEqual(self.base,git(self.repo,"rev-parse","refs/heads/main"));self.assertEqual(remote_tip,git(wt,"rev-parse","HEAD"));verify=self.tmp/"fetch-verify.json";run(sys.executable,str(LIFE),"verify","--manifest",str(manifest),"--output",str(verify));value=json.loads(verify.read_text());self.assertTrue(value["passed"]);self.assertEqual(self.base,value["actual"]["target_sha"]);self.assertEqual(self.base,json.loads(manifest.read_text())["target_sha_at_create"])

 def test_moved_task_tip_and_empty_validation_are_rejected(self):
  task=self.tmp/"moved-task";git(self.repo,"worktree","add","-b","task/moved",str(task),self.base);git(task,"config","user.email","test@example.com");git(task,"config","user.name","Test")
  (task/"feature").write_text("one\n");git(task,"add","feature");git(task,"commit","-m","one");tip=git(task,"rev-parse","HEAD")
  pre=self.tmp/"moved-pre.json";pre.write_text(json.dumps({"schema_version":"juno_review.v1","review_kind":"pre_merge","passed":True,"reviewed_tip":tip,"open_bugs":[]})+"\n");matrix=self.tmp/"moved-matrix.json";matrix.write_text('{"must":"PASS"}\n');plan=self.tmp/"moved-plan.json"
  run(sys.executable,str(CAND),"plan","--repository",str(self.repo),"--target-ref","refs/heads/main","--base-sha",self.base,"--reviewed-tip",tip,"--task-worktree",str(task),"--task-id","MOVED","--expected-path","feature","--premerge-review",str(pre),"--pdr-matrix",str(matrix),"--output",str(plan))
  missing=run(sys.executable,str(CAND),"build","--plan",str(plan),"--candidate-path",str(self.tmp/"unused"),"--output",str(self.tmp/"missing-validation.json"),ok=False);self.assertNotEqual(0,missing.returncode);self.assertIn("validation-command",missing.stderr)
  (task/"feature").write_text("two\n");git(task,"commit","-am","two")
  moved=run(sys.executable,str(CAND),"build","--plan",str(plan),"--candidate-path",str(self.tmp/"unused2"),"--validation-command","true","--output",str(self.tmp/"moved.json"),ok=False);self.assertNotEqual(0,moved.returncode);self.assertIn("moved_or_dirty_task_tip",moved.stderr)

 def test_target_preflight_and_rebuild_rereview_policy_end_to_end(self):
  task=self.tmp/"preflight-task";git(self.repo,"worktree","add","-b","task/PREFLIGHT",str(task),self.base);git(task,"config","user.email","test@example.com");git(task,"config","user.name","Test")
  exact=self.tmp/"exact-preflight.json";run(sys.executable,str(CAND),"target-preflight","--repository",str(self.repo),"--target-ref","refs/heads/main","--approved-base",self.base,"--output",str(exact));exact_value=json.loads(exact.read_text());self.assertEqual("exact",exact_value["classification"]);self.assertTrue(exact_value["passed"])
  (self.repo/"target").write_text("target\n");git(self.repo,"add","target");git(self.repo,"commit","-m","advance target");advanced=git(self.repo,"rev-parse","HEAD");git(self.repo,"config","extensions.worktreeConfig","true");git(self.repo,"config","--worktree","juno.workspace.roleBase",advanced)
  moved=self.tmp/"advanced-preflight.json";before=git(self.repo,"status","--porcelain=v2","--untracked-files=all");run(sys.executable,str(CAND),"target-preflight","--repository",str(self.repo),"--target-ref","refs/heads/main","--approved-base",self.base,"--output",str(moved));value=json.loads(moved.read_text());self.assertEqual("advanced_descendant",value["classification"]);self.assertEqual(advanced,value["observed_target_sha"]);self.assertEqual(before,git(self.repo,"status","--porcelain=v2","--untracked-files=all"));self.assertEqual(advanced,git(self.repo,"rev-parse","refs/heads/main"))
  (task/"feature").write_text("feature\n");git(task,"add","feature");git(task,"commit","-m","task tip");tip=git(task,"rev-parse","HEAD")
  pre=self.tmp/"policy-pre.json";pre.write_text(json.dumps({"schema_version":"juno_review.v1","review_kind":"pre_merge","passed":True,"reviewed_tip":tip,"open_bugs":[]})+"\n");matrix=self.tmp/"policy-matrix.json";matrix.write_text('{"must":"PASS"}\n');plan=self.tmp/"policy-plan.json"
  run(sys.executable,str(CAND),"plan","--repository",str(self.repo),"--target-ref","refs/heads/main","--base-sha",self.base,"--reviewed-tip",tip,"--task-worktree",str(task),"--task-id","PREFLIGHT","--expected-path","feature","--premerge-review",str(pre),"--pdr-matrix",str(matrix),"--output",str(plan));self.assertEqual("merge_both_parents",json.loads(plan.read_text())["strategy"])
  built=self.tmp/"policy-built.json";candidate_path=self.tmp/"policy-candidate";run(sys.executable,str(CAND),"build","--plan",str(plan),"--candidate-path",str(candidate_path),"--validation-command","git diff --check","--output",str(built));candidate=json.loads(built.read_text())["candidate_sha"];self.assertEqual([advanced,tip],git(candidate_path,"show","-s","--format=%P",candidate).split())
  missing_review=run(sys.executable,str(CAND),"verify","--candidate",str(built),"--output",str(self.tmp/"missing-review.json"),ok=False);self.assertIn("semantic review required",missing_review.stderr)
  review=self.tmp/"policy-review.json";review.write_text(json.dumps({"schema_version":"juno_review.v1","review_kind":"candidate","passed":True,"reviewed_tip":candidate,"open_bugs":[]})+"\n");eligible=self.tmp/"policy-eligible.json";run(sys.executable,str(CAND),"verify","--candidate",str(built),"--candidate-review",str(review),"--output",str(eligible));self.assertEqual("candidate",json.loads(eligible.read_text())["candidate_semantic_review_source"])
  (self.repo/"later").write_text("later\n");git(self.repo,"add","later");git(self.repo,"commit","-m","move after plan");later=git(self.repo,"rev-parse","HEAD");stale=run(sys.executable,str(CAND),"verify","--candidate",str(built),"--candidate-review",str(review),"--output",str(self.tmp/"stale-policy.json"),ok=False);self.assertIn("stale_target_rebuild_review_required",stale.stderr);git(self.repo,"config","--worktree","juno.workspace.roleBase",later)
  missing=self.tmp/"missing-target.json";missing_result=run(sys.executable,str(CAND),"target-preflight","--repository",str(self.repo),"--target-ref","refs/heads/missing","--approved-base",self.base,"--output",str(missing),ok=False);self.assertIn("missing_target",missing_result.stderr);self.assertEqual("missing_target",json.loads(missing.read_text())["classification"])
  divergent=self.tmp/"divergent";git(self.repo,"worktree","add","--detach",str(divergent),self.base);git(divergent,"config","user.email","test@example.com");git(divergent,"config","user.name","Test");(divergent/"fork").write_text("fork\n");git(divergent,"add","fork");git(divergent,"commit","-m","diverge");fork=git(divergent,"rev-parse","HEAD");git(self.repo,"branch","divergent",fork);invalid=self.tmp/"invalid-target.json";invalid_result=run(sys.executable,str(CAND),"target-preflight","--repository",str(self.repo),"--target-ref","refs/heads/divergent","--approved-base",advanced,"--output",str(invalid),ok=False);self.assertIn("invalid_rewind_or_divergence",invalid_result.stderr);self.assertFalse(json.loads(invalid.read_text())["passed"])

 def test_advanced_candidate_preserves_both_parents_without_target_mutation(self):
  candidate,eligible=self.candidate(True);before=json.loads(eligible.read_text())["expected_target_sha"]
  self.assertEqual(before,git(self.repo,"rev-parse","refs/heads/main"));self.assertEqual([before,git(self.repo,"rev-parse","refs/heads/task/T2")],git(self.repo,"show","-s","--format=%P",candidate).split())
  self.assertTrue(json.loads(eligible.read_text())["candidate_bytes_changed_by_composition"])

 def test_direct_candidate_reuses_premerge_review(self):
  candidate,eligible=self.candidate(False);value=json.loads(eligible.read_text());self.assertEqual(candidate,value["reviewed_tip"]);self.assertEqual("pre_merge",value["candidate_semantic_review_source"]);self.assertFalse(value["candidate_bytes_changed_by_composition"])

 def test_same_command_detach_risk_and_tag_policy(self):
  candidate,eligible=self.candidate(False);git(self.repo,"checkout","main");omitted=self.tmp/"omitted-policy.json"
  base_args=[sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","low","--validation-command","true","--task-id","FAST"]
  refused=run(*base_args,"--output",str(omitted),ok=False);self.assertIn("target_ref_checked_out",refused.stderr);self.assertEqual("refs/heads/main",git(self.repo,"symbolic-ref","HEAD"))
  receipt=self.tmp/"fast.json";run(*base_args,"--checked-out-target","detach_same_sha","--output",str(receipt));value=json.loads(receipt.read_text());self.assertEqual(os.environ.get("JUNO_WORKFLOW_STEP_DIGEST",""),value["producer_step_digest"]);self.assertEqual("low",value["declared_risk_tier"]);self.assertEqual("low",value["effective_risk_tier"]);self.assertEqual("not_required_by_effective_tier",value["actual_semantic_review"]);self.assertEqual("skipped_by_policy",value["feature_tag_policy"]["status"]);self.assertEqual("stale_behind_target",value["runtime_identities"][0]["runtime_identity_status"]);self.assertEqual(self.base,git(self.repo,"rev-parse","HEAD"));self.assertEqual(candidate,git(self.repo,"rev-parse","refs/heads/main"))
 def test_detach_failure_before_cas_can_resume_with_runtime_identity(self):
  candidate,eligible=self.candidate(False);git(self.repo,"checkout","main");failed=self.tmp/"detached-before-cas.json"
  args=[sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","low","--checked-out-target","detach_same_sha","--validation-command","true","--task-id","RETRY","--inject-failure-after","0"]
  result=run(*args,"--output",str(failed),ok=False);self.assertIn("injected_update_failure",result.stderr);first=json.loads(failed.read_text());self.assertEqual(os.environ.get("JUNO_WORKFLOW_STEP_DIGEST",""),first["producer_step_digest"]);self.assertEqual("failed_preserved",first["outcome"]);self.assertEqual(self.base,first["runtime_identities"][0]["checkout_sha"])
  resumed=self.tmp/"detached-resumed.json";run(*args[:-2],"--resume-receipt",str(failed),"--output",str(resumed));value=json.loads(resumed.read_text());self.assertEqual(os.environ.get("JUNO_WORKFLOW_STEP_DIGEST",""),value["producer_step_digest"]);self.assertEqual("stale_behind_target",value["runtime_identities"][0]["runtime_identity_status"]);self.assertEqual(candidate,git(self.repo,"rev-parse","refs/heads/main"))

 def test_low_explicit_tag_and_composition_escalation(self):
  candidate,eligible=self.candidate(False);receipt=self.tmp/"low-tag.json"
  run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","low","--feature-tag","--validation-command","true","--task-id","LOWTAG","--output",str(receipt))
  value=json.loads(receipt.read_text());self.assertTrue(value["feature_tag_policy"]["created"]);self.assertFalse(value["feature_tag_policy"]["required"])

 def test_composed_low_escalates_high_and_requires_actual_semantic_review(self):
  candidate,eligible=self.candidate(True);expected=json.loads(eligible.read_text())["expected_target_sha"];output=self.tmp/"escalated.json"
  refused=run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{expected},{candidate}","--candidate-receipt",str(eligible),"--risk-tier","low","--validation-command","true","--task-id","ESCALATE","--output",str(output),ok=False)
  value=json.loads(output.read_text());self.assertEqual("high",value["effective_risk_tier"]);self.assertIn("composed_candidate",value["risk_escalation_reasons"]);self.assertIn("semantic review required",refused.stderr);self.assertEqual(expected,git(self.repo,"rev-parse","refs/heads/main"))

 def test_same_channel_attempts_serialize_and_second_fails_stale(self):
  candidate,eligible=self.candidate(False);(self.repo/"controller-dirt").write_text("active controller\n");actual1=self.tmp/"actual1.json";actual2=self.tmp/"actual2.json"
  command1=self.actual_review_command(actual1,candidate,1)
  args=[sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--validation-command","true","--actual-review-command",command1,"--actual-review-receipt",str(actual1),"--task-id","T2","--output",str(self.tmp/"first.json")]
  first=subprocess.Popen(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE);import time;time.sleep(.2)
  second=run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--validation-command","true","--actual-review-command",self.actual_review_command(actual2,candidate),"--actual-review-receipt",str(actual2),"--task-id","T2","--output",str(self.tmp/"second.json"),ok=False)
  first_stdout,first_stderr=first.communicate();self.assertEqual(0,first.returncode,(first_stdout,first_stderr));self.assertNotEqual(0,second.returncode);self.assertIn("stale_target",second.stderr)

 def test_multi_repository_late_failure_reports_partial_without_tag_or_rewind(self):
  repositories=[];receipts=[]
  for name in ("child","root2"):
   repo=self.tmp/name;run("git","init",str(repo));git(repo,"config","user.email","test@example.com");git(repo,"config","user.name","Test");(repo/"base").write_text("base\n");git(repo,"add","base");git(repo,"commit","-m","base");git(repo,"branch","-M","main");base=git(repo,"rev-parse","HEAD")
   wt=self.tmp/(name+"-candidate");git(repo,"worktree","add","-b",name+"-task",str(wt),base);git(wt,"config","user.email","test@example.com");git(wt,"config","user.name","Test");(wt/"feature").write_text("feature\n");git(wt,"add","feature");git(wt,"commit","-m","feature");tip=git(wt,"rev-parse","HEAD")
   receipt=self.tmp/(name+"-eligible.json");receipt.write_text(json.dumps({"schema_version":"juno_integration_candidate.v2","operation":"verify","eligible":True,"repository":str(repo),"target_ref":"refs/heads/main","expected_target_sha":base,"candidate_sha":tip,"candidate_path":str(wt),"validation":[{"exit_code":0}],"pdr_matrix":{"must":"PASS"},"premerge_review_sha256":"a"*64,"candidate_review_sha256":"b"*64,"candidate_receipt_sha256":"c"*64,"candidate_semantic_review_source":"pre_merge","candidate_bytes_changed_by_composition":False})+"\n")
   git(repo,"checkout","--detach",base);repositories.append((name,repo,base,tip));receipts.append(receipt)
  output=self.tmp/"partial.json";args=[sys.executable,str(INTEGRATE),"integrate"]
  for (name,repo,base,tip),receipt in zip(repositories,receipts):args += ["--repository",f"{name}={repo},refs/heads/main,{base},{tip}","--candidate-receipt",str(receipt)]
  args += ["--validation-command","true","--actual-review-command","false","--actual-review-receipt",str(self.tmp/"unused.json"),"--task-id","MULTI","--inject-failure-after","1","--output",str(output)]
  result=run(*args,ok=False);self.assertNotEqual(0,result.returncode);value=json.loads(output.read_text());self.assertEqual(os.environ.get("JUNO_WORKFLOW_STEP_DIGEST",""),value["producer_step_digest"]);self.assertEqual("partial_local_integration",value["outcome"])
  self.assertEqual("target_updates",value["resume_stage"]);self.assertEqual(["child"],[item["name"] for item in value["updates"]])
  self.assertEqual(repositories[0][3],git(repositories[0][1],"rev-parse","refs/heads/main"));self.assertEqual(repositories[1][2],git(repositories[1][1],"rev-parse","refs/heads/main"));self.assertEqual("",git(repositories[0][1],"tag","--list","juno-feature/*"))
  crash_receipt=self.tmp/"partial-crash-window.json";crash_value=json.loads(json.dumps(value));crash_value["outcome"]="running";crash_value["updates"][0].update({"status":"attempting","after_sha":None});crash_receipt.write_text(json.dumps(crash_value)+"\n")
  actual=self.tmp/"partial-retry-actual.json";root_tip=repositories[-1][3]
  retry_args=[sys.executable,str(INTEGRATE),"integrate"]
  for (name,repo,base,tip),candidate_receipt in zip(repositories,receipts):retry_args += ["--repository",f"{name}={repo},refs/heads/main,{base},{tip}","--candidate-receipt",str(candidate_receipt)]
  retry_output=self.tmp/"partial-retry.json";retry_args += ["--resume-receipt",str(crash_receipt),"--validation-command","true","--actual-review-command",self.actual_review_command(actual,root_tip),"--actual-review-receipt",str(actual),"--task-id","MULTI","--output",str(retry_output)]
  run(*retry_args);retry_value=json.loads(retry_output.read_text());self.assertEqual(os.environ.get("JUNO_WORKFLOW_STEP_DIGEST",""),retry_value["producer_step_digest"]);self.assertEqual("integrated",retry_value["outcome"]);self.assertEqual("resumed_already_moved",retry_value["updates"][0]["status"])
  self.assertEqual(repositories[0][3],git(repositories[0][1],"rev-parse","refs/heads/main"));self.assertEqual(repositories[1][3],git(repositories[1][1],"rev-parse","refs/heads/main"))

 def test_cas_actual_review_feature_tag_and_stale_refusal(self):
  candidate,eligible=self.candidate(False);(self.repo/"controller-dirt").write_text("active controller\n");actual=self.tmp/"actual.json";command=self.actual_review_command(actual,candidate)
  receipt=self.tmp/"integration.json"
  run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--validation-command","true","--actual-review-command",command,"--actual-review-receipt",str(actual),"--task-id","T2","--output",str(receipt))
  value=json.loads(receipt.read_text());self.assertEqual(os.environ.get("JUNO_WORKFLOW_STEP_DIGEST",""),value["producer_step_digest"]);self.assertEqual("integrated",value["outcome"]);self.assertTrue(value["feature_tag"].startswith("juno-feature/T2/"))
  stale=self.tmp/"stale.json";r=run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{self.base},{candidate}","--candidate-receipt",str(eligible),"--validation-command","true","--actual-review-command",command,"--actual-review-receipt",str(actual),"--task-id","T2","--output",str(stale),ok=False)
  self.assertNotEqual(0,r.returncode);self.assertIn("stale_target",r.stderr);self.assertEqual(candidate,git(self.repo,"rev-parse","refs/heads/main"))
  cleanup=self.tmp/"cleanup.json";task=self.tmp/"task"
  run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/T2","--expected-head",candidate,"--delete-branch","--output",str(cleanup))
  self.assertTrue(json.loads(cleanup.read_text())["removed"]);self.assertFalse(task.exists())
  retry=self.tmp/"cleanup-retry.json";run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/T2","--expected-head",candidate,"--delete-branch","--output",str(retry))
  self.assertTrue(json.loads(retry.read_text())["already_removed"])

 def test_gitlink_mismatch_refuses_before_any_target_mutation(self):
  candidate,eligible=self.candidate(False);before=git(self.repo,"rev-parse","refs/heads/main");actual=self.tmp/"gitlink-actual.json"
  result=run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{before},{candidate}","--candidate-receipt",str(eligible),"--gitlink","missing=child","--validation-command","true","--actual-review-command","true","--actual-review-receipt",str(actual),"--task-id","T2","--output",str(self.tmp/"gitlink-fail.json"),ok=False)
  self.assertNotEqual(0,result.returncode);self.assertIn("unknown child gitlink",result.stderr);self.assertEqual(before,git(self.repo,"rev-parse","refs/heads/main"))

 def test_candidate_receipt_repository_mismatch_refuses_before_mutation(self):
  candidate,eligible=self.candidate(False);before=git(self.repo,"rev-parse","refs/heads/main");payload=json.loads(eligible.read_text());payload["repository"]=str(self.tmp/"wrong-repository");eligible.write_text(json.dumps(payload)+"\n")
  result=run(sys.executable,str(INTEGRATE),"integrate","--repository",f"root={self.repo},refs/heads/main,{before},{candidate}","--candidate-receipt",str(eligible),"--validation-command","true","--actual-review-command","true","--actual-review-receipt",str(self.tmp/"unused-review.json"),"--task-id","T2","--output",str(self.tmp/"repository-mismatch.json"),ok=False)
  self.assertNotEqual(0,result.returncode);self.assertIn("candidate receipt repository mismatch",result.stderr);self.assertEqual(before,git(self.repo,"rev-parse","refs/heads/main"))

 def test_creation_and_cleanup_refusals_preserve_unsafe_state(self):
  missing=run(sys.executable,str(LIFE),"create","--repository",str(self.repo),"--target-ref","refs/heads/missing","--path",str(self.tmp/"missing"),"--branch-ref","refs/heads/task/missing","--task-id","MISS","--cleanup-owner","owner","--output",str(self.tmp/"missing.json"),ok=False);self.assertNotEqual(0,missing.returncode)
  collision=self.tmp/"collision";collision.mkdir();blocked=run(sys.executable,str(LIFE),"create","--repository",str(self.repo),"--target-ref","refs/heads/main","--expected-base",self.base,"--path",str(collision),"--branch-ref","refs/heads/task/collision","--task-id","COLLIDE","--cleanup-owner","owner","--output",str(self.tmp/"collision.json"),ok=False);self.assertIn("path_collision",blocked.stderr)
  task=self.tmp/"unsafe";git(self.repo,"worktree","add","-b","task/unsafe",str(task),self.base);(task/"dirty").write_text("dirty\n")
  refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/unsafe","--expected-head",self.base,"--output",str(self.tmp/"dirty-cleanup.json"),ok=False);self.assertIn("dirty",refused.stderr);self.assertTrue(task.exists())

 def test_deinitialized_submodule_admin_cleanup_is_reachability_safe(self):
  sub=self.tmp/"submodule-source";run("git","init",str(sub));git(sub,"config","user.email","test@example.com");git(sub,"config","user.name","Test");(sub/"f").write_text("sub\n");git(sub,"add","f");git(sub,"commit","-m","sub");sub_tip=git(sub,"rev-parse","HEAD")
  git(self.repo,"-c","protocol.file.allow=always","submodule","add",str(sub),"child");git(self.repo,"commit","-am","add submodule");target=git(self.repo,"rev-parse","HEAD")
  release=self.tmp/"initialized-target-release.json";run(sys.executable,str(LIFE),"release-target","--repository",str(self.repo),"--path",str(self.repo),"--target-ref","refs/heads/main","--expected-head",target,"--disposition","detach_same_sha","--task-id","RELEASE","--owner","integration-owner","--output",str(release));self.assertEqual("detached_same_sha",json.loads(release.read_text())["outcome"])
  task=self.tmp/"submodule-task";git(self.repo,"worktree","add","-b","task/submodule-cleanup",str(task),target);run("git","-C",str(task),"-c","protocol.file.allow=always","submodule","update","--init")
  initialized=self.tmp/"initialized-cleanup.json";refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/submodule-cleanup","--expected-head",target,"--output",str(initialized),ok=False)
  self.assertIn("nested_repository_initialized",refused.stderr);self.assertTrue(task.exists())
  git(task,"submodule","deinit","-f","child");worktree_git_dir=Path(git(task,"rev-parse","--absolute-git-dir"));stale_admin=worktree_git_dir/"modules"/"child";approved=self.repo/"child";approved_git_dir=Path(git(approved,"rev-parse","--absolute-git-dir"))
  self.assertTrue(stale_admin.is_dir());self.assertTrue(approved_git_dir.is_dir());self.assertEqual(sub_tip,git(task,"rev-parse",f"{target}:child"))
  escaped=self.tmp/"escaped-admin";stale_admin.rename(escaped);stale_admin.symlink_to(escaped,target_is_directory=True);escape_receipt=self.tmp/"escaped-approval.json"
  refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/submodule-cleanup","--expected-head",target,"--deinitialized-submodule",f"child={approved}","--output",str(escape_receipt),ok=False)
  self.assertIn("deinitialized_submodule_admin_symlink_or_escape",refused.stderr);self.assertTrue(escaped.exists());stale_admin.unlink();escaped.rename(stale_admin)
  missing=self.tmp/"missing-approval.json";refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/submodule-cleanup","--expected-head",target,"--output",str(missing),ok=False)
  self.assertIn("deinitialized_submodule_admin_requires_approval",refused.stderr);self.assertTrue(stale_admin.exists())
  wrong_approved=self.tmp/"wrong-approved";run("git","init",str(wrong_approved));git(wrong_approved,"config","user.email","test@example.com");git(wrong_approved,"config","user.name","Test");(wrong_approved/"f").write_text("wrong\n");git(wrong_approved,"add","f");git(wrong_approved,"commit","-m","wrong")
  wrong=self.tmp/"wrong-approval.json";refused=run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/submodule-cleanup","--expected-head",target,"--deinitialized-submodule",f"child={wrong_approved}","--output",str(wrong),ok=False)
  self.assertIn("gitlink_unreachable_from_approved_repository",refused.stderr);self.assertTrue(stale_admin.exists())
  git(approved,"checkout","--detach",sub_tip)
  for ref in git(approved,"for-each-ref","--format=%(refname)").splitlines(): git(approved,"update-ref","-d",ref)
  self.assertEqual("",git(approved,"for-each-ref","--contains",sub_tip,"--format=%(refname)"));self.assertEqual(sub_tip,git(approved,"rev-parse","HEAD"))
  receipt=self.tmp/"deinitialized-cleanup.json";run(sys.executable,str(LIFE),"cleanup","--repository",str(self.repo),"--path",str(task),"--target-ref","refs/heads/main","--branch-ref","refs/heads/task/submodule-cleanup","--expected-head",target,"--delete-branch","--deinitialized-submodule",f"child={approved}","--output",str(receipt))
  value=json.loads(receipt.read_text());self.assertTrue(value["passed"]);self.assertEqual(["child"],[item["path"] for item in value["deinitialized_submodules"]]);self.assertEqual(["HEAD"],value["deinitialized_submodules"][0]["containing_refs"]);self.assertFalse(task.exists());self.assertTrue(approved_git_dir.exists());self.assertEqual(sub_tip,git(approved,"rev-parse",sub_tip));self.assertEqual("",run("git","-C",str(self.repo),"rev-parse","--verify","refs/heads/task/submodule-cleanup",ok=False).stdout.strip())
  self.assertNotIn('"--force"',LIFE.read_text())

 def test_candidate_unexpected_path_and_merge_conflict_refuse_without_target_mutation(self):
  task=self.tmp/"conflict-task";git(self.repo,"worktree","add","-b","task/conflict",str(task),self.base);git(task,"config","user.email","test@example.com");git(task,"config","user.name","Test")
  (task/"base").write_text("task\n");git(task,"commit","-am","task conflict");tip=git(task,"rev-parse","HEAD");pre=self.tmp/"conflict-pre.json";pre.write_text(json.dumps({"schema_version":"juno_review.v1","review_kind":"pre_merge","passed":True,"reviewed_tip":tip,"open_bugs":[]})+"\n");matrix=self.tmp/"conflict-matrix.json";matrix.write_text('{"must":"PASS"}\n')
  unexpected=run(sys.executable,str(CAND),"plan","--repository",str(self.repo),"--target-ref","refs/heads/main","--base-sha",self.base,"--reviewed-tip",tip,"--task-worktree",str(task),"--task-id","CONFLICT","--expected-path","other","--premerge-review",str(pre),"--pdr-matrix",str(matrix),"--output",str(self.tmp/"unexpected.json"),ok=False);self.assertIn("unexpected task paths",unexpected.stderr)
  (self.repo/"base").write_text("target\n");git(self.repo,"commit","-am","target conflict");target=git(self.repo,"rev-parse","HEAD");git(self.repo,"config","extensions.worktreeConfig","true");git(self.repo,"config","--worktree","juno.workspace.roleBase",target);plan=self.tmp/"conflict-plan.json"
  run(sys.executable,str(CAND),"plan","--repository",str(self.repo),"--target-ref","refs/heads/main","--base-sha",self.base,"--reviewed-tip",tip,"--task-worktree",str(task),"--task-id","CONFLICT","--expected-path","base","--premerge-review",str(pre),"--pdr-matrix",str(matrix),"--output",str(plan))
  failed=run(sys.executable,str(CAND),"build","--plan",str(plan),"--candidate-path",str(self.tmp/"conflicted-candidate"),"--validation-command","true","--output",str(self.tmp/"conflicted.json"),ok=False);self.assertIn("candidate_merge_conflict",failed.stderr);self.assertEqual(target,git(self.repo,"rev-parse","refs/heads/main"))

 def test_nested_gitlink_success_updates_child_before_root(self):
  child=self.tmp/"nested-child";run("git","init",str(child));git(child,"config","user.email","test@example.com");git(child,"config","user.name","Test");(child/"f").write_text("base\n");git(child,"add","f");git(child,"commit","-m","base");git(child,"branch","-M","main");child_base=git(child,"rev-parse","HEAD")
  child_wt=self.tmp/"nested-child-candidate";git(child,"worktree","add","-b","child-task",str(child_wt),child_base);git(child_wt,"config","user.email","test@example.com");git(child_wt,"config","user.name","Test");(child_wt/"f").write_text("tip\n");git(child_wt,"commit","-am","tip");child_tip=git(child_wt,"rev-parse","HEAD")
  root=self.tmp/"nested-root";run("git","init",str(root));git(root,"config","user.email","test@example.com");git(root,"config","user.name","Test");(root/"root").write_text("root\n");git(root,"add","root");git(root,"commit","-m","root");git(root,"update-index","--add","--cacheinfo",f"160000,{child_base},child");git(root,"commit","-m","child base");git(root,"branch","-M","main");root_base=git(root,"rev-parse","HEAD")
  root_wt=self.tmp/"nested-root-candidate";git(root,"worktree","add","-b","root-task",str(root_wt),root_base);git(root_wt,"config","user.email","test@example.com");git(root_wt,"config","user.name","Test");git(root_wt,"update-index","--cacheinfo",f"160000,{child_tip},child");git(root_wt,"commit","-m","child tip");root_tip=git(root_wt,"rev-parse","HEAD")
  def eligible(name,repo,base,tip,wt):
   path=self.tmp/(name+"-nested.json");path.write_text(json.dumps({"schema_version":"juno_integration_candidate.v2","operation":"verify","eligible":True,"repository":str(repo),"target_ref":"refs/heads/main","expected_target_sha":base,"candidate_sha":tip,"candidate_path":str(wt),"validation":[{"exit_code":0}],"pdr_matrix":{"must":"PASS"},"premerge_review_sha256":"a"*64,"candidate_review_sha256":"b"*64,"candidate_receipt_sha256":"c"*64,"candidate_semantic_review_source":"pre_merge","candidate_bytes_changed_by_composition":False})+"\n");return path
  child_receipt=eligible("child",child,child_base,child_tip,child_wt);root_receipt=eligible("root",root,root_base,root_tip,root_wt);git(child,"checkout","--detach",child_base);git(root,"checkout","--detach",root_base)
  actual=self.tmp/"nested-actual.json";command=self.actual_review_command(actual,root_tip)
  run(sys.executable,str(INTEGRATE),"integrate","--repository",f"child={child},refs/heads/main,{child_base},{child_tip}","--candidate-receipt",str(child_receipt),"--repository",f"root={root},refs/heads/main,{root_base},{root_tip}","--candidate-receipt",str(root_receipt),"--gitlink","child=child","--validation-command","true","--actual-review-command",command,"--actual-review-receipt",str(actual),"--task-id","NESTED","--output",str(self.tmp/"nested-integration.json"))
  self.assertEqual(child_tip,git(child,"rev-parse","refs/heads/main"));self.assertEqual(root_tip,git(root,"rev-parse","refs/heads/main"));self.assertIn(child_tip,git(root,"ls-tree",root_tip,"--","child"))

 def test_controller_nested_owner_detaches_in_same_command_and_preserves_parent_gitlink(self):
  source=self.tmp/"controller-child-source";run("git","init",str(source));git(source,"config","user.email","test@example.com");git(source,"config","user.name","Test");(source/"f").write_text("base\n");git(source,"add","f");git(source,"commit","-m","base")
  controller=self.tmp/"nested-controller";run("git","init",str(controller));git(controller,"config","user.email","test@example.com");git(controller,"config","user.name","Test");(controller/"root").write_text("root\n");git(controller,"add","root");git(controller,"commit","-m","root");git(controller,"-c","protocol.file.allow=always","submodule","add",str(source),"child");git(controller,"commit","-am","child");controller_head=git(controller,"rev-parse","HEAD")
  child=controller/"child";git(child,"branch","-M","main");base=git(child,"rev-parse","HEAD");candidate_path=self.tmp/"nested-owner-candidate";git(child,"worktree","add","-b","task/nested-owner",str(candidate_path),base);git(candidate_path,"config","user.email","test@example.com");git(candidate_path,"config","user.name","Test");(candidate_path/"f").write_text("tip\n");git(candidate_path,"commit","-am","tip");tip=git(candidate_path,"rev-parse","HEAD")
  eligible=self.tmp/"nested-owner-eligible.json";eligible.write_text(json.dumps({"schema_version":"juno_integration_candidate.v2","operation":"verify","eligible":True,"repository":str(child.resolve()),"target_ref":"refs/heads/main","expected_target_sha":base,"candidate_sha":tip,"candidate_path":str(candidate_path),"validation":[{"exit_code":0}],"pdr_matrix":{"must":"PASS"},"premerge_review_sha256":"a"*64,"candidate_review_sha256":"b"*64,"candidate_receipt_sha256":"c"*64,"candidate_semantic_review_source":"pre_merge","candidate_bytes_changed_by_composition":False})+"\n")
  actual=self.tmp/"nested-owner-actual.json";command=self.actual_review_command(actual,tip)
  output=self.tmp/"nested-owner-integration.json";run(sys.executable,str(INTEGRATE),"integrate","--repository",f"child={child},refs/heads/main,{base},{tip}","--candidate-receipt",str(eligible),"--controller-checkout",str(controller),"--checked-out-target","detach_same_sha","--validation-command","true","--actual-review-command",command,"--actual-review-receipt",str(actual),"--task-id","NESTEDOWNER","--output",str(output))
  value=json.loads(output.read_text());self.assertEqual("controller_nested_integration_owner",value["topology"][0]["classification"]);self.assertEqual(tip,git(child,"rev-parse","refs/heads/main"));self.assertEqual(base,git(child,"rev-parse","HEAD"));self.assertEqual("",run("git","-C",str(child),"symbolic-ref","-q","HEAD",ok=False).stdout.strip());self.assertEqual("",git(controller,"status","--short","--","child"));self.assertEqual(controller_head,git(controller,"rev-parse","HEAD"))
  import importlib.util
  spec=importlib.util.spec_from_file_location("nested_runtime",INTEGRATE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  auxiliary=module.verify_nested_owners([{"name":"aux","path":source.resolve(),"target_ref":"refs/heads/master","expected_sha":base,"candidate_sha":tip}],controller)
  self.assertEqual("auxiliary_integration_owner",auxiliary[0]["classification"])

 def test_feature_tag_is_idempotent_and_collision_safe(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location("integration_runtime",INTEGRATE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  name=module.tag(self.repo,"TAG",self.base,"refs/heads/main","a"*64,"b"*64);self.assertEqual(name,module.tag(self.repo,"TAG",self.base,"refs/heads/main","a"*64,"b"*64))
  git(self.repo,"tag","-d",name);git(self.repo,"tag","-a",name,self.base,"-m","different")
  with self.assertRaises(module.IntegrationError):module.tag(self.repo,"TAG",self.base,"refs/heads/main","a"*64,"b"*64)
if __name__=="__main__":unittest.main()
