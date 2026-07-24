import * as path from 'node:path';
import fs from 'fs-extra';

import type { ContinueScopeContext } from './continue-scope.js';
import {
  getSessionMetadataDirectory,
  withSessionMetadataLock,
  writeSessionMetadataFileAtomic,
} from './session-metadata.js';

export { getSessionMetadataDirectory, SESSION_METADATA_DIRECTORY_ENV } from './session-metadata.js';
export const SESSION_BRANCHES_FILE_NAME = 'session_branches.json';
export const SESSION_BRANCHES_VERSION = 1;
export const MAIN_SESSION_BRANCH = 'main';

const CONTINUE_SCOPE_FULL_HASH_PATTERN = /^SCOPE_[A-F0-9]{16}$/;

type ScopeIdentity = string | Pick<ContinueScopeContext, 'scopeHash'>;

export interface SessionBranchEntry {
  session_id: string;
  parent: string | null;
  source_session_id?: string;
  updated_at: string;
}

export interface SessionBranchScope {
  active: string;
  branches: Record<string, SessionBranchEntry>;
}

export interface SessionBranchesDocument {
  version: 1;
  scopes: Record<string, SessionBranchScope>;
}

export interface ListedSessionBranch {
  name: string;
  active: boolean;
  sessionId: string;
  parent: string | null;
  sourceSessionId: string | null;
  updatedAt: string;
}

export interface ActiveSessionBranch {
  name: string;
  sessionId: string;
  parent: string | null;
  sourceSessionId: string | null;
  updatedAt: string;
}

export interface BranchNameValidationResult {
  valid: boolean;
  normalized: string;
  reason?: string;
}

export class SessionBranchesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionBranchesError';
  }
}

