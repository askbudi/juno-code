# Clean task lifecycle

Use the single public task lifecycle instead of discovering or sequencing Git/review helpers. The controller owns orchestration state, workers receive the admitted product `TASK_ROOT`, and the lifecycle never silently switches controller or target branches.

1. Resolve the canonical controller and the owner-approved full target ref. Never use controller `HEAD` as the product base.
2. Author one `juno_task_lifecycle.v1` manifest with one `repositories` entry, exact target/base, task worktree/branch, complete expected paths (including planned new paths), validation commands, checklist, artifact root, and cleanup owner.
3. Run `yy lifecycle run --manifest PATH`. Use `yy lifecycle status --state PATH` for bounded observation and `yy lifecycle resume --state PATH` only after inspecting the recorded blocker.
4. Implementation and repair workers edit only the admitted task worktree and stop at `REVIEW_READY`. They never launch reviewers, integrate, release, or clean.
5. Low/medium risk receives one independent review. High or ambiguous risk receives Reviewer A followed by Reviewer B on the same frozen tip, with no repair between them. One consolidated repair and one replacement pair are the autonomous maximum. Review launches use fresh `yy pi`, never bare `pi` or a direct provider CLI, and inherit configured provider/model defaults.
6. Deterministic actual-target verification is unconditional. Delivery-sensitive post-CAS review follows the lifecycle policy. Cleanup is reachability-safe and a refusal remains truthful partial state.
7. Release, push, publication, deployment, production mutation, restart, and post-deploy E2E remain separate project-specific authorities.

Historical `workflow_class: local_integration` artifacts remain readable with `workflow_runner.sh doctor`, but old lint/start/resume/recovery/amendment is hard-rejected. Do not translate or adapt an old workflow; create a lifecycle manifest.

Why tests and backing implementation both matter: the state machine enforces exact-base admission, review timing, expected-SHA CAS coordination, target readback, and cleanup. Real-Git, installed-package, parity, and canary tests prove those gates operate on delivered bytes rather than existing only as prose.
