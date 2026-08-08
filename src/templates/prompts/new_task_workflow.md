# New task lifecycle

Create one task-level lifecycle manifest, not a low-level integration workflow. The controller owns orchestration, workers receive only the admitted product `TASK_ROOT`, and the lifecycle never silently switches controller or target branches.

1. Confirm the task, controller, exact product target ref/SHA, objective risk, owner escalation (if any), changed-surface matrix, expected paths, validation profile, requirement checklist, artifact root, and cleanup owner.
2. The v1 manifest has `schema_version: juno_task_lifecycle.v1` and exactly one `repositories` entry with `id: root`. This durable array shape is the extension point for future root/child composition; do not invent a second public lifecycle.
3. Deterministic risk is a minimum: ambiguous/unclassified, Git/CAS/cleanup, lifecycle/review authority, security, runtime/package delivery, and destructive work are high. An owner may escalate but never downgrade.
4. Configure exactly one initial review pair budget and one replacement pair budget. Low/medium uses Reviewer A; high uses Reviewer A then Reviewer B sequentially on one frozen tip. Repair waits for all required results.
5. Use the canonical managed review template and fresh `yy pi` contexts inheriting project provider/model defaults. Reviewers are read-only.
6. Run only `yy lifecycle run --manifest PATH`; observe/resume through the same public lifecycle.

Old `workflow_class: local_integration` execution is retired. Historical doctor/readback remains available, but lint/start/resume/recover/amend cannot be used as a migration path.

Why tests and implementation both matter: the manifest makes policy reviewable, while schema, real-Git, exact-tip validation, review-budget, CAS, target-verification, and cleanup tests prove the declared lifecycle is mechanically enforced.
