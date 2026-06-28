import { resolveContinueScopeContext } from '../core/continue-scope.js';
import {
  MAIN_SESSION_BRANCH,
  SessionBranchesError,
  getActiveSessionBranch,
  listSessionBranches,
  resetMainSessionBranch,
  updateActiveSessionBranch,
  upsertClonedSessionBranch,
  validateSessionBranchName,
} from '../core/session-branches.js';
import type { ExecutionResult } from '../core/engine.js';
import { ExecutionStatus } from '../core/engine.js';
import type { SubagentType } from '../types/index.js';
import type { MainCommandOptions } from './types.js';
import { ValidationError } from './types.js';

export const CONTINUE_SETTINGS_VERSION = 1;

export interface ContinueSettingsSnapshot {
  version: number;
  subagent: SubagentType;
  model?: string;
  maxIterations?: number;
  thinking?: string;
  live?: boolean;
  agents?: string;
  tools?: string[];
  allowedTools?: string[];
  appendAllowedTools?: string[];
  disallowedTools?: string[];
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function parseContinueSettingsSnapshot(raw: string): ContinueSettingsSnapshot | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;

  const subagent = parsed.subagent;
  const validSubagents: SubagentType[] = ['claude', 'cursor', 'codex', 'gemini', 'pi'];
  if (typeof subagent !== 'string' || !validSubagents.includes(subagent as SubagentType)) {
    return null;
  }

  const snapshot: ContinueSettingsSnapshot = {
    version: toNumber(parsed.version) ?? CONTINUE_SETTINGS_VERSION,
    subagent: subagent as SubagentType,
  };

  if (typeof parsed.model === 'string' && parsed.model.trim()) snapshot.model = parsed.model.trim();
  const maxIterations = toNumber(parsed.maxIterations);
  if (maxIterations !== null) snapshot.maxIterations = maxIterations;
  if (typeof parsed.thinking === 'string' && parsed.thinking.trim()) snapshot.thinking = parsed.thinking.trim();
  if (typeof parsed.live === 'boolean') snapshot.live = parsed.live;
  if (typeof parsed.agents === 'string' && parsed.agents.trim()) snapshot.agents = parsed.agents;

  const tools = toStringArray(parsed.tools);
  if (tools) snapshot.tools = tools;
  const allowedTools = toStringArray(parsed.allowedTools);
  if (allowedTools) snapshot.allowedTools = allowedTools;
  const appendAllowedTools = toStringArray(parsed.appendAllowedTools);
  if (appendAllowedTools) snapshot.appendAllowedTools = appendAllowedTools;
  const disallowedTools = toStringArray(parsed.disallowedTools);
  if (disallowedTools) snapshot.disallowedTools = disallowedTools;

  return snapshot;
}

function isTruthyEnvironmentFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

