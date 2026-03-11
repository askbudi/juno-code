import { createHash } from 'node:crypto';
import * as path from 'node:path';
import fs from 'fs-extra';

export const CONTINUE_SESSION_ENV_KEY_BASE = 'JUNO_CODE_LAST_SESSION_ID';
export const CONTINUE_SETTINGS_ENV_KEY_BASE = 'JUNO_CODE_LAST_EXECUTION_SETTINGS';
export const CONTINUE_SCOPE_OVERRIDE_ENV_KEY = 'JUNO_CODE_CONTINUE_SCOPE';

const CONTINUE_SCOPE_RUNTIME_FILE_NAME = 'continue_scope_runtime.json';
const CONTINUE_SCOPE_RUNTIME_VERSION = 1;
const CONTINUE_SCOPE_DIGEST_LENGTH = 16;
const CONTINUE_SCOPE_SHORT_HASH_LENGTH = 6;
const CONTINUE_SCOPE_FULL_HASH_PATTERN = /^SCOPE_[A-F0-9]{16}$/;
const CONTINUE_SCOPE_SHORT_HASH_PATTERN = /^[A-F0-9]{5,6}$/;

const CONTINUE_SCOPE_ENV_MARKERS: ReadonlyArray<string> = [
  'TMUX_PANE',
  'WEZTERM_PANE',
  'KITTY_WINDOW_ID',
  'KITTY_PID',
  'TERM_SESSION_ID',
  'WT_SESSION',
  'ZELLIJ_PANE_ID',
  'STY',
  'WINDOWID',
  'SSH_TTY',
];

interface ContinueScopeRuntimeEntry {
  pid: number;
  startedAt: string;
}

interface ContinueScopeRuntimeDocument {
  version: number;
  scopes: Record<string, ContinueScopeRuntimeEntry>;
}

export interface ContinueScopeContext {
  scopeDescriptor: string;
  scopeHash: string;
  shortHash: string;
  scopeSource: string;
  sessionEnvKey: string;
  settingsEnvKey: string;
}

export type ContinueScopeStatus = 'running' | 'finished' | 'not_found' | 'error';

export interface ContinueScopeStatusResult {
  status: ContinueScopeStatus;
  hash: string;
  fullHash: string;
  scopeSource: string;
  sessionEnvKey: string;
  settingsEnvKey: string;
  sessionId: string | null;
  isCurrentScope: boolean;
  pid: number | null;
  reason?: string;
}

function buildScopeHashes(scopeDescriptor: string): { scopeHash: string; shortHash: string } {
  const digest = createHash('sha256')
    .update(scopeDescriptor)
    .digest('hex')
    .slice(0, CONTINUE_SCOPE_DIGEST_LENGTH)
    .toUpperCase();

  return {
    scopeHash: `SCOPE_${digest}`,
    shortHash: digest.slice(0, CONTINUE_SCOPE_SHORT_HASH_LENGTH),
  };
}

function buildContextFromHash(fullHash: string, scopeSource: string): ContinueScopeContext {
  const digest = fullHash.slice('SCOPE_'.length);
  return {
    scopeDescriptor: '',
    scopeHash: fullHash,
    shortHash: digest.slice(0, CONTINUE_SCOPE_SHORT_HASH_LENGTH),
    scopeSource,
    sessionEnvKey: `${CONTINUE_SESSION_ENV_KEY_BASE}_${fullHash}`,
    settingsEnvKey: `${CONTINUE_SETTINGS_ENV_KEY_BASE}_${fullHash}`,
  };
}

function getRuntimeFilePath(workingDirectory: string): string {
  return path.join(workingDirectory, '.juno_task', CONTINUE_SCOPE_RUNTIME_FILE_NAME);
}

function parseRuntimeDocument(raw: string): ContinueScopeRuntimeDocument {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { version: CONTINUE_SCOPE_RUNTIME_VERSION, scopes: {} };
    }

    const record = parsed as Record<string, unknown>;
    const scopesValue = record.scopes;
    if (!scopesValue || typeof scopesValue !== 'object' || Array.isArray(scopesValue)) {
      return { version: CONTINUE_SCOPE_RUNTIME_VERSION, scopes: {} };
    }

    const scopes: Record<string, ContinueScopeRuntimeEntry> = {};
    for (const [key, value] of Object.entries(scopesValue as Record<string, unknown>)) {
      if (!CONTINUE_SCOPE_FULL_HASH_PATTERN.test(key)) {
        continue;
      }
      if (!value || typeof value !== 'object') {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const pid = typeof entry.pid === 'number' && Number.isFinite(entry.pid) ? entry.pid : null;
      const startedAt = typeof entry.startedAt === 'string' ? entry.startedAt : null;
      if (pid === null || !startedAt) {
        continue;
      }
      scopes[key] = { pid, startedAt };
    }

    return {
      version: CONTINUE_SCOPE_RUNTIME_VERSION,
      scopes,
    };
  } catch {
    return { version: CONTINUE_SCOPE_RUNTIME_VERSION, scopes: {} };
  }
}

