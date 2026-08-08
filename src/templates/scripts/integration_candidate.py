#!/usr/bin/env python3
"""Plan, build, and verify immutable reviewed integration candidates."""
from __future__ import annotations
import argparse, datetime as dt, hashlib, json, os, subprocess, sys, uuid
from pathlib import Path
from typing import Any
sys.path.insert(0,str(Path(__file__).resolve().parent))
import controller_checkpoint
SCHEMA = "juno_integration_candidate.v2"
TARGET_PREFLIGHT_SCHEMA = "juno_integration_target_preflight.v1"
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

def load_waiver(path:Path,tip:str)->dict[str,Any]:
    value=json.loads(path.read_text(encoding="utf-8"))
    if (value.get("schema_version")!="juno_owner_review_waiver.v1" or value.get("status")!="waived_by_owner"
            or value.get("candidate_sha")!=tip or value.get("review_passed") is not False):
        raise CandidateError("exact candidate-bound owner waiver required")
    if value.get("objective_risk") not in {"low","medium","high"} or value.get("effective_risk") not in {"low","medium","high"}:
        raise CandidateError("owner waiver risk truth missing")
    return value

def paths(repo:Path,old:str,new:str)->list[str]: return sorted(set(git(repo,"diff","--name-only",old,new).splitlines()))
def write(path:Path,payload:dict[str,Any])->None:
    encoded=json.dumps(payload,indent=2,sort_keys=True)+"\n"; path=path.resolve()
    if path.exists():
      if path.read_text()!=encoded: raise CandidateError(f"immutable receipt collision: {path}")
      return
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
      with temporary.open("w",encoding="utf-8") as handle:
       handle.write(encoded);handle.flush();os.fsync(handle.fileno())
      os.replace(temporary,path)
    finally: temporary.unlink(missing_ok=True)

def write_blob(path:Path,value:str)->dict[str,Any]:
    encoded=value.encode("utf-8",errors="replace");path=path.resolve()
    if path.exists():
      if path.read_bytes()!=encoded:raise CandidateError(f"immutable validation artifact collision: {path}")
    else:
      path.parent.mkdir(parents=True,exist_ok=True)
      temporary=path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
      try:
       with temporary.open("wb") as handle:
        handle.write(encoded);handle.flush();os.fsync(handle.fileno())
       os.replace(temporary,path)
      finally:temporary.unlink(missing_ok=True)
    return {"path":str(path),"sha256":hashlib.sha256(encoded).hexdigest(),"bytes":len(encoded)}

def output_text(value:Any)->str:
    if value is None:return ""
    if isinstance(value,bytes):return value.decode("utf-8",errors="replace")
    return str(value)

def classify_target(repo:Path,target_ref_value:str,approved_base:str)->dict[str,Any]:
    """Canonical read-only target/base classifier shared by lifecycle admission."""
    repo=repo.resolve();target_ref=full_ref(target_ref_value)
    common_dir=Path(git(repo,"rev-parse","--path-format=absolute","--git-common-dir")).resolve()
    approved_result=run(repo,"rev-parse",f"{approved_base}^{{commit}}",check=False)
    if approved_result.returncode:raise CandidateError("approved base is not a readable commit")
    approved=approved_result.stdout.strip()
    target_result=run(repo,"rev-parse","--verify",f"{target_ref}^{{commit}}",check=False)
    observed=target_result.stdout.strip() if target_result.returncode==0 else None
    if observed is None:classification="missing_target";ancestry=False;safe_action="refuse_missing_target"
    elif observed==approved:classification="exact";ancestry=True;safe_action="continue_exact_base_policy"
    elif run(repo,"merge-base","--is-ancestor",approved,observed,check=False).returncode==0:
      classification="advanced_descendant";ancestry=True;safe_action="snapshot_then_rebuild_and_rereview"
    else:classification="invalid_rewind_or_divergence";ancestry=False;safe_action="refuse_history_change"
    return {"repository":str(repo),"git_common_dir":str(common_dir),"target_ref":target_ref,
      "approved_base":approved,"observed_target_sha":observed,"classification":classification,
      "approved_base_is_ancestor":ancestry,"safe_next_action":safe_action,
      "passed":classification in {"exact","advanced_descendant"}}

