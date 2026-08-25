#!/usr/bin/env node
/**
 * Reproducible test-performance benchmark profile (Wave 1 of 7djT8N).
 *
 * Measures one declared argv (for example a focused validation command or a
 * standalone fixture-construction probe) several times and records a strict
 * `juno.test.performance.profile.v1` artifact that separates:
 *
 *   process startup, transform/collection, global setup, resource wait,
 *   execution, teardown, and receipt finalization.
 *
 * Every claim is reproducible: the artifact records the exact argv, cwd,
 * environment identity (platform, Node/Python versions, CPU count), dependency
 * lock and runtime identities, per-repetition wall times, parsed Vitest phase
 * timings when the command is a Vitest run, p50/p95 summaries, and bounded
 * references to the retained raw logs. Raw logs stay on the machine; only
 * their digest, path, and byte size are referenced.
 *
 * Usage:
 *   node scripts/test-performance/benchmark-profile.mjs \
 *     --label focused-task-workspace \
 *     --cwd . \
 *     -- npm test -- src/utils/__tests__/environment.test.ts
 *
 * Optional flags:
 *   --repetitions <n>     default 5
 *   --warmup <n>          default 1 (unrecorded warm-up repetition)
 *   --probe <name>=<argv> additional standalone probe measured once per run,
 *                         recorded under `probes` (for example the cold
 *                         fixture-construction baseline: venv+git init).
 *   --out <path>          default test-results/performance/<id>.json
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'juno.test.performance.profile.v1';
const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const DEFAULT_RAW_ROOT = path.join(ROOT, 'test-results', 'performance');

function fail(message) {
  process.stderr.write(`benchmark-profile: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { repetitions: 5, warmup: 1, probes: [], label: null, cwd: ROOT, out: null, command: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--' && !options.command) {
      if (index + 1 >= argv.length) fail('-- requires a command');
      options.command = argv.slice(index + 1);
      break;
    }
    if (argument === '--repetitions') options.repetitions = Number(argv[++index]);
    else if (argument === '--warmup') options.warmup = Number(argv[++index]);
    else if (argument === '--label') options.label = String(argv[++index]);
    else if (argument === '--cwd') options.cwd = path.resolve(ROOT, String(argv[++index]));
    else if (argument === '--out') options.out = path.resolve(ROOT, String(argv[++index]));
    else if (argument === '--probe') {
      const specification = String(argv[++index]);
      const separator = specification.indexOf('=');
      if (separator <= 0) fail(`--probe expects name=argv (space-separated command): ${specification}`);
      options.probes.push({
        name: specification.slice(0, separator),
        argv: specification.slice(separator + 1).split(' ').filter(Boolean),
      });
    } else fail(`unknown argument: ${argument}`);
  }
  if (!options.command || options.command.length === 0) fail('a command after -- is required');
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 50) {
    fail('--repetitions must be an integer in [1, 50]');
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0 || options.warmup > 10) {
    fail('--warmup must be an integer in [0, 10]');
  }
  return options;
}

function sha256File(target) {
  try {
    return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  } catch {
    return null;
  }
}

function pythonIdentity() {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  const path_ = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
  return {
    argv: ['python3', '--version'],
    version: (probe.stdout || probe.stderr || '').trim() || null,
    executable: (path_.stdout || '').trim() || null,
  };
}

function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

function summarizeMilliseconds(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min_ms: sorted[0] ?? null,
    p50_ms: quantile(sorted, 0.5),
    p95_ms: quantile(sorted, 0.95),
    max_ms: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * Parse the Vitest default-reporter phase summary line:
 *   Duration 1.82s (transform 50ms, setup 31ms, collect 25ms, tests 17ms, environment 63ms, prepare 42ms)
 */
function parseVitestPhases(output) {
  const match = output.match(
    /Duration\s+([\d.]+m?s)\s*\(transform\s*([\d.]+m?s),?\s*setup\s*([\d.]+m?s),?\s*collect\s*([\d.]+m?s),?\s*tests\s*([\d.]+m?s),?\s*environment\s*([\d.]+m?s),?\s*prepare\s*([\d.]+m?s)\)/,
  );
  if (!match) return null;
  const milliseconds = (token) => (token.endsWith('ms') ? Number(token.slice(0, -2)) : Number(token.slice(0, -1)) * 1000);
  return {
    transform_ms: milliseconds(match[2]),
    setup_ms: milliseconds(match[3]),
    collect_ms: milliseconds(match[4]),
    tests_ms: milliseconds(match[5]),
    environment_ms: milliseconds(match[6]),
    prepare_ms: milliseconds(match[7]),
  };
}

