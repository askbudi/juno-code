---
wiki_contract:
  line_limit: 250
  purpose: "One task-derived root/direct-child implementation, review, CAS, verification, controller-closure, and cleanup lifecycle."
  failure_mode_prevented: "User-authored choreography, stale refs, wrong checkout review, fictional PASS, repeated child CAS, and unsafe cleanup."
  runtime_contract_enforced: "yy lifecycle owns the immutable plan and every task-level transition; low-level helpers are not public UX."
  validation_gate: "python3 .juno_task/scripts/tests/test_task_lifecycle.py"
  related_sots:
    - "parallel_runner_and_spec_review.md"
---

# Task-derived root/direct-child lifecycle

## Public interface

```bash
yy lifecycle run --task TASK_ID
yy lifecycle resume --task TASK_ID
yy lifecycle status --task TASK_ID
```

`run` reads the canonical Kanban task and project policy, then freezes one internal plan. `resume` verifies that plan and the compact attempt hash chain before choosing the first incomplete phase. `status` is bounded and read-only: it does not create state, refresh caches, dispatch agents, or acquire target authority. Old manifest/state syntax is rejected rather than adapted.

Project policy lives at `.juno_task/config/lifecycle.json`:

```json
{
  "schema_version": "juno_task_lifecycle_config.v2",
  "default_topology": "root-only",
  "repositories": {
    "root": {"path": ".", "target_ref": "refs/heads/main", "parent": null, "expected_paths": ["src"]},
    "child": {"path": "child", "target_ref": "refs/heads/main", "parent": "root", "mount_path": "child", "expected_paths": ["src"]}
  },
  "topologies": {
    "root-only": {"root": "root", "children": []},
    "root-child": {"root": "root", "children": ["child"]}
  },
  "candidate_gate": {"rows": [{"id": "full-suite", "command": "npm test"}]}
}
```

The repository registry owns identities, full target refs, parent edges, mount paths, default path authority, objective risk, and candidate-gate rows. Task fields may select topology and exact existing/future paths; they cannot replace repository identities or refs. One root plus any number of direct children is supported. Duplicate identities, unknown children, a parent above the selected root, or a child of a child fails before the first worktree mutation.

## Canonical sparse controller

The canonical controller is a fresh same-repository linked worktree governed by `.juno_task/config/controller-workspace.json`. Its versioned ownership manifest classifies every tracked path as controller canonical, shared managed distribution, product canonical, or local ignored. Normalization rejects overlap, unsafe paths, symlinks, nested repositories, and unclassified tracked bytes. Canonical checkout is non-cone, worktree-scoped, and uses `index.sparse=false`; its normalized selected paths and exact patterns are digest-bound. Required controller/shared paths must be present while product and unexpected tracked paths are unmaterialized.

Controller CWD is orchestration-only. Every managed edit/build/test/commit/candidate/review/integration/release operation names an explicit product root. Task work requires exact lifecycle registration and admission evidence; candidate/review/integration roots are full exact-tip checkouts; release is a clean strict full integration owner. Controller checkpoints classify controller/shared paths, narrow task-bound writes to that task's task/ledger namespace, reject product paths even after manual materialization or `--no-verify`, and recheck sparse policy around mutation.

Controller synchronization still constructs and validates the full two-parent candidate in an isolated full checkout. After expected-HEAD CAS it reapplies and reads back the exact sparse policy. A moved ref with failed restoration is durable `controller_ref_moved_sparse_restore_pending` truth: COMPLETE and release remain blocked until restoration-only resume succeeds. Cutover and rollback are expected-identity plans; the prior full controller remains read-only and no product ref moves.

## Exact-base admission and workers

Prepare resolves every target SHA, Git common directory, path disposition, dependency, and collision before creating anything. Worktrees are then created once in deterministic root/child registry order. A failed create removes only exact-base, clean, inactive worktrees created by that attempt; uncertain state is preserved.

Future paths are exact. Traversal may use the nearest existing parent, but write authority never expands to that parent. Candidate changed-path readback must remain within admitted existing/future paths, so creating a new file does not require recreating a worktree.

One fresh implementation worker normally owns the coherent multi-root authority map. At most three workers run sequentially; concurrent product workers are forbidden. Workers commit coherent child/root tips, update final root gitlinks, and stop at `REVIEW_READY`. They never dispatch reviewers, move targets, clean, release, or push.

## Candidate and evidence gate

