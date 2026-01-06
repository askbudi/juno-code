# juno-code

**AI-powered iterative development CLI** - Inspired by the [Ralph Method](https://ghuntley.com/ralph/)

juno-code brings structure and control to AI-driven development. Instead of endless loops or single-shot prompts, it combines task tracking, backend flexibility, and iteration control for production-ready AI workflows.

## Why juno-code?

The [Ralph Method](https://ghuntley.com/ralph/) showed that AI can deliver production software through iterative refinement - one engineer reportedly delivered a $50,000 project for $297. But Ralph runs forever until Ctrl+C. juno-code adds:

- **Iteration control**: Run exactly N iterations with `-i`, not forever
- **Task tracking**: Built-in kanban system via [juno-kanban](https://github.com/askbudi/juno-kanban) - run until tasks complete, not until you get tired
- **Backend choice**: Switch between Claude, Codex, Gemini, or Cursor with one flag
- **Full traceability**: Every task has a git commit, making time-travel debugging trivial
- **Hooks system**: Run scripts at any lifecycle point without vendor lock-in
- **Human-readable logs**: `-v` gives you structured, jq-friendly output instead of raw JSON dumps

## Installation

```bash
npm install -g juno-code
```

## Quick Start

```bash
# Initialize in any project
juno-code init --task "Add user authentication" --subagent claude

# Run with iteration limit
juno-code -b shell -s claude -i 5 -v

# Or run until all kanban tasks complete
./.juno_task/scripts/run_until_completion.sh -s claude -i 10 -v
```

## Core Concepts

### Task-Driven Development

juno-code initializes a `.juno_task/` directory with:
- **init.md** - Your task breakdown and constraints
- **prompt.md** - Production-ready AI instructions
- **plan.md** - Dynamic tracking as work progresses
- **USER_FEEDBACK.md** - Issue tracking and user input
- **config.json** - Backend, model, and hook configuration
- **scripts/** - Auto-installed utilities (kanban.sh, run_until_completion.sh)

### Kanban Integration

Unlike Ralph's infinite loop, juno-code integrates with juno-kanban for task management:

```bash
# List tasks
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress

# Run until all tasks complete
./.juno_task/scripts/run_until_completion.sh -s claude -i 5 -v
```

Each task gets a git commit, so you can:
- See exactly what changed per task
- Jump between commits to understand context
- Efficiently search history with high token efficiency

### Iteration Control

No more overcooking (Ralph runs too long, adds features nobody asked for) or undercooking (stopping too early):

```bash
# Exactly 5 iterations
juno-code -b shell -s claude -i 5

# Unlimited (like Ralph)
juno-code -b shell -s claude -i -1

# Until kanban tasks complete
./.juno_task/scripts/run_until_completion.sh -s claude
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

```bash
# Try different models with one flag
juno-code -b shell -s claude -m :opus -p "complex task"
juno-code -b shell -s codex -m :codex -p "same task"
juno-code -b shell -s gemini -m :flash -p "same task"
```

### Custom Backends

Service scripts live in `~/.juno_code/services/`. Each is a Python script that wraps the underlying CLI:

```bash
# View installed services
juno-code services list

# Force reinstall (get latest versions)
juno-code services install --force
```

To add a custom backend:
1. Create a Python script in `~/.juno_code/services/`
2. Accept standard args: `-p/--prompt`, `-m/--model`, `-v/--verbose`
3. Output JSON events to stdout for structured parsing

## CLI Reference

### Main Commands

```bash
# Initialize project
juno-code init --task "description" --subagent claude

# Start execution (uses .juno_task/init.md)
juno-code start -b shell -s claude -i 5

# Direct execution with prompt
juno-code -p "your prompt" -b shell -s claude -i 3

# Quick subagent shortcuts
juno-code claude "your task"
juno-code codex "your task"
juno-code gemini "your task"

# Feedback during execution
juno-code feedback "found a bug in X"
juno-code feedback --interactive

# Session management
juno-code session list
juno-code --resume <sessionId> -p "continue work"
juno-code --continue -p "continue most recent"
```

### Global Options

| Flag | Description |
|------|-------------|
| `-b, --backend <type>` | Backend: `mcp`, `shell` |
| `-s, --subagent <name>` | Service: `claude`, `codex`, `gemini`, `cursor` |
| `-m, --model <name>` | Model (supports shorthands like `:opus`) |
| `-i, --max-iterations <n>` | Iteration limit (-1 for unlimited) |
| `-p, --prompt <text>` | Prompt text |
| `-v, --verbose` | Human-readable verbose output |
| `-r, --resume <id>` | Resume specific session |
| `--continue` | Continue most recent session |
| `--tools <list>` | Available tools |
| `--allowed-tools <list>` | Permission-based tool filter |
| `--disallowed-tools <list>` | Block specific tools |
| `--append-allowed-tools <list>` | Add to default tools |

### Environment Variables

```bash
# Primary configuration
export JUNO_CODE_BACKEND=shell
export JUNO_CODE_SUBAGENT=claude
export JUNO_CODE_MODEL=:sonnet
export JUNO_CODE_MAX_ITERATIONS=10

# Service-specific
export CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE=4  # -1 to disable
export CODEX_HIDE_STREAM_TYPES="turn_diff,token_count"
export GEMINI_API_KEY=your-key
```

## Hooks System

Run scripts at any point in the execution lifecycle:

```json
// .juno_task/config.json
{
  "hooks": {
    "START_RUN": { "commands": ["echo 'Starting run'"] },
    "START_ITERATION": { "commands": ["./scripts/pre-check.sh"] },
    "END_ITERATION": { "commands": ["./scripts/post-check.sh"] },
    "END_RUN": { "commands": ["./scripts/cleanup.sh"] }
  }
}
```

Unlike Claude Code's built-in hooks, juno-code hooks work with any backend - no vendor lock-in.

## Real-Time Feedback

Provide feedback to the AI while it's running:

```bash
# Command-line
juno-code feedback "please also add tests for edge cases"

# Interactive form
juno-code feedback --interactive

# Enable concurrent feedback collection
juno-code -b shell -s claude --enable-feedback -i 10
```

Feedback is stored in `.juno_task/USER_FEEDBACK.md` and automatically picked up by the agent.

## Project Structure

After `juno-code init`:

```
your-project/
├── .juno_task/
│   ├── init.md           # Task breakdown
│   ├── prompt.md         # AI instructions
│   ├── plan.md           # Progress tracking
│   ├── USER_FEEDBACK.md  # Issue tracking
│   ├── config.json       # Configuration
│   ├── mcp.json          # MCP config
│   ├── scripts/          # Auto-installed utilities
│   │   ├── run_until_completion.sh
│   │   ├── kanban.sh
│   │   └── install_requirements.sh
│   ├── specs/            # Specifications
│   │   ├── requirements.md
│   │   └── architecture.md
│   └── tasks/            # Kanban tasks (ndjson)
├── CLAUDE.md             # Session learnings
└── AGENTS.md             # Agent performance
```

## Examples

### Migration Project

```bash
# Initialize for large migration
juno-code init --task "Migrate from JavaScript to TypeScript" --subagent claude

# Run in batches
./.juno_task/scripts/run_until_completion.sh -s claude -i 20 -v

# Switch to a different model if stuck
juno-code -b shell -s codex -m :codex -p "Continue the migration"
```

### Bug Investigation

```bash
# Quick investigation with opus
juno-code -b shell -s claude -m :opus -p "Investigate why tests fail in CI" -i 3

# If it's a model-specific issue, try another
juno-code -b shell -s gemini -m :pro -p "Same investigation" -i 3
```

### Iterative Feature Development

```bash
# Add tasks to kanban
./.juno_task/scripts/kanban.sh add "Implement user login"
./.juno_task/scripts/kanban.sh add "Add password reset"
./.juno_task/scripts/kanban.sh add "Write integration tests"

# Run until done
./.juno_task/scripts/run_until_completion.sh -s claude -i 10 -v
```

## Comparison with Ralph

| Feature | Ralph | juno-code |
|---------|-------|-----------|
| Iteration Control | `while :; do` (infinite) | `-i N` (exact control) |
| Task Tracking | None | Built-in kanban |
| Git Integration | Manual | Auto-commit per task |
| Multiple Backends | Single tool | Claude, Codex, Gemini, Cursor |
| Hooks | Tool-specific | Backend-agnostic |
| Feedback | None | Real-time during execution |
| Verbose Mode | Raw JSON | Human-readable + jq-friendly |

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
# Check kanban directly
./.juno_task/scripts/kanban.sh list --status backlog todo in_progress
```

## Credits

juno-code is inspired by [Geoffrey Huntley's Ralph Method](https://ghuntley.com/ralph/) - the insight that AI can deliver production software through iterative refinement. juno-code adds the structure needed for sustainable, controlled AI-driven development.

## License

MIT
