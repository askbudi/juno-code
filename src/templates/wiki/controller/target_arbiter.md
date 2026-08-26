---
wiki_contract:
  line_limit: 100
  purpose: "Run one deterministic on-demand mutation owner per protected target without session polling."
  failure_mode_prevented: "Competing sessions drive the same queue, duplicate lifecycle work, or treat lease expiry as takeover authority."
  runtime_contract_enforced: "The kernel-owned target claim and receipt-bound fencing attempt serialize merge transitions; idle queues start no worker."
  validation_gate: "python3 .juno_task/scripts/tests/test_merge_queue.py && npm test -- src/cli/__tests__/merge-command.test.ts"
  related_sots:
    - "watching_progress.md"
    - "controller/fenced_task_leases.md"
---

# On-demand target arbiter

`yy merge arbiter status` is the read-only observer surface. It reports the
protected target, current attempt and producer observation, FIFO-eligible task
IDs, a stable reason code, and the next action. Status never acquires mutation
authority or starts a worker.

`yy merge arbiter run [--through TASK_ID]` starts only when actionable queued
work exists. `yy merge drive` is the compatibility alias for the same arbiter.
The worker acquires one kernel-released claim scoped to repository identity and
full target ref, then freezes and advances the canonical FIFO merge-drive scope.
It exits after integration drains that scope or after one typed blocker. There
is no always-running daemon and no model-authored polling loop.

Each worker receives a random fencing token represented durably only by its
SHA-256. Every terminal state write must match the current attempt and token.
A delayed predecessor therefore fails `arbiter_fence_stale`. If a worker dies,
the kernel releases its claim; a successor is issued only after controller-owned
PID/start-time readback proves the recorded producer ended. Time or heartbeat
expiry alone never grants takeover.

The existing merge queue remains lifecycle truth. The arbiter adds no second
queue state machine: its compact state records ownership, successor lineage,
and terminal receipt while merge-drive journals remain transition/evidence
truth. FIFO/dependency selection, review ordering, conflict authority, expected-
old-SHA target mutation, release authority, and release barriers are unchanged.
