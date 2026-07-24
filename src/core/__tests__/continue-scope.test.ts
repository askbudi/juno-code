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
  process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = path.join(dir, 'metadata');
  return dir;
}

afterEach(async () => {
  delete process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
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

  it('keeps same terminal marker isolated across different project roots', async () => {
    const projectA = await createTempDir();
    const projectB = await createTempDir();
    const env = { TERM_SESSION_ID: 'shared-terminal-session' };

    const scopeA = resolveContinueScopeContext(env, 4001, projectA);
    const scopeB = resolveContinueScopeContext(env, 4001, projectB);

    expect(scopeA.scopeHash).not.toBe(scopeB.scopeHash);
    expect(scopeA.sessionEnvKey).not.toBe(scopeB.sessionEnvKey);
    expect(scopeA.scopeDescriptor).toContain('PROJECT:');
    expect(scopeB.scopeDescriptor).toContain('PROJECT:');
  });

  it('keeps stable tmux pane scope deterministic when parent lineage changes', async () => {
    const workingDirectory = await createTempDir();
    const env = { TMUX_PANE: '%42' };

    const firstRun = resolveContinueScopeContext(env, 5001, workingDirectory);
    const continueRun = resolveContinueScopeContext(env, 5002, workingDirectory);

    expect(firstRun.scopeHash).toBe(continueRun.scopeHash);
    expect(firstRun.sessionEnvKey).toBe(continueRun.sessionEnvKey);
    expect(firstRun.scopeSource).toBe('project+stable_terminal+TMUX_PANE');
    expect(firstRun.scopeDescriptor).toContain('PROJECT:');
    expect(firstRun.scopeDescriptor).toContain('STABLE_TERMINAL:TMUX_PANE:%42');
    expect(firstRun.scopeDescriptor).not.toContain('SHELL_LINEAGE:');
  });

  it('keeps tmux pane scope independent from secondary terminal markers', async () => {
    const workingDirectory = await createTempDir();

    const firstRun = resolveContinueScopeContext(
      { TMUX_PANE: '%42', TERM_SESSION_ID: 'terminal-a', SSH_TTY: '/dev/ttys001' },
      5001,
      workingDirectory,
    );
    const continueRun = resolveContinueScopeContext(
      { TMUX_PANE: '%42', TERM_SESSION_ID: 'terminal-b', SSH_TTY: '/dev/ttys002' },
      5002,
      workingDirectory,
    );

    expect(firstRun.scopeHash).toBe(continueRun.scopeHash);
    expect(firstRun.scopeSource).toBe('project+stable_terminal+TMUX_PANE');
    expect(firstRun.scopeDescriptor).toContain('STABLE_TERMINAL:TMUX_PANE:%42');
    expect(firstRun.scopeDescriptor).not.toContain('TERM_SESSION_ID');
    expect(firstRun.scopeDescriptor).not.toContain('SSH_TTY');
    expect(firstRun.scopeDescriptor).not.toContain('SHELL_LINEAGE:');
  });

  it('keeps same project root isolated across different tmux panes', async () => {
    const workingDirectory = await createTempDir();

    const paneA = resolveContinueScopeContext({ TMUX_PANE: '%42' }, 5001, workingDirectory);
    const paneB = resolveContinueScopeContext({ TMUX_PANE: '%43' }, 5001, workingDirectory);

    expect(paneA.scopeHash).not.toBe(paneB.scopeHash);
    expect(paneA.scopeDescriptor).toContain('STABLE_TERMINAL:TMUX_PANE:%42');
    expect(paneB.scopeDescriptor).toContain('STABLE_TERMINAL:TMUX_PANE:%43');
  });

  it('keeps normal shells isolated across different shell lineages', async () => {
    const workingDirectory = await createTempDir();
    const env = {};

    const shellA = resolveContinueScopeContext(env, 5001, workingDirectory);
    const shellB = resolveContinueScopeContext(env, 5002, workingDirectory);

    expect(shellA.scopeHash).not.toBe(shellB.scopeHash);
    expect(shellA.scopeSource).toBe('project+shell_lineage');
    expect(shellA.scopeDescriptor).toContain('SHELL_LINEAGE:5001');
    expect(shellB.scopeDescriptor).toContain('SHELL_LINEAGE:5002');
    expect(shellA.scopeDescriptor).not.toContain('STABLE_TERMINAL:');
  });

  it('keeps explicit override deterministic independent of cwd and parent lineage', async () => {
    const projectA = await createTempDir();
    const projectB = await createTempDir();
    const env = {
      [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: 'automation-scope',
      TERM_SESSION_ID: 'ignored-terminal-session',
    };

    const scopeA = resolveContinueScopeContext(env, 6001, projectA);
    const scopeB = resolveContinueScopeContext(env, 6002, projectB);

    expect(scopeA.scopeSource).toBe(CONTINUE_SCOPE_OVERRIDE_ENV_KEY);
    expect(scopeA.scopeHash).toBe(scopeB.scopeHash);
    expect(scopeA.sessionEnvKey).toBe(scopeB.sessionEnvKey);
    expect(scopeA.scopeDescriptor).toBe(`${CONTINUE_SCOPE_OVERRIDE_ENV_KEY}:automation-scope`);
  });

  it('reports current hash and scoped env keys consistently for json-facing status', async () => {
    const workingDirectory = await createTempDir();
    const currentScope = resolveContinueScopeContext(
      { TERM_SESSION_ID: 'json-facing-scope' },
      7001,
      workingDirectory,
    );

    const status = await resolveContinueScopeStatus({
      workingDirectory,
      currentScope,
      env: {
        [currentScope.sessionEnvKey]: 'session-json',
        [currentScope.settingsEnvKey]: JSON.stringify({ version: 1, subagent: 'pi' }),
      },
    });

    expect(status.status).toBe('finished');
    expect(status.hash).toBe(currentScope.shortHash);
    expect(status.fullHash).toBe(currentScope.scopeHash);
    expect(status.sessionEnvKey).toBe(currentScope.sessionEnvKey);
    expect(status.settingsEnvKey).toBe(currentScope.settingsEnvKey);
    expect(status.sessionId).toBe('session-json');
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
