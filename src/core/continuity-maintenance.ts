import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import fs from 'fs-extra';

import type { ContinueScopeContext } from './continue-scope.js';
import { resolveContinueScopeContext } from './continue-scope.js';
import {
  CONTINUITY_INACTIVE_SCOPE_LIMIT,
  CONTINUITY_SCOPE_TTL_DAYS,
  getSessionContinuityFilePath,
  loadSessionContinuityDocument,
  parseContinueSettingsSnapshot,
  type SessionContinuityDocument,
  type SessionContinuityScope,
} from './session-continuity-state.js';
import {
  getSessionMetadataDirectory,
  SESSION_CONTINUITY_SHARED_LOCK_NAME,
  withSessionMetadataLock,
} from './session-metadata.js';

const PLAN_VERSION = 1;
const RECEIPT_VERSION = 1;
const DEFAULT_ENV = '.env.juno';
const CONFIG = path.join('.juno_task', 'config.json');
const SESSION_PREFIX = 'JUNO_CODE_LAST_SESSION_ID_SCOPE_';
const SETTINGS_PREFIX = 'JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_';
const LEGACY_SESSION = 'JUNO_CODE_LAST_SESSION_ID';
const LEGACY_SETTINGS = 'JUNO_CODE_LAST_EXECUTION_SETTINGS';
const SCOPE = /^SCOPE_[A-F0-9]{16}$/;
const TTL_MS = CONTINUITY_SCOPE_TTL_DAYS * 24 * 60 * 60 * 1000;
const MAX_INACTIVE = CONTINUITY_INACTIVE_SCOPE_LIMIT;

