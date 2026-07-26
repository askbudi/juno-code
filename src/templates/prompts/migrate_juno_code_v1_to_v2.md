# Migrate a Juno Code v1 project to the v2 checkout architecture

Own a local, preservation-first migration from a v1 project where one product-target checkout mixes product implementation, Juno/Kanban control state, and integration, into the v2 controller/task/integration-owner architecture. This prompt is portable: do not assume a `juno-code/` source tree or README exists. Project wikis and `AGENTS.md` may add constraints when present, but all required baseline instructions are below.

Invocation authorizes inventory, local named branch/worktree creation, controller registration, a reviewed bootstrap task commit, and reviewed local fast-forward integration when every gate passes. It does **not** authorize Kanban v1-to-v2 data conversion, push, publication, deployment, production mutation, post-deploy E2E, destructive cleanup, or discarding existing work.

## Target architecture

```text
controller checkout on a named ops branch
  -> canonical Kanban/Juno mutation, prompts, orchestration, sessions, receipts
  -> never owns product implementation or integration-target advancement

one or more named task worktrees based on the approved product target
  -> implementation, focused tests, coherent task commits
  -> Kanban/session writes always route to the controller

clean integration-owner checkout on the exact approved target branch
  -> reviewed integration while repository lease is held
  -> integrated-target validation only; no Kanban/orchestration/session writes
```

These are three **roles**, not a permanent limit of three directories: parallel execution normally uses one controller, N task worktrees, and one integration owner.

`JUNO_TASK_ROOT` always means the canonical controller/Kanban root. It never means the product task worktree. Product commands must receive their checkout through `--cwd`, command-file `cwd`, an absolute path, or an explicit prompt variable such as `TASK_ROOT`.

## Non-negotiable safety rules

- Never auto-stash, reset, clean, discard, force-remove, force-delete, detach, silently switch refs, overwrite registration, or move an existing branch to manufacture compliance.
- Preserve staged, tracked, untracked, ignored-but-important, submodule, nested-repository, and existing-worktree state until classified by an owner.
- Do not run implementation or parallel workers in the controller. Do not run Juno/Kanban/workflows in the integration owner.
- Do not claim a clean task tree proves a clean controller or integration owner.
- Do not install v2 globally during acceptance. Prefer an isolated v2 executable/alias and record `command -v`, version, source, policy, and hashes.
- Keep source/executable selection, project bootstrap, controller registration, session-state adoption, Kanban data conversion, integration, push, and deployment as separate decisions.
- If the project uses legacy NDJSON Kanban, leave its active runtime/data untouched and hand it to the separate Kanban v1-to-v2 migration procedure.
- Before that handoff, record whether the owner wants `full-hot` storage or `active-hot/terminal-cold` storage. In either case the Kanban converter must consume the complete source; never prepare an active-only filtered NDJSON input.
- No `/tmp` artifact may be the only migration evidence. Persist the manifest and receipts under a reviewed project spec/run path or an owner-approved external durable path.

## Phase A — read-only discovery and migration manifest

Before mutation, discover rather than assume:

1. Project root, Git common directory, current checkout path, exact branch/ref, HEAD, upstream, remotes, default remote branch, and the owner-approved integration target. Never infer the target from a conventional branch name.
2. Full `git status --porcelain=v1 --untracked-files=all`, staged diff, unstaged diff, submodules, embedded repositories, and `git worktree list --porcelain`.
3. Every current process that may write Juno, Kanban, workflow, session, or Git state; identify the freeze/terminal owner.
4. Current Juno executable/version/source, Kanban executable/version/storage format, `.env.juno`, `.venv_juno`, `.juno_task` scripts/config/prompts, controller registration, workspace-role settings, and session metadata locations.
5. Which dirty paths are durable controller state, product implementation, generated/cache/runtime state, board state, submodule pointers, or unknown/unrelated work.
6. Exact proposed paths and branches:
   - existing checkout becoming controller: `<project-current>` on `juno/controller-v2` (or owner-approved equivalent);
   - integration owner: a new clean path owning the exact target branch;
   - bootstrap task: `/tmp/juno-code/worktrees/<migration-id>/<run-id>/<repo-slug>` on `juno/<migration-id>-<run-id>`;
   - durable artifact root and external integration receipt path.
7. Base SHA, expected bootstrap paths, validation commands, semantic reviewer, integration owner, cleanup owner, and permitted integration method.
8. Intended Kanban policy (`full-hot` or explicit hot/cold status sets), cross-tier reference inventory owner, and whether integration-owner creation is sequenced before or after accepted board cutover.

Write the manifest before changing refs. Stop for owner input if the current branch is not the approved target, the target is divergent/unknown, another worktree owns a proposed branch, nested repository targets are unresolved, existing dirt cannot be classified, or any path/branch already exists with unexpected state.

