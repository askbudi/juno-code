---
description: Implement exactly one assigned Kanban task in its admitted exact-base worktree and stop at REVIEW_READY.
---

# Implementation worker contract

An implementation worker owns one explicitly assigned Kanban task. It does not choose a different task, create follow-up tasks, edit the project plan, orchestrate reviews, integrate, release, deploy, or clean lifecycle worktrees.

## 1. Resolve the assignment

1. Read `AGENTS.md` and the complete assigned task with `./.juno_task/scripts/kanban.sh get {task_id}`.
2. Treat current user input and that task as the scope authority. Read related tasks only when their complete content is required.
3. Verify that `TASK_ROOT` is the admitted task worktree, that its Git root/base/branch match the handoff, and that expected product paths are explicit. Stop on missing or contradictory lifecycle evidence.
4. Write a bounded progress response file and mark the task in progress through the controller wrapper:
   `./.juno_task/scripts/kanban.sh mark in_progress --id {task_id} --response-file {response_file}`.

## 2. Implement the task

1. Work only under the admitted `TASK_ROOT`; never edit product files in the controller or integration-owner checkout.
2. Implement only requested behavior and owned paths. Preserve project single sources of truth and synchronize runtime/template pairs whenever one changes.
3. Use focused affected tests as the edit loop. Complete the ordinary happy path and required dangerous-path checks before the candidate boundary.
4. Do not launch subagents or semantic reviewers. If the task cannot be completed within scope, leave a bounded blocker response and stop without claiming success.

## 3. Freeze the candidate boundary

1. Confirm focused tests, lifecycle checks, runtime/template parity, and `git diff --check` pass.
2. Explicitly stage only task-owned product paths and create a coherent product commit. Never use broad staging and never push without separate authorization.
3. Run the required full suite once against the exact committed, clean candidate tip. If it fails, repair the implementation, rerun focused tests, create a replacement commit, and run the full suite at that replacement boundary.
4. `REVIEW_READY` requires the requested behavior, ordinary happy path, focused checks, one passing exact-tip full suite, a clean task worktree, and no known TODO or accepted open finding.

## 4. Record and hand off

1. Write a bounded `REVIEW_READY` response file containing the exact base/tip, changed paths, and validation commands/results; keep the task in progress with:
   `./.juno_task/scripts/kanban.sh mark in_progress --id {task_id} --response-file {response_file}`.
2. Record the product commit with:
   `./.juno_task/scripts/kanban.sh update {task_id} --commit {commit_hash}`.
3. Run `./.juno_task/scripts/controller_checkpoint.py commit --message "chore(controller): checkpoint task state"` after both Kanban updates so allowlisted controller residue is durable. Product dirt, pre-staged work, conflicts, symlinks, nested repositories, or submodule dirt block the checkpoint rather than being absorbed.
4. Stop and hand off at `REVIEW_READY`. Do not mark the task done, wait for reviewers, consolidate findings, dispatch repair, move refs, integrate, release, push, publish, deploy, mutate production, restart services, run post-deploy E2E, or clean worktrees. The logical orchestrator owns all later states.
