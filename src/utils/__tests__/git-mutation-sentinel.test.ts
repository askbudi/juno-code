import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertGitMutationSnapshotsUnchanged,
  captureGitMutationSnapshot,
} from '../../test-utils/git-mutation-sentinel.js';

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
  it('accepts byte-stable protected state', async () => {
    const root = await repositoryFixture();
    const before = captureGitMutationSnapshot('fixture-controller', root);
    const after = captureGitMutationSnapshot('fixture-controller', root);
    expect(() => assertGitMutationSnapshotsUnchanged([before], [after])).not.toThrow();
  });

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