## Phase B — preserve the combined v1 checkout as controller

The common starting state is one checkout on the approved product target that owns controller state and may be dirty. Preserve it in place; do not attempt to copy or stash its dirt into another checkout.

After the manifest is reviewed, if and only if the current checkout still owns the recorded target branch and HEAD, create and switch it explicitly to a new controller branch:

```bash
git -C "$CURRENT_CHECKOUT" switch -c juno/controller-v2
```

This must create the branch at the recorded target SHA, carry the existing worktree/index unchanged, and leave the exact recorded product-target ref at its original SHA. Capture before/after branch, HEAD, status hashes, and target-ref SHA. If Git would overwrite/conflict or the branch exists unexpectedly, stop. Do not silently choose another branch.

Classify controller dirt again. Commit only reviewed durable controller-owned state in coherent commits. Do not mix unknown product changes, generated caches, or Kanban conversion into the architecture bootstrap. If controller state cannot yet be committed, preserve it and report that controller cleanliness remains independently blocked; do not fake cleanliness.

## Phase C — create the clean integration owner and bootstrap task

Once the target branch is no longer checked out by the controller, create a dedicated integration worktree on the exact target ref:

```bash
test -n "$INTEGRATION_TARGET_BRANCH" || exit 1
git -C "$CONTROLLER" worktree add "$INTEGRATION_OWNER" "$INTEGRATION_TARGET_BRANCH"
```

Require exact branch, expected HEAD, clean tracked/untracked status, no initialized dirty nested repository, and no active writer. Set strict role in its execution environment:

```bash
JUNO_WORKSPACE_ROLE=integration-owner
JUNO_WORKSPACE_ENFORCEMENT=strict
```

When a legacy board conversion is still pending, it is also valid to defer integration-owner creation until the board cutover and acceptance complete. Choose and record one sequence; do not alternate mid-run. Deferral can reduce routing ambiguity because the controller becomes canonical before strict refusal is tested.

Create the named bootstrap task worktree from the synchronized local target SHA, not merely a remote-tracking ref:

```bash
git -C "$CONTROLLER" worktree add \
  -b "juno/$MIGRATION_ID-$RUN_ID" \
  "$BOOTSTRAP_TASK" \
  "$SYNCHRONIZED_TARGET_SHA"
```

Require clean status, expected branch/HEAD/base ancestry, and recorded path ownership. For submodules/embedded repositories, create and record separate named branches/worktrees where their commits must change; never assume the superproject branch controls them.

## Phase D — isolated v2 executable and bootstrap implementation

Identify a reviewed Juno Code v2 executable without replacing normal global v1 tools. Acceptable sources include an owner-provided isolated alias, an installed v2 package in a dedicated prefix, or a reviewed source-toolchain installer. Record executable/version/source and verify its selected Kanban compatibility. If no isolated v2 executable exists, stop with exact installation options; do not curl/run unknown installers or use latest implicitly.

From the controller context, target the bootstrap task checkout explicitly to install/refresh v2 project scripts and skills. Prefer the supported equivalent of:

```bash
yy-v2 install-scripts --force --cwd "$BOOTSTRAP_TASK"
```

Capture help first and adapt only to the installed v2 command surface. Review every changed path. The bootstrap should establish, when supported:

- controller resolver and branch-verified registration;
- `controller`, `task`, and `integration-owner` role enforcement;
- orchestration and integration-owner guards;
- parallel/workflow runner environment propagation;
- canonical controller Kanban wrappers;
- volatile session metadata outside tracked product paths;
- prompts/skills needed for v2 operation;
- ignores for derived cache/lock/runtime state without hiding canonical board data.

It must not convert the Kanban board, copy controller-private task/session data into the task checkout, replace the global CLI, mutate the integration owner, or introduce migration/adaptor duplication.

Run focused installer/resolver/runner tests available in the project, syntax checks by actual file language, project build/typecheck, and a clean disposable linked-worktree routing smoke. Commit all and only bootstrap-owned changes on the task branch.

## Phase E — register and prove controller routing

Use the installed v2 resolver/tooling to register the existing controller path and exact controller branch for this Git repository. Registration is authoritative and must fail closed when stale, missing, detached, on the wrong branch, or from another Git common directory. It must never switch branches.

Repository-local controller path/branch registration may be shared by linked worktrees. Keep `controller`, `task`, and `integration-owner` role selection in each process environment unless Git worktree-specific config behavior is explicitly enabled and tested; do not write one shared role value that reclassifies every checkout.

Verify from controller, task, and integration-owner contexts:

