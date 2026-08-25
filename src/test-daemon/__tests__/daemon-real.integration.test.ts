/**
 * Real-daemon integration and warm/cold equivalence tests (Wave 2 of PDR
 * 7djT8N). Excluded from the fast suite (`vitest.fast.config.ts`) because it
 * spawns a real daemon child and a real cold Vitest process against a
 * throwaway project that reuses this repository's exact dependency tree.
 *
 * Equivalence contract: warm (daemon) and cold (fresh child process) runs
 * select identical tests and agree on per-file status and test counts.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daemonRun, daemonStatus, daemonStop, startDaemon } from '../client.js';
import {
  dependencyLockDigest,
  daemonIdentityFromParts,
  resolveRepositoryTopology,
  runtimeGenerationDigest,
  toolchainIdentity,
} from '../identity.js';
import { DAEMON_PROTOCOL_VERSION } from '../protocol.js';
import { daemonLayoutFor } from '../paths.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

let projectRoot: string;
let daemonIdentity: Awaited<ReturnType<typeof buildIdentity>>;

function git(root: string, args: string[]): string {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    .stdout.toString();
}

async function buildIdentity() {
  // realpath once: macOS mkdtemp returns /var/... while spawned children and
  // Vitest resolve /private/var/...; identity must bind the physical path.
  projectRoot = await fs.realpath(projectRoot);
  const topology = await resolveRepositoryTopology(projectRoot);
  const lock = await dependencyLockDigest(projectRoot);
  const vitestVersion = (
    await import('node:module')
  ).createRequire(path.join(projectRoot, 'package.json'))('vitest/package.json') as {
    version: string;
  };
  const runtime = await runtimeGenerationDigest(projectRoot, vitestVersion.version);
  return daemonIdentityFromParts(
    DAEMON_PROTOCOL_VERSION,
    topology,
    projectRoot,
    lock,
    runtime,
    toolchainIdentity(),
  );
}

beforeAll(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yylo-daemon-real-'));
  git(projectRoot, ['init', '--initial-branch=main']);
  git(projectRoot, ['config', 'user.email', 'daemon@test']);
  git(projectRoot, ['config', 'user.name', 'Daemon Test']);
  // Reuse the repository's exact dependency tree through a node_modules
  // symlink so the temp project resolves the same Vitest generation.
  await fs.symlink(
    path.join(REPO_ROOT, 'node_modules'),
    path.join(projectRoot, 'node_modules'),
  );
  await fs.writeFile(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'daemon-real', private: true }, null, 2),
  );
  // An exact dependency lock is required for daemon identity.
  await fs.copyFile(
    path.join(REPO_ROOT, 'package-lock.json'),
    path.join(projectRoot, 'package-lock.json'),
  );
  await fs.writeFile(
    path.join(projectRoot, 'vitest.config.ts'),
    [
      "import { defineConfig } from 'vitest/config';",
      'export default defineConfig({ test: { environment: "node" } });',
      '',
    ].join('\n'),
  );
  await fs.mkdir(path.join(projectRoot, 'tests'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'tests', 'green.test.ts'),
    [
      "import { expect, test } from 'vitest';",
      "test('passes', () => { expect(1 + 1).toBe(2); });",
      "test('passes again', () => { expect('a').toBe('a'); });",
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(projectRoot, 'tests', 'red.test.ts'),
    [
      "import { expect, test } from 'vitest';",
      "test('fails', () => { expect(1).toBe(2); });",
      '',
    ].join('\n'),
  );
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'init']);

  daemonIdentity = await buildIdentity();

  // Ensure no daemon is left over from a previous failed run.
  await daemonStop(daemonIdentity).catch(() => undefined);
}, 120_000);

afterAll(async () => {
  await daemonStop(daemonIdentity).catch(() => undefined);
  await fs.rm(projectRoot, { recursive: true, force: true });
}, 120_000);

describe('real advisory test daemon', () => {
  it(
    'starts, reports status, and stops',
    { timeout: 120_000 },
    async () => {
      const started = await startDaemon(daemonIdentity, {
        startTimeoutMs: 90_000,
        entryOverride: path.join(REPO_ROOT, 'src/bin/cli.ts'),
      });
      expect(['started', 'already_running']).toContain(started.outcome);

      const statusStart = Date.now();
      const status = await daemonStatus(daemonIdentity);
      expect(status.type).toBe('status');
      expect(Date.now() - statusStart).toBeLessThan(500);

      const layout = daemonLayoutFor(daemonIdentity.identity_sha256);
      const runFile = JSON.parse(
        await fs.readFile(layout.runJsonPath, 'utf8'),
      ) as { state: string };
      expect(runFile.state).toBe('serving');

      const { response } = await daemonStop(daemonIdentity);
      expect([null, 'stopping']).toContain(response?.outcome ?? null);
    },
  );

  it(
    'produces warm results equivalent to a cold child run',
    { timeout: 180_000 },
    async () => {
      await startDaemon(daemonIdentity, {
        startTimeoutMs: 90_000,
        entryOverride: path.join(REPO_ROOT, 'src/bin/cli.ts'),
      });
      const warm = await daemonRun(
        {
          identity: daemonIdentity,
          selectedTests: ['tests/green.test.ts', 'tests/red.test.ts'],
          timeoutMs: 60_000,
          commandArgv: ['npm', 'test', '--', 'tests/green.test.ts', 'tests/red.test.ts'],
        },
        120_000,
      );
      expect(warm.type).toBe('run');
      expect(warm.outcome).toBe('completed');
      expect(warm.results?.totals.tests).toBe(3);
      expect(warm.results?.totals.failed).toBe(1);
      expect(warm.results?.files.map((file) => file.path)).toEqual([
        'tests/green.test.ts',
        'tests/red.test.ts',
      ]);

      // Cold reference: a fresh Vitest child process on the same selection.
      // It exits 1 because the selection contains a failing test; read the
      // structured JSON from stdout regardless of the exit code.
      const coldRun = spawnSync(
        'node',
        [
          '--import',
          'tsx',
          path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--reporter=json',
          'tests/green.test.ts',
          'tests/red.test.ts',
        ],
        { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
      expect(coldRun.status).toBe(1);
      const coldOutput = coldRun.stdout ?? '';
      const jsonStart = coldOutput.indexOf('{');
      const cold = JSON.parse(
        coldOutput.slice(jsonStart, coldOutput.lastIndexOf('}') + 1),
      ) as {
        numTotalTests: number;
        numFailedTests: number;
        testResults: Array<{ assertionResults: Array<{ status: string }> }>;
      };
      expect(cold.numTotalTests).toBe(warm.results?.totals.tests);
      expect(cold.numFailedTests).toBe(warm.results?.totals.failed);
      const coldFailedFiles = cold.testResults
        .filter((file) =>
          file.assertionResults.some((test) => test.status === 'failed'),
        )
        .map((file) =>
          path.relative(projectRoot, (file as unknown as { name: string }).name),
        )
        .sort();
      const warmFailedFiles = (warm.results?.files ?? [])
        .filter((file) => file.status === 'failed')
        .map((file) => file.path)
        .sort();
      expect(warmFailedFiles).toEqual(coldFailedFiles);
    },
  );

  it(
    'recovers deterministically from a crashed daemon (stale socket)',
    { timeout: 120_000 },
    async () => {
      await startDaemon(daemonIdentity, {
        startTimeoutMs: 90_000,
        entryOverride: path.join(REPO_ROOT, 'src/bin/cli.ts'),
      });
      const layout = daemonLayoutFor(daemonIdentity.identity_sha256);
      const runFile = JSON.parse(
        await fs.readFile(layout.runJsonPath, 'utf8'),
      ) as { pid: number };
      process.kill(runFile.pid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 500));
      // The next start must recover the stale socket and serve again.
      const restarted = await startDaemon(daemonIdentity, {
        startTimeoutMs: 90_000,
        entryOverride: path.join(REPO_ROOT, 'src/bin/cli.ts'),
      });
      expect(restarted.outcome).toBe('started');
      const status = await daemonStatus(daemonIdentity);
      expect(status.type).toBe('status');
    },
  );
});