function runOnce({ command, cwd, rawDir, index, label, phaseReportPath }) {
  if (phaseReportPath) {
    try { fs.rmSync(phaseReportPath, { force: true }); } catch { /* best effort */ }
  }
  const startedAt = new Date();
  const highRes = process.hrtime.bigint();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    env: phaseReportPath
      ? { ...process.env, YYLO_TEST_GLOBAL_SETUP_PHASE_REPORT: phaseReportPath }
      : { ...process.env, YYLO_TEST_GLOBAL_SETUP_PHASE_REPORT: '' },
  });
  const wallMs = Number(process.hrtime.bigint() - highRes) / 1e6;
  const finishedAt = new Date();
  const stdout = result.stdout ? result.stdout.toString('utf8') : '';
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';
  const combined = `${stdout}\n${stderr}`;
  const rawLog = path.join(rawDir, `${label}.rep-${index}.log`);
  const bounded = Buffer.from(combined, 'utf8');
  fs.writeFileSync(rawLog, bounded.length > 262144 ? bounded.subarray(0, 262144) : bounded);
  let globalSetupPhases = null;
  if (phaseReportPath && fs.existsSync(phaseReportPath)) {
    try {
      globalSetupPhases = JSON.parse(fs.readFileSync(phaseReportPath, 'utf8'));
    } catch { globalSetupPhases = null; }
  }
  return {
    index,
    exit_code: result.status,
    signal: result.signal,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    wall_ms: Math.round(wallMs * 1000) / 1000,
    vitest_phases: parseVitestPhases(combined),
    global_setup_phases: globalSetupPhases,
    raw_log: {
      path: path.relative(ROOT, rawLog),
      bytes: fs.statSync(rawLog).size,
      sha256: createHash('sha256').update(fs.readFileSync(rawLog)).digest('hex'),
      truncated: combined.length > 262144,
    },
  };
}

