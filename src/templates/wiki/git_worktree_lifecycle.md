---
wiki_contract:
  line_limit: 250
  purpose: "One public exact-base implementation, review, CAS, target-verification, and cleanup state machine."
  failure_mode_prevented: "Controller edits, stale integration, review ping-pong, fictional PASS, target ambiguity, and unsafe cleanup."
  runtime_contract_enforced: "yy lifecycle owns task-level phase ordering while low-level Git helpers remain internal."
  validation_gate: "python3 -m unittest .juno_task/scripts/tests/test_task_lifecycle.py && python3 .juno_task/scripts/tests/test_integration_concurrency.py"
  related_sots:
    - "parallel_runner_and_spec_review.md"
---

# Single-repository task lifecycle

## Public interface

```bash
yy lifecycle run --manifest /absolute/task-lifecycle.yaml
yy lifecycle status --state /absolute/artifacts/state.json
yy lifecycle resume --state /absolute/artifacts/state.json
```

These are operations of one public lifecycle. `worktree_lifecycle.py`, `integration_candidate.py`, and `integration_owner_preflight.py` remain internal proven phase primitives. Operators do not sequence them.

Minimal JSON manifest (YAML is accepted when controller PyYAML is available):

```json
{
  "schema_version": "juno_task_lifecycle.v1",
  "task_id": "T123",
  "controller_root": "/absolute/controller",
  "objective_risk": "high",
  "owner_risk_escalation": null,
  "repositories": [{
    "id": "root",
    "path": "/absolute/integration-owner",
    "target_ref": "refs/heads/integration",
    "approved_base_sha": "FULL_40_CHARACTER_SHA",
    "task_worktree": "/absolute/new-task-worktree",
    "task_branch_ref": "refs/heads/juno/task-T123",
    "expected_paths": ["src/owned-area", "tests/owned-test.ts"]
  }],
  "artifact_root": "/absolute/controller-artifacts/T123/run-1",
  "cleanup_owner": "logical-orchestrator",
  "requirements_checklist": "/absolute/T123-requirements.md",
  "validation_commands": ["npm test", "npm run typecheck", "npm run build"],
  "review": {"initial_pair_limit": 1, "replacement_pair_limit": 1}
}
```

Optional `parity_pairs` contains two-path arrays whose bytes must match. Agent commands normally use fresh `yy pi` with inherited defaults; configured implementation/repair/review commands are accepted only when they remain fresh canonical `yy pi` argv without provider/model overrides. Timeouts are bounded under `timeouts.agent_seconds` and `timeouts.validation_seconds`.

Release, push, publication, deployment, production mutation, restart, and post-deploy E2E are intentionally outside this reusable lifecycle.

## Exact-base topology

The controller owns Kanban, prompts, and durable state. It is never the product implementation base. The manifest names an explicit repository checkout, full `refs/heads/...` target, approved SHA, task path/ref, and complete expected paths. `prepare` rereads the target and creates the task worktree from that exact integration SHA. A controller branch or controller `HEAD` cannot substitute for it.

Expected paths are hash-bound authority. They may identify planned new files; edit preflight records `existing` versus `planned_new` rather than making pre-existence a prerequisite for creating a file. Candidate admission still rejects every changed path outside the declared file or subtree.

The v1 schema uses a `repositories` array constrained to one `id: root` entry. Future root/child composition extends that cardinality and adds edges; it does not create another lifecycle.

## State flow

```text
PLANNED -> IMPLEMENT_READY -> IMPLEMENTING
 -> CANDIDATE_FROZEN -> CLOSURE_AUDITED -> CANDIDATE_VALIDATED
 -> Reviewer A -> Reviewer B when high -> REVIEWED_PASS
 -> expected-SHA CAS -> ACTUAL_TARGET_VERIFIED
 -> delivery-sensitive semantic review when required
 -> reachability-safe cleanup -> COMPLETE
```

Findings produce `REPAIR_REQUIRED`, one consolidated repair, one replacement validation, and one replacement review pair. Remaining findings produce `REVIEW_BUDGET_EXHAUSTED`; the lifecycle does not silently start a third pair.

