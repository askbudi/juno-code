# Clean task lifecycle

Use the single public task lifecycle instead of discovering or sequencing Git/review helpers. The controller owns orchestration state, workers receive the admitted product `TASK_ROOT`, and the lifecycle never silently switches controller or target branches.

1. Resolve and verify the canonical sparse controller and the owner-approved full target ref. Never use controller `HEAD` or absent controller product bytes as the product base. Sparse policy drift, unexpected expansion, stale generation, or missing required controller paths stops orchestration.
2. Configure the repository-owned `.juno_task/config/lifecycle.json` registry and task lifecycle fields. The runtime derives exact targets, worktrees, existing/future paths, risk, validation rows, and cleanup authority into one immutable internal plan.
3. Run `yy lifecycle run --task TASK_ID`. Use `yy lifecycle status --task TASK_ID` for bounded observation and `yy lifecycle resume --task TASK_ID` only after inspecting the recorded blocker.
4. Implementation and repair workers edit only an explicit receipt-verified `TASK_ROOT` and stop at `REVIEW_READY`. Controller and integration-owner roots refuse product-edit dispatch; never materialize product paths in the controller as a workaround. Candidate/review/integration and release checks use explicit full product checkouts.
5. Low/medium risk receives one independent review. High or ambiguous risk receives Reviewer A followed by Reviewer B on the same frozen tip, with no repair between them. One consolidated repair and one replacement pair are the autonomous maximum. Review launches use fresh `yy pi`, never bare `pi` or a direct provider CLI, and inherit configured provider/model defaults.
6. Deterministic actual-target verification is unconditional. Delivery-sensitive post-CAS review follows the lifecycle policy. Cleanup is reachability-safe and a refusal remains truthful partial state.
7. Release, push, publication, deployment, production mutation, restart, and post-deploy E2E remain separate project-specific authorities.

Historical `workflow_class: local_integration` artifacts remain readable with `workflow_runner.sh doctor`, but old lint/start/resume/recovery/amendment is hard-rejected. Do not translate or adapt an old workflow; select the project-owned lifecycle through the Kanban task.

Why tests and backing implementation both matter: the state machine enforces exact-base admission, review timing, expected-SHA CAS coordination, target readback, and cleanup. Real-Git, installed-package, parity, and canary tests prove those gates operate on delivered bytes rather than existing only as prose.
