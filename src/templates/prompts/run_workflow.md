# Run a workflow or Bolt task

Choose one public interface by intent:

`TASK_ROOT` names the canonical controller. Control-plane routing never switches or cleans the checkout where the user invoked `yy`.

- Generic ordered reporting or agent work: `workflow_runner.sh --workflow PATH`.
- Feature implementation: `yy task start TASK_ID`, then `yy task finish TASK_ID`.
- Serialized delivery: `yy merge status|next|resolve`.

Generic Workflow Runner remains available, including read-only doctor support
for historical local-integration artifacts. It must not execute or adapt retired
feature-integration manifests.

Task state is durable in the metadata controller. Product workers receive only
their dedicated product worktree; controller data is not copied there. Multiple
features may be implemented concurrently, while one per-target merge queue owns
the short expected-SHA mutation window.

Risk decides semantic review: low zero, normal at most one, and high exactly two
sequential reviewers on one frozen candidate. Post-merge work is deterministic
identity/readback, not a second review. Release and external publication remain
separately authorized.
