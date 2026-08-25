import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY = path.resolve(import.meta.dirname, '../../../..');
const HARNESS = path.join(REPOSITORY, 'juno-code', 'scripts', 'test-performance', 'benchmark-profile.mjs');

/**
 * Wave 1 (7djT8N) benchmark-profile schema and reproducibility contracts.
 * The harness runs a tiny deterministic command under a private output root
 * and must emit the strict `juno.test.performance.profile.v1` artifact with
 * phase separation, environment and lock identities, p50/p95 summaries, and
 * bounded raw-log references.
 */
describe('test-performance benchmark profile', () => {
  let outputRoot: string;

  beforeAll(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yylo-benchmark-profile-test-'));
  });

  afterAll(() => {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  const runHarness = (extra: string[]): Record<string, unknown> => {
    const out = path.join(outputRoot, `artifact-${extra.join('-').replace(/[^a-z0-9-]/gi, '')}.json`);
    execFileSync(
      process.execPath,
      [HARNESS, '--out', out, '--label', 'schema-probe', '--repetitions', '3', '--warmup', '0', ...extra,
        '--', process.execPath, '-e', 'process.exit(0)'],
      { cwd: path.join(REPOSITORY, 'juno-code'), encoding: 'utf8' },
    );
    return JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, unknown>;
  };

  it('emits the strict schema with phase separation and identities', () => {
    const artifact = runHarness([]);
    expect(artifact.schema_version).toBe('juno.test.performance.profile.v1');
    expect(artifact.label).toBe('schema-probe');
    expect(artifact.repetitions).toBe(3);
    expect(artifact.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const environment = artifact.environment as Record<string, unknown>;
    expect(environment.platform).toBe(os.platform());
    expect(environment.node_version).toBe(process.version);
    expect((environment.python as Record<string, unknown>).version).toMatch(/^Python 3/);

    const identities = artifact.identities as Record<string, string | null>;
    expect(identities.package_lock_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(identities.vitest_config_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(identities.global_setup_sha256).toMatch(/^[0-9a-f]{64}$/);

    const summary = artifact.summary as Record<string, unknown>;
    const phases = [
      'wall',
      'vitest_transform_collect_ms',
      'vitest_environment_ms',
      'vitest_tests_ms',
      'global_setup_ms',
      'teardown_ms',
      'process_startup_ms',
      'receipt_finalization_ms',
    ];
    for (const phase of phases) {
      const row = summary[phase] as Record<string, number | null>;
      expect(row).toBeTruthy();
      expect(typeof row.count).toBe('number');
      // Vitest-sourced phases only exist when the measured command is a
      // Vitest run; a plain node command reports an empty (count 0)
      // distribution with null quantiles rather than absent fields.
      if ((row.count ?? 0) > 0) {
        expect(typeof row.p50_ms).toBe('number');
        expect(typeof row.p95_ms).toBe('number');
        expect(row.p50_ms as number).toBeGreaterThanOrEqual(0);
        expect((row.p95_ms as number) >= (row.p50_ms as number)).toBe(true);
      } else {
        expect(row.p50_ms).toBeNull();
        expect(row.p95_ms).toBeNull();
      }
    }
    // Wall carries every repetition; receipt finalization is the harness's
    // single artifact write, so its distribution has exactly one sample.
    expect((summary.wall as Record<string, number | null>).count).toBe(3);
    expect((summary.receipt_finalization_ms as Record<string, number | null>).count).toBe(1);
    // The declared phase surface is complete; unmeasured phases carry reasons.
    expect(summary.resource_wait_note).toBeTruthy();
    expect(summary.receipt_finalization_note).toBeTruthy();

    const runs = artifact.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run.exit_code).toBe(0);
      expect(typeof run.wall_ms).toBe('number');
      const raw = run.raw_log as Record<string, unknown>;
      expect(typeof raw.path).toBe('string');
      expect(typeof raw.bytes).toBe('number');
      expect(String(raw.sha256)).toMatch(/^[0-9a-f]{64}$/);
      // Bounded raw retention: logs are truncated to a hard byte ceiling.
      expect(Number(raw.bytes)).toBeLessThanOrEqual(262144);
    }
  });

  it('reproduces identical argv and identity across repeated invocations', () => {
    const first = runHarness(['--repetitions', '2']);
    const second = runHarness(['--repetitions', '2']);
    expect(first.command).toEqual(second.command);
    expect((first as Record<string, unknown>).identities).toEqual(second.identities);
    const firstWalls = (first.runs as Array<{ wall_ms: number }>).map((row) => row.wall_ms);
    const secondWalls = (second.runs as Array<{ wall_ms: number }>).map((row) => row.wall_ms);
    expect(firstWalls.length).toBe(secondWalls.length);
    // Timing values vary between machines/runs; reproducibility is about the
    // identity and shape, not bitwise equality of durations.
    expect(firstWalls.every((value) => value > 0)).toBe(true);
  });

  it('records standalone probes with their exact argv', () => {
    const artifact = runHarness(['--probe', 'true-probe=true']);
    const probes = artifact.probes as Array<Record<string, unknown>>;
    expect(probes).toHaveLength(1);
    expect(probes[0].name).toBe('true-probe');
    expect(probes[0].argv).toEqual(['true']);
    expect(probes[0].exit_code).toBe(0);
  });

  it('rejects invalid repetition bounds and missing commands', () => {
    for (const args of [['--repetitions', '0'], ['--repetitions', '51'], ['--warmup', '11']]) {
      expect(() => runHarness(args)).toThrow();
    }
    expect(() =>
      execFileSync(process.execPath, [HARNESS], { cwd: path.join(REPOSITORY, 'juno-code'), encoding: 'utf8' }),
    ).toThrow();
  });
});
