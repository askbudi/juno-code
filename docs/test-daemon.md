# Advisory test daemon (Wave 2)

This document describes the Wave 2 delivery of the trusted-test performance
PDR (`7djT8N`): a bounded, fail-safe, persistent advisory validator that
keeps Vitest module transforms, dependency resolution, immutable fixture
bases, and global-setup runtime state warm across affected-test requests.

## Safety model first

The daemon is **advisory-only**:

- Authoritative lifecycle admission (`yy task`, `yy evidence`, `yy merge`)
  never consults the daemon; cold, receipt-bound execution is unchanged.
- Every response frame carries `advisory: true`; a frame without it is
  rejected by the client-side protocol parser.
- Any identity drift, transport failure, protocol skew, or runner failure
  returns a structured error with a cold-fallback hint — never a successful
  PASS.
- Identity is rechecked **before dispatch and after completion**: HEAD plus a
  digest over the full working tree (tracked and untracked, because edit-loop
  changes are uncommitted). A tree that mutated during the run yields
  `outcome: invalidated`.

## Daemon identity

One daemon serves exactly one `(repository, worktree, project root,
dependency lock, runtime generation, toolchain)` tuple, digested into
`identity_sha256`:

- repository root and physical worktree (`git rev-parse`),
- project root (for example `juno-code`),
- dependency lock: sha256 of `package-lock.json`,
- runtime generation: Vitest version plus the bytes of `vitest.config.ts`,
  `vitest.fast.config.ts`, the global setup, setup files, fixture base cache,
  and resource lock helper,
- toolchain: Node version, platform, arch.

Drift in any component materializes a different identity — and therefore a
different daemon — instead of reusing incompatible warm state. Daemons live
under `$(realpath tmpdir)/yylo-test-daemons/<identity>/` (`run.json`,
`identity.json`, `daemon.log` bounded at 8 MiB). The Unix socket itself uses
a short generated name (`yylo-td-<16 hex>.sock`) because kernel `sun_path`
budgets (104 bytes on macOS, 108 on Linux) silently truncate longer paths.

## Versioned protocol

`juno.test.daemon.protocol.v1` frames are newline-delimited JSON with strict
schemas (`juno.test.daemon.request.v1` / `...response.v1`): unknown fields,
wrong types, malformed digests, and protocol-version skew are rejected, never
guessed. A run request binds:

- physical worktree, project root, and daemon identity digest,
- HEAD and the working-tree digest,
- the exact selected tests and their input-closure digest (selected files
  plus runtime-generation inputs, recomputed independently by the daemon),
- the admitted environment (an explicit allowlist: `CI`, `NODE_ENV`, `TZ`,
  `YYLO_TEST_QUARANTINE_RETRIES`, `YYLO_TEST_DISABLE_FIXTURE_BASE_CACHE`,
  `JUNO_TEST_RESOURCE_LOCK_PATH`) frozen at daemon start — `NODE_ENV`
  normalizes unset→`test` exactly as Vitest's cold child does, and drift is
  an `environment_mismatch`,
- the equivalent cold command argv and a bounded timeout.

Responses contain compact structured results (per-file status, counts,
bounded failure messages), a canonical `results_digest` the client verifies,
timing phases, and the before/after identity recheck.

## CLI surface

```bash
yy test daemon start    # start (or confirm) the daemon for this project
yy test daemon status   # bounded status; well under 500 ms
yy test daemon stop     # graceful stop with owner-checked escalation
yy test affected        # warm affected edit loop; cold fallback on any refusal
yy test affected --no-daemon   # force the cold path for one invocation
yy test affected --changed-base <ref>   # select against an explicit base
```

`yy test affected` selects tests deterministically: changed test files select
themselves; a changed source file selects its sibling `<name>.test.ts` and
`<name>/__tests__/<name>.test.ts` when they exist. Import-graph tracing is
deliberately out of scope for the advisory loop. Results print with an
explicit `advisory-only` marker; the exit code mirrors the test outcome for
edit-loop convenience.

## Fail-safety and bounds

