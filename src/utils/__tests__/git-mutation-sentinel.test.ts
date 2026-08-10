import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertGitMutationSnapshotsUnchanged,
  captureGitMutationSnapshot,
} from '../../test-utils/git-mutation-sentinel.js';
import { protectedRoots } from '../../test-utils/global-setup.js';

const temporaryRoots: string[] = [];

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function repositoryFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-mutation-sentinel-'));
  temporaryRoots.push(root);
  git(root, 'init', '-b', 'fixture');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  await fs.outputFile(path.join(root, 'protected', 'managed-script.sh'), 'original\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.remove(root)));
});

describe('full-suite Git mutation sentinel', () => {
  it('does not freeze a shared registered controller unless the caller explicitly owns it', async () => {
    const productRoot = await repositoryFixture();
    const controllerRoot = await repositoryFixture();
    git(productRoot, 'config', 'juno.controller.path', controllerRoot);
    git(productRoot, 'config', 'juno.controller.branch', 'fixture-controller');

    expect(protectedRoots(productRoot, { JUNO_TASK_ROOT: controllerRoot })).toEqual([
      {
        identity: 'product/candidate',
        root: await fs.realpath(productRoot),
      },
    ]);

    expect(protectedRoots(productRoot, {
      JUNO_TASK_ROOT: controllerRoot,
      JUNO_CODE_TEST_PROTECTED_GIT_ROOTS: controllerRoot,
    })).toEqual([
      {
        identity: 'product/candidate',
        root: await fs.realpath(productRoot),
      },
      {
        identity: 'protected[0]',
        root: await fs.realpath(controllerRoot),
      },
    ]);
  });

  it('accepts byte-stable protected state', async () => {
    const root = await repositoryFixture();
    const before = captureGitMutationSnapshot('fixture-controller', root);
    const after = captureGitMutationSnapshot('fixture-controller', root);
    expect(() => assertGitMutationSnapshotsUnchanged([before], [after])).not.toThrow();
  });

  it.each(['protected/managed-script.sh', '__proto__'])(
    'names the exact %s path when only index stat bytes change',
    async (relativePath) => {
      const root = await repositoryFixture();
      const protectedPath = path.join(root, relativePath);
      if (relativePath === '__proto__') {
        await fs.writeFile(protectedPath, 'metakey path\n');
        git(root, 'add', relativePath);
        git(root, 'commit', '-m', 'add metakey path');
      }
      const before = captureGitMutationSnapshot('fixture-controller', root);

      // Refresh only this entry's cached stat data. Content, HEAD, logical index
      // entries, and porcelain status remain byte-for-byte equivalent.
      const future = new Date(Date.now() + 5_000);
      await fs.utimes(protectedPath, future, future);
      git(root, 'update-index', '--refresh');
      const after = captureGitMutationSnapshot('fixture-controller', root);

      expect(after.status).toBe(before.status);
      expect(after.trackedFiles).toEqual(before.trackedFiles);
      expect(after.indexEntriesSha256).toBe(before.indexEntriesSha256);
      expect(after.indexSha256).not.toBe(before.indexSha256);
      expect(() => assertGitMutationSnapshotsUnchanged([before], [after])).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining(
            `fixture-controller (${await fs.realpath(root)}): <index>, ${relativePath}`,
          ),
        }),
      );
    },
  );

  it('refuses an intentional mutation with the exact identity and paths without restoring evidence', async () => {
    const root = await repositoryFixture();
    const protectedPath = path.join(root, 'protected', 'managed-script.sh');
    const before = captureGitMutationSnapshot('fixture-controller', root);

    // The backing guard matters because fixture routing can regress; this real
    // Git check proves HEAD/index/status/file bytes are independently frozen.
    await fs.writeFile(protectedPath, 'mutated\n');
    git(root, 'add', protectedPath);
    const after = captureGitMutationSnapshot('fixture-controller', root);

    expect(() => assertGitMutationSnapshotsUnchanged([before], [after])).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(`fixture-controller (${await fs.realpath(root)}): <index>, <status>, protected/managed-script.sh`),
      }),
    );
    expect(await fs.readFile(protectedPath, 'utf8')).toBe('mutated\n');
  });
});
