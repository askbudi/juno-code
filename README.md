# juno-code

<p align="center">
  <img src="./Juno-code-icon.png" alt="juno-code logo" width="200" />
</p>

<p align="center">
  <strong>AI-powered code automation with structured task management</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/juno-code"><img src="https://img.shields.io/npm/v/juno-code.svg" alt="npm version" /></a>
  <a href="https://github.com/askbudi/juno-code"><img src="https://img.shields.io/github/stars/askbudi/juno-code?style=social" alt="GitHub stars" /></a>
</p>

## Installation

### Isolated Juno 2 source toolchain

From a monorepo checkout containing `juno-code/` and `juno_kanban/`:

```bash
./juno-code/scripts/juno-002-source-toolchain.sh install
export PATH="$PWD/.juno_toolchain/juno-002/bin:$PATH"
yy-juno-002 --version
juno-kanban-juno-002 --version
./juno-code/scripts/juno-002-source-toolchain.sh status
```

The installer is idempotent, builds into the repository-local `.juno_toolchain/juno-002` npm prefix and Python venv, and never writes normal global `yy`. Both aliases validate the selected Kanban against the single `>=2.0.5,<3.0.0` policy before execution. `yy-juno-002 init` provisions the disposable controller's own `.venv_juno` from that selected Kanban source; it never adopts an unrelated active/global environment, and generated linked-worktree wrappers continue to execute only the controller runtime. Override source or state paths with `JUNO_002_CODE_SOURCE`, `JUNO_002_KANBAN_SOURCE`, or `JUNO_002_STATE_DIR`; spaces in paths are supported.

Adopt the isolated executables only in the intended shell, then inspect executable, source, and compatibility identities:

```bash
export PATH="$PWD/.juno_toolchain/juno-002/bin:$PATH"
hash -r
command -v yy-juno-002 juno-kanban-juno-002
yy-juno-002 --version
juno-kanban-juno-002 --version
./juno-code/scripts/juno-002-source-toolchain.sh status
./juno-code/scripts/juno-002-source-toolchain.sh controller-status
```

Register a controller checkout from a linked task checkout when an environment override is not preferable:

```bash
./juno-code/scripts/juno-002-source-toolchain.sh register-controller /path/to/controller controller-branch
./.juno_task/scripts/controller_resolver.py --cwd "$PWD" --operation diagnostic --format shell
```

Resolution is checkout-aware: explicit `JUNO_TASK_ROOT`, then repository-local controller registration, then the current project root. A configured controller is branch-verified and invalid configuration fails closed. Juno and Kanban never switch, detach, stash, or update branches to manufacture compliance.

| Lane | Permitted | Forbidden |
|---|---|---|
| Controller | Kanban/Juno mutation, orchestration, prompts, and durable receipts; pass the product checkout as explicit `TASK_ROOT` | Product implementation or integration; implicit ref changes |
| Task checkout | Implementation, focused tests, and coherent task commits against the declared base | Private Kanban/session state or integration-target mutation; route writes to the controller |
| Integration owner | Reviewed candidate integration under the `(Git common directory, full target ref)` channel lock and expected-SHA CAS | Kanban/orchestration/session writes, unrelated edits, target rewind, or implicit push/deploy |
| Small fix worktree | Exact-base named branch with the same review/candidate lifecycle as a feature | Controller-checkout product edits, bypassing review, or broad unrelated refactors |

Choose the smallest lane that satisfies the work. Controller dirt and unrelated agents do not gate exact-base creation or a disjoint target channel. Every product change uses a named worktree. See `.juno_task/wiki/git_worktree_lifecycle.md` for the single lifecycle contract rather than duplicating it here.

Rollback operations are intentionally separate:

1. **Source rollback:** use Git in the source worktrees to choose reviewed source commits; this does not select executables or alter Kanban data.
2. **Executable selector rollback:** run `./juno-code/scripts/juno-002-source-toolchain.sh rollback-selection`, then `status`; this swaps only the repository-local selected executable paths and does not replace normal global tools.
3. **Kanban data rollback:** restore/migrate a separately backed-up board with Kanban's reviewed data procedures. Switching source branches—including switching to `master`—or selectors never downgrades, reverses conversion, or restores board data.

These local commands authorize neither push/deploy nor production-board conversion or post-deploy E2E.

Normal stable installation remains explicit and independent:

```bash
npm install -g juno-code

# For Pi agent support (optional - multi-provider coding agent)
npm install -g @mariozechner/pi-coding-agent
```

After installation, initialize your project:

```bash
juno-code init --task "Your task description" --subagent claude
# Or with Pi (multi-provider agent)
juno-code init --task "Your task description" --subagent pi
```

### Shell Completion (Tab Autocomplete)

```bash
# Install completion for your current shell
juno-code completion install

# Or explicitly target a shell
juno-code completion install bash
juno-code completion install zsh
juno-code completion install fish

# Check status
juno-code completion status
```

After installation/reload, `juno-code c<TAB><TAB>` suggests available subcommands.

---

## The Ralph Method: Where It All Started

