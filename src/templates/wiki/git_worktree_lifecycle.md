---
wiki_contract:
  line_limit: 220
  purpose: "Canonical exact-base worktree, reviewed candidate, target-channel integration, feature-tag, and cleanup lifecycle."
  failure_mode_prevented: "Dirty controllers block unrelated work, stale integrations overwrite refs, tags lie, or cleanup destroys unintegrated work."
  runtime_contract_enforced: "Immutable identities and three review receipts gate target-ref CAS, actual-target validation, local feature tags, and cleanup."
  validation_gate: "python3 -m py_compile .juno_task/scripts/worktree_lifecycle.py .juno_task/scripts/integration_candidate.py .juno_task/scripts/integration_owner_preflight.py && python3 .juno_task/scripts/tests/test_integration_concurrency.py"
  related_sots:
    - "parallel_runner_task_creation_best_practices.md"
    - "parallel_runner_and_spec_review.md"
  owns:
    - "Named worktree creation, candidate, local integration, feature tag, and cleanup contracts."
  does_not_own:
    - "Push, publication, release, deployment, or post-deploy E2E authority."
---

# Git Worktree Lifecycle

Every product change, including a small fix, uses a named exact-base worktree. Controller dirt and unrelated processes are not integration inputs and do not block creation or a proven disjoint target channel.

```text
exact base -> named clean task tree -> pre-merge review PASS
 -> direct or both-parent candidate -> candidate review PASS
 -> ordered channel lock + expected-SHA CAS -> actual-target tests/review PASS
 -> local juno-feature tag -> safe typed cleanup
```

## Exact-base creation

Use `worktree_lifecycle.py create` with full `refs/...` names, task ID, expected paths, validation commands, and cleanup owner. `--fetch REMOTE,REF` is narrow and uses `--no-tags`. `--expected-base` binds the fetched identity. Existing paths/branches are accepted only when path, branch, HEAD, and clean state exactly match.

Controller status is intentionally absent. Capacity is advisory. `--hard-min-free-bytes` blocks only when measurement succeeds and reports threshold, observation, and recovery. Git's actual worktree-add result remains authoritative.

`verify` binds later work to the immutable manifest. `audit` records inventory, target reachability, and prune dry-run.

## Three semantic gates and candidate composition

`integration_candidate.py plan` requires a `pre_merge` PASS receipt, exact base/target/task identities, expected paths, no open bugs, and a PDR matrix whose values are all `PASS`. It records task, target, overlap, and candidate path classes.

`build` leaves a linear candidate at the reviewed task tip. If the target advanced, it creates an isolated candidate at the exact target and merges the reviewed tip with `--no-ff`; the resulting parents must be exactly target then task. Candidate construction never updates the official target. Conflicts are preserved for diagnosis. Candidate commands are timeout-bounded.

`verify` requires a separate `candidate` PASS receipt for the exact candidate and rejects target movement. Target movement means rebuild **and re-review**, never reuse a stale receipt.

## Target-ref channels

`integration_owner_preflight.py integrate` is the only local target mutation authority. Each repository argument is:

```text
--repository NAME=PATH,TARGET_REF,EXPECTED_SHA,CANDIDATE_SHA
```

The helper validates every candidate before mutation, derives a channel from `(resolved Git common directory, full target ref)`, acquires all channels in deterministic order, rechecks expected SHAs under lock, and updates refs with `git update-ref <ref> <new> <expected-old>`. Unrelated controller/task processes do not gate the transaction.

Multi-repository arguments are updated in caller order, so callers list nested children before parents. All locks remain held. A later failure emits `partial_local_integration`, preserves evidence, and withholds success, tag, and cleanup; it never rewinds.

After updates, every `--validation-command` runs against the actual target state. `--actual-review-command` must produce the named `--actual-review-receipt` with `review_kind=actual_target`, exact integrated tip, `passed=true`, and no open bugs.

Only then does the helper create an annotated local tag:

```text
juno-feature/<task-id>/<integrated-short-sha>
```

Its message binds full SHA, target ref, candidate receipt hash, validation receipt hash, and task ID. Exact retries are idempotent; collisions fail. `vX.Y.Z` is package-release-only and must align package metadata, built CLI version, and release identity. No helper here pushes tags/code, publishes, releases, deploys, or runs E2E.

## Automatic workflow queue

A `workflow_class: local_integration` declares this exact policy:

```yaml
integration_policy:
  queue: automatic_after_review_pass
  channel_scope: git_common_dir_and_target_ref
  target_movement: rebuild_and_rereview
```

Validation ownership names `pre_merge_review`, `candidate_review`, and `actual_target_review`. The integration step consumes the eligible receipt and runs actual-target review. Same-channel jobs serialize on the channel lock; disjoint channels can progress independently.

## Cleanup

`worktree_lifecycle.py cleanup` requires explicit repository, target ref, task/candidate path, expected HEAD, and `--branch-ref` as a full `refs/heads/...` name or the exact literal `DETACHED`. It refuses dirty, locked, active, wrong-identity, unreachable, or initialized-nested worktrees. Remove nested worktrees before parents. Expected disappearance is success; optional branch deletion uses non-force `git branch -d`. Every attempt records final inventory and prune dry-run. There is no automatic force mode.

## Shipping and validation

The canonical bytes are under `juno-code/src/templates/scripts/`. ScriptInstaller installs every helper into `.juno_task/scripts/`; build copies those bytes to `dist/templates/scripts/`. Runtime/template/dist parity is mandatory. The old repository-wide writer guard and read-only cleanup authority were removed rather than retained as alternate engines.

Real Git/worktree tests matter: prose cannot prove dirty-controller isolation, both-parent composition, stale compare-and-swap refusal, lock serialization, partial multi-repository truth, tag collisions, or reachability-safe removal. Package-install tests matter because source-only helpers do not fix existing or fresh projects.
