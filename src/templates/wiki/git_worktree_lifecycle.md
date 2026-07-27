---
wiki_contract:
  line_limit: 220
  purpose: "Canonical lifecycle for isolated Git worktrees used by task, review, and workflow agents."
  failure_mode_prevented: "Agents share a dirty checkout, mutate a target beside another writer, delete an unexplained Git index lock, strand commits, integrate into the wrong branch, run E2E before integration, or destroy active/uncommitted work during cleanup."
  runtime_contract_enforced: "Every isolated task records its repository, base SHA, integration target and owner, preserves and diagnoses an existing checkout-specific index lock, proves bounded quiescence under repository leases, validates the integrated target, and ends with an explicit controller/cleanup disposition."
  validation_gate: "python3 -m py_compile .juno_task/scripts/git_index_lock.py .juno_task/scripts/controller_checkpoint.py .juno_task/scripts/worktree_lifecycle_audit.py .juno_task/scripts/integration_owner_preflight.py && python3 .juno_task/scripts/git_index_lock.py --repository . && python3 .juno_task/scripts/worktree_lifecycle_audit.py --root . --json"
  related_sots:
    - "parallel_runner_task_creation_best_practices.md"
    - "parallel_runner_and_spec_review.md"
    - "runtime_migration_and_replacement_contract.md"
  owns:
    - "Decision, creation, integration, validation, and cleanup rules for Git worktrees."
    - "Repository-wide worktree inventory and cleanup classification contract."
  does_not_own:
    - "Task-specific paths, branches, commits, evidence, or current inventory counts."
    - "Production deployment mechanics or domain-specific test gates."
---

# Git Worktree Lifecycle

Use this SOT whenever a task, workflow, or reviewer creates or inherits a Git worktree. Worktrees isolate files; they do not integrate commits or make cleanup safe automatically.

## Isolation decision

Use the existing checkout only for one bounded owner when it is clean or all existing changes are explicitly owned by that same task. Create an isolated branch worktree when any of these apply:

- the primary checkout is dirty with unrelated work;
- multiple agents may edit overlapping repositories or generated files;
- a dependency-ordered task set needs one shared task branch;
- validation requires a clean committed tree;
- a task crosses a submodule boundary and must preserve parent-pointer ownership.

Use a detached worktree only for read-only review or validation. Any edit made there must be committed onto a named branch before the worktree is disposable. Path-ownership controls are still required when agents share one task worktree.

## Preflight and creation

Before creation, record this manifest in the task, workflow preflight, or durable artifact:

```text
repository | primary checkout | integration target | fetched base SHA
worktree path | task branch or detached purpose | integration owner
expected touched paths | nested submodules | validation gate | cleanup owner
```

Discover repositories rather than assuming the superproject is the only one. Include the root, declared recursive submodules, and embedded repositories. Discover the intended integration target from the approved task/deployment path; do not globally assume `main` or `master`. Fetch that target immediately before recording its base SHA.

Creation must fail closed when the path or branch already exists with the wrong HEAD, an existing worktree is dirty, the target ref cannot be resolved, or another worktree already owns the branch. Prefer a task-identifying path and branch. For a shared dependency-ordered worktree, every worker must verify the same branch and predecessor commit before editing.

## Required lifecycle

```text
owner-approved task and isolation decision
  -> fetch target; record base SHA; create/verify worktree
  -> implementation commits with task validation
  -> independent review and coherent review-fix commits
  -> fetch target again; classify integrated/ahead/divergent
  -> integration owner merges/rebases/cherry-picks or pushes as approved
  -> for submodules: push child commit, then commit parent pointer
  -> validate the actual integrated target
  -> only then permit deployment or post-deploy E2E
  -> remove nested worktrees before parents; remove task worktree
  -> delete task branch only after reachability proof
  -> final inventory and prune dry-run
```

Integration is an explicit stage after independent review and before deployment/E2E. A successful worker, task commit, or clean worktree is not integration evidence.

## Controller checkpoint boundary

Before any Juno-owned Git index mutation, resolve the checkout-specific lock with `git rev-parse --path-format=absolute --git-path index.lock`. If it exists, preserve it and stop. Never infer staleness from age, an empty payload, or absence of an `lsof` owner; those observations do not establish that the writer is dead or that the interrupted index operation is recoverable. Use the shipped read-only helper to create a durable diagnostic receipt:

