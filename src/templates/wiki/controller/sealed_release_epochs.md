---
wiki_contract:
  line_limit: 140
  purpose: "Seal, compose, validate, and deliver one history-preserving release epoch with one protected-target CAS."
  failure_mode_prevented: "Per-candidate target churn, omitted finished work, duplicate evidence/review, and release cuts while eligible candidates wait."
  runtime_contract_enforced: "Explicit immutable seal closes admission; one fenced drive drains the snapshot and emits read-only release readiness."
  validation_gate: "python3 .juno_task/scripts/tests/test_release_train.py && npm test -- src/cli/__tests__/release-command.test.ts"
  related_sots:
    - "watching_progress.md"
    - "controller/target_arbiter.md"
    - "controller/fenced_task_leases.md"
---

# Sealed release epochs

## Release barrier

```text
explicit seal (close admission)
  -> drain every eligible pre-cutoff candidate
  -> compose private history-preserving train
  -> reuse exact task evidence and run one aggregate suite
  -> one expected-old-SHA target CAS + owner readback
  -> read-only release readiness
  -> reopen admission on the new base
```

`plan`, `status`, `inspect`, `epoch-status`, and `shadow` are observations. They
never seal, compose, mutate a target, release, push, publish, deploy, or clean.
`seal` is the sole v1 admission-closing authority and returns a one-time fencing
token. Every later mutation requires that exact token.

## Operator flow

```bash
yy release train inspect /absolute/train.json --json
yy release train seal /absolute/train.json --json
# retain lease_token from the seal result
yy release train drive EPOCH_ID --epoch-token TOKEN --json
yy release train epoch-status EPOCH_ID --json
```

The seal snapshots target/base, queue cutoff and FIFO order, dependency order,
required/optional/ambient-barrier disposition, task revision/tip/tree, queue
record, attempt, complete-input evidence, review, runtime, and policy identities.
All eligible pre-cutoff candidates are members, including unrelated finished
candidates. New candidates enter the next epoch. Retrying an identical seal is
idempotent; changing an existing epoch ID is refused.

Required failure transitions to `PAUSED_REQUIRED`. An optional ejection carries
its dependent subtree and leaves independent members admitted:

```bash
yy release train eject EPOCH TASK --reason REASON --epoch-token TOKEN
```

## Composition and conflict recovery

Composition uses an isolated controller-managed worktree/ref rooted at the
sealed base. Dependency topology wins, then frozen FIFO order. Every admitted
task gets a both-parent merge commit; task commits are never squashed, rebased,
or rewritten. Ejected tips must be absent.

A conflict preserves the dirty checkout and writes one bounded repair packet
with base/ours/theirs, conflict paths, task contract identity, dependencies, and
admitted paths. Run exactly one canonical managed worker against that packet.
After it creates a clean both-parent repair commit, consume its immutable receipt:

```bash
yy release train repair EPOCH --receipt RECEIPT --epoch-token TOKEN
yy release train drive EPOCH --epoch-token TOKEN --json
```

Out-of-scope edits, unresolved conflicts, a second repair, sensitive/destructive
choices, new dependencies, or ambiguous requirements stop as `NEEDS_OPERATOR`.
Material repair remains subject to scoped delta review.

## Evidence, CAS, and recovery

Candidate evidence is reusable only with its complete-input identity. The train
runs one aggregate suite per exact train tip. Retries reuse its exact receipt.
Before CAS, drive rechecks queue records, ancestry/dispositions, runtime/policy,
aggregate evidence, and the target base. Target movement preserves the epoch as
`STALE`; create a successor seal on the new base and reuse only exact closures.

A successful CAS advances the protected ref once, advances/readbacks the
registered integration owner through the canonical merge owner, and emits
`juno_release_epoch_readiness.v1`. That receipt grants no tag, package release,
push, publication, deployment, production mutation, or cleanup authority.

## Shadow canary and rollback

```bash
yy release train shadow /absolute/train.json --baseline /absolute/baseline.json \
  --output /absolute/decision.json --json
```

Shadow is read-only and reports seeded scenario coverage, target-move count,
duplicate unchanged-closure execution, model lifecycle calls, and cache-read
token deltas. Missing thresholds return reason codes and `BLOCK`. The rollback
switch is to disable epoch drive and retain the existing per-candidate arbiter;
immutable epoch receipts remain audit evidence.
