---
juno_wiki:
  purpose: 'Create, inspect, and queue one exact-base feature worktree.'
  runtime_contract_enforced: 'yy task owns task workspace admission and finish validation.'
  validation_gate: 'python3 .juno_task/scripts/tests/test_task_workspace.py'
---

# Task worktrees

The controller is a metadata store. It owns Kanban, compact task state, and task artifacts, but it is not a product checkout and never merges or synchronizes into the product target.

```text
controller: Kanban + .juno_task/state/tasks.json
       |
       +-- yy task start X --> product worktree X -- implement/commit
       |
       `-- yy task start Y --> product worktree Y -- implement/commit

product worktree -- yy task finish --> focused validation --> QUEUED
                                                              |
                     yy merge next -- affected validation ----+
                                   | conflict
                                   `--> CONFLICT -- yy merge resolve TASK_ID
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
yy merge resolve TASK_ID
```

`start` reads the canonical segmented task and `.juno_task/config/task-workspace.json`, freezes the target SHA, and creates exactly one deterministic branch/worktree. Repeating it succeeds only for the same clean base identity. Existing branches, existing paths, moved targets, dirty worktrees, and identity drift refuse without discarding anything.

`status` reads one bounded task record. It reports target movement but does not fetch, write state, mutate Git, or update the task.

`finish` requires a clean branch tip that descends from the frozen base and contains committed changes only under configured allowed product paths. Controller-private paths always refuse. Every configured focused command must pass. Success records the tip and changed paths as `QUEUED`; refusal preserves the branch and worktree as `WORKING`.

Neither `start` nor `finish` mutates the target. `merge next` is the only normal target writer: a nonblocking lock is scoped to the repository identity and full target ref, direct descendants reuse the feature tip, and a moved target gets one ordinary both-parent merge in a temporary checkout. It runs affected validation once and advances the ref with an expected-old-SHA compare-and-swap followed by exact ref/tree readback. It never rebases, squashes, force-updates, pushes, releases, or synchronizes the controller.

Text conflicts become durable `CONFLICT` records containing exact target/feature identities, conflict paths, and the preserved checkout. Resolve only those paths, stage them, and run `yy merge resolve TASK_ID`. Unrelated drift refuses. Resolution reuses the preserved checkout, validates the new candidate, and performs the same CAS; it never recreates or cleans the feature worktree. `yy merge status` is bounded deterministic observation.

## Configuration

The policy contains one repository, one full local target ref, one explicit worktree root, one branch prefix, allowed product roots, controller-private roots, and argv-based focused validation rows. Commands are argv arrays rather than shell strings; stdin is closed, every row has a bounded timeout, and only configured-size stdout/stderr tails enter task evidence. The installed Juno Code package owns the runtime template; the controller receives an ignored generated runtime copy.

Historical lifecycle evidence remains read-only during the Bolt migration. New task work uses this interface and does not extend the former controller-sync path.
