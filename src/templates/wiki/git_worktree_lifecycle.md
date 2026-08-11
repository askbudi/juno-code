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
yy task start TASK_ID --path juno_kanban  # repeat --path for policy-admitted roots
yy task status TASK_ID
yy task finish TASK_ID

yy merge status
yy merge next
yy merge resolve TASK_ID
```

Task start freezes the exact configured product target SHA and any explicitly
selected policy-admitted product roots, then creates one branch/worktree. Before
editing or testing there, the worker follows [task dependency hydration](task_dependency_hydration.md)
for each configured validation cwd and stops on provisioning or clean-tree
failure. Task finish requires a clean committed tip, allowed changed paths, and
focused validation before queueing. Independent features can remain active
concurrently.

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

## Checkout-aware entry points

The same installed `yy` command can start in the controller, integration owner,
task worktree, or a nested directory. Shared Git registration binds those
checkouts to one exact controller path/ref and product target; routing happens
before checkout-local bootstrap. The caller's checkout is never switched,
cleaned, stashed, or made authoritative by inference.

```text
invocation directory
  +-- controller ---------+
  +-- integration owner --+--> controller router --> Kanban/task/merge runtime
  +-- task worktree ------+
  +-- nested directory ---+

product bytes
  +-- task worktree ------> edit, focused test, commit
  +-- integration owner --> synced read/debug/server checkout
```

Use `yy info --json` for stable machine-readable topology, `yy where
controller|integration|target|task` for one script-safe path, and `yy doctor
workspace` for offline health/refusal guidance. Missing, stale, dirty, attached,
or ambiguous integration ownership fails closed.

## Integration owner lifecycle

```text
status [--fetch]
       |
       v
sync: guard -> fetch -> verify target -> fast-forward -> exact submodules
       |
       +--> healthy: inspect/debug/start local server here
       +--> refusal: repair --dry-run -> review receipt -> repair --apply RECEIPT

publication: push --dry-run -> separate authorization -> push --apply RECEIPT
             child repositories first -----------------------> root last
```

Repair never discards local work, and push never follows from sync or repair
authority. Every apply binds the reviewed receipt to exact topology and SHAs,
rechecks readiness under a lock, and records partial-failure truth for safe
retry. Package publication, deployment, production mutation, and post-deploy
E2E remain outside these commands.

Agent orchestration instructions and core skills are ignored installed assets in
the controller. Product/domain instructions and skills are tracked in product
history and materialized in task worktrees. A controller symlink inside the
integration owner is intentionally unnecessary and unsafe for search/staging;
use `yy where controller` when an agent or script needs the exact path.
