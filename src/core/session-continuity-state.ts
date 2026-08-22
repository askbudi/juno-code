import * as path from 'node:path';
import fs from 'fs-extra';

import type { ContinueScopeContext } from './continue-scope.js';
import {
  getProvenLiveContinueScopeHashes,
  resolveContinueScopeContext,
} from './continue-scope.js';
import {
  getSessionMetadataDirectory,
  SESSION_CONTINUITY_SHARED_LOCK_NAME,
  withSessionMetadataLock,
  writeSessionMetadataFileAtomic,
} from './session-metadata.js';

export { getSessionMetadataDirectory, SESSION_METADATA_DIRECTORY_ENV } from './session-metadata.js';

export const SESSION_CONTINUITY_FILE_NAME = 'session_continuity.v2.json';
export const SESSION_CONTINUITY_VERSION = 2;
export const MAIN_SESSION_BRANCH = 'main';
export const MAX_CONTINUE_SETTINGS_BYTES = 16 * 1024;
export const MAX_CONTINUE_SETTING_ARRAY_ITEMS = 128;
export const CONTINUITY_SCOPE_TTL_DAYS = 30;
export const CONTINUITY_INACTIVE_SCOPE_LIMIT = 128;
const CONTINUITY_SCOPE_TTL_MS = CONTINUITY_SCOPE_TTL_DAYS * 24 * 60 * 60 * 1_000;

const CONTINUE_SCOPE_FULL_HASH_PATTERN = /^SCOPE_[A-F0-9]{16}$/;
const VALID_SUBAGENTS = new Set(['claude', 'cursor', 'codex', 'gemini', 'pi']);
const SETTINGS_KEYS = new Set([
  'version',
  'subagent',
  'model',
  'maxIterations',
  'thinking',
  'live',
  'agents',
  'tools',
  'allowedTools',
  'appendAllowedTools',
  'disallowedTools',
]);

type ScopeIdentity =
  | string
  | (Pick<ContinueScopeContext, 'scopeHash'> & Partial<Pick<ContinueScopeContext, 'scopeSource'>>);
export type ContinueSettingsSnapshot = Record<string, unknown>;

export interface SessionBranchEntry {
  session_id: string;
  parent: string | null;
  source_session_id?: string;
  updated_at: string;
}

export interface SessionContinuityScope {
  source: string;
  createdAt: string;
  lastUsedAt: string;
  pinned: boolean;
  settings: ContinueSettingsSnapshot | null;
  active: string;
  branches: Record<string, SessionBranchEntry>;
}

export interface SessionContinuityDocument {
  version: 2;
  scopes: Record<string, SessionContinuityScope>;
}

export interface ListedSessionBranch {
  name: string;
  active: boolean;
  sessionId: string;
  parent: string | null;
  sourceSessionId: string | null;
  updatedAt: string;
}

export type ActiveSessionBranch = Omit<ListedSessionBranch, 'active'>;
export interface BranchNameValidationResult {
  valid: boolean;
  normalized: string;
  reason?: string;
}

