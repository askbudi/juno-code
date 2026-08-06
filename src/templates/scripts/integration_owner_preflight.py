#!/usr/bin/env python3
"""Receipt-gated, target-ref-scoped local integration with exact CAS updates."""
from __future__ import annotations
import argparse, datetime, fcntl, hashlib, json, os, re, shlex, subprocess, sys, tempfile, time
from pathlib import Path
from typing import Any
sys.path.insert(0, str(Path(__file__).resolve().parent))
import worktree_lifecycle as lifecycle
import controller_checkpoint
SCHEMA="juno_local_integration.v3"; TAG_RE=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
RISK_ORDER={"low":0,"medium":1,"high":2,"release":3}
class IntegrationError(Exception):pass

def run(repo:Path,*args:str,check:bool=True,env:dict[str,str]|None=None)->subprocess.CompletedProcess[str]:
 r=subprocess.run(["git","-C",str(repo),*args],text=True,capture_output=True,stdin=subprocess.DEVNULL,env=env or {**os.environ,"GIT_OPTIONAL_LOCKS":"0"})
 if check and r.returncode:raise IntegrationError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
 return r
def git(repo:Path,*args:str,check:bool=True)->str:return run(repo,*args,check=check).stdout.strip()
def sha(path:Path)->str:return hashlib.sha256(path.read_bytes()).hexdigest()
def require_committed_tree(repo:Path,fallback_base:str)->dict[str,Any]:
 try:return controller_checkpoint.committed_admission(repo,fallback_base,protected_role_override="integration-owner")
 except controller_checkpoint.CheckpointError as exc:raise IntegrationError(f"committed-tree admission refused: {exc}") from exc
def advance_protected_role_base(repo:Path,integrated_sha:str,*,inject_failure:bool=False)->dict[str,Any]:
 if not (repo/".juno_task").is_dir():return {"role":"unmanaged", "advanced":False,"registered":False}
 actual=git(repo,"rev-parse",f"{integrated_sha}^{{commit}}")
 if actual!=integrated_sha:raise IntegrationError("protected roleBase candidate identity mismatch")
 persisted=git(repo,"config","--worktree","--get","juno.workspace.role",check=False) or None
 authority=git(repo,"config","--worktree","--get","juno.workspace.roleAuthority",check=False) or None
 git_dir=Path(git(repo,"rev-parse","--path-format=absolute","--git-dir")).resolve()
 common_dir=common(repo)
 if persisted not in {None,"integration-owner"}:raise IntegrationError(f"protected integration refuses persisted workspace role: {persisted}")
 if persisted=="integration-owner" and authority!="protected-integration.v1":raise IntegrationError("integration-owner lacks protected integration authority")
 if persisted is None and git_dir==common_dir:return {"role":"controller","advanced":False,"registered":False}
 if inject_failure:raise IntegrationError("injected_authority_persistence_failure")
 run(repo,"config","--local","extensions.worktreeConfig","true")
 for key in ("taskId","manifestIdentity","createReceiptSha256","verifyReceiptSha256","expectedPathsSha256","eligibleReceiptSha256"):
  run(repo,"config","--worktree","--unset-all",f"juno.workspace.{key}",check=False)
 run(repo,"config","--worktree","juno.workspace.role","integration-owner")
 run(repo,"config","--worktree","juno.workspace.roleAuthority","protected-integration.v1")
 run(repo,"config","--worktree","juno.workspace.roleBase",actual)
 if (git(repo,"config","--worktree","--get","juno.workspace.role")!="integration-owner"
     or git(repo,"config","--worktree","--get","juno.workspace.roleAuthority")!="protected-integration.v1"
     or git(repo,"config","--worktree","--get","juno.workspace.roleBase")!=actual):raise IntegrationError("protected roleBase update failed")
 return {"role":"integration-owner","advanced":True,"registered":persisted is None,"role_base":actual,"authority":"protected-integration.v1"}
def full_ref(v:str)->str:
 if not v.startswith("refs/heads/"):raise IntegrationError("integration target must be a full refs/heads/... name")
 return v

def parse_repo(v:str)->dict[str,Any]:
 name,separator,remainder=v.partition("=")
 parts=remainder.rsplit(",",3)
 if not separator or len(parts)!=4 or not all([name,*parts]):raise argparse.ArgumentTypeError("repository must be NAME=PATH,TARGET_REF,EXPECTED_SHA,CANDIDATE_SHA")
 return {"name":name,"path":Path(parts[0]).resolve(),"target_ref":full_ref(parts[1]),"expected_sha":parts[2],"candidate_sha":parts[3]}
def parse_gitlink(v:str)->tuple[str,str]:
 name,separator,path=v.partition("=")
 if not separator or not name or not path or Path(path).is_absolute() or ".." in Path(path).parts:raise argparse.ArgumentTypeError("gitlink must be CHILD_REPOSITORY_NAME=ROOT_RELATIVE_PATH")
 return name,path
def parse_named_receipt(v:str)->tuple[str,Path]:
 name,separator,receipt=v.partition("=")
 if not separator or not name or not receipt:raise argparse.ArgumentTypeError("nested owner receipt must be REPOSITORY_NAME=RECEIPT_PATH")
 return name,Path(receipt).resolve()
def common(repo:Path)->Path:return Path(git(repo,"rev-parse","--path-format=absolute","--git-common-dir")).resolve()
def lock_key(item:dict[str,Any])->str:
 raw=f"{common(item['path'])}\0{item['target_ref']}";return hashlib.sha256(raw.encode()).hexdigest()
def lock_file(item:dict[str,Any])->Path:return common(item["path"])/"juno-integration-channels"/(lock_key(item)+".lock")
def index_lock(repo:Path)->Path:return Path(git(repo,"rev-parse","--path-format=absolute","--git-path","index.lock")).resolve()
def acquire_bounded(handle:Any,timeout:float)->None:
 deadline=time.monotonic()+timeout
 while True:
  try:fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB);return
  except BlockingIOError:
   if time.monotonic()>=deadline:raise IntegrationError("integration channel lock timeout")
   time.sleep(min(0.05,max(0.0,deadline-time.monotonic())))
def write(path:Path,payload:dict[str,Any],*,replace:bool=False)->None:
 encoded=json.dumps(payload,indent=2,sort_keys=True)+"\n";path=path.resolve();path.parent.mkdir(parents=True,exist_ok=True)
 if path.exists() and not replace and path.read_text()!=encoded:raise IntegrationError(f"immutable receipt collision: {path}")
 temporary=path.with_name(f".{path.name}.tmp-{os.getpid()}");temporary.write_text(encoded);temporary.replace(path)
