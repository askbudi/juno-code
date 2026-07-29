#!/usr/bin/env python3
"""Receipt-gated, target-ref-scoped local integration with exact CAS updates."""
from __future__ import annotations
import argparse, fcntl, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path
from typing import Any
sys.path.insert(0, str(Path(__file__).resolve().parent))
import worktree_lifecycle as lifecycle
SCHEMA="juno_local_integration.v3"; TAG_RE=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
RISK_ORDER={"low":0,"medium":1,"high":2,"release":3}
class IntegrationError(Exception):pass

def run(repo:Path,*args:str,check:bool=True,env:dict[str,str]|None=None)->subprocess.CompletedProcess[str]:
 r=subprocess.run(["git","-C",str(repo),*args],text=True,capture_output=True,stdin=subprocess.DEVNULL,env=env or {**os.environ,"GIT_OPTIONAL_LOCKS":"0"})
 if check and r.returncode:raise IntegrationError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
 return r
def git(repo:Path,*args:str,check:bool=True)->str:return run(repo,*args,check=check).stdout.strip()
def sha(path:Path)->str:return hashlib.sha256(path.read_bytes()).hexdigest()
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

def verify_nested_owners(repositories:list[dict[str,Any]],controller:Path|None)->list[dict[str,Any]]:
 if controller is None:return []
 controller=controller.resolve();controller_root=Path(git(controller,"rev-parse","--show-toplevel")).resolve()
 if controller_root!=controller:raise IntegrationError("controller checkout must be its exact Git root")
 evidence=[]
 for item in repositories:
  try:relative=item["path"].relative_to(controller_root)
  except ValueError:
   evidence.append({"name":item["name"],"classification":"auxiliary_integration_owner","path":str(item["path"])});continue
  if not relative.parts:raise IntegrationError("controller checkout cannot be an integration owner")
  fields=git(controller_root,"ls-tree","HEAD","--",relative.as_posix()).split(None,3)
  if len(fields)<3 or fields[0]!="160000":raise IntegrationError(f"controller_nested_owner_not_gitlink name={item['name']}")
  if fields[2]!=item["expected_sha"]:raise IntegrationError("controller nested gitlink SHA mismatch")
  if git(controller_root,"status","--porcelain=v2","--untracked-files=all","--",relative.as_posix()):raise IntegrationError("controller nested gitlink is dirty")
  evidence.append({"name":item["name"],"classification":"controller_nested_integration_owner","controller_root":str(controller_root),"controller_head":git(controller_root,"rev-parse","HEAD"),"gitlink_path":relative.as_posix(),"gitlink_sha":fields[2],"gitlink_clean":True,"path":str(item["path"])})
 return evidence

def validate_item(item:dict[str,Any],expected_current_sha:str|None=None,checked_policy:str|None=None)->dict[str,Any]:
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
  elif len(detached)>1:raise IntegrationError("ambiguous detached runtime identity for target retry")
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
  if not worktree.exists() or common(worktree)!=common(Path(by_name[name]["path"])) or git(worktree,"rev-parse","HEAD",check=False)!=evidence["checkout_sha"] or git(worktree,"symbolic-ref","-q","HEAD",check=False):raise IntegrationError("resume receipt detached runtime identity is no longer present")
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
def runtime_identities(detaches:list[dict[str,Any]],repositories:list[dict[str,Any]])->list[dict[str,Any]]:
 by_name={item["name"]:item for item in repositories};result=[]
 for evidence in detaches:
  item=by_name[evidence["name"]];target=git(item["path"],"rev-parse",item["target_ref"],check=False)
  checkout=evidence["checkout_sha"]
  state="unknown_target" if not target else "current" if target==checkout else "stale_behind_target"
  result.append({"name":item["name"],"worktree":evidence["worktree"],"checkout_sha":checkout,"target_sha":target or None,
                 "runtime_identity_status":state,"process_policy":"preserved_no_signal"})
 return result