Every update is atomic and records the previous phase, next phase, generation, timestamp, and receipt hash. The compact result keeps candidate, integrated, and release identities separate. Release fields remain null because release is project-specific.

## Risk and review truth

Deterministic risk is the minimum. Ambiguous/unclassified changes and Git/ref/CAS/cleanup, lifecycle/review authority, security, runtime/package delivery, release, deployment, or destructive surfaces are high. Other behavioral work is medium; documentation-only/non-behavioral test work may be low. Owners may escalate but never downgrade.

Low/medium requires one independent review. High requires Reviewer A then Reviewer B sequentially on exactly the same frozen base/tip. Both are fresh `yy pi` contexts, read-only, and inherit configured provider/model defaults. No repair or product commit may occur between them. Strict output is one or more `JUNO_REVIEW_FINDING` lines or exactly `JUNO_REVIEW_VERDICT: PASS`.

The orchestrator waits for every required reviewer before deduplicating findings by requirement/root cause. Implementation and repair workers never launch review subloops.

An owner waiver is read only from the canonical Kanban task field `fields.lifecycle_review` and must bind `status: waived_by_owner` to the exact candidate SHA. The lifecycle never authors or infers it. Objective/effective risk remains unchanged and `review_passed` remains false. This truth is independent from validation and integration status.

## Candidate boundary

Focused tests are the editing loop. Before semantic review, the lifecycle:

1. requires one committed clean candidate;
2. audits expected paths, authority/order claims, forbidden architecture, and declared parity pairs;
3. creates a detached exact-tip validation clone with independent Git configuration;
4. unsets controller routing variables;
5. runs the declared candidate-boundary suite once;
6. stores bounded stdout/stderr and exact command/tip receipts;
7. removes only the validation checkout through ordinary Git worktree removal.

Reviewers consume the compact receipt and run only diagnostic checks needed for findings. They do not rerun the full suite by default.

## Candidate, CAS, and target truth

After PASS, the lifecycle coordinates the existing candidate planner/builder/verifier. A direct unchanged candidate reuses exact-tip semantic truth. If target composition changes candidate meaning, fresh candidate review is required; the lifecycle refuses rather than pretending the old review covers new bytes.

Integration uses the expected target SHA and channel lock. A moved target fails closed; no ref is rewound. Deterministic actual-target readback and validation are unconditional. Post-CAS semantic review is required for high risk, delivery/runtime/package surfaces, composed bytes, or any actual-target identity differing from the reviewed candidate.

Partial target movement, validation failure, review failure, controller synchronization failure, checkpoint failure, and cleanup refusal remain separate terminal dimensions. Integration never implies cleanup or release.

## Cleanup

Cleanup uses the existing typed reachability-safe helper. It requires the exact task/candidate HEAD, clean inactive checkout, target reachability, nested-worktree safety, and exact-old-SHA branch deletion. Unknown activity, initialized nested worktrees, dirty state, wrong identity, or unreachable commits block cleanup without force. A refusal reports `CLEANUP_BLOCKED` and preserves evidence.

## Hard cut and history

`workflow_class: local_integration` is no longer executable. Workflow Runner rejects old lint, start, `--from-step` resume, recovery, and amendment with a pointer to `yy lifecycle`. Historical artifacts remain immutable and readable through `workflow_runner.sh doctor`; generic non-lifecycle workflows remain supported. There is no adapter, schema translation, or dual integration runtime.

## Canonical worker distribution

`src/templates/skills/canonical/ralph-loop/references/implement.md` is the sole implementation-worker contract. `npm run generate:implementation-contract` deterministically renders Claude, Codex, and Pi template/project copies. Build runs `--check`, and drift fails parity validation. Generated destinations identify their canonical source and must not be edited independently.

## Why implementation and tests both matter

Instructions explain roles and why review waits for a stable candidate. The backing state machine enforces phase order, review budget, exact SHA identities, bounded evidence, CAS coordination, target verification, and cleanup. Real Git/worktree tests matter because prose cannot prove ref CAS, detached validation, or reachability-safe removal. Package-install tests matter because source-only checks cannot prove users receive the command, scripts, prompts, and generated worker contract together. Unit tests protect schemas and verdict truth; medium/high canaries prove one-review and same-tip A/B user flows without helper syntax discovery.