function runProbe(probe, cwd, rawDir) {
  const startedAt = new Date();
  const highRes = process.hrtime.bigint();
  const result = spawnSync(probe.argv[0], probe.argv.slice(1), { cwd, encoding: 'utf8' });
  const wallMs = Number(process.hrtime.bigint() - highRes) / 1e6;
  const rawLog = path.join(rawDir, `probe.${probe.name}.log`);
  fs.writeFileSync(rawLog, `${result.stdout || ''}\n${result.stderr || ''}`);
  return {
    name: probe.name,
    argv: probe.argv,
    exit_code: result.status,
    wall_ms: Math.round(wallMs * 1000) / 1000,
    started_at: startedAt.toISOString(),
    raw_log: {
      path: path.relative(ROOT, rawLog),
      bytes: fs.statSync(rawLog).size,
      sha256: createHash('sha256').update(fs.readFileSync(rawLog)).digest('hex'),
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const identifier = `${new Date().toISOString().replace(/[:.]/g, '-')}-${createHash('sha256')
    .update(JSON.stringify({ command: options.command, label: options.label }))
    .digest('hex')
    .slice(0, 12)}`;
  const rawDir = path.dirname(options.out ?? path.join(DEFAULT_RAW_ROOT, `${identifier}.json`));
  fs.mkdirSync(rawDir, { recursive: true });
  const phaseReportPath = path.join(rawDir, 'global-setup-phases.json');

  for (let warmup = 0; warmup < options.warmup; warmup += 1) {
    runOnce({
      command: options.command,
      cwd: options.cwd,
      rawDir,
      index: `warmup-${warmup}`,
      label: options.label ?? 'command',
      phaseReportPath,
    });
  }
  const repetitions = [];
  for (let index = 0; index < options.repetitions; index += 1) {
    repetitions.push(runOnce({
      command: options.command,
      cwd: options.cwd,
      rawDir,
      index,
      label: options.label ?? 'command',
      phaseReportPath,
    }));
  }
  const exitCodes = [...new Set(repetitions.map((row) => row.exit_code))];

  const artifact = {
    schema_version: SCHEMA,
    id: identifier,
    label: options.label ?? 'command',
    created_at: new Date().toISOString(),
    command: { argv: options.command, cwd: path.relative(ROOT, options.cwd) || '.' },
    repetitions: options.repetitions,
    warmup: options.warmup,
    environment: {
      platform: os.platform(),
      platform_release: os.release(),
      architecture: os.arch(),
      cpu_count: os.cpus().length,
      node_version: process.version,
      python: pythonIdentity(),
      ci: Boolean(process.env.CI),
    },
    identities: {
      package_lock_sha256: sha256File(path.join(ROOT, 'package-lock.json')),
      vitest_version: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'vitest', 'package.json'), 'utf8')).version,
      vitest_config_sha256: sha256File(path.join(ROOT, 'vitest.config.ts')),
      global_setup_sha256: sha256File(path.join(ROOT, 'src', 'test-utils', 'global-setup.ts')),
    },
    summary: {
      exit_codes: exitCodes,
      wall: summarizeMilliseconds(repetitions.map((row) => row.wall_ms)),
      vitest_transform_collect_ms: summarizeMilliseconds(
        repetitions.map((row) => (row.vitest_phases ? row.vitest_phases.transform_ms + row.vitest_phases.collect_ms : NaN)).filter((value) => Number.isFinite(value)),
      ),
      vitest_environment_ms: summarizeMilliseconds(
        repetitions.map((row) => (row.vitest_phases ? row.vitest_phases.environment_ms : NaN)).filter((value) => Number.isFinite(value)),
      ),
      vitest_tests_ms: summarizeMilliseconds(
        repetitions.map((row) => (row.vitest_phases ? row.vitest_phases.tests_ms : NaN)).filter((value) => Number.isFinite(value)),
      ),
      global_setup_ms: summarizeMilliseconds(
        repetitions.map((row) => (row.global_setup_phases ? row.global_setup_phases.total_setup_ms ?? NaN : NaN)).filter((value) => Number.isFinite(value)),
      ),
      teardown_ms: summarizeMilliseconds(
        repetitions.map((row) => (row.global_setup_phases ? row.global_setup_phases.total_teardown_ms ?? NaN : NaN)).filter((value) => Number.isFinite(value)),
      ),
      process_startup_ms: summarizeMilliseconds(
        repetitions.map((row) => {
          if (!row.vitest_phases) return NaN;
          const accounted = row.vitest_phases.transform_ms + row.vitest_phases.setup_ms
            + row.vitest_phases.collect_ms + row.vitest_phases.tests_ms
            + row.vitest_phases.environment_ms + row.vitest_phases.prepare_ms;
          const residual = row.wall_ms - accounted;
          return Number.isFinite(residual) ? Math.max(0, residual) : NaN;
        }).filter((value) => Number.isFinite(value)),
      ),
      resource_wait_ms: null,
      resource_wait_note: 'single-command profile runs hold no shared managed-install lease contention; resource wait is reported by focused-gate lock diagnostics when present',
      receipt_finalization_ms: null,
      receipt_finalization_note: 'finalization is the harness JSON artifact write, measured below and excluded from wall phases',
    },
    probes: options.probes.map((probe) => runProbe(probe, options.cwd, rawDir)),
    runs: repetitions,
  };
  const receiptStarted = process.hrtime.bigint();
  const outPath = options.out ?? path.join(DEFAULT_RAW_ROOT, `${identifier}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const receiptMs = Number(process.hrtime.bigint() - receiptStarted) / 1e6;
  artifact.summary.receipt_finalization_ms = { count: 1, min_ms: receiptMs, p50_ms: receiptMs, p95_ms: receiptMs, max_ms: receiptMs };
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const summary = artifact.summary;
  process.stdout.write(
    `benchmark ${artifact.label}: reps=${options.repetitions} exit=${JSON.stringify(exitCodes)}\n`
    + `  wall p50/p95: ${summary.wall.p50_ms?.toFixed(0)}ms / ${summary.wall.p95_ms?.toFixed(0)}ms\n`
    + `  artifact: ${path.relative(ROOT, outPath)}\n`,
  );
  if (exitCodes.length !== 1 || exitCodes[0] !== 0) process.exitCode = 1;
}

main();