export class SessionContinuityStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionContinuityStateError';
  }
}
export class SessionContinuityCorruptStateError extends SessionContinuityStateError {
  constructor(filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Unable to read session continuity state from ${filePath}: ${detail}. Move or remove ${SESSION_CONTINUITY_FILE_NAME} to let yylo recreate it.`,
    );
    this.name = 'SessionContinuityCorruptStateError';
  }
}
export interface SessionContinuityStateContext {
  workingDirectory: string;
  context?: ContinueScopeContext;
  env?: NodeJS.ProcessEnv;
  /** Deterministic clock injection for retention and last-used tests. */
  now?: Date;
}
export interface ScopedContinueSessionState {
  context: ContinueScopeContext;
  activeBranch: ActiveSessionBranch | null;
  resolvedSessionId: string;
  settings: ContinueSettingsSnapshot | null;
  serializedSettings: string | null;
}
export interface PersistContinueScopeSnapshotOptions {
  workingDirectory: string;
  context: ContinueScopeContext;
  sessionId: string;
  serializedSettings?: string;
  now?: Date;
}
export interface PersistActiveSessionBranchSelectionOptions extends SessionContinuityStateContext {
  branchName: string;
}

export interface ContinuityRetentionResult {
  expired: number;
  lru: number;
  retainedInactive: number;
  protected: { current: number; live: number; pinned: number; named: number };
  protectedOverflow: boolean;
}
export interface ApplySessionContinuityRetentionOptions {
  workingDirectory: string;
  currentScopeHash: string;
  now?: Date;
  /** Tests and callers already holding the shared lock may supply a proven snapshot. */
  provenLiveScopeHashes?: ReadonlySet<string>;
  warn?: (message: string) => void;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value)))
    throw new Error(`${label} must be an ISO timestamp`);
  return value;
}
function normalizeScopeHash(scope: ScopeIdentity): string {
  const hash = typeof scope === 'string' ? scope : scope.scopeHash;
  if (!CONTINUE_SCOPE_FULL_HASH_PATTERN.test(hash))
    throw new SessionContinuityStateError(
      `Invalid continue scope hash '${hash}'. Expected SCOPE_<16 uppercase hex characters>.`,
    );
  return hash;
}
function scopeSource(scope: ScopeIdentity): string {
  const source = typeof scope === 'string' ? 'hash_lookup' : scope.scopeSource || 'hash_lookup';
  if (source.length > 256)
    throw new SessionContinuityStateError('Continue scope source exceeds 256 characters.');
  return source;
}
function sessionId(value: string, label = 'Continue'): string {
  const result = value.trim();
  if (!result) throw new SessionContinuityStateError(`${label} session id cannot be empty.`);
  if (result.length > 4096)
    throw new SessionContinuityStateError(`${label} session id exceeds 4096 characters.`);
  return result;
}
function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

export function validateContinueSettingsSnapshot(value: unknown): ContinueSettingsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SessionContinuityStateError('Continue settings must be a JSON object.');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!SETTINGS_KEYS.has(key))
      throw new SessionContinuityStateError(`Unsupported continue setting '${key}'.`);
  if (typeof input.version !== 'number' || input.version !== 1)
    throw new SessionContinuityStateError('Continue settings version must be 1.');
  if (typeof input.subagent !== 'string' || !VALID_SUBAGENTS.has(input.subagent))
    throw new SessionContinuityStateError('Continue settings subagent is invalid.');
  const output: Record<string, unknown> = { version: 1, subagent: input.subagent };
  for (const key of ['model', 'thinking', 'agents']) {
    const candidate = input[key];
    if (candidate !== undefined) {
      if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 512)
        throw new SessionContinuityStateError(`Continue setting '${key}' is invalid.`);
      output[key] = candidate.trim();
    }
  }
  if (input.maxIterations !== undefined) {
    if (
      !Number.isInteger(input.maxIterations) ||
      ((input.maxIterations as number) !== -1 && (input.maxIterations as number) < 1) ||
      (input.maxIterations as number) > 1_000_000
    )
      throw new SessionContinuityStateError("Continue setting 'maxIterations' is invalid.");
    output.maxIterations = input.maxIterations;
  }
  if (input.live !== undefined) {
    if (typeof input.live !== 'boolean')
      throw new SessionContinuityStateError("Continue setting 'live' is invalid.");
    output.live = input.live;
  }
  for (const key of ['tools', 'allowedTools', 'appendAllowedTools', 'disallowedTools']) {
    const candidate = input[key];
    if (candidate === undefined) continue;
    if (
      !Array.isArray(candidate) ||
      candidate.length > MAX_CONTINUE_SETTING_ARRAY_ITEMS ||
      candidate.some((item) => typeof item !== 'string' || !item.trim() || item.length > 512)
    ) {
      throw new SessionContinuityStateError(
        `Continue setting '${key}' is invalid or exceeds its bound.`,
      );
    }
    output[key] = candidate.map((item) => (item as string).trim());
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_CONTINUE_SETTINGS_BYTES)
    throw new SessionContinuityStateError(
      `Continue settings exceed ${MAX_CONTINUE_SETTINGS_BYTES} bytes.`,
    );
  return output;
}

export function parseContinueSettingsSnapshot(raw: string): ContinueSettingsSnapshot {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONTINUE_SETTINGS_BYTES)
    throw new SessionContinuityStateError(
      `Continue settings exceed ${MAX_CONTINUE_SETTINGS_BYTES} bytes.`,
    );
  try {
    return validateContinueSettingsSnapshot(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SessionContinuityStateError) throw error;
    throw new SessionContinuityStateError(
      `Continue settings contain malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateSessionBranchName(
  branchName: string,
  options: { allowMain?: boolean } = {},
): BranchNameValidationResult {
  const normalized = branchName.trim();
  if (!normalized) return { valid: false, normalized, reason: 'Branch name cannot be empty.' };
  if (/[\u0000-\u001F\u007F]/.test(normalized))
    return { valid: false, normalized, reason: 'Branch name cannot contain control characters.' };
  if (options.allowMain === false && normalized === MAIN_SESSION_BRANCH)
    return {
      valid: false,
      normalized,
      reason: `'${MAIN_SESSION_BRANCH}' is reserved for the root session branch.`,
    };
  return { valid: true, normalized };
}
export function assertValidSessionBranchName(
  branchName: string,
  options: { allowMain?: boolean } = {},
): string {
  const result = validateSessionBranchName(branchName, options);
  if (!result.valid)
    throw new SessionContinuityStateError(result.reason || `Invalid branch name '${branchName}'.`);
  return result.normalized;
}

function assertDocument(value: unknown): asserts value is SessionContinuityDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('state document must be a JSON object');
  const doc = value as Record<string, unknown>;
  if (doc.version !== SESSION_CONTINUITY_VERSION)
    throw new Error(`unsupported session continuity version '${String(doc.version)}'`);
  if (!doc.scopes || typeof doc.scopes !== 'object' || Array.isArray(doc.scopes))
    throw new Error('state document must contain a scopes object');
  for (const [hash, raw] of Object.entries(doc.scopes as Record<string, unknown>)) {
    normalizeScopeHash(hash);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`scope '${hash}' must be an object`);
    const scope = raw as Record<string, unknown>;
    if (typeof scope.source !== 'string' || !scope.source || scope.source.length > 256)
      throw new Error(`scope '${hash}' source is invalid`);
    iso(scope.createdAt, `scope '${hash}' createdAt`);
    iso(scope.lastUsedAt, `scope '${hash}' lastUsedAt`);
    if (typeof scope.pinned !== 'boolean')
      throw new Error(`scope '${hash}' pinned must be boolean`);
    if (scope.settings !== null) validateContinueSettingsSnapshot(scope.settings);
    if (typeof scope.active !== 'string' || !scope.active.trim())
      throw new Error(`scope '${hash}' active branch is invalid`);
    if (!scope.branches || typeof scope.branches !== 'object' || Array.isArray(scope.branches))
      throw new Error(`scope '${hash}' branches is invalid`);
    const branches = scope.branches as Record<string, unknown>;
    if (!branches[scope.active])
      throw new Error(`scope '${hash}' active branch '${scope.active}' is missing`);
    for (const [name, rawBranch] of Object.entries(branches)) {
      if (
        !validateSessionBranchName(name).valid ||
        !rawBranch ||
        typeof rawBranch !== 'object' ||
        Array.isArray(rawBranch)
      )
        throw new Error(`branch '${name}' in scope '${hash}' is invalid`);
      const branch = rawBranch as Record<string, unknown>;
      sessionId(String(branch.session_id ?? ''), name);
      if (branch.parent !== null && typeof branch.parent !== 'string')
        throw new Error(`branch '${name}' parent is invalid`);
      if (branch.source_session_id !== undefined && typeof branch.source_session_id !== 'string')
        throw new Error(`branch '${name}' source_session_id is invalid`);
      iso(branch.updated_at, `branch '${name}' updated_at`);
    }
  }
}