export class SessionBranchesCorruptStateError extends SessionBranchesError {
  constructor(filePath: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Unable to read named session branches from ${filePath}: ${causeMessage}. ` +
        `Move or remove ${SESSION_BRANCHES_FILE_NAME} to let juno-code recreate it.`,
    );
    this.name = 'SessionBranchesCorruptStateError';
  }
}

function normalizeScopeHash(scope: ScopeIdentity): string {
  const scopeHash = typeof scope === 'string' ? scope : scope.scopeHash;
  if (!CONTINUE_SCOPE_FULL_HASH_PATTERN.test(scopeHash)) {
    throw new SessionBranchesError(
      `Invalid continue scope hash '${scopeHash}'. Expected SCOPE_<16 uppercase hex characters>.`,
    );
  }
  return scopeHash;
}

function normalizeSessionId(sessionId: string, label: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new SessionBranchesError(`${label} session id cannot be empty.`);
  }
  return normalized;
}

function normalizeBranchName(branchName: string): string {
  return branchName.trim();
}

function toListedBranch(name: string, activeName: string, entry: SessionBranchEntry): ListedSessionBranch {
  return {
    name,
    active: name === activeName,
    sessionId: entry.session_id,
    parent: entry.parent,
    sourceSessionId: entry.source_session_id ?? null,
    updatedAt: entry.updated_at,
  };
}

function assertValidDocumentShape(value: unknown): asserts value is SessionBranchesDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('state document must be a JSON object');
  }

  const record = value as Record<string, unknown>;
  if (record.version !== SESSION_BRANCHES_VERSION) {
    throw new Error(`unsupported session branches version '${String(record.version)}'`);
  }

  if (!record.scopes || typeof record.scopes !== 'object' || Array.isArray(record.scopes)) {
    throw new Error('state document must contain a scopes object');
  }

  for (const [scopeHash, scopeValue] of Object.entries(record.scopes as Record<string, unknown>)) {
    if (!CONTINUE_SCOPE_FULL_HASH_PATTERN.test(scopeHash)) {
      throw new Error(`invalid scope hash '${scopeHash}'`);
    }
    if (!scopeValue || typeof scopeValue !== 'object' || Array.isArray(scopeValue)) {
      throw new Error(`scope '${scopeHash}' must be an object`);
    }

    const scope = scopeValue as Record<string, unknown>;
    if (typeof scope.active !== 'string' || !scope.active.trim()) {
      throw new Error(`scope '${scopeHash}' must contain an active branch name`);
    }
    if (!scope.branches || typeof scope.branches !== 'object' || Array.isArray(scope.branches)) {
      throw new Error(`scope '${scopeHash}' must contain a branches object`);
    }

    const branches = scope.branches as Record<string, unknown>;
    if (!branches[scope.active]) {
      throw new Error(`scope '${scopeHash}' active branch '${scope.active}' is missing`);
    }

    for (const [branchName, branchValue] of Object.entries(branches)) {
      const validation = validateSessionBranchName(branchName);
      if (!validation.valid) {
        throw new Error(`invalid branch name '${branchName}': ${validation.reason}`);
      }
      if (!branchValue || typeof branchValue !== 'object' || Array.isArray(branchValue)) {
        throw new Error(`branch '${branchName}' in scope '${scopeHash}' must be an object`);
      }
      const branch = branchValue as Record<string, unknown>;
      if (typeof branch.session_id !== 'string' || !branch.session_id.trim()) {
        throw new Error(`branch '${branchName}' in scope '${scopeHash}' must contain session_id`);
      }
      if (branch.parent !== null && typeof branch.parent !== 'string') {
        throw new Error(`branch '${branchName}' in scope '${scopeHash}' parent must be a string or null`);
      }
      if (branch.source_session_id !== undefined && typeof branch.source_session_id !== 'string') {
        throw new Error(`branch '${branchName}' in scope '${scopeHash}' source_session_id must be a string`);
      }
      if (typeof branch.updated_at !== 'string' || !branch.updated_at.trim()) {
        throw new Error(`branch '${branchName}' in scope '${scopeHash}' must contain updated_at`);
      }
    }
  }
}

export function getSessionBranchesFilePath(workingDirectory: string): string {
  return path.join(getSessionMetadataDirectory(workingDirectory), SESSION_BRANCHES_FILE_NAME);
}

export function createEmptySessionBranchesDocument(): SessionBranchesDocument {
  return { version: SESSION_BRANCHES_VERSION, scopes: {} };
}

export async function loadSessionBranchesDocument(
  workingDirectory: string,
): Promise<SessionBranchesDocument> {
  const filePath = getSessionBranchesFilePath(workingDirectory);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    assertValidDocumentShape(parsed);
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return createEmptySessionBranchesDocument();
    }
    throw new SessionBranchesCorruptStateError(filePath, error);
  }
}

async function writeSessionBranchesDocumentUnlocked(
  workingDirectory: string,
  document: SessionBranchesDocument,
): Promise<void> {
  assertValidDocumentShape(document);
  const filePath = getSessionBranchesFilePath(workingDirectory);
  await writeSessionMetadataFileAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

export async function saveSessionBranchesDocument(
  workingDirectory: string,
  document: SessionBranchesDocument,
): Promise<void> {
  const metadataDirectory = getSessionMetadataDirectory(workingDirectory);
  await withSessionMetadataLock(metadataDirectory, SESSION_BRANCHES_FILE_NAME, () =>
    writeSessionBranchesDocumentUnlocked(workingDirectory, document));
}

async function mutateSessionBranchesDocument<T>(
  workingDirectory: string,
  mutation: (document: SessionBranchesDocument) => T,
): Promise<T> {
  const metadataDirectory = getSessionMetadataDirectory(workingDirectory);
  return withSessionMetadataLock(metadataDirectory, SESSION_BRANCHES_FILE_NAME, async () => {
    const document = await loadSessionBranchesDocument(workingDirectory);
    const result = mutation(document);
    await writeSessionBranchesDocumentUnlocked(workingDirectory, document);
    return result;
  });
}

export function validateSessionBranchName(
  branchName: string,
  options: { allowMain?: boolean } = {},
): BranchNameValidationResult {
  const normalized = normalizeBranchName(branchName);
  if (!normalized) {
    return { valid: false, normalized, reason: 'Branch name cannot be empty.' };
  }
  if (/[\u0000-\u001F\u007F]/.test(normalized)) {
    return { valid: false, normalized, reason: 'Branch name cannot contain control characters.' };
  }
  if (options.allowMain === false && normalized === MAIN_SESSION_BRANCH) {
    return {
      valid: false,
      normalized,
      reason: `'${MAIN_SESSION_BRANCH}' is reserved for the root session branch.`,
    };
  }
  return { valid: true, normalized };
}

export function assertValidSessionBranchName(
  branchName: string,
  options: { allowMain?: boolean } = {},
): string {
  const result = validateSessionBranchName(branchName, options);
  if (!result.valid) {
    throw new SessionBranchesError(result.reason || `Invalid branch name '${branchName}'.`);
  }
  return result.normalized;
}

export async function resetMainSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
  sessionId: string;
  now?: Date;
}): Promise<SessionBranchScope> {
  const scopeHash = normalizeScopeHash(options.scope);
  const sessionId = normalizeSessionId(options.sessionId, MAIN_SESSION_BRANCH);
  const updatedAt = (options.now ?? new Date()).toISOString();

  return mutateSessionBranchesDocument(options.workingDirectory, (document) => {
    const scope: SessionBranchScope = {
      active: MAIN_SESSION_BRANCH,
      branches: {
        [MAIN_SESSION_BRANCH]: {
          session_id: sessionId,
          parent: null,
          updated_at: updatedAt,
        },
      },
    };
    document.scopes[scopeHash] = scope;
    return scope;
  });
}

export async function getActiveSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
}): Promise<ActiveSessionBranch | null> {
  const document = await loadSessionBranchesDocument(options.workingDirectory);
  const scopeHash = normalizeScopeHash(options.scope);
  const scope = document.scopes[scopeHash];
  if (!scope) {
    return null;
  }
  const entry = scope.branches[scope.active];
  if (!entry) {
    throw new SessionBranchesError(
      `Active branch '${scope.active}' is missing for continue scope ${scopeHash}.`,
    );
  }
  return {
    name: scope.active,
    sessionId: entry.session_id,
    parent: entry.parent,
    sourceSessionId: entry.source_session_id ?? null,
    updatedAt: entry.updated_at,
  };
}

export async function setActiveSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
  branchName: string;
}): Promise<ActiveSessionBranch> {
  const scopeHash = normalizeScopeHash(options.scope);
  const branchName = assertValidSessionBranchName(options.branchName);
  return mutateSessionBranchesDocument(options.workingDirectory, (document) => {
    const scope = document.scopes[scopeHash];
    if (!scope) {
      throw new SessionBranchesError(`No named session branches found for continue scope ${scopeHash}.`);
    }
    const entry = scope.branches[branchName];
    if (!entry) {
      throw new SessionBranchesError(
        `Unknown session branch '${branchName}' for continue scope ${scopeHash}.`,
      );
    }
    scope.active = branchName;
    return {
      name: branchName,
      sessionId: entry.session_id,
      parent: entry.parent,
      sourceSessionId: entry.source_session_id ?? null,
      updatedAt: entry.updated_at,
    };
  });
}

export async function upsertClonedSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
  branchName: string;
  sessionId: string;
  parent: string;
  sourceSessionId: string;
  now?: Date;
}): Promise<ListedSessionBranch> {
  const scopeHash = normalizeScopeHash(options.scope);
  const branchName = assertValidSessionBranchName(options.branchName, { allowMain: false });
  const sessionId = normalizeSessionId(options.sessionId, branchName);
  const sourceSessionId = normalizeSessionId(options.sourceSessionId, 'source');
  const parent = assertValidSessionBranchName(options.parent);
  const updatedAt = (options.now ?? new Date()).toISOString();
  return mutateSessionBranchesDocument(options.workingDirectory, (document) => {
    const scope = document.scopes[scopeHash];
    if (!scope) {
      throw new SessionBranchesError(`No named session branches found for continue scope ${scopeHash}.`);
    }
    if (!scope.branches[parent]) {
      throw new SessionBranchesError(
        `Cannot clone from missing parent branch '${parent}' in continue scope ${scopeHash}.`,
      );
    }
    const entry: SessionBranchEntry = {
      session_id: sessionId,
      parent,
      source_session_id: sourceSessionId,
      updated_at: updatedAt,
    };
    scope.branches[branchName] = entry;
    return toListedBranch(branchName, scope.active, entry);
  });
}

export async function updateActiveSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
  sessionId: string;
  now?: Date;
}): Promise<ActiveSessionBranch> {
  const scopeHash = normalizeScopeHash(options.scope);
  const sessionId = normalizeSessionId(options.sessionId, 'active branch');
  return mutateSessionBranchesDocument(options.workingDirectory, (document) => {
    const scope = document.scopes[scopeHash];
    if (!scope) {
      throw new SessionBranchesError(`No named session branches found for continue scope ${scopeHash}.`);
    }
    const entry = scope.branches[scope.active];
    if (!entry) {
      throw new SessionBranchesError(
        `Active branch '${scope.active}' is missing for continue scope ${scopeHash}.`,
      );
    }
    entry.session_id = sessionId;
    entry.updated_at = (options.now ?? new Date()).toISOString();
    return {
      name: scope.active,
      sessionId: entry.session_id,
      parent: entry.parent,
      sourceSessionId: entry.source_session_id ?? null,
      updatedAt: entry.updated_at,
    };
  });
}

export async function listSessionBranches(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
}): Promise<ListedSessionBranch[]> {
  const document = await loadSessionBranchesDocument(options.workingDirectory);
  const scopeHash = normalizeScopeHash(options.scope);
  const scope = document.scopes[scopeHash];
  if (!scope) {
    return [];
  }
  return Object.entries(scope.branches)
    .map(([name, entry]) => toListedBranch(name, scope.active, entry))
    .sort((a, b) => (a.name === MAIN_SESSION_BRANCH ? -1 : b.name === MAIN_SESSION_BRANCH ? 1 : a.name.localeCompare(b.name)));
}
