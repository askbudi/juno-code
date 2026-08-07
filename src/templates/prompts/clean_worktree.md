# Run an exact-base product-change workflow

Every product mutation uses a named exact-base worktree. Orchestrate from the canonical controller, pass the product root as `TASK_ROOT`, and keep Kanban/session writes routed through `JUNO_TASK_ROOT`. Juno never silently switches refs.

This instruction reset changes operating policy, not the current schema or helper contract. Continue to use `schema_version: 2` and the existing lifecycle helpers until the complete replacement ships.

## Required flow

1. Resolve the canonical controller and the owner-approved full target ref and SHA. Record task ID, expected paths, validation commands, risk tier, cleanup owner, and receipt root.
2. Run `worktree_lifecycle.py create`, `verify`, and joined `edit-preflight` for the exact-base named task worktree. Run `integration_candidate.py target-preflight` for each official target. Product steps are `edit_capable: true` and consume the successful admission; controller and integration-owner checkouts are not product edit locations.
3. Implement only in the admitted task worktree. Use focused affected tests as the inner loop. Implementation and repair workers never launch semantic reviewers.
4. Enter `REVIEW_READY` only when the requested behavior and ordinary happy path are complete, focused tests and lifecycle E2E pass, runtime/template parity is current, one full suite passes on the exact tip, and no known implementation TODO or accepted open finding remains.
5. Freeze the exact base and tip. For high risk, launch Reviewer A and then Reviewer B in fresh independent `yy pi` sessions against that same frozen identity. Never use bare `pi`; inherit project provider/model defaults or use only an exact project-allowed provider/model selector. Both reviewers are read-only. Do not repair between Reviewer A and Reviewer B. Configure orchestration so a finding from A does not prevent B from returning its independent result.
6. Wait for both review results before repair. If either reports findings, deduplicate both outputs by root cause and dispatch one repair packet to one repair session. Run focused tests, then one full suite at the replacement candidate boundary, freeze the new tip, and repeat Reviewer A then Reviewer B. Low/medium work uses the project-required single independent review.
7. After required PASS evidence, use `integration_candidate.py plan`, `build`, and `verify`. Reuse the reviewed tip when composition is unchanged; a composed candidate still receives the currently required independent candidate review. Target movement means rebuild and re-review.
8. Integrate only through the directly executed argv-list `integration_owner_preflight.py integrate` owner with declared risk and approved `--checked-out-target detach_same_sha`. Preserve current expected-SHA CAS, actual-target validation/review, feature-tag, partial-state, and resume requirements. Do not manually move refs.
9. Use typed `worktree_lifecycle.py cleanup` only after integrated reachability and current acceptance are proven. Preserve any uncertain, dirty, active, or unreachable worktree.
10. Report implemented, validated, reviewed, integrated, released, and cleanup-complete states separately from a bounded terminal summary. Keep raw logs and full receipts artifact-backed; observe long work through one bounded wait/result operation instead of repeated model-driven sleep/tail polling.

## Validation timing

```text
edit -> focused test -> edit -> focused test -> happy path
                                      |
                                      v
                         REVIEW_READY candidate
                                      |
                               one full suite
                                      |
                     Reviewer A -> Reviewer B
                                      |
                        findings? one repair
```

Reviewers do not rerun the full suite by default. They consume exact-tip validation evidence and run only bounded diagnostics needed to establish a finding. Rerun a full suite only at a new candidate boundary, after a failed full run, or when reviewed bytes legitimately changed.

## Current mechanical contract

For authorized local integration, retain the current `schema_version: 2`, `workflow_class: local_integration`, exact integration policy, validation ownership, typed receipts, candidate read-only identity, direct integration-owner argv command, actual-target child evidence, and safe cleanup requirements documented in `.juno_task/wiki/git_worktree_lifecycle.md`. Every typed receipt requires `producer_step_digest` bound to `JUNO_WORKFLOW_STEP_DIGEST`. This patch does not advertise the future task-level lifecycle command and does not reject or adapt existing workflows.

Never use G8ylrk's signer, key, HMAC, sandbox, Seatbelt, bubblewrap, trusted-runtime closure, special approval, helper-owned edit, or helper-owned commit architecture. Never infer push, publication, deployment, production mutation, restart, or post-deploy E2E authority from implementation or local integration.
