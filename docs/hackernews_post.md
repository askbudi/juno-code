# Show HN: juno-code - Ralph Method for AI coding, but with guard rails

I've been using Geoffrey Huntley's "Ralph Method" (https://ghuntley.com/ralph/) for AI-assisted development. The core idea is brilliant: run your AI coding assistant in a loop and let it iterate until the job is done.

```bash
while :; do
  claude
done
```

One engineer reportedly delivered a $50,000 project for $297 using this technique. I've had similar success with migrations and rewrites.

But Ralph has problems when you move beyond one-off tasks:

**1. Overcooking**: The loop runs forever. Leave it too long and the AI starts adding features nobody asked for, refactoring code that was fine, writing documentation for the sake of it.

**2. Undercooking**: Ctrl+C too early and you're left with half-done features.

**3. Fragile state**: Ralph uses markdown files (TASKS.md, PLANNING.md) as source of truth. LLMs can corrupt these - add extra formatting, forget sections, change structure.

**4. No memory between sessions**: Each run starts fresh. The AI can't see what was done yesterday.

**5. Vendor lock-in**: Ralph was built for Claude Code. Switching to Codex or Gemini means rewriting your workflow.

So I built juno-code to fix these problems.

## What juno-code does differently

**Iteration control**: Instead of `while :; do`, you get `-i 5` for exactly 5 iterations, or `run_until_completion.sh` that stops when kanban tasks are done.

**Structured task tracking**: Instead of markdown, tasks are stored in NDJSON files via juno-kanban. The format can't be corrupted by LLM formatting errors. You can query tasks programmatically:

```bash
./.juno_task/scripts/kanban.sh list --status in_progress
```

**Backend agnostic**: Switch between Claude, Codex, Gemini, or Cursor with one flag:

```bash
juno-code -b shell -s claude -m :opus -i 5 -v
juno-code -b shell -s codex -m :codex -i 5 -v
juno-code -b shell -s gemini -m :flash -i 5 -v
```

Stuck on a bug? Try a different model's perspective with one word change.

**Full traceability**: Every completed task links to a git commit. Time travel through development history. The AI can search git history instead of re-reading everything.

**Hooks without lock-in**: Run tests, linters, or any script at lifecycle points. Works with any backend:

```json
{
  "hooks": {
    "START_ITERATION": { "commands": ["./scripts/lint.sh"] },
    "END_ITERATION": { "commands": ["npm test"] }
  }
}
```

**Real-time feedback**: Send feedback to the running AI without stopping it:

```bash
juno-code feedback "found a bug in the auth flow"
```

## Quick start

```bash
npm install -g juno-code

cd your-project
juno-code init --task "Migrate from JavaScript to TypeScript" --subagent claude

# Run until kanban tasks are complete
./.juno_task/scripts/run_until_completion.sh -s claude -i 10 -v
```

## The key insight

Ralph proved that AI works better in loops. juno-code adds the structure that makes loops sustainable:

- Controlled cooking time (not infinite)
- Strict task format (not corruptible markdown)
- Any AI backend (not vendor locked)
- Full audit trail (not blended changes)

GitHub: https://github.com/askbudi/juno-code
npm: https://www.npmjs.com/package/juno-code

Built with TypeScript. MIT licensed. Feedback welcome.
