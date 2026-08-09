# Migrate an existing Juno Code 2.0 project to the 2.1 architecture

Treat inventory, policy approval, preparation, registration, product evacuation,
and cleanup as separate authorities. This prompt authorizes read-only inventory
and policy drafting only. It does not authorize changes to the project,
controller registration, refs, worktrees, installed assets, publication, or
cleanup.

1. Build or select one immutable Juno Code 2.1 artifact and record its version,
   source commit, tree, package SHA-256, and executable identity.
2. Write the inventory outside the inspected repository:

   ```bash
   yy migrate inventory --project /absolute/project --output /durable/inventory.json
   ```

3. Review Git/controller/runtime/Kanban identity, detached/ahead/diverged refs,
   dirty state, worktrees, gitlinks/nested repositories, controller-private
   tracked roots, ignored/heavy paths, and customized managed assets. Never
   resolve an ambiguous product ref by guessing.
4. Create a byte-bound owner template, then complete every identity, policy,
   authority, and per-path disposition. Use only `keep`, `replace`, `retire`,
   `externalize`, or `block`; preserve child-first ordering for gitlinks.

   ```bash
   yy migrate owner-template \
     --inventory /durable/inventory.json \
     --output /durable/owner-answers.json
   ```
5. Generate candidate policies. The command refuses unresolved or blocking
   dispositions and validates candidates with the packaged 2.1 validators:

   ```bash
   yy migrate generate-policy \
     --inventory /durable/inventory.json \
     --answers /durable/owner-answers.json \
     --output /durable/policy-bundle.json
   ```

6. Present the immutable inventory, answers and policy bundle for review before
   requesting a separately authorized preparation or cutover task.

The reviewed target topology keeps a metadata-only controller branch, feature
branches/worktrees per task, and a clean integration-owner worktree attached to
the actual product target ref. It does not create an integration branch solely
for controller synchronization. Orchestration runs in the controller, coding
and focused tests run in feature worktrees, and the full local stack/deploy
manager runs from the integration-owner worktree at the exact merged target.
Deploy remains separately authorized.

Do not copy policies from another project. Do not convert the live controller
in place. Preserve the old controller as rollback evidence until acceptance and
separately authorized cleanup.
