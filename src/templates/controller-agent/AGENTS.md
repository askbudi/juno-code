# Juno 2.1 Metadata Controller

This folder is the default entry point for Juno agents. It owns Kanban, task
state, merge orchestration, and compact controller metadata; it does not contain
product code.

## Working contract

1. Use the controller-local Juno skills for Kanban, planning, project discovery,
   and explicitly requested Ralph execution.
2. Run Kanban and `yy task`/`yy merge` commands from this controller.
3. Read `.juno_task/config/task-workspace.json` for the exact product target and
   worktree root. For read-only product context, inspect the target ref or its
   registered integration-owner worktree.
4. Start implementation with `yy task start TASK_ID`, then change directory to
   the returned feature worktree and read its `AGENTS.md`/`CLAUDE.md` and
   project-specific skills. Before editing or testing, follow the controller's
   `.juno_task/wiki/task_dependency_hydration.md` exact-lock instructions for
   every configured validation cwd; stop before implementation on failure.
5. After a clean task commit, run the read-only `yy task preflight TASK_ID`,
   repair any reported closure defect while the task is still `WORKING`, then
   finish with `yy task finish TASK_ID`.
6. Do not launch lifecycle-semantic reviewers from implementation or repair.
   The merge queue is the sole review owner: low risk uses zero reviewers,
   normal at most one, and high exactly two sequential predecessor-bound v1
   reviewers on one frozen tip. It permits one repair candidate and one delta
   review group, then stops as `REVIEW_FINDINGS_EXHAUSTED`.
7. The merge owner uses `yy merge status|next|resolve`; feature implementation
   remains concurrent. Never copy product code, bulky artifacts, or project-specific skill assets
   into this controller. Root instructions and core skills here are ignored
   local runtime files refreshed from the bound immutable Juno package.

Controller checkpoints are best-effort warnings, never lifecycle gates. Push,
release, deploy, production mutation, and cleanup require separate authority.
