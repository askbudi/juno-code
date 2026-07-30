---
wiki_contract:
  line_limit: 220
  purpose: "Canonical exact-base worktree, reviewed candidate, target-channel integration, feature-tag, and cleanup lifecycle."
  failure_mode_prevented: "Dirty controllers block unrelated work, stale integrations overwrite refs, tags lie, or cleanup destroys unintegrated work."
  runtime_contract_enforced: "Risk-tiered immutable review identities, metadata-only detach, target-ref CAS, actual-target validation, tiered tags, and strict cleanup."
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
 -> direct review reuse or reviewed both-parent candidate
 -> ordered lock + same-SHA metadata detach + expected-SHA CAS
 -> deterministic actual-target validation + tiered review/tag -> typed cleanup
```

## Exact-base creation

Use `worktree_lifecycle.py create` with full `refs/...` names, task ID, expected paths, validation commands, and cleanup owner. `--fetch REMOTE,REF` is narrow, uses `--no-tags`, and resolves `FETCH_HEAD` without advancing the approved local target. `--expected-base` binds the fetched identity. Existing paths/branches are accepted only when path, branch, HEAD, clean state, and checkout policy exactly match. Full checkout remains the default. For an owner-reviewed small task in a large repository, add `--sparse`; the sole path contract is the normalized union of repeated `--expected-path` task ownership and explicit `--sparse-tooling-path` requirements. Sparse mode requires at least one such relative non-glob path, rejects `.git`, traversal, negation, comments, and implicit tooling, and uses `git worktree add --no-checkout` plus canonical non-cone, non-sparse-index exact/subtree patterns before resetting to the exact base. The immutable create receipt binds mode/style, selected paths, exact patterns and sparse-file hash, effective and explicit worktree-scoped Git config readback including disabled sparse-index mode, bounded count/SHA-256 evidence for the exact actual and expected skip-worktree path sets from the base tree, materialized tracked paths, and the local target-ref SHA observed separately from a fetched base. Tracked-path and skip-bit inspection is NUL-delimited so unusual Git filenames cannot evade the allowlist. Sparse path inputs with control characters or leading/trailing whitespace are rejected rather than rewritten, and malformed pattern encoding is inconsistent evidence rather than an audit/cleanup crash. Retry and `verify` require the identical policy and refuse missing/malformed/disabled sparse config, residual skip-worktree state, pattern drift, target-ref movement, or any materialized tracked path outside the declared union. If sparse setup or its postcondition fails after registration, create attempts only ordinary exact-identity removal plus exact-old-SHA branch deletion; failed rollback is reported and preserved without force. The create receipt's resolved `worktree` is the canonical identity source. For a configured/display spelling, run `worktree_lifecycle.py verify --manifest CREATE_RECEIPT --path DISPLAY_PATH --output VERIFY_RECEIPT`; it compares canonical-to-canonical and also binds the Git top level, common directory, branch, base HEAD, cleanliness, receipt hash, and stable resolution. Equivalent aliases such as macOS `/tmp` and `/private/tmp` pass; missing, dangling, substituted, non-root, or resolution-drifted paths fail closed. Do not hardcode platform aliases or use lexical shell equality for worktree identity.

Controller status is intentionally absent. Capacity is advisory. `--hard-min-free-bytes` blocks only when measurement succeeds and reports threshold, observation, and recovery. Git's actual worktree-add result remains authoritative.

`verify` binds later work to the immutable manifest. `audit` records inventory, target reachability, and prune dry-run.

## Read-only official-target preflight

Before implementation, keep the task worktree at the exact owner-approved base and separately run `integration_candidate.py target-preflight --repository REPO --target-ref refs/heads/TARGET --approved-base SHA --output RECEIPT.json`. The typed receipt binds the Git common directory, full target ref, approved base, observed target, ancestry, timestamp, producer digest, and safe next action. `exact` and `advanced_descendant` pass; rewind/divergence and missing targets write refusal evidence and exit nonzero. The helper is read-only: descendant acceptance is only a snapshot for later rebuild/re-review, never permission to substitute the current target for the task base or semantic acceptance of composed bytes.

## Three semantic gates and candidate composition

`integration_candidate.py plan` requires a `pre_merge` PASS receipt, exact base/target/task identities, expected paths, no open bugs, and a PDR matrix whose values are all `PASS`. It records task, target, overlap, and candidate path classes.

`build` leaves a linear candidate at the reviewed task tip. If the target advanced, it creates an isolated candidate at the exact target and merges the reviewed tip with `--no-ff`; the resulting parents must be exactly target then task. Candidate construction never updates the official target. Conflicts are preserved for diagnosis. Candidate commands are timeout-bounded. A fresh candidate does not inherit ignored dependencies or hydrated submodules from the task worktree: make the validation-command sequence self-contained with deterministic bootstrap before tests, and never copy dependency directories into the candidate.

Every candidate validation writes immutable stdout/stderr sidecars and hash-bound metadata. A nonzero exit or timeout writes a typed `build_failed` receipt to `--output` with the exact validation index, command hash, cwd, outcome, and artifact identities before returning nonzero, so diagnosis never depends on terminal scrollback.

`verify` reuses the immutable `pre_merge` review when the candidate SHA equals the reviewed tip and records `candidate_semantic_review_source=pre_merge` plus `candidate_bytes_changed_by_composition=false`. A both-parent/composed candidate requires a separate exact `candidate` PASS receipt. Target movement means rebuild **and re-review**.

## Target-ref channels

`integration_owner_preflight.py integrate` is the only local target mutation authority. It accepts `--risk-tier low|medium|high|release` (omission defaults high) and explicit `--checked-out-target detach_same_sha` (omission refuses an attached target). Each repository argument is:

```text
--repository NAME=PATH,TARGET_REF,EXPECTED_SHA,CANDIDATE_SHA
```

The helper validates every candidate before mutation, derives a channel from `(resolved Git common directory, full target ref)`, acquires all channels in deterministic order, rechecks expected SHAs under lock, and updates refs with `git update-ref <ref> <new> <expected-old>`. Unrelated controller/task processes do not gate the transaction.

Multi-repository arguments are updated in caller order, so callers list nested children before parents and bind each child to its root-relative gitlink with `--gitlink CHILD=PATH`. Every root gitlink must equal the child candidate before any target moves. All locks remain held. A later failure emits `partial_local_integration`, or `failed_preserved` when detach completed before the first CAS, preserves evidence, and withholds success, tag, and cleanup; it never rewinds. Resume that exact operation with `--resume-receipt <receipt>`: repository identities, candidate-receipt hashes, and detached runtime identities must match, already-moved refs are reconciled, and remaining refs still use expected-SHA CAS. A fresh retry may adopt one unambiguous registered detached checkout at the expected SHA and continues to report it as current or stale. Never start an unrelated integration to repair partial state.

After updates, every `--validation-command` runs against the actual integrated candidate and target readback is proven. Effective high/release risk— including composed, multi-repository, or controller-nested escalation—requires `--actual-review-command` and an exact `actual_target` PASS receipt. Direct low/medium records semantic review as not required; deterministic validation still runs.

High/release creates an annotated local tag; low/medium skips it by default and may request one with `--feature-tag`:

```text
juno-feature/<task-id>/<integrated-short-sha>
```

Its message binds full SHA, target ref, candidate receipt hash, validation receipt hash, and task ID. Exact retries are idempotent; collisions fail. Receipts explicitly record required/requested/created/skipped tag policy. `vX.Y.Z` is package-release-only and must align package metadata, built CLI version, and release identity. No helper here pushes tags/code, publishes, releases, deploys, or runs E2E.

## Automatic workflow queue

A `workflow_class: local_integration` declares this exact policy:

```yaml
integration_policy:
  queue: automatic_after_review_pass
  channel_scope: git_common_dir_and_target_ref
  target_movement: rebuild_and_rereview
  checked_out_target: detach_same_sha