def require_committed_tree(repo:Path,fallback_base:str)->dict[str,Any]:
    try:return controller_checkpoint.committed_admission(repo,fallback_base)
    except controller_checkpoint.CheckpointError as exc:raise CandidateError(f"committed-tree admission refused: {exc}") from exc

def require_target_channel_owner(repo:Path,declared_owner:Path,base_sha:str)->dict[str,Any]:
    """Read-only first-use audit for the exact checkout that will own target CAS."""
    repo=repo.resolve();declared=declared_owner.resolve()
    root=Path(git(declared,"rev-parse","--show-toplevel")).resolve()
    if declared!=repo or root!=repo:raise CandidateError("target-channel owner must exactly match --repository Git root")
    git_dir=Path(git(repo,"rev-parse","--path-format=absolute","--git-dir")).resolve()
    common_dir=Path(git(repo,"rev-parse","--path-format=absolute","--git-common-dir")).resolve()
    if git_dir==common_dir:raise CandidateError("target-channel owner must be a dedicated linked checkout")
    persisted=git(repo,"config","--worktree","--get","juno.workspace.role",check=False) or None
    authority=git(repo,"config","--worktree","--get","juno.workspace.roleAuthority",check=False) or None
    if persisted not in {None,"integration-owner"}:raise CandidateError(f"target-channel owner has incompatible persisted role: {persisted}")
    if persisted=="integration-owner" and authority!="protected-integration.v1":raise CandidateError("integration-owner lacks protected integration authority")
    try:
      audit=controller_checkpoint.committed_admission(repo,base_sha,protected_role_override="integration-owner")
    except controller_checkpoint.CheckpointError as exc:
      raise CandidateError(f"committed-tree admission refused: {exc}") from exc
    base=git(repo,"rev-parse",f"{base_sha}^{{commit}}")
    head=git(repo,"rev-parse","HEAD")
    if head!=base:raise CandidateError("target-channel owner must remain at the exact approved base")
    if git(repo,"status","--porcelain=v2","--untracked-files=all"):raise CandidateError("target-channel owner must be clean")
    return {"intent":"target_channel_owner","repository":str(repo),"git_common_dir":str(common_dir),
      "git_dir":str(git_dir),"head":head,"base_sha":base,"persisted_role":persisted,
      "protected_authority_persisted":persisted=="integration-owner","committed_tree_admission":audit,
      "read_only":True,"role_persisted_by_planning":False}

def target_preflight(args:argparse.Namespace)->dict[str,Any]:
    require_committed_tree(args.repository,args.approved_base)
    snapshot=classify_target(args.repository,args.target_ref,args.approved_base)
    payload={
      "schema_version":TARGET_PREFLIGHT_SCHEMA,"operation":"target_preflight",**snapshot,
      "producer_step_digest":os.environ.get("JUNO_WORKFLOW_STEP_DIGEST", ""),
      "observed_at":dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00","Z"),
    }
    write(args.output,payload)
    if not payload["passed"]: raise CandidateError(str(payload["classification"]))
    return payload

