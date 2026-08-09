# Run a workflow or task lifecycle

Choose the public owner by intent:

- Generic ordered reporting/agent workflow: `workflow_runner.sh --workflow PATH`.
- Product task implementation, review, integration, verification, and cleanup: `yy lifecycle run --task TASK_ID`.

For task lifecycle work, never expose or ask the operator to discover helper choreography. The controller retains orchestration state, product workers receive the admitted `TASK_ROOT`, and the lifecycle never silently switches controller or target branches. Observe with `yy lifecycle status --task TASK_ID`; resume only the recorded first pending phase with `yy lifecycle resume --task TASK_ID`. Worker and reviewer roles remain bounded by the managed contracts.

`workflow_class: local_integration` is historical. Its artifacts remain readable with `workflow_runner.sh doctor`, but lint, start, `--from-step`, recovery, and amendment are hard-rejected. Do not create an adapter or mechanically translate historical execution evidence.

A lifecycle terminal result reports candidate validation, review PASS or truthful owner waiver, expected-SHA integration, deterministic actual-target verification, delivery-sensitive review, controller synchronization/checkpoint, and cleanup independently. `waived_by_owner` never means PASS and never lowers risk.

Release, push, publication, deployment, production mutation, restart, and post-deploy E2E are outside the reusable task lifecycle and require project-specific authorization.

Why tests and backing implementation matter: prompts establish role behavior, but only the state machine and real process/Git tests can enforce same-tip review timing, bounded repair, CAS, target truth, and safe cleanup.