```

The workflow also declares exactly one `risk_tier`; legacy CLI omission defaults to high.

Validation ownership names `pre_merge_review`, `candidate_review`, and `actual_target_review`. Medium/high/release pre-merge review is a dedicated fresh `yy pi`/Juno step; independent review roles reject explicit resume/continue. Candidate review runs only when composition changed bytes. The integration step consumes the eligible receipt and keeps actual-target review under the lock/CAS transaction, while Workflow Runner binds that nested fresh invocation as an `actual_target_review` child step with command hash, parent digest, stdout/stderr/response/capture hashes, session, timing, semantic outcome, reviewed target SHA, and review-receipt hash. Child evidence participates in checkpoints, recovery, manifests, doctor, and review packets; missing or drifted evidence fails closed. Same-channel jobs serialize on the channel lock; disjoint channels can progress independently.

Pass the exact canonical controller root as `--controller-checkout`. Repository owners outside it are auxiliary. A nested owner must be the clean committed gitlink at the expected SHA. With explicit detach policy, integration invokes the same canonical metadata detach under channel locks and embeds its evidence; no prior release receipt or second detach engine is used. After CAS it proves the nested checkout stayed detached at the committed SHA while the child target advanced.

## Checked-out target release

When integration reports `target_ref_checked_out`, rerun only with owner-approved `--checked-out-target detach_same_sha`, or use `worktree_lifecycle.py release-target --disposition detach_same_sha` separately for an explicit lifecycle operation. For a controller-nested submodule owner, also pass the canonical `--controller-checkout`; the canonical detach itself revalidates controller HEAD and the clean committed gitlink at the final mutation boundary and after detach. It recognizes Git's embedded-primary registration, requires exactly one complete-inventory owner of the target before an initial detach, and proves registration identity is preserved while ownership becomes zero. The helper requires clean tracked/index state while allowing untracked files. It snapshots index bytes/tree, complete status, submodules, registration, and target identity; uses `git update-ref --no-deref HEAD`; and proves them unchanged. Processes and probe uncertainty are preserved as non-blocking evidence. Every operation-level refusal, including postcondition refusal, writes immutable identity/process/refusal evidence. `release-target` has no removal disposition. A matching retry is idempotent. The release receipt grants no integration, branch deletion, process signal, push, or target-rewind authority.

## Cleanup

`worktree_lifecycle.py audit` records each checkout's full/sparse policy and withholds cleanup eligibility from noncanonical sparse config, patterns, or unexpected materialized tracked paths. `worktree_lifecycle.py cleanup` is the sole destructive checkout authority and is asynchronous—it never gates integration. It receipts the discovered checkout policy and refuses inconsistent sparse state before ordinary removal. Any active use or activity probe result other than `lsof` success or its documented no-match exit code 1—including missing, timeout, or any other nonzero exit—blocks cleanup. The `lsof -n -P +D` probe defaults to a five-second bound; for reviewed large-tree cleanup, `--activity-probe-timeout-seconds N` may raise that bound to at most 60 seconds. Values outside 1–60 refuse before the probe, and every cleanup receipt records the selected bound, hard maximum, command, elapsed time when run, and outcome. A larger bound never converts timeout or unknown evidence into inactivity. It requires explicit repository, target ref, task/candidate path, expected HEAD, and `--branch-ref` as a full `refs/heads/...` name or the exact literal `DETACHED`. It refuses dirty, locked, active, wrong-identity, unreachable, or initialized-nested worktrees. Remove nested worktrees before parents. If an initialized submodule was explicitly deinitialized but its exact linked-worktree administration remains, pass `--deinitialized-submodule RELATIVE_PATH=APPROVED_REPOSITORY`. Cleanup verifies the path is a deinitialized gitlink at the expected parent commit, the stale administration HEAD equals that gitlink, and the commit is reachable from a ref in the separately approved repository. It then removes only that linked-worktree-owned administration plus empty owned parent directories before ordinary removal; unapproved, mismatched, initialized, or unreachable entries fail closed. Expected disappearance is idempotent success; optional branch deletion uses exact-old-SHA `git update-ref -d`. Every attempt records reachability evidence, final inventory, and prune dry run. There is no automatic force mode.

## Runtime checkout identity

A healthy port is not source identity. Before a local runtime or feature-E2E launch, freeze one canonical checkout root, full ref or detached SHA, root HEAD, and relevant gitlink SHAs. Launch tracked commands from that checkout rather than copying product bytes into the controller. Runtime evidence records the canonical source root, root and nested SHAs, process CWD and PID, scoped state/log locations, and health result without secret values. A status check rejects a process whose CWD or recorded SHA set differs from the frozen identity, even if its port is healthy.

Restart after any target ref, root HEAD, gitlink, or lockfile identity change; hot reload is not integration evidence. Controller-to-product orchestration and product runtime ownership are separate and one-way: the controller may select and verify an approved checkout, but product source is never synchronized back into the controller. Product-specific ports, service order, environment files, health routes, dispatchers, process supervisors, and stop policy stay in the product project. Add a generic read-only identity probe only when multiple Juno entrypoints consume one contract; do not create a speculative service manager.

## Shipping and validation

The canonical bytes are under `juno-code/src/templates/scripts/`. Generated task workflows define stable common agent and review contracts once in workflow `vars`; ordinary review handoff uses task IDs, exact SHAs, files, and receipts rather than injecting a prior agent response. `steps.<id>.response` is emitted only for an explicitly declared conversational handoff. ScriptInstaller installs lifecycle scripts only as a bundle with their checksum-managed prompts/wiki; customized guidance blocks an ordinary generation change and `yy scripts doctor` reports incomplete or mixed installations. `yy scripts update --force` is the explicit backup-and-replace recovery path. Build copies canonical bytes to `dist/templates/scripts/`. Runtime/template/dist parity is mandatory. The old repository-wide writer guard and read-only cleanup authority were removed rather than retained as alternate engines.

Real Git/worktree tests matter: prose cannot prove dirty-controller isolation, both-parent composition, stale compare-and-swap refusal, lock serialization, partial multi-repository truth, tag collisions, or reachability-safe removal. Package-install tests matter because source-only helpers do not fix existing or fresh projects.
