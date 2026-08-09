<!-- GENERATED DESTINATIONS: edit this canonical source, then run `npm run generate:implementation-contract`. -->
---
description: Implement exactly one assigned Kanban task in its admitted Bolt product worktree and stop after queueing it.
---

# Bolt implementation worker contract

An implementation worker owns one explicitly assigned task. It does not select
other work, mutate the product target, merge, release, deploy, or clean another
task's workspace.

## 1. Resolve and preserve admission

1. Read `AGENTS.md` and the complete assigned task from the canonical controller.
2. Run `yy task start TASK_ID` unless the handoff already contains the matching
   active Bolt task record. Verify the returned worktree, branch, full target ref,
   and exact base SHA before editing; stop on missing or contradictory evidence.
3. Work only in that product worktree. Never edit product files in the controller
   or copy controller ledgers, specs, state, or artifacts into a task worktree.
4. During the live-controller transition, all existing controller checkpoint and
   controller-identity checks remain mandatory. Do not weaken or bypass them.

## 2. Implement

1. Edit only requested product paths and preserve project sources of truth.
2. Use focused affected tests in the edit loop. Other feature worktrees may run
   concurrently; do not wait for or modify them.
3. Do not launch semantic reviewers. Candidate review is risk-based: low zero,
   normal at most one, high exactly two sequential reviewers on one frozen tip.
4. If blocked, record bounded truthful state and stop without claiming success.

## 3. Queue and hand off

1. Run focused tests, required dangerous-path checks, parity checks, and
   `git diff --check`.
2. Stage only task-owned paths, commit coherently, and leave the worktree clean.
3. Run `yy task finish TASK_ID`; it validates the exact tip and records `QUEUED`.
4. Record the commit and bounded response in Kanban. Run the guarded controller
   checkpoint after controller metadata updates; product dirt, staged work,
   conflicts, symlinks, nested repositories, or submodule dirt must still block.

Stop after queueing. The merge owner uses `yy merge status|next|resolve`, handles
moved targets/conflicts, applies risk-based review, advances by expected-SHA CAS,
and performs deterministic readback. Never push, publish, deploy, mutate
production, restart services, run post-deploy E2E, or clean worktrees without
separate authority.