async function applyContinueContextFromEnvironment(
  options: MainCommandOptions,
  action = 'continue',
  workingDirectory?: string,
): Promise<void> {
  const continueScope = resolveContinueScopeContext();
  let sessionId = process.env[continueScope.sessionEnvKey]?.trim();

  if (workingDirectory) {
    const activeBranch = await getActiveSessionBranch({ workingDirectory, scope: continueScope });
    if (activeBranch) {
      sessionId = activeBranch.sessionId;
    }
  }

  if (!sessionId) {
    const commandHint = action === 'clone' ? 'clone' : 'continue';
    throw new ValidationError(`No previous session found to ${commandHint} in this shell context`, [
      `Run a regular juno-code command in this same pane/tab first (scope source: ${continueScope.scopeSource})`,
      action === 'clone'
        ? 'Or clone an explicit Pi session: juno-code --resume <session-id> --clone "your prompt"'
        : 'Or resume another session directly: juno-code --resume <session-id> "your next prompt"',
    ]);
  }

  const rawSettings = process.env[continueScope.settingsEnvKey];
  const settings = rawSettings ? parseContinueSettingsSnapshot(rawSettings) : null;
  if (!settings) {
    throw new ValidationError('Previous execution settings are missing or invalid for this shell context', [
      'Run a regular juno-code command again in this pane/tab to refresh the continue snapshot',
      'Then retry: juno-code continue "your next prompt"',
    ]);
  }

  options.resume = options.resume || sessionId;
  if (!options.subagent) options.subagent = settings.subagent;
  if (options.model === undefined && settings.model) options.model = settings.model;
  if (options.maxIterations === undefined && settings.maxIterations !== undefined) {
    options.maxIterations = settings.maxIterations;
  }
  if (options.thinking === undefined && settings.thinking) options.thinking = settings.thinking;
  if (options.live === undefined && settings.live !== undefined) options.live = settings.live;
  if (options.agents === undefined && settings.agents !== undefined) options.agents = settings.agents;
  if (options.tools === undefined && settings.tools !== undefined) options.tools = [...settings.tools];
  if (options.allowedTools === undefined && settings.allowedTools !== undefined) {
    options.allowedTools = [...settings.allowedTools];
  }
  if (options.appendAllowedTools === undefined && settings.appendAllowedTools !== undefined) {
    options.appendAllowedTools = [...settings.appendAllowedTools];
  }
  if (options.disallowedTools === undefined && settings.disallowedTools !== undefined) {
    options.disallowedTools = [...settings.disallowedTools];
  }
}

async function resolveNamedCloneOptions(options: MainCommandOptions, workingDirectory: string): Promise<void> {
  const targetName = typeof options.cloneBranchName === 'string' ? options.cloneBranchName.trim() : '';
  const sourceName = typeof options.cloneBranchFrom === 'string' && options.cloneBranchFrom.trim()
    ? options.cloneBranchFrom.trim()
    : MAIN_SESSION_BRANCH;

  if (!targetName && !options.cloneBranchFrom) {
    return;
  }

  if (!targetName) {
    throw new ValidationError('Named branch clone requires --name <branch>', [
      'Use: juno-code clone --name C "your prompt"',
      'Use: juno-code clone --from C --name M "your prompt"',
    ]);
  }

  const targetValidation = validateSessionBranchName(targetName, { allowMain: false });
  if (!targetValidation.valid) {
    throw new ValidationError(`Invalid clone branch name '${targetName}': ${targetValidation.reason}`, [
      "Choose a non-empty branch name other than 'main'",
      'Example: juno-code clone --name C "your prompt"',
    ]);
  }

  const sourceValidation = validateSessionBranchName(sourceName);
  if (!sourceValidation.valid) {
    throw new ValidationError(`Invalid source branch name '${sourceName}': ${sourceValidation.reason}`, [
      'Use an existing branch from: juno-code branches',
    ]);
  }

  const continueScope = resolveContinueScopeContext();
  const branches = await listSessionBranches({ workingDirectory, scope: continueScope });
  if (branches.length === 0) {
    throw new ValidationError('No named session branches found for this shell scope', [
      "Run ypl 'init' or juno-code pi 'init' first to create the main session branch",
      'Then retry: juno-code clone --name C "your prompt"',
    ]);
  }

  const sourceBranch = branches.find((branch) => branch.name === sourceName);
  if (!sourceBranch) {
    throw new ValidationError(`Unknown source branch '${sourceName}' for this shell scope`, [
      'List branches with: juno-code branches',
      'Use: juno-code clone --from <branch> --name <new-branch> "your prompt"',
    ]);
  }

  if (!sourceBranch.sessionId.trim()) {
    throw new ValidationError(`Source branch '${sourceName}' does not have a session id`, [
      "Run ypl 'init' or juno-code pi 'init' to refresh the main branch session",
    ]);
  }

  options.cloneBranchName = targetValidation.normalized;
  options.cloneBranchFrom = sourceValidation.normalized;
  options.resume = sourceBranch.sessionId;
  options.clone = options.clone ?? true;
}

