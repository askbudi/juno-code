# End-of-session reflection

Perform a retrospective using concrete session evidence. Do not edit product files, commit, or ask questions. The only authorized mutation is the Kanban follow-up required below.

Compare the original goal, actual path, outcome, and validation. Identify wins, detours, retries, weak assumptions, missing knowledge/tools/validation, and external constraints. Explain root causes, not symptoms; do not invent improvements.

For each meaningful issue:

1. Classify scope (session, domain, repository, or cross-project) and recurrence (low/medium/high).
2. Consider **simplification** (remove steps/branches/SOTs), **10x** (reusable helper, template, automation, or better default), and **100x/categorical removal** (architecture, invariant, lint, test, or fail-closed guard). These are lenses, not required claims.
3. Search existing guidance/helpers first, then choose one home: existing wiki, new wiki only if none owns it, `AGENTS.md` only for short stable contracts, helper/script, automated guard, task/spec evidence, or no action.
4. Check recurrence evidence, overfit risk, maintenance/context cost, exclusions, and the smallest useful intervention. Do not institutionalize one-offs without strong impact.

Wiki proposals must resolve the canonical root with `yy wiki --path`, then follow its project `wiki_maintenance.md` specialization when present or `controller/wiki_maintenance.md` otherwise. Name the path, concise instruction, failure prevented, runtime contract, validation gate, and why it belongs there. Helper proposals must name the path/interface, behavior, adoption point, replaced work, and tests.

## Output and durable Kanban follow-up

Give a brief verdict, then produce this complete reflection table:

| Priority | Evidence/root cause | Scope/recurrence | Simplify/10x/100x action | Home | Overfit/tradeoff | Validation |
| --- | --- | --- | --- | --- | --- | --- |

Finish with the top three recommendations, what should remain unchanged, decisions needing approval, and explicitly say when no wiki/helper change is justified.

After the retrospective is complete, create exactly one backlog task through the project-local `./.juno_task/scripts/kanban.sh`. The task must:

- use the exact feature tag `REFLECTION_TABLE` (additional relevant tags are allowed);
- include the complete reflection table without summarizing or dropping rows;
- include the verdict, top three recommendations, unchanged contracts, approval decisions, and why backing implementation and tests matter;
- identify the reflected task/session and related Kanban task IDs when available; and
- request later review/approval rather than authorizing implementation, integration, release, push, deployment, cleanup, or E2E.

Use `--body-file -` (or another shell-safe body-file input) so Markdown fences, backticks, and variables are not interpolated. Read back the created task and verify that `feature_tags` contains the exact `REFLECTION_TABLE` tag and that its body contains the complete reflection table before reporting the new task ID. If creation or verification fails, report the failure truthfully; do not claim the reflection was persisted.