def verify_target_channel_planning(value:dict[str,Any],item:dict[str,Any])->None:
 planning=value.get("target_channel_planning")
 if not isinstance(planning,dict) or planning.get("intent")!="target_channel_owner":return
 repo=item["path"]
 expected={"repository":str(repo),"git_common_dir":str(common(repo)),
           "git_dir":str(Path(git(repo,"rev-parse","--path-format=absolute","--git-dir")).resolve()),
           "head":git(repo,"rev-parse","HEAD"),"base_sha":value.get("base_sha")}
 for field,actual in expected.items():
  if planning.get(field)!=actual:raise IntegrationError(f"candidate target-channel owner {field} mismatch")
 if planning.get("read_only") is not True or planning.get("role_persisted_by_planning") is not False:
  raise IntegrationError("candidate target-channel planning authority contract invalid")
 if git(repo,"status","--porcelain=v2","--untracked-files=all"):
  raise IntegrationError("candidate target-channel owner is no longer clean")

def load_candidate(path:Path,repositories:list[dict[str,Any]])->dict[str,Any]:
 value=json.loads(path.read_text());
 if value.get("schema_version")!="juno_integration_candidate.v2" or value.get("operation")!="verify" or value.get("eligible") is not True:raise IntegrationError("eligible verified candidate receipt required")
 validations=value.get("validation");matrix=value.get("pdr_matrix")
 if not isinstance(validations,list) or not validations or any(item.get("exit_code")!=0 for item in validations):raise IntegrationError("successful candidate validation evidence required")
 if not isinstance(matrix,dict) or not matrix or any(result!="PASS" for result in matrix.values()):raise IntegrationError("candidate PDR matrix PASS required")
 for field in ("premerge_review_sha256","candidate_review_sha256","candidate_receipt_sha256"):
  if not re.fullmatch(r"[0-9a-f]{64}",str(value.get(field) or "")):raise IntegrationError(f"candidate receipt missing {field}")
 source=value.get("candidate_semantic_review_source")
 if source not in {"pre_merge","candidate"}:raise IntegrationError("candidate semantic review source missing")
 if value.get("candidate_bytes_changed_by_composition") is True and source != "candidate":raise IntegrationError("composed candidate review required")
 if len(repositories)==1:
  item=repositories[0]
  if Path(str(value.get("repository") or "")).resolve()!=item["path"]:raise IntegrationError("candidate receipt repository mismatch")
  for field,expected in (("target_ref",item["target_ref"]),("expected_target_sha",item["expected_sha"]),("candidate_sha",item["candidate_sha"])):
   if value.get(field)!=expected:raise IntegrationError(f"candidate receipt {field} mismatch")
  verify_target_channel_planning(value,item)
 candidate_path=value.get("candidate_path")
 if run(Path(value["repository"]),"merge-base","--is-ancestor",value["expected_target_sha"],value["candidate_sha"],check=False).returncode:raise IntegrationError("candidate does not descend from expected target")
 if not candidate_path or git(Path(candidate_path),"rev-parse","HEAD")!=value.get("candidate_sha") or git(Path(candidate_path),"status","--porcelain=v2","--untracked-files=all"):
  raise IntegrationError("candidate worktree is missing, moved, or dirty")
 if index_lock(Path(candidate_path)).exists():raise IntegrationError("candidate index lock present")
 return value
def verify_gitlinks(repositories:list[dict[str,Any]],gitlinks:list[tuple[str,str]])->None:
 if not gitlinks:return
 by_name={item["name"]:item for item in repositories};root=repositories[-1]
 if len(by_name)!=len(repositories):raise IntegrationError("repository names must be unique")
 for child,path in gitlinks:
  if child not in by_name or child==root["name"]:raise IntegrationError(f"unknown child gitlink repository: {child}")
  entry=git(root["path"],"ls-tree",root["candidate_sha"],"--",path)
  fields=entry.split(None,3)
  if len(fields)<3 or fields[0]!="160000" or fields[2]!=by_name[child]["candidate_sha"]:raise IntegrationError(f"root_gitlink_mismatch child={child} path={path}")

def verify_nested_owners(repositories:list[dict[str,Any]],controller:Path|None,restore_policy:str|None=None,allow_restored_transition:bool=False)->list[dict[str,Any]]:
 if controller is None:return []
 controller=controller.resolve();controller_root=Path(git(controller,"rev-parse","--show-toplevel")).resolve()
 if controller_root!=controller:raise IntegrationError("controller checkout must be its exact Git root")
 evidence=[]
 for index,item in enumerate(repositories):
  try:relative=item["path"].relative_to(controller_root)
  except ValueError:
   evidence.append({"name":item["name"],"classification":"auxiliary_integration_owner","path":str(item["path"])});continue
  if not relative.parts:
   if restore_policy!="exact_integrated" or index!=len(repositories)-1:
    raise IntegrationError("controller checkout cannot be an integration owner without --restore-controller-checkout exact_integrated")
   evidence.append({"name":item["name"],"classification":"controller_root_target_owner","controller_root":str(controller_root),"controller_head":git(controller_root,"rev-parse","HEAD"),"target_ref":item["target_ref"],"expected_sha":item["expected_sha"],"path":str(item["path"])});continue
  fields=git(controller_root,"ls-tree","HEAD","--",relative.as_posix()).split(None,3)
  if len(fields)<3 or fields[0]!="160000":raise IntegrationError(f"controller_nested_owner_not_gitlink name={item['name']}")
  if fields[2]!=item["expected_sha"]:raise IntegrationError("controller nested gitlink SHA mismatch")
  path_status=git(controller_root,"status","--porcelain=v2","--untracked-files=all","--",relative.as_posix())
  transitional=allow_restored_transition and git(item["path"],"rev-parse","HEAD")==item["candidate_sha"] and not git(item["path"],"symbolic-ref","-q","HEAD",check=False)
  if path_status and not transitional:raise IntegrationError("controller nested gitlink is dirty")
  evidence.append({"name":item["name"],"classification":"controller_nested_integration_owner","controller_root":str(controller_root),"controller_head":git(controller_root,"rev-parse","HEAD"),"gitlink_path":relative.as_posix(),"gitlink_sha":fields[2],"gitlink_clean":not bool(path_status),"restored_transition":transitional,"path":str(item["path"])})
 return evidence

