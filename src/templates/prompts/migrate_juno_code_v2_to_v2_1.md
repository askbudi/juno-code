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
   resolve an ambiguous product ref by guessing. The inspected checkout must be
   at the exact selected product-ref commit before policy generation; never mix
   one ref's identity with another checkout's filesystem. Review grouped legacy
   assets and automatic generated-cache classifications instead of answering
   once per cache file. Runtime candidates are fingerprinted, not executed.
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

6. After review, create the product metadata-removal diff only in a clean disposable
   linked worktree:

   ```bash
   yy migrate evacuation-plan --inventory /durable/inventory.json \
     --policy /durable/policy-bundle.json --project /absolute/source \
     --output /durable/evacuation-plan.json
   yy migrate evacuation-apply --plan /durable/evacuation-plan.json \
     --candidate /absolute/disposable-worktree \
     --output /durable/evacuation-apply.json --allow-disposable-mutation
   yy migrate evacuation-verify --plan /durable/evacuation-plan.json \
     --candidate /absolute/disposable-worktree \
     --output /durable/evacuation-verify.json
   ```

7. Present the immutable inventory, answers, policy, evacuation plan and verified
   candidate diff for review before requesting separately authorized integration,
   controller preparation, or cutover. Evacuation never stages, commits, moves the
   product ref, or deletes the preserved controller.

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
