import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveContinueScopeContext } from '../../core/continue-scope.js';
import { ExecutionStatus, type ExecutionResult } from '../../core/engine.js';
import {
  applySessionContinuityRetention,
  listSessionBranches,
  loadSessionContinuityDocument,
  resetMainSessionBranch,
  setActiveSessionBranch,
  upsertClonedSessionBranch,
  persistContinueScopeSnapshot,
} from '../../core/session-continuity-state.js';
import {
  prepareSessionBranchExecution,
  syncSessionBranchExecutionResult,
} from '../session-branch-workflow.js';
import type { MainCommandOptions } from '../types.js';

const tempDirs: string[] = [];
const ORIGINAL_SCOPE = process.env.YYLO_CONTINUE_SCOPE;
const ORIGINAL_METADATA_DIRECTORY = process.env.YYLO_SESSION_METADATA_DIRECTORY;
const ORIGINAL_SESSION_ENV = new Map<string, string | undefined>();
const ORIGINAL_SETTINGS_ENV = new Map<string, string | undefined>();

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-branch-workflow-'));
  tempDirs.push(dir);
  process.env.YYLO_SESSION_METADATA_DIRECTORY = path.join(dir, 'metadata');
  return dir;
}

function setScope(scope: string) {
  process.env.YYLO_CONTINUE_SCOPE = scope;
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
    delete process.env.YYLO_CONTINUE_SCOPE;
  } else {
    process.env.YYLO_CONTINUE_SCOPE = ORIGINAL_SCOPE;
  }
  if (ORIGINAL_METADATA_DIRECTORY === undefined) delete process.env.YYLO_SESSION_METADATA_DIRECTORY;
  else process.env.YYLO_SESSION_METADATA_DIRECTORY = ORIGINAL_METADATA_DIRECTORY;
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
  it('routes only from canonical state and ignores superseded env branch snapshots', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-canonical-routing');
    process.env[scope.sessionEnvKey] = 'STALE_ENV_SESSION';
    process.env[scope.settingsEnvKey] = JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 99 });
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'C' });
    await persistContinueScopeSnapshot({ workingDirectory, context: scope, sessionId: 'SESSION_C', serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 5 }) });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });
    expect(options.resume).toBe('SESSION_C');
    expect(options.maxIterations).toBe(5);
  });

  it('continues safely when scoped env snapshot and active branch session match', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-env-branch-match');
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'C' });
    await persistContinueScopeSnapshot({ workingDirectory, context: scope, sessionId: 'SESSION_C', serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 6 }) });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_C');
    expect(options.maxIterations).toBe(6);
  });

  it('continues from only the scoped env snapshot when no named branches exist', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-env-only');
    await persistContinueScopeSnapshot({ workingDirectory, context: scope, sessionId: 'SESSION_ONLY', serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 4 }) });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_ONLY');
    expect(options.maxIterations).toBe(4);
  });

  it('continues from only the active branch when settings exist but the env session snapshot is absent', async () => {
    const workingDirectory = await createTempDir();
    const scope = setScope('continue-branch-only');
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'D' });
    await persistContinueScopeSnapshot({ workingDirectory, context: scope, sessionId: 'SESSION_D', serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 8 }) });

    const options = { continueFromLatest: true } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('SESSION_D');
    expect(options.maxIterations).toBe(8);
  });

  it('prepares continue from the active branch in only the current shell scope so another pane cannot hijack routing', async () => {
    const workingDirectory = await createTempDir();
    const scopeA = setScope('pane-a');
    await seedBranches(workingDirectory, scopeA);
    await setActiveSessionBranch({ workingDirectory, scope: scopeA, branchName: 'C' });
    await persistContinueScopeSnapshot({ workingDirectory, context: scopeA, sessionId: 'SESSION_C', serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 7 }) });

    const scopeB = setScope('pane-b');
    await resetMainSessionBranch({ workingDirectory, scope: scopeB, sessionId: 'B_MAIN' });
    await persistContinueScopeSnapshot({ workingDirectory, context: scopeB, sessionId: 'B_MAIN', serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', maxIterations: 3 }) });

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
    await seedBranches(workingDirectory, scope);
    await setActiveSessionBranch({ workingDirectory, scope, branchName: 'D' });
    await persistContinueScopeSnapshot({
      workingDirectory,
      context: scope,
      sessionId: 'SESSION_D',
      serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', model: ':gpt', maxIterations: 9, thinking: 'high', tools: ['read', 'bash'] }),
    });

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
    await seedBranches(workingDirectory, scope);
    await persistContinueScopeSnapshot({
      workingDirectory,
      context: scope,
      sessionId: 'SESSION_MAIN',
      serializedSettings: JSON.stringify({ version: 1, subagent: 'pi', model: ':gpt', maxIterations: 9 }),
    });

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

  it('keeps explicit resume available after implicit metadata expires without using another scope', async () => {
    const workingDirectory = await createTempDir();
    const expired = setScope('expired-implicit');
    await resetMainSessionBranch({
      workingDirectory,
      scope: expired,
      sessionId: 'EXPIRED_IMPLICIT',
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    const current = setScope('explicit-recovery');
    await applySessionContinuityRetention({
      workingDirectory,
      currentScopeHash: current.scopeHash,
      now: new Date('2026-07-30T00:00:00.000Z'),
      provenLiveScopeHashes: new Set(),
    });

    const options = { resume: 'OWNER_SELECTED', prompt: 'recover' } as MainCommandOptions;
    await prepareSessionBranchExecution(options, { workingDirectory });

    expect(options.resume).toBe('OWNER_SELECTED');
    expect((await loadSessionContinuityDocument(workingDirectory)).scopes[expired.scopeHash]).toBeUndefined();
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
      { ...completedPiResult(), status: ExecutionStatus.FAILED },
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
