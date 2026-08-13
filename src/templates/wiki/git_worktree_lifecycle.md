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

yy task runtime-bootstrap --dry-run
# review the printed immutable receipt
yy task runtime-bootstrap --apply RECEIPT

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
concurrently. Runtime identity is validated before any Juno-specific generated-output
admission. Project classification is explicit: a source repository whose
`juno-code/package.json` names `juno-code` must provide both authoritative,
strict declarations; an ordinary consumer without that package identity has no
Juno-source declaration requirement.

If start reports a stale or absent target task runtime, `scripts update` refreshes
only controller-local bytes and is not the recovery. Run `yy task
runtime-bootstrap --dry-run`, review the immutable package/controller/target/path
receipt, then apply that exact receipt. This command is restricted to the exact
registered, sparse metadata-controller class and refuses synthetic/product/task
worktrees. Apply uses a clean isolated target worktree, creates a one-path
reviewed commit and durably records its apply intent. Before mutation it discovers
all exact target-ref holders under the repository writer lock. No holder uses an
expected-SHA CAS; one exact clean unlocked holder is synchronized with Git's
checked-out-branch reset so its ref, index, and files finish together. Dirty,
locked, moved, or multiple holders refuse before mutation with a supported clean,
unlock, or reviewed extra-worktree removal action. Interrupted holder synchronization
or completion recording is recovered by rerunning the same receipt; the durable
intent prevents another commit or unrelated ref mutation. Modified or completed
receipts, package mismatch, and target customization without exact source plus
validated managed-inventory provenance also refuse.

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

## Observable nonblocking execution

Use `@@life_cycle TASK_IDS_OR_GOAL` to load the versioned orchestration contract.
For example, `yy pi -p '@@life_cycle T1 then T2; stop before release'` preserves
the caller payload once while directing work through canonical `yy` lifecycle
commands.

For every long-running agent, finish, merge, or authorized release command,
create a private task-ID `mktemp -d` run directory and place distinct log, PID,
and footer files inside it. Capture combined stdout and stderr, keep the producer
timeout-bounded, atomically publish its PID immediately, and atomically rename a
strict `juno.watch-footer.v1` footer immediately after exit. Resolve
`controller_root=$(yy where controller)` and invoke the absolute
`$controller_root/.juno_task/scripts/watch_progress.py` path rather than a
checkout-relative script or rewritten polling loop. Its producer example,
JSONL/raw-payload framing, and footer/PID identity contract are in [watching
progress](watching_progress.md). A quiet process doing real-Git or test work is
active until PID/process evidence or a valid terminal footer proves completion;
log silence alone is never a hang signal. Report exact exit, elapsed duration,
and run-directory paths. This pattern adds observation only; Workflow Runner and
the managed-agent runner remain the execution owners.

Independent review is fresh and read-only against one frozen committed diff.
Task finish, merge/CAS, integration repair/push receipts, release build/tag/global
verification, and push/publish/deploy authorities remain separate boundaries.

Agent orchestration instructions and core skills are ignored installed assets in
the controller. Product/domain instructions and skills are tracked in product
history and materialized in task worktrees. A controller symlink inside the
integration owner is intentionally unnecessary and unsafe for search/staging;
use `yy where controller` when an agent or script needs the exact path.
