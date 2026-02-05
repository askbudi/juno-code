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

```bash
npm install -g juno-code
```

After installation, initialize your project:

```bash
juno-code init --task "Your task description" --subagent claude
```

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
| **Vendor lock-in** | Ralph was built for Claude Code | Can't easily switch to Codex, Gemini, or others |
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
Built-in kanban via [juno-kanban](https://pypi.org/project/juno-kanban/). Unlike Ralph's markdown files, kanban uses **NDJSON** - a strict format that can't be corrupted by LLM formatting errors:
```bash
# Query tasks programmatically - always parseable
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress

# Each task is isolated and linked to a git commit
./.juno_task/scripts/kanban.sh get TASK_ID

# Scale to thousands of tasks without context bloat
./.juno_task/scripts/kanban.sh list --limit 5  # Shows only what matters
```

### Backend Choice: Use Any AI
Switch between Claude, Codex, Gemini, or Cursor with one flag:
```bash
# Stuck on a bug? Try different models
juno-code -b shell -s claude -m :opus-i 1 -v
juno-code -b shell -s codex -m :codex -i 1 -v
juno-code -b shell -s gemini -m :flash -i 1 -v
```

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

## Quick Start

```bash
# Install
npm install -g juno-code

# Initialize project
juno-code init --task "Add user authentication..." --subagent claude

# Start execution - uses .juno_task/int.md (optimized Ralph prompt)
juno-code start -b shell -s claude -i 1 -v

# Or with a custom prompt
juno-code -b shell -s claude -i 5 -p "Fix the login bug"

# Default Ralph based on kanban , without -p , juno-code uses .juno_task/prompt.md as prompt
juno-code -b shell -s claude -i 5 -v
```

**Key insight**: Running `juno-code start` without `-p` uses `.juno_task/prompt.md`—a production-ready prompt template that implements the Ralph method with guard rails.

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
juno-code -b shell -s claude -i 3 -p "your prompt"

# Quick subagent shortcuts
juno-code claude "your task"
juno-code codex "your task"
juno-code gemini "your task"
```

### Global Options

| Flag | Description |
|------|-------------|
| `-b, --backend <type>` | Backend: `mcp`, `shell` |
| `-s, --subagent <name>` | Service: `claude`, `codex`, `gemini`, `cursor` |
| `-m, --model <name>` | Model (supports shorthands like `:opus`, `:haiku`) |
| `-i, --max-iterations <n>` | Iteration limit (-1 for unlimited) |
| `-p, --prompt <text>` | Prompt text (if omitted with `start`, uses prompt.md) |
| `-v, --verbose` | Human-readable verbose output |
| `-r, --resume <id>` | Resume specific session |
| `--continue` | Continue most recent session |

### Session Management

```bash
juno-code session list           # View all sessions
juno-code session info abc123    # Session details
juno-code --resume abc123 -p "continue"  # Resume session
juno-code --continue -p "keep going"     # Continue most recent
```

### Feedback System

```bash
# While juno-code is running, provide feedback
juno-code feedback "found a bug in the auth flow"
juno-code feedback --interactive

# Or enable inline feedback
juno-code start -b shell -s claude --enable-feedback -i 10
```

## Slack Integration

juno-code includes built-in Slack integration for team collaboration. The system monitors Slack channels and creates kanban tasks from messages, then posts agent responses as threaded replies.

### How It Works

1. **Fetch**: `slack_fetch.sh` monitors a Slack channel and creates kanban tasks from new messages
2. **Process**: The AI agent processes tasks and records responses in the kanban
3. **Respond**: `slack_respond.sh` sends agent responses back to Slack as threaded replies

This enables a workflow where team members can submit tasks via Slack and receive AI-generated responses without leaving their chat interface.

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

Use the `--pre-run` flag to sync with Slack before each juno-code run:

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

This enables a workflow where team members can submit tasks via GitHub issues and receive AI-generated responses with automatic issue closure.

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

   # One-time sync
   ./.juno_task/scripts/github.py sync --repo owner/repo --once

   # Dry run to preview what would be posted
   ./.juno_task/scripts/github.py respond --dry-run --verbose
   ```

### Key Features

- **Tag-based identification**: Uses `github_issue_owner_repo_123` format for O(1) lookups
- **State tracking**: Maintains state in `.juno_task/github/state.ndjson` and `responses.ndjson`
- **Automatic closure**: Issues are automatically closed after posting the agent response
- **Commit linking**: Includes commit hash in comment if available
- **Response format**: Posts `agent_response` field from completed kanban tasks

### Automated GitHub Workflow with Hooks

Use the `--pre-run` flag to sync with GitHub before each juno-code run:

```bash
# Fetch GitHub issues before starting work
./.juno_task/scripts/run_until_completion.sh \
  --pre-run "./.juno_task/scripts/github.py fetch --repo owner/repo" \
  -s claude -i 5 -v
```

Or configure hooks in `.juno_task/config.json`:

```json
{
  "hooks": {
    "GITHUB_SYNC": {
      "commands": [
        "./.juno_task/scripts/github.py fetch --repo owner/repo --labels bug",
        "./.juno_task/scripts/github.py respond --tag github-issue"
      ]
    }
  }
}
```

Then run with the hook:

```bash
./.juno_task/scripts/run_until_completion.sh --pre-run-hook GITHUB_SYNC -s claude -i 5 -v
```

## run_until_completion.sh

The `run_until_completion.sh` script continuously runs juno-code until all kanban tasks are completed. It uses a do-while loop pattern: juno-code runs at least once, then continues while tasks remain in backlog, todo, or in_progress status.

### Basic Usage

```bash
# Run until all tasks complete
./.juno_task/scripts/run_until_completion.sh -s claude -i 5 -v

# With custom backend and model
./.juno_task/scripts/run_until_completion.sh -b shell -s codex -m :codex -i 10
```

### Pre-run Commands (--pre-run)

Execute commands before the main loop starts. Useful for syncing with external services, running linters, or preparing the environment.

```bash
# Single pre-run command
./.juno_task/scripts/run_until_completion.sh --pre-run "./scripts/lint.sh" -s claude -i 5

# Multiple pre-run commands (executed in order)
./.juno_task/scripts/run_until_completion.sh \
  --pre-run "./scripts/sync.sh" \
  --pre-run "npm run build" \
  -s claude -i 5 -v

# Alternative: use environment variable
JUNO_PRE_RUN="./scripts/prepare.sh" \
  ./.juno_task/scripts/run_until_completion.sh -s claude -i 5
```

### Pre-run Hooks (--pre-run-hook)

Execute named hooks defined in `.juno_task/config.json`. Hooks group multiple commands that run together.

**Define hooks in config.json:**
```json
{
  "hooks": {
    "START_ITERATION": {
      "commands": [
        "./scripts/lint.sh",
        "npm run typecheck"
      ]
    },
    "SLACK_SYNC": {
      "commands": [
        "./.juno_task/scripts/slack_fetch.sh --channel bugs",
        "./.juno_task/scripts/slack_respond.sh"
      ]
    }
  }
}
```

**Use hooks:**
```bash
# Single hook
./.juno_task/scripts/run_until_completion.sh --pre-run-hook START_ITERATION -s claude -i 5

# Multiple hooks (executed in order)
./.juno_task/scripts/run_until_completion.sh \
  --pre-run-hook SLACK_SYNC \
  --pre-run-hook START_ITERATION \
  -s claude -i 5

# Alternative: use environment variable
JUNO_PRE_RUN_HOOK="START_ITERATION" \
  ./.juno_task/scripts/run_until_completion.sh -s claude -i 5
```

### Execution Order

When both hooks and pre-run commands are specified, the execution order is:
1. Hooks from `JUNO_PRE_RUN_HOOK` env var
2. Hooks from `--pre-run-hook` flags (in order)
3. Commands from `JUNO_PRE_RUN` env var
4. Commands from `--pre-run` flags (in order)
5. Main juno-code loop begins

### Environment Variables

| Variable | Description |
|----------|-------------|
| `JUNO_DEBUG=true` | Show debug diagnostic messages |
| `JUNO_VERBOSE=true` | Show informational status messages |
| `JUNO_PRE_RUN` | Pre-run command (runs before --pre-run flags) |
| `JUNO_PRE_RUN_HOOK` | Pre-run hook name (runs before --pre-run-hook flags) |
| `JUNO_RUN_UNTIL_MAX_ITERATIONS` | Maximum iterations (0 = unlimited) |

## Kanban Commands

The kanban.sh script wraps juno-kanban. Here are the actual commands:

```bash
# List tasks
./.juno_task/scripts/kanban.sh list --limit 5
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress

# Get task details
./.juno_task/scripts/kanban.sh get TASK_ID

# Mark task status (backlog, todo, in_progress, done)
./.juno_task/scripts/kanban.sh mark in_progress --ID TASK_ID
./.juno_task/scripts/kanban.sh mark done --ID TASK_ID --response "Fixed auth, added tests"

# Update task with git commit reference
./.juno_task/scripts/kanban.sh update TASK_ID --commit abc123
```

## Backends & Services

### Available Backends

- **shell** - Direct execution via service scripts (recommended for headless)
- **mcp** - Model Context Protocol servers (full tool integration)

### Supported Services

| Service | Default Model | Shorthands |
|---------|---------------|------------|
| claude | `claude-sonnet-4-5-20250929` | `:haiku`, `:sonnet`, `:opus` |
| codex | `gpt-5.3-codex` | `:codex`, `:gpt-5`, `:mini` |
| gemini | `gemini-2.5-pro` | `:pro`, `:flash`, `:pro-3`, `:flash-3` |

### Custom Backends

Service scripts live in `~/.juno_code/services/`. Each is a Python script:

```bash
# View installed services
juno-code services list

# Force reinstall (get latest)
juno-code services install --force
```

To add a custom backend:
1. Create a Python script in `~/.juno_code/services/`
2. Accept standard args: `-p/--prompt`, `-m/--model`, `-v/--verbose`
3. Output JSON events to stdout for structured parsing

## Project Structure

After `juno-code init`:

```
your-project/
├── .juno_task/
│   ├── init.md           # Task breakdown (your input)
│   ├── prompt.md         # AI instructions (Ralph-style prompt)
│   ├── plan.md           # Progress tracking
│   ├── USER_FEEDBACK.md  # Issue tracking
│   ├── config.json       # Configuration
│   ├── scripts/          # Auto-installed utilities
│   │   ├── run_until_completion.sh
│   │   ├── kanban.sh
│   │   └── install_requirements.sh
│   └── tasks/            # Kanban tasks (ndjson)
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
export CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE=4
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
```

### Iterative Feature Development

```bash
# Tasks are tracked via kanban
# (Tasks created by agent or imported)

# Run until all tasks complete
./.juno_task/scripts/run_until_completion.sh -s claude -i 10 -v

# Each completed task has a git commit for traceability
git log --oneline
```

## Comparison: Ralph vs juno-code

| Feature | Ralph | juno-code |
|---------|-------|-----------|
| **Design Focus** | One-time tasks (migrations, rewrites) | Iterative development (scales to 1000s of tasks) |
| **Core Loop** | `while :; do claude; done` | Controlled iterations |
| **Stopping** | Ctrl+C (guesswork) | `-i N` or "until tasks done" |
| **Source of Truth** | Markdown files (TASKS.md, PLANNING.md) | Structured kanban over bash |
| **Format Integrity** | Relies on LLM instruction-following | Strict format, always parseable |
| **Multiple AIs** | Claude only | Claude, Codex, Gemini, Cursor |
| **Traceability** | None | Every task → git commit |
| **Hooks** | Claude-specific | Works with any backend |
| **Verbose** | Raw JSON | Human-readable + jq-friendly |
| **Feedback** | None | Real-time during execution |

### Why Structured Kanban Over Markdown?

Ralph uses markdown files (TASKS.md, PLANNING.md) as its source of truth. This works for **one-time tasks** like "migrate the whole repo from TypeScript to Rust."

But for **iterative development**, markdown files break down:

- **No strict format**: LLMs can corrupt the structure, add extra formatting, forget sections
- **Context bloat**: Long plan.md files confuse agents and waste tokens
- **No query capability**: Can't ask "what's in progress?" without parsing prose
- **No task isolation**: Changes to one task can accidentally affect others

juno-code uses **structured kanban over bash**:

```bash
# Always parseable - the format can never break
./.juno_task/scripts/kanban.sh list --status in_progress

# Query specific tasks
./.juno_task/scripts/kanban.sh get TASK_ID

# Tasks stored as NDJSON - one line per task
# Each task is self-contained and isolated
```

This lets juno-code scale Ralph's insight (AI works better in loops) to **thousands of tasks** without the agent losing track or corrupting state.

## Troubleshooting

### Service scripts not updating
```bash
juno-code services install --force
```

### Model passthrough issues
```bash
# Verify with verbose
juno-code -v -b shell -s codex -m :codex -p "test"
# Check stderr for: "Executing: python3 ~/.juno_code/services/codex.py ... -m codex-5.2-codex-max"
```

### Kanban not finding tasks
```bash
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress
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
