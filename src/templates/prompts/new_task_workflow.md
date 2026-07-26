# Create task workflow

Own creation; execute only when the request also includes the workflow-execution phase or explicitly requests execution.

Read `.juno_task/wiki/parallel_runner_task_creation_best_practices.md` and choose the minimum lane: direct bounded task, guarded small fix, or isolated worktree/workflow. Do not force a workflow onto one clean owner. Resolve the canonical controller with `.juno_task/scripts/controller_resolver.py --operation diagnostic`; resolution is checkout-aware and branch-verified and never switches refs. Record controller, task, and integration-owner cleanliness separately, and give every product command an explicit `TASK_ROOT`.

For a workflow:

1. Write empty-context task bodies plus one symbolic manifest covering parent, implementation/reserved E2E tags, controller and product roots, roles/dependencies, workflow path, budget, expected states, and owned/baseline paths. Bodies need context, compact ASCII flow, MUST/MUST NOT, failure/runtime contracts, exact validation, and why tests matter.
2. Run the controller's `.juno_task/scripts/task_workflow_helper.py create-task-set <manifest> --output-dir <dir>` dry-run, then `--execute` to create/read back tasks. Treat its receipt/resolved manifest as structural truth and publish the generated YAML at the declared workflow path. Task checkouts must route Kanban/session writes back to the verified controller; integration owners remain clean and write-free.
3. Create E2E only when deployed verification is needed; exclude it from implementation. Update/read back the parent via response-file with IDs, exclusions, paths, and exact lint/run/finalize commands. Lint the workflow.

Handoff exact manifest/workflow paths, task IDs, timeout/run command, expected outcomes, and lint result. If no execution phase follows, stop. Otherwise continue into execution without recreating or revalidating creation artifacts.
