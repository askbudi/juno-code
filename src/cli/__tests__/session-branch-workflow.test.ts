import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveContinueScopeContext } from '../../core/continue-scope.js';
import { ExecutionStatus, type ExecutionResult } from '../../core/engine.js';
import {
  listSessionBranches,
  resetMainSessionBranch,
  setActiveSessionBranch,
  upsertClonedSessionBranch,
} from '../../core/session-branches.js';
import {
  prepareSessionBranchExecution,
  syncSessionBranchExecutionResult,
} from '../session-branch-workflow.js';
import type { MainCommandOptions } from '../types.js';

const tempDirs: string[] = [];
const ORIGINAL_SCOPE = process.env.JUNO_CODE_CONTINUE_SCOPE;
const ORIGINAL_SESSION_ENV = new Map<string, string | undefined>();
const ORIGINAL_SETTINGS_ENV = new Map<string, string | undefined>();

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-branch-workflow-'));
  tempDirs.push(dir);
  return dir;
}

function setScope(scope: string) {
  process.env.JUNO_CODE_CONTINUE_SCOPE = scope;
  const context = resolveContinueScopeContext();
  ORIGINAL_SESSION_ENV.set(context.sessionEnvKey, process.env[context.sessionEnvKey]);
  ORIGINAL_SETTINGS_ENV.set(context.settingsEnvKey, process.env[context.settingsEnvKey]);
  return context;
}

function restoreEnvKey(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function completedPiResult(cloneSession = false): ExecutionResult {
  return {
    request: { requestId: 'request-1', instruction: 'prompt', subagent: 'pi', cloneSession } as any,
    status: ExecutionStatus.COMPLETED,
    iterations: [],
    statistics: {} as any,
  };
}

async function seedBranches(workingDirectory: string, scope = resolveContinueScopeContext()) {
  await resetMainSessionBranch({ workingDirectory, scope, sessionId: 'SESSION_MAIN' });
  await upsertClonedSessionBranch({
    workingDirectory,
    scope,
    branchName: 'C',
    sessionId: 'SESSION_C',
    parent: 'main',
    sourceSessionId: 'SESSION_MAIN',
  });
  await upsertClonedSessionBranch({
    workingDirectory,
    scope,
    branchName: 'D',
    sessionId: 'SESSION_D',
    parent: 'main',
    sourceSessionId: 'SESSION_MAIN',
  });
}

afterEach(async () => {
  if (ORIGINAL_SCOPE === undefined) {
    delete process.env.JUNO_CODE_CONTINUE_SCOPE;
  } else {
    process.env.JUNO_CODE_CONTINUE_SCOPE = ORIGINAL_SCOPE;
  }
  for (const [key, value] of ORIGINAL_SESSION_ENV.entries()) restoreEnvKey(key, value);
  for (const [key, value] of ORIGINAL_SETTINGS_ENV.entries()) restoreEnvKey(key, value);
  ORIGINAL_SESSION_ENV.clear();
  ORIGINAL_SETTINGS_ENV.clear();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.remove(dir);
  }
});

