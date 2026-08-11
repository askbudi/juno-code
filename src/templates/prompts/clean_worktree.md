# Clean Bolt task workspaces

The metadata controller owns Kanban, task state, and compact artifacts. Product
code lives only in the target branch and dedicated feature worktrees.

`TASK_ROOT` names the canonical controller. Control-plane routing never switches or cleans the checkout where the user invoked `yy`.

Independent agents and reviewers use fresh `yy pi` contexts. Bare `pi` and indirect provider/model overrides are forbidden.

1. Start each selected feature with `yy task start TASK_ID`. The command records
   the exact target SHA and creates one task branch/worktree from it.
2. Enter the returned worktree and, before editing or testing, follow the
   exact-lock, validation-cwd-aware [task dependency hydration](../wiki/task_dependency_hydration.md)
   contract. Stop before implementation on provisioning or clean-tree failure.
3. Implement, run focused tests, and commit only inside the returned worktree.
   Starting feature Y never waits for feature X; each has its own worktree.
4. Run `yy task finish TASK_ID` after the worktree is clean and committed. This
   validates affected paths/tests and queues the immutable feature tip.
5. Use `yy merge status` and `yy merge next` to serialize only target mutation.
   A moved target is composed deterministically. A conflict is preserved and
   resumed with `yy merge resolve TASK_ID` after editing only reported paths.
6. Low risk needs no semantic review. Normal risk uses at most one independent
   review. High risk uses Reviewer A then Reviewer B on one frozen candidate.
7. After expected-SHA CAS, verify identity/readback only; do not redispatch a
   semantic reviewer for byte-identical delivery.
8. Cleanup is reachability-safe. Push, release, publish, deploy, production
   mutation, restart, and post-deploy E2E always require separate authority.

Do not copy controller ledgers/specs/artifacts into product worktrees, author
helper receipts, or synchronize controller and product histories.