type Kind = 'session' | 'settings';
interface Assignment {
  key: string;
  kind: Kind;
  scopeHash: string | null;
  value: string;
  raw: Buffer;
  offset: number;
  length: number;
}
interface ParsedEnv {
  filePath: string;
  exists: boolean;
  bytes: Buffer;
  sha256: string;
  mode: number;
  assignments: Assignment[];
  assignmentKeys: number;
  duplicateKeys: string[];
  malformedLines: number;
  completePairs: number;
  orphanPairs: number;
  mtime: string;
}
export interface ContinuityFileInventory {
  path: string;
  exists: boolean;
  bytes: number;
  sha256: string;
  keys: number;
  continuityAssignments: number;
  completePairs: number;
  orphanPairs: number;
  duplicates: number;
  malformed: number;
}
export interface ContinuityInventory {
  version: 1;
  files: ContinuityFileInventory[];
  metadata: {
    path: string;
    exists: boolean;
    sha256: string | null;
    scopes: number;
    pinned: number;
    named: number;
    olderThan30Days: number;
  };
  totals: {
    bytes: number;
    keys: number;
    continuityAssignments: number;
    completePairs: number;
    orphanPairs: number;
    duplicates: number;
    malformed: number;
  };
  projected: {
    removedAssignments: number;
    importedScopes: number;
    expiredScopes: number;
    lruScopes: number;
    protectedScopes: number;
  };
}
interface PlanFile extends ContinuityFileInventory {
  mode: number;
  mtime: string;
}
export interface ContinuityMigrationPlan {
  version: 1;
  kind: 'juno-continuity-reviewed-plan';
  createdAt: string;
  workingDirectory: string;
  currentScope: string;
  files: PlanFile[];
  metadata: { path: string; exists: boolean; sha256: string | null };
  runtime: { path: string; exists: boolean; sha256: string | null };
  keepScopes: string[];
  projected: ContinuityInventory['projected'];
  policy: { ttlDays: 30; maxInactiveScopes: 128 };
}
interface ReceiptFile {
  path: string;
  beforeSha256: string;
  afterSha256: string;
  backupPath: string;
  existed: boolean;
  mode: number;
}
interface Receipt {
  version: 1;
  kind: 'juno-continuity-receipt';
  appliedAt: string;
  workingDirectory: string;
  planSha256: string;
  files: ReceiptFile[];
  metadata: ReceiptFile;
  backups: Array<{ path: string; sha256: string }>;
  counts: ContinuityMigrationPlan['projected'];
  policy: ContinuityMigrationPlan['policy'];
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function cleanRoot(candidate: string): string {
  return path.resolve(candidate);
}
function decodeValue(raw: string): string {
  const value = raw.trimStart();
  if (value.startsWith("'")) {
    const match = /^'([^']*)'\s*(?:#.*)?$/.exec(value);
    if (!match) throw new Error('malformed single-quoted continuity value');
    return match[1]!;
  }
  if (value.startsWith('"')) {
    let closing = -1;
    for (let index = 1; index < value.length; index++) {
      if (value[index] !== '"') continue;
      let escapes = 0;
      for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) escapes++;
      if (escapes % 2 === 0) {
        closing = index;
        break;
      }
    }
    if (closing < 0 || !/^\s*(?:#.*)?$/.test(value.slice(closing + 1)))
      throw new Error('malformed double-quoted continuity value');
    return value
      .slice(1, closing)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return value.trimEnd().replace(/\s+#.*$/, '');
}
function identify(key: string): { kind: Kind; scopeHash: string | null } | null {
  if (key === LEGACY_SESSION) return { kind: 'session', scopeHash: null };
  if (key === LEGACY_SETTINGS) return { kind: 'settings', scopeHash: null };
  if (key.startsWith(SESSION_PREFIX)) {
    const scopeHash = `SCOPE_${key.slice(SESSION_PREFIX.length)}`;
    return SCOPE.test(scopeHash) ? { kind: 'session', scopeHash } : null;
  }
  if (key.startsWith(SETTINGS_PREFIX)) {
    const scopeHash = `SCOPE_${key.slice(SETTINGS_PREFIX.length)}`;
    return SCOPE.test(scopeHash) ? { kind: 'settings', scopeHash } : null;
  }
  return null;
}
function continuityLike(key: string): boolean {
  return (
    key === LEGACY_SESSION ||
    key === LEGACY_SETTINGS ||
    key.startsWith(SESSION_PREFIX) ||
    key.startsWith(SETTINGS_PREFIX)
  );
}
function lines(bytes: Buffer): Array<{ raw: Buffer; offset: number }> {
  const result: Array<{ raw: Buffer; offset: number }> = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) {
      result.push({ raw: bytes.subarray(start, i + 2), offset: start });
      start = ++i + 1;
    } else if (bytes[i] === 10 || bytes[i] === 13) {
      result.push({ raw: bytes.subarray(start, i + 1), offset: start });
      start = i + 1;
    }
  }
  if (start < bytes.length) result.push({ raw: bytes.subarray(start), offset: start });
  return result;
}
async function parseEnv(filePath: string): Promise<ParsedEnv> {
  let bytes: Buffer;
  let stat;
  let exists = true;
  try {
    bytes = await fs.readFile(filePath);
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
    bytes = Buffer.alloc(0);
    stat = { mode: 0o600, mtime: new Date(0) };
  }
  const assignments: Assignment[] = [];
  const allKeys: string[] = [];
  let malformedLines = 0;
  for (const line of lines(bytes)) {
    const text = line.raw.toString('utf8').replace(/(?:\r\n|\n|\r)$/, '');
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(text);
    if (!match) {
      if (
        /^\s*(?:export\s+)?JUNO_CODE_LAST_(?:SESSION_ID|EXECUTION_SETTINGS)(?:_SCOPE_\S+)?/.test(
          text,
        )
      )
        malformedLines++;
      continue;
    }
    const key = match[1]!;
    allKeys.push(key);
    const identity = identify(key);
    if (!identity) {
      if (continuityLike(key)) malformedLines++;
      continue;
    }
    let value: string;
    try {
      value = decodeValue(match[2]!);
    } catch {
      malformedLines++;
      continue;
    }
    assignments.push({
      key,
      ...identity,
      value,
      raw: line.raw,
      offset: line.offset,
      length: line.raw.length,
    });
  }
  const counts = new Map<string, number>();
  for (const item of assignments) counts.set(item.key, (counts.get(item.key) || 0) + 1);
  const duplicateKeys = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
  const pairs = new Map<string, Set<Kind>>();
  for (const item of assignments) {
    const key = item.scopeHash ?? '<legacy>';
    if (!pairs.has(key)) pairs.set(key, new Set());
    pairs.get(key)!.add(item.kind);
  }
  const completePairs = [...pairs.values()].filter((pair) => pair.size === 2).length;
  return {
    filePath,
    exists,
    bytes,
    sha256: digest(bytes),
    mode: stat.mode & 0o777,
    assignments,
    assignmentKeys: new Set(allKeys).size,
    duplicateKeys,
    malformedLines,
    completePairs,
    orphanPairs: pairs.size - completePairs,
    mtime: stat.mtime.toISOString(),
  };
}
async function envPaths(root: string): Promise<string[]> {
  const paths = [path.join(root, DEFAULT_ENV)];
  const configPath = path.join(root, CONFIG);
  if (await fs.pathExists(configPath)) {
    let config: unknown;
    try {
      config = await fs.readJson(configPath);
    } catch (error) {
      throw new Error(`Cannot inventory continuity with malformed ${configPath}: ${String(error)}`);
    }
    const custom = (config as { envFilePath?: unknown }).envFilePath;
    if (custom !== undefined && (typeof custom !== 'string' || !custom.trim()))
      throw new Error(`Invalid envFilePath in ${configPath}.`);
    if (typeof custom === 'string') paths.push(path.resolve(root, custom));
  }
  return [...new Set(paths.map((item) => path.resolve(item)))];
}
function fileInventory(file: ParsedEnv): ContinuityFileInventory {
  return {
    path: file.filePath,
    exists: file.exists,
    bytes: file.bytes.length,
    sha256: file.sha256,
    keys: file.assignmentKeys,
    continuityAssignments: file.assignments.length,
    completePairs: file.completePairs,
    orphanPairs: file.orphanPairs,
    duplicates: file.duplicateKeys.length,
    malformed: file.malformedLines,
  };
}
function assertSafe(files: ParsedEnv[]): void {
  const duplicate = files.reduce((sum, file) => sum + file.duplicateKeys.length, 0);
  const malformed = files.reduce((sum, file) => sum + file.malformedLines, 0);
  if (duplicate)
    throw new Error(
      `Continuity inventory found ${duplicate} duplicate continuity key(s); refusing to continue.`,
    );
  if (malformed)
    throw new Error(
      `Continuity inventory found ${malformed} malformed continuity assignment(s); refusing to continue.`,
    );
  const seen = new Map<string, string>();
  for (const file of files)
    for (const item of file.assignments) {
      const identity = `${item.scopeHash ?? '<legacy>'}:${item.kind}`;
      const previous = seen.get(identity);
      if (previous !== undefined && previous !== item.value)
        throw new Error(`Conflicting continuity state for ${identity}; refusing to continue.`);
      seen.set(identity, item.value);
    }
}
async function metadataSnapshot(root: string): Promise<{
  document: SessionContinuityDocument;
  bytes: Buffer | null;
  sha256: string | null;
  path: string;
}> {
  const filePath = getSessionContinuityFilePath(root);
  let bytes: Buffer | null = null;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    document: await loadSessionContinuityDocument(root),
    bytes,
    sha256: bytes ? digest(bytes) : null,
    path: filePath,
  };
}
function currentContext(root: string, supplied?: ContinueScopeContext): ContinueScopeContext {
  return supplied ?? resolveContinueScopeContext(process.env, process.ppid, root);
}
function importEntries(
  files: ParsedEnv[],
  current: ContinueScopeContext,
): Map<
  string,
  { session?: string; settings?: ReturnType<typeof parseContinueSettingsSnapshot>; at: string }