def plan(args:argparse.Namespace)->dict[str,Any]:
    repo=args.repository.resolve(); target_ref=full_ref(args.target_ref); target=git(repo,"rev-parse",f"{target_ref}^{{commit}}")
    planning=(require_target_channel_owner(repo,args.target_channel_owner,args.base_sha) if args.target_channel_owner else
              {"intent":"registered_repository","committed_tree_admission":require_committed_tree(repo,args.base_sha)})
    tip=git(repo,"rev-parse",f"{args.reviewed_tip}^{{commit}}"); base=git(repo,"rev-parse",f"{args.base_sha}^{{commit}}")
    if bool(args.premerge_review)==bool(args.owner_waiver): raise CandidateError("exactly one pre-merge PASS or owner waiver is required")
    acceptance=load_pass(args.premerge_review,"pre_merge",tip) if args.premerge_review else load_waiver(args.owner_waiver,tip)
    acceptance_status="passed" if args.premerge_review else "waived_by_owner"
    if run(repo,"merge-base","--is-ancestor",base,tip,check=False).returncode: raise CandidateError("reviewed tip does not descend from base")
    if run(repo,"merge-base","--is-ancestor",base,target,check=False).returncode: raise CandidateError("invalid_rewind_or_divergence")
    task_paths=paths(repo,base,tip); target_paths=paths(repo,base,target)
    expected=sorted(set(args.expected_path)); unexpected=sorted(path for path in task_paths if expected and not any(path==prefix or path.startswith(prefix.rstrip("/")+"/") for prefix in expected))
    if unexpected: raise CandidateError("unexpected task paths: "+",".join(unexpected))
    direct=run(repo,"merge-base","--is-ancestor",target,tip,check=False).returncode==0
    strategy="direct" if direct else "merge_both_parents"
    task_worktree=args.task_worktree.resolve()
    if git(task_worktree,"rev-parse","HEAD")!=tip or git(task_worktree,"status","--porcelain=v2","--untracked-files=all"):raise CandidateError("reviewed task worktree must be exact and clean")
    payload={"schema_version":SCHEMA,"operation":"plan","task_id":args.task_id,"repository":str(repo),"target_ref":target_ref,
      "base_sha":base,"reviewed_tip":tip,"task_worktree":str(task_worktree),"expected_target_sha":target,"strategy":strategy,"task_paths":task_paths,
      "target_channel_planning":planning,"target_paths":target_paths,"overlap_paths":sorted(set(task_paths)&set(target_paths)),"expected_paths":expected,
      "premerge_review_sha256":hashlib.sha256((args.premerge_review or args.owner_waiver).read_bytes()).hexdigest(),
      "premerge_review":acceptance,"review_status":acceptance_status,"review_passed":acceptance_status=="passed",
      "pdr_matrix":json.loads(args.pdr_matrix.read_text())}
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
      validations=[];artifacts=args.output.resolve().parent/f"{args.output.name}.artifacts"
      for index,command in enumerate(args.validation_command,start=1):
        timed_out=False
        try:
          result=subprocess.run(command,shell=True,cwd=work,text=True,capture_output=True,stdin=subprocess.DEVNULL,timeout=args.validation_timeout)
          exit_code=result.returncode;stdout=output_text(result.stdout);stderr=output_text(result.stderr)
        except subprocess.TimeoutExpired as exc:
          timed_out=True;exit_code=None;stdout=output_text(exc.stdout);stderr=output_text(exc.stderr)
        stdout_artifact=write_blob(artifacts/f"validation-{index:03d}.stdout.txt",stdout)
        stderr_artifact=write_blob(artifacts/f"validation-{index:03d}.stderr.txt",stderr)
        validation={"index":index,"command_sha256":hashlib.sha256(command.encode()).hexdigest(),"cwd":str(work.resolve()),
          "exit_code":exit_code,"timed_out":timed_out,"stdout":stdout_artifact,"stderr":stderr_artifact}
        validations.append(validation)
        if timed_out or exit_code:
          failure={"code":"candidate_validation_timeout" if timed_out else "candidate_validation_failed","validation_index":index,
            "command_sha256":validation["command_sha256"],"exit_code":exit_code,"timed_out":timed_out}
          failed={**plan_data,"operation":"build_failed","candidate_sha":candidate,"candidate_path":str(candidate_path),
            "candidate_paths":candidate_paths,"candidate_bytes_changed_by_composition":candidate!=plan_data["reviewed_tip"],
            "validation":validations,"failure":failure,"eligible":False,"plan_sha256":hashlib.sha256(args.plan.read_bytes()).hexdigest()}
          write(args.output,failed)
          raise CandidateError(f"{failure['code']}: validation_index={index}; receipt={args.output.resolve()}")
      payload={**plan_data,"operation":"build","candidate_sha":candidate,"candidate_path":str(candidate_path) if candidate_path else None,
       "candidate_paths":candidate_paths,"candidate_bytes_changed_by_composition":candidate != plan_data["reviewed_tip"],
       "validation":validations,"eligible":False,"plan_sha256":hashlib.sha256(args.plan.read_bytes()).hexdigest()}
      write(args.output,payload);return payload
    except Exception:
      # Conflicted or failed candidates and their typed evidence are preserved for diagnosis.
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
      if not isinstance(pre,dict): raise CandidateError("direct candidate semantic acceptance identity missing")
      reviewed_identity=pre.get("reviewed_tip") if candidate.get("review_status")=="passed" else pre.get("candidate_sha")
      if reviewed_identity != tip: raise CandidateError("direct candidate semantic acceptance identity missing")
      review_source="pre_merge"; review_hash=candidate["premerge_review_sha256"]
    repo=Path(candidate["repository"])
    if git(repo,"rev-parse",f"{candidate['target_ref']}^{{commit}}")!=candidate["expected_target_sha"]:raise CandidateError("stale_target_rebuild_review_required")
    candidate_path=Path(candidate.get("candidate_path") or "")
    if not candidate.get("candidate_path") or git(candidate_path,"rev-parse","HEAD")!=tip or git(candidate_path,"status","--porcelain=v2","--untracked-files=all"):
      raise CandidateError("moved_or_dirty_candidate")
    if candidate.get("strategy")=="merge_both_parents":
      parents=git(candidate_path,"show","-s","--format=%P",tip).split()
      if parents != [candidate["expected_target_sha"],candidate["reviewed_tip"]]: raise CandidateError("candidate_parent_identity_mismatch")
    elif tip != candidate.get("reviewed_tip"):
      raise CandidateError("direct_candidate_identity_mismatch")
    payload={**candidate,"operation":"verify","eligible":True,"candidate_receipt_sha256":hashlib.sha256(args.candidate.read_bytes()).hexdigest(),
             "candidate_semantic_review_source":review_source,"candidate_review_sha256":review_hash}
    write(args.output,payload);return payload

