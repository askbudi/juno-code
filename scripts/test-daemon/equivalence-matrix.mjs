#!/usr/bin/env node
/**
 * Warm/cold equivalence matrix for the YYLO advisory test daemon (Wave 2 of
 * PDR 7djT8N).
 *
 * For each requested selection this script runs the cold authoritative path
 * (`npm test -- <files>`, a fresh Vitest child) and the warm advisory path
 * (daemon rerun through the versioned protocol), then compares selected
 * tests, per-file status, and test counts. It emits a strict
 * `juno.test.daemon.equivalence.v1` artifact with timings and p50/p95 for
 * both paths, referenced by digest from docs/test-daemon.md.
 *
 * Usage (from the project root under test, e.g. juno-code):
 *   node scripts/test-daemon/equivalence-matrix.mjs \
 *     --selection src/utils/__tests__/environment.test.ts \
 *     --selection src/utils/__tests__/explicit-command.test.ts \
 *     [--repetitions 5] [--out test-results/performance/daemon-equivalence.json]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);

function readOption(name) {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : undefined;
}

const selections = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--selection') selections.push(args[index + 1]);
}

const repetitions = Number(readOption('--repetitions') ?? 5);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 50) {
  console.error('--repetitions must be an integer in [1, 50]');
  process.exit(2);
}
if (selections.length === 0) {
  console.error('at least one --selection <test file> is required');
  process.exit(2);
}

const projectRoot = fs.realpathSync(process.cwd());
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const { resolveDaemonIdentity } = await import(
  path.join(repoRoot, 'src/test-daemon/cli.ts')
);
const { resolveProjectVitestVersion } = await import(
  path.join(repoRoot, 'src/test-daemon/warm-runner.ts')
);
const { startDaemon, daemonRun, daemonStop, daemonStatus } = await import(
  path.join(repoRoot, 'src/test-daemon/client.ts')
);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function coldRun(files) {
  const started = Date.now();
  const result = spawnSync(
    'node',
    [
      '--import',
      'tsx',
      path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--reporter=json',
      ...files,
    ],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const elapsed = Date.now() - started;
  let totals = null;
  const jsonPath = path.join(projectRoot, 'test-results', 'results.json');
  try {
    // The project config routes the JSON reporter to test-results/results.json;
    // fall back to stdout parsing for projects without an outputFile.
    const source = fs.existsSync(jsonPath)
      ? fs.readFileSync(jsonPath, 'utf8')
      : result.stdout ?? '';
    const jsonStart = source.indexOf('{');
    const raw = JSON.parse(source.slice(jsonStart, source.lastIndexOf('}') + 1));
    totals = {
      tests: raw.numTotalTests ?? null,
      failed: raw.numFailedTests ?? null,
      files: (raw.testResults ?? []).map((entry) => ({
        path: path.relative(projectRoot, entry.name),
        failed: (entry.assertionResults ?? []).some((test) => test.status === 'failed'),
      })),
    };
  } catch {
    totals = null;
  }
  return { exitCode: result.status, elapsed, totals };
}

const vitestVersion = await resolveProjectVitestVersion(projectRoot);
const identity = await resolveDaemonIdentity(projectRoot, vitestVersion);

console.log(`[equivalence] identity ${identity.identity_sha256.slice(0, 12)} vitest ${vitestVersion}`);
const statusStart = Date.now();
await startDaemon(identity, {
  startTimeoutMs: 120_000,
  entryOverride: path.join(repoRoot, 'src/bin/cli.ts'),
});
const status = await daemonStatus(identity);
console.log(`[equivalence] daemon status in ${Date.now() - statusStart}ms pid=${status.daemon.pid}`);

const matrix = [];
try {
  for (const selection of selections) {
    const files = [selection];
    const entry = { selection, warm: [], cold: [] };
    let warmReference = null;
    let coldReference = null;
    for (let index = 0; index < repetitions; index += 1) {
      const warm = await daemonRun(
        {
          identity,
          selectedTests: files,
          timeoutMs: 300_000,
          commandArgv: ['npm', 'test', '--', ...files],
        },
        330_000,
      );
      if (warm.type !== 'run') {
        console.error(`[equivalence] warm run failed: ${warm.error?.code} ${warm.error?.message}`);
        process.exitCode = 1;
        break;
      }
      const warmSummary = {
        tests: warm.results.totals.tests,
        failed: warm.results.totals.failed,
        files: warm.results.files.map((file) => ({
          path: file.path,
          failed: file.status === 'failed',
        })),
      };
      warmReference ??= warmSummary;
      entry.warm.push({
        elapsed_ms: warm.timings_ms.total_ms,
        equivalent:
          JSON.stringify(warmSummary) === JSON.stringify(warmReference),
      });
    }
    for (let index = 0; index < repetitions; index += 1) {
      const cold = coldRun(files);
      if (cold.totals === null) {
        console.error('[equivalence] cold run produced no structured results');
        process.exitCode = 1;
        break;
      }
      coldReference ??= cold.totals;
      entry.cold.push({
        elapsed_ms: cold.elapsed,
        equivalent: JSON.stringify(cold.totals) === JSON.stringify(coldReference),
      });
    }
    const warmEquivalent =
      warmReference !== null &&
      coldReference !== null &&
      warmReference.tests === coldReference.tests &&
      warmReference.failed === coldReference.failed &&
      JSON.stringify([...warmReference.files].sort()) ===
        JSON.stringify([...coldReference.files].sort());
    entry.equivalent = warmEquivalent;
    entry.warm_totals = warmReference;
    entry.cold_totals = coldReference;
    matrix.push(entry);
  }
} finally {
  await daemonStop(identity);
}

const warmElapsed = matrix.flatMap((entry) => entry.warm.map((run) => run.elapsed_ms));
const coldElapsed = matrix.flatMap((entry) => entry.cold.map((run) => run.elapsed_ms));
const artifact = {
  schema_version: 'juno.test.daemon.equivalence.v1',
  identity: {
    platform: os.platform(),
    node: process.versions.node,
    vitest: vitestVersion,
    cpus: os.cpus().length,
    dependency_lock: identity.dependency_lock.sha256,
    runtime_generation: identity.runtime_generation.sha256,
  },
  repetitions,
  matrix,
  summary: {
    all_equivalent: matrix.every((entry) => entry.equivalent),
    warm_p50_ms: percentile(warmElapsed, 0.5),
    warm_p95_ms: percentile(warmElapsed, 0.95),
    cold_p50_ms: percentile(coldElapsed, 0.5),
    cold_p95_ms: percentile(coldElapsed, 0.95),
  },
};

const out =
  readOption('--out') ??
  path.join(projectRoot, 'test-results', 'performance', 'daemon-equivalence.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
const digest = createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log(`[equivalence] artifact ${out}`);
console.log(`[equivalence] sha256 ${digest}`);
console.log(`[equivalence] summary ${JSON.stringify(artifact.summary)}`);
process.exitCode = artifact.summary.all_equivalent ? 0 : 1;
