# Run task workflow

Own execution/review. If a creation phase already produced a handoff in this request, consume it without repeating creation. Otherwise require one exact existing workflow and task-set manifest; never invent or recreate them.

1. From the controller, resolve `.juno_task/scripts/controller_resolver.py --operation orchestration`; fail on path/ref/role mismatch. Preflight lint, selected/excluded IDs, dependencies, E2E isolation, authority, worktree, budget/timeout, and fail-on-step-error behavior. Verify controller, task, and integration-owner status independently; never clean or switch one to satisfy another.
2. Run the declared controller `workflow_runner.sh` command once and wait. Every product step must receive and verify explicit `TASK_ROOT`; Kanban and session writes remain routed to the canonical controller. Never deploy or run excluded E2E without explicit authorization.
3. Runner exit is not acceptance. Inspect terminal steps, then run the controller's `.juno_task/scripts/task_workflow_helper.py finalize-review <run_dir> --manifest <manifest>`.
4. Inspect its evidence, Kanban readbacks, validation claims, and git/submodule/worktree state; give a human MUST/MUST NOT verdict. Report runner and semantic outcomes separately. On failure, create/reopen the issue and resume only the smallest invalid stage.
