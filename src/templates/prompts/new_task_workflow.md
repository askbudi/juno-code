# Start a feature task

Use the canonical controller to select one Kanban task, then run:

`TASK_ROOT` names that canonical controller. Control-plane routing never switches or cleans the checkout where the user invoked `yy`.

```text
yy task start TASK_ID
```

The project-owned task-workspace policy supplies the full product target ref, allowed product paths, focused validation, branch prefix, and worktree root. Start freezes the exact current target SHA, creates one task branch and one product worktree, and writes a compact controller record. It is idempotent only while that worktree is still clean at the exact frozen base; any branch, path, target, or record drift refuses.

Implement and commit only inside the returned product worktree. Immediately after start and before editing or testing, follow the exact-lock, validation-cwd-aware hydration contract in [task dependency hydration](../wiki/task_dependency_hydration.md). Stop before implementation if provisioning or its clean-tree check fails. The controller keeps Kanban and task artifacts; those files are never copied into product worktrees. Other tasks may start from the same target in their own worktrees while this task is active.

When implementation is committed, run:

```text
yy task finish TASK_ID
```

Finish checks the exact task identity, clean committed tip, allowed paths, and configured focused validation, then records the task as `QUEUED`. It does not review, merge, release, push, deploy, clean up, or synchronize controller and product branches. Use `yy task status TASK_ID` for bounded read-only observation.

The target owner first stops shared integration servers, verifies the integration checkout is clean, and detaches it so the full target ref is unowned. Advance queued work with `yy merge next`. If it reports `CONFLICT`, edit and stage only the listed paths in the preserved candidate checkout, then run `yy merge resolve TASK_ID`. A failed resolved-candidate test is retried with the same command and same preserved commit. Use `yy merge status` to observe queued, conflicted, and merged tasks. After the queue is drained or paused, attach the integration owner to the exact target for shared tests, servers, release, or deploy; detach it again before the next queue mutation. The merge queue serializes only the short target mutation window; feature implementation remains concurrent.