![Ralph Wiggum - The Simpsons](https://ghuntley.com/content/images/size/w1200/2025/06/3ea367ed-cae3-454a-840f-134531dea1fd.jpg)

> *"I'm in danger!"* - Ralph Wiggum, every time you Ctrl+C a working AI loop too early

[Geoffrey Huntley's Ralph Method](https://ghuntley.com/ralph/) demonstrated something remarkable: AI can deliver production-quality software through iterative refinement. One engineer reportedly delivered a $50,000 project for $297 using this technique.

The core insight is simple:
```bash
while :; do
  claude
done
```

Run the AI in a loop. Let it iterate. Watch it solve problems, fix bugs, and add features until you hit Ctrl+C.

**But Ralph has problems:**

| Problem | What Happens | Why It Matters |
|---------|--------------|----------------|
| **One-time only** | Ralph shines for single big tasks | Doesn't scale to iterative development with many tasks |
| **Overcooking** | Loop runs too long, AI adds features nobody asked for | You get bloated code and wasted tokens |
| **Undercooking** | You Ctrl+C too early, work is incomplete | Features half-done, bugs half-fixed |
| **Fragile state** | Markdown files (TASKS.md, PLANNING.md) as source of truth | LLMs can corrupt format; no strict schema |
| **Vendor lock-in** | Ralph was built for Claude Code | Can't easily switch to Codex, Gemini, Pi, or others |
| **No traceability** | Changes blend together | Hard to debug, impossible to time-travel |

## juno-code: Ralph, But Better

juno-code takes the Ralph insight—*AI works better in loops*—and adds the structure needed for real work:

### Iteration Control: No More Overcooking
```bash
# Exactly 5 iterations - cooked perfectly
juno-code -b shell -s claude -m :opus -i 5 -v

# Until kanban tasks complete - cooked exactly right
./.juno_task/scripts/run_until_completion.sh -s claude -i 1 -v

# Unlimited (like Ralph) - when you really want that
juno-code -b shell -s claude
```

### Task Tracking: Structured, Not Prose
Built-in kanban via [juno-kanban](https://pypi.org/project/juno-kanban/). Hot current state uses safe Markdown plus hash-chained ledgers; explicitly archived terminal tasks use immutable NDJSON packs.

Cross-project routing is disabled by default. Authorize it in `.juno_task/config.json` with `kanbanRegistry: { "enabled": true, "allowedProjects": ["alias"] }`, register an initialized destination with `juno-kanban project add alias --path /absolute/project/path`, then route any read or write explicitly. Environment overrides are `JUNO_KANBAN_REGISTRY_ENABLED` and comma-separated `JUNO_KANBAN_REGISTRY_ALLOWED_PROJECTS`; enablement without allowed aliases remains deny-all.

```bash
./.juno_task/scripts/kanban.sh --project juno-code create --body "Cross-project issue" --tags bug
./.juno_task/scripts/kanban.sh --project juno-code list --status todo
```

The destination wrapper/runtime remains authoritative, and invalid routing never falls back to the source board. This implementation boundary matters because direct foreign-storage access could bypass destination controller, virtualenv, stdin, or write guards; real two-project tests prove exact target and stdin behavior.

Normal local usage remains unchanged:
```bash
# Query tasks programmatically - always parseable
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress

# Each task is isolated; exact get transparently resolves hot or archived state
./.juno_task/scripts/kanban.sh get TASK_ID

# Scale to thousands of tasks without context bloat
./.juno_task/scripts/kanban.sh list --limit 5  # Shows only hot work that matters
```

Cold archives never enter normal discovery. Owner-authorized maintenance uses a clean tree, an external revision-bound plan/receipt, `archive-pack create`, and both archive/global doctors. Never edit sealed packs, reopen an archived ID, infer production authorization, or combine implementation work with push/deploy/post-deploy E2E; create a new related hot task instead.

```bash
./.juno_task/scripts/kanban.sh archive-pack plan --status done,archive --older-than 90d --report /external/archive-plan.json
./.juno_task/scripts/kanban.sh archive-pack create --plan /external/archive-plan.json --report /external/archive-create.json
./.juno_task/scripts/kanban.sh archive-pack doctor
./.juno_task/scripts/kanban.sh archive-search --tag backend --limit 20 --projection metadata
```

### Task Dependencies
Declare what must be done first. The kanban system builds a dependency graph so agents work in the right order:
```bash
# Create a task that depends on another
./.juno_task/scripts/kanban.sh create "Deploy API" --blocked-by A1b2C3

# Or use body markup (4 synonym tags supported)
./.juno_task/scripts/kanban.sh create "Deploy API [blocked_by]A1b2C3[/blocked_by]"

# What's ready to work on right now?
./.juno_task/scripts/kanban.sh ready

# Dependency-aware execution order
./.juno_task/scripts/kanban.sh order --scores

# Inspect a task's dependency info
./.juno_task/scripts/kanban.sh deps TASK_ID
```

### Backend Choice: Use Any AI
Switch between Claude, Codex, Gemini, Pi, or Cursor with one flag:
```bash
# Stuck on a bug? Try different models
juno-code -b shell -s claude -m :opus -i 1 -v
juno-code -b shell -s codex -m :codex -i 1 -v
juno-code -b shell -s gemini -m :flash -i 1 -v
juno-code -b shell -s pi -m :sonnet -i 1 -v
```

### Parallel Execution
Run multiple tasks simultaneously with the parallel runner:
```bash
# Run 3 kanban tasks in parallel
./.juno_task/scripts/parallel_runner.sh --kanban T1,T2,T3 --parallel 3

# Visual monitoring in tmux
./.juno_task/scripts/parallel_runner.sh --tmux --kanban T1,T2,T3 --parallel 5

# Process a CSV file with custom prompt
./.juno_task/scripts/parallel_runner.sh --items-file data.csv --prompt-file instructions.md --strict

# Dependency-aware parallel execution
./.juno_task/scripts/parallel_runner.sh --kanban-filter 'ready' --parallel 3
```

#### Tmux handoff for operator investigations
Use tmux handoff when each item needs a stable pane for a human to inspect later. In `--tmux-handoff`, completed panes/windows are not reused; each task keeps its scrollback plus per-task JSON result containing the session ID and final response. If there are more tasks than the cap, `--max-panes-per-session N` splits the work into auditable child sessions and writes a manifest.

```bash
./.juno_task/scripts/workflow_runner.sh --init-example production-triage-handoff .juno_task/workflows/prod_triage.yaml
./.juno_task/scripts/workflow_runner.sh --workflow .juno_task/workflows/prod_triage.yaml
# later
tmux attach -t pc-prod-triage-1
yy continue <session_id>
```

Inspect `{{ out_dir }}/parallel` (or the printed parallel runner artifact path) for `parallel_runner_status.json`, per-task `*.json`, `aggregation_*.json`, and `tmux_handoff_manifest.json` when capped splitting is used. These artifacts matter because aggregation avoids reconstructing work from scratch, manifests make multi-session handoff auditable, and tests protect the no-reuse contract so handoff panes are not accidentally overwritten before `yy continue <session_id>`.

### Workflow Runner
Use Workflow Runner when the work is not just one prompt, but a repeatable multi-step process: gather context, run one or more agents, validate output, summarize artifacts, and hand off the final session for follow-up. Workflows run from YAML or stdin with durable artifacts, so teams can turn ad-hoc operator playbooks into reviewed, repeatable automation instead of rebuilding context from terminal scrollback.

```bash
./.juno_task/scripts/workflow_runner.sh --init-example agent-chain .juno_task/workflows/agent_chain.yaml
./.juno_task/scripts/workflow_runner.sh --init-example production-triage-handoff .juno_task/workflows/prod_triage.yaml
./.juno_task/scripts/workflow_runner.sh --init-example parallel-kanban-review .juno_task/workflows/parallel_kanban_review.yaml
./.juno_task/scripts/workflow_runner.sh --workflow .juno_task/workflows/agent_chain.yaml --dry-run
./.juno_task/scripts/workflow_runner.sh --workflow .juno_task/workflows/agent_chain.yaml --tmux --no-print-step-stdout
cat workflow.yaml | ./.juno_task/scripts/workflow_runner.sh --workflow - --print-output summary
./.juno_task/scripts/workflow_runner.sh lint --workflow .juno_task/workflows/agent_chain.yaml
./.juno_task/scripts/workflow_runner.sh doctor .juno_task/specs/workflows/<workflow_id>/<run_id>
```

Use `production-triage-handoff` when production discovery should fan out into capped tmux handoff panes (`--tmux panes --tmux-handoff --max-panes-per-session 4`) with a fixed `{{ out_dir }}/parallel` artifact root. Use `parallel-kanban-review` when a planning agent creates kanban tasks, parallel workers write aggregation artifacts, and a master review reads the latest `aggregation_*.json`. Use raw command YAML mode in `parallel_runner.sh` when the fan-out items are complete commands or multiple workflow files that should run concurrently. These examples matter because aggregation artifacts preserve final agent responses, session IDs, commits, and statuses; later review/`yy continue` handoff should not reconstruct history from tmux scrollback.

By default, step failures are recorded in the manifest/report but do not make the process exit non-zero; set `fail_workflow: true` on a step when automation should fail fast. Workflow and parallel subprocesses inherit the canonical `JUNO_TASK_ROOT` plus an isolated session metadata destination. Durable run artifacts retain selected session IDs even though mutable history, branch, and runtime-marker files stay outside product worktrees. Add `--tmux` to create a dedicated detached observer session; it does **not** detach the producer, so the invoking command must remain alive. The runner prints the attach command and streams step stdout/stderr into `workflow.live.log` for that session even when `--no-print-step-stdout` keeps the invoking console quiet. The observer remains available after completion for review, and `manifest.json` records its session, live log, and attach command; use `--tmux-session NAME` for a stable custom name. Steps that invoke `juno-code`, `yy`, or `ypl` automatically capture session metadata for later `{{ steps.<id>.session_id }}` templates unless `capture_session: false` is set. For agent steps, use `{{ steps.<id>.response }}` as the final answer. The runner does not inject `--quiet`; it keeps successful stderr logs in artifacts instead of echoing them to the operator console, and detected agent commands that exit 0 with an empty response are marked failed. Use `workflow_runner.sh lint` before cron runs to catch noisy `stdout`/`stderr` templates, and `workflow_runner.sh doctor`/`dr` after runs to diagnose manifest/artifact response issues. At the end, detected agent step session ids are printed and the last session is persisted to the same continue-scope env file and main branch registry used by juno-code, so `yy cc` can continue the last workflow agent session. Set top-level `continue_from_step: <step-id-or-name>` when a workflow should hand off a specific agent step instead; explicit selection is strict and fails if that step does not produce a session id. The runner is backed by subprocess tests because cron workflows depend on real process boundaries for command rendering, failure continuation, artifacts, stdout controls, live observer visibility, response capture, session visibility, and continue handoff.

Cron owners should wrap a launch with `orchestration_guard.py --key <stable-name> -- <command>`. The guard requires the controller role, rejects a concurrent live owner, reclaims a stale marker, and never changes Git refs. A workflow singleton is **not** integration authority: research/report cron may produce reports and proposed tasks only. Automatic implementation follow-up requires an explicit reviewed policy, and advancing a target still requires the separate integration-owner lease and receipt described below.

For mutation or integration workflows, declare `frozen_inputs`, typed `receipts`, `requires_receipts`, and a `terminal_gate`. Receipt contracts can require dotted fields and bind semantic values with `expected_fields`. A receipt declaration is the path source of truth: prompts and commands use `{{ receipts.<id>.path }}` or the injected `JUNO_WORKFLOW_RECEIPT_<ID>` environment variable instead of repeating a literal path. IDs are lowercase and unambiguous after environment-key normalization. Lint detects identifiable hardcoded paths that contradict a declaration.

The first attempt writes `run_contract.json`, the single checkpoint and attempt index. A successful step becomes reusable only after stdout, stderr, response, optional capture, and every declared receipt are atomically persisted and hash-bound with command/run/attempt identity. If the producer is interrupted before terminal metadata, run `workflow_runner.sh recover-attempt RUN_DIR --dry-run`, then `recover-attempt RUN_DIR`; recovery refuses active, partial, non-contiguous, cross-run, or drifted evidence, appends an `interrupted` manifest, and never infers semantic completion. Resume exactly at its reported first invalid step. `workflow_runner.sh doctor`, workflow review packets, and `task_workflow_helper.py finalize-review` all use the same `workflow_run_evidence.py` resolver, preferring the newest hash-bound contract attempt while retaining root `manifest.json` only as the legacy fallback. Resuming the same output directory with `--from-step` verifies the unchanged workflow, variables, rendered commands, frozen inputs, producer digests, and receipt hashes before marking predecessors `reused_verified`. A harness-only correction instead uses a fresh output directory, `amendment_mode: harness_only_validation`, and `--amends-run PRIOR_RUN`. Add `--from-step STEP` to make that amendment selective: before dispatch, the runner hash-verifies the prior successful prefix, exact attempt/manifest lineage, completed command identity, frozen inputs/templates/variables, and receipt bytes/contracts. Only receipt-path relocation is allowed; missing, tampered, ambiguous, added, removed, reassigned, or weakened evidence fails closed. The printed execution plan and `manifest.json.amendment_plan` list revalidated/reused and executed steps; imported steps are recorded as `amendment_revalidated`. Omit `--from-step` when a full fresh amendment replay is intended. Never edit a historical run to make evidence reusable.

Prefer the lean mutation lifecycle: deterministic preflight, implementation agent, independent pre-merge semantic review, deterministic candidate preparation, candidate semantic review only when required by changed candidate identity, then receipt-gated integration and typed cleanup. Do not add separate agent guard steps that merely repeat deterministic receipt, diff, candidate, or CAS checks. Advanced contract YAML requires Python PyYAML; JSON workflows remain dependency-free and the runner fails explicitly instead of partially parsing unsupported YAML.

Use `workflow_assert.py` for named machine-readable diagnostics. Local integration uses three installed helpers: `worktree_lifecycle.py` creates/verifies exact-base named trees and performs typed safe cleanup; `integration_candidate.py target-preflight` read-only classifies the official target as exact, advanced descendant, invalid history, or missing without weakening the task worktree's exact approved base; `integration_candidate.py` then plans/builds direct or both-parent candidates and requires pre-merge plus candidate review receipts; `integration_owner_preflight.py integrate` locks each `(Git common directory, full target ref)` channel, performs exact expected-SHA CAS, validates/reviews the actual target, and creates the local annotated `juno-feature/<task>/<sha>` tag. Target movement requires candidate rebuild and re-review. Multi-repository updates are child-first and later failure is recorded as `partial_local_integration` without rewind.

A `local_integration` workflow sets `integration_policy.queue: automatic_after_review_pass`, `channel_scope: git_common_dir_and_target_ref`, and `target_movement: rebuild_and_rereview`. Its integration step uses an argv-list command that directly executes `integration_owner_preflight.py integrate` (optionally via `python3`), never a shell string or wrapper, so Workflow Runner grants nested-review evidence capability only to the owner process. Same-channel jobs serialize while disjoint channels proceed independently. Feature tags are local integration evidence; `vX.Y.Z`, push, publication, release, deployment, and post-deploy E2E each require separate authority.

Some historical local `vX.Y.Z` tags in the development repository do not match the package metadata at their tagged commits. They are retained as immutable history, not accepted as release truth and never rewritten by lifecycle automation. Every new package release must bind one version across `package.json`, the built CLI `--version`, and the newly created release tag before any publication; local feature automation uses only `juno-feature/...` and cannot create or repair release tags.

Controller checkpoints remain local orchestration durability only. They are not product inputs or integration gates. `controller_checkpoint.py plan --json` is read-only; configured commits remain bounded to explicit controller paths. Ordinary/workflow/parallel outer finalizers may checkpoint after terminal writes, but target integration never requires an unrelated controller checkout to become clean or idle.

### Full Traceability: Every Change Tracked
- Every task links to a git commit
- Jump to any point in development history
- High token efficiency—AI can search git history instead of re-reading everything

### Hooks Without Lock-in
Run scripts at any lifecycle point. Works with ANY backend, not just Claude:
```json
{
  "hooks": {
    "START_ITERATION": { "commands": ["./scripts/lint.sh"] },
    "END_ITERATION": { "commands": ["npm test"] }
  }
}
```

### Human-Readable Logs
`-v` gives you structured output instead of raw JSON dumps:
```bash
juno-code -b shell -s claude -i 5 -v
# Clean, readable progress instead of wall of JSON
```

### Quota Limit Handling
Auto-wait when you hit API rate limits instead of failing:
```bash
# Wait automatically when hitting hourly limits
juno-code -b shell -s claude -i 10 --on-hourly-limit wait

# Or exit immediately (default)
juno-code -b shell -s claude -i 10 --on-hourly-limit raise
```

## Quick Start

```bash
# Install
npm install -g juno-code

# Initialize project
juno-code init --task "Add user authentication..." --subagent claude

# Start execution - uses .juno_task/init.md (optimized Ralph prompt)
juno-code start -b shell -s claude -i 1 -v

# Or with a custom prompt
juno-code -b shell -s claude -i 5 -p 'Fix the login bug'

# Default Ralph based on kanban , without -p , juno-code uses .juno_task/prompt.md as prompt
juno-code -b shell -s claude -i 5 -v
```

**Key insight**: Running `juno-code start` without `-p` uses `.juno_task/prompt.md`—a production-ready prompt template that implements the Ralph method with guard rails.

### Shell safety for prompts

When prompt text contains shell metacharacters (especially backticks `` `...` `` or `$()`), prefer one of these patterns so your shell does not execute substitutions before juno-code receives the prompt:

```bash
juno-code -s claude -p 'literal text with `backticks` and $(dollar-parens)'
juno-code -s claude -f prompt.md
juno-code -s claude << 'EOF'
literal text with `backticks`
EOF
```

### Oversized prompt transport

`juno-code` protects shell-backend runs from OS `E2BIG` spawn failures by switching large prompts away from argv/env transport. The threshold is controlled by `JUNO_PROMPT_ARG_MAX_BYTES` (default `65536` bytes / 64 KiB). Prompts at or below the threshold may use normal argv/env paths; larger prompts are sent through managed prompt files or stdin so wrappers do not copy huge payloads into `JUNO_INSTRUCTION` or vendor CLI arguments.

You do not need to create temp files yourself. When file transport is required, juno-code manages prompt files under `/tmp/juno-code/` and cleans internal handoff files where safe. The tests assert argv/env/stdin/file behavior because this backing implementation is what prevents regressions where a safe CLI stdin/heredoc entry point later becomes a huge Python wrapper argv or environment variable.

### Prompt-time command substitution (per iteration)

`juno-code` also supports explicit prompt-time shell substitutions that run inside the working directory on **every engine iteration**:

- `!'command'`
- `!\`\`\`command\`\`\``

Examples:

```bash
juno-code claude -i 3 -p "Summarize git status: !'git status --short'"
juno-code claude -i 2 -p "Recent commits:\n!```git log -n 5 --oneline```"
```

This avoids relying on your shell’s one-time backtick expansion and keeps command output fresh across retries/iterations.

## CLI Reference

### Core Commands

```bash
# Initialize - sets up .juno_task/ directory structure
juno-code init --task "description" --subagent claude
juno-code init --interactive  # wizard mode

# Start execution (uses .juno_task/prompt.md by default)
juno-code start -b shell -s claude -i 5 -v
juno-code start -b shell -s codex -m :codex -i 10

# Direct prompt execution
juno-code -b shell -s claude -i 3 -p 'your prompt'

# Quick subagent shortcuts
juno-code claude 'your task'
juno-code codex 'your task'
juno-code gemini 'your task'
juno-code pi 'your task'

# Pi live interactive run (auto-exits on non-aborted completion)
juno-code pi --live -p '/skill:ralph-loop' -i 1

# Installed shortcuts
# yy is the short binary alias for juno-code.
# ypl is shorthand for yy pi --live and forwards all remaining args.
yy pi --live 'hello'
ypl 'hello'
ypl '/skill:ralph-loop' -i 1

# AI-powered test generation
juno-code test --generate --framework vitest
juno-code test --run

# View and parse log files
juno-code view-log .juno_task/logs/claude_shell_*.log --output json-only --limit 50
```

### Global Options

| Flag | Description |
|------|-------------|
| `-b, --backend <type>` | Backend: `shell` |
| `-s, --subagent <name>` | Service: `claude`, `codex`, `gemini`, `pi`, `cursor` |
| `-m, --model <name>` | Model (supports shorthands like `:opus`, `:haiku`) |
| `-i, --max-iterations <n>` | Iteration limit (-1 for unlimited) |
| `-p, --prompt <text>` | Prompt text (if omitted with `start`, uses prompt.md) |
| `-f, --prompt-file <path>` | Read prompt from a file instead of `-p` |
| `-v, --verbose` | Human-readable verbose output |
| `-r, --resume <id>` | Resume specific session |
| `--continue` | Continue most recent session |
| `--clone [prompt]` | Pi-only: fork a clone from `--resume <id>` or the current shell continue scope |
| `--live` | Pi-only: run Pi in interactive TUI mode with auto-exit on non-aborted completion |
| `--no-hooks`, `--no-hook` | Skip lifecycle hooks (equivalent spellings) |
| `--on-hourly-limit <action>` | Quota limit behavior: `wait` (auto-retry) or `raise` (exit) |
| `--force-update` | Force reinstall all scripts and services |
| `--til-completion` | Loop until all kanban tasks are done |
| `--pre-run-hook <name>` | Execute named hooks before loop |

### Session Management

```bash
juno-code session list                # View all sessions
juno-code session info abc123         # Session details
juno-code --resume abc123 -p 'continue'   # Resume session
juno-code --continue -p 'keep going'      # Continue most recent (backend-native)
juno-code continue 'next prompt'          # Reuse last session id + runtime settings snapshot
juno-code clone 'Explore approach A'      # Fork current shell continue-scope Pi session
juno-code clone --name C 'Explore C'      # Clone main into named branch C
juno-code clone --from C --name M 'Explore M'  # Clone branch C into branch M
juno-code branches                        # List this shell's named branches
juno-code switch C                        # Make C active for future continue runs
juno-code continue --clone 'Explore approach B'
juno-code --resume abc123 --clone 'Explore approach C'  # Fork explicit session id
juno-code pi --resume abc123 'Continue work'             # Resume explicit session id
```

Each `juno-code` run also appends execution history to `session_history.json` under the shared Git-common-dir Juno state root (unlimited, newest-first). `session_branches.json` and `continue_scope_runtime.json` use the same resolver, so linked worktrees cannot dirty tracked product paths or overwrite another repository's state. Non-Git directories use an identity-keyed user state directory. Set `JUNO_CODE_SESSION_METADATA_DIRECTORY` for an explicit location; existing project-local metadata is left untouched until the user explicitly adopts or migrates it.

Per-run entries include: initial prompt + timestamp, subagent/model/settings, total cost, turn/message counts, session IDs, and last-message timestamp.

CLI run summaries also surface these fields live in the terminal:
- `Statistics -> Total Cost`
- `Statistics -> Completed At`
- `Statistics -> Average Duration` (humanized unit: ms/s/m/h)
- `Session ID(s)` entries with per-session cost when available

For `juno-code continue`, automatic session routing, validated execution settings, and named branches live in one versioned `session_continuity.v2.json` document under Git-common session metadata. Each shell-scoped record includes its source, creation/last-use timestamps, pin state, active branch, and branch sessions. One TypeScript service validates, locks, re-reads, and atomically replaces this document; `.env.juno` remains user configuration and is not rewritten during normal continuity operation.

Legacy continuity cleanup is explicit and reversible:
```bash
juno-code continuity doctor --json
juno-code continuity clean                         # dry-run inventory only
juno-code continuity clean --plan /tmp/review.json # redacted reviewed plan; no state change
juno-code continuity clean --apply /tmp/review.json
juno-code continuity rollback <receipt-path>
juno-code continuity pin [SCOPE_0123456789ABCDEF]
juno-code continuity unpin [SCOPE_0123456789ABCDEF]
```
Apply rechecks default/custom env and metadata hashes under the shared lock, writes mode-600 backups and a value-free receipt, imports retained legacy state once, and removes only recognized continuity assignments. Unknown env bytes remain exact. Automatic retention runs under that same lock after successful continuation reads and state writes: unprotected implicit lookup metadata expires after 30 days, then only the 128 most recently used inactive scopes remain. Current, proven-live, explicitly pinned, and non-main named-branch scopes are protected. An explicit `JUNO_CODE_CONTINUE_SCOPE` selects identity but does not pin it; use `continuity pin` for owner protection. If protected records alone exceed the limit, Juno emits a value-free count warning and retains them. Rollback is hash-guarded and refuses concurrent changes; retention, cleanup, and rollback never inspect or delete Pi session files.

Expiration removes only automatic lookup metadata. A missing Pi session fails without deleting its continuity record or trying another scope, and the error directs the operator to an explicit `--resume <session-id>` or a new run. Deterministic clock/TTL/LRU/live/pin/named/concurrency/missing-session tests plus the persisted 2,500-scope structural regression matter because prose or cleanup commands cannot enforce the hard bound, prove lost-update safety, or prove that explicit recovery remains available without cross-scope routing.

Scope detection prefers terminal markers (for example `TMUX_PANE`, `WEZTERM_PANE`, `TERM_SESSION_ID`) and falls back to the parent shell PID. You can override scope resolution explicitly with `JUNO_CODE_CONTINUE_SCOPE=<name>`. `JUNO_CODE_SESSION_METADATA_DIRECTORY` still selects a custom metadata root.

Continuation is resolved in the parent before dispatch. Resolver, hook, prompt-substitution, Kanban, backend/service/provider, workflow, and parallel children preserve ordinary credentials/configuration plus controller routing, but do not inherit legacy or historical scoped session/settings keys. Resume and execution settings instead travel through typed execution requests. Concurrency, malformed-document, stale-lock, routing, and deterministic 2,500-pair boundary tests matter because only the locked backing service prevents lost updates, while routing tests prove no caller silently restores the retired env/branch stores.

Script endpoint for hash/status lookups:
```bash
juno-code continue-scope --json                    # current scope hash + status
juno-code continue-scope A1B2C3 --json             # lookup by short hash prefix (5-6 chars)
juno-code continue-scope --json --parent-pid 1234  # scope seen by a child of PID 1234
```

`continue-scope` returns `status` as one of: `running`, `finished`, `not_found`, `error`. Script runners use `--parent-pid` for caller/child handoff scopes; descriptor selection, hashing, and environment-key generation remain owned exclusively by TypeScript rather than being mirrored in runner code.

### Pi Session Cloning and Named Branches

Pi session cloning lets one root session branch into independent experiments without branches overwriting each other. `juno-code` uses Pi native `--fork`, so every clone receives a dedicated Pi session id that can be continued independently.

```bash
ypl 'init'
yy clone 'research auto-branch'   # auto-names b1, b2, ...
yy clone C 'research C'
yy clone D 'research D'
yy --resume <session-id> --clone '@@close_loop'  # fork an explicit session id (not named)
ypl --resume <session-id> '@@close_loop'         # resume an explicit session id live
yy cc 'continue main'
yy switch C
yy switch +                 # next branch, wraps at end
yy switch -                 # previous branch, wraps at start
yy cc 'continue C'
yy switch C 'continue C immediately'

# Equivalent long forms:
juno-code branches
juno-code switch C
juno-code switch C 'Continue C immediately'
juno-code clone 'Explore auto-branch'
juno-code clone C 'Explore C'
juno-code clone --name C 'Explore C'
juno-code clone --from C --name M 'Explore M'
```

Named branch behavior:
- `juno-code branches` shows named branches for the current shell/pane and marks the active branch.
- `juno-code switch C` makes `C` active for future `juno-code continue` / `yy cc` in that shell; `juno-code switch +` and `juno-code switch -` cycle to the next/previous listed branch with wraparound; `juno-code switch C 'prompt'` switches first and then runs the prompt immediately as a continue on `C`.
- `juno-code clone 'prompt'` auto-assigns the first available generated branch name (`b1`, `b2`, ...) when a branch registry exists for the current shell, clones from `main`, runs the prompt immediately, and does **not** switch the active branch.
- `juno-code clone C 'prompt'` is shorthand for `juno-code clone --name C 'prompt'`; both clone from `main` by default, run the prompt immediately in `C`, overwrite `C` if it exists, and do **not** switch the active branch.
- `juno-code clone --from C --name M ...` clones from branch `C` into branch `M`; `--name main` is rejected because `main` is reserved.
- Each shell/pane has its own active branch registry; normal use does not require manually naming scopes.
- If a new terminal tab reports `No named session branches found for this shell scope`, that tab has a different continue scope. Run `ypl 'init'` in that tab, run from the original tab, or set a shared `JUNO_CODE_CONTINUE_SCOPE=<name>` before starting runs that should share branch state.
- A new root/main run resets that shell's branches to only `main`; explicit `--resume <session-id> ...` without `--clone` also resets branches and makes `main` point at the resulting session.

Explicit session-id resume/clone behavior:
- `juno-code pi --resume <session-id> 'prompt'` or `ypl --resume <session-id> 'prompt'` resumes that exact Pi session. Because `ypl` expands to `yy pi --live`, do **not** run `ypl clone C ...`; `clone C` would be treated as prompt text.
- `juno-code --resume <session-id> --clone 'prompt'` forks the explicit session id as a non-named clone.
- `juno-code clone C --resume <session-id> 'prompt'` is not the named-branch syntax; named clones source from the branch registry (`main` by default, or `--from C`). Use `juno-code --resume <session-id> --clone 'prompt'` for an explicit session id, or initialize/register `main` first and then use `juno-code clone C 'prompt'`.
- `juno-code clone ...` and `juno-code continue --clone ...` fork the current shell session and then future `juno-code continue` in that shell follows the clone.

The backing command-routing and branch-registry tests are important because they protect the user flow: clone, switch, and continue must target the intended session id so users do not accidentally continue `main` when they meant branch `C`, pass `clone C` through `ypl` as prompt text, drop an inline `switch C 'prompt'` request after switching, lose an unnamed clone because no branch name was recorded, or expect clone to switch branches automatically.

### Feedback System

```bash
# While juno-code is running, provide feedback
juno-code feedback "found a bug in the auth flow"
juno-code feedback --interactive

# Or enable inline feedback
juno-code start -b shell -s claude --enable-feedback -i 10
```

### Skills Management

Skills are Markdown instruction files (with YAML frontmatter) installed into agent-specific directories so each coding agent reads them as context. juno-code auto-provisions skills on every CLI run.

```bash
# List installed skills
juno-code skills list

# Install/update skills
juno-code skills install
juno-code skills install --force

# Check skill status
juno-code skills status
```

**Skill groups by agent:**

| Agent | Directory | Skills |
|-------|-----------|--------|
| Claude | `.claude/skills/` | `kanban-workflow`, `ralph-loop`, `plan-kanban-tasks`, `understand-project` |
| Codex | `.agents/skills/` | `kanban-workflow`, `ralph-loop`, `plan-kanban-tasks`, `understand-project` |
| Pi | `.pi/skills/` | `kanban-workflow`, `ralph-loop`, `plan-kanban-tasks`, `understand-project` |

### Service Management

```bash
# View installed services
juno-code services list

# Check service status
juno-code services status

# Force reinstall (get latest)
juno-code services install --force
```

### Auth Management (Codex → Pi)

```bash
# Import default Codex auth into Pi auth store
juno-code auth import-codex

# Use explicit input/output paths (useful for account switching/backup files)
juno-code auth import-codex --input ~/.codex/auth.json --output ~/.pi/agent/auth.json
```

This command translates Codex CLI credentials to Pi's `auth.json` format (`type: "oauth"`) and writes/updates the `openai-codex` provider entry.

## Backends & Services

### Supported Services

| Service | Default Model | Shorthands |
|---------|---------------|------------|
| claude | `claude-sonnet-4-6` | `:haiku`, `:sonnet`, `:opus` |
| codex | `gpt-5.3-codex` | `:codex`, `:codex-mini`, `:gpt-5`, `:mini` |
| gemini | `gemini-2.5-pro` | `:pro`, `:flash`, `:pro-3`, `:flash-3` |
| pi | `anthropic/claude-sonnet-4-6` | `:pi`, `:sonnet`, `:opus`, `:luna`, `:sol`, `:gpt`, `:gpt5.5`, `:mini`, `:gpt-5`, `:codex`, `:api-codex`, `:codex-spark`, `:api-codex-spark`, `:gemini-pro` |

Pi's Codex-provider shortcuts include:

| Shortcut | Resolved Pi model |
|----------|-------------------|
| `:luna` | `openai-codex/gpt-5.6-luna` |
| `:sol` | `openai-codex/gpt-5.6-sol` |
| `:gpt` | `:sol` → `openai-codex/gpt-5.6-sol` |
| `:gpt5.5` | `openai-codex/gpt-5.5` |
| `:mini` | `openai-codex/gpt-5.6-terra` |

These aliases are subagent-specific: Pi's `:mini` selects Terra, while the Codex service keeps its existing `:mini` mapping.

> **Pi** is a multi-provider coding agent that supports Anthropic, OpenAI, Google, Groq, xAI, and more.
> It requires separate installation: `npm install -g @mariozechner/pi-coding-agent`

### Pi Live Mode (`--live`)

Use live mode when you want Pi's interactive TUI while keeping juno-code iteration hooks/statistics.

```bash
# Canonical live flow
juno-code pi --live -p '/skill:ralph-loop' -i 1

# If :pi default model is unavailable in your Pi provider setup, pick an explicit available model
juno-code pi --live -m :api-codex -p '/skill:ralph-loop' -i 1

# GPT-5.6 models support Pi's max thinking level
juno-code pi -m :gpt --thinking max -p 'Analyze and implement this task' -i 1
```

Notes:
- Pi accepts `--thinking off|minimal|low|medium|high|xhigh|max`; use `max` for GPT-5.6 models when maximum supported reasoning effort is desired. `PI_THINKING=max` provides the equivalent environment default.
- `--live` is validated as **Pi-only** (`juno-code pi ...`).
- `--live` requires extensions enabled (`--no-extensions` is incompatible).
- Live auto-exit is triggered on non-aborted `agent_end` only. Pressing `Esc` to interrupt the current run keeps Pi open so you can continue interacting.
- To manually leave Pi and return control to juno-code hooks/loop, use Pi's normal exit keys (for example `Ctrl+C` twice quickly or `Ctrl+D` on an empty editor).
- Best experience is an interactive terminal (TTY) so Pi TUI can manage screen state cleanly.
- Pi TUI depends on the Node runtime used to launch Pi; use a modern Node version (Node 20+) in PATH.

### Custom Backends

Service scripts live in `~/.juno_code/services/`. Each is a Python script that accepts standard args (`-p/--prompt`, `-m/--model`, `-v/--verbose`) and outputs JSON events to stdout.

## Hook System

Hooks allow user-defined shell commands at execution lifecycle points. Configure in `.juno_task/config.json`:

| Hook | When | Example Use |
|------|------|-------------|
| `START_RUN` | Before all iterations | Environment setup |
| `START_ITERATION` | Each iteration start | File size monitoring, linting |
| `END_ITERATION` | Each iteration end | Test execution |
| `END_RUN` | After all iterations | Cleanup, reports |
| `ON_STALE` | Stale iteration detected | Alert, auto-create task |

**Default hooks** (set up by `juno-code init`):
- `START_ITERATION`: CLAUDE.md / AGENTS.md file size checks, feedback cleanup
- `ON_STALE`: Creates a kanban warning task when no progress detected

Example config:
```json
{
  "hooks": {
    "START_ITERATION": {
      "commands": [
        "test ! -f CLAUDE.md || [ $(wc -c < CLAUDE.md) -lt 40000 ] || echo 'WARNING: CLAUDE.md exceeds 40KB'",
        "./.juno_task/scripts/cleanup_feedback.sh"
      ]
    },
    "END_ITERATION": {
      "commands": ["npm test"]
    }
  }
}
```

## Autonomous Execution

Use these runners as the core automation layer around `juno-code`:

| Need | Use |
|------|-----|
| One AI loop over project/kanban context | `juno-code start` or `juno-code -p ...` |
| Keep looping until kanban is done | `run_until_completion.sh` |
| Many independent kanban tasks | `parallel_runner.sh --kanban ...` or `--kanban-filter ...` |
| Many complete shell commands or workflow files | `parallel_runner.sh --commands-file ...` |
| Ordered multi-step operator/team process | `workflow_runner.sh --workflow ...` |
| Human inspection after parallel work | `parallel_runner.sh --tmux-handoff ...` |
| Continue the final workflow agent session | workflow handoff + `yy cc` |

The runner tests exercise real subprocess boundaries because this is where production failures usually hide: command rendering, stdout/stderr handling, artifact capture, session IDs, and continue handoff all need to work outside an in-process unit-test harness.

### run_until_completion.sh

Continuously runs juno-code until all kanban tasks are completed. Uses a do-while loop: juno-code runs at least once, then continues while tasks remain in backlog, todo, or in_progress status.

```bash
# Run until all tasks complete
./.juno_task/scripts/run_until_completion.sh -s claude -i 5 -v

# With custom backend and model
./.juno_task/scripts/run_until_completion.sh -b shell -s codex -m :codex -i 10
```

#### Stale Detection

Tracks kanban state between iterations. After 3 consecutive iterations with no task changes (configurable), executes `ON_STALE` hook and exits.

```bash
# Custom stale threshold
./.juno_task/scripts/run_until_completion.sh -s claude -i 5 --stale-threshold 5

# Disable stale checking
./.juno_task/scripts/run_until_completion.sh -s claude -i 5 --no-stale-check
```

#### Pre-run Commands & Hooks

Execute commands or named hooks before the main loop:

```bash
# Single pre-run command
./.juno_task/scripts/run_until_completion.sh --pre-run "./scripts/lint.sh" -s claude -i 5

# Named hooks from config.json
./.juno_task/scripts/run_until_completion.sh --pre-run-hook SLACK_SYNC -s claude -i 5

# Multiple pre-run commands (executed in order)
./.juno_task/scripts/run_until_completion.sh \
  --pre-run "./scripts/sync.sh" \
  --pre-run "npm run build" \
  -s claude -i 5 -v
```

**Execution order** when both hooks and commands are specified:
1. Hooks from `JUNO_PRE_RUN_HOOK` env var
2. Hooks from `--pre-run-hook` flags (in order)
3. Commands from `JUNO_PRE_RUN` env var
4. Commands from `--pre-run` flags (in order)
5. Main juno-code loop begins

### Parallel Runner

Orchestrate N concurrent juno-code processes with queue management, structured output, and optional tmux visualization.

#### Input Modes

| Input | Description |
|-------|-------------|
| `--kanban T1,T2,T3` | Kanban task IDs |
| `--kanban-filter '--tag X --status Y'` | Query kanban, auto-extract IDs |
| `--kanban-filter 'ready'` | Dependency-aware: only unblocked tasks |
| `--items "a,b,c"` | Generic item list |
| `--items-file data.csv` | File input (JSONL, CSV, TSV, XLSX) |
| `--commands-file workflows.yaml` | Raw command YAML mode: fan out complete commands or workflow files |

#### Execution Modes

| Mode | Flag | Description |
|------|------|-------------|
| Headless | (default) | ThreadPoolExecutor, output to log files |
| Tmux Windows | `--tmux` | Each worker = tmux window |
| Tmux Panes | `--tmux panes` | Workers as split panes |

```bash
# Headless parallel execution
./.juno_task/scripts/parallel_runner.sh --kanban T1,T2,T3 --parallel 3

# Tmux visualization with 5 workers (interactive attach)
./.juno_task/scripts/parallel_runner.sh --tmux --kanban T1,T2,T3 --parallel 5

# Explicit background launch for nohup, CI, cron, or a non-TTY remote shell
./.juno_task/scripts/parallel_runner.sh --tmux tabs --no-attach --kanban T1,T2,T3
# The runner exits after launch and prints concrete attach, tail/follow, wait, and stop commands.

# Process file with extraction
./.juno_task/scripts/parallel_runner.sh --items-file data.csv --prompt-file crawl.md --strict

# Generate, lint, then run raw command/workflow batches
./.juno_task/scripts/parallel_runner.sh --init-commands-example .juno_task/commands/workflows.yaml
./.juno_task/scripts/parallel_runner.sh --lint-commands-file .juno_task/commands/workflows.yaml
./.juno_task/scripts/parallel_runner.sh --commands-file .juno_task/commands/workflows.yaml --parallel 3

# Use different AI backend
./.juno_task/scripts/parallel_runner.sh -s codex -m :codex --kanban T1,T2

# Session control
./.juno_task/scripts/parallel_runner.sh --stop --name my-batch
./.juno_task/scripts/parallel_runner.sh --stop-all
```

#### Raw command YAML mode

Use raw command YAML mode when each parallel item is already a complete command, such as several `workflow_runner.sh --workflow ...` invocations. This composes with Workflow Runner: `workflow_runner.sh` owns ordered steps and per-run artifacts, while `parallel_runner.sh --commands-file` owns concurrent fan-out, queueing, and aggregate status.

```bash
./.juno_task/scripts/parallel_runner.sh --init-commands-example .juno_task/commands/workflows.yaml
./.juno_task/scripts/parallel_runner.sh --lint-commands-file .juno_task/commands/workflows.yaml
./.juno_task/scripts/parallel_runner.sh --commands-file .juno_task/commands/workflows.yaml --parallel 3
```

The command file supports schema `v1`; command entries may be shell command strings or argv lists. Run the lint command before unattended batches so YAML/schema mistakes fail before expensive agents launch. The implementation is backed by command-file parser and runner tests because command-string-vs-argv behavior, schema validation, and aggregation artifacts are the safety net for repeatable team automation.

#### Dedicated Example: SEO landing-page batch in tmux panes

Use this pattern when you want to generate many related content tasks in parallel while keeping live visibility per worker pane:

```bash
./.juno_task/scripts/parallel_runner.sh \
  -s pi \
  -m zai/glm-5 \
  --kanban-filter "--tag SEO_LANDING_PAGES --limit 200 --status backlog,in_progress,todo" \
  --parallel 5 \
  --tmux panes \
  --prompt-file ./tmp_prompt/content_gen.md
```

What each flag does:

- `-s pi -m zai/glm-5`: run workers with Pi on a specific model.
- `--kanban-filter "..."`: dynamically pull task IDs from kanban (here: only `SEO_LANDING_PAGES`, up to 200, only open statuses).
- `--parallel 5`: execute up to 5 tasks concurrently.
- `--tmux panes`: split workers into panes for side-by-side monitoring.
- `--prompt-file ./tmp_prompt/content_gen.md`: keep a reusable, versioned instruction template instead of long inline prompts.

Tip: keep the filter string quoted so it is passed as one argument to `parallel_runner.sh` and then correctly forwarded to `kanban.sh`.

#### Output & Extraction

- **Per-task JSON**: `{output_dir}/{task_id}.json` with exit code, wall time, extracted response
- **Aggregation JSON**: All tasks merged into one file
- **Code block extraction**: Finds last fenced code block in output. `--strict` fails the task if not found
- **Pause/resume**: `touch .juno_task/scripts/logs/.pause_{name}` / remove to resume

## Slack Integration

juno-code includes built-in Slack integration for team collaboration. The system monitors Slack channels and creates kanban tasks from messages, then posts agent responses as threaded replies.

### How It Works

1. **Fetch**: `slack_fetch.sh` monitors a Slack channel and creates kanban tasks from new messages
2. **Process**: The AI agent processes tasks and records responses in the kanban
3. **Respond**: `slack_respond.sh` sends agent responses back to Slack as threaded replies

### Setup

1. **Create a Slack App**:
   - Go to https://api.slack.com/apps and create a new app
   - Under "OAuth & Permissions", add these scopes:
     - `channels:history`, `channels:read` (public channels)
     - `groups:history`, `groups:read` (private channels)
     - `users:read` (user info)
     - `chat:write` (send messages)
   - Install the app to your workspace
   - Copy the "Bot User OAuth Token" (starts with `xoxb-`)

2. **Configure Environment**:
   ```bash
   # In project root .env file
   SLACK_BOT_TOKEN=xoxb-your-token-here
   SLACK_CHANNEL=bug-reports
   ```

3. **Usage**:
   ```bash
   # Fetch messages from Slack and create tasks
   ./.juno_task/scripts/slack_fetch.sh --channel bug-reports

   # Continuous monitoring mode
   ./.juno_task/scripts/slack_fetch.sh --channel feature-requests --continuous

   # Send completed task responses back to Slack
   ./.juno_task/scripts/slack_respond.sh --tag slack-input

   # Dry run to preview what would be sent
   ./.juno_task/scripts/slack_respond.sh --dry-run --verbose
   ```

### Automated Slack Workflow with Hooks

```bash
# Fetch Slack messages before starting work
./.juno_task/scripts/run_until_completion.sh \
  --pre-run "./.juno_task/scripts/slack_fetch.sh --channel bug-reports" \
  -s claude -i 5 -v
```

Or configure hooks in `.juno_task/config.json`:

```json
{
  "hooks": {
    "SLACK_SYNC": {
      "commands": [
        "./.juno_task/scripts/slack_fetch.sh --channel bug-reports",
        "./.juno_task/scripts/slack_respond.sh --tag slack-input"
      ]
    }
  }
}
```

Then run with the hook:

```bash
./.juno_task/scripts/run_until_completion.sh --pre-run-hook SLACK_SYNC -s claude -i 5 -v
```

## GitHub Integration

juno-code includes built-in GitHub integration for issue tracking and automated responses. The system monitors GitHub repositories, creates kanban tasks from issues, and posts agent responses as threaded comments with automatic issue closure.

### How It Works

1. **Fetch**: `github.py fetch` monitors a GitHub repository and creates kanban tasks from new issues
2. **Process**: The AI agent processes tasks and records responses in the kanban
3. **Respond**: `github.py respond` posts agent responses as comments on GitHub issues and closes them

### Setup

1. **Create a GitHub Personal Access Token**:
   - Go to https://github.com/settings/tokens and create a new token (classic)
   - Grant these permissions:
     - `repo` (full control of private repositories)
     - `public_repo` (access to public repositories)
   - Copy the token (starts with `ghp_`)

2. **Configure Environment**:
   ```bash
   # In project root .env file
   GITHUB_TOKEN=ghp_your_token_here
   GITHUB_REPO=owner/repo  # Optional default repository
   GITHUB_LABELS=bug,priority  # Optional label filter
   ```

3. **Usage**:
   ```bash
   # Fetch issues from GitHub and create tasks
   ./.juno_task/scripts/github.py fetch --repo owner/repo

   # Filter by labels
   ./.juno_task/scripts/github.py fetch --repo owner/repo --labels bug,priority

   # Post completed task responses back to GitHub
   ./.juno_task/scripts/github.py respond --tag github-issue

   # Bidirectional sync (fetch + respond)
   ./.juno_task/scripts/github.py sync --repo owner/repo

   # Continuous sync mode with interval
   ./.juno_task/scripts/github.py sync --repo owner/repo --continuous --interval 600

   # Dry run to preview what would be posted
   ./.juno_task/scripts/github.py respond --dry-run --verbose
   ```

### Automated GitHub Workflow with Hooks

```bash
./.juno_task/scripts/run_until_completion.sh --pre-run-hook GITHUB_SYNC -s claude -i 5 -v
```

## Log Scanner

Proactive error detection that scans log files and auto-creates kanban bug reports:

```bash
# Scan for errors and create tasks
./.juno_task/scripts/log_scanner.sh

# Dry run (report only)
./.juno_task/scripts/log_scanner.sh --dry-run --verbose

# Check scan status
./.juno_task/scripts/log_scanner.sh --status

# Reset scan state (re-scan everything)
./.juno_task/scripts/log_scanner.sh --reset
```

Detects Python errors (Traceback, ValueError, TypeError), Node.js errors (UnhandledPromiseRejection, ECONNREFUSED), and general patterns (FATAL, CRITICAL, PANIC, OOM). Uses ripgrep for high-performance scanning with grep fallback.

Use as a pre-run hook so the agent finds and fixes errors automatically:
```json
{
  "hooks": {
    "START_ITERATION": {
      "commands": ["./.juno_task/scripts/log_scanner.sh"]
    }
  }
}
```

## Kanban Commands

The kanban.sh script wraps juno-kanban. Here are the actual commands:

```bash
# Task CRUD
./.juno_task/scripts/kanban.sh create "Task body" --tags feature,backend
./.juno_task/scripts/kanban.sh get TASK_ID
./.juno_task/scripts/kanban.sh update TASK_ID --response "Fixed it" --commit abc123
./.juno_task/scripts/kanban.sh mark done --id TASK_ID --response "Completed, tests pass"
./.juno_task/scripts/kanban.sh archive TASK_ID

# List & search
./.juno_task/scripts/kanban.sh list --limit 5 --status backlog todo in_progress
./.juno_task/scripts/kanban.sh search --tag backend --status todo

# Dependencies
./.juno_task/scripts/kanban.sh create "Deploy" --blocked-by A1b2C3,X4y5Z6
./.juno_task/scripts/kanban.sh deps TASK_ID                    # Show blockers & dependents
./.juno_task/scripts/kanban.sh deps add --id T1 --blocked-by T2  # Add dependency
./.juno_task/scripts/kanban.sh deps remove --id T1 --blocked-by T2
./.juno_task/scripts/kanban.sh ready                           # Tasks with no unmet blockers
./.juno_task/scripts/kanban.sh order --scores                  # Topological execution order

# Merge (monorepo support)
./.juno_task/scripts/kanban.sh merge source/ --into target/ --strategy keep-newer
```

**Task schema**: `{id, status, body, commit_hash, agent_response, created_date, last_modified, feature_tags[], related_tasks[], blocked_by[]}`

**Status lifecycle**: `backlog → todo → in_progress → done → archive`

**Body markup** (auto-parsed on create):
- `[task_id]ID1, ID2[/task_id]` → `related_tasks`
- `[blocked_by]ID1, ID2[/blocked_by]` → `blocked_by` (synonyms: `block_by`, `block`, `parent_task`)

## Configuration

### Hierarchy (highest to lowest priority)

1. CLI arguments
2. Environment variables (`JUNO_CODE_*`)
3. Project config (`.juno_task/config.json`)
4. Global config files
5. Hardcoded defaults

### Per-subagent default models

Set model defaults per subagent without changing your global default:

```bash
juno-code pi set-default-model :api-codex
juno-code claude set-default-model :opus
juno-code codex set-default-model :gpt-5
```

This writes to `.juno_task/config.json`:

```json
{
  "defaultModels": {
    "pi": ":api-codex",
    "claude": ":opus",
    "codex": ":gpt-5"
  }
}
```

`juno-code` resolves models in this order: CLI `--model` → configured subagent default (`defaultModels` / legacy `defaultModel`) → built-in default.

### Prompt Macros config (`@@key`)

Define prompt macro dictionaries in `.juno_task/config.json` using `promptMacros`:

```json
{
  "promptMacros": {
    "enabled": true,
    "order": "before_command_substitution",
    "maxDepth": 10,
    "global": {
      "git": "commit your changes",
      "spec": { "path": "prompts/spec.md" }
    },
    "local": {
      "ship": "run tests then @@git",
      "inline": { "text": "run !'npm test' before @@git" }
    }
  }
}
```

Notes:
- `local` overrides `global` on key collisions.
- `maxDepth` defaults to `10` and must be a positive integer.
- `order` supports `before_command_substitution` (default) or `after_command_substitution`.
- Dictionary values can be strings or objects with exactly one non-empty `path` or `text` field.
- `path` loads UTF-8 text/markdown from an absolute path or a path relative to the project working directory where `juno-code` is executed.
- Loaded/inline macro text still flows through normal `@@key` macro expansion and `!'cmd'` prompt command substitution according to `order`.

#### Managed V2 lifecycle macros

Fresh `juno-code init` installs portable, file-backed lifecycle prompts and guidance. Existing projects install or refresh the same assets with:

```bash
yy scripts update
# Destructive replacement is explicit and backed up:
yy scripts update --force
```

The public mappings are `@@clean_worktree`, `@@new_task_workflow`, `@@run_workflow`, `@@migrate_juno_code_v1_to_v2`, and `@@migrate_juno_kanban_v1_to_v2`. Their files live under `.juno_task/prompts/`; lifecycle guidance lives under `.juno_task/wiki/`.

Safe updates are checksum-based through `.juno_task/managed-assets.json`. Missing and unchanged managed files update automatically. Locally customized or migration-specialized files are preserved, while the package candidate is written under `.juno_task/managed-conflicts/<version>/`. `--force` first writes a timestamped backup. Existing local macro overrides remain authoritative.

Architecture migration must render exact repository targets rather than guessing a conventional branch:

```bash
yy prompts specialize-clean-worktree --policy-file /absolute/reviewed-policy.json --cwd /absolute/project
```

The renderer validates one root and every changed nested repository, writes exact targets into `clean_worktree.md`, and records a hash receipt. Local reviewed integration never implies push, publication, deployment, production mutation, or post-deploy E2E authority.

Why tests and backing implementation matter: prose alone cannot prove npm packaging, detect whether a file still matches its managed base, preserve a specialized integration target, or reject an incomplete nested-repository policy. Build/pack parity, clean-install macro expansion, update-conflict, and nonstandard-target fixtures exercise those runtime boundaries.

### Project Env Bootstrap (`.env.juno`)

`juno-code` now bootstraps a project env file automatically:

- On `juno-code init`: creates an empty `.env.juno` in project root
- On any `juno-code` run: ensures `.env.juno` exists (creates if missing)
- Loads env values before execution so hooks and subagent processes receive them
- Supports custom env file path via `.juno_task/config.json`

Example config:

```json
{
  "envFilePath": ".env.local",
  "envFileCopied": true
}
```

Notes:
- `envFilePath`: env file to load (relative to project root or absolute path)
- `envFileCopied`: tracks one-time initialization from `.env.juno` to custom env path
- Load order: `.env.juno` first, then `envFilePath` (custom file overrides defaults)

### Project Structure

After `juno-code init`:

```
your-project/
├── .env.juno            # Project env file auto-created and loaded on startup
├── .juno_task/
│   ├── init.md           # Task breakdown (your input)
│   ├── prompt.md         # AI instructions (Ralph-style prompt)
│   ├── plan.md           # Progress tracking
│   ├── USER_FEEDBACK.md  # Issue tracking (write here while agent runs)
│   ├── config.json       # Hooks, agent config, project settings
│   ├── scripts/          # Auto-installed utilities
│   │   ├── kanban.sh
│   │   ├── run_until_completion.sh
│   │   ├── parallel_runner.sh
│   │   ├── log_scanner.sh
│   │   ├── install_requirements.sh
│   │   ├── slack_fetch.sh / slack_fetch.py
│   │   ├── slack_respond.sh / slack_respond.py
│   │   ├── github.py
│   │   └── hooks/session_counter.sh
│   ├── tasks/            # Kanban tasks (NDJSON)
│   └── logs/             # Agent session logs
├── .claude/skills/       # Claude agent skills (auto-provisioned)
├── .agents/skills/       # Codex agent skills (auto-provisioned)
├── CLAUDE.md             # Session learnings
└── AGENTS.md             # Agent performance
```

## Environment Variables

```bash
# Primary
export JUNO_CODE_BACKEND=shell
export JUNO_CODE_SUBAGENT=claude
export JUNO_CODE_MODEL=:sonnet
export JUNO_CODE_MAX_ITERATIONS=10

# Service-specific
export CODEX_HIDE_STREAM_TYPES="turn_diff,token_count"
export GEMINI_API_KEY=your-key

# Execution control
export JUNO_STALE_THRESHOLD=3            # Stale iteration limit
export JUNO_PRE_RUN="./scripts/sync.sh"  # Pre-run command
export JUNO_PRE_RUN_HOOK="SLACK_SYNC"    # Pre-run hook name
export JUNO_RUN_UNTIL_MAX_ITERATIONS=0   # Max iterations (0=unlimited)
export JUNO_SESSION_COUNTER_THRESHOLD=100 # Session length warning threshold

# Integration
export SLACK_BOT_TOKEN=xoxb-your-token
export SLACK_CHANNEL=bug-reports
export GITHUB_TOKEN=ghp_your-token
export GITHUB_REPO=owner/repo

# Debug
export JUNO_DEBUG=true                   # Enable [DEBUG] output
export JUNO_VERBOSE=true                 # Enable [INFO] output

# Pi requires the pi-coding-agent CLI installed globally
# npm install -g @mariozechner/pi-coding-agent
```

## Examples

### The Ralph Workflow (Modernized)

```bash
# Initialize
juno-code init --task "Migrate JavaScript to TypeScript"

# Run until done (not forever)
./.juno_task/scripts/run_until_completion.sh -s claude -i 20 -v

# Check progress anytime
./.juno_task/scripts/kanban.sh list --status in_progress done
```

### Bug Investigation

```bash
# Try with Claude opus
juno-code -b shell -s claude -m :opus -p "Investigate CI failures" -i 3

# Stuck? Try Codex perspective
juno-code -b shell -s codex -p "Same investigation" -i 3

# Or use Pi with any provider's model
juno-code -b shell -s pi -m :sonnet -p "Same investigation" -i 3
```

### Parallel Batch Processing

```bash
# Process 100 kanban tasks with 5 workers
./.juno_task/scripts/parallel_runner.sh --kanban T1,T2,...,T100 --parallel 5

# Visual monitoring
./.juno_task/scripts/parallel_runner.sh --tmux --kanban T1,T2,T3 --parallel 3

# Process a CSV dataset
./.juno_task/scripts/parallel_runner.sh --items-file data.csv --prompt-file process.md --strict --file-format csv
```

### Dependency-Aware Workflow

```bash
# Create tasks with dependencies
./.juno_task/scripts/kanban.sh create "Setup database" --tags infra
./.juno_task/scripts/kanban.sh create "Build API [blocked_by]DBID[/blocked_by]" --tags backend
./.juno_task/scripts/kanban.sh create "Build UI [blocked_by]APIID[/blocked_by]" --tags frontend

# See what's ready to work on
./.juno_task/scripts/kanban.sh ready

# Execution order respecting dependencies
./.juno_task/scripts/kanban.sh order --scores

# Run only unblocked tasks in parallel
./.juno_task/scripts/parallel_runner.sh --kanban-filter 'ready' --parallel 3
```

### Slack-Driven Development

```bash
# Full automated loop: Slack → Agent → Slack
./.juno_task/scripts/run_until_completion.sh \
  --pre-run-hook SLACK_SYNC \
  -s claude -i 5 -v
```

## Comparison: Ralph vs juno-code

| Feature | Ralph | juno-code |
|---------|-------|-----------|
| **Design Focus** | One-time tasks (migrations, rewrites) | Iterative development (scales to 1000s of tasks) |
| **Core Loop** | `while :; do claude; done` | Controlled iterations |
| **Stopping** | Ctrl+C (guesswork) | `-i N` or "until tasks done" |
| **Source of Truth** | Markdown files (TASKS.md, PLANNING.md) | Structured kanban over bash |
| **Format Integrity** | Relies on LLM instruction-following | Strict NDJSON, always parseable |
| **Multiple AIs** | Claude only | Claude, Codex, Gemini, Pi, Cursor |
| **Dependencies** | None | blocked_by, ready, topological sort |
| **Parallelism** | None | parallel_runner with N workers |
| **Traceability** | None | Every task → git commit |
| **Integrations** | None | Slack, GitHub Issues |
| **Hooks** | Claude-specific | Works with any backend |
| **Error Detection** | None | Log scanner with auto bug reports |
| **Verbose** | Raw JSON | Human-readable + jq-friendly |
| **Feedback** | None | Real-time during execution |

## Troubleshooting

### Service scripts not updating
```bash
juno-code services install --force
```

### Model passthrough issues
```bash
# Verify with verbose
juno-code -v -b shell -s codex -m :codex -p "test"
# Check stderr for: "Executing: python3 ~/.juno_code/services/codex.py ... -m gpt-5.3-codex"
```

### Kanban not finding tasks
```bash
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress
```

### Skills not appearing
```bash
juno-code skills list
juno-code skills install --force
```

### Python environment issues
```bash
# Force reinstall Python dependencies
./.juno_task/scripts/install_requirements.sh --force-update
```

## Build from Source

```bash
cd juno-code

# Build
npm run build

# Build as exp-juno-code (local testing)
npm run build:exp

# Remove exp-juno-code
npm run uninstall:exp

# Run tests
npm test              # Fast tests
npm run test:full     # Full suite
npm run test:coverage # With coverage

# Lint & format
npm run lint
npm run format:check
npm run typecheck
```

## Credits

juno-code is inspired by [Geoffrey Huntley's Ralph Method](https://ghuntley.com/ralph/)—the insight that AI delivers production software through iterative refinement. juno-code adds the structure that makes Ralph sustainable for real development work.

---

## Get Started Now

```bash
# Install globally
npm install -g juno-code

# Initialize in your project
cd your-project
juno-code init --task "Your task description" --subagent claude

# Start coding with AI
juno-code start -b shell -s claude -i 5 -v
```

**Links:**
- [npm package](https://www.npmjs.com/package/juno-code)
- [GitHub repository](https://github.com/askbudi/juno-code)
- [Report issues](https://github.com/askbudi/juno-code/issues)

## License

MIT
