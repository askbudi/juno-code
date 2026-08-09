# Migrate juno-kanban v1 storage to v2

Own a safety-gated migration of this project's canonical juno-kanban board from legacy v1 NDJSON storage to v2 Git-native Markdown/ledger storage. This prompt authorizes investigation and a dry run. It does **not** by itself authorize production cutover, push/deploy, deletion/unrelated archival, or destructive cleanup; obtain explicit owner approval after presenting the dry-run evidence and exact cutover command. Immutable cold packs may be part of an explicitly approved tiered conversion, but they must preserve complete source semantics and are not permission to discard history.

## Mandatory sources and boundaries

1. Read project `AGENTS.md` when present. If project wiki or installed/source v2 Kanban operational docs are available, use them as additional constraints, but do not assume a `juno-code/` source tree or README exists. This prompt is the portable baseline. If the exact v2 executable and its `convert --help` contract cannot be identified, stop.
2. Resolve and record the canonical controller checkout. If no v2 resolver is installed yet, derive it from explicit owner confirmation plus Git facts and record that limitation. All board reads/writes and durable receipts belong to that controller. Do not use a task or integration-owner checkout as an alternate board.
3. Keep these operations separate: source checkout selection, executable selection, project script installation, board conversion, rollback, Git integration, push, deployment, and post-deploy E2E. Approval for one never authorizes another.
4. Never edit generated v2 task/ledger/cutover files manually, run a force/dirty conversion, replace the legacy source before accepted cutover, silently switch refs, auto-stash/reset/clean, or discard unknown work.
5. Keep reports, backups, installable package/executable artifacts, and rollback evidence outside every repository/worktree. `/tmp` may be used for a reviewed dry-run report but must not be the only durable location for an authorized cutover.
6. Treat the legacy board as one referential inventory even when only active work should remain hot. Decide the hot/cold policy from status counts and the complete dependency/related-task graph. Never make a filtered NDJSON file the conversion source: omitted terminal rows can break readiness, exact lookup/history, later conversion, and rollback.
7. Keep large per-task hashes, bodies, and receipts out of terminal/stdout. Write them directly to a mode-restricted external artifact, print only a bounded summary, and verify the artifact hash. This is both an operability and sensitive-data boundary.
8. Require an immutable, hash-bound, non-editable executable/package identity. When building from source, use a clean disposable clone/worktree at an exact reviewed commit rather than a protected canonical source checkout with stale or unwritable build state. Do not assume Python wheels are the only valid packaging format.
9. Before selecting or installing v2, fetch (without switching branches) the owner-approved Juno Kanban v2 source ref, resolve its latest reviewed commit, and record both the full ref and 40-character SHA. Require the source worktree, built artifact, selected executable, and migration receipt to bind that same SHA; a merely compatible but older installed v2 is stale and must not be used. If the approved ref cannot be fetched or its latest commit cannot be reviewed and frozen, stop. Never install or execute a floating branch name during conversion.

## Package integrity preflight — before any canonical board access

The Juno Kanban 2.0.5 sdist omitted its requirements source, so an
sdist-derived wheel could install without declaring `ruamel.yaml` and then fail
on the first YAML-backed import. Do not use 2.0.5 as migration authority and do
not accept an import that succeeds only because the operator environment already
contains the dependency.

The reviewed fixed candidate is Juno Kanban 2.0.6 at source commit
`1ed2de072a52c7c9ae0559d62e097a04af595a73`. Freeze the owner-approved artifact
SHA separately; a version string or source SHA alone is insufficient. Before
reading the board:

1. Inspect wheel `METADATA` and require exactly the bounded runtime declaration
   `Requires-Dist: ruamel.yaml (<0.19,>=0.18.6)` (normalization-equivalent
   spacing is acceptable).
2. Create a clean virtual environment, prove `ruamel.yaml` is initially absent,
   install the reviewed wheel with normal dependency resolution, and verify
   installed metadata, `import kanban.codec`, and a minimal public CLI YAML
   create/get smoke on a disposable board.
3. Run a negative disposable `--no-deps` installation and prove the preflight
   stops on the missing dependency before any canonical board command.
4. Record source commit, wheel SHA-256, installed executable SHA/version, clean
   environment path, commands, exits, and bounded stdout/stderr hashes.

Never repair dependencies mid-conversion, use `--no-deps` for the selected
runtime, or mutate the canonical board to diagnose packaging. This package
identity/dependency preflight is shared with the Juno Code migration prompt.

## Required flow

