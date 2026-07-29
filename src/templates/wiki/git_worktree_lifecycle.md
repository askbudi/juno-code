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

Use `worktree_lifecycle.py create` with full `refs/...` names, task ID, expected paths, validation commands, and cleanup owner. `--fetch REMOTE,REF` is narrow, uses `--no-tags`, and resolves `FETCH_HEAD` without advancing the approved local target. `--expected-base` binds the fetched identity. Existing paths/branches are accepted only when path, branch, HEAD, and clean state exactly match. The create receipt's resolved `worktree` is the canonical identity source. For a configured/display spelling, run `worktree_lifecycle.py verify --manifest CREATE_RECEIPT --path DISPLAY_PATH --output VERIFY_RECEIPT`; it compares canonical-to-canonical and also binds the Git top level, common directory, branch, base HEAD, cleanliness, receipt hash, and stable resolution. Equivalent aliases such as macOS `/tmp` and `/private/tmp` pass; missing, dangling, substituted, non-root, or resolution-drifted paths fail closed. Do not hardcode platform aliases or use lexical shell equality for worktree identity.

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

Multi-repository arguments are updated in caller order, so callers list nested children before parents and bind each child to its root-relative gitlink with `--gitlink CHILD=PATH`. Every root gitlink must equal the child candidate before any target moves. All locks remain held. A later failure emits `partial_local_integration`, preserves evidence, and withholds success, tag, and cleanup; it never rewinds. Resume that exact operation with `--resume-receipt <partial-receipt>`: repository identities and candidate-receipt hashes must match, already-moved refs are reconciled, and remaining refs still use expected-SHA CAS. Never start an unrelated integration to repair partial state.

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

Pass the exact canonical controller root as `integration_owner_preflight.py --controller-checkout`. Repository owners outside it are classified as auxiliary. A child owner nested under the controller must be its committed gitlink and requires `--nested-owner-receipt NAME=RELEASE_RECEIPT` from an owner-approved `release-target --controller-checkout CONTROLLER --disposition detach_same_sha`. Integration binds the receipt hash, controller HEAD, gitlink path/SHA, detached child checkout, child target ref, and expected SHA before and under channel locks, then proves after target advancement/review that the child target reached the candidate while the controller's nested checkout stayed detached at its committed gitlink and its parent path stayed clean. Missing, stale, removal-disposition, non-gitlink, or dirty topology fails before target mutation. Prefer an auxiliary owner; the nested receipt is an explicit target-preserving exception, not authority to mutate unrelated controller dirt.

## Checked-out target release

When integration reports `target_ref_checked_out`, do not switch or remove the owner ad hoc. Obtain owner approval and run `worktree_lifecycle.py release-target` with the exact repository, registered worktree, full target ref, expected target SHA, task/owner identity, immutable output receipt, and an explicit `detach_same_sha` or `remove` disposition. For a controller-nested submodule owner, also pass the canonical `--controller-checkout`; the helper recognizes Git's embedded-primary registration, requires same-SHA detach, and binds the controller HEAD and clean committed gitlink in the receipt. The helper canonicalizes registration identity; records processes whose CWD is inside the checkout; refuses dirty, locked, active, stale, or mismatched owners; and proves the target ref remains at the expected SHA. Same-SHA detach changes only checkout attachment and may preserve clean initialized submodules because no worktree bytes are removed. Removal additionally refuses initialized nested repositories and uses ordinary no-force Git worktree removal. A matching retry is idempotent. The release receipt grants no integration, branch deletion, process signal, push, or target-rewind authority.

## Cleanup

`worktree_lifecycle.py cleanup` requires explicit repository, target ref, task/candidate path, expected HEAD, and `--branch-ref` as a full `refs/heads/...` name or the exact literal `DETACHED`. It refuses dirty, locked, active, wrong-identity, unreachable, or initialized-nested worktrees. Remove nested worktrees before parents. If an initialized submodule was explicitly deinitialized but its exact linked-worktree administration remains, pass `--deinitialized-submodule RELATIVE_PATH=APPROVED_REPOSITORY`. Cleanup verifies the path is a deinitialized gitlink at the expected parent commit, the stale administration HEAD equals that gitlink, and the commit is reachable from a ref in the separately approved repository. It then removes only that linked-worktree-owned administration plus empty owned parent directories before ordinary removal; unapproved, mismatched, initialized, or unreachable entries fail closed. Expected disappearance is idempotent success; optional branch deletion uses exact-old-SHA `git update-ref -d`. Every attempt records reachability evidence, final inventory, and prune dry run. There is no automatic force mode.

## Runtime checkout identity

A healthy port is not source identity. Before a local runtime or feature-E2E launch, freeze one canonical checkout root, full ref or detached SHA, root HEAD, and relevant gitlink SHAs. Launch tracked commands from that checkout rather than copying product bytes into the controller. Runtime evidence records the canonical source root, root and nested SHAs, process CWD and PID, scoped state/log locations, and health result without secret values. A status check rejects a process whose CWD or recorded SHA set differs from the frozen identity, even if its port is healthy.

Restart after any target ref, root HEAD, gitlink, or lockfile identity change; hot reload is not integration evidence. Controller-to-product orchestration and product runtime ownership are separate and one-way: the controller may select and verify an approved checkout, but product source is never synchronized back into the controller. Product-specific ports, service order, environment files, health routes, dispatchers, process supervisors, and stop policy stay in the product project. Add a generic read-only identity probe only when multiple Juno entrypoints consume one contract; do not create a speculative service manager.

## Shipping and validation

The canonical bytes are under `juno-code/src/templates/scripts/`. ScriptInstaller installs lifecycle scripts only as a bundle with their checksum-managed prompts/wiki; customized guidance blocks an ordinary generation change and `yy scripts doctor` reports incomplete or mixed installations. `yy scripts update --force` is the explicit backup-and-replace recovery path. Build copies canonical bytes to `dist/templates/scripts/`. Runtime/template/dist parity is mandatory. The old repository-wide writer guard and read-only cleanup authority were removed rather than retained as alternate engines.

Real Git/worktree tests matter: prose cannot prove dirty-controller isolation, both-parent composition, stale compare-and-swap refusal, lock serialization, partial multi-repository truth, tag collisions, or reachability-safe removal. Package-install tests matter because source-only helpers do not fix existing or fresh projects.
