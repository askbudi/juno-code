#!/usr/bin/env python3
"""Plan, build, and verify immutable reviewed integration candidates."""
from __future__ import annotations
import argparse, hashlib, json, os, subprocess, sys
from pathlib import Path
from typing import Any
SCHEMA = "juno_integration_candidate.v2"
class CandidateError(Exception): pass

def run(repo: Path, *args: str, check: bool=True) -> subprocess.CompletedProcess[str]:
    result=subprocess.run(["git","-C",str(repo),*args],text=True,capture_output=True,stdin=subprocess.DEVNULL,env={**os.environ,"GIT_OPTIONAL_LOCKS":"0"})
    if check and result.returncode: raise CandidateError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result

def git(repo: Path,*args: str,check: bool=True)->str:return run(repo,*args,check=check).stdout.strip()
def full_ref(value:str)->str:
    if not value.startswith("refs/heads/"): raise CandidateError("target ref must be a full refs/heads/... name")
    return value

def load_pass(path:Path,kind:str,tip:str|None=None)->dict[str,Any]:
    value=json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema_version") != "juno_review.v1" or value.get("review_kind") != kind or value.get("passed") is not True: raise CandidateError(f"required {kind} PASS receipt missing")
    if tip and value.get("reviewed_tip") != tip: raise CandidateError(f"{kind} reviewed_tip mismatch")
    if value.get("open_bugs") != []: raise CandidateError(f"{kind} must explicitly record no open bugs")
    return value

def paths(repo:Path,old:str,new:str)->list[str]: return sorted(set(git(repo,"diff","--name-only",old,new).splitlines()))
def write(path:Path,payload:dict[str,Any])->None:
    encoded=json.dumps(payload,indent=2,sort_keys=True)+"\n"; path=path.resolve()
    if path.exists() and path.read_text()!=encoded: raise CandidateError(f"immutable receipt collision: {path}")
    path.parent.mkdir(parents=True,exist_ok=True); path.write_text(encoded)

def plan(args:argparse.Namespace)->dict[str,Any]:
    repo=args.repository.resolve(); target_ref=full_ref(args.target_ref); target=git(repo,"rev-parse",f"{target_ref}^{{commit}}")
    tip=git(repo,"rev-parse",f"{args.reviewed_tip}^{{commit}}"); base=git(repo,"rev-parse",f"{args.base_sha}^{{commit}}")
    load_pass(args.premerge_review,"pre_merge",tip)
    if run(repo,"merge-base","--is-ancestor",base,tip,check=False).returncode: raise CandidateError("reviewed tip does not descend from base")
    task_paths=paths(repo,base,tip); target_paths=paths(repo,base,target)
    expected=sorted(set(args.expected_path)); unexpected=sorted(path for path in task_paths if expected and not any(path==prefix or path.startswith(prefix.rstrip("/")+"/") for prefix in expected))
    if unexpected: raise CandidateError("unexpected task paths: "+",".join(unexpected))
    direct=run(repo,"merge-base","--is-ancestor",target,tip,check=False).returncode==0
    strategy="direct" if direct else "merge_both_parents"
    task_worktree=args.task_worktree.resolve()
    if git(task_worktree,"rev-parse","HEAD")!=tip or git(task_worktree,"status","--porcelain=v2","--untracked-files=all"):raise CandidateError("reviewed task worktree must be exact and clean")
    payload={"schema_version":SCHEMA,"operation":"plan","task_id":args.task_id,"repository":str(repo),"target_ref":target_ref,
      "base_sha":base,"reviewed_tip":tip,"task_worktree":str(task_worktree),"expected_target_sha":target,"strategy":strategy,"task_paths":task_paths,
      "target_paths":target_paths,"overlap_paths":sorted(set(task_paths)&set(target_paths)),"expected_paths":expected,
      "premerge_review_sha256":hashlib.sha256(args.premerge_review.read_bytes()).hexdigest(),"premerge_review":load_pass(args.premerge_review,"pre_merge",tip),"pdr_matrix":json.loads(args.pdr_matrix.read_text())}
    if not isinstance(payload["pdr_matrix"],dict) or not payload["pdr_matrix"] or any(v!="PASS" for v in payload["pdr_matrix"].values()): raise CandidateError("PDR matrix must be non-empty and contain only PASS values")
    write(args.output,payload);return payload