def validate_item(item:dict[str,Any],expected_current_sha:str|None=None,checked_policy:str|None=None,*,allow_post_detach_ambiguity:bool=False)->dict[str,Any]:
 repo=item["path"]
 if index_lock(repo).exists():raise IntegrationError(f"index_lock_present: {index_lock(repo)}")
 inventory=lifecycle.listed(repo);owners=[row for row in inventory if row.get("branch")==item["target_ref"]]
 if len(owners)>1:raise IntegrationError("duplicate target checkout owner")
 if owners and checked_policy!="detach_same_sha":raise IntegrationError(f"target_ref_checked_out: {item['target_ref']}; pass --checked-out-target detach_same_sha")
 actual=git(repo,"rev-parse",f"{item['target_ref']}^{{commit}}")
 expected_current_sha=expected_current_sha or item["expected_sha"]
 if actual!=expected_current_sha:raise IntegrationError(f"stale_target name={item['name']} expected={expected_current_sha} actual={actual}")
 candidate=git(repo,"rev-parse",f"{item['candidate_sha']}^{{commit}}")
 if candidate!=item["candidate_sha"]:raise IntegrationError("candidate identity mismatch")
 owner_path=None
 if owners:
  owner_path=str(repo.resolve()) if git(repo,"symbolic-ref","-q","HEAD",check=False)==item["target_ref"] else str(Path(owners[0]["worktree"]).resolve())
 elif checked_policy=="detach_same_sha":
  # A prior attempt may have completed metadata detach before its first CAS/write.
  detached=[row for row in inventory if row.get("HEAD")==expected_current_sha and not row.get("branch")]
  if len(detached)==1:owner_path=str(repo.resolve()) if Path(detached[0]["worktree"]).resolve()==common(repo) and git(repo,"rev-parse","HEAD",check=False)==expected_current_sha else str(Path(detached[0]["worktree"]).resolve())
  elif len(detached)>1 and not allow_post_detach_ambiguity:raise IntegrationError("ambiguous detached runtime identity for target retry")
 return {**item,"path":str(repo),"git_common_dir":str(common(repo)),"lock_key":lock_key(item),"before_sha":actual,"target_checkout":owner_path}
def public_plan(repositories:list[dict[str,Any]],receipt_hashes:list[str])->list[dict[str,str]]:
 return [{"name":item["name"],"path":str(item["path"]),"target_ref":item["target_ref"],"expected_sha":item["expected_sha"],"candidate_sha":item["candidate_sha"],"candidate_receipt_sha256":receipt_hashes[index]} for index,item in enumerate(repositories)]
def load_resume(path:Path,task_id:str,plan:list[dict[str,str]])->tuple[set[str],list[dict[str,Any]]]:
 value=json.loads(path.read_text())
 allowed=value.get("outcome") in {"running","partial_local_integration"} or (value.get("outcome")=="failed_preserved" and value.get("resume_stage")=="target_updates")
 if value.get("schema_version")!=SCHEMA or not allowed:raise IntegrationError("retryable running, partial, or detached-preserved integration receipt required for resume")
 if value.get("task_id")!=task_id or value.get("repositories")!=plan:raise IntegrationError("resume receipt does not match task or repository plan")
 updates=value.get("updates")
 if not isinstance(updates,list):raise IntegrationError("resume receipt updates must be a list")
 names=[];completed:set[str]=set()
 by_name={item["name"]:item for item in plan}
 for update in updates:
  name=str(update.get("name") or "") if isinstance(update,dict) else ""
  if name not in by_name or update.get("before_sha")!=by_name[name]["expected_sha"]:raise IntegrationError("resume receipt contains an invalid target update")
  item=by_name[name];actual=git(Path(item["path"]),"rev-parse",item["target_ref"]);status=update.get("status")
  if status in {"moved","resumed_already_moved"}:
   if update.get("after_sha")!=item["candidate_sha"] or actual!=item["candidate_sha"]:raise IntegrationError("resume receipt moved target no longer matches candidate")
   completed.add(name)
  elif status in {"attempting","cas_failed"}:
   if actual==item["candidate_sha"]:completed.add(name)
   elif actual!=item["expected_sha"]:raise IntegrationError("resume receipt attempted target has unexpected current SHA")
  else:raise IntegrationError("resume receipt contains an unsupported update status")
  names.append(name)
 if names!=[item["name"] for item in plan[:len(names)]] or len(names)!=len(set(names)):raise IntegrationError("resume receipt updates must be a unique child-first prefix")
 if any(name not in completed for name in names[:-1]):raise IntegrationError("only the final attempted target may remain unmoved")
 detaches=value.get("checked_out_target_policy",{}).get("detachments",[])
 if not isinstance(detaches,list):raise IntegrationError("resume receipt detachments must be a list")
 detached_names=[]
 for evidence in detaches:
  name=evidence.get("name") if isinstance(evidence,dict) else None
  if name not in by_name or evidence.get("checkout_sha")!=by_name[name]["expected_sha"]:raise IntegrationError("resume receipt contains invalid detached runtime identity")
  worktree=Path(str(evidence.get("worktree") or ""))
  if not worktree.exists() or common(worktree)!=common(Path(by_name[name]["path"])):raise IntegrationError("resume receipt runtime identity is no longer present")
  current_head=git(worktree,"rev-parse","HEAD",check=False);current_branch=git(worktree,"symbolic-ref","-q","HEAD",check=False)
  allowed_old=current_head==evidence["checkout_sha"] and not current_branch
  allowed_restored=current_head==by_name[name]["candidate_sha"] and current_branch in {"",by_name[name]["target_ref"]}
  if not (allowed_old or allowed_restored):raise IntegrationError("resume receipt runtime identity moved outside exact restoration states")
  detached_names.append(name)
 if len(detached_names)!=len(set(detached_names)):raise IntegrationError("resume receipt contains duplicate detached runtime identity")
 return completed,detaches
def tag(repo:Path,task_id:str,integrated:str,target_ref:str,candidate_hash:str,validation_hash:str)->str:
 if not TAG_RE.fullmatch(task_id):raise IntegrationError("task id is not tag-safe")
 name=f"juno-feature/{task_id}/{integrated[:12]}"; ref=f"refs/tags/{name}"
 message=f"task_id={task_id}\nintegrated_sha={integrated}\ntarget_ref={target_ref}\ncandidate_receipt_sha256={candidate_hash}\nvalidation_receipt_sha256={validation_hash}"
 existing=git(repo,"rev-parse","--verify",ref,check=False)
 if existing:
  peeled=git(repo,"rev-parse",f"{ref}^{{commit}}");body=git(repo,"for-each-ref","--format=%(contents)",ref)
  if peeled!=integrated or body.strip()!=message:raise IntegrationError("feature_tag_collision")
 else:git(repo,"tag","-a",name,integrated,"-m",message)
 return name
