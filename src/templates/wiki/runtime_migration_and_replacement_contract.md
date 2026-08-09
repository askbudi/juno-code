---
wiki_contract:
  line_limit: 140
  purpose: "Stable planning and validation guidance for runtime, API, UI, and data-source replacements."
  failure_mode_prevented: "Agents preserve visible behavior while missing access, ownership, limit provenance, backing-data feasibility, stale callers, or efficient validation ownership."
  runtime_contract_enforced: "Replacement work inventories old and new ownership, decides every invariant explicitly, removes obsolete paths, and assigns targeted/full validation to named roles."
  validation_gate: "./.juno_task/scripts/wiki_lint.sh --file .juno_task/wiki/runtime_migration_and_replacement_contract.md && git diff --check -- .juno_task/wiki/runtime_migration_and_replacement_contract.md"
  related_sots:
    - "parallel_runner_and_spec_review.md"
  owns:
    - "Generic runtime migration and replacement planning invariants."
    - "Replacement ledger, limit provenance, feasibility, and validation-ownership conventions."
  does_not_own:
    - "Feature-specific IDs, limits, labels, vocabulary, data counts, or acceptance evidence."
    - "Task creation mechanics, post-run review mechanics, or task-specific validation commands."
---

# Runtime Migration and Replacement Contract

Use this guide when replacing a runtime path, API, UI surface, mapper, or data source. Task-specific specs and tests remain authoritative for concrete IDs, labels, limits, vocabulary, data counts, and acceptance commands.

## Compact context first

Retrieve the assigned task with `kanban.sh get <ID> --compact`. Fetch a named parent, blocker, or related task separately only when its complete body is required. Do not recursively load the relation graph by default.

## Inventory before partitioning

Write an old/new inventory before implementation:

```text
Concern | Old owner/path | New owner/path | Public surface | Allowed callers | Decision | Evidence
```

Inventory the public and internal path end to end. Include producer, storage, reader, API, and UI—not only the visible component. Partition tasks by coherent write/runtime ownership so one task and one targeted test set can prove each path; split work when ownership, failure behavior, or test matrices differ.

## Decide invariants explicitly

For each old behavior, record `preserve`, `change`, or `remove`, with its owner and test. At minimum evaluate:

- identifiers and anchors;
- authentication, access, quota, and entitlement;
- filters, ordering, pagination, and limits;
- fallback and empty/error behavior;
- links, copy, and navigation;
- telemetry and observability;
- source-of-truth and write ownership.

Silence is not preservation. Any changed invariant requires explicit owner approval in the task/spec; removed behavior needs deletion evidence.

## Trace limits to their owner

For every count, cap, page size, sample, or retention boundary, trace provenance:

```text
producer -> storage -> reader -> API -> UI
```

Record where truncation first occurs and whether downstream layers can request or display more. Do not infer a safe limit from the nearest constant or UI shape. Feature-specific numeric values belong in the task spec and tests, not this guide.

## Prove backing-data feasibility

Before promising a data-driven section or migration result, run the smallest bounded read-only probe that proves the required fields, coverage, cardinality, and join/key semantics exist. Record unavailable or sparse data as a planning constraint. Do not invent fallback data, a second source of truth, or an unapproved adapter to make the surface appear complete.

## Keep a replacement ledger

Maintain a task/spec ledger during implementation:

```text
Old symbol/path | New symbol/path | Allowed remaining callers | Removal decision | Test/grep evidence
```

Search definitions, imports, route registrations, configuration, tests, and generated/public surfaces. A replacement is incomplete while an obsolete mapper, reader, endpoint, fallback, or alternate owner remains outside the explicitly allowed caller list. Finish with a deletion grep scoped to the affected paths.

## Controller/workspace replacement boundary

When replacing controller-facing runtime, freeze metadata, product, installed-runtime, and local-ignored ownership before migration. Create a fresh metadata-only linked controller and retain the former controller read-only for rollback; never convert the active controller in place. Validate product bytes in explicit product worktrees and persist ref-moved/conflict states as resumable truth.

## Canonical managed-agent execution

Lifecycle workers/reviewers and typed workflow `managed_agent` steps delegate process ownership to
`.juno_task/scripts/managed_agent_runner.py`. Call `run --mode worker|reviewer` with absolute controller,
agent, prompt, and output roots plus worker admission receipts or reviewer candidate identity. The runner
uses only fresh configured-default `yy pi`, closes stdin, sanitizes outer agent routing, and stays foreground.
Its live `stdout.log`, `stderr.log`, and labelled `combined.log` are canonical while `receipt.json` hash-binds
prompt, capture, session, response, identity, and terminal truth. Never wrap it with another capture owner,
provider/model override, shell/eval, detached producer, or manually reconstructed receipt.

## Validation ownership convention

Use one deliberate validation owner per level:

```text
implementation worker -> targeted changed-path tests
independent reviewer  -> one full task-specific gate
root reviewer         -> targeted high-risk smoke + evidence review
```

This is a convention, not automatic test-impact inference or an acceptance mechanism. Rerun the full gate when evidence is missing, stale, failed, or contradicted by review. Human semantic review remains required; tests must prove the backing producer/storage/reader behavior and cleanup, not only the new visible output.

## Required task evidence

A migration/replacement task or review artifact should contain the inventory, invariant decisions, limit provenance, bounded feasibility result, replacement ledger, task ownership split, and exact role-owned validation commands. Store volatile run evidence in Kanban responses or task specs, never in this global guide.

## Why backing implementation matters

Snapshot or UI-only tests can preserve shape while access rules, producer limits, source ownership, or stale callers remain wrong. Backing-path tests plus deletion evidence prove the replacement is real rather than a parallel path hidden behind equivalent output.

Failure mode prevented: migrations preserve visible shape but miss access/anchor invariants, inherit the wrong limit, promise unavailable data, retain stale alternate paths, recursively load context, or repeat expensive full validation in every worker.

Runtime contract enforced: replacements have explicit old/new ownership, invariant decisions, end-to-end limit provenance, bounded feasibility, deletion evidence, coherent task boundaries, and one full independent review owner.

Exact validation gate:

```bash
./.juno_task/scripts/wiki_lint.sh --file .juno_task/wiki/runtime_migration_and_replacement_contract.md
git diff --check -- .juno_task/wiki/runtime_migration_and_replacement_contract.md
```