```text
inventory only
  -> identify canonical controller/ref/HEAD and all linked worktrees
  -> identify exact legacy board/config/runtime and freeze owner
  -> identify exact v2 executable/source/policy without selecting it globally
  -> preserve hashes/counts/status/reference graph and classify dirt
  -> choose full-hot or whole-source hot/cold policy; never filter the source
  -> prove converter complexity, atomic rollback across every selected tier, and full-scale disposable runtime
  -> v2 convert --dry-run with external report and bounded stdout
  -> independently compare whole-source v1/v2 semantics and write acceptance matrix
  -> present cutover prerequisites, blockers, rollback assets, observer policy, and exact command
  -> STOP for explicit owner cutover authorization
  -> clean/frozen/tagged conversion under a non-signaling observer
  -> global doctor, cache/reconcile, whole-source parity/readback, and receipt review
  -> for tiered policy: archive doctor and cross-tier parity/readback
  -> full legacy export/restore rehearsal while the immediate rollback window remains open
  -> report local commit separately from push/deploy state
```

## Phase A — inventory without mutation

Record in a durable migration manifest:

- controller path, branch, HEAD, upstream/remote target, Git common directory, and `git status --porcelain=v1 --untracked-files=all`;
- `git worktree list --porcelain`, with each checkout's role, branch, status, and board-writing processes;
- legacy board path(s), config path, row count, byte size, SHA-256, malformed/duplicate ID findings, field-shape variants (including omitted versus null collections), newline/byte-canonicalization anomalies, and current task/status/dependency/tag summaries;
- the proposed hot statuses and cold statuses, counts in each tier, every active-to-terminal blocker/related edge, and every active task that references terminal history;
- exact legacy executable path/version and a retained immutable installable package/executable artifact identity (wheel when applicable);
- exact v2 executable path/version and compatibility policy;
- whether v2 canonical task files, ledger, cutover metadata, cache, cold archive packs/manifests, staging roots, machine freeze/lock state, or incomplete activation receipts/markers already exist;
- external backup/report destinations, filesystem capacity/permissions, conversion freeze owner, semantic acceptance owner, rollback owner, and separately authorized integration/push owner.

Fail closed on ambiguous canonical storage, unrelated `JUNO_TASK_ROOT`, active concurrent board writers, partial conversion state, missing exact legacy installable artifact, unknown dirt in task-storage paths, corrupt input, or unresolved branch ownership. Do not "repair" evidence before reporting it.

## Phase B — choose storage policy and prove converter eligibility

Make the storage-policy decision before creating a dry-run input:

- `full-hot`: all source tasks remain ordinary mutable/listable v2 tasks; or
- `active-hot/terminal-cold`: actionable statuses become hot Markdown/ledger state while terminal statuses become immutable, exact-addressable cold v2 records that are excluded from ordinary hot list/search.

For active-hot/terminal-cold, require the converter—not an ad hoc pre-filter—to consume every source row in one transaction. Exact get/history/dependency resolution and rollback/export must span both tiers. Require the owner and selected tool contract to define and test whether cold tasks are permanently immutable, explicitly promotable, or reopened through a new related hot task; do not invent an identity-changing workaround.

Inspect the conversion algorithm before trusting a time estimate. Reject or fix a path that rebuilds a global cache/index, scans the complete board, or performs equivalent whole-board work once per task. The eligible shape is global validation once, batch hot writes, batch cold-pack creation when tiering is selected, and one derived-cache rebuild; acceptance must assert `cache_rebuild_count == 1`. Run the real full source in a disposable fixture and record start/end/duration, phase timings/rates, peak resource use when available, final counts, and artifact sizes. Estimate production time from that full-scale proof, not from early linear progress.

Require focused tests and independent review for every policy:

- null/missing legacy fields, timestamp normalization, and newline/byte anomalies; any compatibility equivalence or source normalization must be narrowly scoped, owner-reviewed, and protected by before/after hashes rather than silently broadening semantic equality;
- duplicate and case-folded ID rejection across all selected ID sets;
- canonical final-path config/provenance hashes rather than random staging paths;
- fault injection after every selected canonical activation boundary, restoring the exact prior state;
- whole-source semantic hashes and full legacy export/rollback.

When active-hot/terminal-cold is selected, additionally require archive-time ordering (`archived_at` cannot predate terminal transition/event time), content-addressed pack verification, archive dirty guards, fault injection after archive activation, exact restoration of any pre-existing archive, and complete hot+cold semantic hashes.

## Phase C — dry run and independent acceptance

Use the exact selected v2 executable with `JUNO_TASK_ROOT` pinned to the controller. First capture `juno-kanban convert --help`, then run the equivalent supported dry-run form (the expected v2 contract is):

```bash
juno-kanban convert /absolute/controller/.juno_task/backlog.ndjson \
  --dry-run \
  --report /external/or-reviewed-temp/conversion-dry-run.json
```

Adapt the legacy source path only from verified project facts; never guess between `.juno_task/backlog.ndjson` and `.juno_task/tasks/backlog.ndjson`. Capture command, executable hash/version, source/config hashes, exit code, stdout/stderr hashes, report hash, start/end timestamps, and post-command Git/board hashes proving dry-run non-mutation.

