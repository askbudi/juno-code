---
wiki_contract:
  line_limit: 140
  purpose: "Hydrate each task worktree through its frozen project workflow before implementation."
  failure_mode_prevented: "Fresh task worktrees reach validation without task-local tools, borrow dependencies from another checkout, or begin implementation after provisioning failed."
  runtime_contract_enforced: "Task start runs bounded exact-base hydration; preflight and finish verify its clean, lock-bound evidence without provisioning."
  validation_gate: "npm test -- src/utils/__tests__/managed-project-assets.test.ts && npm run test:implementation-contract"
  related_sots:
    - "git_worktree_lifecycle.md"
  owns:
    - "Workflow-driven exact-lock dependency preparation during task start and explicit retry."
  does_not_own:
    - "Project-specific commands, network authorization, and sensitive-file source approval."
---

# Task-worktree dependency hydration

## Workflow-driven task start

New task targets own `.juno_task/config/worktree-hydration.yaml`. `yy task start`
freezes its exact path and bytes, lints `workflow_class: task_hydration`, and runs
the canonical Workflow Runner with the new task worktree as project/run root.
The worktree is reported `WORKING` only after the workflow succeeds, its declared
dependency locks are present, and Git proves all outputs are ignored or admitted.

Each hydration step is an argv list with a bounded timeout, an idempotency probe,
workflow-fatal/non-interactive flags, explicit network/sensitive declarations,
and declared output paths. Use deterministic exact-lock installers. Env files use
only owner-approved source/destination pairs through `worktree_hydration.py`; the
helper copies without echoing content and enforces mode `0600`.

On failure the worktree and bounded Workflow Runner artifacts are preserved in a
non-agent-ready `HYDRATION_FAILED` state. Repair the stated prerequisite and rerun
`yy task hydrate TASK_ID`; successful probes skip already satisfied steps. This public
recovery command uses the package-bound, protocol-checked hydration engine even when
the controller's selected runtime predates `hydrate`; controller routing, creation
receipt, and worktree authority remain mandatory. Preflight and finish never install
or copy files—they verify frozen workflow and lock evidence.

Immediately after `yy task start TASK_ID` and entering its returned worktree,
before the first edit or test, read `.juno_task/config/task-workspace.json` from
the canonical controller. Inspect every selected `focused_validation[].cwd` (and
any task-required full-suite cwd), then provision only the roots those commands
need. Do not assume each root is Node: identify its checked-in exact lockfile and
use that ecosystem's deterministic, task-local install. Never copy or symlink a
dependency directory from another worktree and never substitute arbitrary global
packages.

For a Juno Code validation root, `cd` to that configured cwd, activate Node 22
(for example, `source ~/.nvm/nvm.sh && nvm use 22`), and verify its major version.
Run task-local `npm ci` when `node_modules` is absent or when its recorded lock
identity differs from the current `package-lock.json`. The following is the
canonical command; it streams combined stdout/stderr to both the terminal and a
task-ID-named `/tmp` log, enforces a real timeout, and writes its terminal footer
immediately. Set `TASK_ID` and run it from the configured Juno Code validation
cwd:

```bash
TASK_ID=TASK_ID python3 - <<'PY'
import hashlib, os, selectors, signal, subprocess, sys, time
from pathlib import Path

task_id = os.environ["TASK_ID"]
timeout = int(os.environ.get("JUNO_DEPENDENCY_TIMEOUT_SECONDS", "900"))
root = Path.cwd()
lock = root / "package-lock.json"
stamp = root / "node_modules" / ".juno-package-lock.sha256"
log = Path("/tmp") / f"yy-task-{task_id}-npm-ci.log"
started = time.monotonic()

def footer(message):
    line = f"[dependency-hydration] {message}; duration={time.monotonic() - started:.1f}s; log={log}\n"
    sys.stdout.write(line); sys.stdout.flush()
    with log.open("a", encoding="utf-8") as stream:
        stream.write(line); stream.flush()

if not lock.is_file():
    footer("FAILED missing package-lock.json")
    raise SystemExit(2)
identity = hashlib.sha256(lock.read_bytes()).hexdigest()
try:
    node = subprocess.run(["node", "-p", "process.versions.node"], text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
except OSError as exc:
    footer(f"FAILED cannot run Node 22: {exc}")
    raise SystemExit(2)
if node.returncode or node.stdout.strip().split(".", 1)[0] != "22":
    with log.open("a", encoding="utf-8") as stream:
        stream.write(node.stdout); stream.flush()
    footer("FAILED Node 22 is required")
    raise SystemExit(2)

def dependency_probe():
    remaining = max(1, timeout - int(time.monotonic() - started))
    try:
        probe = subprocess.run(["npm", "ls", "--all", "--json"], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=remaining)
    except (OSError, subprocess.TimeoutExpired) as exc:
        with log.open("a", encoding="utf-8") as stream:
            stream.write(f"dependency probe failed: {exc}\n"); stream.flush()
        return False
    with log.open("a", encoding="utf-8") as stream:
        stream.write(probe.stdout); stream.flush()
    return probe.returncode == 0

if ((root / "node_modules").is_dir() and stamp.is_file()
        and stamp.read_text().strip() == identity and dependency_probe()):
    footer("OK exact-lock dependencies already present")
    raise SystemExit(0)
try:
    stamp.unlink(missing_ok=True)
except OSError as exc:
    footer(f"FAILED cannot invalidate stale lock stamp: {exc}")
    raise SystemExit(2)
with log.open("wb") as stream:
    try:
        process = subprocess.Popen(["npm", "ci"], stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, bufsize=0, start_new_session=True)
    except OSError as exc:
        footer(f"FAILED cannot run npm ci: {exc}")
        raise SystemExit(2)
    ready = selectors.DefaultSelector(); ready.register(process.stdout, selectors.EVENT_READ)
    while True:
        if time.monotonic() - started > timeout:
            os.killpg(process.pid, signal.SIGTERM)
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.wait()
            footer(f"FAILED npm ci timed out after {timeout}s")
            raise SystemExit(124)
        events = ready.select(0.1)
        if events:
            chunk = os.read(process.stdout.fileno(), 65536)
            if chunk:
                sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
                stream.write(chunk); stream.flush()
            elif process.poll() is not None:
                break
        elif process.poll() is not None:
            chunk = os.read(process.stdout.fileno(), 65536)
            if chunk:
                sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
                stream.write(chunk); stream.flush()
            else:
                break
if process.returncode:
    footer(f"FAILED npm ci exit={process.returncode}")
    raise SystemExit(process.returncode)
if not dependency_probe():
    footer("FAILED dependency probe after npm ci")
    raise SystemExit(2)
temporary_stamp = stamp.with_name(f".{stamp.name}.{os.getpid()}.tmp")
try:
    temporary_stamp.write_text(identity + "\n")
    os.replace(temporary_stamp, stamp)
finally:
    temporary_stamp.unlink(missing_ok=True)
footer("OK npm ci complete")
PY
```

After every provisioning attempt, run `git status --short` from the task
worktree root and verify it is unchanged: dependency trees and the lock stamp
must be ignored. On any missing tool/lock, timeout, nonzero install, or dirty
status, stop before implementation. Report the configured validation cwd, exact
lockfile, `/tmp` log, terminal footer, and the exact command above (including the
required `cd` and `TASK_ID`) as the recovery command. Do not continue with a
partial dependency tree.

For configured projects, `yy task start` runs the frozen hydration workflow before
`WORKING`; preflight and finish verify its receipt and exact-lock evidence without rerunning provisioning.