```bash
python3 .juno_task/scripts/git_index_lock.py \
  --repository /path/to/checkout \
  --output /durable/index-lock.json
```

The receipt records checkout/common-directory identity, bounded hashes and metadata for the lock and index, and hashed process names when owner inspection is available. It does not delete, rename, rewrite, or unlock anything. `safe_next_action=preserve_and_coordinate` is a hard workflow boundary: identify and coordinate with the active or interrupted Git/Juno operation before any recovery decision. Juno startup provenance should eventually correlate an invocation/session ID, PID/PPID, repository common directory, bounded Git operation class, start/end/exit state, and lock observations in the isolated session-metadata directory; do not record prompts, credentials, full command lines, or repository file contents.

After an ordinary, workflow, or parallel run writes its final durable state, its outer finalizer invokes `controller_checkpoint.py commit` best-effort. Failure is warned without replacing the run status; failed runs may preserve valid allowlisted state with a failure-state message. The helper rejects product dirt, a pre-existing index, conflicts, unsafe paths/repository boundaries, detached HEAD, races, and lease contention, stages only frozen explicit paths, and never pushes or orchestrates refs. Agent mode can propose strict JSON grouping/messages with hooks disabled, closed stdin, bounded time, and read-only tools; deterministic code remains the only staging/commit owner.

Immediately before integration, pass `--checkpoint-controller "$CONTROLLER_ROOT"` to `integration_owner_preflight.py`, before `--exec-command`. It runs `controller_checkpoint.py require-clean --checkpoint`, records checkpoint evidence, and only then acquires the integration leases. Product dirt fails closed and remains untouched. This is clean proof, not merge authority or a substitute for review, ancestry, or integrated-target validation.

## Integration-owner quiescence

Immediately before any target-ref mutation, acquire fixed-order cooperative leases for every affected repository and prove each named target owner is clean, checked out on the exact target ref, and unchanged across a bounded observation window. Use the shared helper; pass the mutation as `--exec-command` so leases remain held through it:

```bash
python3 .juno_task/scripts/integration_owner_preflight.py \
  --checkpoint-controller "$CONTROLLER_ROOT" \
  --repository "root=$ROOT_INTEGRATION_OWNER,$ROOT_EXACT_TARGET_REF" \
  --repository "child=$CHILD_INTEGRATION_OWNER,$CHILD_EXACT_TARGET_REF" \
  --quiescence-seconds 2 --output "$DURABLE_RUN/preflight.json" \
  --exec-command "$REVIEWED_INTEGRATION_SCRIPT"
```

Long-running non-integration launchers can use `repository_writer_guard.py --cwd PATH -- COMMAND` to hold a shared `juno-repository-writer.lock` lease in the Git common directory; integration takes that lease exclusively through the preflight helper. Do not wrap an agent that must itself perform integration, because its own shared lease would correctly block the exclusive mutation. The preflight hashes process commands in receipts, excludes caller ancestry, never signals processes, rejects same-repository legacy writers, and permits writers whose Git common directory proves they belong to another repository. Process discovery remains a fail-closed compatibility fallback when legacy writer scope is unknown. Any integration workflow capable of target mutation must use the exclusive preflight rather than inventing task-local lock directories.

Workflow-launched Juno commands redirect volatile session metadata beside run artifacts. Interactive integration owners should use an equivalent isolated `JUNO_CODE_SESSION_METADATA_DIRECTORY`. If tracked session/Kanban metadata changes during quiescence, stop and preserve ownership; do not repeatedly commit runtime churn merely to manufacture a clean target owner.

## Integration gate

The named integration owner must:

1. Fetch the approved target and detect remote movement.
2. Inspect the complete base-to-task diff and task/review commits.
3. Stop on divergence or conflicts unless the approved strategy names how to resolve them.
4. Integrate through the repository's approved route: fast-forward/merge, reviewed rebase, selected cherry-pick, direct protected-branch push, or submodule child push plus parent-pointer commit.
5. Prove `git merge-base --is-ancestor <task-tip> <integration-target>` after integration. For squash integration, record the replacement commit and prove the reviewed patch equivalence because task-tip ancestry will intentionally be false.
6. Run the required tests against the integrated target, not only the task branch.
7. Record final target ref/SHA, integration method, validation result, and E2E eligibility.