export function getSessionContinuityFilePath(workingDirectory: string): string {
  return path.join(getSessionMetadataDirectory(workingDirectory), SESSION_CONTINUITY_FILE_NAME);
}
export function createEmptySessionContinuityDocument(): SessionContinuityDocument {
  return { version: 2, scopes: {} };
}
export async function loadSessionContinuityDocument(
  workingDirectory: string,
): Promise<SessionContinuityDocument> {
  const file = getSessionContinuityFilePath(workingDirectory);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    assertDocument(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return createEmptySessionContinuityDocument();
    throw new SessionContinuityCorruptStateError(file, error);
  }
}
async function writeUnlocked(
  workingDirectory: string,
  document: SessionContinuityDocument,
): Promise<void> {
  assertDocument(document);
  await writeSessionMetadataFileAtomic(
    getSessionContinuityFilePath(workingDirectory),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}
function applyRetentionToDocument(
  document: SessionContinuityDocument,
  options: {
    currentScopeHash: string;
    now: Date;
    provenLiveScopeHashes: ReadonlySet<string>;
    warn: (message: string) => void;
  },
): ContinuityRetentionResult {
  const protectedCounts = { current: 0, live: 0, pinned: 0, named: 0 };
  const inactive: Array<[string, SessionContinuityScope]> = [];

  for (const entry of Object.entries(document.scopes)) {
    const [hash, scope] = entry;
    if (hash === options.currentScopeHash) protectedCounts.current += 1;
    else if (options.provenLiveScopeHashes.has(hash)) protectedCounts.live += 1;
    else if (scope.pinned) protectedCounts.pinned += 1;
    else if (Object.keys(scope.branches).some((name) => name !== MAIN_SESSION_BRANCH))
      protectedCounts.named += 1;
    else inactive.push(entry);
  }

  const cutoff = options.now.getTime() - CONTINUITY_SCOPE_TTL_MS;
  let expired = 0;
  const ttlRetained: Array<[string, SessionContinuityScope]> = [];
  for (const entry of inactive) {
    if (Date.parse(entry[1].lastUsedAt) < cutoff) {
      delete document.scopes[entry[0]];
      expired += 1;
    } else ttlRetained.push(entry);
  }

  ttlRetained.sort(
    (a, b) =>
      Date.parse(b[1].lastUsedAt) - Date.parse(a[1].lastUsedAt) || a[0].localeCompare(b[0]),
  );
  const lruEntries = ttlRetained.slice(CONTINUITY_INACTIVE_SCOPE_LIMIT);
  for (const [hash] of lruEntries) delete document.scopes[hash];

  const protectedTotal = Object.values(protectedCounts).reduce((sum, count) => sum + count, 0);
  const protectedOverflow = protectedTotal > CONTINUITY_INACTIVE_SCOPE_LIMIT;
  if (protectedOverflow) {
    options.warn(
      `Continuity retention warning: protected count ${protectedTotal} exceeds limit ${CONTINUITY_INACTIVE_SCOPE_LIMIT}; retaining protected metadata.`,
    );
  }
  return {
    expired,
    lru: lruEntries.length,
    retainedInactive: Math.min(ttlRetained.length, CONTINUITY_INACTIVE_SCOPE_LIMIT),
    protected: protectedCounts,
    protectedOverflow,
  };
}

async function mutate<T>(
  workingDirectory: string,
  currentScopeHash: string,
  now: Date | undefined,
  fn: (document: SessionContinuityDocument) => T | Promise<T>,
): Promise<T> {
  const metadata = getSessionMetadataDirectory(workingDirectory);
  return withSessionMetadataLock(metadata, SESSION_CONTINUITY_SHARED_LOCK_NAME, async () => {
    const document = await loadSessionContinuityDocument(workingDirectory);
    const result = await fn(document);
    applyRetentionToDocument(document, {
      currentScopeHash,
      now: now ?? new Date(),
      provenLiveScopeHashes: await getProvenLiveContinueScopeHashes(workingDirectory),
      warn: (message) => console.warn(message),
    });
    await writeUnlocked(workingDirectory, document);
    return result;
  });
}

export async function applySessionContinuityRetention(
  options: ApplySessionContinuityRetentionOptions,
): Promise<ContinuityRetentionResult> {
  const currentScopeHash = normalizeScopeHash(options.currentScopeHash);
  const metadata = getSessionMetadataDirectory(options.workingDirectory);
  return withSessionMetadataLock(metadata, SESSION_CONTINUITY_SHARED_LOCK_NAME, async () => {
    const document = await loadSessionContinuityDocument(options.workingDirectory);
    const result = applyRetentionToDocument(document, {
      currentScopeHash,
      now: options.now ?? new Date(),
      provenLiveScopeHashes:
        options.provenLiveScopeHashes ??
        (await getProvenLiveContinueScopeHashes(options.workingDirectory)),
      warn: options.warn ?? ((message) => console.warn(message)),
    });
    await writeUnlocked(options.workingDirectory, document);
    return result;
  });
}
function resolveContext(options: SessionContinuityStateContext): ContinueScopeContext {
  return (
    options.context ||
    resolveContinueScopeContext(options.env || process.env, process.ppid, options.workingDirectory)
  );
}
function toListed(name: string, active: string, entry: SessionBranchEntry): ListedSessionBranch {
  return {
    name,
    active: name === active,
    sessionId: entry.session_id,
    parent: entry.parent,
    sourceSessionId: entry.source_session_id ?? null,
    updatedAt: entry.updated_at,
  };
}
function ensureScope(
  document: SessionContinuityDocument,
  identity: ScopeIdentity,
  at: string,
  initialSessionId: string,
): SessionContinuityScope {
  const hash = normalizeScopeHash(identity);
  return (document.scopes[hash] ||= {
    source: scopeSource(identity),
    createdAt: at,
    lastUsedAt: at,
    pinned: false,
    settings: null,
    active: MAIN_SESSION_BRANCH,
    branches: { main: { session_id: initialSessionId, parent: null, updated_at: at } },
  });
}

export async function persistContinueScopeSnapshot(
  options: PersistContinueScopeSnapshotOptions,
): Promise<void> {
  const id = sessionId(options.sessionId);
  const at = nowIso(options.now);
  const settings =
    options.serializedSettings === undefined
      ? undefined
      : parseContinueSettingsSnapshot(options.serializedSettings);
  await mutate(options.workingDirectory, options.context.scopeHash, options.now, (document) => {
    const scope = ensureScope(document, options.context, at, id);
    const active = scope.branches[scope.active];
    if (!active)
      throw new SessionContinuityStateError(
        `Active branch '${scope.active}' is missing for continue scope ${options.context.scopeHash}.`,
      );
    active.session_id = id;
    active.updated_at = at;
    scope.lastUsedAt = at;
    scope.source = options.context.scopeSource;
    if (settings !== undefined) scope.settings = settings;
  });
}

export async function resolveScopedContinueSessionState(
  options: SessionContinuityStateContext,
): Promise<ScopedContinueSessionState> {
  const context = resolveContext(options);
  return mutate(options.workingDirectory, context.scopeHash, options.now, (document) => {
    const scope = document.scopes[context.scopeHash];
    if (!scope)
      return {
        context,
        activeBranch: null,
        resolvedSessionId: '',
        settings: null,
        serializedSettings: null,
      };
    const entry = scope.branches[scope.active];
    if (!entry)
      throw new SessionContinuityStateError(
        `Active branch '${scope.active}' is missing for continue scope ${context.scopeHash}.`,
      );
    scope.lastUsedAt = nowIso(options.now);
    const activeBranch = toListed(scope.active, scope.active, entry);
    delete (activeBranch as Partial<ListedSessionBranch>).active;
    return {
      context,
      activeBranch: activeBranch as ActiveSessionBranch,
      resolvedSessionId: entry.session_id,
      settings: scope.settings,
      serializedSettings: scope.settings ? JSON.stringify(scope.settings) : null,
    };
  });
}

export async function resetMainSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
  sessionId: string;
  now?: Date;
}): Promise<SessionContinuityScope> {
  const hash = normalizeScopeHash(options.scope);
  const id = sessionId(options.sessionId, MAIN_SESSION_BRANCH);
  const at = nowIso(options.now);
  return mutate(options.workingDirectory, hash, options.now, (document) => {
    const previous = document.scopes[hash];
    const next: SessionContinuityScope = {
      source: scopeSource(options.scope),
      createdAt: previous?.createdAt ?? at,
      lastUsedAt: at,
      pinned: previous?.pinned ?? false,
      settings: previous?.settings ?? null,
      active: MAIN_SESSION_BRANCH,
      branches: { main: { session_id: id, parent: null, updated_at: at } },
    };
    document.scopes[hash] = next;
    return next;
  });
}
export async function getActiveSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
}): Promise<ActiveSessionBranch | null> {
  const doc = await loadSessionContinuityDocument(options.workingDirectory);
  const hash = normalizeScopeHash(options.scope);
  const scope = doc.scopes[hash];
  if (!scope) return null;
  const entry = scope.branches[scope.active];
  if (!entry)
    throw new SessionContinuityStateError(
      `Active branch '${scope.active}' is missing for continue scope ${hash}.`,
    );
  const listed = toListed(scope.active, scope.active, entry);
  return {
    name: listed.name,
    sessionId: listed.sessionId,
    parent: listed.parent,
    sourceSessionId: listed.sourceSessionId,
    updatedAt: listed.updatedAt,
  };
}
export async function listSessionBranches(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
}): Promise<ListedSessionBranch[]> {
  const doc = await loadSessionContinuityDocument(options.workingDirectory);
  const scope = doc.scopes[normalizeScopeHash(options.scope)];
  if (!scope) return [];
  return Object.entries(scope.branches)
    .map(([name, entry]) => toListed(name, scope.active, entry))
    .sort((a, b) =>
      a.name === MAIN_SESSION_BRANCH
        ? -1
        : b.name === MAIN_SESSION_BRANCH
          ? 1
          : a.name.localeCompare(b.name),
    );
}
export async function setActiveSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
  branchName: string;
}): Promise<ActiveSessionBranch> {
  const hash = normalizeScopeHash(options.scope);
  const name = assertValidSessionBranchName(options.branchName);
  return mutate(options.workingDirectory, hash, undefined, (doc) => {
    const scope = doc.scopes[hash];
    if (!scope)
      throw new SessionContinuityStateError(
        `No named session branches found for continue scope ${hash}.`,
      );
    const entry = scope.branches[name];
    if (!entry)
      throw new SessionContinuityStateError(
        `Unknown session branch '${name}' for continue scope ${hash}.`,
      );
    scope.active = name;
    scope.lastUsedAt = nowIso();
    const listed = toListed(name, name, entry);
    return {
      name,
      sessionId: listed.sessionId,
      parent: listed.parent,
      sourceSessionId: listed.sourceSessionId,
      updatedAt: listed.updatedAt,
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
  const hash = normalizeScopeHash(options.scope);
  const name = assertValidSessionBranchName(options.branchName, { allowMain: false });
  const parent = assertValidSessionBranchName(options.parent);
  const id = sessionId(options.sessionId, name);
  const source = sessionId(options.sourceSessionId, 'source');
  const at = nowIso(options.now);
  return mutate(options.workingDirectory, hash, options.now, (doc) => {
    const scope = doc.scopes[hash];
    if (!scope)
      throw new SessionContinuityStateError(
        `No named session branches found for continue scope ${hash}.`,
      );
    if (!scope.branches[parent])
      throw new SessionContinuityStateError(
        `Cannot clone from missing parent branch '${parent}' in continue scope ${hash}.`,
      );
    const entry = { session_id: id, parent, source_session_id: source, updated_at: at };
    scope.branches[name] = entry;
    scope.lastUsedAt = at;
    return toListed(name, scope.active, entry);
  });
}
export async function updateActiveSessionBranch(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
  sessionId: string;
  now?: Date;
}): Promise<ActiveSessionBranch> {
  const hash = normalizeScopeHash(options.scope);
  const id = sessionId(options.sessionId, 'active branch');
  const at = nowIso(options.now);
  return mutate(options.workingDirectory, hash, options.now, (doc) => {
    const scope = doc.scopes[hash];
    if (!scope)
      throw new SessionContinuityStateError(
        `No named session branches found for continue scope ${hash}.`,
      );
    const entry = scope.branches[scope.active];
    if (!entry)
      throw new SessionContinuityStateError(
        `Active branch '${scope.active}' is missing for continue scope ${hash}.`,
      );
    entry.session_id = id;
    entry.updated_at = at;
    scope.lastUsedAt = at;
    const listed = toListed(scope.active, scope.active, entry);
    return {
      name: listed.name,
      sessionId: listed.sessionId,
      parent: listed.parent,
      sourceSessionId: listed.sourceSessionId,
      updatedAt: listed.updatedAt,
    };
  });
}
export async function persistActiveSessionBranchSelection(
  options: PersistActiveSessionBranchSelectionOptions,
): Promise<ActiveSessionBranch> {
  const context = resolveContext(options);
  let name = options.branchName;
  if (name === '+' || name === '-') {
    const branches = await listSessionBranches({
      workingDirectory: options.workingDirectory,
      scope: context,
    });
    if (!branches.length)
      throw new SessionContinuityStateError(
        `No named session branches found for continue scope ${context.scopeHash}.`,
      );
    const index = Math.max(
      0,
      branches.findIndex((branch) => branch.active),
    );
    name = branches[(index + (name === '+' ? 1 : -1) + branches.length) % branches.length]!.name;
  }
  return setActiveSessionBranch({
    workingDirectory: options.workingDirectory,
    scope: context,
    branchName: name,
  });
}
export async function setContinueScopePinned(options: {
  workingDirectory: string;
  scope: ScopeIdentity;
  pinned: boolean;
}): Promise<void> {
  const hash = normalizeScopeHash(options.scope);
  const currentScopeHash = resolveContinueScopeContext(
    process.env,
    process.ppid,
    options.workingDirectory,
  ).scopeHash;
  await mutate(options.workingDirectory, currentScopeHash, undefined, (doc) => {
    const scope = doc.scopes[hash];
    if (!scope) throw new SessionContinuityStateError(`Unknown continue scope ${hash}.`);
    scope.pinned = options.pinned;
  });
}
