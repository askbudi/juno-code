import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTINUE_SCOPE_OVERRIDE_ENV_KEY, resolveContinueScopeContext } from '../continue-scope.js';
import {
  MAX_CONTINUE_SETTING_ARRAY_ITEMS,
  SESSION_CONTINUITY_FILE_NAME,
  getSessionContinuityFilePath,
  loadSessionContinuityDocument,
  persistContinueScopeSnapshot,
  resetMainSessionBranch,
  resolveScopedContinueSessionState,
  setActiveSessionBranch,
  upsertClonedSessionBranch,
} from '../session-continuity-state.js';

const roots: string[] = [];
const originalMetadataDirectory = process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-continuity-v2-'));
  roots.push(root);
  process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = path.join(root, 'metadata');
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.remove(root);
  if (originalMetadataDirectory === undefined)
    delete process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
  else process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = originalMetadataDirectory;
});
function context(root: string, name: string) {
  return resolveContinueScopeContext({ [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: name }, 1, root);
}
const settings = (subagent = 'pi') => JSON.stringify({ version: 1, subagent, maxIterations: 5 });

describe('session continuity state service', () => {
  it('writes one versioned atomic document with identity, settings, branch, timestamps, source and pin state without touching env files', async () => {
    const root = await temporaryRoot();
    const scope = context(root, 'shape');
    await fs.writeFile(path.join(root, '.env.custom'), 'SECRET=unchanged\n');
    await persistContinueScopeSnapshot({
      workingDirectory: root,
      context: scope,
      sessionId: 'SESSION_A',
      serializedSettings: settings(),
    });
    const document = await loadSessionContinuityDocument(root);
    const stored = document.scopes[scope.scopeHash]!;
    expect(document.version).toBe(2);
    expect(stored).toMatchObject({
      source: scope.scopeSource,
      pinned: false,
      active: 'main',
      settings: { version: 1, subagent: 'pi', maxIterations: 5 },
    });
    expect(stored.branches.main?.session_id).toBe('SESSION_A');
    expect(Date.parse(stored.createdAt)).not.toBeNaN();
    expect(Date.parse(stored.lastUsedAt)).not.toBeNaN();
    expect(await fs.readFile(path.join(root, '.env.custom'), 'utf8')).toBe('SECRET=unchanged\n');
    expect(await fs.pathExists(path.join(root, '.env.juno'))).toBe(false);
  });

  it('serializes concurrent writers without losing unrelated scopes or branch updates', async () => {
    const root = await temporaryRoot();
    process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = path.join(root, 'custom-metadata');
    const a = context(root, 'writer-a');
    const b = context(root, 'writer-b');
    await Promise.all([
      persistContinueScopeSnapshot({
        workingDirectory: root,
        context: a,
        sessionId: 'A',
        serializedSettings: settings(),
      }),
      persistContinueScopeSnapshot({
        workingDirectory: root,
        context: b,
        sessionId: 'B',
        serializedSettings: settings('claude'),
      }),
    ]);
    await upsertClonedSessionBranch({
      workingDirectory: root,
      scope: a,
      branchName: 'C',
      sessionId: 'C',
      parent: 'main',
      sourceSessionId: 'A',
    });
    await Promise.all([
      setActiveSessionBranch({ workingDirectory: root, scope: a, branchName: 'C' }),
      persistContinueScopeSnapshot({ workingDirectory: root, context: b, sessionId: 'B2' }),
    ]);
    const document = await loadSessionContinuityDocument(root);
    expect(Object.keys(document.scopes).sort()).toEqual([a.scopeHash, b.scopeHash].sort());
    expect(document.scopes[a.scopeHash]?.active).toBe('C');
    expect(document.scopes[b.scopeHash]?.branches.main?.session_id).toBe('B2');
    expect(getSessionContinuityFilePath(root)).toBe(
      path.join(root, 'custom-metadata', SESSION_CONTINUITY_FILE_NAME),
    );
  });

  it('reclaims a stale continuity lock before writing', async () => {
    const root = await temporaryRoot();
    process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = path.join(root, 'metadata');
    const lock = `${getSessionContinuityFilePath(root)}.lock`;
    await fs.ensureDir(lock);
    await fs.writeJson(path.join(lock, 'owner.json'), { pid: 99_999_999, token: 'dead' });
    const scope = context(root, 'stale-lock');
    await expect(
      persistContinueScopeSnapshot({
        workingDirectory: root,
        context: scope,
        sessionId: 'A',
        serializedSettings: settings(),
      }),
    ).resolves.toBeUndefined();
    expect(
      (await loadSessionContinuityDocument(root)).scopes[scope.scopeHash]?.branches.main
        ?.session_id,
    ).toBe('A');
  });

  it('fails closed on malformed or unsupported documents', async () => {
    const root = await temporaryRoot();
    process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = path.join(root, 'metadata');
    await fs.ensureDir(path.dirname(getSessionContinuityFilePath(root)));
    await fs.writeFile(getSessionContinuityFilePath(root), '{bad');
    await expect(loadSessionContinuityDocument(root)).rejects.toThrow(
      /Unable to read session continuity state/,
    );
    await fs.writeJson(getSessionContinuityFilePath(root), { version: 1, scopes: {} });
    await expect(loadSessionContinuityDocument(root)).rejects.toThrow(
      /unsupported session continuity version/,
    );
  });

  it('rejects unbounded or unsupported settings before writing', async () => {
    const root = await temporaryRoot();
    const scope = context(root, 'bounds');
    await expect(
      persistContinueScopeSnapshot({
        workingDirectory: root,
        context: scope,
        sessionId: 'A',
        serializedSettings: JSON.stringify({
          version: 1,
          subagent: 'pi',
          tools: Array(MAX_CONTINUE_SETTING_ARRAY_ITEMS + 1).fill('read'),
        }),
      }),
    ).rejects.toThrow(/bound/);
    await expect(
      persistContinueScopeSnapshot({
        workingDirectory: root,
        context: scope,
        sessionId: 'A',
        serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', secret: 'no' }),
      }),
    ).rejects.toThrow(/Unsupported continue setting/);
    expect(await fs.pathExists(getSessionContinuityFilePath(root))).toBe(false);
  });

  it('resolves session and settings from the same active branch document', async () => {
    const root = await temporaryRoot();
    const scope = context(root, 'routing');
    await resetMainSessionBranch({ workingDirectory: root, scope, sessionId: 'MAIN' });
    await persistContinueScopeSnapshot({
      workingDirectory: root,
      context: scope,
      sessionId: 'MAIN',
      serializedSettings: settings(),
    });
    await upsertClonedSessionBranch({
      workingDirectory: root,
      scope,
      branchName: 'C',
      sessionId: 'C',
      parent: 'main',
      sourceSessionId: 'MAIN',
    });
    await setActiveSessionBranch({ workingDirectory: root, scope, branchName: 'C' });
    await expect(
      resolveScopedContinueSessionState({ workingDirectory: root, context: scope }),
    ).resolves.toMatchObject({
      resolvedSessionId: 'C',
      settings: { subagent: 'pi' },
      activeBranch: { name: 'C' },
    });
  });
});
