---
title: Bolt task worktrees and merge queue
runtime_contract_enforced: "yy task owns feature worktrees; yy merge owns per-target composition and CAS."
validation_gate: "python3 .juno_task/scripts/tests/test_task_workspace.py && python3 .juno_task/scripts/tests/test_merge_queue.py"
---

# Bolt task worktrees and merge queue

The controller is a metadata store. It contains Kanban/task truth and compact
receipts, not product code. Runtime scripts are installed from one versioned
Juno Code package and are not synchronized through product history.

```text
metadata controller
  +-- yy task start X --> product worktree X -- implement/test/commit --+
  +-- yy task start Y --> product worktree Y -- implement/test/commit --+--> queue
                                                                          |
                                                   one target lock + expected-SHA CAS
                                                                          |
                                             moved target -> compose; conflict -> preserve
                                                                          |
                                                           verify identity -> MERGED
```

## Public commands

```text
yy task start TASK_ID
yy task status TASK_ID
yy task finish TASK_ID

yy merge status
yy merge next
yy merge resolve TASK_ID
```

Task start freezes the exact configured product target SHA and creates one
branch/worktree. Task finish requires a clean committed tip, allowed changed
paths, and focused validation before queueing. Independent features can remain
active concurrently.

The merge queue serializes only target mutation. It uses a per-target lock and
expected-old-SHA update. If the target moved, it builds a candidate from the
latest target plus the feature tip. Conflicts are explicit durable state and the
candidate is preserved for `merge resolve`; failed validation never advances
the target.

Review is risk-based: low zero, normal at most one, high Reviewer A then Reviewer
B on the same frozen candidate. A changed candidate invalidates prior review.
After CAS, only deterministic identity/readback and bounded smoke checks run.

Cleanup refuses unless the delivered commit is reachable and the task worktree
is safe to remove. Push, release, publication, deployment, production mutation,
restart, and post-deploy E2E are never implied by merge completion.

Historical local-integration receipts remain readable by Workflow Runner doctor.
Their executors are retired and must not be adapted into the Bolt path.