def child_artifact(path:Path,published_path:Path|None=None)->dict[str,str]:
 return {"path":str((published_path or path).resolve()),"sha256":sha(path)}
def publish_child_evidence(staging:Path,target:Path,evidence:dict[str,Any],integrated:str)->None:
 if evidence.get("schema_version")!="juno_workflow_child_step.v1" or evidence.get("child_id")!="actual_target_review" or evidence.get("reviewed_target_sha")!=integrated:raise IntegrationError("actual_target_review staged evidence binding invalid")
 artifacts=evidence.get("artifacts")
 if not isinstance(artifacts,dict) or set(artifacts)!={"stdout","stderr","response","capture","review_receipt"}:raise IntegrationError("actual_target_review staged artifacts invalid")
 for name,artifact in artifacts.items():
  staged=staging/("capture.json" if name=="capture" else "review_receipt.json" if name=="review_receipt" else f"{name}.txt")
  if not isinstance(artifact,dict) or Path(str(artifact.get("path") or "")).resolve()!=target/staged.name or not staged.is_file() or artifact.get("sha256")!=sha(staged):raise IntegrationError("actual_target_review staged artifact binding invalid")
 expected={"stdout.txt","stderr.txt","response.txt","capture.json","review_receipt.json"}
 if {path.name for path in staging.iterdir()}!=expected:raise IntegrationError("actual_target_review staging contains unexpected evidence")
 event_path=staging/"actual_target_review.event.json";event_path.write_text(json.dumps(evidence,indent=2,sort_keys=True)+"\n")
 if json.loads(event_path.read_text())!=evidence:raise IntegrationError("actual_target_review staged event validation failed")
 os.replace(staging,target)
SESSION_TOKEN=r"[A-Za-z0-9](?:[A-Za-z0-9_.:-]*[A-Za-z0-9])?"
SESSION_SUMMARY_RE=re.compile(rf"^[ \t]*(?:🔑[ \t]*)?(?:session_id[ \t]*=|session[ \t]+id(?:\(s\))?[ \t]*:)[ \t]*(?:\r?\n[ \t]+)?({SESSION_TOKEN})(?![A-Za-z0-9_.:-])(?=[ \t]*(?:(?:cost[ \t]*:.*)?\r?$))",re.I|re.M)
def child_session(stdout:str,stderr:str,capture:dict[str,Any])->str|None:
 value=capture.get("session_id")
 if isinstance(value,str) and value.strip():return value.strip()
 for text in (stdout,stderr):
  match=SESSION_SUMMARY_RE.search(text)
  if match:return match.group(1)
 return None
def has_resume_or_continue(tokens:list[str])->bool:
 for token in tokens:
  if token=="--":return False
  if token in {"--resume","--continue","continue","cc","-r"} or token.startswith(("--resume=","--continue=")) or (len(token)>2 and token.startswith("-r")):return True
 return False
def actual_review_child(command:str,actual_cwd:Path,receipt_path:Path,integrated:str,timeout:float,child_root:Path|None=None)->dict[str,Any]:
 try:tokens=shlex.split(command)
 except ValueError as exc:raise IntegrationError(f"actual_target_review command is not parseable: {exc}") from exc
 if len(tokens)<2 or Path(tokens[0]).name not in {"yy","juno-code","ypl"} or tokens[1]!="pi":raise IntegrationError("actual_target_review must be a declared yy/juno-code/ypl pi execution")
 if has_resume_or_continue(tokens):raise IntegrationError("actual_target_review must use a fresh session without resume/continue")
 child_root_text=os.environ.pop("JUNO_WORKFLOW_CHILD_EVIDENCE_DIR","").strip()
 child_root=child_root.resolve() if child_root else Path(child_root_text).resolve() if child_root_text else None
 staging=None
 if child_root:
  child_root.parent.mkdir(parents=True,exist_ok=True)
  if child_root.exists():
   if not child_root.is_dir() or any(child_root.iterdir()):raise IntegrationError("actual_target_review evidence target must be absent or empty")
   child_root.rmdir()
  staging=Path(tempfile.mkdtemp(prefix=f".{child_root.name}.staging-",dir=child_root.parent));staging.chmod(0o700)
 capture_path=(staging/"capture.raw.json") if staging else receipt_path.with_suffix(".capture.raw.json")
 env={key:value for key,value in os.environ.items() if key not in {"JUNO_WORKFLOW_CHILD_EVIDENCE_DIR","JUNO_WORKFLOW_DIRECT_OWNER"}};env.update({"JUNO_TOOL_ID":"workflow_actual_target_review","JUNO_SUBAGENT_CAPTURE_PATH":str(capture_path)})
 if receipt_path.exists():receipt_path.unlink()
 started_wall=datetime.datetime.now(datetime.timezone.utc);started=time.monotonic()
 try:review_run=subprocess.run(tokens,cwd=actual_cwd,text=True,capture_output=True,stdin=subprocess.DEVNULL,timeout=timeout,env=env)
 except subprocess.TimeoutExpired as exc:
  stdout=exc.stdout.decode() if isinstance(exc.stdout,bytes) else exc.stdout or "";stderr=exc.stderr.decode() if isinstance(exc.stderr,bytes) else exc.stderr or ""
  review_run=subprocess.CompletedProcess(command,124,stdout,stderr+f"actual target review timed out after {timeout} seconds\n")
 duration=round(time.monotonic()-started,3);completed_wall=datetime.datetime.now(datetime.timezone.utc)
 capture:dict[str,Any]={}
 if capture_path.is_file():
  try:
   loaded=json.loads(capture_path.read_text());capture=loaded if isinstance(loaded,dict) else {}
  except json.JSONDecodeError:pass
 response=str(capture.get("result") or review_run.stdout or "")
 session_id=child_session(review_run.stdout or "",review_run.stderr or "",capture)
 semantic="failed"
 review:dict[str,Any]={}
 if review_run.returncode==0 and receipt_path.is_file():
  try:review=json.loads(receipt_path.read_text())
  except json.JSONDecodeError:review={}
  semantic="accepted" if review.get("schema_version")=="juno_review.v1" and review.get("review_kind")=="actual_target" and review.get("passed") is True and review.get("reviewed_tip")==integrated and review.get("open_bugs")==[] else "rejected"
 missing_session=semantic=="accepted" and not session_id
 if missing_session:semantic="rejected"
 prompt=tokens[-1] if len(tokens)>=3 and Path(tokens[0]).name in {"yy","juno-code","ypl"} else ""
 evidence={"child_id":"actual_target_review","role":"actual_target_review","invocation_mode":"fresh_session","rendered_command_sha256":hashlib.sha256(command.encode()).hexdigest(),"rendered_argv_sha256":hashlib.sha256(json.dumps(tokens,separators=(",",":"),ensure_ascii=False).encode()).hexdigest(),"rendered_prompt_sha256":hashlib.sha256(prompt.encode()).hexdigest() if prompt else None,"started_at":started_wall.isoformat().replace("+00:00","Z"),"completed_at":completed_wall.isoformat().replace("+00:00","Z"),"duration_seconds":duration,"exit_code":review_run.returncode,"transport_status":"success" if review_run.returncode==0 else "failed","semantic_outcome":semantic,"session_id":session_id,"reviewed_target_sha":integrated}
 if child_root and staging:
  stdout_path=staging/"stdout.txt";stderr_path=staging/"stderr.txt";response_path=staging/"response.txt";normalized_capture=staging/"capture.json";bound_receipt=staging/"review_receipt.json"
  stdout_path.write_text(review_run.stdout or "");stderr_path.write_text(review_run.stderr or "");response_path.write_text(response);normalized_capture.write_text(json.dumps({"session_id":session_id,"result":response,"raw_capture":capture},sort_keys=True)+"\n");bound_receipt.write_bytes(receipt_path.read_bytes() if receipt_path.is_file() else b"")
  if capture_path.exists():capture_path.unlink()
  evidence.update({"schema_version":"juno_workflow_child_step.v1","parent_workflow_id":os.environ.get("JUNO_WORKFLOW_ID",""),"parent_run_id":os.environ.get("JUNO_WORKFLOW_RUN_ID",""),"parent_step_id":os.environ.get("JUNO_WORKFLOW_STEP_ID",""),"parent_step_digest":os.environ.get("JUNO_WORKFLOW_STEP_DIGEST",""),"artifacts":{"stdout":child_artifact(stdout_path,child_root/stdout_path.name),"stderr":child_artifact(stderr_path,child_root/stderr_path.name),"response":child_artifact(response_path,child_root/response_path.name),"capture":child_artifact(normalized_capture,child_root/normalized_capture.name),"review_receipt":child_artifact(bound_receipt,child_root/bound_receipt.name)}})
  publish_child_evidence(staging,child_root,evidence,integrated);staging=None
  live_path=os.environ.get("JUNO_WORKFLOW_LIVE_LOG_PATH","").strip()
  if live_path:
   with Path(live_path).open("a",encoding="utf-8") as live:live.write(f"\n=== CHILD actual_target_review semantic={semantic} exit={review_run.returncode} ===\n{review_run.stdout or ''}{review_run.stderr or ''}=== END CHILD actual_target_review ===\n")
 if review_run.returncode:raise IntegrationError("actual_target_review_command_failed")
 if missing_session:raise IntegrationError("actual_target_review session identity required")
 if semantic!="accepted":raise IntegrationError("actual_target_review_PASS_required")
 evidence["review_receipt_sha256"]=sha(receipt_path)
 return evidence