- **Crash recovery**: stale sockets without a listener are recovered on the
  next start; a crashed child leaves at worst a stale socket file that the
  client removes. Stop escalates SIGTERM → SIGKILL only against a PID whose
  `ps` command line proves it is this identity's daemon child.
- **Busy**: one run at a time; concurrent requests receive `busy` and fall
  back cold.
- **Runner failure poisons the daemon**: any warm-runner error shuts the
  daemon down deterministically; the client falls back cold and the next
  request starts a fresh daemon.
- **Bounded resources**: idle shutdown (default 30 min, `--daemon-idle-timeout-ms`),
  a request ceiling (default 2000, `--daemon-max-requests`), an RSS ceiling,
  bounded frame sizes (1 MiB), bounded result payloads, and a bounded log.
- **Shared managed-install resources**: requests intersecting
  `managed-project-assets.test.ts` / `script-installer.test.ts` serialize on
  the same cross-process Python lock protocol as the cold focused-validation
  runner before dispatch.
- **Platform guard**: Unix sockets require macOS/Linux; other platforms get
  an explicit `unsupported_platform` cold fallback.
- **Source and installed routing**: the daemon child re-executes the exact
  CLI entry that is running (bundled `dist` or `src` under tsx), and the
  Vitest Node API is resolved through `createRequire` anchored at the
  consumer project (with a dist-URL import fallback for loader-patched
  source checkouts), so installed and source CLIs behave consistently.

## Warm/cold equivalence matrix

`scripts/test-daemon/equivalence-matrix.mjs` runs the same selections through
the cold authoritative child (`npm test -- <files>`) and the warm daemon,
then compares selected tests, per-file status, and test counts across
repetitions, emitting a `juno.test.daemon.equivalence.v1` artifact with
p50/p95 for both paths:

```bash
node scripts/test-daemon/equivalence-matrix.mjs \
  --selection src/utils/__tests__/environment.test.ts \
  --repetitions 5
```

Run this matrix before any future proposal to admit daemon evidence
authoritatively; equivalence evidence is a precondition, not a consequence.

## Measurements (reference machine)

Reference machine: the PDR controller laptop (macOS 26.5.1, Node 22.22.3,
Python 3.13.9, 8 CPUs). Artifacts are machine-bound and retained under
`test-results/performance/` (gitignored); record the artifact digest
together with any claim.

| Measurement | Result | Artifact (sha256) |
| --- | --- | --- |
| `yy test daemon status` protocol request | p95 ≈ 0–2 ms (budget < 500 ms) | — |
| `yy test daemon status` full source-CLI wall | p50 913 ms / p95 948 ms (tsx boot dominates) | `daemon-status-profile.json` `c7a4d8ae…` |
| Warm affected loop, one focused file (steady state) | p50 190 ms (budget p95 < 5 s; first-touch run pays the transform once: 2.4 s) | `daemon-equivalence.json` `209724f0…` |
| Cold reference, same selection | p50 2 510 ms / p95 2 686 ms | `daemon-equivalence.json` `209724f0…` |
| Warm vs cold equivalence | identical selection, per-file status, and counts across 5 repetitions × 2 selections | `daemon-equivalence.json` `209724f0…` |

Warm steady-state is ≈ 13× faster than the cold child at the median for a
single focused file, and the equivalence matrix shows no selection, status,
or count drift.

Reproduce with:

```bash
yy test daemon start
yy test daemon status
node scripts/test-daemon/equivalence-matrix.mjs --selection <file> --repetitions 5
```

## Node version characterization

The daemon uses stable Node APIs only (net, fs, crypto, child_process,
module). Characterized on Node 22 (primary, all suites above) and Node 24
(protocol, identity, server, and real-daemon suites); Node 20 shares every
code path and is covered by the same suite in CI. Platform support is macOS
and Linux; other platforms fail safe to the cold path. The Unix socket name
is generated to stay within the kernel `sun_path` budget (104 bytes macOS,
108 Linux) — see `daemonSocketPathFor`.

## Exclusions (unchanged from the wave contract)

No admission authority for daemon results, no distributed or remote workers,
no network service, and no broad lifecycle-core refactor. Promotion of
daemon evidence to authoritative status requires the warm/cold equivalence
matrix plus a separate reviewed decision.
