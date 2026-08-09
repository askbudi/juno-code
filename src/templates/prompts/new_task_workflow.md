# New task lifecycle

Create one task-level lifecycle policy and Kanban selection, not a user-authored manifest or low-level integration workflow. The controller owns orchestration, workers receive only the admitted product `TASK_ROOT`, and the lifecycle never silently switches controller or target branches.

1. Confirm the task, canonical sparse-controller registration/policy/generation, exact product target ref/SHA, explicit admitted `TASK_ROOT`, objective risk, owner escalation (if any), changed-surface matrix, expected paths, validation profile, requirement checklist, artifact root, and cleanup owner. Product paths must be absent from the controller.
2. The project policy has `schema_version: juno_task_lifecycle_config.v2`, one named root, and zero or more configured direct children. Task fields select entries; deeper nesting and identity/ref overrides fail before mutation.
3. Deterministic risk is a minimum: ambiguous/unclassified, Git/CAS/cleanup, lifecycle/review authority, security, runtime/package delivery, and destructive work are high. An owner may escalate but never downgrade.
4. Configure exactly one initial review pair budget and one replacement pair budget. Low/medium uses Reviewer A; high uses Reviewer A then Reviewer B sequentially on one frozen tip. Repair waits for all required results.
5. Use the canonical managed review template and fresh `yy pi` contexts inheriting project provider/model defaults. Reviewers are read-only.
6. Run only `yy lifecycle run --task TASK_ID` from the canonical controller; observe or resume with the same task ID. Every managed product operation is dispatched to an exact verified task/candidate/integration-owner root, never controller CWD.

Old `workflow_class: local_integration` execution is retired. Historical doctor/readback remains available, but lint/start/resume/recover/amend cannot be used as a migration path.

Why tests and implementation both matter: the project-owned policy and immutable derived plan make authority reviewable, while schema, real-Git, exact-tip validation, review-budget, CAS, target-verification, and cleanup tests prove the declared lifecycle is mechanically enforced.