def main(argv:list[str]|None=None)->int:
 p=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);p.add_argument("integrate",nargs="?");p.add_argument("--repository",action="append",type=parse_repo,required=True);p.add_argument("--candidate-receipt",action="append",type=Path,required=True);p.add_argument("--resume-receipt",type=Path);p.add_argument("--gitlink",action="append",type=parse_gitlink,default=[]);p.add_argument("--controller-checkout",type=Path);p.add_argument("--checked-out-target",choices=("detach_same_sha",));p.add_argument("--risk-tier",choices=tuple(RISK_ORDER),default="high");p.add_argument("--feature-tag",action="store_true");p.add_argument("--actual-review-command");p.add_argument("--actual-review-receipt",type=Path);p.add_argument("--validation-command",action="append",required=True);p.add_argument("--validation-timeout",type=float,default=3600);p.add_argument("--lock-timeout",type=float,default=30);p.add_argument("--task-id",required=True);p.add_argument("--output",type=Path,required=True);p.add_argument("--inject-failure-after",type=int)
 a=p.parse_args(argv)
 if a.integrate not in (None,"integrate"):p.error("only the integrate subcommand is supported")
 if not 0<=a.lock_timeout<=300:p.error("--lock-timeout must be between 0 and 300 seconds")
 if not 0<a.validation_timeout<=86400:p.error("--validation-timeout must be between 0 and 86400 seconds")
 if a.output.resolve().exists():print(f"integration_owner_preflight: error: immutable receipt collision: {a.output.resolve()}",file=sys.stderr);return 2
 receipt:dict[str,Any]={"schema_version":SCHEMA,"outcome":"running","task_id":a.task_id,"updates":[],"feature_tag":None};detaches=[]
 try:
  if len(a.candidate_receipt)!=len(a.repository):raise IntegrationError("one --candidate-receipt is required per --repository")
  candidates=[load_candidate(path,[repository]) for path,repository in zip(a.candidate_receipt,a.repository)]
  receipt_hashes=[sha(path) for path in a.candidate_receipt];candidate_hash=receipt_hashes[0] if len(receipt_hashes)==1 else hashlib.sha256("\n".join(receipt_hashes).encode()).hexdigest()
  plan=public_plan(a.repository,receipt_hashes);topology=verify_nested_owners(a.repository,a.controller_checkout)
  reasons=[]
  if any(c.get("candidate_bytes_changed_by_composition") is True for c in candidates):reasons.append("composed_candidate")
  if len(a.repository)>1:reasons.append("multiple_repositories")
  if any(x["classification"]=="controller_nested_integration_owner" for x in topology):reasons.append("controller_nested_owner")
  effective="high" if reasons and RISK_ORDER[a.risk_tier]<RISK_ORDER["high"] else a.risk_tier
  actual_required=effective in {"high","release"}
  receipt.update({"repositories":plan,"candidate_receipt_sha256":candidate_hash,"topology":topology,"declared_risk_tier":a.risk_tier,"effective_risk_tier":effective,"risk_escalation_reasons":reasons})
  if actual_required and (not a.actual_review_command or not a.actual_review_receipt):raise IntegrationError("actual_target semantic review required by effective risk tier")
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
   verify_gitlinks(a.repository,a.gitlink);verify_nested_owners(a.repository,a.controller_checkout)
   by_name={x["name"]:x for x in validated}
   detached_names={entry["name"] for entry in detaches}
   for item in validated:
    if item["target_checkout"] and item["name"] not in resumed and item["name"] not in detached_names:
     evidence=lifecycle.detach_same_sha(Path(item["path"]),Path(item["target_checkout"]),item["target_ref"],item["expected_sha"],controller=a.controller_checkout)
     detaches.append({"name":item["name"],"worktree":item["target_checkout"],"checkout_sha":item["expected_sha"],"evidence":evidence})
   receipt["checked_out_target_policy"]={"requested":a.checked_out_target,"detachments":detaches};receipt["runtime_identities"]=runtime_identities(detaches,a.repository)
   for original in a.repository:validate_item(original,original["candidate_sha"] if original["name"] in resumed else original["expected_sha"],a.checked_out_target)
   for original in a.repository:
    if original["name"] in resumed:receipt["updates"].append({"name":original["name"],"target_ref":original["target_ref"],"before_sha":original["expected_sha"],"after_sha":original["candidate_sha"],"status":"resumed_already_moved"})
   receipt["resume_stage"]="target_updates";write(a.output,receipt,replace=True)
   for index,original in enumerate(a.repository):
    item=by_name[original["name"]]
    if original["name"] in resumed:continue
    if a.inject_failure_after is not None and index>=a.inject_failure_after:raise IntegrationError("injected_update_failure")
    update={"name":item["name"],"target_ref":item["target_ref"],"before_sha":item["expected_sha"],"after_sha":None,"status":"attempting"};receipt["updates"].append(update);write(a.output,receipt,replace=True)
    result=run(Path(item["path"]),"update-ref",item["target_ref"],item["candidate_sha"],item["expected_sha"],check=False)
    if result.returncode:update["status"]="cas_failed";write(a.output,receipt,replace=True);raise IntegrationError(f"target_cas_failed name={item['name']}: {result.stderr.strip()}")
    update.update({"after_sha":git(Path(item["path"]),"rev-parse",item["target_ref"]),"status":"moved"});write(a.output,receipt,replace=True)
   for item in a.repository:
    if git(item["path"],"rev-parse",item["target_ref"])!=item["candidate_sha"]:raise IntegrationError("actual target readback mismatch")
   receipt["resume_stage"]="actual_target_validation";write(a.output,receipt,replace=True)
   actual_cwd=Path(candidates[-1]["candidate_path"]);integrated=a.repository[-1]["candidate_sha"]
   if git(actual_cwd,"rev-parse","HEAD")!=integrated or git(actual_cwd,"status","--porcelain=v2","--untracked-files=all"):raise IntegrationError("actual target validation checkout moved or dirty")
   validations=[]
   for command in a.validation_command:
    r=subprocess.run(command,shell=True,cwd=actual_cwd,text=True,capture_output=True,stdin=subprocess.DEVNULL,timeout=a.validation_timeout);validations.append({"command_sha256":hashlib.sha256(command.encode()).hexdigest(),"exit_code":r.returncode})
    if r.returncode:raise IntegrationError("actual_target_validation_failed")
   actual_semantic="not_required_by_effective_tier";actual_hash=None
   if actual_required:
    review_run=subprocess.run(a.actual_review_command,shell=True,cwd=actual_cwd,text=True,capture_output=True,stdin=subprocess.DEVNULL,timeout=a.validation_timeout)
    if review_run.returncode:raise IntegrationError("actual_target_review_command_failed")
    review=json.loads(a.actual_review_receipt.read_text())
    if review.get("schema_version")!="juno_review.v1" or review.get("review_kind")!="actual_target" or review.get("passed") is not True or review.get("reviewed_tip")!=integrated or review.get("open_bugs") != []:raise IntegrationError("actual_target_review_PASS_required")
    actual_semantic="performed";actual_hash=sha(a.actual_review_receipt)
   for item in a.repository:
    if git(item["path"],"rev-parse",item["target_ref"])!=item["candidate_sha"]:raise IntegrationError("actual target moved during validation/review")
   verify_nested_owners(a.repository,a.controller_checkout)
   validation_receipt={"validation":validations,"deterministic_actual_target_validation":"passed","actual_review_sha256":actual_hash,"target_refs":{item["name"]:{"target_ref":item["target_ref"],"reviewed_tip":item["candidate_sha"]} for item in a.repository}};validation_hash=hashlib.sha256(json.dumps(validation_receipt,sort_keys=True).encode()).hexdigest()
   tag_required=effective in {"high","release"};tag_requested=tag_required or a.feature_tag
   feature=tag(a.repository[-1]["path"],a.task_id,integrated,a.repository[-1]["target_ref"],candidate_hash,validation_hash) if tag_requested else None
   tag_policy={"required":tag_required,"requested":a.feature_tag,"created":feature is not None,"status":"created" if feature else "skipped_by_policy"}
   receipt.update({"outcome":"integrated","passed":True,"feature_tag":feature,"feature_tag_policy":tag_policy,"actual_semantic_review":actual_semantic,"candidate_receipt_sha256":candidate_hash,"actual_target":validation_receipt,"lock_order":[x["lock_key"] for x in validated],"runtime_identities":runtime_identities(detaches,a.repository)})
  finally:
   for h in reversed(handles):fcntl.flock(h.fileno(),fcntl.LOCK_UN);h.close()
 except (IntegrationError,lifecycle.LifecycleError,OSError,json.JSONDecodeError,subprocess.TimeoutExpired) as exc:
  receipt.update({"passed":False,"error":str(exc),"runtime_identities":runtime_identities(detaches,a.repository)})
  receipt["outcome"]="partial_local_integration" if any(update.get("status") in {"moved","resumed_already_moved"} for update in receipt["updates"]) else "failed_preserved"
  if receipt["updates"] and not receipt.get("resume_stage"):receipt["resume_stage"]="target_updates"
  try:write(a.output,receipt,replace=a.output.resolve().exists())
  except Exception as write_exc:print(f"integration_owner_preflight: receipt error: {write_exc}",file=sys.stderr)
  print(f"integration_owner_preflight: error: {exc}",file=sys.stderr);return 2
 write(a.output,receipt,replace=True);print(json.dumps({"schema_version":SCHEMA,"passed":True,"outcome":"integrated","feature_tag":receipt["feature_tag"]},sort_keys=True));return 0
if __name__=="__main__":raise SystemExit(main())
