# Migrate a Juno Code v1 project

Treat migration as an explicit, reversible boundary. Do not silently adopt an
existing environment, mutate production data, move product refs, publish, or
delete the previous controller.

## 1. Inventory and freeze

Record the current controller path/ref/HEAD, product target ref/HEAD, installed
Juno Code executable/version, Kanban storage identity, worktrees, dirty state,
and rollback owner. Resolve each required dependency to an exact reviewed source
commit and executable. A compatible but older binary is stale.

Persist an owner-answer manifest before mutation. It must contain:

- absolute project root and Git common directory; nested repositories/gitlinks;
  remotes without embedded credentials; current ref/HEAD; exact full product
  target ref and expected base SHA;
- desired absolute fresh controller path and full controller branch, existing
  path/ref disposition, checkpoint owner, and controller-only durable roots;
- desired absolute integration-owner worktree, whether it checks out the product
  target directly or an explicitly named product integration ref, current
  checkout conflicts, and expected-SHA local-integration owner;
- task-worktree parent, full branch-prefix convention, concurrency needs,
  repositories expected to change, and cleanup owner;
- separate yes/no authorities for bootstrap, local integration, controller
  preparation, registration, product-ref movement, push, publication,
  release/tag, deployment, production mutation, cleanup, and E2E.

Inventory top-level plus unusually large/ignored paths and ask the owner to
classify every meaningful group as product-required, controller-only durable,
external durable evidence, generated/rebuildable excluded, or unresolved
blocker. Explicitly cover artifacts, screenshots, recordings, reports,
workflow receipts, logs, caches, generated builds, local datasets,
exports/backups, and design assets. Record count/size, rationale, retention,
and owner. Never move, delete, ignore, or make tracked product input
controller-only merely because it is large. Ordinary Git worktrees share the
tracked tree; lighter checkouts require a reviewed sparse/external policy plus
build and test proof.

Apply the shared package preflight before any canonical board access: reject Juno
Kanban 2.0.5 because its sdist could omit `Requires-Dist: ruamel.yaml`; select
the reviewed 2.0.6 source commit
`1ed2de072a52c7c9ae0559d62e097a04af595a73`, bind a separately reviewed wheel
SHA, inspect bounded `ruamel.yaml>=0.18.6,<0.19` metadata, and prove normal
clean-environment install/import/public-CLI smoke. A `--no-deps` fixture must
fail before board access. Ambient dependency leakage is not acceptance.

## 2. Create the metadata controller

Use the installed metadata-controller migration command and its reviewed policy
to create a fresh unrelated-root controller checkout on the owner-selected full
ref. It contains only Kanban,
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
