# Create task workflow

Own task/PDR creation. Execute only when the request also authorizes implementation or explicitly requests workflow execution. Task creation alone never authorizes product edits, local integration, push, release, deployment, or E2E.

1. Resolve the canonical controller with `.juno_task/scripts/controller_resolver.py --operation diagnostic`; Juno never silently switches refs to manufacture a controller. Read the task-creation, review, and lifecycle wikis.
2. Write empty-context task bodies and one symbolic manifest covering the parent, implementation/review tasks, separately reserved E2E, controller root, exact product target refs, expected paths, validation, dependencies, budgets/timeouts, artifact root, and cleanup owner. Every product mutation—including a small fix—must use a named exact-base worktree.
3. For local integration, declare `schema_version: 2`, `workflow_class: local_integration`, exactly one `risk_tier: low|medium|high|release`, `integration_step`, `terminal_gate`, and exactly this policy:

   ```yaml
   integration_policy:
     queue: automatic_after_review_pass
     channel_scope: git_common_dir_and_target_ref
     target_movement: rebuild_and_rereview
     checked_out_target: detach_same_sha
   ```

4. Assign `validation_ownership.pre_merge_review`, `candidate_review`, and `actual_target_review`. Use a lean phase graph: deterministic preflight, implementation agent, independent pre-merge review, deterministic candidate preparation/verification, a candidate semantic reviewer only when composition creates different bytes, and integration with actual-target review. Do not add standalone `implementation_guard`, `pre_merge_guard`, or `candidate_guard` steps; encode those checks as typed receipt requirements and helper postconditions. Define typed receipts for required PASS gates and an integration receipt produced by the integration step with `outcome=integrated` and required `feature_tag_policy`. Every receipt `required_fields` list includes `producer_step_digest`, bound to `JUNO_WORKFLOW_STEP_DIGEST`. Reference receipt locations through `{{ receipts.<id>.path }}` or `JUNO_WORKFLOW_RECEIPT_<ID>`, never a duplicate hardcoded path. The integration command must use `integration_owner_preflight.py integrate`, `--risk-tier`, and `--checked-out-target detach_same_sha`; actual-review arguments are required for effective high/release risk.
5. Declare `task_body_validators` for every project canonical body contract, with argv as a string list (never a shell string), optional role filters, and `{{body_file}}` where the fully substituted preview body belongs. A `post_deploy_e2e` task requires a matching validator. The helper also supplies `{{task_key}}`, `{{role}}`, `{{status}}`, `{{tags_json}}`, and `{{dependencies_json}}` plus matching `JUNO_TASK_*` environment values. The configured command must be the same non-mutating validation entry point used by Kanban writes, not a private duplicate.
6. Run the controller's `task_workflow_helper.py create-task-set` as a dry run, then `--execute`; both modes render the whole symbolic task set and run all canonical validators before the first Kanban command. Read back tasks and publish/lint the generated workflow. Task checkouts route Kanban/session writes to the controller and receive the explicit product root as `TASK_ROOT`.
7. Create post-deploy E2E only when deployed verification is needed and always exclude it from local implementation. Record task IDs, exact paths, lint/run/finalize commands, expected outcomes, and authority exclusions in the parent response.

If execution is not authorized, stop after the handoff. Otherwise consume the exact generated artifacts and proceed without recreating them.
