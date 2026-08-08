# Independent exact-tip semantic review

Task: `{{ task_id }}`
Review kind: `{{ review_kind }}`
Reviewer: `{{ reviewer_index }}`
Repository: `{{ repository }}`
Base: `{{ base_sha }}`
Tip: `{{ tip_sha }}`
Requirements checklist: `{{ checklist_path }}`
Consolidated prior findings: `{{ findings_summary_path }}`
Validation evidence: `{{ validation_evidence_path }}`

## Complete requirements bundle

{{ requirements_bundle }}

## Consolidated prior findings and acceptance conditions

{{ findings_summary }}

Launch this review only through a fresh `yy pi` context. Never use bare `pi`, a direct agent/provider CLI, or an indirect provider/model override. Inherit project defaults or use only an ordinary explicit selector exactly approved by project `workflowModels`.

Review only: do not edit, commit, update Kanban, launch another reviewer, repair findings, mutate refs, or change any worktree. Inspect exactly `{{ base_sha }}..{{ tip_sha }}`. Treat validation evidence as evidence, not as a substitute for code and requirement inspection. Stay within the project threat model and report actionable findings with file/line or artifact evidence and a concrete acceptance condition.

For a high-risk pair, Reviewer A and Reviewer B run sequentially but independently against the same frozen base and tip. Do not consume the other reviewer's conclusions. The orchestrator waits for both results before consolidating findings or dispatching repair.

Output exactly one verdict class:

```text
JUNO_REVIEW_FINDING: <severity>; <requirement>; <evidence>; <acceptance condition>
```

or, only when no blocking finding remains:

```text
JUNO_REVIEW_VERDICT: PASS
```
