# Run an exact-base product-change workflow

Every product mutation, including a small fix, uses a named exact-base worktree. Launch orchestration from the canonical branch-verified controller, pass product paths explicitly, and route Kanban/session writes through `JUNO_TASK_ROOT`. Controller dirt and unrelated processes are not integration inputs. Juno/Kanban must never silently switch refs.

MUST:

1. Read `.juno_task/wiki/git_worktree_lifecycle.md`, `.juno_task/wiki/parallel_runner_task_creation_best_practices.md`, and `.juno_task/wiki/parallel_runner_and_spec_review.md` before planning or executing.
2. Resolve the canonical controller and one owner-approved exact `refs/heads/<target>` per changed repository. Record repository identity, target ref/SHA, task ID, expected paths, validation commands, cleanup owner, nested repositories, and durable receipt root. Never infer a conventional target branch.
3. Use `.juno_task/scripts/worktree_lifecycle.py create` to create a named task worktree from the approved target SHA. A narrow `--fetch REMOTE,REF` may bind `FETCH_HEAD` with `--expected-base`; it must not advance the target ref. Existing paths/branches are reusable only when path, ref, HEAD, and cleanliness exactly match the manifest.
4. Run implementation only in the task worktree. Verify its Git root, branch, base, and clean starting state; edit only declared paths; validate; and create one or more coherent task commits. Product steps receive explicit `TASK_ROOT`; controller-owned Kanban/session writes stay on the controller.
5. In a separate context, produce a `pre_merge` PASS receipt bound to the request/PDR, complete base-to-tip diff, expected paths, commits, tests, and open-bug set. A failed review requires a review-fix commit and a fresh receipt.
6. Use `integration_candidate.py plan` and `build`. When the target is still the task base, the candidate may be the reviewed task tip. When it advanced, build a both-parent candidate whose parents are exactly current target then reviewed task tip. Conflicts or target ambiguity preserve the worktree and fail closed.
7. Independently validate the candidate and produce a `candidate` PASS receipt. Run `integration_candidate.py verify`; any target movement after review requires candidate rebuild and re-review. Never reuse a stale receipt.
8. Integrate only through `integration_owner_preflight.py integrate`, using the verified candidate receipt. It must lock `(Git common directory, full target ref)`, recheck the expected SHA, update the target with compare-and-swap, validate the actual target, and require an `actual_target` PASS receipt. List nested repositories child-first and bind root gitlinks. Partial multi-repository integration is preserved and reported; it is never rewound or called success.
9. Require a typed integration receipt with `outcome=integrated` and a local `juno-feature/<task>/<sha>` tag before cleanup. The tag is local evidence, not package-release or push authority.
10. Use `worktree_lifecycle.py cleanup` only after actual-target review passes, the reviewed result is reachable from the exact target, the task worktree is clean/inactive, and nested worktrees are handled first. Preserve blocked worktrees with owner and reason; never force cleanup.
11. Persist creation, pre-merge, candidate, integration, actual-target, validation, feature-tag, cleanup, and final semantic-verdict receipts under the controller's durable workflow artifact root. Report local target, remote target, and runner/semantic outcomes separately.

For an authorized local-integration workflow, declare exactly:

```yaml
schema_version: 2
workflow_class: local_integration
integration_policy:
  queue: automatic_after_review_pass
  channel_scope: git_common_dir_and_target_ref
  target_movement: rebuild_and_rereview
validation_ownership:
  pre_merge_review: <step-id>
  candidate_review: <step-id>
  actual_target_review: <integration-step-id>
```

Every typed receipt in this workflow explicitly lists `producer_step_digest` in `required_fields`; producers write the matching `JUNO_WORKFLOW_STEP_DIGEST` value.

MUST NOT:

- Do not edit product files in the controller or integration-owner checkout, even for a small fix.
- Do not pre-advance a local target merely to create a task worktree.
- Do not require controller cleanliness, repository-wide writer quiescence, or a clean checkout owner as a target-channel gate.
- Do not use a direct merge/fast-forward command in place of the reviewed candidate and expected-SHA CAS helper.
- Do not auto-stash, reset, discard, rewind, force-remove, force-delete, or silently overwrite work.
- Do not infer push, publication, package release, deployment, production mutation, or post-deploy E2E authority from task execution or local integration.

```text
controller orchestration
  -> exact approved target SHA
  -> named task worktree
  -> implementation + tests + commit
  -> pre_merge PASS
  -> direct/both-parent candidate
  -> candidate PASS
  -> target-channel lock + expected-SHA CAS
  -> actual_target PASS + local feature tag
  -> typed safe cleanup + final verdict
```

If any identity, review, integration, or cleanup gate cannot be proven, preserve the task/candidate evidence and report the exact blocker and safest next command.
