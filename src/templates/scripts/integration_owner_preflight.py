#!/usr/bin/env python3
"""Receipt-gated, target-ref-scoped local integration with exact CAS updates."""
from __future__ import annotations
import argparse, fcntl, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path
from typing import Any
SCHEMA="juno_local_integration.v2"; TAG_RE=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
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
def write(path:Path,payload:dict[str,Any])->None:
 encoded=json.dumps(payload,indent=2,sort_keys=True)+"\n";path=path.resolve();path.parent.mkdir(parents=True,exist_ok=True)
 if path.exists() and path.read_text()!=encoded:raise IntegrationError(f"immutable receipt collision: {path}")
 path.write_text(encoded)
def load_candidate(path:Path,repositories:list[dict[str,Any]])->dict[str,Any]:
 value=json.loads(path.read_text());
 if value.get("schema_version")!="juno_integration_candidate.v1" or value.get("operation")!="verify" or value.get("eligible") is not True:raise IntegrationError("eligible verified candidate receipt required")
 validations=value.get("validation");matrix=value.get("pdr_matrix")
 if not isinstance(validations,list) or not validations or any(item.get("exit_code")!=0 for item in validations):raise IntegrationError("successful candidate validation evidence required")
 if not isinstance(matrix,dict) or not matrix or any(result!="PASS" for result in matrix.values()):raise IntegrationError("candidate PDR matrix PASS required")
 for field in ("premerge_review_sha256","candidate_review_sha256","candidate_receipt_sha256"):
  if not re.fullmatch(r"[0-9a-f]{64}",str(value.get(field) or "")):raise IntegrationError(f"candidate receipt missing {field}")
 if len(repositories)==1:
  item=repositories[0]
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

