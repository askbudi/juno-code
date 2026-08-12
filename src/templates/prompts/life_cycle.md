---
juno_prompt_schema: juno.life_cycle.v1
public_macro: "@@life_cycle"
revision: 1
---

# Observable Juno task lifecycle

Treat all caller text after this prompt as the requested ordered task set, goal,
or release boundary. Preserve that payload literally and exactly once. In
particular, do not reinterpret or remove multiline task IDs, `##TASK_ID`,
`@@no_code`, quotes, backticks, `$ARGUMENTS`, `$1`, `$2`, `$@`, or shell syntax.

Use the installed Juno control plane; do not create another workflow engine.

1. **Discover before mutation.** Run `yy info --json`, `yy doctor workspace`, and
   the canonical Kanban reads. Record controller, target ref/SHA, registered
   integration owner, installed/controller/runtime versions, Node version, task
   ownership, blockers, and safe parallel opportunities. Bind the project-
   supported Node runtime before `yy` or managed Pi execution. Never assume the
   invocation directory is the product checkout.
2. **Keep Kanban and receipts authoritative.** Deduplicate every newly proven
   Juno defect before filing it with evidence. Do not absorb unrelated work.
   Start implementation only with `yy task start TASK_ID`; use the exact returned
   worktree and immutable receipt/path scope. Do not impersonate lifecycle state
   or edit receipts.
3. **Hydrate locally.** In each admitted task worktree use exact-lock dependency
   installation (`npm ci` where applicable). Never symlink dependencies. Keep
   controller metadata and product bytes on their declared surfaces.
4. **Make execution observable.** For each actual `yy pi`, task finish, merge, or
   separately authorized release command, use a bounded timeout and capture
   combined stdout/stderr in a task-ID `/tmp` log. Keep separate PID and terminal
   footer files. Poll with bounded `kill -0`/`ps` and `tail`; quiet real-Git or
   test work remains active until process/footer evidence says otherwise. Record
   exact exit, completion time, duration, session, and log path. Follow the
   detailed nonblocking pattern in `.juno_task/wiki/git_worktree_lifecycle.md`.
5. **Implement narrowly.** Give the agent bounded task requirements, exclusions,
   exact paths, and proportional focused tests. Commit one logical task at a
   time. Before shared heavy real-Git suites, inspect active workloads and avoid
   intentional resource-lock contention.
6. **Review once, independently.** After focused validation and a clean committed
   tip, launch a fresh read-only independent `yy pi` review over the frozen diff.
   Deduplicate/file proven defects, repair material findings, and rerun focused
   checks. Do not start an unbounded review loop.
7. **Use managed lifecycle boundaries.** Only after implementation/review gates,
   run separately authorized `yy task finish TASK_ID`. Observe the queue with
   `yy merge status`; integration uses `yy merge next|resolve` and expected-SHA
   CAS. For integration-owner drift use `yy integration status`, then receipt-
   bound `repair --dry-run/--apply`; publication planning remains child-first via
   `push --dry-run`, and apply needs separate authority.
8. **Keep release authority explicit.** A release dry-run/build/version/tag/global
   link verification may run only under its exact release authority and
   workspace contract. Push, npm/PyPI publish, deployment, production mutation,
   cleanup, and post-deploy E2E are independent authorities and are never implied.
9. **Hand off truth.** Report ordered task outcomes, exact commits and SHAs,
   sessions, costs where available, durations, tests, PID/log/footer paths,
   Kanban updates/new bugs, blockers, contention waits, canary limitations, and
   remaining safe parallel opportunities. Leave every unauthorized action undone.

## Evolution

This is schema `juno.life_cycle.v1`, revision 1. Change the canonical source in
`juno-code/src/templates/prompts/life_cycle.md`, update this revision and release
notes when behavior changes, and validate source/dist/tarball plus managed-install
parity. Project customizations are user-owned: managed update must preserve or
surface conflicts rather than silently replacing customized bytes.
