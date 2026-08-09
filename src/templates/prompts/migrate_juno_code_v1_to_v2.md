# Migrate a Juno Code v1 project

Treat migration as an explicit, reversible boundary. Do not silently adopt an
existing environment, mutate production data, move product refs, publish, or
delete the previous controller.

## 1. Inventory and freeze

Record the current controller path/ref/HEAD, product target ref/HEAD, installed
Juno Code executable/version, Kanban storage identity, worktrees, dirty state,
and rollback owner. Resolve each required dependency to an exact reviewed source
commit and executable. A compatible but older binary is stale.

## 2. Create the metadata controller

Use the installed metadata-controller migration command and its reviewed policy
to create a fresh unrelated-root controller checkout. It contains only Kanban,
task state/specs, compact receipts, and configuration. Runtime scripts are
ignored installed bytes. Product paths must be absent. Preserve the old
controller read-only until canaries and owner acceptance complete.

## 3. Configure Bolt product work

Set the exact product target ref, allowed paths, focused validation, worktree
root/branch prefix, and risk policy. Validate:

```text
yy task start CANARY_X
yy task start CANARY_Y
yy task finish CANARY_X
yy task finish CANARY_Y
yy merge status
yy merge next
```

Prove concurrent worktrees, a moved-target composition, a real preserved
conflict followed by `yy merge resolve TASK_ID`, failed-test no-movement, and
expected-SHA CAS. Low risk uses zero semantic reviewers, normal at most one,
high Reviewer A then Reviewer B on one frozen candidate. Post-CAS verification
is deterministic identity/readback only.

## 4. Cut over and verify

Move controller registration only with explicit owner authorization. Confirm
Kanban mutation, task status, queue status, controller checkpoint durability,
installed-package parity, and historical Workflow Runner doctor readback.
Controller commits never synchronize into product history.

Retired feature-integration commands must refuse with migration to `yy task` and
`yy merge`; do not provide an adapter or dual execution path. Cleanup of the old
controller, push, release, publication, deployment, production mutation,
restart, and post-deploy E2E each remain separately authorized.