def validate_item(item:dict[str,Any])->dict[str,Any]:
 repo=item["path"]
 if index_lock(repo).exists():raise IntegrationError(f"index_lock_present: {index_lock(repo)}")
 worktrees=git(repo,"worktree","list","--porcelain").splitlines()
 if f"branch {item['target_ref']}" in worktrees:raise IntegrationError(f"target_ref_checked_out: {item['target_ref']}")
 actual=git(repo,"rev-parse",f"{item['target_ref']}^{{commit}}")
 if actual!=item["expected_sha"]:raise IntegrationError(f"stale_target name={item['name']} expected={item['expected_sha']} actual={actual}")
 candidate=git(repo,"rev-parse",f"{item['candidate_sha']}^{{commit}}")
 if candidate!=item["candidate_sha"]:raise IntegrationError("candidate identity mismatch")
 return {**item,"path":str(repo),"git_common_dir":str(common(repo)),"lock_key":lock_key(item),"before_sha":actual}
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
def main(argv:list[str]|None=None)->int:
 p=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);p.add_argument("integrate",nargs="?");p.add_argument("--repository",action="append",type=parse_repo,required=True);p.add_argument("--candidate-receipt",action="append",type=Path,required=True);p.add_argument("--gitlink",action="append",type=parse_gitlink,default=[]);p.add_argument("--actual-review-command",required=True);p.add_argument("--actual-review-receipt",type=Path,required=True);p.add_argument("--validation-command",action="append",required=True);p.add_argument("--validation-timeout",type=float,default=3600);p.add_argument("--lock-timeout",type=float,default=30);p.add_argument("--task-id",required=True);p.add_argument("--output",type=Path,required=True);p.add_argument("--inject-failure-after",type=int)
 a=p.parse_args(argv)
 if a.integrate not in (None,"integrate"):p.error("only the integrate subcommand is supported")
 if not 0<=a.lock_timeout<=300:p.error("--lock-timeout must be between 0 and 300 seconds")
 if not 0<a.validation_timeout<=86400:p.error("--validation-timeout must be between 0 and 86400 seconds")
 receipt:dict[str,Any]={"schema_version":SCHEMA,"outcome":"failed_preserved","task_id":a.task_id,"updates":[],"feature_tag":None}
 try:
  if len(a.candidate_receipt)!=len(a.repository):raise IntegrationError("one --candidate-receipt is required per --repository")
  candidates=[load_candidate(path,[repository]) for path,repository in zip(a.candidate_receipt,a.repository)]
  receipt_hashes=[sha(path) for path in a.candidate_receipt]
  candidate_hash=receipt_hashes[0] if len(receipt_hashes)==1 else hashlib.sha256("\n".join(receipt_hashes).encode()).hexdigest()
  verify_gitlinks(a.repository,a.gitlink)
  ordered=sorted(a.repository,key=lambda x:(str(common(x["path"])),x["target_ref"]));validated=[validate_item(i) for i in ordered]
  if len({x["lock_key"] for x in validated})!=len(validated):raise IntegrationError("duplicate integration channel")
  # Every candidate and exact target is validated before any official ref moves.
  handles=[]
  try:
   for item in validated:
    path=lock_file(item);path.parent.mkdir(parents=True,exist_ok=True);h=path.open("a+");acquire_bounded(h,a.lock_timeout);handles.append(h)
   # Revalidate every receipt, candidate worktree, gitlink and target under all
   # ordered locks, then update child-first in caller order.
   if [sha(path) for path in a.candidate_receipt]!=receipt_hashes:raise IntegrationError("candidate_receipt_changed_under_lock")
   candidates=[load_candidate(path,[repository]) for path,repository in zip(a.candidate_receipt,a.repository)]
   verify_gitlinks(a.repository,a.gitlink)
   by_name={x["name"]:x for x in validated}
   for original in a.repository:validate_item(original)
   for index,original in enumerate(a.repository):
    item=by_name[original["name"]]
    if a.inject_failure_after is not None and index>=a.inject_failure_after:raise IntegrationError("injected_update_failure")
    result=run(Path(item["path"]),"update-ref",item["target_ref"],item["candidate_sha"],item["expected_sha"],check=False)
    if result.returncode:raise IntegrationError(f"target_cas_failed name={item['name']}: {result.stderr.strip()}")
    after=git(Path(item["path"]),"rev-parse",item["target_ref"]);receipt["updates"].append({"name":item["name"],"target_ref":item["target_ref"],"before_sha":item["expected_sha"],"after_sha":after})
   for item in a.repository:
    if git(item["path"],"rev-parse",item["target_ref"])!=item["candidate_sha"]:raise IntegrationError("actual target readback mismatch")
   actual_cwd=Path(candidates[-1]["candidate_path"])
   if git(actual_cwd,"rev-parse","HEAD")!=a.repository[-1]["candidate_sha"] or git(actual_cwd,"status","--porcelain=v2","--untracked-files=all"):
    raise IntegrationError("actual target validation checkout moved or dirty")
   validations=[]
   for command in a.validation_command:
    r=subprocess.run(command,shell=True,cwd=actual_cwd,text=True,capture_output=True,stdin=subprocess.DEVNULL,timeout=a.validation_timeout)
    validations.append({"command_sha256":hashlib.sha256(command.encode()).hexdigest(),"exit_code":r.returncode})
    if r.returncode:raise IntegrationError("actual_target_validation_failed")
   review_run=subprocess.run(a.actual_review_command,shell=True,cwd=actual_cwd,text=True,capture_output=True,stdin=subprocess.DEVNULL,timeout=a.validation_timeout)
   if review_run.returncode:raise IntegrationError("actual_target_review_command_failed")
   review=json.loads(a.actual_review_receipt.read_text())
   integrated=a.repository[-1]["candidate_sha"]
   for item in a.repository:
    if git(item["path"],"rev-parse",item["target_ref"])!=item["candidate_sha"]:raise IntegrationError("actual target moved during validation/review")
   if git(actual_cwd,"rev-parse","HEAD")!=integrated or git(actual_cwd,"status","--porcelain=v2","--untracked-files=all"):
    raise IntegrationError("actual target validation checkout changed during validation/review")
   if review.get("schema_version")!="juno_review.v1" or review.get("review_kind")!="actual_target" or review.get("passed") is not True or review.get("reviewed_tip")!=integrated or review.get("open_bugs") != []:raise IntegrationError("actual_target_review_PASS_required")
   validation_receipt={"validation":validations,"actual_review_sha256":sha(a.actual_review_receipt)};validation_hash=hashlib.sha256(json.dumps(validation_receipt,sort_keys=True).encode()).hexdigest()
   feature=tag(a.repository[-1]["path"],a.task_id,integrated,a.repository[-1]["target_ref"],candidate_hash,validation_hash)
   receipt.update({"outcome":"integrated","passed":True,"feature_tag":feature,"candidate_receipt_sha256":candidate_hash,"actual_target":validation_receipt,"lock_order":[x["lock_key"] for x in validated]})
  finally:
   for h in reversed(handles):fcntl.flock(h.fileno(),fcntl.LOCK_UN);h.close()
 except (IntegrationError,OSError,json.JSONDecodeError,subprocess.TimeoutExpired) as exc:
  receipt.update({"passed":False,"error":str(exc)})
  if receipt["updates"]:receipt["outcome"]="partial_local_integration"
  try:write(a.output,receipt)
  except Exception as write_exc:print(f"integration_owner_preflight: receipt error: {write_exc}",file=sys.stderr)
  print(f"integration_owner_preflight: error: {exc}",file=sys.stderr);return 2
 write(a.output,receipt);print(json.dumps({"schema_version":SCHEMA,"passed":True,"outcome":"integrated","feature_tag":receipt["feature_tag"]},sort_keys=True));return 0
if __name__=="__main__":raise SystemExit(main())
