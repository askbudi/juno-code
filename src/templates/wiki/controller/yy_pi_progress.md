# Watching managed progress

Use the first-class watch surface for commands that may outlive one ordinary
shell tool call. It owns the child process group, bounded combined log, private
run directory, terminal metadata, and the strict `juno.watch-footer.v1` footer.
Do not assemble a producer with heredocs and do not use `sleep; tail` polling.

## Decision rule

```text
new command you own       -> yy watch exec -- COMMAND...
already detached watch run -> yy watch status RUN_ID / yy watch await RUN_ID
coherent task checkpoint   -> yy task checkpoint TASK_ID; yy evidence run TASK_ID
waiting for task evidence  -> yy evidence await TASK_ID
external one-shot blocker  -> await_blocker.py --then ...
```

These commands grant no implementation, review, release, push, deployment, or
production authority. They only execute an already-authorized argv.

## Foreground command

```bash
yy watch exec --timeout 900 -- npm test -- src/cli/__tests__/main.test.ts
```

Foreground mode returns the command's canonical exit code and prints the
terminal `juno.watch-run.v1` record. Combined output is retained in the run's
private log rather than mixed with the machine record.

## Detached command

```bash
start=$(yy watch exec --detach --timeout 900 -- npm test)
run_id=$(printf '%s\n' "$start" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')
yy watch status "$run_id"
yy watch await "$run_id"
```

`status` is read-only. `await` observes the bound producer and returns its exit
code. Timeout or interruption sends TERM and then bounded KILL only to the owned
process group. Unrelated process groups are never cleanup targets.

## Task validation evidence

A task is the unit of intent and may contain several commits. A commit is not
automatically a validation request.

```text
WIP commit                  -> no automatic validation
coherent committed tip      -> yy task checkpoint TASK_ID
run selected local evidence -> yy evidence run TASK_ID
read/await evidence         -> yy evidence status|await TASK_ID
final clean tip             -> yy task finish TASK_ID
```

Checkpoint planning selects registered focused validation and binds task, base,
tip, tree, changed paths, command, dependency locks, controller policy, runtime,
and local runner class. Unknown or mixed ownership falls back conservatively.
A later tip reuses a command only when its complete input closure remains exact.
`yy task finish` creates the final checkpoint, reuses valid receipts, runs only
missing commands, and binds the receipts into the review-ready closure. The
merge queue re-verifies those receipts before expensive admission.

## Terminal files

Runs live under the canonical controller's private
`.juno_task/runtime/watch-runs/RUN_ID/` directory:

```text
run.json       juno.watch-run.v1 state and process identity
pid            owned child/process-group ID
combined.log   bounded observation source
footer         strict atomic terminal footer
```

The footer remains exact ASCII:

```text
schema_version=juno.watch-footer.v1
exit_code=0
completed_utc=2026-08-12T21:09:28Z
```

A valid footer is terminal producer truth; it does not convert a nonzero command
into success. Empty, partial, reordered, duplicate, unknown-field, invalid-time,
and out-of-range bytes fail closed. `run.json` additionally records timeout and
signal truth. Run directories and standing-evidence receipts are private runtime
state; deletion is a separate cleanup action.

## Legacy attachment

`watch_progress.py --pid-file ... --log-file ... --footer-file ...` remains the
strict observer for a pre-existing producer. It never signals that producer.
New producers should use `yy watch exec` so PID publication, logging, footer
publication, timeout handling, and descendant settlement are not hand-written.
