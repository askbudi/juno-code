import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { useSharedHeavyWorkloadLock } from '../../test-utils/resource-lock.js';
import { inspect, runSyntheticLeakageCanaries } from '../../../scripts/scan-benchmark-release-artifacts.mjs';
import {
  BENCHMARK_VERSION_RANGE,
  BenchmarkDelegateError,
  discoverBenchmarkExecutable,
  invokeBenchmark,
} from '../commands/benchmark.js';

const fixtures: string[] = [];
const projectRoot = path.resolve(__dirname, '../../..');
const leakageSourceTree = '2'.repeat(40);
const leakageCommandHash = `sha256:${'3'.repeat(64)}`;
const requiredLeakageClasses = [
  'private-registry', 'auth-credentials', 'candidate-home-xdg',
  'canonical-controller-route', 'host-paths', 'candidate-git-metadata',
];
const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

useSharedHeavyWorkloadLock('benchmark clean-source release artifact smoke');

async function fixture(): Promise<{ root: string; bin: string; record: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-delegate-'));
  fixtures.push(root);
  const binDirectory = path.join(root, 'bin');
  const executable = path.join(binDirectory, 'juno-benchmark');
  const record = path.join(root, 'record.json');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(binDirectory));
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  if (process.env.FAKE_VERSION_WAIT) setInterval(() => {}, 1000);
  else {
    process.stdout.write(process.env.FAKE_BENCHMARK_VERSION || 'juno-benchmark 0.1.0');
    process.exit(Number(process.env.FAKE_VERSION_EXIT || 0));
  }
}
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.DELEGATE_MARKER,
  preflightPresent: Object.prototype.hasOwnProperty.call(process.env, 'JUNO_CODE_PREFLIGHT_ONLY')
}));
process.stdout.write('delegate stdout\\n');
process.stderr.write('delegate stderr\\n');
process.exit(Number(process.env.FAKE_EXIT || 0));
`);
  await chmod(executable, 0o755);
  return { root, bin: binDirectory, record };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('benchmark release leakage canaries', () => {
  it('runs every canary through the production rejection path and hashes its actual failure', () => {
    const failures = new Map<string, Error & { detectedClasses: string[] }>();
    const calls: Array<{ label: string; count: boolean }> = [];
    const productionRejection = (bytes: Buffer, label: string, count: boolean) => {
      calls.push({ label, count });
      try {
        return inspect(bytes, label, count);
      } catch (error) {
        failures.set(label, error as Error & { detectedClasses: string[] });
        throw error;
      }
    };

    const results = runSyntheticLeakageCanaries(leakageSourceTree, leakageCommandHash, productionRejection);

    expect(results.map((result: { check_id: string }) => result.check_id)).toEqual(requiredLeakageClasses);
    expect(calls).toEqual(requiredLeakageClasses.map((checkId) => ({ label: `synthetic:${checkId}`, count: false })));
    for (const result of results) {
      const failure = failures.get(`synthetic:${result.check_id}`)!;
      expect(failure).toBeInstanceOf(Error);
      expect(result.passed).toBe(true);
      expect(result.observed).toEqual({ detected: true, rejected: true, detected_classes: failure.detectedClasses });
      expect(result.output.detected_classes).toEqual(failure.detectedClasses);
      expect(result.log.stderr_hash).toBe(sha256(failure.message));
    }
  });

  it('fails closed when the production rejection path is bypassed', () => {
    expect(() => runSyntheticLeakageCanaries(leakageSourceTree, leakageCommandHash, () => undefined))
      .toThrow(/positive control failed: private-registry/u);
  });

  it('does not pass a canary rejected for a different leakage class', () => {
    const rejectAsCredentials = (_bytes: Buffer, label: string, count: boolean) =>
      inspect(Buffer.from('_authToken=juno_release_wrong_class_credential\n'), label, count);
    expect(() => runSyntheticLeakageCanaries(leakageSourceTree, leakageCommandHash, rejectAsCredentials))
      .toThrow(/positive control failed: private-registry/u);
  });
});

describe('benchmark delegate', () => {
  it('packs, installs, and verifies standalone/delegate equivalence from tracked sources', async () => {
    const result = await execa(process.execPath, ['scripts/verify-benchmark-release-artifacts.mjs'], {
      cwd: projectRoot,
      reject: false,
      timeout: 300_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('benchmark release artifact smoke passed');
  }, 310_000);

  it('discovers only PATH executables and preserves argument order, cwd, and caller environment', async () => {
    const { root, bin, record } = await fixture();
    const cwd = path.join(root, 'working directory');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(cwd));
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_RECORD: record,
      DELEGATE_MARKER: 'exact value',
      JUNO_CODE_PREFLIGHT_ONLY: 'must-not-leak',
    };
    const args = ['plan', '--task', 'T 1', '--models', ':mini,:sol', '--dry-run'];

    const result = await invokeBenchmark(args, { cwd, env });
    const observed = JSON.parse(await readFile(record, 'utf8'));

    expect(result).toEqual({ code: 0, signal: null });
    expect(observed).toEqual({
      argv: args,
      cwd: await realpath(cwd),
      marker: 'exact value',
      preflightPresent: true,
    });
  });

  it('returns the canonical executable nonzero status unchanged', async () => {
    const { root, bin, record } = await fixture();
    const result = await invokeBenchmark(['run', '--dry-run'], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_RECORD: record, FAKE_EXIT: '47' },
    });
    expect(result).toEqual({ code: 47, signal: null });
  });

  it('resolves relative PATH entries from the delegated working directory', async () => {
    const { root, record } = await fixture();
    const env = {
      ...process.env,
      PATH: `bin${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_RECORD: record,
    };
    const result = await invokeBenchmark(['plan'], { cwd: root, env });
    expect(result).toEqual({ code: 0, signal: null });
  });

  it('fails closed with an actionable missing-executable diagnostic', () => {
    expect(() => discoverBenchmarkExecutable({ PATH: '' })).toThrowError(BenchmarkDelegateError);
    try {
      discoverBenchmarkExecutable({ PATH: '' });
    } catch (error) {
      expect(error).toMatchObject({ exitCode: 127 });
      expect(String(error)).toContain('independently installed');
      expect(String(error)).toContain(BENCHMARK_VERSION_RANGE);
    }
  });

  it.each(['juno-benchmark 1.0.0', 'juno-benchmark 0.1.0-alpha.1'])(
    'refuses incompatible version %s before forwarding user arguments',
    async (reportedVersion) => {
      const { root, bin, record } = await fixture();
      await expect(invokeBenchmark(['run'], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
          FAKE_RECORD: record,
          FAKE_BENCHMARK_VERSION: reportedVersion,
        },
      })).rejects.toMatchObject({ exitCode: 69 });
      await expect(readFile(record, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('bounds a stalled version handshake and reaps the child', async () => {
    const { root, bin, record } = await fixture();
    await expect(invokeBenchmark(['run'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_RECORD: record,
        FAKE_VERSION_WAIT: '1',
      },
      versionTimeoutMs: 50,
    })).rejects.toMatchObject({ exitCode: 69 });
    await expect(readFile(record, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
