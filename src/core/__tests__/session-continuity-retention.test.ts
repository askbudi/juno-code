import * as os from 'node:os';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildChildProcessEnvironment,
  isContinuityEnvironmentKey,
} from '../child-process-environment.js';
import {
  clearContinueScopeRunning,
  markContinueScopeRunning,
  resolveContinueScopeContext,
} from '../continue-scope.js';
import {
  CONTINUITY_INACTIVE_SCOPE_LIMIT,
  CONTINUITY_SCOPE_TTL_DAYS,
  applySessionContinuityRetention,
  getSessionContinuityFilePath,
  loadSessionContinuityDocument,
  persistContinueScopeSnapshot,
  type SessionContinuityDocument,
  type SessionContinuityScope,
} from '../session-continuity-state.js';

const roots: string[] = [];
const originalMetadata = process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
const NOW = new Date('2026-07-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1_000;

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-retention-'));
  roots.push(root);
  process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = path.join(root, 'metadata');
  return root;
}
function hash(index: number): string {
  return `SCOPE_${index.toString(16).toUpperCase().padStart(16, '0')}`;
}
function scope(at: Date, options: { pinned?: boolean; named?: boolean } = {}): SessionContinuityScope {
  const timestamp = at.toISOString();
  return {
    source: 'fixture',
    createdAt: timestamp,
    lastUsedAt: timestamp,
    pinned: options.pinned ?? false,
    settings: { version: 1, subagent: 'pi' },
    active: 'main',
    branches: {
      main: { session_id: 'REDACTED_FIXTURE', parent: null, updated_at: timestamp },
      ...(options.named
        ? { review: { session_id: 'REDACTED_NAMED', parent: 'main', updated_at: timestamp } }
        : {}),
    },
  };
}
async function seed(root: string, scopes: Record<string, SessionContinuityScope>): Promise<void> {
  const document: SessionContinuityDocument = { version: 2, scopes };
  await fs.ensureDir(path.dirname(getSessionContinuityFilePath(root)));
  await fs.writeJson(getSessionContinuityFilePath(root), document);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.remove(root);
  if (originalMetadata === undefined) delete process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
  else process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = originalMetadata;
});