```text
controller + orchestration -> resolves controller, permitted
controller + Kanban write  -> mutates only controller board
linked task + Kanban read/write -> resolves controller; task-local board unchanged
linked task + product edit -> edits only task worktree
integration owner + orchestration/session/Kanban under strict enforcement -> refused
all contexts -> Git refs and unrelated files unchanged by resolution
```

Test explicit `JUNO_TASK_ROOT`, repository-local registration, and current-root fallback separately. Reject an unrelated explicit root. Record diagnostics and before/after hashes. Do not adopt/migrate old tracked session metadata implicitly; inventory it and propose a separate explicit disposition.

If Kanban cutover occurs during this architecture migration, finalize controller artifacts intended for the pre-cutover history before running the converter. Keep controller HEAD at the machine-generated cutover commit until immediate rollback is accepted or waived. A later documentation/bootstrap commit changes the rollback class to post-write and must be recorded as such.

## Phase F — independent review and local integration

In a fresh context, build an acceptance matrix from this prompt, project instructions, manifest, installed v2 help, and available wikis before reading the implementation summary. Inspect complete base-to-tip diff, commits, statuses, generated files, tests, controller routing, role refusal, and no-conversion/no-global-replacement claims. Create a bug record before any review fix when canonical Kanban is safely available; otherwise write it to the durable migration artifact and reconcile later.

Only after review PASS:

1. Re-fetch the approved remote target and classify equal/local-behind/local-ahead/divergent. Stop on remote movement requiring an unapproved rebase/merge, divergence, dirty integration owner, wrong branch/HEAD, or concurrent writer.
2. Use the available `integration_owner_preflight.py` or equivalent v2 lease helper with a receipt outside all participating checkouts. Hold the Git-common-directory lease through the exact mutation.
3. Fast-forward the actual local target branch to the reviewed task tip. No squash/rebase/cherry-pick unless separately approved and re-reviewed.
4. Prove integration-owner HEAD, local target ref, and reviewed tip are equal; prove target/base ancestry.
5. Run required validation against the integrated checkout, not only the task branch.
6. Report local integration separately from remote state. Do not push.

## Phase G — post-integration operation and cleanup

From the controller only:

```bash
export JUNO_TASK_ROOT="$CONTROLLER"
export JUNO_WORKSPACE_ROLE=controller
export JUNO_WORKSPACE_ENFORCEMENT=strict
```

Launch Juno, Kanban, workflow runner, and parallel runner there. Every worker must receive a distinct explicit task checkout through `--cwd`, command-file `cwd`, or an absolute worktree path; never rely on the controller cwd for product edits. Create one named task worktree per concurrent implementation owner.

Keep the integration owner strict and write-free except reviewed integration and integrated-target validation.

Remove a bootstrap/task worktree only after integrated-target validation passes, status is clean, no active process/nested worktree uses it, and its reviewed tip is reachable from the approved target. Delete its branch only after the same proof. Never force cleanup. Finish with:

```bash
git worktree list --porcelain
git worktree prune --dry-run --verbose
```

Use a project lifecycle audit helper when available. Preserve blocked worktrees with owner/reason.

## Required migration-to-clean-worktree handoff

Before migration acceptance, write an owner-reviewed JSON policy containing the exact controller checkout/ref, task path/branch conventions, and one repository entry for the root plus every changed nested repository. Every repository entry must name its absolute repository path, exact local `refs/heads/...` integration target, exact fetched `refs/remotes/...` target, integration-owner checkout, expected branch, clean-owner contract, fetched-base policy, approved integration method, pre-merge validation, and integrated-target validation. Missing or mismatched entries are terminal ambiguity, not defaults.

Use the installed deterministic renderer rather than freehand substitution:

```bash
yy prompts specialize-clean-worktree \
  --policy-file "$REVIEWED_WORKTREE_POLICY_JSON" \
  --cwd "$BOOTSTRAP_TASK"
```

Read back `.juno_task/prompts/clean_worktree.md`, its macro mapping, specialization receipt/hash, and all exact repository targets. Reject any unresolved policy value or target belonging to another project. The specialized prompt is intentionally project-customized; routine managed updates must preserve it and emit a side-by-side candidate. Its local integration authority does not authorize push, publication, deployment, production mutation, or post-deploy E2E.

## Final report

Report:

- controller/task/integration-owner paths, branches, HEADs, roles, and independent statuses;
- original target SHA, controller branch creation proof, reviewed bootstrap tip, integrated target SHA, and ancestry;
- v1/v2 executable identities and confirmation global v1 was unchanged;
- installed bootstrap paths and exact validations;
- controller-routing and strict-refusal evidence;
- Kanban storage format and explicit statement that conversion was or was not performed;
- session metadata disposition;
- durable manifest/review/lease receipt paths;
- local target versus remote/push/deploy state;
- every preserved blocker and safest next command.
