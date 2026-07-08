import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTINUE_SCOPE_OVERRIDE_ENV_KEY, resolveContinueScopeContext } from '../continue-scope.js';
import { resetMainSessionBranch, upsertClonedSessionBranch } from '../session-branches.js';
import {
  persistActiveSessionBranchSelection,
  persistContinueScopeSnapshot,
  resolveScopedContinueSessionState,
} from '../session-continuity-state.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-session-continuity-state-'));
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

describe('session-continuity-state', () => {
  it('persists the scoped env snapshot from one production writer while preserving settings', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({ [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'state-env' }, 1, workingDirectory);

    await persistContinueScopeSnapshot({
      workingDirectory,
      context,
      sessionId: 'SESSION_A',
      serializedSettings: '{"version":1,"subagent":"pi"}',
    });
    await persistContinueScopeSnapshot({
      workingDirectory,
      context,
      sessionId: 'SESSION_B',
    });

    const envFile = await fs.readFile(path.join(workingDirectory, '.env.juno'), 'utf-8');
    expect(envFile).toContain(`${context.sessionEnvKey}="SESSION_B"`);
    expect(envFile).toContain(`${context.settingsEnvKey}="{\\"version\\":1,\\"subagent\\":\\"pi\\"}"`);
  });

  it('switches active branch and scoped env snapshot as a single state operation', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({ [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'state-switch' }, 1, workingDirectory);

    await resetMainSessionBranch({ workingDirectory, scope: context, sessionId: 'SESSION_MAIN' });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope: context,
      branchName: 'C',
      sessionId: 'SESSION_C',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN',
    });

    const active = await persistActiveSessionBranchSelection({
      workingDirectory,
      context,
      branchName: 'C',
    });
    const state = await resolveScopedContinueSessionState({
      workingDirectory,
      context,
      env: process.env,
    });

    expect(active.name).toBe('C');
    expect(state.activeBranch?.name).toBe('C');
    expect(state.envSessionId).toBe('SESSION_C');
    expect(state.resolvedSessionId).toBe('SESSION_C');
    expect(state.hasEnvActiveBranchMismatch).toBe(false);
  });

  it('preserves scoped execution settings from env when branch switching creates the env file snapshot', async () => {
    const workingDirectory = await createTempDir();
    const context = resolveContinueScopeContext({ [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'state-switch-settings' }, 1, workingDirectory);
    const serializedSettings = '{"version":1,"subagent":"claude","maxIterations":5}';

    await resetMainSessionBranch({ workingDirectory, scope: context, sessionId: 'SESSION_MAIN' });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope: context,
      branchName: 'C',
      sessionId: 'SESSION_C',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN',
    });

    await persistActiveSessionBranchSelection({
      workingDirectory,
      context,
      env: {
        [context.settingsEnvKey]: serializedSettings,
      },
      branchName: 'C',
    });

    const envFile = await fs.readFile(path.join(workingDirectory, '.env.juno'), 'utf-8');
    expect(envFile).toContain(`${context.sessionEnvKey}="SESSION_C"`);
    expect(envFile).toContain(`${context.settingsEnvKey}="{\\"version\\":1,\\"subagent\\":\\"claude\\",\\"maxIterations\\":5}"`);
  });
});
