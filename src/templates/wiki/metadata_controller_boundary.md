---
wiki_contract:
  line_limit: 220
  purpose: 'Plan, prepare, verify, and roll back the metadata-only controller boundary without product-ref mutation.'
  failure_mode_prevented: 'Controller/product history reconciliation, tracked runtime copies, in-place conversion, and ambiguous rollback.'
  runtime_contract_enforced: 'metadata_controller.py'
  validation_gate: 'python3 .juno_task/scripts/tests/test_metadata_controller.py'
  related_sots:
    - 'git_worktree_lifecycle.md'
---

# Metadata-only controller boundary

## Ownership

The controller is a state store, never a product source or integration participant. Controller commits never merge or synchronize into a product target. Its root commit contains only the paths admitted by `.juno_task/config/metadata-controller.json`:

```text
.juno_task/tasks/       canonical current Kanban tasks
.juno_task/ledger/      canonical task history
.juno_task/specs/       top-level task plans and decisions
.juno_task/state/       lifecycle.json plus atomic tasks.json task/queue state
.juno_task/receipts/    top-level final boundary/transition receipts
.juno_task/config/      minimal controller policy
```

Product source, tests, package metadata, release tooling, generated product assets, and bulky workflow attempts are absent. Only top-level spec and final-receipt files cross the migration boundary; nested workflow/lifecycle/task-set evidence, nested receipt trees, and arbitrary state files are rejected. They stay in the preserved rollback controller instead of bloating every future controller commit. Task and ledger directories remain recursive because they are canonical segmented stores. A product branch may retain minimal project lifecycle config, prompts, and install inputs, but it must not contain the controller-private roots declared by `product_forbidden`.

Controller execution comes from one released `juno-code` installation outside every linked or unrelated mutable Git worktree. `.juno_task/runtime/identity.json` and installed `.juno_task/scripts/` are ignored local state. Rebinding that installed runtime preflights controller cleanliness and receipt immutability, rolls identity/config back on any failure, and must leave controller `HEAD`, tree, index, and product refs unchanged.

## Preservation-first migration

Existing Juno Code 2.0 projects first freeze project facts and owner decisions;
they do not begin with `metadata_controller.py prepare`. The packaged inventory
is read-only and its receipt must live outside the inspected repository:

```bash
yy migrate inventory --project /absolute/project --output /durable/inventory.json
yy migrate owner-template --inventory /durable/inventory.json \
  --output /durable/owner-answers.json
yy migrate generate-policy --inventory /durable/inventory.json \
  --answers /durable/owner-answers.json --output /durable/policy-bundle.json
```

Policy generation refuses unresolved or `block` dispositions and runs the
canonical metadata-controller, task-workspace and risk-policy validators. The
result is still a candidate: it grants no prepare, registration, ref movement,
cleanup, or release authority. See `@@migrate_juno_code_v2_to_v2_1`.

The boundary helper deliberately does not register the new controller:

```bash
python3 .juno_task/scripts/metadata_controller.py migration-plan \
  --old-controller /path/to/old-controller \
  --old-branch refs/heads/old-controller \
  --expected-old-head OLD_SHA \
  --new-controller /path/to/new-controller \
  --new-branch refs/heads/juno/controller-metadata-v1 \
  --product-ref refs/heads/main \
  --expected-product-head PRODUCT_SHA \
  --runtime /installed/bin/yy \
  --runtime-version X.Y.Z \
  --output /durable/path/migration-plan.json

python3 .juno_task/scripts/metadata_controller.py prepare \
  --plan /durable/path/migration-plan.json \
  --output /durable/path/prepare.json
```

`migration-plan` freezes the exact old controller, product target, installed runtime, selected metadata, excluded product/history inventory, and rollback identity. It is receipt-only. `prepare` requires a fresh output receipt path before mutation, then creates a fresh unrelated root and linked worktree; it neither moves the product target nor changes live controller registration. The root boundary receipt binds every preserved source path, mode, and blob identity. The old sparse/full controller remains intact.

Before a separately authorized cutover, run `verify --pending`, `verify-product`, the packaged real-Git acceptance test, Kanban mutation canaries while feature worktrees remain clean, and runtime-rebind verification. Then create a `cutover-plan` receipt. Registration mutation is outside this helper and requires explicit owner authorization.

Rollback is equally explicit: preserve the prior controller worktree/ref, verify the active metadata controller, create a `rollback-plan`, then use the separately authorized registrar. Neither transition merges controller commits into product history, rewrites history, deletes a worktree, pushes, or releases.

## Operating topology after cutover

The controller branch remains separate because it owns Kanban state. A separate
long-lived integration branch is not required merely to synchronize controller
and product state. `integration-owner` is a clean worktree role attached to the
real product target ref; a project may still choose a staging branch as an
explicit product policy, but the controller never merges into it.

```text
metadata controller branch/worktree (Kanban, ledger, decisions, receipts)
        | task start X                         | task start Y
        v                                      v
feature/X branch + worktree              feature/Y branch + worktree
  agent edits + focused tests              agent edits + focused tests
        | task finish                         | task finish
        +---------------- merge queue --------+
                              |
                              v
                  real product target ref (CAS guarded)
                              |
                              v
             clean integration-owner worktree at exact target SHA
                full suite, shared local stack, deploy manager
```

Run Kanban and task/merge orchestration from the metadata controller. Run agent
development and focused tests from the returned feature worktree. Run the full
multi-service stack, integration/E2E validation, release build, and deploy
manager from the clean integration-owner worktree after queued changes merge.
Deployment remains a separate authority. Never deploy from the controller or
from an unfinished feature worktree. If feature worktrees need local servers,
give each isolated ports and state; otherwise keep the shared stack solely in
the integration-owner worktree.

## Refusal rules

Refuse when any of these identities drift:

- old controller path, attached full branch ref, or expected head;
- reviewed metadata controller/product refs;
- Git common directory;
- installed released executable, version, or executable digest;
- metadata policy digest;
- new destination freshness;
- metadata-only root/tree boundary or local runtime binding;
- product target expected SHA or controller-private path absence.

Verification accepts ordinary descendants of the prepared root while checking the unique root tree against the receipt-bound source bytes and the current tree against the narrow boundary. Current tasks, ledger, and top-level specs must each remain nonempty; optional metadata classes are not invented as requirements. Canonical config/policy, state files, and the immutable root boundary receipt must remain present and structurally valid. Creating or staging a product path, deleting the whole canonical board, deleting a generated control, adding nested spec/receipt evidence, or adding an unrecognized state/config path makes verification fail. Runtime updates are local generation changes, not controller/product synchronization work.