Build an acceptance matrix independently from the converter summary. At minimum compare task IDs and case, body/title, status summaries, commit/response, tags, dependency edges/readiness/order, timestamps, history policy, list/search/get semantics, and privacy-sensitive fields. Run documented staging, parity, and global-doctor checks where the dry-run contract supports them. For a tiered migration also prove a disjoint complete partition (`source = hot + cold`), ordinary list/search excludes cold rows, exact cold get/history works, every cross-tier reference resolves, archive search is bounded, whole-source hashes remain equal, and archive doctor passes. Explain every discrepancy; do not normalize it away.

If source code, package/executable bytes, controller HEAD, board/config hash, partition policy, or exact command changes after the dry run, invalidate the old gate. Produce or select a fresh immutable installable artifact (wheel when applicable), rerun the full-source dry run, create a new tag, and present the new identities; passing evidence is not transferable across changed inputs.

## Cutover authorization gate

Before any real conversion, report:

- dry-run verdict and report location/hash;
- every unsatisfied prerequisite;
- exact clean/freeze/tag/base facts;
- exact retained legacy installable artifact and executing v2 package/executable identities;
- external checksummed backup and restore-rehearsal plan;
- required installed-public-CLI benchmark receipt;
- benchmark reuse criteria binding the executing package/module, benchmark driver, command surface, and relevant source identity, or an explicit reviewed compatibility argument when exact executable reuse is impossible;
- the disposable full-scale runtime result, algorithmic complexity judgment, resource margin, and phase-level observability available during the real run;
- proposed pre-cutover tag, backup path, report path, and exact conversion command;
- the non-signaling observer command/policy, including producer PID/run identity, heartbeat or durable progress timestamp, stage/work totals, rate/ETA provenance, canonical hashes, and markers distinguishing staging, activation, validation, and commit;
- immediate rollback command/receipt contract;
- what local Git commit/ref would change and confirmation that push/deploy remain unauthorized.

Then stop and ask for explicit authorization naming the controller ref and exact cutover command. A request to "analyze", "prepare", or invoke this macro is not cutover authorization.

## Authorized cutover and validation

Only after explicit approval, re-run all freshness/cleanliness/freeze checks and execute the exact non-dry-run `convert` command verified from that v2 executable's help. Do not weaken any prerequisite. Observe without signals: no short wall timeout, automatic retry, or kill based only on quiet stdout. A monitoring timeout may stop waiting, but must never signal the producer. Require the machine-generated conversion receipt and verify the conversion commit, pre-cutover tag/parent ancestry, backup/checksum manifest, restore rehearsal, benchmark identity, staging round trip, activation of every selected canonical tier, active legacy-source removal, cache rebuild, and global doctor. For active-hot/terminal-cold, also require archive doctor and exact hot/cold partition evidence.

Run reconcile-check, cache rebuild, readback/parity, and a full legacy export using the installed public v2 CLI. Seal a durable post-cutover acceptance receipt containing commands/exits, doctor results, whole-source/export counts, ancestry, artifact hashes, timings, rollback class, and—when tiering is selected—partition/pack counts and cross-tier parity; chat output or a final narrative is not sufficient evidence. Prove the export contains every source ID and preserves whole-source semantics. For tiered policy, also prove all cross-tier blocker/related edges preserve v1 semantics. Prove the controller remains the only canonical writer and other linked worktrees resolve to it. Derived cache files are disposable evidence, not canonical state; configure or relocate them so final cleanliness does not require committing cache output.

Keep the controller at the machine-generated cutover commit while immediate rollback eligibility is being evaluated. Any later controller commit changes the rollback class to post-write; record that transition instead of claiming the immediate rollback command is still eligible. If a post-commit mismatch exists, preserve state and use only the documented receipt-bound rollback path after separate rollback authorization; never hand-edit or improvise a reverse migration.

## Interrupted-run recovery

Silence or an observer timeout is not proof of producer failure. First prove the original producer is dead, classify the last completed phase from durable markers/receipt, and hash every selected canonical tier. When failure was pre-activation and canonical v1 is unchanged, remove or relocate only the exact receipt-classified staging/freeze artifacts; do not clean broad paths. When any canonical activation occurred, stop and use the converter's tested selected-tier recovery or receipt-bound rollback contract. Never start a competing retry against ambiguous state.

## Final report

Report separately:

- runner/tool exit versus semantic migration verdict;
- source and executable identities;
- pre-cutover tag/base and conversion commit;
- receipt/backup/benchmark/report paths and hashes;
- parity/doctor/cache results;
- durable post-cutover acceptance receipt path/hash rather than only terminal output;
- selected full-hot or active-hot/terminal-cold policy, whole-source counts, full legacy export, current rollback class, and cross-tier parity when applicable;
- measured dry-run/cutover durations, why the estimate was credible, and any observer timeout distinguished from producer outcome;
- controller/task/integration-owner statuses;
- local ref state versus remote/push state;
- unresolved blockers and the single safest next command.