> {
  const imported = new Map<
    string,
    { session?: string; settings?: ReturnType<typeof parseContinueSettingsSnapshot>; at: string }
  >();
  for (const file of files)
    for (const item of file.assignments) {
      const scope = item.scopeHash ?? current.scopeHash;
      const entry = imported.get(scope) ?? { at: file.mtime };
      if (item.kind === 'session') {
        if (!item.value.trim())
          throw new Error(`Malformed empty continuity session assignment for ${scope}.`);
        if (entry.session !== undefined && entry.session !== item.value)
          throw new Error(`Conflicting continuity session state for ${scope}.`);
        entry.session = item.value.trim();
      } else {
        const settings = parseContinueSettingsSnapshot(item.value);
        if (
          entry.settings !== undefined &&
          JSON.stringify(entry.settings) !== JSON.stringify(settings)
        )
          throw new Error(`Conflicting continuity settings state for ${scope}.`);
        entry.settings = settings;
      }
      imported.set(scope, entry);
    }
  return imported;
}
function processIsAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
function runtimePath(root: string): string {
  return path.join(getSessionMetadataDirectory(root), 'continue_scope_runtime.json');
}
async function runtimeSnapshot(root: string): Promise<{
  path: string;
  exists: boolean;
  sha256: string | null;
}> {
  const filePath = runtimePath(root);
  try {
    const bytes = await fs.readFile(filePath);
    return { path: filePath, exists: true, sha256: digest(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { path: filePath, exists: false, sha256: null };
    throw error;
  }
}
async function liveScopes(root: string): Promise<Set<string>> {
  try {
    const value = (await fs.readJson(runtimePath(root))) as {
      version?: unknown;
      scopes?: Record<string, { pid?: unknown }>;
    };
    if (value.version !== 1 || !value.scopes || typeof value.scopes !== 'object') return new Set();
    return new Set(
      Object.entries(value.scopes)
        .filter(([, item]) => processIsAlive(item?.pid))
        .map(([hash]) => hash),
    );
  } catch {
    return new Set();
  }
}
function scopeAt(scope: SessionContinuityScope): number {
  return Date.parse(scope.lastUsedAt);
}
async function project(
  root: string,
  files: ParsedEnv[],
  document: SessionContinuityDocument,
  current: ContinueScopeContext,
  now: Date,
) {
  const imported = importEntries(files, current);
  const candidates = new Map<string, { at: number; protected: boolean }>();
  const live = await liveScopes(root);
  for (const [hash, scope] of Object.entries(document.scopes))
    candidates.set(hash, {
      at: scopeAt(scope),
      protected:
        hash === current.scopeHash ||
        scope.pinned ||
        Object.keys(scope.branches).some((name) => name !== 'main') ||
        live.has(hash),
    });
  for (const [hash, item] of imported) {
    const existing = document.scopes[hash];
    if (existing && item.session && existing.branches[existing.active]?.session_id !== item.session)
      throw new Error(`Conflicting canonical and legacy continuity state for ${hash}.`);
    if (
      existing?.settings &&
      item.settings &&
      JSON.stringify(existing.settings) !== JSON.stringify(item.settings)
    )
      throw new Error(`Conflicting canonical and legacy settings for ${hash}.`);
    const at = Number.isFinite(Date.parse(item.at)) ? Date.parse(item.at) : now.getTime();
    const old = candidates.get(hash);
    candidates.set(hash, {
      at: Math.max(old?.at ?? 0, at),
      protected: old?.protected === true || hash === current.scopeHash || live.has(hash),
    });
  }
  const keep = new Set([...candidates].filter(([, item]) => item.protected).map(([hash]) => hash));
  let expiredScopes = 0;
  const eligible = [...candidates]
    .filter(([, item]) => !item.protected && now.getTime() - item.at <= TTL_MS)
    .sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0]));
  expiredScopes = [...candidates].filter(
    ([, item]) => !item.protected && now.getTime() - item.at > TTL_MS,
  ).length;
  for (const [hash] of eligible.slice(0, MAX_INACTIVE)) keep.add(hash);
  return {
    keepScopes: [...keep].sort(),
    importedScopes: [...imported].filter(
      ([hash, value]) => value.session && keep.has(hash) && !document.scopes[hash],
    ).length,
    expiredScopes,
    lruScopes: Math.max(0, eligible.length - MAX_INACTIVE),
    protectedScopes: [...candidates.values()].filter((item) => item.protected).length,
  };
}
export async function inspectContinuityState(options: {
  workingDirectory: string;
  context?: ContinueScopeContext;
  now?: Date;
}): Promise<ContinuityInventory> {
  const root = cleanRoot(options.workingDirectory);
  const files = await Promise.all((await envPaths(root)).map(parseEnv));
  assertSafe(files);
  const metadata = await metadataSnapshot(root);
  const now = options.now ?? new Date();
  const projected = await project(
    root,
    files,
    metadata.document,
    currentContext(root, options.context),
    now,
  );
  const inventories = files.map(fileInventory);
  const scopes = Object.values(metadata.document.scopes);
  return {
    version: 1,
    files: inventories,
    metadata: {
      path: metadata.path,
      exists: metadata.bytes !== null,
      sha256: metadata.sha256,
      scopes: scopes.length,
      pinned: scopes.filter((scope) => scope.pinned).length,
      named: scopes.filter((scope) => Object.keys(scope.branches).some((name) => name !== 'main'))
        .length,
      olderThan30Days: scopes.filter((scope) => now.getTime() - scopeAt(scope) > TTL_MS).length,
    },
    totals: {
      bytes: inventories.reduce((n, item) => n + item.bytes, 0),
      keys: inventories.reduce((n, item) => n + item.keys, 0),
      continuityAssignments: inventories.reduce((n, item) => n + item.continuityAssignments, 0),
      completePairs: inventories.reduce((n, item) => n + item.completePairs, 0),
      orphanPairs: inventories.reduce((n, item) => n + item.orphanPairs, 0),
      duplicates: 0,
      malformed: 0,
    },
    projected: {
      removedAssignments: inventories.reduce((n, item) => n + item.continuityAssignments, 0),
      ...projected,
    },
  };
}
async function atomicWrite(filePath: string, bytes: Buffer, mode: number): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await nodeFs.open(temporary, 'w', mode || 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(temporary, mode || 0o600);
  await fs.rename(temporary, filePath);
  try {
    const directory = await nodeFs.open(path.dirname(filePath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    /* best effort on unsupported directory fsync */
  }
  if (!(await fs.readFile(filePath)).equals(bytes))
    throw new Error(`Atomic readback failed for ${filePath}.`);
}
async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
}
export async function createContinuityMigrationPlan(options: {
  workingDirectory: string;
  planPath: string;
  context?: ContinueScopeContext;
  now?: Date;
}): Promise<ContinuityMigrationPlan> {
  const root = cleanRoot(options.workingDirectory);
  const metadataDirectory = getSessionMetadataDirectory(root);
  return withSessionMetadataLock(metadataDirectory, SESSION_CONTINUITY_SHARED_LOCK_NAME, async () => {
    const files = await Promise.all((await envPaths(root)).map(parseEnv));
    assertSafe(files);
    const metadata = await metadataSnapshot(root);
    const now = options.now ?? new Date();
    const context = currentContext(root, options.context);
    const projection = await project(root, files, metadata.document, context, now);
    const runtime = await runtimeSnapshot(root);
    const plan: ContinuityMigrationPlan = {
      version: 1,
      kind: 'juno-continuity-reviewed-plan',
      createdAt: now.toISOString(),
      workingDirectory: root,
      currentScope: context.scopeHash,
      files: files.map((file) => ({ ...fileInventory(file), mode: file.mode, mtime: file.mtime })),
      metadata: { path: metadata.path, exists: metadata.bytes !== null, sha256: metadata.sha256 },
      runtime,
      keepScopes: projection.keepScopes,
      projected: {
        removedAssignments: files.reduce((n, file) => n + file.assignments.length, 0),
        importedScopes: projection.importedScopes,
        expiredScopes: projection.expiredScopes,
        lruScopes: projection.lruScopes,
        protectedScopes: projection.protectedScopes,
      },
      policy: { ttlDays: 30, maxInactiveScopes: 128 },
    };
    await writePrivateJson(path.resolve(options.planPath), plan);
    return plan;
  });
}
function assertPlan(value: unknown, root: string): asserts value is ContinuityMigrationPlan {
  const plan = value as Partial<ContinuityMigrationPlan>;
  if (
    !plan ||
    plan.version !== PLAN_VERSION ||
    plan.kind !== 'juno-continuity-reviewed-plan' ||
    plan.workingDirectory !== root ||
    !Array.isArray(plan.files) ||
    !Array.isArray(plan.keepScopes) ||
    !plan.runtime ||
    typeof plan.runtime.path !== 'string' ||
    (plan.runtime.sha256 !== null && !/^[a-f0-9]{64}$/.test(plan.runtime.sha256)) ||
    !SCOPE.test(plan.currentScope || '') ||
    !plan.keepScopes.every((scope) => typeof scope === 'string' && SCOPE.test(scope)) ||
    plan.policy?.ttlDays !== 30 ||
    plan.policy?.maxInactiveScopes !== 128
  )
    throw new Error('Invalid or ambiguous continuity reviewed plan.');
}
function withoutContinuity(file: ParsedEnv): Buffer {
  if (!file.assignments.length) return file.bytes;
  const remove = new Set(file.assignments.map((item) => item.offset));
  return Buffer.concat(
    lines(file.bytes)
      .filter((line) => !remove.has(line.offset))
      .map((line) => line.raw),
  );
}
function mergedDocument(
  document: SessionContinuityDocument,
  files: ParsedEnv[],
  plan: ContinuityMigrationPlan,
): SessionContinuityDocument {
  const result: SessionContinuityDocument = JSON.parse(
    JSON.stringify(document),
  ) as SessionContinuityDocument;
  const imported = importEntries(files, { scopeHash: plan.currentScope } as ContinueScopeContext);
  for (const hash of Object.keys(result.scopes))
    if (!plan.keepScopes.includes(hash)) delete result.scopes[hash];
  for (const [hash, item] of imported) {
    if (!plan.keepScopes.includes(hash)) continue;
    const existing = result.scopes[hash];
    if (existing) {
      if (item.session && existing.branches[existing.active]?.session_id !== item.session)
        throw new Error(`Conflicting canonical and legacy continuity state for ${hash}.`);
      if (
        item.settings &&
        existing.settings &&
        JSON.stringify(item.settings) !== JSON.stringify(existing.settings)
      )
        throw new Error(`Conflicting canonical and legacy settings for ${hash}.`);
      if (!existing.settings && item.settings) existing.settings = item.settings;
      continue;
    }
    if (!item.session) continue;
    result.scopes[hash] = {
      source:
        hash === plan.currentScope ? 'legacy_current_scope_import' : 'legacy_scoped_env_import',
      createdAt: item.at,
      lastUsedAt: item.at,
      pinned: false,
      settings: item.settings ?? null,
      active: 'main',
      branches: { main: { session_id: item.session, parent: null, updated_at: item.at } },
    };
  }
  return result;
}
async function backup(
  filePath: string,
  backupPath: string,
): Promise<{ bytes: Buffer | null; mode: number }> {
  try {
    const [bytes, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    await atomicWrite(backupPath, bytes, 0o600);
    return { bytes, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, mode: 0o600 };
    throw error;
  }
}
export async function applyContinuityMigrationPlan(options: {
  workingDirectory: string;
  planPath: string;
  context?: ContinueScopeContext;
}): Promise<{ receiptPath: string }> {
  const root = cleanRoot(options.workingDirectory);
  const rawPlan = await fs.readFile(path.resolve(options.planPath));
  const plan = JSON.parse(rawPlan.toString('utf8')) as unknown;
  assertPlan(plan, root);
  const metadataDirectory = getSessionMetadataDirectory(root);
  return withSessionMetadataLock(metadataDirectory, SESSION_CONTINUITY_SHARED_LOCK_NAME, async () => {
    const applyContext = currentContext(root, options.context);
    if (applyContext.scopeHash !== plan.currentScope)
      throw new Error('Reviewed continuity plan is stale: the current scope changed.');
    const runtime = await runtimeSnapshot(root);
    if (
      runtime.path !== plan.runtime.path ||
      runtime.exists !== plan.runtime.exists ||
      runtime.sha256 !== plan.runtime.sha256
    )
      throw new Error('Reviewed continuity plan is stale: live scope evidence changed.');
    const files = await Promise.all((await envPaths(root)).map(parseEnv));
    assertSafe(files);
    if (
      files.length !== plan.files.length ||
      files.some(
        (file, index) =>
          file.filePath !== plan.files[index]?.path ||
          file.exists !== plan.files[index]?.exists ||
          file.sha256 !== plan.files[index]?.sha256,
      )
    )
      throw new Error('Reviewed continuity plan is stale: an env file changed.');
    const beforeMetadata = await metadataSnapshot(root);
    if (
      beforeMetadata.path !== plan.metadata.path ||
      beforeMetadata.sha256 !== plan.metadata.sha256
    )
      throw new Error('Reviewed continuity plan is stale: continuity metadata changed.');
    const run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const directory = path.join(metadataDirectory, 'continuity-maintenance', run);
    await fs.ensureDir(directory);
    await fs.chmod(directory, 0o700);
    const receiptFiles: ReceiptFile[] = [];
    const backups: Array<{ path: string; sha256: string }> = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const backupPath = path.join(directory, `env-${index}.bak`);
      const saved = await backup(file.filePath, backupPath);
      if (
        (saved.bytes !== null) !== file.exists ||
        (saved.bytes !== null && digest(saved.bytes) !== file.sha256)
      )
        throw new Error(
          `Reviewed continuity plan is stale: ${file.filePath} changed while backups were created.`,
        );
      if (saved.bytes !== null)
        backups.push({ path: backupPath, sha256: digest(saved.bytes) });
      receiptFiles.push({
        path: file.filePath,
        beforeSha256: file.sha256,
        afterSha256: digest(withoutContinuity(file)),
        backupPath,
        existed: saved.bytes !== null,
        mode: saved.mode,
      });
    }
    const metadataBackup = path.join(directory, 'metadata.bak');
    const savedMetadata = await backup(beforeMetadata.path, metadataBackup);
    if (savedMetadata.bytes)
      backups.push({ path: metadataBackup, sha256: digest(savedMetadata.bytes) });
    const next = mergedDocument(beforeMetadata.document, files, plan);
    const metadataBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    if ((savedMetadata.bytes ? digest(savedMetadata.bytes) : null) !== beforeMetadata.sha256)
      throw new Error(
        'Reviewed continuity plan is stale: metadata changed while backups were created.',
      );
    const metadataReceipt: ReceiptFile = {
      path: beforeMetadata.path,
      beforeSha256: beforeMetadata.sha256 ?? digest(''),
      afterSha256: digest(metadataBytes),
      backupPath: metadataBackup,
      existed: savedMetadata.bytes !== null,
      mode: savedMetadata.mode,
    };
    const receipt: Receipt = {
      version: 1,
      kind: 'juno-continuity-receipt',
      appliedAt: new Date().toISOString(),
      workingDirectory: root,
      planSha256: digest(rawPlan),
      files: receiptFiles,
      metadata: metadataReceipt,
      backups,
      counts: plan.projected,
      policy: plan.policy,
    };
    const receiptPath = path.join(directory, 'receipt.json');
    // Persist the rollback contract before the first destructive write.
    await writePrivateJson(receiptPath, receipt);
    try {
      await atomicWrite(beforeMetadata.path, metadataBytes, savedMetadata.mode || 0o600);
      await loadSessionContinuityDocument(root);
      for (const file of files) {
        const expectedDigest = file.exists ? file.sha256 : null;
        if ((await currentDigest(file.filePath)) !== expectedDigest)
          throw new Error(
            `Env file changed concurrently: ${file.filePath}; refusing to overwrite it.`,
          );
        if (file.exists)
          await atomicWrite(file.filePath, withoutContinuity(file), file.mode || 0o600);
      }
    } catch (error) {
      throw new Error(
        `Continuity apply stopped after its rollback receipt was written at ${receiptPath}. ` +
          `Run continuity rollback with that receipt after resolving the write failure. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { receiptPath };
  });
}
function assertReceipt(value: unknown, root: string): asserts value is Receipt {
  const receipt = value as Partial<Receipt>;
  if (
    !receipt ||
    receipt.version !== RECEIPT_VERSION ||
    receipt.kind !== 'juno-continuity-receipt' ||
    receipt.workingDirectory !== root ||
    !Array.isArray(receipt.files) ||
    !receipt.metadata
  )
    throw new Error('Invalid or ambiguous continuity receipt.');
}
async function currentDigest(filePath: string): Promise<string | null> {
  try {
    return digest(await fs.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function restore(item: ReceiptFile): Promise<void> {
  if (!item.existed) {
    await fs.remove(item.path);
    return;
  }
  const bytes = await fs.readFile(item.backupPath);
  if (digest(bytes) !== item.beforeSha256)
    throw new Error(`Backup changed for ${item.path}; refusing rollback.`);
  await atomicWrite(item.path, bytes, item.mode || 0o600);
}
export async function rollbackContinuityMigration(options: {
  workingDirectory: string;
  receiptPath: string;
}): Promise<void> {
  const root = cleanRoot(options.workingDirectory);
  const receiptPath = path.resolve(options.receiptPath);
  const receipt = (await fs.readJson(receiptPath)) as unknown;
  assertReceipt(receipt, root);
  const expectedEnvPaths = await envPaths(root);
  const expectedMetadataPath = getSessionContinuityFilePath(root);
  const receiptDirectory = path.dirname(receiptPath);
  if (
    receipt.files.length !== expectedEnvPaths.length ||
    receipt.files.some((item, index) => item.path !== expectedEnvPaths[index]) ||
    receipt.metadata.path !== expectedMetadataPath
  )
    throw new Error('Receipt paths do not match this project continuity state; refusing rollback.');
  for (const item of [...receipt.files, receipt.metadata]) {
    const relativeBackup = path.relative(receiptDirectory, path.resolve(item.backupPath));
    if (
      relativeBackup.startsWith('..') ||
      path.isAbsolute(relativeBackup) ||
      !/^[a-f0-9]{64}$/.test(item.beforeSha256) ||
      !/^[a-f0-9]{64}$/.test(item.afterSha256)
    )
      throw new Error('Receipt contains an unsafe or malformed rollback entry.');
  }
  await withSessionMetadataLock(
    getSessionMetadataDirectory(root),
    SESSION_CONTINUITY_SHARED_LOCK_NAME,
    async () => {
      for (const item of [...receipt.files, receipt.metadata]) {
        const observed = await currentDigest(item.path);
        const before = item.existed ? item.beforeSha256 : null;
        if (observed !== item.afterSha256 && observed !== before)
          throw new Error(`File changed since continuity apply: ${item.path}; refusing rollback.`);
      }
      await restore(receipt.metadata);
      for (const item of receipt.files) await restore(item);
    },
  );
}
