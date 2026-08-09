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
```

## Public task interface

```text
yy task start TASK_ID
yy task status TASK_ID
yy task finish TASK_ID
```

`start` reads the canonical segmented task and `.juno_task/config/task-workspace.json`, freezes the target SHA, and creates exactly one deterministic branch/worktree. Repeating it succeeds only for the same clean base identity. Existing branches, existing paths, moved targets, dirty worktrees, and identity drift refuse without discarding anything.

`status` reads one bounded task record. It reports target movement but does not fetch, write state, mutate Git, or update the task.

`finish` requires a clean branch tip that descends from the frozen base and contains committed changes only under configured allowed product paths. Controller-private paths always refuse. Every configured focused command must pass. Success records the tip and changed paths as `QUEUED`; refusal preserves the branch and worktree as `WORKING`.

Review, candidate construction, conflict handling, target mutation, release, push, deployment, and cleanup are separate operations. Neither `start` nor `finish` invokes them. Product target movement after start is normal queue input and never causes an implicit rebase.

## Configuration

The policy contains one repository, one full local target ref, one explicit worktree root, one branch prefix, allowed product roots, controller-private roots, and argv-based focused validation rows. Commands are argv arrays rather than shell strings. The installed Juno Code package owns the runtime template; the controller receives an ignored generated runtime copy.

Historical lifecycle evidence remains read-only during the Bolt migration. New task work uses this interface and does not extend the former controller-sync path.
