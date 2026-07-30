import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAIN_SESSION_BRANCH,
  SESSION_METADATA_DIRECTORY_ENV,
  SessionContinuityCorruptStateError,
  assertValidSessionBranchName,
  getActiveSessionBranch,
  getSessionContinuityFilePath,
  listSessionBranches,
  loadSessionContinuityDocument,
  resetMainSessionBranch,
  setActiveSessionBranch,
  updateActiveSessionBranch,
  upsertClonedSessionBranch,
  validateSessionBranchName,
} from '../session-continuity-state.js';

const tempDirs: string[] = [];
const SCOPE_A = 'SCOPE_AAAAAAAAAAAAAAAA';
const SCOPE_B = 'SCOPE_BBBBBBBBBBBBBBBB';

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-session-branches-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env[SESSION_METADATA_DIRECTORY_ENV];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.remove(dir);
    }
  }
});

describe('session-branches', () => {
  it('supports an explicit session metadata directory outside the working tree', async () => {
    const workingDirectory = await createTempDir();
    const artifactDirectory = path.join(await createTempDir(), 'session-metadata');
    process.env[SESSION_METADATA_DIRECTORY_ENV] = artifactDirectory;

    await resetMainSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      sessionId: 'SESSION_A',
    });

    expect(getSessionContinuityFilePath(workingDirectory)).toBe(
      path.join(artifactDirectory, 'session_continuity.v2.json'),
    );
    expect(await fs.pathExists(path.join(workingDirectory, '.juno_task', 'session_continuity.v2.json'))).toBe(false);
    expect((await fs.readJson(path.join(artifactDirectory, 'session_continuity.v2.json'))).scopes[SCOPE_A]).toBeTruthy();
  });

  it('missing file initializes an empty document', async () => {
    const workingDirectory = await createTempDir();

    await expect(loadSessionContinuityDocument(workingDirectory)).resolves.toEqual({
      version: 2,
      scopes: {},
    });
  });

  it('reset main creates only main and active main for the scope', async () => {
    const workingDirectory = await createTempDir();

    await resetMainSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      sessionId: 'SESSION_MAIN',
      now: new Date('2026-06-27T00:00:00.000Z'),
    });

    const document = await loadSessionContinuityDocument(workingDirectory);
    expect(document.scopes[SCOPE_A]).toMatchObject({
      source: 'hash_lookup',
      pinned: false,
      settings: null,
      active: MAIN_SESSION_BRANCH,
      branches: {
        main: {
          session_id: 'SESSION_MAIN',
          parent: null,
          updated_at: '2026-06-27T00:00:00.000Z',
        },
      },
    });

    const branches = await listSessionBranches({ workingDirectory, scope: SCOPE_A });
    expect(branches).toEqual([
      {
        name: 'main',
        active: true,
        sessionId: 'SESSION_MAIN',
        parent: null,
        sourceSessionId: null,
        updatedAt: '2026-06-27T00:00:00.000Z',
      },
    ]);
  });

  it('clone upsert C from main preserves active main', async () => {
    const workingDirectory = await createTempDir();
    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_A, sessionId: 'SESSION_MAIN' });

    const clone = await upsertClonedSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      branchName: 'C',
      sessionId: 'SESSION_C',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN',
      now: new Date('2026-06-27T00:01:00.000Z'),
    });

    expect(clone).toMatchObject({ name: 'C', active: false, sessionId: 'SESSION_C' });
    await expect(getActiveSessionBranch({ workingDirectory, scope: SCOPE_A })).resolves.toMatchObject({
      name: 'main',
      sessionId: 'SESSION_MAIN',
    });
  });

  it('overriding C replaces its session id and source metadata', async () => {
    const workingDirectory = await createTempDir();
    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_A, sessionId: 'SESSION_MAIN' });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      branchName: 'C',
      sessionId: 'SESSION_C1',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN',
      now: new Date('2026-06-27T00:01:00.000Z'),
    });

    await upsertClonedSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      branchName: 'C',
      sessionId: 'SESSION_C2',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN_NEW',
      now: new Date('2026-06-27T00:02:00.000Z'),
    });

    const branches = await listSessionBranches({ workingDirectory, scope: SCOPE_A });
    expect(branches.find((branch) => branch.name === 'C')).toEqual({
      name: 'C',
      active: false,
      sessionId: 'SESSION_C2',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN_NEW',
      updatedAt: '2026-06-27T00:02:00.000Z',
    });
  });

  it('switch C changes active only for the current scope', async () => {
    const workingDirectory = await createTempDir();
    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_A, sessionId: 'A_MAIN' });
    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_B, sessionId: 'B_MAIN' });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      branchName: 'C',
      sessionId: 'A_C',
      parent: 'main',
      sourceSessionId: 'A_MAIN',
    });

    await setActiveSessionBranch({ workingDirectory, scope: SCOPE_A, branchName: 'C' });

    await expect(getActiveSessionBranch({ workingDirectory, scope: SCOPE_A })).resolves.toMatchObject({
      name: 'C',
      sessionId: 'A_C',
    });
    await expect(getActiveSessionBranch({ workingDirectory, scope: SCOPE_B })).resolves.toMatchObject({
      name: 'main',
      sessionId: 'B_MAIN',
    });
  });

  it('continue update active branch updates only C, not main or D', async () => {
    const workingDirectory = await createTempDir();
    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_A, sessionId: 'SESSION_MAIN' });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      branchName: 'C',
      sessionId: 'SESSION_C',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN',
    });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      branchName: 'D',
      sessionId: 'SESSION_D',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN',
    });
    await setActiveSessionBranch({ workingDirectory, scope: SCOPE_A, branchName: 'C' });

    await updateActiveSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      sessionId: 'SESSION_C2',
      now: new Date('2026-06-27T00:03:00.000Z'),
    });

    const branches = await listSessionBranches({ workingDirectory, scope: SCOPE_A });
    expect(branches).toEqual([
      expect.objectContaining({ name: 'main', active: false, sessionId: 'SESSION_MAIN' }),
      expect.objectContaining({ name: 'C', active: true, sessionId: 'SESSION_C2' }),
      expect.objectContaining({ name: 'D', active: false, sessionId: 'SESSION_D' }),
    ]);
  });

  it('reset main drops stale branch pointers for the scope only', async () => {
    const workingDirectory = await createTempDir();
    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_A, sessionId: 'A_MAIN' });
    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_B, sessionId: 'B_MAIN' });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope: SCOPE_A,
      branchName: 'C',
      sessionId: 'A_C',
      parent: 'main',
      sourceSessionId: 'A_MAIN',
    });

    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_A, sessionId: 'A_MAIN_2' });

    await expect(listSessionBranches({ workingDirectory, scope: SCOPE_A })).resolves.toEqual([
      expect.objectContaining({ name: 'main', active: true, sessionId: 'A_MAIN_2' }),
    ]);
    await expect(listSessionBranches({ workingDirectory, scope: SCOPE_B })).resolves.toEqual([
      expect.objectContaining({ name: 'main', active: true, sessionId: 'B_MAIN' }),
    ]);
  });

  it('invalid and missing branch switch errors clearly', async () => {
    const workingDirectory = await createTempDir();
    await resetMainSessionBranch({ workingDirectory, scope: SCOPE_A, sessionId: 'SESSION_MAIN' });

    await expect(
      setActiveSessionBranch({ workingDirectory, scope: SCOPE_A, branchName: 'missing' }),
    ).rejects.toThrow("Unknown session branch 'missing'");
    await expect(
      setActiveSessionBranch({ workingDirectory, scope: SCOPE_A, branchName: '   ' }),
    ).rejects.toThrow('Branch name cannot be empty');
  });

  it('validates branch names and exposes reserved main validation for clone targets', () => {
    expect(validateSessionBranchName(' C ')).toEqual({ valid: true, normalized: 'C' });
    expect(validateSessionBranchName('main', { allowMain: false })).toMatchObject({
      valid: false,
      normalized: 'main',
      reason: expect.stringContaining('reserved'),
    });
    expect(() => assertValidSessionBranchName('main', { allowMain: false })).toThrow('reserved');
  });

  it('corrupted JSON fails safe with an actionable recovery error', async () => {
    const workingDirectory = await createTempDir();
    const statePath = getSessionContinuityFilePath(workingDirectory);
    await fs.ensureDir(path.dirname(statePath));
    await fs.writeFile(statePath, '{not-json', 'utf-8');

    await expect(loadSessionContinuityDocument(workingDirectory)).rejects.toThrow(
      SessionContinuityCorruptStateError,
    );
    await expect(loadSessionContinuityDocument(workingDirectory)).rejects.toThrow(
      'Move or remove session_continuity.v2.json',
    );
  });
});
