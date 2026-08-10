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

Controller execution comes from one released `juno-code` installation outside every linked or unrelated mutable Git worktree. The controller is the default agent entry point: that immutable package provisions ignored local `AGENTS.md`, `CLAUDE.md`, and the core Juno skills under `.agents/skills/`, `.claude/skills/`, and `.pi/skills/`. These files guide orchestration without becoming controller history. Product- or domain-specific skills stay with product code; after `yy task start`, the agent enters the returned worktree and loads its product instructions and skills there. `.juno_task/runtime/identity.json` and installed `.juno_task/scripts/` are also ignored local state. Rebinding that installed runtime preflights controller cleanliness and receipt immutability, rolls identity/config back on any failure, and must leave controller `HEAD`, tree, index, and product refs unchanged.

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

After review, generate the product metadata-removal diff in a disposable linked
worktree. Planning is read-only; apply refuses the inventoried source, the protected
target branch, dirty candidates, unrelated repositories, and stale base commits:

```bash
yy migrate evacuation-plan --inventory /durable/inventory.json \
  --policy /durable/policy-bundle.json --project /absolute/source \
  --output /durable/evacuation-plan.json
yy migrate evacuation-apply --plan /durable/evacuation-plan.json \
  --candidate /absolute/disposable-linked-worktree \
  --output /durable/evacuation-apply.json --allow-disposable-mutation
yy migrate evacuation-verify --plan /durable/evacuation-plan.json \
  --candidate /absolute/disposable-linked-worktree \
  --output /durable/evacuation-verify.json
```

Every controller-private root needs an owner disposition. Product-owned prompts,
config, docs, tests and code outside those roots remain untouched. Only the retired
top-level `lifecycle` and `controllerWorkspace` config keys are removed. Nested
repository or gitlink boundary crossings fail closed. The commands never stage,
commit, move a ref, register a controller, or delete rollback evidence.

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
  --policy-bundle /durable/path/reviewed-policy-bundle.json \
  --output /durable/path/migration-plan.json

python3 .juno_task/scripts/metadata_controller.py prepare \
  --plan /durable/path/migration-plan.json \
  --output /durable/path/prepare.json
```

`migration-plan` freezes the exact old controller, product target, installed runtime, selected metadata, excluded product/history inventory, rollback identity, and canonical reviewed metadata/task/risk policies. A single reviewed policy bundle is preferred; alternatively pass both `--task-workspace-policy` and `--risk-policy` with the global `--policy` metadata policy. `prepare` re-reads those exact sources and refuses source or content drift before mutation. It requires a fresh output receipt path, then creates a fresh unrelated root and linked worktree; it neither moves the product target nor changes live controller registration. The root boundary receipt binds every preserved source path, mode, blob identity, and generated policy digest. The old sparse/full controller remains intact.

Before a separately authorized cutover, run `verify --pending`, `verify-product`, the packaged real-Git acceptance test, Kanban mutation canaries while feature worktrees remain clean, and runtime-rebind verification. Then create a `cutover-plan` receipt. The supported registrar remains a separate, explicit boundary:

```bash
yy migrate registration plan \
  --source-controller /path/to/preserved-controller --source-ref refs/heads/old-controller --expected-source-head OLD_SHA \
  --target-controller /path/to/metadata-controller --target-ref refs/heads/juno/controller-metadata-v1 --expected-target-head NEW_SHA \
  --product-root /path/to/integration-owner --product-ref refs/heads/main --expected-product-head PRODUCT_SHA \
  --runtime /installed/bin/yy --runtime-version 2.1.1 --inventory /durable/inventory.json \
  --policy-bundle /durable/policy-bundle.json --pending-verification /durable/pending-verify.json \
  --output /durable/registration-plan.json

# Separate owner authorization is required at this line.
yy migrate registration apply --plan /durable/registration-plan.json \
  --output /durable/registration-apply.json --authorize-apply
yy migrate registration verify --plan /durable/registration-plan.json \
  --output /durable/registration-verify.json
```

The apply receipt is preceded by an immutable intent receipt. Repeating apply
is idempotent. If interruption leaves only planned endpoint values, the same
authorized command completes them; foreign config values fail closed. The
registrar never moves product or controller refs and refuses dirty, detached,
stale, runtime-drifted, policy-drifted, or unrelated worktrees. The same atomic
transition registers the product worktree as `integration-owner`, binds
`protected-integration.v1` authority and its exact starting commit, and proves
that strict Kanban writes are refused there. Planning requires a fresh product
worktree with no pre-existing workspace-role authority. A legacy source
controller may have either the explicit `controller` role or no persisted role
when the registered resolver proves it is the active controller.

Rollback is equally explicit: preserve the prior controller worktree/ref,
verify the active metadata controller, and run `yy migrate registration
rollback --plan /durable/registration-plan.json --output
/durable/registration-rollback.json --authorize-rollback`. It restores the
exact frozen registration values, all three product role values, and the
pending-controller role. Neither
transition merges controller commits into product history, rewrites history,
deletes a worktree, pushes, or releases. Keep every receipt outside the Git
common directory and all protected worktrees.

## Operating topology after cutover

The controller branch remains separate because it owns Kanban state. A separate
long-lived integration branch is not required merely to synchronize controller
and product state. `integration-owner` is a protected clean worktree role for
the real product target. Its checkout is detached while the merge queue owns the
target-ref CAS window, then attached to the exact target for shared validation,
servers, release, or deploy. A project may still choose a staging branch as an
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
                  real product target ref (CAS guarded;
                   integration owner detached)
                              |
                              v
             attach clean integration-owner at exact target SHA
                full suite, shared local stack, deploy manager
                              |
                              v
                detach before the next queue mutation
```

Run Kanban and task/merge orchestration from the metadata controller. Run agent
development and focused tests from the returned feature worktree. Run the full
multi-service stack, integration/E2E validation, release build, and deploy
manager from the clean integration-owner worktree after queued changes merge.
Deployment remains a separate authority. Never deploy from the controller or
from an unfinished feature worktree. If feature worktrees need local servers,
give each isolated ports and state; otherwise keep the shared stack solely in
the integration-owner worktree.

The transition is serialized: stop shared servers and require a clean checkout,
detach the integration owner before `yy merge next|resolve`, drain or pause the
queue, attach the exact target ref for shared validation/deployment, then detach
again before another queue mutation. Never leave the target ref attached while
expecting queue CAS to advance it.

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
