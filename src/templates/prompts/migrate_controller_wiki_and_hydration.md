# Migrate controller wiki and worktree hydration

Prepare a reviewable migration for the current registered Juno 2.1 controller
and product. This prompt authorizes inventory, candidate generation, Workflow
Runner lint/dry-run, and reports only. Do not apply tracked changes, start tasks,
copy secrets, install dependencies, merge, release, publish, deploy, or clean.

1. Resolve the canonical controller, product target/ref, integration owner, task
   worktree root, installed `yy` identity, and `wiki_root=$(yy wiki --path)`.
2. Inventory controller/product wiki files with hashes and classify every older
   page as `keep-project-path`, `move-controller`, `split`, `retire`, or
   `unresolved`. Preserve domain-relative paths; place portable lifecycle/Juno
   guidance under `controller/`. Consolidate progress guidance into
   `controller/yy_pi_progress.md` and portable tmux guidance into
   `controller/tmux_best_practices.md`.
3. Inventory every configured validation cwd, exact lockfile, ignored dependency
   tree, Python virtualenv/requirements, submodule, codegen output, fixture/cache,
   required tool version, and clean-tree rule.
4. Ask the owner for explicit decisions on network use; env/secret source and
   destination pairs; destination modes; virtualenv/install commands; submodules;
   generated outputs; and whether any step may be omitted. Never read or print
   secret contents and never discover `.env*` files broadly.
5. Generate a project-owned `.juno_task/config/worktree-hydration.yaml` candidate
   using `workflow_class: task_hydration`. Every step must use argv lists and
   declare `probe`, `timeout_seconds`, `fail_workflow: true`,
   `non_interactive: true`, `network`, `sensitive`, and `outputs`. Use exact-lock
   commands such as `npm ci` or owner-approved hashed Python requirements. A
   sensitive env step must call the packaged non-echoing `worktree_hydration.py`
   helper with one explicit source/destination pair.
6. Generate controller policy/instruction candidates using `yy wiki` and
   `$(yy wiki --path)/controller/...`, without absolute workspace paths.
7. Run canonical Workflow Runner lint and dry-run with a disposable task-shaped
   project root. Report candidate hashes, conflicts, unresolved owner decisions,
   and exact separately authorized plan/apply/recovery commands.

The same reviewed inputs must produce byte-identical candidates. A changed
source hash, controller identity, product target, workflow, owner answer, or
package generation invalidates any later apply plan.