describe('session branch workflow', () => {
  it('fails continueFromLatest when scoped env snapshot differs from the active branch session', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-env-branch-mismatch');
    process.env[scope.sessionEnvKey] = 'SESSION_ENV';
    process.env[scope.settingsEnvKey] = JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 5 });
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'C' });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await expect(prepareSessionBranchExecution(options, { workingDirectory })).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringContaining('Continue session mismatch for this shell context'),
      suggestions: expect.arrayContaining([
        expect.stringContaining('juno-code continue-scope --json'),
        expect.stringContaining('juno-code branches'),
      ]),
    });

    await expect(prepareSessionBranchExecution(options, { workingDirectory })).rejects.toThrow(/SESSION_ENV/);
    await expect(prepareSessionBranchExecution(options, { workingDirectory })).rejects.toThrow(/active branch 'C'/);
    await expect(prepareSessionBranchExecution(options, { workingDirectory })).rejects.toThrow(/SESSION_C/);
    await expect(prepareSessionBranchExecution(options, { workingDirectory })).rejects.toThrow(new RegExp(scope.scopeHash));
    expect(options.resume).toBeUndefined();
  });

  it('continues safely when scoped env snapshot and active branch session match', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-env-branch-match');
    process.env[scope.sessionEnvKey] = 'SESSION_C';
    process.env[scope.settingsEnvKey] = JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 6 });
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'C' });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_C');
    expect(options.maxIterations).toBe(6);
  });

  it('continues from only the scoped env snapshot when no named branches exist', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-env-only');
    process.env[scope.sessionEnvKey] = 'SESSION_ENV_ONLY';
    process.env[scope.settingsEnvKey] = JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 4 });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_ENV_ONLY');
    expect(options.maxIterations).toBe(4);
  });

  it('continues from only the active branch when settings exist but the env session snapshot is absent', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-branch-only');
    process.env[scope.settingsEnvKey] = JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 8 });
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'D' });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_D');
    expect(options.maxIterations).toBe(8);
  });

  it('prepares continue from the active branch in only the current shell scope so another pane cannot hijack routing', async () => {
    const workingDirectory = await createTempDir();
    const scopeA = setScope('pane-a');
    process.env[scopeA.settingsEnvKey] = JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 7 });
    await seedBranches(workingDirectory, scopeA);
    await setActiveSessionBranch({ workingDirectory, scope: scopeA, branchName: 'C' });

    const scopeB = setScope('pane-b');
    process.env[scopeB.settingsEnvKey] = JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 3 });
    await resetMainSessionBranch({ workingDirectory, scope: scopeB, sessionId: 'B_MAIN' });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('B_MAIN');
    expect(options.maxIterations).toBe(3);
  });

  it('prepares clone --name from main instead of active D so experimental forks start from the root branch by default', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('clone-defaults-main');
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'D' });

    const options = {
      continueFromLatest: true,
      clone: true,
      cloneBranchName: 'C',
      prompt: 'fork from root',
    } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_MAIN');
    expect(options.cloneFromSession).toBe('SESSION_MAIN');
    expect(options.cloneSession).toBe(true);
    expect(options.subagent).toBe('pi');
  });

  it('auto-names unnamed clones with the first available b-number branch from main', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('clone-auto-name');
    await resetMainSessionBranch({ workingDirectory, scope, sessionId: 'SESSION_MAIN' });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope,
      branchName: 'b1',
      sessionId: 'SESSION_B1',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN',
    });
    await upsertClonedSessionBranch({
      workingDirectory,
      scope,
      branchName: 'b3',
      sessionId: 'SESSION_B3',
      parent: 'main',
      sourceSessionId: 'SESSION_MAIN',
    });

    const options = {
      continueFromLatest: true,
      clone: true,
      prompt: 'unnamed fork',
    } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.cloneBranchName).toBe('b2');
    expect(options.cloneBranchFrom).toBe('main');
    expect(options.resume).toBe('SESSION_MAIN');
    expect(options.cloneFromSession).toBe('SESSION_MAIN');
    expect(options.cloneSession).toBe(true);
    expect(options.subagent).toBe('pi');
  });

  it('prepares named clone with saved runtime settings while keeping the branch-selected source session', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('clone-settings-preserved');
    process.env[scope.settingsEnvKey] = JSON.stringify({
      version: 1,
      subagent: 'pi',
      model: ':gpt',
      maxIterations: 9,
      thinking: 'high',
      tools: ['read', 'bash'],
    });
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'D' });

    const options = {
      continueFromLatest: true,
      clone: true,
      cloneBranchName: 'C',
      prompt: 'fork with current settings',
    } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_MAIN');
    expect(options.cloneFromSession).toBe('SESSION_MAIN');
    expect(options.model).toBe(':gpt');
    expect(options.maxIterations).toBe(9);
    expect(options.thinking).toBe('high');
    expect(options.tools).toEqual(['read', 'bash']);
  });

  it('keeps explicit named clone runtime overrides ahead of saved continue-scope settings', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('clone-settings-overrides');
    process.env[scope.settingsEnvKey] = JSON.stringify({
      version: 1,
      subagent: 'pi',
      model: ':gpt',
      maxIterations: 9,
    });
    await seedBranches(workingDirectory, scope);

    const options = {
      continueFromLatest: true,
      clone: true,
      cloneBranchName: 'C',
      prompt: 'fork with explicit settings',
      model: ':sonnet',
      maxIterations: 2,
    } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_MAIN');
    expect(options.cloneFromSession).toBe('SESSION_MAIN');
    expect(options.model).toBe(':sonnet');
    expect(options.maxIterations).toBe(2);
  });

  it('syncs named clone overrides without switching active so recreating C does not steal the current branch', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('clone-override-active');
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'D' });

    await syncSessionBranchExecutionResult(
      completedPiResult(true),
      { workingDirectory },
      { cloneBranchName: 'C', cloneBranchFrom: 'main', cloneSession: true } as MainCommandOptions,
      'SESSION_C_REPLACEMENT',
    );

    await expect(listSessionBranches({ workingDirectory, scope })).resolves.toEqual([
      expect.objectContaining({ name: 'main', active: false, sessionId: 'SESSION_MAIN' }),
      expect.objectContaining({ name: 'C', active: false, sessionId: 'SESSION_C_REPLACEMENT' }),
      expect.objectContaining({ name: 'D', active: true, sessionId: 'SESSION_D' }),
    ]);
  });

  it('syncs successful continue to only active C so main remains a stable source for future clones', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-updates-active-only');
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'C' });

    await syncSessionBranchExecutionResult(
      completedPiResult(),
      { workingDirectory },
      { continueFromLatest: true, resume: 'SESSION_C' } as MainCommandOptions,
      'SESSION_C_NEXT',
    );

    await expect(listSessionBranches({ workingDirectory, scope })).resolves.toEqual([
      expect.objectContaining({ name: 'main', active: false, sessionId: 'SESSION_MAIN' }),
      expect.objectContaining({ name: 'C', active: true, sessionId: 'SESSION_C_NEXT' }),
      expect.objectContaining({ name: 'D', active: false, sessionId: 'SESSION_D' }),
    ]);
  });

  it('syncs explicit --resume without clone by resetting stale branches so a new topic cannot inherit C or D', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('explicit-resume-resets');
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'C' });

    await syncSessionBranchExecutionResult(
      completedPiResult(),
      { workingDirectory },
      { resume: 'EXTERNAL_SESSION' } as MainCommandOptions,
      'EXTERNAL_NEXT',
    );

    await expect(listSessionBranches({ workingDirectory, scope })).resolves.toEqual([
      expect.objectContaining({ name: 'main', active: true, sessionId: 'EXTERNAL_NEXT' }),
    ]);
  });

  it('does not reset named branches for --resume --clone because clone runs are forks, not new roots', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('explicit-clone-preserves');
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'C' });

    await syncSessionBranchExecutionResult(
      completedPiResult(true),
      { workingDirectory },
      { resume: 'EXTERNAL_SESSION', cloneSession: true } as MainCommandOptions,
      'CLONE_NEXT',
    );

    await expect(listSessionBranches({ workingDirectory, scope })).resolves.toEqual([
      expect.objectContaining({ name: 'main', active: false, sessionId: 'SESSION_MAIN' }),
      expect.objectContaining({ name: 'C', active: true, sessionId: 'SESSION_C' }),
      expect.objectContaining({ name: 'D', active: false, sessionId: 'SESSION_D' }),
    ]);
  });

  it('skips branch sync when the provider result has no session id so failures cannot advance hidden state', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('missing-session-noop');
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'C' });

    await syncSessionBranchExecutionResult(
      completedPiResult(),
      { workingDirectory },
      { continueFromLatest: true, resume: 'SESSION_C' } as MainCommandOptions,
      undefined,
    );

    await expect(listSessionBranches({ workingDirectory, scope })).resolves.toEqual([
      expect.objectContaining({ name: 'main', active: false, sessionId: 'SESSION_MAIN' }),
      expect.objectContaining({ name: 'C', active: true, sessionId: 'SESSION_C' }),
      expect.objectContaining({ name: 'D', active: false, sessionId: 'SESSION_D' }),
    ]);
  });
});