describe('automatic session continuity retention', () => {
  it('uses a deterministic 30-day TTL and LRU-retains only the 128 newest inactive scopes', async () => {
    const root = await fixture();
    const scopes: Record<string, SessionContinuityScope> = {};
    scopes[hash(1)] = scope(new Date(NOW.getTime() - (CONTINUITY_SCOPE_TTL_DAYS + 1) * DAY));
    for (let index = 2; index < 2 + CONTINUITY_INACTIVE_SCOPE_LIMIT + 3; index += 1) {
      scopes[hash(index)] = scope(new Date(NOW.getTime() - index * 1_000));
    }
    await seed(root, scopes);

    const result = await applySessionContinuityRetention({
      workingDirectory: root,
      currentScopeHash: hash(2),
      now: NOW,
      provenLiveScopeHashes: new Set(),
    });
    const retained = await loadSessionContinuityDocument(root);

    expect(result).toMatchObject({ expired: 1, lru: 2, protectedOverflow: false });
    expect(Object.keys(retained.scopes)).toHaveLength(CONTINUITY_INACTIVE_SCOPE_LIMIT + 1);
    expect(retained.scopes[hash(2)]).toBeDefined();
    expect(retained.scopes[hash(1)]).toBeUndefined();
    expect(retained.scopes[hash(CONTINUITY_INACTIVE_SCOPE_LIMIT + 4)]).toBeUndefined();
  });

  it('protects current, proven-live, pinned, and named-branch scopes; protected overflow warns and retains without values', async () => {
    const root = await fixture();
    const old = new Date(NOW.getTime() - 40 * DAY);
    const scopes: Record<string, SessionContinuityScope> = {
      [hash(1)]: scope(old),
      [hash(2)]: scope(old),
      [hash(3)]: scope(old, { pinned: true }),
      [hash(4)]: scope(old, { named: true }),
    };
    for (let index = 5; index < 5 + CONTINUITY_INACTIVE_SCOPE_LIMIT + 1; index += 1) {
      scopes[hash(index)] = scope(old, { pinned: true });
    }
    await seed(root, scopes);
    const warnings: string[] = [];

    const result = await applySessionContinuityRetention({
      workingDirectory: root,
      currentScopeHash: hash(1),
      now: NOW,
      provenLiveScopeHashes: new Set([hash(2)]),
      warn: (message) => warnings.push(message),
    });
    const retained = await loadSessionContinuityDocument(root);

    expect(retained.scopes[hash(1)]).toBeDefined();
    expect(retained.scopes[hash(2)]).toBeDefined();
    expect(retained.scopes[hash(3)]).toBeDefined();
    expect(retained.scopes[hash(4)]).toBeDefined();
    expect(result.protectedOverflow).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/count|protected|limit/i);
    expect(warnings[0]).not.toMatch(/SCOPE_|REDACTED|session/i);
  });

  it('runs automatically under the write lock after a successful snapshot write', async () => {
    const root = await fixture();
    const scopes: Record<string, SessionContinuityScope> = {};
    for (let index = 1; index <= CONTINUITY_INACTIVE_SCOPE_LIMIT + 12; index += 1) {
      scopes[hash(index)] = scope(new Date(NOW.getTime() - index * 1_000));
    }
    await seed(root, scopes);
    const current = resolveContinueScopeContext({ JUNO_CODE_CONTINUE_SCOPE: 'automatic' }, 1, root);

    await persistContinueScopeSnapshot({
      workingDirectory: root,
      context: current,
      sessionId: 'CURRENT',
      serializedSettings: JSON.stringify({ version: 1, subagent: 'pi' }),
      now: NOW,
    });

    expect(Object.keys((await loadSessionContinuityDocument(root)).scopes)).toHaveLength(
      CONTINUITY_INACTIVE_SCOPE_LIMIT + 1,
    );
  });

  it('proves live protection from the shared runtime marker without inspecting provider files', async () => {
    const root = await fixture();
    const live = resolveContinueScopeContext({ JUNO_CODE_CONTINUE_SCOPE: 'live' }, 1, root);
    const current = resolveContinueScopeContext({ JUNO_CODE_CONTINUE_SCOPE: 'current-live-test' }, 1, root);
    await seed(root, { [live.scopeHash]: scope(new Date(NOW.getTime() - 40 * DAY)) });
    await markContinueScopeRunning(root, live, process.pid);

    await applySessionContinuityRetention({
      workingDirectory: root,
      currentScopeHash: current.scopeHash,
      now: NOW,
    });
    expect((await loadSessionContinuityDocument(root)).scopes[live.scopeHash]).toBeDefined();
    await clearContinueScopeRunning(root, live);
  });

  it('does not auto-pin an explicit override and serializes retention with a concurrent writer', async () => {
    const root = await fixture();
    const override = resolveContinueScopeContext({ JUNO_CODE_CONTINUE_SCOPE: 'temporary-name' }, 1, root);
    const current = resolveContinueScopeContext({ JUNO_CODE_CONTINUE_SCOPE: 'current' }, 1, root);
    await persistContinueScopeSnapshot({
      workingDirectory: root,
      context: override,
      sessionId: 'OVERRIDE_SESSION',
      serializedSettings: JSON.stringify({ version: 1, subagent: 'pi' }),
      now: new Date(NOW.getTime() - 40 * DAY),
    });

    await Promise.all([
      applySessionContinuityRetention({
        workingDirectory: root,
        currentScopeHash: current.scopeHash,
        now: NOW,
        provenLiveScopeHashes: new Set(),
      }),
      persistContinueScopeSnapshot({
        workingDirectory: root,
        context: current,
        sessionId: 'CURRENT_SESSION',
        serializedSettings: JSON.stringify({ version: 1, subagent: 'pi' }),
        now: NOW,
      }),
    ]);

    const retained = await loadSessionContinuityDocument(root);
    expect(retained.scopes[override.scopeHash]).toBeUndefined();
    expect(retained.scopes[current.scopeHash]).toBeDefined();
    expect(retained.scopes[current.scopeHash]?.pinned).toBe(false);
  });

  it('bounds a 2,500-scope persisted fixture and keeps child continuity overhead at zero', async () => {
    const root = await fixture();
    const scopes: Record<string, SessionContinuityScope> = {};
    const ambientPath = process.env.PATH ?? '/usr/bin';
    const env: NodeJS.ProcessEnv = {
      PATH: ambientPath,
      JUNO_CODE_LAST_SESSION_ID: 'HIDDEN_LEGACY_SESSION',
      JUNO_CODE_LAST_EXECUTION_SETTINGS: 'HIDDEN_LEGACY_SETTINGS',
    };
    for (let index = 1; index <= 2_500; index += 1) {
      scopes[hash(index)] = scope(new Date(NOW.getTime() - index * 1_000));
      env[`JUNO_CODE_LAST_SESSION_ID_${hash(index)}`] = 'HIDDEN';
      env[`JUNO_CODE_LAST_EXECUTION_SETTINGS_${hash(index)}`] = 'HIDDEN';
    }
    await seed(root, scopes);

    await applySessionContinuityRetention({
      workingDirectory: root,
      currentScopeHash: hash(1),
      now: NOW,
      provenLiveScopeHashes: new Set(),
    });
    const retained = await loadSessionContinuityDocument(root);
    const child = buildChildProcessEnvironment(env);
    const sourceContinuityNames = Object.keys(env).filter(isContinuityEnvironmentKey).sort();
    const childContinuityNames = Object.keys(child).filter(isContinuityEnvironmentKey).sort();
    const childContinuitySerializedBytes = Buffer.byteLength(
      childContinuityNames.map((name) => `${name}=${child[name] ?? ''}\0`).join(''),
      'utf8',
    );

    expect(Object.keys(retained.scopes)).toHaveLength(CONTINUITY_INACTIVE_SCOPE_LIMIT + 1);
    expect(sourceContinuityNames).toHaveLength(2_500 * 2 + 2);
    expect(sourceContinuityNames).toContain('JUNO_CODE_LAST_SESSION_ID');
    expect(sourceContinuityNames).toContain('JUNO_CODE_LAST_EXECUTION_SETTINGS');
    expect(childContinuityNames).toEqual([]);
    expect(childContinuityNames).toHaveLength(0);
    expect(childContinuitySerializedBytes).toBe(0);
    expect(child.PATH).toBe(ambientPath);
  });
});
