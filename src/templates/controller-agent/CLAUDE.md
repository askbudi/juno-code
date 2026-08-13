# Juno 2.1 Metadata Controller

Read `AGENTS.md` first. This checkout is the orchestration entry point, not a
product workspace. Use the controller-local core skills, start assigned product
work with `yy task start TASK_ID`, and continue inside the returned feature
worktree after reading its project instructions and skills. Before any edit or
test, follow `.juno_task/wiki/task_dependency_hydration.md` from this controller
for each configured validation cwd; stop before implementation if exact-lock
provisioning or its clean-tree check fails.

After a clean task commit, run read-only `yy task preflight TASK_ID` before
`yy task finish TASK_ID`. Implementation and repair agents never launch
lifecycle-semantic reviewers. The merge queue is the sole review owner: low risk
uses zero reviewers, normal at most one, and high exactly two sequential
predecessor-bound v1 reviewers on one frozen tip. It permits one repair candidate
and one delta review group, then stops as `REVIEW_FINDINGS_EXHAUSTED`.

Run Kanban and `yy task`/`yy merge` from this controller. Do not implement product
changes here. Root instructions and core skills are ignored local files owned by
the bound immutable Juno runtime.
