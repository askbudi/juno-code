/**
 * Identity, tree-snapshot, and closure-digest tests for the advisory test
 * daemon (Wave 2 of PDR 7djT8N). Identity must bind repository, worktree,
 * lock, runtime generation, and toolchain; any drift must materialize a new
 * identity instead of reusing warm state.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  currentEnvironmentBinding,
  daemonIdentityFromParts,
  dependencyLockDigest,
  inputClosureDigest,
  resolveRepositoryTopology,
  runtimeGenerationDigest,
  toolchainIdentity,
  treeSnapshot,
} from '../identity.js';
import { DAEMON_PROTOCOL_VERSION, sha256Hex } from '../protocol.js';

let repositoryRoot: string;

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).toString();
}

beforeAll(async () => {
  repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yylo-daemon-identity-'));
  git(repositoryRoot, ['init', '--initial-branch=main']);
  git(repositoryRoot, ['config', 'user.email', 'daemon@test']);
  git(repositoryRoot, ['config', 'user.name', 'Daemon Test']);
  await fs.writeFile(path.join(repositoryRoot, 'package.json'), '{ "name": "p" }\n');
  await fs.writeFile(
    path.join(repositoryRoot, 'package-lock.json'),
    '{ "lockfileVersion": 3 }\n',
  );
  await fs.writeFile(
    path.join(repositoryRoot, 'vitest.config.ts'),
    'export default {};\n',
  );
  await fs.mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repositoryRoot, 'src', 'a.test.ts'),
    "import {test} from 'vitest'; test('a', () => {});\n",
  );
  git(repositoryRoot, ['add', '.']);
  git(repositoryRoot, ['commit', '-m', 'init']);
});

afterAll(async () => {
  await fs.rm(repositoryRoot, { recursive: true, force: true });
});

describe('repository topology', () => {
  it('resolves the worktree and common Git directory', async () => {
    const topology = await resolveRepositoryTopology(repositoryRoot);
    expect(topology.worktree).toBe(await fs.realpath(repositoryRoot));
    expect(topology.repositoryRoot).toContain('.git');
  });
});

describe('daemon identity binding', () => {
  it('changes when the dependency lock drifts', async () => {
    const topology = await resolveRepositoryTopology(repositoryRoot);
    const lockA = await dependencyLockDigest(repositoryRoot);
    const runtime = await runtimeGenerationDigest(repositoryRoot, '1.6.1');
    const base = daemonIdentityFromParts(
      DAEMON_PROTOCOL_VERSION,
      topology,
      repositoryRoot,
      lockA,
      runtime,
      toolchainIdentity(),
    );
    const lockB = { path: lockA.path, sha256: sha256Hex('different-lock') };
    const drifted = daemonIdentityFromParts(
      DAEMON_PROTOCOL_VERSION,
      topology,
      repositoryRoot,
      lockB,
      runtime,
      toolchainIdentity(),
    );
    expect(base.identity_sha256).not.toBe(drifted.identity_sha256);
  });

  it('changes when the runtime generation or toolchain drifts', async () => {
    const topology = await resolveRepositoryTopology(repositoryRoot);
    const lock = await dependencyLockDigest(repositoryRoot);
    const runtimeA = await runtimeGenerationDigest(repositoryRoot, '1.6.1');
    const runtimeB = await runtimeGenerationDigest(repositoryRoot, '1.6.2');
    const toolchainA = toolchainIdentity({ node: '22.1.0' } as NodeJS.ProcessVersions, 'darwin', 'arm64');
    const toolchainB = toolchainIdentity({ node: '24.1.0' } as NodeJS.ProcessVersions, 'darwin', 'arm64');
    const mk = (runtime: typeof runtimeA, toolchain: typeof toolchainA) =>
      daemonIdentityFromParts(
        DAEMON_PROTOCOL_VERSION,
        topology,
        repositoryRoot,
        lock,
        runtime,
        toolchain,
      ).identity_sha256;
    expect(mk(runtimeA, toolchainA)).not.toBe(mk(runtimeB, toolchainA));
    expect(mk(runtimeA, toolchainA)).not.toBe(mk(runtimeA, toolchainB));
  });

  it('changes when the runtime generation inputs change bytes', async () => {
    const before = await runtimeGenerationDigest(repositoryRoot, '1.6.1');
    await fs.appendFile(path.join(repositoryRoot, 'vitest.config.ts'), '// drift\n');
    const after = await runtimeGenerationDigest(repositoryRoot, '1.6.1');
    expect(before.sha256).not.toBe(after.sha256);
    await fs.writeFile(path.join(repositoryRoot, 'vitest.config.ts'), 'export default {};\n');
  });
});

describe('tree snapshot', () => {
  it('digests HEAD and the uncommitted working tree', async () => {
    const clean = await treeSnapshot(repositoryRoot);
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
    await fs.writeFile(path.join(repositoryRoot, 'untracked.txt'), 'dirty\n');
    const dirty = await treeSnapshot(repositoryRoot);
    expect(dirty.head).toBe(clean.head);
    expect(dirty.digest).not.toBe(clean.digest);
    await fs.rm(path.join(repositoryRoot, 'untracked.txt'));
    const restored = await treeSnapshot(repositoryRoot);
    expect(restored.digest).toBe(clean.digest);
  });
});

describe('input closure digest', () => {
  it('changes when a selected test file changes', async () => {
    const runtime = await runtimeGenerationDigest(repositoryRoot, '1.6.1');
    const files = ['src/a.test.ts'];
    const before = await inputClosureDigest(repositoryRoot, files, runtime);
    await fs.appendFile(path.join(repositoryRoot, 'src', 'a.test.ts'), '// edit\n');
    const after = await inputClosureDigest(repositoryRoot, files, runtime);
    expect(before).not.toBe(after);
  });

  it('rejects selections that escape the project root', async () => {
    const runtime = await runtimeGenerationDigest(repositoryRoot, '1.6.1');
    await expect(
      inputClosureDigest(repositoryRoot, ['../outside.test.ts'], runtime),
    ).rejects.toThrowError(/escapes the project root/);
  });
});

describe('environment binding', () => {
  it('binds exactly the allowlisted keys, normalizing unset NODE_ENV to test', () => {
    const binding = currentEnvironmentBinding({} as NodeJS.ProcessEnv);
    expect(Object.keys(binding).sort()).toEqual([
      'CI',
      'JUNO_TEST_RESOURCE_LOCK_PATH',
      'NODE_ENV',
      'TZ',
      'YYLO_TEST_DISABLE_FIXTURE_BASE_CACHE',
      'YYLO_TEST_QUARANTINE_RETRIES',
    ]);
    expect(binding.NODE_ENV).toBe('test');
    expect(
      Object.entries(binding)
        .filter(([key]) => key !== 'NODE_ENV')
        .every(([, value]) => value === null),
    ).toBe(true);
    const bound = currentEnvironmentBinding({
      CI: 'true',
    } as NodeJS.ProcessEnv);
    expect(bound.CI).toBe('true');
  });
});