Target-ref integration and primary-controller restoration are separate outcomes. End with exactly one durable disposition: `target_integrated_controller_attached_clean`, `target_integrated_controller_detached_preserved`, `integration_pending_dirty_owner`, or `integration_failed_preserved`. A request to restore the root/controller channel requires the attached-clean disposition: quiesce writers, preserve or externalize metadata, release any auxiliary owner holding the branch, attach the controller to the integrated target, update nested checkouts to exact gitlinks, and revalidate cleanliness/ref/gitlink equality. Never switch a dirty controller merely to make it current.

## Cleanup gate

Inventory first:

```bash
python3 .juno_task/scripts/worktree_lifecycle_audit.py --root . --json
git worktree list --porcelain
git worktree prune --dry-run --verbose
```

Pass explicit `--target REPOSITORY=REF` mappings when the default upstream is not the approved integration target. The helper is read-only; `cleanup_candidate=true` means an auxiliary worktree is clean, has neither an initialized nested repository nor retained worktree-specific `modules/` metadata, and its tip is an ancestor of the selected target. `git submodule deinit` alone does not make retained metadata automatically removable. The helper never removes anything.

Before removal, recheck all tracked and untracked status, target reachability, locked/prunable state, initialized submodules, and active processes using the worktree. `worktree_lifecycle_audit.py` owns read-only cleanup classification; `integration_owner_preflight.py` owns target-ref integration leases and has no cleanup mode. Do not pass undocumented modes or treat either helper as permission to remove files. A task branch is removable only when the audit reports it clean and its reviewed tip is reachable from the declared exact target, followed by an explicit no-active-process check. Remove nested worktrees before parent worktrees. Do not use filesystem deletion as a substitute for `git worktree remove`; use `prune` only for already-missing registrations. Force removal is allowed only with explicit cleanup authorization plus recorded proof that no dirty, active, or unintegrated work will be lost.

Delete a task branch only after its reviewed tip is reachable from the approved target or a recorded squash replacement preserves the patch. Finish with another repository-wide inventory and prune dry-run. Keep blocked trees with an owner and reason rather than guessing from age.

## Dispositions

- `clean_integrated`: eligible for ordinary removal when auxiliary.
- `clean_integrated_nested`: integrated, but nested repositories require ordered manual cleanup.
- `clean_unintegrated_ahead`: preserve until integration or intentional archival protects the tip.
- `clean_divergent`: preserve; fetch and integration-owner decision required.
- `dirty`: preserve; classify and commit, transfer, or intentionally discard with authorization.
- `stale_missing_path` / `prunable_registration`: audit the protected commit, then prune the registration.
- `locked`, `status_error`, `target_unknown`, or `reachability_error`: fail closed and resolve the named condition.

Failure mode prevented: parallel agents leave large worktrees, lose detached commits, target the wrong shared branch, or clean up before reviewed work is integrated.

Runtime contract enforced: isolation begins with an explicit fetched base and ends only after integration, integrated-target validation, E2E handoff, and a repository-wide cleanup disposition.

Exact installed-project validation gate:

```bash
python3 -m py_compile \
  .juno_task/scripts/git_index_lock.py \
  .juno_task/scripts/controller_checkpoint.py \
  .juno_task/scripts/integration_owner_preflight.py \
  .juno_task/scripts/worktree_lifecycle_audit.py
python3 .juno_task/scripts/git_index_lock.py --repository .
python3 .juno_task/scripts/worktree_lifecycle_audit.py --root . --json
git worktree list --porcelain
git worktree prune --dry-run --verbose
```

The Juno Code source package additionally runs focused helper tests and source/dist/npm-tarball parity. Runtime projects are not required to carry package test sources or a private wiki linter.

Why tests/backing implementation matter: prose cannot reliably enumerate embedded repositories, serialize target mutation, observe ref/status stability, or distinguish clean-integrated, dirty, active, missing, nested, and divergent states. The helpers make those states and leases reviewable while keeping integration commands and destructive cleanup explicit.
