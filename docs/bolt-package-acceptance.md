# Bolt package acceptance canary

`npm run test:bolt-package-canary` packs the built Juno Code distribution, extracts that immutable npm artifact, and runs selected real-Git tests from the packaged runtime. It reuses the shipped task-workspace, merge-queue, metadata-controller, and CLI engines; the harness contains no alternate executor.

The selected contract covers concurrent X/Y exact-base worktrees and moved-target composition; concurrent A/B conflict preservation and in-place resolution; failed affected validation; stale expected-SHA CAS; queue-worker collision; dirty and unreachable cleanup refusal; disposable metadata prepare, verification, cutover plan, rollback plan, and controller-mutation independence; and hard refusal of retired lifecycle and controller-copy entrypoints.

## Architecture and cost comparison

| Property | Historical zEt5z2 / o58wD2 / Workflow Runner path | Bolt package canary |
|---|---|---|
| Product concurrency | Lifecycle/controller closure serialized broad phases | Four feature worktrees; only per-target CAS is serialized |
| Controller relationship | Product/controller copying and checkpoint closure | Metadata-only independent controller; zero product copying |
| Candidate handling | Multiple phase receipts and incomplete controller closure were possible | One direct X/A candidate and one moved/conflict composition per Y/B scenario |
| Semantic review | zEt5z2 recorded review-ready ceremony; o58wD2 retained incomplete review/controller truth | Risk-policy tests prove low 0, normal at most 1, high A then B; this deterministic canary launches 0 model reviewers |
| Full suites | zEt5z2 recorded a 1,294-test candidate suite; Workflow Runner could repeat gates by phase | One full repository suite at the final candidate boundary; canary editing loop is selected real-Git tests |
| Controller checkpoints | Historical paths required controller checkpoint closure | 0; disposable metadata commits are independently verified |
| Tokens/model tools | Historical task records do not provide comparable token/cache/tool totals | 0 model calls, 0 agent tool calls, 0 failed agent calls, 0 input/output/cache tokens |

The canary emits `juno_bolt_package_canary.v1` JSON with elapsed time, package inventory, scenario counts, and zero-agent-cost metrics. Use `--output /fresh/path.json` for a disposable receipt; never commit bulky run logs. Historical token/cache/tool figures remain `unavailable`, rather than being guessed.

## Reference run

On 2026-08-09, Node.js 24.12.0 packed 111 files and passed all 11 selected packaged-runtime tests in 22.949 seconds. The repository fast suite passed 1,288 tests with 29 intentionally skipped, and the focused Bolt suite passed 104 tests. The canary itself launched no model, reviewer, or checkpoint process.
