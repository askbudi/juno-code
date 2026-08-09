---
juno_wiki:
  purpose: 'Create, inspect, and queue one exact-base feature worktree.'
  runtime_contract_enforced: 'yy task owns task workspace admission and finish validation.'
  validation_gate: 'python3 .juno_task/scripts/tests/test_task_workspace.py'
---

# Task worktrees

The controller is a metadata store. It owns Kanban, compact task state, and task artifacts, but it is not a product checkout and never merges or synchronizes into the product target.

```text
controller: Kanban + atomic .juno_task/state/tasks.json (tasks + queues/conflicts)
       |
       +-- yy task start X --> product worktree X -- implement/commit
       |
       `-- yy task start Y --> product worktree Y -- implement/commit

product worktree -- yy task finish --> focused validation --> QUEUED
                                                              |
                     yy merge next -- affected validation -- risk plan
                                   | conflict                 |
                                   |                          +-- low/normal eligible --> CAS
                                   `--> CONFLICT              `-- high --> AWAITING_RISK
                                         |                                  |
                                  yy merge resolve                    yy merge review TASK_ID
                                                                            |
                                                              yy merge next -- verify exact receipt
                                                                            |
                                                           expected-old-SHA target CAS --> MERGED
```

## Public task interface

```text
yy task start TASK_ID
yy task status TASK_ID
yy task finish TASK_ID

yy merge status
yy merge next
yy merge next TASK_ID
yy merge resolve TASK_ID
yy merge review TASK_ID
yy merge reopen TASK_ID
```

`start` reads the canonical segmented task and `.juno_task/config/task-workspace.json`, freezes the target SHA, and creates exactly one deterministic branch/worktree. Repeating it succeeds only for the same clean base identity. Existing branches, existing paths, moved targets, dirty worktrees, and identity drift refuse without discarding anything.

`status` reads one bounded task record. It reports target movement but does not fetch, write state, mutate Git, or update the task.

`finish` requires a clean branch tip that descends from the frozen base and contains committed changes only under configured allowed product paths. Controller-private paths always refuse. Every configured focused command must pass. Success records the tip and changed paths as `QUEUED`; refusal preserves the branch and worktree as `WORKING`.

Neither `start` nor `finish` mutates the target. `merge next` is the only normal target writer: a nonblocking lock lives in the repository Git common directory and is scoped to the full target ref, so every controller for that repository contends on the same lock. Direct descendants reuse the feature tip, and a moved target gets one ordinary both-parent merge in a temporary checkout. It runs affected validation once, derives a strict Git-based risk plan for the full target-to-candidate diff, and verifies canonical evidence before advancing the ref with an expected-old-SHA compare-and-swap followed by exact ref/tree readback. Missing or hand-written PASS fields never imply low risk or authorize CAS.

Low risk uses zero reviews; normal risk permits zero or one; high risk durably enters `AWAITING_RISK` and requires `yy merge review TASK_ID` to run the configured full validation and Reviewer A then Reviewer B against the same frozen SHA. Each verified PASS is persisted in the single task state before the next reviewer starts. A transport retry revalidates and reuses A, launches only missing B in a fresh attempt namespace, and never overwrites old evidence. Review only writes a bounded canonical receipt; `yy merge next TASK_ID` freshly verifies that exact awaiting candidate and performs CAS.

Bare `yy merge next` continues FIFO work among `QUEUED` tasks, so an awaiting risk or release decision never starves independent features. Findings enter `REVIEW_FINDINGS` and reviewer failures preserve truthful awaiting state; neither moves the target. After fixing findings in the same clean feature worktree and committing a new descendant tip, `yy merge reopen TASK_ID` validates the new product diff, safely removes only the exactly owned old composed checkout, clears active review evidence, and requeues the task. Release authority is separate: a release candidate remains `AWAITING_RELEASE` until an owner-authorized release-gate receipt exists, and the merge queue performs no release action. The full target ref must be unowned by every worktree (use a detached integration checkout); the queue fails closed before CAS rather than making a checked-out branch incoherent. It never rebases, squashes, force-updates, pushes, releases, or synchronizes the controller.

Text conflicts become durable `CONFLICT` records containing exact target/feature identities, conflict paths, and the preserved checkout. Resolve only those paths, stage them, and run `yy merge resolve TASK_ID`. Unrelated drift refuses. If affected validation fails, `CONFLICT_RESOLVED` retains the same resolved commit and checkout; retrying `merge resolve` revalidates it without recreating the worktree or repeating the merge. Task, queue, attempt, and conflict truth share one atomic `tasks.json` replacement—there is no second queue ledger. Cleanup only removes the exact registered, detached, clean queue-owned checkout whose HEAD is the reachable candidate. `yy merge status` is bounded deterministic observation.

## Configuration

The policy contains one repository, one full local target ref, one explicit worktree root, one branch prefix, allowed product roots, controller-private roots, argv-based focused validation rows, and one distinct `full_suite_validation` row. `merge next` runs affected validation once; only a risk plan that requires the full suite runs the separately configured full-suite command, exactly once for an unchanged candidate/config identity. Before execution, the task review lease admits a fresh random-token claim at an attempt-specific canonical path under controller state using exclusive creation; the receipt is also exclusively created at the exact path named by that claim, and `tasks.json` advances from `CLAIMED` to `COMPLETE` only after strict verification. The receipt binds the claim path/digest/token/attempt, candidate SHA/tree, risk policy, exact workspace/full-suite configuration, argv/bounds, timestamps, exit/timeout result, full stream digests, and bounded tails. Cache reuse and final risk-evidence import reopen both files; the queue additionally requires the persisted `COMPLETE` admission and canonical controller-state containment. Boolean PASS projections, arbitrary external receipts, and state-only receipt references are ignored. A valid nonzero or timed-out receipt advances the admission to retryable `FAILED`, records bounded failure detail, and dispatches no reviewer; the next explicit review strictly revalidates that historical failure before creating attempt N+1 and never overwrites prior evidence. A crash with a successful claimed receipt can finish admission deterministically without rerunning, while restart with a failed claimed receipt deterministically records `FAILED` at the same N and returns; a valid claim without a receipt reruns that same N. The suite-attempt counter advances only with a fresh exclusive claim, while a separate bounded reviewer counter preserves transport retry namespaces. Preexisting paths refuse rather than overwrite and are tracked separately from successful claim numbering. Malformed or tampered FAILED tokens, digests, projections, claims, or receipts hard-refuse and preserve the prior admission. This is queue authority and crash consistency for cooperating processes, not signing or protection against a hostile process running as the same OS user. Commands are argv arrays rather than shell strings; stdin is closed, every row has a bounded timeout, and pipes are closed. After the suite and each reviewer PASS, the worker briefly rechecks the target and durable task claim before spending tokens on another reviewer; target movement immediately enters recoverable stale-candidate cleanup and requeue. The installed Juno Code package owns the runtime template; the controller receives an ignored generated runtime copy.

Historical lifecycle evidence remains read-only during the Bolt migration. New task work uses this interface and does not extend the former controller-sync path.