async function readRuntimeDocument(runtimeFilePath: string): Promise<ContinueScopeRuntimeDocument> {
  try {
    const raw = await fs.readFile(runtimeFilePath, 'utf-8');
    return parseRuntimeDocument(raw);
  } catch {
    return { version: CONTINUE_SCOPE_RUNTIME_VERSION, scopes: {} };
  }
}

async function writeRuntimeDocument(
  runtimeFilePath: string,
  document: ContinueScopeRuntimeDocument,
): Promise<void> {
  await fs.ensureDir(path.dirname(runtimeFilePath));
  await fs.writeFile(runtimeFilePath, JSON.stringify(document, null, 2), 'utf-8');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function looksLikeValidSettingsSnapshot(raw: string | undefined): boolean {
  if (typeof raw !== 'string' || !raw.trim()) {
    return false;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function extractKnownScopeHashesFromEnv(env: NodeJS.ProcessEnv): Set<string> {
  const hashes = new Set<string>();
  const sessionRegex = new RegExp(`^${CONTINUE_SESSION_ENV_KEY_BASE}_(SCOPE_[A-F0-9]{16})$`);
  const settingsRegex = new RegExp(`^${CONTINUE_SETTINGS_ENV_KEY_BASE}_(SCOPE_[A-F0-9]{16})$`);

  for (const key of Object.keys(env)) {
    const sessionMatch = key.match(sessionRegex);
    if (sessionMatch?.[1]) {
      hashes.add(sessionMatch[1]);
      continue;
    }

    const settingsMatch = key.match(settingsRegex);
    if (settingsMatch?.[1]) {
      hashes.add(settingsMatch[1]);
    }
  }

  return hashes;
}

function resolveTargetScopeHash(
  requestedHash: string | undefined,
  currentScope: ContinueScopeContext,
  knownHashes: ReadonlySet<string>,
): { scopeHash: string; isCurrentScope: boolean } {
  if (!requestedHash || !requestedHash.trim()) {
    return {
      scopeHash: currentScope.scopeHash,
      isCurrentScope: true,
    };
  }

  const normalized = requestedHash.trim().toUpperCase();
  if (CONTINUE_SCOPE_FULL_HASH_PATTERN.test(normalized)) {
    return {
      scopeHash: normalized,
      isCurrentScope: normalized === currentScope.scopeHash,
    };
  }

  if (CONTINUE_SCOPE_SHORT_HASH_PATTERN.test(normalized)) {
    const candidates = [...knownHashes].filter((hash) =>
      hash.slice('SCOPE_'.length).startsWith(normalized),
    );

    if (candidates.length === 1) {
      const [candidate] = candidates;
      return {
        scopeHash: candidate!,
        isCurrentScope: candidate === currentScope.scopeHash,
      };
    }

    if (candidates.length > 1) {
      throw new Error(`Ambiguous continue scope hash '${requestedHash}'. Use full SCOPE_<HASH> value.`);
    }

    throw new Error(
      `Unknown continue scope hash '${requestedHash}'. Run 'juno-code continue-scope --json' to list the current scope hash.`,
    );
  }

  throw new Error(
    `Invalid hash '${requestedHash}'. Use a 5-6 character hash prefix or full SCOPE_<16 HEX> hash.`,
  );
}

export function resolveContinueScopeContext(
  env: NodeJS.ProcessEnv = process.env,
  fallbackParentPid: number = process.ppid,
): ContinueScopeContext {
  const overrideScope = env[CONTINUE_SCOPE_OVERRIDE_ENV_KEY]?.trim();
  let scopeDescriptor = '';
  let scopeSource = '';

  if (overrideScope) {
    scopeDescriptor = `${CONTINUE_SCOPE_OVERRIDE_ENV_KEY}:${overrideScope}`;
    scopeSource = CONTINUE_SCOPE_OVERRIDE_ENV_KEY;
  } else {
    for (const envKey of CONTINUE_SCOPE_ENV_MARKERS) {
      const rawValue = env[envKey];
      if (typeof rawValue !== 'string') {
        continue;
      }

      const markerValue = rawValue.trim();
      if (!markerValue) {
        continue;
      }

      scopeDescriptor = `${envKey}:${markerValue}`;
      scopeSource = envKey;
      break;
    }
  }

  if (!scopeDescriptor) {
    scopeDescriptor = `PPID:${fallbackParentPid}`;
    scopeSource = 'process.ppid';
  }

  const hashes = buildScopeHashes(scopeDescriptor);

  return {
    scopeDescriptor,
    scopeHash: hashes.scopeHash,
    shortHash: hashes.shortHash,
    scopeSource,
    sessionEnvKey: `${CONTINUE_SESSION_ENV_KEY_BASE}_${hashes.scopeHash}`,
    settingsEnvKey: `${CONTINUE_SETTINGS_ENV_KEY_BASE}_${hashes.scopeHash}`,
  };
}

export async function markContinueScopeRunning(
  workingDirectory: string,
  context: ContinueScopeContext,
  pid: number = process.pid,
): Promise<void> {
  const runtimeFilePath = getRuntimeFilePath(workingDirectory);
  const document = await readRuntimeDocument(runtimeFilePath);

  document.scopes[context.scopeHash] = {
    pid,
    startedAt: new Date().toISOString(),
  };

  await writeRuntimeDocument(runtimeFilePath, document);
}

export async function clearContinueScopeRunning(
  workingDirectory: string,
  context: ContinueScopeContext,
): Promise<void> {
  const runtimeFilePath = getRuntimeFilePath(workingDirectory);
  const document = await readRuntimeDocument(runtimeFilePath);

  if (!document.scopes[context.scopeHash]) {
    return;
  }

  delete document.scopes[context.scopeHash];

  if (Object.keys(document.scopes).length === 0) {
    await fs.remove(runtimeFilePath);
    return;
  }

  await writeRuntimeDocument(runtimeFilePath, document);
}

export async function resolveContinueScopeStatus(options: {
  workingDirectory: string;
  requestedHash?: string;
  env?: NodeJS.ProcessEnv;
  currentScope?: ContinueScopeContext;
}): Promise<ContinueScopeStatusResult> {
  const env = options.env || process.env;
  const currentScope = options.currentScope || resolveContinueScopeContext(env);
  const runtimeFilePath = getRuntimeFilePath(options.workingDirectory);
  const runtimeDocument = await readRuntimeDocument(runtimeFilePath);

  const knownHashes = new Set<string>([
    ...Object.keys(runtimeDocument.scopes),
    ...extractKnownScopeHashesFromEnv(env),
    currentScope.scopeHash,
  ]);

  const { scopeHash, isCurrentScope } = resolveTargetScopeHash(
    options.requestedHash,
    currentScope,
    knownHashes,
  );

  const context = isCurrentScope
    ? currentScope
    : buildContextFromHash(scopeHash, 'hash_lookup');

  const runtimeEntry = runtimeDocument.scopes[scopeHash];
  if (runtimeEntry) {
    if (isProcessAlive(runtimeEntry.pid)) {
      return {
        status: 'running',
        hash: context.shortHash,
        fullHash: context.scopeHash,
        scopeSource: context.scopeSource,
        sessionEnvKey: context.sessionEnvKey,
        settingsEnvKey: context.settingsEnvKey,
        sessionId: typeof env[context.sessionEnvKey] === 'string' ? env[context.sessionEnvKey]!.trim() : null,
        isCurrentScope,
        pid: runtimeEntry.pid,
      };
    }

    delete runtimeDocument.scopes[scopeHash];
    if (Object.keys(runtimeDocument.scopes).length === 0) {
      await fs.remove(runtimeFilePath);
    } else {
      await writeRuntimeDocument(runtimeFilePath, runtimeDocument);
    }

    return {
      status: 'error',
      hash: context.shortHash,
      fullHash: context.scopeHash,
      scopeSource: context.scopeSource,
      sessionEnvKey: context.sessionEnvKey,
      settingsEnvKey: context.settingsEnvKey,
      sessionId: typeof env[context.sessionEnvKey] === 'string' ? env[context.sessionEnvKey]!.trim() : null,
      isCurrentScope,
      pid: runtimeEntry.pid,
      reason: 'stale_runtime_marker',
    };
  }

  const sessionValue = env[context.sessionEnvKey];
  const settingsValue = env[context.settingsEnvKey];
  const sessionId = typeof sessionValue === 'string' && sessionValue.trim() ? sessionValue.trim() : null;

  if (!sessionId && (typeof settingsValue !== 'string' || !settingsValue.trim())) {
    return {
      status: 'not_found',
      hash: context.shortHash,
      fullHash: context.scopeHash,
      scopeSource: context.scopeSource,
      sessionEnvKey: context.sessionEnvKey,
      settingsEnvKey: context.settingsEnvKey,
      sessionId: null,
      isCurrentScope,
      pid: null,
    };
  }

  const hasValidSettings = looksLikeValidSettingsSnapshot(settingsValue);
  if (sessionId && hasValidSettings) {
    return {
      status: 'finished',
      hash: context.shortHash,
      fullHash: context.scopeHash,
      scopeSource: context.scopeSource,
      sessionEnvKey: context.sessionEnvKey,
      settingsEnvKey: context.settingsEnvKey,
      sessionId,
      isCurrentScope,
      pid: null,
    };
  }

  return {
    status: 'error',
    hash: context.shortHash,
    fullHash: context.scopeHash,
    scopeSource: context.scopeSource,
    sessionEnvKey: context.sessionEnvKey,
    settingsEnvKey: context.settingsEnvKey,
    sessionId,
    isCurrentScope,
    pid: null,
    reason: 'invalid_snapshot',
  };
}