def parser()->argparse.ArgumentParser:
 p=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);s=p.add_subparsers(dest="command",required=True)
 q=s.add_parser("target-preflight",allow_abbrev=False);q.set_defaults(func=target_preflight)
 q.add_argument("--repository",type=Path,required=True);q.add_argument("--target-ref",required=True);q.add_argument("--approved-base",required=True);q.add_argument("--output",type=Path,required=True)
 q=s.add_parser("plan",allow_abbrev=False);q.set_defaults(func=plan)
 q.add_argument("--repository",type=Path,required=True);q.add_argument("--target-channel-owner",type=Path,help="explicit dedicated integration-owner checkout; enables the read-only protected first-use audit");q.add_argument("--target-ref",required=True);q.add_argument("--base-sha",required=True);q.add_argument("--reviewed-tip",required=True);q.add_argument("--task-worktree",type=Path,required=True);q.add_argument("--task-id",required=True);q.add_argument("--expected-path",action="append",default=[]);q.add_argument("--premerge-review",type=Path);q.add_argument("--owner-waiver",type=Path);q.add_argument("--pdr-matrix",type=Path,required=True);q.add_argument("--output",type=Path,required=True)
 q=s.add_parser("build",allow_abbrev=False);q.set_defaults(func=build);q.add_argument("--plan",type=Path,required=True);q.add_argument("--candidate-path",type=Path,required=True);q.add_argument("--validation-command",action="append",required=True);q.add_argument("--validation-timeout",type=float,default=1800);q.add_argument("--output",type=Path,required=True)
 q=s.add_parser("verify",allow_abbrev=False);q.set_defaults(func=verify);q.add_argument("--candidate",type=Path,required=True);q.add_argument("--candidate-review",type=Path);q.add_argument("--output",type=Path,required=True)
 return p
def main(argv:list[str]|None=None)->int:
 try:
  a=parser().parse_args(argv);v=a.func(a);print(json.dumps({"schema_version":v.get("schema_version",SCHEMA),"operation":v["operation"],"candidate_sha":v.get("candidate_sha"),"eligible":v.get("eligible",False),"classification":v.get("classification")},sort_keys=True));return 0
 except (CandidateError,OSError,json.JSONDecodeError,subprocess.TimeoutExpired) as e:print(f"integration_candidate: error: {e}",file=sys.stderr);return 2
if __name__=="__main__":raise SystemExit(main())