async function normalizeCloneOptions(options: MainCommandOptions, workingDirectory: string): Promise<void> {
  if (options.clone === undefined) {
    return;
  }

  if (typeof options.clone === 'string' && options.prompt === undefined && options.promptFile === undefined) {
    options.prompt = options.clone;
  }

  const cloneSource = typeof options.resume === 'string' ? options.resume.trim() : '';
  if (!cloneSource) {
    await applyContinueContextFromEnvironment(options, 'clone', workingDirectory);
  }

  const normalizedSource = typeof options.resume === 'string' ? options.resume.trim() : '';
  if (!normalizedSource) {
    throw new ValidationError('Pi session cloning requires a source session', [
      'Use: juno-code --resume <session-id> --clone "your prompt"',
      'Or run from a shell with a saved continue scope: juno-code clone "your prompt"',
    ]);
  }

  if (isTruthyEnvironmentFlag(process.env.PI_NO_SESSION)) {
    throw new ValidationError('Pi session cloning cannot run with session persistence disabled', [
      'Unset PI_NO_SESSION before cloning',
      'Clone mode uses Pi session persistence to fork and return a new session id',
    ]);
  }

  options.resume = normalizedSource;
  options.cloneSession = true;
  options.cloneFromSession = normalizedSource;
  delete options.continue;

  if (!options.subagent) {
    options.subagent = 'pi';
  }
}

export async function prepareSessionBranchExecution(
  options: MainCommandOptions,
  config: { workingDirectory: string },
): Promise<void> {
  await resolveNamedCloneOptions(options, config.workingDirectory);

  // Named branch clone resolves its source from the branch registry instead of the active continue snapshot.
  if (options.continueFromLatest && !options.cloneBranchName) {
    await applyContinueContextFromEnvironment(options, 'continue', config.workingDirectory);
  }

  await normalizeCloneOptions(options, config.workingDirectory);
}

export async function syncSessionBranchExecutionResult(
  result: ExecutionResult,
  config: { workingDirectory: string },
  options: MainCommandOptions,
  latestSessionId: string | undefined,
): Promise<void> {
  if (!latestSessionId || result.status !== ExecutionStatus.COMPLETED) {
    return;
  }

  const continueScope = resolveContinueScopeContext();
  const branches = await listSessionBranches({ workingDirectory: config.workingDirectory, scope: continueScope });

  if (options.cloneBranchName) {
    const sourceBranchName = options.cloneBranchFrom || MAIN_SESSION_BRANCH;
    const sourceBranch = branches.find((branch) => branch.name === sourceBranchName);
    if (!sourceBranch) {
      throw new SessionBranchesError(
        `Cannot save cloned branch '${options.cloneBranchName}': source branch '${sourceBranchName}' is missing.`,
      );
    }

    await upsertClonedSessionBranch({
      workingDirectory: config.workingDirectory,
      scope: continueScope,
      branchName: options.cloneBranchName,
      sessionId: latestSessionId,
      parent: sourceBranchName,
      sourceSessionId: sourceBranch.sessionId,
    });
    return;
  }

  const isPiRun = result.request.subagent === 'pi';
  const isCloneRun = options.cloneSession === true || result.request.cloneSession === true;
  const isNamedCloneRun = typeof options.cloneBranchName === 'string' && options.cloneBranchName.trim().length > 0;
  const isContinueRun = options.continueFromLatest === true && !isCloneRun && !isNamedCloneRun;
  const isExplicitResumeRun =
    !isContinueRun &&
    !isCloneRun &&
    typeof options.resume === 'string' &&
    options.resume.trim().length > 0;
  const isNewRootRun =
    isPiRun &&
    !isContinueRun &&
    !isExplicitResumeRun &&
    !isCloneRun &&
    !isNamedCloneRun;

  if (!isPiRun || isCloneRun) {
    return;
  }

  if (branches.length === 0 || isNewRootRun || isExplicitResumeRun) {
    await resetMainSessionBranch({
      workingDirectory: config.workingDirectory,
      scope: continueScope,
      sessionId: latestSessionId,
    });
    return;
  }

  if (isContinueRun) {
    await updateActiveSessionBranch({
      workingDirectory: config.workingDirectory,
      scope: continueScope,
      sessionId: latestSessionId,
    });
  }
}
