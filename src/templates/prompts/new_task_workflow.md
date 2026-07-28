# Create task workflow

Own task/PDR creation. Execute only when the request also authorizes implementation or explicitly requests workflow execution. Task creation alone never authorizes product edits, local integration, push, release, deployment, or E2E.

1. Resolve the canonical controller with `.juno_task/scripts/controller_resolver.py --operation diagnostic`; never switch refs to manufacture a controller. Read the task-creation, review, and lifecycle wikis.
2. Write empty-context task bodies and one symbolic manifest covering the parent, implementation/review tasks, separately reserved E2E, controller root, exact product target refs, expected paths, validation, dependencies, budgets/timeouts, artifact root, and cleanup owner. Every product mutation—including a small fix—must use a named exact-base worktree.
3. For local integration, declare `schema_version: 2`, `workflow_class: local_integration`, `integration_step`, `terminal_gate`, and exactly this policy:

   ```yaml
   integration_policy:
     queue: automatic_after_review_pass
     channel_scope: git_common_dir_and_target_ref
     target_movement: rebuild_and_rereview
   ```

4. Assign `validation_ownership.pre_merge_review`, `candidate_review`, and `actual_target_review`. Define typed receipts for the first two independent PASS gates and an integration receipt produced by the integration step with `outcome=integrated` and required `feature_tag`. Every receipt `required_fields` list includes `producer_step_digest`, bound to `JUNO_WORKFLOW_STEP_DIGEST`. The integration command must use `integration_owner_preflight.py integrate` with candidate and actual-review receipts.
5. Declare `task_body_validators` for every project canonical body contract, with argv as a string list (never a shell string), optional role filters, and `{{body_file}}` where the fully substituted preview body belongs. A `post_deploy_e2e` task requires a matching validator. The helper also supplies `{{task_key}}`, `{{role}}`, `{{status}}`, `{{tags_json}}`, and `{{dependencies_json}}` plus matching `JUNO_TASK_*` environment values. The configured command must be the same non-mutating validation entry point used by Kanban writes, not a private duplicate.
6. Run the controller's `task_workflow_helper.py create-task-set` as a dry run, then `--execute`; both modes render the whole symbolic task set and run all canonical validators before the first Kanban command. Read back tasks and publish/lint the generated workflow. Task checkouts route Kanban/session writes to the controller and receive explicit product roots.
7. Create post-deploy E2E only when deployed verification is needed and always exclude it from local implementation. Record task IDs, exact paths, lint/run/finalize commands, expected outcomes, and authority exclusions in the parent response.

If execution is not authorized, stop after the handoff. Otherwise consume the exact generated artifacts and proceed without recreating them.