Composition occurs before review. The immutable candidate receipt binds every root/child tip, changed path, root tree, and expected gitlink. A missing or wrong child gitlink fails rather than creating a helper-owned product commit.

The candidate gate creates detached exact-tip checkouts with controller routing unset. Its nonempty matrix emits one bounded row per invariant with ID, command digest, expected/actual result, exit status, evidence path, evidence digest, and pass/fail/not-applicable status. An empty matrix or a matrix with no applicable row cannot pass. Project policy includes built public run/resume/status dogfood, dangerous real-Git scenarios, full suites, typecheck/build, runtime/template/generated/package parity, and changed-path confinement. A changed candidate byte creates a new generation and invalidates prior gate/review evidence.

## Canonical review trust

Every pre-CAS, composed, and delivery-sensitive actual-target review uses the same pipeline:

1. create one external detached exact-tip checkout set;
2. prove each HEAD and porcelain-v2 tracked/staged/untracked state before dispatch;
3. launch fresh canonical `yy pi` with inherited provider/model defaults and a capture path;
4. parse verdict only from captured final response—not prompt echo, argv, stdout, stderr, progress, or footer;
5. require a fresh nonempty session ID bound to the process receipt;
6. prove HEAD and tracked, staged, untracked state unchanged immediately after dispatch;
7. remove the frozen checkout only after evidence is durable.

Low/medium uses Reviewer A. High uses Reviewer A then Reviewer B sequentially on exactly the same frozen base/tip, with distinct sessions and no repair between. Both results complete before one consolidated repair packet. One initial and one replacement round are autonomous; further work requires owner action. Missing/duplicate sessions, prompt echoes, contradictory verdicts, wrong HEAD, or any reviewer mutation fail closed.

A candidate-bound owner waiver preserves objective/effective risk and `review_passed=false`. It must bind the exact candidate digest, target refs/expected SHAs, package scope, and separate integration/local-release permissions. Waiver is never PASS; release remains an optional operation after core COMPLETE.

## Attempts, CAS, and resume

Each task owns a disjoint `<git-common-dir>/juno-lifecycle/tasks/TASK_ID` operational namespace, keeping receipts out of product/controller dirt. Atomic attempts form a task-local hash chain and bind phase, generation, root/child identities, expected controller HEAD, normalized failure, artifact digests, and next action. Symlinks, same-task writers, schema drift, product/staged/submodule dirt, conflicting namespaces, and controller-head races refuse without broad staging.

Integration preflights every target, then moves children in deterministic order and root last using exact-old-SHA `git update-ref`. Every successful movement is persisted before the next. A later failure records `PARTIAL_INTEGRATION`; resume verifies moved refs and continues forward from the first incomplete repository. It never repeats, rewinds, or silently adopts an unreceipted moved child.

Actual-target verification is unconditional: refs, trees, root gitlinks, parity, and deterministic smoke/readback must match. Semantic actual-target review occurs only when objective delivery conditions can change reviewed meaning; byte-identical delivery records `not_required` with policy evidence.

## Controller closure and cleanup

Core COMPLETE requires actual-target truth, required review/waiver/not-required truth, expected-HEAD controller synchronization, terminal checkpoint/readback, and typed cleanup. Optional release is independent and cannot make an incomplete core lifecycle complete.

Cleanup is child-first/root-last and binds each repository's reviewed task tip. Exact HEAD, clean tracked/staged/untracked state, target reachability, registration, and administration must agree. Any mismatch preserves evidence and refuses without force; there is no force lane or automatic rollback.

## Hard cut and history

`workflow_class: local_integration` and old lifecycle manifest/state execution, resume, recovery, lint, and amendment are rejected with task-command guidance. Historical state, receipts, and logs remain readable and immutable through `workflow_runner.sh doctor`. There is no adapter, schema translation, or dual integration runtime. There is no migration executor; permanently partial historical lifecycles remain untouched.

## Why implementation and tests both matter

The Python state machine enforces topology, authority, immutable review, CAS ordering, controller closure, and cleanup. Real Git/worktree tests matter because they prove those boundaries survive actual ref races, partial movement, dirty checkouts, and forward resume. Review-capture tests prove transport text cannot become semantic truth. Package-install tests matter because source-only checks cannot prove users receive the same runtime and schema. Release, push, publication, deployment, production mutation, restart, and post-deploy E2E remain separate authority. Documentation captures why these backing tests are release-critical rather than treating prose or self-authored receipts as sufficient evidence.