def build(args:argparse.Namespace)->dict[str,Any]:
    plan_data=json.loads(args.plan.read_text()); repo=Path(plan_data["repository"])
    if plan_data.get("schema_version")!=SCHEMA or plan_data.get("operation")!="plan":raise CandidateError("invalid plan receipt")
    if git(repo,"rev-parse",f"{plan_data['target_ref']}^{{commit}}")!=plan_data["expected_target_sha"]:raise CandidateError("stale_target_replan_required")
    task_worktree=Path(plan_data["task_worktree"])
    if git(task_worktree,"rev-parse","HEAD")!=plan_data["reviewed_tip"] or git(task_worktree,"status","--porcelain=v2","--untracked-files=all"):
      raise CandidateError("moved_or_dirty_task_tip")
    candidate=plan_data["reviewed_tip"]; candidate_path=Path(plan_data["task_worktree"])
    try:
      if plan_data["strategy"]=="merge_both_parents":
        candidate_path=args.candidate_path.resolve()
        if candidate_path.exists():raise CandidateError("candidate path collision")
        git(repo,"worktree","add","--detach",str(candidate_path),plan_data["expected_target_sha"])
        merged=run(candidate_path,"merge","--no-ff","--no-edit",plan_data["reviewed_tip"],check=False)
        if merged.returncode:raise CandidateError("candidate_merge_conflict: "+merged.stderr.strip())
        candidate=git(candidate_path,"rev-parse","HEAD")
        parents=git(candidate_path,"show","-s","--format=%P",candidate).split()
        if parents!=[plan_data["expected_target_sha"],plan_data["reviewed_tip"]]:raise CandidateError("candidate_parent_identity_mismatch")
      work=Path(candidate_path)
      if git(work,"status","--porcelain=v2","--untracked-files=all"):raise CandidateError("dirty_candidate")
      candidate_paths=paths(repo,plan_data["expected_target_sha"],candidate)
      expected=plan_data["expected_paths"]
      unexpected=sorted(path for path in candidate_paths if expected and not any(path==prefix or path.startswith(prefix.rstrip("/")+"/") for prefix in expected))
      if unexpected:raise CandidateError("unexpected candidate paths: "+",".join(unexpected))
      validations=[]
      for command in args.validation_command:
        result=subprocess.run(command,shell=True,cwd=work,text=True,capture_output=True,stdin=subprocess.DEVNULL,timeout=args.validation_timeout)
        validations.append({"command_sha256":hashlib.sha256(command.encode()).hexdigest(),"exit_code":result.returncode})
        if result.returncode:raise CandidateError("candidate_validation_failed")
      payload={**plan_data,"operation":"build","candidate_sha":candidate,"candidate_path":str(candidate_path) if candidate_path else None,
       "candidate_paths":candidate_paths,"candidate_bytes_changed_by_composition":candidate != plan_data["reviewed_tip"],
       "validation":validations,"eligible":False,"plan_sha256":hashlib.sha256(args.plan.read_bytes()).hexdigest()}
      write(args.output,payload);return payload
    except Exception:
      # Conflicted candidate is preserved for diagnosis as required.
      raise

def verify(args:argparse.Namespace)->dict[str,Any]:
    candidate=json.loads(args.candidate.read_text()); tip=candidate.get("candidate_sha")
    if candidate.get("schema_version")!=SCHEMA or candidate.get("operation")!="build" or candidate.get("eligible") is not False:
      raise CandidateError("valid ineligible build receipt required")
    validations=candidate.get("validation")
    if not isinstance(validations,list) or not validations or any(item.get("exit_code")!=0 for item in validations):
      raise CandidateError("successful candidate validation evidence required")
    composed = candidate.get("candidate_bytes_changed_by_composition") is True
    if composed:
      if args.candidate_review is None: raise CandidateError("composed candidate semantic review required")
      load_pass(args.candidate_review,"candidate",tip)
      review_source="candidate"; review_hash=hashlib.sha256(args.candidate_review.read_bytes()).hexdigest()
    else:
      pre=candidate.get("premerge_review")
      if not isinstance(pre,dict) or pre.get("reviewed_tip") != tip: raise CandidateError("direct candidate pre-merge review identity missing")
      review_source="pre_merge"; review_hash=candidate["premerge_review_sha256"]
    repo=Path(candidate["repository"])
    if git(repo,"rev-parse",f"{candidate['target_ref']}^{{commit}}")!=candidate["expected_target_sha"]:raise CandidateError("stale_target_rebuild_review_required")
    candidate_path=Path(candidate.get("candidate_path") or "")
    if not candidate.get("candidate_path") or git(candidate_path,"rev-parse","HEAD")!=tip or git(candidate_path,"status","--porcelain=v2","--untracked-files=all"):
      raise CandidateError("moved_or_dirty_candidate")
    payload={**candidate,"operation":"verify","eligible":True,"candidate_receipt_sha256":hashlib.sha256(args.candidate.read_bytes()).hexdigest(),
             "candidate_semantic_review_source":review_source,"candidate_review_sha256":review_hash}
    write(args.output,payload);return payload

def parser()->argparse.ArgumentParser:
 p=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);s=p.add_subparsers(dest="command",required=True)
 q=s.add_parser("plan",allow_abbrev=False);q.set_defaults(func=plan)
 q.add_argument("--repository",type=Path,required=True);q.add_argument("--target-ref",required=True);q.add_argument("--base-sha",required=True);q.add_argument("--reviewed-tip",required=True);q.add_argument("--task-worktree",type=Path,required=True);q.add_argument("--task-id",required=True);q.add_argument("--expected-path",action="append",default=[]);q.add_argument("--premerge-review",type=Path,required=True);q.add_argument("--pdr-matrix",type=Path,required=True);q.add_argument("--output",type=Path,required=True)
 q=s.add_parser("build",allow_abbrev=False);q.set_defaults(func=build);q.add_argument("--plan",type=Path,required=True);q.add_argument("--candidate-path",type=Path,required=True);q.add_argument("--validation-command",action="append",required=True);q.add_argument("--validation-timeout",type=float,default=1800);q.add_argument("--output",type=Path,required=True)
 q=s.add_parser("verify",allow_abbrev=False);q.set_defaults(func=verify);q.add_argument("--candidate",type=Path,required=True);q.add_argument("--candidate-review",type=Path);q.add_argument("--output",type=Path,required=True)
 return p
def main(argv:list[str]|None=None)->int:
 try:
  a=parser().parse_args(argv);v=a.func(a);print(json.dumps({"schema_version":SCHEMA,"operation":v["operation"],"candidate_sha":v.get("candidate_sha"),"eligible":v.get("eligible",False)},sort_keys=True));return 0
 except (CandidateError,OSError,json.JSONDecodeError,subprocess.TimeoutExpired) as e:print(f"integration_candidate: error: {e}",file=sys.stderr);return 2
if __name__=="__main__":raise SystemExit(main())
