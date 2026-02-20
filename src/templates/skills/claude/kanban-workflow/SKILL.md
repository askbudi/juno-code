---
name: kanban-workflow
description: Comprehensive guide for using juno-kanban task management. Covers all commands (create, list, search, get, mark, update, archive, deps, ready, order, merge), dependency management, best practices, and workflow patterns. Use when you need to interact with the kanban board.
argument-hint: [command or workflow question]
---

## Kanban CLI Reference

All commands use `./.juno_task/scripts/kanban.sh` (wrapper around juno-kanban Python CLI).

### Core Commands

**CREATE** — Add a new task
```bash
./.juno_task/scripts/kanban.sh create "Task description here" --status backlog --tags feature,backend
```
Options: `--status` (backlog|todo|in_progress|done), `--tags` (comma/space-separated), `--blocked-by` (task IDs), `--related-tasks` (task IDs)

**LIST** — Browse tasks with summary stats
```bash
./.juno_task/scripts/kanban.sh list --limit 5 --sort asc
./.juno_task/scripts/kanban.sh list --status todo --sort asc
./.juno_task/scripts/kanban.sh list --status todo,in_progress --limit 10
```

**SEARCH** — Find tasks by criteria
```bash
./.juno_task/scripts/kanban.sh search --status todo --tag backend --limit 10
./.juno_task/scripts/kanban.sh search --body "OAuth" --open
./.juno_task/scripts/kanban.sh search --commit abc123
```
Filters: `--status`, `--tag`, `--body`, `--response`, `--commit`, `--open` (no agent_response), `--recent`, `--exclude` (exclude tags)

**GET** — Full task details (including dependency info and related task details)
```bash
./.juno_task/scripts/kanban.sh get TASK_ID
```

**MARK** — Update status with required response message
```bash
./.juno_task/scripts/kanban.sh mark in_progress --id TASK_ID --response "Starting work on this"
./.juno_task/scripts/kanban.sh mark done --id TASK_ID --response "Completed: implemented X, tested Y" --commit abc123def
./.juno_task/scripts/kanban.sh mark todo --id TASK_ID --response "Reopening: found regression"
```
Required: `--id` and `--response`. Optional: `--commit` (recommended for done).

**UPDATE** — Modify task fields
```bash
./.juno_task/scripts/kanban.sh update TASK_ID --status todo --tags backend,urgent
./.juno_task/scripts/kanban.sh update TASK_ID --commit abc123def
./.juno_task/scripts/kanban.sh update TASK_ID --response "Additional context"
```

**ARCHIVE** — Soft delete (preserves data, sets status to archive)
```bash
./.juno_task/scripts/kanban.sh archive TASK_ID
```

### Dependency Management

**DEPS** — View, add, or remove task dependencies
```bash
# View dependency info (blockers, dependents, priority score)
./.juno_task/scripts/kanban.sh deps TASK_ID

# Add blockers (TASK_ID cannot start until BLOCKER1 and BLOCKER2 are done)
./.juno_task/scripts/kanban.sh deps add --id TASK_ID --blocked-by BLOCKER1 BLOCKER2

# Remove a blocker
./.juno_task/scripts/kanban.sh deps remove --id TASK_ID --blocked-by BLOCKER1
```
Cycle detection prevents circular dependencies automatically.

**READY** — Tasks with all blockers satisfied (safe to work on)
```bash
./.juno_task/scripts/kanban.sh ready
./.juno_task/scripts/kanban.sh ready --tag backend --limit 5
```
Returns tasks where status is backlog/todo/in_progress AND all `blocked_by` tasks are done/archive.

**ORDER** — Topological sort of open tasks respecting dependencies
```bash
./.juno_task/scripts/kanban.sh order
./.juno_task/scripts/kanban.sh order --scores
```
Use for determining safe parallel execution order.

### Body Markup for Inline Dependencies

Declare dependencies and relations directly in task body text:

```
[blocked_by]TASK_ID[/blocked_by]          — This task is blocked by TASK_ID
[blocked_by]ID1, ID2[/blocked_by]         — Blocked by multiple tasks
[task_id]RELATED_ID[/task_id]             — Reference a related task
[task_id]ID1 ID2[/task_id]                — Multiple related tasks
```

These are parsed automatically when the task is created/updated.

### Merge (Multi-Directory Consolidation)

When tasks get scattered across subdirectories:
```bash
# Auto-discover and merge all .juno_task dirs
./.juno_task/scripts/kanban.sh merge --find-all --into ./.juno_task --dry-run

# Merge specific sources
./.juno_task/scripts/kanban.sh merge ./sub1/.juno_task ./sub2/.juno_task --into ./.juno_task
```
Strategy: `--strategy keep-newer` (default) or `--strategy keep-both`.

### Output Formats

All commands support: `-f json`, `-f ndjson` (default), `-f xml`, `-f table`
Add `--raw` for compact output. Add `-p` for pretty print.

### Best Practices

1. **Task sizing**: Create tasks small enough to complete in one iteration without filling the context window
2. **Status flow**: backlog → todo → in_progress → done (or archive for abandoned tasks)
3. **Always include `--response`** when using `mark` — document what you did and how you tested it
4. **Attach commits**: Use `--commit HASH` when marking done, then `update TASK_ID --commit HASH` to link the git history
5. **Use `ready`** before starting work to find unblocked tasks
6. **Use `order --scores`** to plan parallel execution pipelines
7. **Use `[blocked_by]` markup** in task body when creating tasks that depend on others
8. **Use `[task_id]` markup** in task body to cross-reference related tasks
9. **Use `get TASK_ID`** to see full task details including resolved dependency and related task info
10. **One task in_progress at a time** — finish or re-queue before starting the next

### Environment Variables

- `JUNO_TASK_ROOT` — Pin kanban operations to a specific project root directory
- `JUNO_DEBUG=true` — Show diagnostic messages
- `JUNO_VERBOSE=true` — Show informational messages
- `JUNO_KANBAN_LIST_BODY_TRUNCATE_CHARS=N` — Override list body truncation (default: 1200)

$ARGUMENTS
