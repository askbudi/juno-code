import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTINUE_SCOPE_OVERRIDE_ENV_KEY,
  clearContinueScopeRunning,
  markContinueScopeRunning,
  resolveContinueScopeContext,
  resolveContinueScopeStatus,
} from '../continue-scope.js';

const CONTINUE_SESSION_ENV_KEY_BASE = 'JUNO_CODE_LAST_SESSION_ID';
const CONTINUE_SETTINGS_ENV_KEY_BASE = 'JUNO_CODE_LAST_EXECUTION_SETTINGS';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-continue-scope-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.remove(dir);
    }
  }
});

describe('continue-scope', () => {
  it('resolves deterministic full + short hashes from override scope', () => {
    const context = resolveContinueScopeContext({
      [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'pane-a',
    });

    expect(context.scopeSource).toBe(CONTINUE_SCOPE_OVERRIDE_ENV_KEY);
    expect(context.scopeHash).toMatch(/^SCOPE_[A-F0-9]{16}$/);
    expect(context.shortHash).toMatch(/^[A-F0-9]{6}$/);
    expect(context.sessionEnvKey).toBe(`${CONTINUE_SESSION_ENV_KEY_BASE}_${context.scopeHash}`);
    expect(context.settingsEnvKey).toBe(`${CONTINUE_SETTINGS_ENV_KEY_BASE}_${context.scopeHash}`);
  });

  it('reports running when runtime marker pid is alive', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({
      [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'running-pane',
    });

    await markContinueScopeRunning(workingDirectory, context, process.pid);

    const status = await resolveContinueScopeStatus({
      workingDirectory,
      currentScope: context,
      env: {
        [context.sessionEnvKey]: 'session-123',
        [context.settingsEnvKey]: JSON.stringify({ version: 1, subagent: 'claude' }),
      },
    });

    expect(status.status).toBe('running');
    expect(status.pid).toBe(process.pid);
    expect(status.hash).toBe(context.shortHash);
  });

  it('reports finished when snapshot session/settings exist', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({
      [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'finished-pane',
    });

    const status = await resolveContinueScopeStatus({
      workingDirectory,
      currentScope: context,
      env: {
        [context.sessionEnvKey]: 'session-finished',
        [context.settingsEnvKey]: JSON.stringify({ version: 1, subagent: 'pi' }),
      },
    });

    expect(status.status).toBe('finished');
    expect(status.sessionId).toBe('session-finished');
  });

  it('reports not_found when no snapshot exists for scope hash', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({
      [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'missing-pane',
    });

    const status = await resolveContinueScopeStatus({
      workingDirectory,
      currentScope: context,
      env: {},
    });

    expect(status.status).toBe('not_found');
    expect(status.sessionId).toBeNull();
  });

  it('reports error when session exists but settings snapshot is invalid', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({
      [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'invalid-pane',
    });

    const status = await resolveContinueScopeStatus({
      workingDirectory,
      currentScope: context,
      env: {
        [context.sessionEnvKey]: 'session-bad',
        [context.settingsEnvKey]: '{broken-json',
      },
    });

    expect(status.status).toBe('error');
    expect(status.reason).toBe('invalid_snapshot');
  });

  it('can resolve status by short hash lookup', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({
      [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'lookup-pane',
    });

    const status = await resolveContinueScopeStatus({
      workingDirectory,
      currentScope: context,
      requestedHash: context.shortHash,
      env: {
        [context.sessionEnvKey]: 'session-lookup',
        [context.settingsEnvKey]: JSON.stringify({ version: 1, subagent: 'claude' }),
      },
    });

    expect(status.status).toBe('finished');
    expect(status.fullHash).toBe(context.scopeHash);
  });

  it('clears running marker and falls back to snapshot status', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({
      [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'clear-pane',
    });

    await markContinueScopeRunning(workingDirectory, context, process.pid);
    await clearContinueScopeRunning(workingDirectory, context);

    const status = await resolveContinueScopeStatus({
      workingDirectory,
      currentScope: context,
      env: {
        [context.sessionEnvKey]: 'session-clear',
        [context.settingsEnvKey]: JSON.stringify({ version: 1, subagent: 'codex' }),
      },
    });

    expect(status.status).toBe('finished');
    expect(status.pid).toBeNull();
  });
});
