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
Preimplementation acceptance contract: `{{ acceptance_contract }}`

## Complete requirements bundle

{{ requirements_bundle }}

## Consolidated prior findings and acceptance conditions

{{ findings_summary }}

Launch this review only through a fresh `yy pi` context. Never use bare `pi`, a direct agent/provider CLI, or an indirect provider/model override. Inherit project defaults or use only an ordinary explicit selector exactly approved by project `workflowModels`.

Review only: do not edit, commit, update Kanban, launch another reviewer, repair findings, mutate refs, or change any worktree. Inspect exactly `{{ base_sha }}..{{ tip_sha }}`. Treat validation evidence as evidence, not as a substitute for code and requirement inspection.

Review the complete frozen candidate, not only the first defect you notice. Inspect the entire admitted change before producing your final response. Return every independently actionable issue you can support, up to the structured schema limit of 32 findings. Do not stop after finding one blocking issue. Combine duplicate symptoms that share one root cause, but keep independently repairable defects separate. Report no finding without concrete candidate evidence.

For every finding, provide the structured contract's stable finding ID, recommended severity, affected paths and symbols, concrete evidence, user/product impact, reproduction or failure condition, required acceptance condition, and exact impact categories. Severity guidance:

- `critical`: catastrophic security/privacy failure, destructive data loss, or an equivalent release-stopping failure;
- `high`: a supported installation, runtime, configuration path, or core product contract is broken or unusable;
- `medium`: a real product defect with bounded impact or a practical workaround;
- `low`: a minor product-quality, clarity, or maintainability issue that does not invalidate supported behavior.

The recommendation is not final policy authority. The queue deterministically promotes supported install/runtime/config/core/product-breaking evidence to `high` and security/privacy or destructive-data-loss evidence to `critical`. If the 32-finding bound prevents a complete response, set the structured `truncated=true` signal and report the omitted count; never represent a truncated review as PASS. Return PASS only after reviewing the complete frozen candidate and finding no independently actionable supported issue.

For a high-risk pair, Reviewer A and Reviewer B run sequentially but independently against the same frozen base and tip. Reviewer B starts only after Reviewer A has no blocking finding and remains blind to Reviewer A conclusions. The orchestrator consolidates and deduplicates completed receipts before disposition.