def process_lineage()->set[int]:
 result:set[int]=set();pid=os.getpid()
 for _ in range(64):
  if pid<=1 or pid in result:break
  result.add(pid)
  probe=subprocess.run(["ps","-o","ppid=","-p",str(pid)],text=True,capture_output=True,stdin=subprocess.DEVNULL)
  if probe.returncode or not probe.stdout.strip().isdigit():break
  pid=int(probe.stdout.strip())
 return result

def restoration_process_evidence(path:Path)->dict[str,Any]:
 status,processes=lifecycle.active_cwd_processes(path);lineage=process_lineage()
 owning=[item for item in processes if item.get("pid") in lineage];foreign=[item for item in processes if item.get("pid") not in lineage]
 evidence={"probe_status":status,"owning_controller_lineage":owning,"foreign_product_runtimes":foreign,"policy":"preserved_no_signal"}
 if status=="unknown":raise IntegrationError(f"controller_restoration_process_probe_unknown path={path}")
 if foreign:raise IntegrationError(f"unsafe_active_runtime_ownership path={path} pids={[item['pid'] for item in foreign]}")
 return evidence

def restoration_registration(rows:list[dict[str,str]],mutable_path:Path)->list[dict[str,str]]:
 mutable_path=mutable_path.resolve();mutable_identities={mutable_path,common(mutable_path)};normalized=[]
 for row in rows:
  try:is_mutable=Path(row.get("worktree","")).resolve() in mutable_identities
  except OSError:is_mutable=False
  normalized.append({key:value for key,value in row.items() if not (is_mutable and key in {"HEAD","branch","detached"})})
 return sorted(normalized,key=lambda row:row.get("worktree",""))

def exact_checkout_state(path:Path,item:dict[str,Any],allowed_heads:set[str],allowed_dirty_paths:set[str]|None=None)->dict[str,Any]:
 if lifecycle.lock_path(path).exists():raise IntegrationError(f"restoration_index_lock_present path={path}")
 head=git(path,"rev-parse","HEAD");branch=git(path,"symbolic-ref","-q","HEAD",check=False)
 if head not in allowed_heads:raise IntegrationError(f"restoration_checkout_head_mismatch name={item['name']} actual={head}")
 if run(path,"diff","--quiet",check=False).returncode:
  dirty_paths=set(git(path,"diff","--name-only").splitlines())
  if not allowed_dirty_paths or not dirty_paths or not dirty_paths.issubset(allowed_dirty_paths):raise IntegrationError(f"restoration_tracked_dirt name={item['name']}")
 if run(path,"diff","--cached","--quiet",check=False).returncode:raise IntegrationError(f"restoration_index_dirt name={item['name']}")
 if git(item["path"],"rev-parse",item["target_ref"])!=item["candidate_sha"]:raise IntegrationError(f"restoration_target_moved name={item['name']}")
 if run(path,"cat-file","-e",f"{item['candidate_sha']}^{{commit}}",check=False).returncode:raise IntegrationError(f"restoration_candidate_object_missing name={item['name']}")
 return {"head":head,"branch":branch or "DETACHED","status":git(path,"status","--porcelain=v2","--untracked-files=all"),"registration":restoration_registration(lifecycle.listed(Path(item["path"])),path) }

