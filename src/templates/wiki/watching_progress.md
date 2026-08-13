# Watching managed progress

Use the canonical controller-managed `watch_progress.py` for an already-running
producer that owns three distinct files: a numeric PID file, a combined log, and
an atomically published terminal footer. Resolve the controller from every
controller, task, integration-owner, or nested invocation surface with the
existing read-only `yy where controller` command; never select a watcher from the
current checkout. The watcher observes only. Interrupting it never signals the
producer.

## Safe producer and watcher

This example binds Node 22.22.3, creates a private collision-resistant run
directory, gives the command a five-minute bound, captures combined output, and
atomically publishes both PID and footer. Replace the sample command only within
the existing lifecycle/release authority.

```bash
set -eu
source "$HOME/.nvm/nvm.sh"
nvm use 22.22.3
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/yy-TASK_ID-run.XXXXXX")
log="$run_dir/combined.log"
pid_file="$run_dir/producer.pid"
footer="$run_dir/terminal.footer"

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
const derived = Number.isInteger(value)
  ? value
  : sig && constants.signals[sig]
    ? 128 + constants.signals[sig]
    : spawnFailed ? 1 : 1;
const code = Number.isInteger(derived) && derived >= 0 && derived <= 255 ? derived : 1;
const completed = new Date().toISOString();
const temporary = `${process.env.RUN_FOOTER}.tmp-${process.pid}`;
await writeFile(temporary,
  `schema_version=juno.watch-footer.v1\nexit_code=${code}\ncompleted_utc=${completed}\n`,
  { encoding: 'ascii', mode: 0o600 });
await rename(temporary, process.env.RUN_FOOTER);
process.exitCode = code;
NODE
producer_pid=$!
pid_tmp="$run_dir/producer.pid.tmp-$$"
printf '%s\n' "$producer_pid" >"$pid_tmp"
chmod 600 "$pid_tmp"
mv "$pid_tmp" "$pid_file"

controller_root=$(yy where controller)
watcher="$controller_root/.juno_task/scripts/watch_progress.py"
"$watcher" \
  --pid-file "$pid_file" --log-file "$log" --footer-file "$footer" \
  --poll-interval 1 --snapshot-interval 60 --tail-lines 40 --footer-grace 3
```

`mktemp -d` creates a private mode-0700 directory and isolates simultaneous
launches. Retain the printed `run_dir` path as evidence; deletion is a separate,
explicit cleanup action.

## Strict terminal footer

The only supported footer is exact ASCII in this order, with one final newline:

```text
schema_version=juno.watch-footer.v1
exit_code=0
completed_utc=2026-08-12T21:09:28.123Z
```

`schema_version` must be exactly `juno.watch-footer.v1`. `exit_code` is one
canonical base-10 integer in the intentionally supported Unix range 0 through
255 (no sign, fraction, or leading zero). `completed_utc` is a real calendar
instant in UTC using `YYYY-MM-DDTHH:MM:SSZ` or one to six fractional digits
before `Z`. Empty, partial, reordered, duplicate, unknown-field, invalid-range,
invalid-time, non-ASCII, and arbitrary footer bytes are malformed and never
produce watcher success.

The footer is checked before liveness every cycle, including late attachment.
A valid existing footer remains terminal truth after process exit. The producer
must publish by atomic rename as shown. To tolerate a mistaken non-atomic writer,
a malformed footer observed while the bound producer remains live is reported
once per changed payload and may become valid; it is not success. Once the
producer exits, only `--footer-grace` remains. Grace expiry fails closed with a
`malformed_footer` or `missing_footer` event, exact malformed bytes when present,
and a bounded final tail. Watcher exit 0 means a schema-valid footer was
observed, not that the producer exit code was zero.

The watcher binds the OS process start identity where available and rejects an
identity change. It also rejects a live process whose start time is newer than
the atomically published PID file. Without a valid preexisting footer, systems
that expose no process start identity cannot prove pre-attachment PID history
and refuse attachment; supported Linux/macOS paths bind identity.

## Output framing

All metadata is compact JSONL with schema version `juno.watch-event.v1` and at
least `event` and `utc`. JSON escaping applies to every value, including paths
and macOS identities containing spaces, equals signs, newlines, or other control
characters. Events include `watch_started`, `snapshot`, `process_exited`,
`footer_malformed_waiting`, `footer_valid`, `malformed_footer`,
`missing_footer`, `error`, and `interrupted`.

Raw footer and tail bytes are never event records. They are framed by JSONL
`payload_begin` and `payload_end` records carrying the same `payload_name` and
`byte_length`. A machine reader must read exactly `byte_length` bytes after the
newline ending `payload_begin`; `payload_end` starts immediately after those
bytes, even when the payload has no trailing newline. This preserves footer
bytes exactly and prevents footer or log content from injecting metadata.

Polls use monotonic deadlines: identity and snapshot work consume the current
interval rather than adding another full sleep. Snapshot and tail reads remain
bounded, and missing or empty logs are safe. A quiet log is not hang evidence.

This helper is not a workflow engine, command launcher, timeout owner, lifecycle
authority, or substitute for `managed_agent_runner.py`, Workflow Runner,
`yy task`, `yy merge`, or release/publication approval.
