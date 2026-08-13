---
wiki_contract:
  line_limit: 220
  purpose: "Fast, evidence-bound execution of ordinary task, integration, RC, and consumer-canary work."
  failure_mode_prevented: "Wrong-worktree edits, review loops, stale runtime conclusions, accidental dirt loss, and confusing task admission with product completion."
  runtime_contract_enforced: "The controller orchestrates, task worktrees implement, the integration owner integrates/releases, and exact receipts bind transitions."
  validation_gate: "npm run build && npm run test:managed-assets"
  related_sots:
    - "metadata_controller_boundary.md"
    - "task_dependency_hydration.md"
    - "runtime_migration_and_replacement_contract.md"
    - "validation_depth_by_risk.md"
---

# Effective lifecycle field guide

## Start from authority, not convenience

1. Run Kanban, `yy task`, `yy merge`, and controller runtime operations from the
   registered metadata controller.
2. Start implementation with `yy task start TASK_ID`. Edit only the returned
   feature worktree after reading its root and relevant nested instructions.
3. Treat the registered integration owner as protected delivery state. Do not
   use it as an implementation checkout or clean pre-existing dirt to make a
   command pass.
4. Bind every conclusion to the exact branch, HEAD, target ref, runtime version,
   and receipt involved. A nearby clean checkout is not evidence for the real
   consumer.

Before mutation, record concise readback:

```text
controller path + branch + cleanliness
task worktree path + branch + HEAD + target SHA
integration-owner path + detached HEAD + role base + dirt
launcher version + registered runtime version + managed-script generation
```

If those identities disagree, diagnose the topology first. Do not compensate
by copying files between worktrees or rewriting registration informally.

## Keep the loop bounded

- One implementation task owns one coherent defect or feature.
- Use the risk plan's review count. Low risk has no semantic review; normal has
  at most one; high has two reviewers on one frozen candidate.
- A reviewer reports findings; it does not become an autonomous repair/review
  loop. Repair once, regenerate the candidate, and run only the required next
  review round.
- When dogfood reveals a distinct Juno defect, create a separate bounded task.
  Do not silently widen a consumer or product task.
- Manual integration is legitimate when explicitly authorized, but it still
  requires an exact clean candidate, focused validation, target readback, and
  Kanban closure. Skipping repeated review does not mean skipping evidence.

## Separate admission, implementation, and delivery

These are different claims:

| Claim | Strong evidence |
| --- | --- |
| Task admission works | `yy task start` creates or reopens the exact-base worktree |
| Workspace is ready | status/current-runtime checks, dependencies hydrated, required files present |
| Product implementation exists | committed task changes and focused product tests |
| Candidate is mergeable | `yy task preflight`/`finish` passes against the committed tip |
| Delivery is integrated | target ref and integration-owner readback match the merged candidate |
| Consumer accepts a release | exact installed RC, runtime rebind/bootstrap receipts, real consumer canary |

`task has no committed changes` is a correct preflight result for an admitted
but unimplemented task. It does not mean task creation or RC support is broken.
Conversely, a successful `task start` does not prove the product defect is fixed.

## Hydrate dependencies exactly

Fresh worktrees may lack ignored dependency trees or initialized submodules.
Follow `task_dependency_hydration.md` and use the pinned lockfile or gitlink.
Verify the resulting commit and cleanliness before testing.

When a remote is slow or unavailable, a local object source is acceptable only
when its object is verified to be the exact pinned commit. Restore canonical
remote configuration afterward. Never borrow mutable dependency directories or
accept a merely similar branch tip.

## Integrate and release an RC

1. Finish or otherwise freeze the exact clean feature commit.
2. Integrate it into the protected target with expected-SHA authority.
3. Read back the target ref, integration-owner HEAD, role base, submodule
   gitlinks, and cleanliness. A successful-looking receipt is not a substitute
   for checkout readback.
4. Refresh the controller's managed runtime when the integrated change affects
   the runtime used to perform the next step.
5. Run the release dry run/gates against the fully integrated candidate.
6. Create the release commit and tag from the authorized clean integration
   owner. Push, registry publication, deployment, and production mutation remain
   separate authority.
7. Build or install the exact tagged package for local consumer verification;
   do not rely on an unrelated global executable.

Self-upgrade defects may require using the exact candidate CLI to refresh the
old controller once. Keep that bootstrap minimal, hash-bound, and followed by
ordinary doctor/readback under the new runtime.

## Verify a consumer release

Consumer verification should exercise supported operations in the real
controller, not only Juno's own repository tests:

1. Verify the invoked CLI and registered runtime both report the intended RC.
2. Rebind the controller using the exact installed executable and retain the
   receipt.
3. Refresh ignored managed scripts when required and prove their generation is
   current against the consumer target.
4. Run `yy task status`, then the relevant `start` or `preflight` canary.
5. Inspect the actual task worktree: exact base/target, clean parent repository,
   exact submodule gitlinks, instructions, dependencies, and focused test paths.
6. State precisely what passed. Distinguish lifecycle readiness from product
   implementation and deployed behavior.

Use a bounded read-only agent audit when independent inspection is valuable.
The prompt must forbid edits, commits, implementation, review, finish, merge,
release, and production mutation. Record its session ID and exact conclusion.

## Handle blockers without erasing evidence

- Classify the blocker: command routing, registered runtime, managed generation,
  target runtime, dependency hydration, product implementation, merge, release,
  or deployment. Fix the owning layer rather than the symptom.
- Preserve user-owned and integration-owner dirt. If a command requires a clean
  controller, checkpoint only controller metadata proven to belong to the
  current work; never reset broad paths.
- Stop stalled commands with read-only process evidence first. Remove only an
  exact, incomplete artifact when its provenance and safe recreation are known.
- Record failed evidence and why later evidence supersedes it. A successful
  rerun does not make the original failure disappear.
- Release another RC only for a newly isolated release-blocking code defect.
  Missing product implementation is not grounds for an endless RC train.

## Close with useful truth

Report the release tag and commit, implementation and merge commits, consumer
controller and task identities, tests/canaries run, preserved dirt, and anything
explicitly not performed. Mark the Kanban task with the integrated commit and a
response that lets the next agent resume without reconstructing the session.