def restore_controller_checkout(repositories:list[dict[str,Any]],gitlinks:list[tuple[str,str]],controller:Path|None,policy:str|None,detaches:list[dict[str,Any]],receipt:dict[str,Any],inject_after:int|None)->list[dict[str,Any]]:
 if policy is None:return []
 if policy!="exact_integrated" or controller is None:raise IntegrationError("exact controller restoration requires --controller-checkout")
 controller=controller.resolve();root=repositories[-1];detach_by_name={entry["name"]:entry for entry in detaches}
 root_detach=detach_by_name.get(root["name"])
 if not root_detach or Path(root_detach["worktree"]).resolve()!=controller:raise IntegrationError("controller restoration requires receipt-bound root detachment")
 links=dict(gitlinks);children=[];paths=[]
 for item in repositories[:-1]:
  detached=detach_by_name.get(item["name"])
  if not detached:continue
  path=Path(detached["worktree"]).resolve()
  try:relative=path.relative_to(controller)
  except ValueError:continue
  if item["name"] not in links or relative.as_posix()!=links[item["name"]]:raise IntegrationError(f"unbound_nested_restoration name={item['name']}")
  paths.append(relative);children.append((item,path,relative))
 for left in paths:
  for right in paths:
   if left!=right and (left in right.parents or right in left.parents):raise IntegrationError("overlapping_nested_restoration_paths")
 planned=[]
 for item,path,relative in children:
  fields=git(root["path"],"ls-tree",root["candidate_sha"],"--",relative.as_posix()).split(None,3)
  if len(fields)<3 or fields[0]!="160000" or fields[2]!=item["candidate_sha"]:raise IntegrationError(f"restoration_gitlink_mismatch name={item['name']}")
  before=exact_checkout_state(path,item,{item["expected_sha"],item["candidate_sha"]})
  detached_registration=restoration_registration(detached.get("evidence",{}).get("inventory_after") or [],path)
  if not detached_registration or before["registration"]!=detached_registration:raise IntegrationError(f"restoration_inventory_drift name={item['name']}")
  process=restoration_process_evidence(path)
  planned.append({"name":item["name"],"kind":"nested","path":str(path),"before":before,"process_evidence":process,"status":"planned"})
 root_before=exact_checkout_state(controller,root,{root["expected_sha"],root["candidate_sha"]},{relative.as_posix() for _,_,relative in children})
 root_detached_registration=restoration_registration(root_detach.get("evidence",{}).get("inventory_after") or [],controller)
 if not root_detached_registration or root_before["registration"]!=root_detached_registration:raise IntegrationError("controller_root_inventory_drift")
 root_process=restoration_process_evidence(controller)
 root_inventory=root_before["registration"]
 receipt["controller_restoration"]={"policy":policy,"status":"planned","entries":planned,"root":{"name":root["name"],"path":str(controller),"before":root_before,"process_evidence":root_process,"status":"planned"}}
 receipt["resume_stage"]="controller_restoration";write(Path(receipt["_output_path"]),{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
 mutation_count=0
 for entry,(item,path,relative) in zip(planned,children):
  if git(path,"rev-parse","HEAD")!=item["candidate_sha"]:
   run(path,"-c","submodule.recurse=false","checkout","--detach",item["candidate_sha"])
  after=exact_checkout_state(path,item,{item["candidate_sha"]})
  if after["registration"]!=entry["before"]["registration"]:raise IntegrationError(f"nested_restoration_inventory_drift name={item['name']}")
  if after["branch"]!="DETACHED":raise IntegrationError(f"nested_restoration_attached_branch name={item['name']}")
  entry.update({"status":"restored","after":after});mutation_count+=1
  write(Path(receipt["_output_path"]),{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
  if inject_after is not None and mutation_count>=inject_after:raise IntegrationError("injected_controller_restoration_failure")
 root_entry=receipt["controller_restoration"]["root"]
 if git(controller,"rev-parse","HEAD")!=root["candidate_sha"]:
  run(controller,"-c","submodule.recurse=false","checkout","--detach",root["candidate_sha"])
 if git(controller,"symbolic-ref","-q","HEAD",check=False)!=root["target_ref"]:
  owners=[row for row in lifecycle.listed(Path(root["path"])) if row.get("branch")==root["target_ref"]]
  if owners:raise IntegrationError("foreign_branch_owner_before_root_restoration")
  run(controller,"symbolic-ref","HEAD",root["target_ref"])
 owners_after=[row for row in lifecycle.listed(Path(root["path"])) if row.get("branch")==root["target_ref"]]
 if len(owners_after)!=1 or Path(owners_after[0]["worktree"]).resolve()!=controller:raise IntegrationError("controller_root_target_owner_readback_failed")
 after=exact_checkout_state(controller,root,{root["candidate_sha"]})
 if after["branch"]!=root["target_ref"]:raise IntegrationError("controller_root_restoration_postcondition_failed")
 if after["registration"]!=root_inventory:raise IntegrationError("controller_root_inventory_drift")
 root_entry.update({"status":"restored","after":after});mutation_count+=1
 receipt["controller_restoration"]["status"]="restored"
 write(Path(receipt["_output_path"]),{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
 if inject_after is not None and mutation_count>=inject_after:raise IntegrationError("injected_controller_restoration_failure")
 return planned+[root_entry]

def runtime_identities(detaches:list[dict[str,Any]],repositories:list[dict[str,Any]])->list[dict[str,Any]]:
 by_name={item["name"]:item for item in repositories};result=[]
 for evidence in detaches:
  item=by_name[evidence["name"]];target=git(item["path"],"rev-parse",item["target_ref"],check=False)
  checkout=evidence["checkout_sha"]
  state="unknown_target" if not target else "current" if target==checkout else "stale_behind_target"
  worktree=Path(evidence["worktree"]);actual=git(worktree,"rev-parse","HEAD",check=False);branch=git(worktree,"symbolic-ref","-q","HEAD",check=False)
  if actual==item["candidate_sha"]:state="restored_attached" if branch==item["target_ref"] else "restored_detached"
  result.append({"name":item["name"],"worktree":evidence["worktree"],"checkout_sha":checkout,"actual_checkout_sha":actual or None,"checkout_ref":branch or None,"target_sha":target or None,
                 "runtime_identity_status":state,"process_policy":"preserved_no_signal"})
 return result

def main(argv:list[str]|None=None)->int:
 p=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);p.add_argument("integrate",nargs="?");p.add_argument("--repository",action="append",type=parse_repo,required=True);p.add_argument("--candidate-receipt",action="append",type=Path,required=True);p.add_argument("--resume-receipt",type=Path);p.add_argument("--gitlink",action="append",type=parse_gitlink,default=[]);p.add_argument("--controller-checkout",type=Path);p.add_argument("--restore-controller-checkout",choices=("exact_integrated",));p.add_argument("--checked-out-target",choices=("detach_same_sha",));p.add_argument("--risk-tier",choices=tuple(RISK_ORDER),default="high");p.add_argument("--feature-tag",action="store_true");p.add_argument("--actual-review-command");p.add_argument("--actual-review-receipt",type=Path);p.add_argument("--validation-command",action="append",required=True);p.add_argument("--validation-timeout",type=float,default=3600);p.add_argument("--lock-timeout",type=float,default=30);p.add_argument("--task-id",required=True);p.add_argument("--output",type=Path,required=True);p.add_argument("--inject-failure-after",type=int);p.add_argument("--inject-restoration-failure-after",type=int);p.add_argument("--inject-authority-failure-after",type=int)
 a=p.parse_args(argv)
 child_evidence_text=os.environ.pop("JUNO_WORKFLOW_CHILD_EVIDENCE_DIR","").strip();child_evidence_root=Path(child_evidence_text).resolve() if child_evidence_text else None
 if a.integrate not in (None,"integrate"):p.error("only the integrate subcommand is supported")
 if not 0<=a.lock_timeout<=300:p.error("--lock-timeout must be between 0 and 300 seconds")
 if not 0<a.validation_timeout<=86400:p.error("--validation-timeout must be between 0 and 86400 seconds")
 if a.output.resolve().exists():print(f"integration_owner_preflight: error: immutable receipt collision: {a.output.resolve()}",file=sys.stderr);return 2
 receipt:dict[str,Any]={"schema_version":SCHEMA,"outcome":"running","task_id":a.task_id,"producer_step_digest":os.environ.get("JUNO_WORKFLOW_STEP_DIGEST",""),"updates":[],"feature_tag":None,"_output_path":str(a.output.resolve())};detaches=[]
 try:
  if len(a.candidate_receipt)!=len(a.repository):raise IntegrationError("one --candidate-receipt is required per --repository")
  committed_admission=[require_committed_tree(item["path"],item["candidate_sha"] if a.resume_receipt else item["expected_sha"]) for item in a.repository]
  candidates=[load_candidate(path,[repository]) for path,repository in zip(a.candidate_receipt,a.repository)]
  receipt_hashes=[sha(path) for path in a.candidate_receipt];candidate_hash=receipt_hashes[0] if len(receipt_hashes)==1 else hashlib.sha256("\n".join(receipt_hashes).encode()).hexdigest()
  plan=public_plan(a.repository,receipt_hashes);topology=verify_nested_owners(a.repository,a.controller_checkout,a.restore_controller_checkout,a.resume_receipt is not None)
  reasons=[]
  if any(c.get("candidate_bytes_changed_by_composition") is True for c in candidates):reasons.append("composed_candidate")
  if len(a.repository)>1:reasons.append("multiple_repositories")
  if any(x["classification"]=="controller_nested_integration_owner" for x in topology):reasons.append("controller_nested_owner")
  effective="high" if reasons and RISK_ORDER[a.risk_tier]<RISK_ORDER["high"] else a.risk_tier
  actual_required=effective in {"high","release"}
  receipt.update({"repositories":plan,"committed_tree_admission":committed_admission,"candidate_receipt_sha256":candidate_hash,"topology":topology,"declared_risk_tier":a.risk_tier,"effective_risk_tier":effective,"risk_escalation_reasons":reasons})
  if actual_required and (not a.actual_review_command or not a.actual_review_receipt):raise IntegrationError("actual_target semantic review required by effective risk tier")
  workflow_owned=os.environ.get("JUNO_WORKFLOW_DIRECT_OWNER","").strip()=="integration_owner_preflight.v1"
  if actual_required and workflow_owned and child_evidence_root is None:raise IntegrationError("workflow-owned high-risk integration requires JUNO_WORKFLOW_CHILD_EVIDENCE_DIR")
  resumed,prior_detaches=load_resume(a.resume_receipt,a.task_id,plan) if a.resume_receipt else (set(),[])
  detaches.extend(prior_detaches)
  if a.resume_receipt:receipt["resume_receipt_sha256"]=sha(a.resume_receipt)
  verify_gitlinks(a.repository,a.gitlink)
  ordered=sorted(a.repository,key=lambda x:(str(common(x["path"])),x["target_ref"]));validated=[validate_item(i,i["candidate_sha"] if i["name"] in resumed else i["expected_sha"],a.checked_out_target) for i in ordered]
  if len({x["lock_key"] for x in validated})!=len(validated):raise IntegrationError("duplicate integration channel")
  handles=[]
  try:
   for item in validated:
    path=lock_file(item);path.parent.mkdir(parents=True,exist_ok=True);h=path.open("a+");acquire_bounded(h,a.lock_timeout);handles.append(h)
   if [sha(path) for path in a.candidate_receipt]!=receipt_hashes:raise IntegrationError("candidate_receipt_changed_under_lock")
   candidates=[load_candidate(path,[repository]) for path,repository in zip(a.candidate_receipt,a.repository)]
   verify_gitlinks(a.repository,a.gitlink);verify_nested_owners(a.repository,a.controller_checkout,a.restore_controller_checkout,a.resume_receipt is not None)
   by_name={x["name"]:x for x in validated}
   detached_names={entry["name"] for entry in detaches}
   for item in validated:
    if item["target_checkout"] and item["name"] not in resumed and item["name"] not in detached_names:
     allow_root=a.restore_controller_checkout=="exact_integrated" and a.controller_checkout is not None and Path(item["target_checkout"]).resolve()==a.controller_checkout.resolve()
     evidence=lifecycle.detach_same_sha(Path(item["path"]),Path(item["target_checkout"]),item["target_ref"],item["expected_sha"],controller=a.controller_checkout,allow_controller_root=allow_root)
     detaches.append({"name":item["name"],"worktree":item["target_checkout"],"checkout_sha":item["expected_sha"],"evidence":evidence})
   receipt["checked_out_target_policy"]={"requested":a.checked_out_target,"detachments":detaches};receipt["runtime_identities"]=runtime_identities(detaches,a.repository)
   # The target checkout was receipt-bound before detachment. A distinct
   # integration-owner can legitimately share the same detached expected SHA,
   # so post-detach ref revalidation must not rediscover a unique checkout.
   for original in a.repository:validate_item(original,original["candidate_sha"] if original["name"] in resumed else original["expected_sha"],a.checked_out_target,allow_post_detach_ambiguity=True)
   for original in a.repository:
    if original["name"] in resumed:receipt["updates"].append({"name":original["name"],"target_ref":original["target_ref"],"before_sha":original["expected_sha"],"after_sha":original["candidate_sha"],"status":"resumed_already_moved"})
   receipt["resume_stage"]="target_updates";write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
   for index,original in enumerate(a.repository):
    item=by_name[original["name"]]
    if original["name"] in resumed:continue
    if a.inject_failure_after is not None and index>=a.inject_failure_after:raise IntegrationError("injected_update_failure")
    update={"name":item["name"],"target_ref":item["target_ref"],"before_sha":item["expected_sha"],"after_sha":None,"status":"attempting"};receipt["updates"].append(update);write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
    result=run(Path(item["path"]),"update-ref",item["target_ref"],item["candidate_sha"],item["expected_sha"],check=False)
    if result.returncode:update["status"]="cas_failed";write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True);raise IntegrationError(f"target_cas_failed name={item['name']}: {result.stderr.strip()}")
    update.update({"after_sha":git(Path(item["path"]),"rev-parse",item["target_ref"]),"status":"moved"});write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
   for item in a.repository:
    if git(item["path"],"rev-parse",item["target_ref"])!=item["candidate_sha"]:raise IntegrationError("actual target readback mismatch")
   receipt["resume_stage"]="actual_target_validation";write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
   actual_cwd=Path(candidates[-1]["candidate_path"]);integrated=a.repository[-1]["candidate_sha"]
   if git(actual_cwd,"rev-parse","HEAD")!=integrated or git(actual_cwd,"status","--porcelain=v2","--untracked-files=all"):raise IntegrationError("actual target validation checkout moved or dirty")
   validations=[]
   for command in a.validation_command:
    validation_env={key:value for key,value in os.environ.items() if key not in {"JUNO_WORKFLOW_CHILD_EVIDENCE_DIR","JUNO_WORKFLOW_DIRECT_OWNER"}}
    r=subprocess.run(command,shell=True,cwd=actual_cwd,text=True,capture_output=True,stdin=subprocess.DEVNULL,timeout=a.validation_timeout,env=validation_env);validations.append({"command_sha256":hashlib.sha256(command.encode()).hexdigest(),"exit_code":r.returncode})
    if r.returncode:raise IntegrationError("actual_target_validation_failed")
   actual_semantic="not_required_by_effective_tier";actual_hash=None
   if actual_required:
    child_evidence=actual_review_child(a.actual_review_command,actual_cwd,a.actual_review_receipt,integrated,a.validation_timeout,child_evidence_root)
    receipt["actual_review_child_step"]={key:value for key,value in child_evidence.items() if key not in {"artifacts"}}
    actual_semantic="performed";actual_hash=sha(a.actual_review_receipt)
   for item in a.repository:
    if git(item["path"],"rev-parse",item["target_ref"])!=item["candidate_sha"]:raise IntegrationError("actual target moved during validation/review")
   verify_nested_owners(a.repository,a.controller_checkout,a.restore_controller_checkout,a.resume_receipt is not None)
   restore_controller_checkout(a.repository,a.gitlink,a.controller_checkout,a.restore_controller_checkout,detaches,receipt,a.inject_restoration_failure_after)
   validation_receipt={"validation":validations,"deterministic_actual_target_validation":"passed","actual_review_sha256":actual_hash,"target_refs":{item["name"]:{"target_ref":item["target_ref"],"reviewed_tip":item["candidate_sha"]} for item in a.repository}};validation_hash=hashlib.sha256(json.dumps(validation_receipt,sort_keys=True).encode()).hexdigest()
   tag_required=effective in {"high","release"};tag_requested=tag_required or a.feature_tag
   receipt["resume_stage"]="protected_authority_persistence";receipt["role_base_updates"]=[]
   receipt["feature_tag_policy"]={"required":tag_required,"requested":a.feature_tag,"created":False,"status":"withheld_pending_authority" if tag_requested else "skipped_by_policy"};write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
   for index,item in enumerate(a.repository):
    update=advance_protected_role_base(item["path"],item["candidate_sha"],inject_failure=a.inject_authority_failure_after is not None and index>=a.inject_authority_failure_after)
    receipt["role_base_updates"].append(update);write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
   feature=tag(a.repository[-1]["path"],a.task_id,integrated,a.repository[-1]["target_ref"],candidate_hash,validation_hash) if tag_requested else None
   tag_policy={"required":tag_required,"requested":a.feature_tag,"created":feature is not None,"status":"created" if feature else "skipped_by_policy"}
   receipt.update({"outcome":"integrated","passed":True,"feature_tag":feature,"feature_tag_policy":tag_policy,"actual_semantic_review":actual_semantic,"candidate_receipt_sha256":candidate_hash,"actual_target":validation_receipt,"lock_order":[x["lock_key"] for x in validated],"runtime_identities":runtime_identities(detaches,a.repository)})
  finally:
   for h in reversed(handles):fcntl.flock(h.fileno(),fcntl.LOCK_UN);h.close()
 except (IntegrationError,lifecycle.LifecycleError,OSError,json.JSONDecodeError,subprocess.TimeoutExpired) as exc:
  receipt.update({"passed":False,"error":str(exc),"runtime_identities":runtime_identities(detaches,a.repository)})
  if receipt.get("feature_tag_policy",{}).get("status")=="withheld_pending_authority":receipt["feature_tag_policy"]["status"]="withheld_authority_persistence_failed"
  receipt["outcome"]="partial_local_integration" if any(update.get("status") in {"moved","resumed_already_moved"} for update in receipt["updates"]) else "failed_preserved"
  if receipt["updates"] and not receipt.get("resume_stage"):receipt["resume_stage"]="target_updates"
  try:write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=a.output.resolve().exists())
  except Exception as write_exc:print(f"integration_owner_preflight: receipt error: {write_exc}",file=sys.stderr)
  print(f"integration_owner_preflight: error: {exc}",file=sys.stderr);return 2
 # Integration truth is durable and all target-channel handles have been released
 # before the optional bridge runs. Bridge failures must never rewrite this
 # receipt or change the successful integration exit code.
 write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)
 controller_sync={"outcome":"not_enabled"}
 try:
  import git_flow
  controller_sync=git_flow.auto_after_integration(Path(a.repository[-1]["path"]),a.output.resolve())
 except Exception as exc:
  controller_sync={"outcome":"failed_preserved","integrationRemainsSuccessful":True,"error":str(exc)}
 print(json.dumps({"schema_version":SCHEMA,"passed":True,"outcome":"integrated","feature_tag":receipt["feature_tag"],"controller_sync":controller_sync},sort_keys=True));return 0
if __name__=="__main__":raise SystemExit(main())
