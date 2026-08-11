---
wiki_contract:
  line_limit: 140
  purpose: "Prepare each Bolt task worktree from the exact locks required by its configured validation roots before implementation."
  failure_mode_prevented: "Fresh task worktrees reach validation without task-local tools, borrow dependencies from another checkout, or begin implementation after provisioning failed."
  runtime_contract_enforced: "Workers inspect configured validation cwd values, hydrate only missing or lock-mismatched task-local dependencies, preserve a clean Git tree, and stop before implementation on failure."
  validation_gate: "npm test -- src/utils/__tests__/managed-project-assets.test.ts && npm run test:implementation-contract"
  related_sots:
    - "git_worktree_lifecycle.md"
  owns:
    - "Instruction-level exact-lock dependency preparation immediately after task start."
  does_not_own:
    - "Automatic lifecycle provisioning, which remains owned by Kanban task cjM2Uc."
---

# Task-worktree dependency hydration

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
if (root / "node_modules").is_dir() and stamp.is_file() and stamp.read_text().strip() == identity:
    footer("OK exact-lock dependencies already present")
    raise SystemExit(0)
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
stamp.write_text(identity + "\n")
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

This page is instruction-level preparation only. Automatic typed provisioning
before lifecycle validation remains the explicit future hardening contract in
`cjM2Uc`; these instructions must not be represented as runtime enforcement.
