# Migrate a Juno Code v1 project to the v2 checkout architecture

Own a preservation-first local migration from a checkout that mixes product work, Juno/Kanban state, and integration into the v2 controller plus exact-base task-worktree architecture. This portable prompt must not assume a Juno Code source tree or conventional target branch.

Invocation authorizes inventory, reviewed controller registration, local named task-worktree creation, bootstrap implementation, risk-tiered semantic review gates, expected-SHA local target integration, typed cleanup, and durable receipts. It does not authorize Kanban data conversion, push, publication, package release, deployment, production mutation, post-deploy E2E, destructive cleanup, or discarding existing work.

## Target architecture

```text
controller checkout on a named ops branch
  -> canonical Kanban/Juno writes, prompts, orchestration, sessions, receipts
  -> never supplies a product base or advances a product target

N named task worktrees from exact approved target SHAs
  -> implementation, tests, coherent commits
  -> Kanban/session writes route to the controller

reviewed target channel per (Git common directory, full target ref)
  -> candidate review, expected-SHA CAS, actual-target validation/review
  -> no implicit push/release/deploy authority
```

These are roles and channels, not a permanent directory count. `JUNO_TASK_ROOT` always names the controller/Kanban root; product commands receive explicit worktree paths such as `TASK_ROOT`.

## Non-negotiable safety rules

- Never auto-stash, reset, clean, discard, detach, silently switch refs, force-remove/delete, overwrite registration, or rewind a partial integration.
- Preserve staged, tracked, untracked, ignored-but-important, submodule, nested-repository, and existing-worktree state until classified by an owner.
- Never implement product changes in the controller, including small fixes. Controller dirt is not an integration input.
- Keep executable selection, project bootstrap, controller registration, session adoption, Kanban data conversion, local integration, push, publication, release, and deployment as separate decisions.
- If legacy NDJSON Kanban is active, preserve it and use the separate Kanban migration prompt. Source Git ref changes never convert or roll back board data.
- Durable migration evidence must not exist only under `/tmp`.

## Phase A — inventory and manifest

Before mutation, record:

1. Project root, Git common directory, all worktrees, exact refs/HEADs/upstreams/remotes, current status/diffs, nested repositories, and active writers.
2. Owner-approved controller path/ref and exact product `refs/heads/...` target per changed repository. Never infer `main`, `master`, or another conventional target.
3. Juno/Kanban executable paths, versions, source policies, controller registration, roles, session locations, storage format, and generated/runtime script identity.
4. Exact task paths/branch refs, expected base SHAs, expected changed paths, validation commands, cleanup owner, durable artifact root, and semantic reviewers.
5. Separate authority decisions for local integration, push, publication, release, deployment, production mutation, and E2E.

Stop on ambiguous ownership/ref identity, unresolved nested targets, unclassified product dirt, active conflicting writers, or unexpected existing task paths/branches.

## Phase B — preserve and register the controller

If the combined checkout still owns the approved product target, preserve its complete state and create an owner-approved named controller branch at the recorded SHA. Do not stash/copy its dirt or move the product target. Capture before/after branch, HEAD, status hashes, and target-ref SHA.

Install/select the exact reviewed V2 runtime without changing Kanban data. Register the controller using the installed resolver and set controller/task/integration roles per process. Prove:

```text
controller + Kanban/Juno/orchestration -> accepted
task worktree + controller-routed Kanban/session writes -> accepted
task worktree + product edits -> accepted
controller + product edits -> refused by workflow policy
integration/release workspace + Kanban/orchestration/session writes -> refused
invalid controller path/ref -> fails closed without branch switching
```

Controller checkpointing is local durability only. It is not a product input or integration gate.

## Phase C — exact-base bootstrap worktree

Use `.juno_task/scripts/worktree_lifecycle.py create` with the approved full target ref and expected SHA. A narrow fetch may bind `FETCH_HEAD`, but must not pre-advance the target. Every product mutation uses this named worktree; there is no direct small-fix lane.

In the task worktree, install/update the project V2 scripts, managed prompts, lifecycle wiki, resolver registration, role guidance, and required ignore/config state. Preserve customized managed assets through checksum conflict candidates unless explicit force replacement is separately reviewed. Validate runtime/template/dist parity, routing, workspace refusals, focused tests, full project tests, typecheck/build where applicable, and one coherent bootstrap commit.

Do not convert Kanban, copy controller-private state into the task worktree, globally replace an unrelated stable runtime, mutate product target refs, or introduce dual migration/adaptor truth.

## Phase D — three review gates and local integration

1. Produce an independent `pre_merge` PASS receipt bound to the migration manifest/PDR, complete diff, expected paths, commits, validations, and open-bug set.
2. Run `integration_candidate.py plan` and `build`. Use the reviewed task tip directly only when the target remains its ancestor; otherwise build a both-parent candidate at the exact current target. Conflicts preserve evidence.
3. Run deterministic candidate verification. Direct candidates reuse pre-merge review; composed candidates require a `candidate` PASS receipt. Target movement requires rebuild and re-review.
4. Run `integration_owner_preflight.py integrate` as the directly executed owner in an argv-list workflow command (optionally prefixed by `python3`), with declared risk and explicit `--checked-out-target detach_same_sha`; never use a shell string or wrapper. It preserves active processes, performs expected-SHA CAS, and always validates the actual target; effective high/release also requires semantic actual review.
5. For nested repositories, integrate child targets before the root and bind child candidate SHAs to root gitlinks. A later failure is truthful `partial_local_integration`; never rewind or claim success.
6. Require an integrated receipt. High/release requires a local `juno-feature/<task>/<sha>` tag; low/medium tagging is opt-in. Report the local target separately from the remote.

An authorized workflow declares:

```yaml
schema_version: 2
workflow_class: local_integration
risk_tier: <low|medium|high|release>
integration_policy:
  queue: automatic_after_review_pass
  channel_scope: git_common_dir_and_target_ref
  target_movement: rebuild_and_rereview
  checked_out_target: detach_same_sha
validation_ownership:
  pre_merge_review: <step-id>
  candidate_review: <step-id>
  actual_target_review: <integration-step-id>
```

Every typed receipt `required_fields` list includes `producer_step_digest`, and its producer writes the matching `JUNO_WORKFLOW_STEP_DIGEST` value.

## Phase E — specialization and cleanup

Write an owner-reviewed specialization policy with schema version 2, the exact controller path/ref, task path/branch conventions, and one repository entry for the root plus every changed nested repository. Each repository entry names its path, exact target ref, optional fetched remote ref, exact-base policy, target-channel policy, target-movement policy, pre-merge validation, and actual-target validation.

Render it with:

```bash
yy prompts specialize-clean-worktree \
  --policy-file "$REVIEWED_WORKTREE_POLICY_JSON" \
  --cwd "$BOOTSTRAP_TASK"
```

Read back the specialized prompt, macro mapping, receipt/hash, and exact targets. Missing/mismatched entries are terminal ambiguity. Routine managed updates preserve the specialization and emit a candidate.

Use `worktree_lifecycle.py cleanup` only after actual-target PASS, reachability proof, clean/inactive task state, and nested cleanup. Never force. Persist the cleanup audit and prune-dry-run receipt.

## Final report

Report controller/task paths and roles; original target and exact task base; reviewed task/candidate/integrated SHAs; three review receipts; validation and feature-tag identities; runtime/template/dist parity; Kanban storage disposition; local target versus remote/push state; cleanup disposition; and every preserved blocker with the safest next command.
