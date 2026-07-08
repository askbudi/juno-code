import * as path from 'node:path';
import fs from 'fs-extra';

import type { ContinueScopeContext } from './continue-scope.js';
import { resolveContinueScopeContext } from './continue-scope.js';
import {
  type ActiveSessionBranch,
  SessionBranchesError,
  getActiveSessionBranch,
  listSessionBranches,
  setActiveSessionBranch,
} from './session-branches.js';

const DEFAULT_CONTINUE_ENV_FILE_NAME = '.env.juno';

export interface SessionContinuityStateContext {
  workingDirectory: string;
  envFilePath?: string | undefined;
  context?: ContinueScopeContext | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ScopedContinueSessionState {
  context: ContinueScopeContext;
  envSessionId: string;
  activeBranch: ActiveSessionBranch | null;
  activeBranchSessionId: string;
  resolvedSessionId: string;
  hasEnvActiveBranchMismatch: boolean;
}

export interface PersistContinueScopeSnapshotOptions {
  workingDirectory: string;
  envFilePath?: string | undefined;
  context: ContinueScopeContext;
  sessionId: string;
  serializedSettings?: string | undefined;
}

export interface PersistActiveSessionBranchSelectionOptions extends SessionContinuityStateContext {
  branchName: string;
}

function resolveStateContext(options: SessionContinuityStateContext): ContinueScopeContext {
  return options.context || resolveContinueScopeContext(
    options.env || process.env,
    process.ppid,
    options.workingDirectory,
  );
}

function resolveContinueEnvFilePath(workingDirectory: string, configuredPath?: string): string {
  const candidate = configuredPath && configuredPath.trim() ? configuredPath.trim() : DEFAULT_CONTINUE_ENV_FILE_NAME;
  return path.isAbsolute(candidate) ? candidate : path.join(workingDirectory, candidate);
}

function upsertEnvVariable(content: string, key: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const line = `${key}="${escaped}"`;
  const pattern = new RegExp(`^(?:export\\s+)?${key}=.*$`, 'm');

  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  if (!content) {
    return `${line}\n`;
  }

  return `${content.replace(/\s*$/, '')}\n${line}\n`;
}

/**
 * Persist the shell-scoped continue snapshot.
 *
 * This is the production env-file writer for session-continuity state. Higher-level
 * operations in this module call it so user intents such as "switch branch" cannot
 * update the branch registry while forgetting the matching `.env.juno` snapshot.
 */
export async function persistContinueScopeSnapshot(
  options: PersistContinueScopeSnapshotOptions,
): Promise<void> {
  const sessionId = options.sessionId.trim();
  if (!sessionId) {
    throw new Error('Continue session id cannot be empty.');
  }

  process.env[options.context.sessionEnvKey] = sessionId;
  if (options.serializedSettings !== undefined) {
    process.env[options.context.settingsEnvKey] = options.serializedSettings;
  }

  const envFilePath = resolveContinueEnvFilePath(options.workingDirectory, options.envFilePath);
  await fs.ensureDir(path.dirname(envFilePath));

  let currentContent = '';
  if (await fs.pathExists(envFilePath)) {
    currentContent = await fs.readFile(envFilePath, 'utf-8');
  }

  currentContent = upsertEnvVariable(currentContent, options.context.sessionEnvKey, sessionId);
  if (options.serializedSettings !== undefined) {
    currentContent = upsertEnvVariable(currentContent, options.context.settingsEnvKey, options.serializedSettings);
  }

  await fs.writeFile(envFilePath, currentContent, 'utf-8');
}

export async function resolveScopedContinueSessionState(
  options: SessionContinuityStateContext,
): Promise<ScopedContinueSessionState> {
  const context = resolveStateContext(options);
  const env = options.env || process.env;
  const envSessionId = env[context.sessionEnvKey]?.trim() || '';
  const activeBranch = await getActiveSessionBranch({
    workingDirectory: options.workingDirectory,
    scope: context,
  });
  const activeBranchSessionId = activeBranch?.sessionId.trim() || '';

  return {
    context,
    envSessionId,
    activeBranch,
    activeBranchSessionId,
    resolvedSessionId: activeBranchSessionId || envSessionId,
    hasEnvActiveBranchMismatch: Boolean(
      envSessionId && activeBranchSessionId && envSessionId !== activeBranchSessionId,
    ),
  };
}

export async function persistActiveSessionBranchSelection(
  options: PersistActiveSessionBranchSelectionOptions,
): Promise<ActiveSessionBranch> {
  const context = resolveStateContext(options);
  let targetBranchName = options.branchName;

  if (targetBranchName === '+' || targetBranchName === '-') {
    const branches = await listSessionBranches({
      workingDirectory: options.workingDirectory,
      scope: context,
    });
    if (branches.length === 0) {
      throw new SessionBranchesError(`No named session branches found for continue scope ${context.scopeHash}.`);
    }
    const activeIndex = branches.findIndex((branch) => branch.active);
    const currentIndex = activeIndex >= 0 ? activeIndex : 0;
    const offset = targetBranchName === '+' ? 1 : -1;
    const nextIndex = (currentIndex + offset + branches.length) % branches.length;
    targetBranchName = branches[nextIndex]?.name ?? branches[0]?.name ?? 'main';
  }

  const active = await setActiveSessionBranch({
    workingDirectory: options.workingDirectory,
    scope: context,
    branchName: targetBranchName,
  });

  const env = options.env || process.env;
  const serializedSettings = env[context.settingsEnvKey]?.trim() || undefined;

  await persistContinueScopeSnapshot({
    workingDirectory: options.workingDirectory,
    envFilePath: options.envFilePath,
    context,
    sessionId: active.sessionId,
    serializedSettings,
  });

  return active;
}
