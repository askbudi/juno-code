# Watching managed progress

Use `.juno_task/scripts/watch_progress.py` for an arbitrary already-running
producer that owns three distinct files: a numeric PID file, a combined log, and
an atomically published terminal footer. The watcher observes only; interruption
stops the watcher and never signals the producer.

## Safe producer and watcher

This example binds Node 22.22.3, gives the command a five-minute bound, captures
combined output, atomically publishes the PID, and writes the footer immediately
when the wrapped command exits. Replace the sample command only within the
existing lifecycle/release authority.

```bash
set -eu
source "$HOME/.nvm/nvm.sh"
nvm use 22.22.3
run_id="TASK_ID-$(date -u +%Y%m%dT%H%M%SZ)"
log="/tmp/${run_id}.log"
pid_file="/tmp/${run_id}.pid"
footer="/tmp/${run_id}.footer"
rm -f "$footer"

RUN_LOG="$log" RUN_FOOTER="$footer" node --input-type=module <<'NODE' \
  >"$log" 2>&1 < /dev/null &
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { rename, writeFile } from 'node:fs/promises';
const child = spawn('yy', ['pi', '-p', 'bounded task prompt'], {
  stdio: 'inherit', signal: AbortSignal.timeout(300_000)
});
let spawnFailed = false;
child.once('error', error => {
  spawnFailed = true;
  console.error(error);
});
const [value, sig] = await new Promise(resolve => child.once('close', (...args) => resolve(args)));
const code = Number.isInteger(value)
  ? value
  : sig && constants.signals[sig]
    ? 128 + constants.signals[sig]
    : spawnFailed ? 1 : 1;
const completed = new Date().toISOString();
const temporary = `${process.env.RUN_FOOTER}.tmp-${process.pid}`;
await writeFile(temporary, `exit_code=${code}\ncompleted_utc=${completed}\n`);
await rename(temporary, process.env.RUN_FOOTER);
process.exitCode = code;
NODE
producer_pid=$!
pid_tmp="${pid_file}.tmp-$$"
printf '%s\n' "$producer_pid" >"$pid_tmp"
mv "$pid_tmp" "$pid_file"

./.juno_task/scripts/watch_progress.py \
  --pid-file "$pid_file" --log-file "$log" --footer-file "$footer" \
  --poll-interval 1 --snapshot-interval 60 --tail-lines 40 --footer-grace 3
```

The footer is producer-owned terminal truth and is checked before liveness on
every cycle, including when watching starts after the producer exited. Its exact
bytes are printed; watcher exit 0 means only that a footer was observed, never
that the producer succeeded. Read the producer's exact exit code from the footer;
PID exit or log text cannot supply it. While active, `WATCH_SNAPSHOT` reports UTC, PID, elapsed state, log byte count,
and a bounded recent tail. A quiet log is not evidence of a hang.

The watcher binds the OS process start identity where available and rejects an
identity change. It also rejects a live process whose start time is newer than
the PID file, which catches stale-file PID reuse under the documented atomic PID
publication contract. If the process exits first, only `--footer-grace` is
allowed for footer flush; expiry emits `event=missing_footer`, prints a bounded
final tail, and exits nonzero. Without a preexisting footer, systems that expose
no process start identity can provide liveness but cannot prove pre-attachment
PID history; use the producer contract above on supported Linux/macOS hosts.

This helper is not a workflow engine, command launcher, timeout owner, lifecycle
authority, or substitute for `managed_agent_runner.py`, Workflow Runner,
`yy task`, `yy merge`, or release/publication approval. Stable event prefixes are
`WATCH_STARTED`, `WATCH_SNAPSHOT`, and `WATCH_EVENT`.
