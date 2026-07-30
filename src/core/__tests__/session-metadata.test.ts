import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetMainSessionBranch, loadSessionContinuityDocument } from '../session-continuity-state.js';
import {
  getSessionMetadataDirectory,
  withSessionMetadataLock,
  writeSessionMetadataFileAtomic,
} from '../session-metadata.js';

const roots: string[] = [];
const originalMetadataDirectory = process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
const scope = (suffix: string) => ({ scopeHash: `SCOPE_${suffix.padEnd(16, '0')}` });

async function temporaryDirectory(name: string): Promise<string> {
  const root = path.join('/tmp', `juno-session-metadata-${name}-${process.pid}-${Date.now()}`);
  roots.push(root);
  await fs.ensureDir(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  delete process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
});

afterEach(async () => {
  if (originalMetadataDirectory === undefined) delete process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
  else process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = originalMetadataDirectory;
  for (const root of roots.splice(0)) await fs.remove(root);
});

describe('session metadata resolver', () => {
  it('uses one Git-common-dir root for a repository and linked worktree', async () => {
    const root = await temporaryDirectory('linked');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(root, 'tracked'), 'x');
    git(root, 'add', 'tracked');
    git(root, 'commit', '-qm', 'base');
    const linked = `${root}-linked`;
    roots.push(linked);
    git(root, 'worktree', 'add', '-q', '-b', 'linked-test', linked);

    const primaryMetadata = getSessionMetadataDirectory(root);
    expect(getSessionMetadataDirectory(linked)).toBe(primaryMetadata);
    expect(primaryMetadata.endsWith(path.join('.git', 'juno', 'session_metadata'))).toBe(true);
    expect(primaryMetadata.includes(`${path.sep}.juno_task${path.sep}`)).toBe(false);
  });

  it('honors override and keeps non-Git state outside the working directory', async () => {
    const root = await temporaryDirectory('nongit');
    const state = await temporaryDirectory('state');
    expect(getSessionMetadataDirectory(root, { XDG_STATE_HOME: state })).toMatch(
      new RegExp(`^${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = '../explicit-metadata';
    expect(getSessionMetadataDirectory(root)).toBe(path.resolve(root, '../explicit-metadata'));
  });

  it('atomically replaces metadata and lock ownership with private modes', async () => {
    const root = await temporaryDirectory('private-modes');
    const metadata = path.join(root, 'metadata');
    const file = path.join(metadata, 'session_continuity.v2.json');
    await fs.ensureDir(metadata);
    await fs.chmod(metadata, 0o755);
    await fs.writeFile(file, 'legacy', { mode: 0o644 });

    await writeSessionMetadataFileAtomic(file, 'private');
    expect((await fs.stat(metadata)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    await withSessionMetadataLock(metadata, 'mode-proof', async () => {
      expect((await fs.stat(path.join(metadata, 'mode-proof.lock'))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(metadata, 'mode-proof.lock', 'owner.json'))).mode & 0o777).toBe(0o600);
    });
  });

  it('serializes concurrent branch producers without dropping scopes', async () => {
    const root = await temporaryDirectory('concurrent');
    process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = path.join(root, 'metadata');
    await Promise.all([
      resetMainSessionBranch({ workingDirectory: root, scope: scope('A'), sessionId: 'one' }),
      resetMainSessionBranch({ workingDirectory: root, scope: scope('B'), sessionId: 'two' }),
    ]);
    const document = await loadSessionContinuityDocument(root);
    expect(Object.keys(document.scopes).sort()).toEqual([
      'SCOPE_A000000000000000', 'SCOPE_B000000000000000',
    ]);
  });

  it('reclaims stale markers and fails visibly on a live overlapping owner', async () => {
    const root = await temporaryDirectory('locks');
    const stale = path.join(root, 'cron.lock');
    await fs.ensureDir(stale);
    await fs.writeJson(path.join(stale, 'owner.json'), { pid: 99999999 });
    await expect(withSessionMetadataLock(root, 'cron', async () => 'reclaimed')).resolves.toBe('reclaimed');

    let release!: () => void;
    const held = withSessionMetadataLock(root, 'cron', () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const overlap = withSessionMetadataLock(root, 'cron', async () => undefined);
    await expect(overlap).rejects.toThrow('Timed out waiting for session metadata lock');
    release();
    await held;
  }, 7_000);
});
