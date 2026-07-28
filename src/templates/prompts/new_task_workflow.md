# Create task workflow

Own task/PDR creation. Execute only when the request also authorizes implementation or explicitly requests workflow execution. Task creation alone never authorizes product edits, local integration, push, release, deployment, or E2E.

1. Resolve the canonical controller with `.juno_task/scripts/controller_resolver.py --operation diagnostic`; never switch refs to manufacture a controller. Read the task-creation, review, and lifecycle wikis.
2. Write empty-context task bodies and one symbolic manifest covering the parent, implementation/review tasks, separately reserved E2E, controller root, exact product target refs, expected paths, validation, dependencies, budgets/timeouts, artifact root, and cleanup owner. Every product mutation—including a small fix—must use a named exact-base worktree.
3. For local integration, declare `workflow_class: local_integration`, `integration_step`, `terminal_gate`, and exactly this policy:

   ```yaml
   integration_policy:
     queue: automatic_after_review_pass
     channel_scope: git_common_dir_and_target_ref
     target_movement: rebuild_and_rereview
   ```

4. Assign `validation_ownership.pre_merge_review`, `candidate_review`, and `actual_target_review`. Define typed receipts for the first two independent PASS gates and an integration receipt produced by the integration step with `outcome=integrated` and required `feature_tag`. The integration command must use `integration_owner_preflight.py integrate` with candidate and actual-review receipts.
5. Run the controller's `task_workflow_helper.py create-task-set` as a dry run, then `--execute`; read back tasks and publish/lint the generated workflow. Task checkouts route Kanban/session writes to the controller and receive explicit product roots.
6. Create post-deploy E2E only when deployed verification is needed and always exclude it from local implementation. Record task IDs, exact paths, lint/run/finalize commands, expected outcomes, and authority exclusions in the parent response.

If execution is not authorized, stop after the handoff. Otherwise consume the exact generated artifacts and proceed without recreating them.
