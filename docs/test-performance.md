# Test performance: benchmark profile and cold-setup elimination (Wave 1)

This document describes the Wave 1 delivery of the trusted-test performance
PDR (`7djT8N`): a reproducible benchmark profile, Node-by-default test
environments, an explicit retry quarantine policy, and content-addressed
immutable fixture bases that remove per-invocation venv and real-Git
controller construction.

## Benchmark profile

The harness `scripts/test-performance/benchmark-profile.mjs` measures one
command several times and emits a strict `juno.test.performance.profile.v1`
artifact that separates process startup, transform/collection, environment,
global setup, teardown, and receipt finalization, and records environment
identity (platform, Node/Python versions, CPU count), dependency-lock and
runtime identities (package-lock sha256, vitest version, vitest config and
global-setup digests), p50/p95 summaries per phase, and bounded references to
the retained raw logs (logs are truncated at 256 KiB and referenced by path,
size, and sha256 rather than committed).

Reproduce a focused-gate profile:

```bash
npm run test:performance-profile -- --label focused-task-workspace \
  -- npm test -- src/utils/__tests__/environment.test.ts
```

Reproduce the pre-cache cold fixture-construction baseline:

```bash
sh scripts/test-performance/probe-cold-fixture.sh
```

Artifacts are written to `test-results/performance/<id>.json` (gitignored;
reference them by digest when recording claims). The profile is deliberately
machine-bound: report the artifact id, environment identity, and phase
summaries together, never a bare wall-clock number.

## Node-by-default environments

`vitest.config.ts` sets `environment: 'node'`. The suite has no browser-DOM
dependence — every historical `document`/`window` reference in tests is a
local JSON-document variable — so Node-only runs no longer load `happy-dom`.
Files that genuinely need a DOM opt in with a docblock:

```ts
// @vitest-environment happy-dom
```

`src/utils/__tests__/fixtures/happy-dom-probe.test.ts` proves the opt-in
still yields a DOM, and `src/utils/__tests__/vitest-policy.test.ts` pins the
default plus the opt-in contract.

## Retry policy

Ordinary failures execute exactly once (`retry: 0`). Retries exist only as an
explicit, reported quarantine: `YYLO_TEST_QUARANTINE_RETRIES=<n>` (integer in
`[0, 5]`) emits a `[quarantine] ... advisory-not-first-pass` marker into the
structured output. Lifecycle admission argv never sets the variable, so a
retried pass can never become an eligible first-pass receipt.

## Content-addressed fixture bases

`src/test-utils/fixture-base-cache.ts` replaces the per-invocation
Python-venv + fixture-controller construction in
`src/test-utils/global-setup.ts` with:

- a base key — SHA-256 over the dependency lock, fixture schema,
  implementation/admission contract digests, Python interpreter identity, and
  Node runtime generation — so any drift materializes a new base and stale
  bases are never reused;
- immutable bases published by atomic rename and sealed read-only
  (`yylo-fixture-base.json` manifest with content digests; attempted mutation
  fails at the filesystem level; corruption is detected by digest and the
  damaged base is quarantined, then rebuilt);
- a disposable writable overlay per run, copied from the sealed base, with
  cleanup that is path-scoped to exactly this run's overlay — it can never
  delete the shared base, a foreign cache entry, or another process's overlay;
- serialized materialization through claim files with dead-owner recovery for
  concurrent cold starts;
- an explicit cold fallback (`YYLO_TEST_DISABLE_FIXTURE_BASE_CACHE=1`, or an
  unusable cache root) that preserves the pre-cache construction semantics.

Bases live under `$(realpath tmpdir)/yylo-fixture-bases/` and overlays under
`$(realpath tmpdir)/yylo-fixture-overlays/`. The git mutation sentinel and
all fixture environment semantics are unchanged; only construction cost is
removed. Phase instrumentation is available to the harness through
`YYLO_TEST_GLOBAL_SETUP_PHASE_REPORT=<path>`.
