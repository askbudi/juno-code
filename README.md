# juno-code

![Ralph Wiggum - The Simpsons](https://ghuntley.com/content/images/size/w1200/2025/06/3ea367ed-cae3-454a-840f-134531dea1fd.jpg)

> *"I'm in danger!"* - Ralph Wiggum, every time you Ctrl+C a working AI loop too early

## The Ralph Method: Where It All Started

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
| **Overcooking** | Loop runs too long, AI adds features nobody asked for | You get bloated code and wasted tokens |
| **Undercooking** | You Ctrl+C too early, work is incomplete | Features half-done, bugs half-fixed |
| **No memory** | Each iteration starts fresh | AI forgets what it just did |
| **Vendor lock-in** | Ralph was built for Claude Code | Can't easily switch to Codex, Gemini, or others |
| **No traceability** | Changes blend together | Hard to debug, impossible to time-travel |

## juno-code: Ralph, But Better

juno-code takes the Ralph insight—*AI works better in loops*—and adds the structure needed for real work:

### Iteration Control: No More Overcooking
```bash
# Exactly 5 iterations - cooked perfectly
juno-code start -b shell -s claude -i 5

# Until kanban tasks complete - cooked exactly right
./.juno_task/scripts/run_until_completion.sh -s claude -i 10 -v

# Unlimited (like Ralph) - when you really want that
juno-code start -b shell -s claude -i -1
```

### Task Tracking: Remember What Matters
Built-in kanban via [juno-kanban](https://pypi.org/project/juno-kanban/). Each task gets a git commit, so you can time-travel:
```bash
# See what's in progress
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress

# Each completed task links to a commit
./.juno_task/scripts/kanban.sh get TASK_ID
```

### Backend Choice: Use Any AI
Switch between Claude, Codex, Gemini, or Cursor with one flag:
```bash
# Stuck on a bug? Try different models
juno-code -b shell -s claude -m :opus -p "fix the auth bug"
juno-code -b shell -s codex -m :codex -p "fix the auth bug"
juno-code -b shell -s gemini -m :flash -p "fix the auth bug"
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
juno-code init --task "Add user authentication" --subagent claude

# Start execution - uses .juno_task/prompt.md (optimized Ralph prompt)
juno-code start -b shell -s claude -i 5 -v

# Or with a custom prompt
juno-code -b shell -s claude -i 5 -p "Fix the login bug"
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
| codex | `codex-5.2-max` | `:codex`, `:gpt-5`, `:mini` |
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
| **Core Loop** | `while :; do claude; done` | Controlled iterations |
| **Stopping** | Ctrl+C (guesswork) | `-i N` or "until tasks done" |
| **Task Memory** | None | Kanban with git commits |
| **Multiple AIs** | Claude only | Claude, Codex, Gemini, Cursor |
| **Traceability** | None | Every task → git commit |
| **Hooks** | Claude-specific | Works with any backend |
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
# Check stderr for: "Executing: python3 ~/.juno_code/services/codex.py ... -m codex-5.2-codex-max"
```

### Kanban not finding tasks
```bash
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress
```

## Credits

juno-code is inspired by [Geoffrey Huntley's Ralph Method](https://ghuntley.com/ralph/)—the insight that AI delivers production software through iterative refinement. juno-code adds the structure that makes Ralph sustainable for real development work.

## License

MIT
