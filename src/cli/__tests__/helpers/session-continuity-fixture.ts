import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { expect } from 'vitest';

import {
  CONTINUE_SCOPE_OVERRIDE_ENV_KEY,
  resolveContinueScopeContext,
  type ContinueScopeContext,
} from '../../../core/continue-scope.js';

export interface SessionContinuityBranchFixture {
  name: string;
  sessionId: string;
  parent?: string | null;
  sourceSessionId?: string | null;
  updatedAt?: string;
}

export interface SessionContinuityFixtureOptions {
  projectRoot?: string;
  tempPrefix?: string;
  scope: string;
  envSessionId?: string;
  settings?: Record<string, unknown>;
  branches?: SessionContinuityBranchFixture[];
  activeBranch?: string;
  history?: unknown;
  seedProcessEnv?: boolean;
  config?: Record<string, unknown>;
}

export interface SessionContinuityFixture {
  projectRoot: string;
  ownsProjectRoot: boolean;
  scopeName: string;
  scope: ContinueScopeContext;
  env: Record<string, string>;
  cleanup(): Promise<void>;
  restoreProcessEnv(): void;
  readEnvFile(): Promise<string>;
  readBranchState(): Promise<any>;
  writeEnvSession(sessionId: string): Promise<void>;
  assertEnvSession(sessionId: string): Promise<void>;
  assertActiveBranch(branchName: string, sessionId?: string): Promise<void>;
  assertScopeInvariant(expectedActiveBranch: string, expectedSessionId: string): Promise<void>;
}

export const DEFAULT_SESSION_CONTINUITY_SETTINGS = {
  version: 1,
  subagent: 'pi',
  maxIterations: 1,
};

export function explicitContinueScopeHash(scope: string): string {
  const digest = createHash('sha256')
    .update(`${CONTINUE_SCOPE_OVERRIDE_ENV_KEY}:${scope}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `SCOPE_${digest}`;
}

export function createSessionContinuityConfig(
  projectRoot: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    defaultSubagent: 'pi',
    defaultBackend: 'shell',
    defaultMaxIterations: 1,
    defaultModel: ':pi',
    defaultModels: { pi: ':pi' },
    logLevel: 'info',
    verbose: 0,
    quiet: true,
    mcpTimeout: 30000,
    mcpRetries: 0,
    onHourlyLimit: 'raise',
    interactive: false,
    headlessMode: true,
    workingDirectory: projectRoot,
    sessionDirectory: path.join(projectRoot, '.juno_task'),
    envFilePath: '.env.yylo',
    envFileCopied: true,
    hooks: {},
    ...overrides,
  };
}

function quoteEnvValue(value: string, quote: 'single' | 'double'): string {
  if (quote === 'single') {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function writeEnvSnapshot(
  projectRoot: string,
  scopeName: string,
  scope: ContinueScopeContext,
  sessionId: string | undefined,
  settings: Record<string, unknown> | undefined,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: scopeName };
  const lines: string[] = [];

  if (sessionId !== undefined) {
    env[scope.sessionEnvKey] = sessionId;
    lines.push(`${scope.sessionEnvKey}=${quoteEnvValue(sessionId, 'double')}`);
  }

  if (settings !== undefined) {
    const settingsJson = JSON.stringify(settings);
    env[scope.settingsEnvKey] = settingsJson;
    lines.push(`${scope.settingsEnvKey}=${quoteEnvValue(settingsJson, 'single')}`);
  }

  if (lines.length > 0) {
    const envPath = path.join(projectRoot, '.env.yylo');
    const existing = (await fs.pathExists(envPath)) ? await fs.readFile(envPath, 'utf-8') : '';
    await fs.writeFile(envPath, `${existing}${lines.join('\n')}\n`, 'utf-8');
  }

  return env;
}

async function writeBranchRegistry(
  projectRoot: string,
  scope: ContinueScopeContext,
  branches: SessionContinuityBranchFixture[],
  activeBranch: string | undefined,
  fallbackSessionId: string | undefined,
  settings: Record<string, unknown> | undefined,
): Promise<void> {
  if (branches.length === 0 && fallbackSessionId === undefined) return;
  const effectiveBranches = branches.length > 0 ? branches : [{ name: 'main', sessionId: fallbackSessionId! }];

  const fixtureTimestamp = new Date().toISOString();
  const branchEntries = Object.fromEntries(
    effectiveBranches.map((branch) => [
      branch.name,
      {
        session_id: branch.sessionId,
        parent: branch.parent ?? null,
        ...(branch.sourceSessionId === undefined ? {} : { source_session_id: branch.sourceSessionId }),
        updated_at: branch.updatedAt ?? fixtureTimestamp,
      },
    ]),
  );

  await fs.ensureDir(path.join(projectRoot, '.juno_task'));
  const registryPath = path.join(projectRoot, '.juno_task', 'session_continuity.v2.json');
  const existing = (await fs.pathExists(registryPath))
    ? await fs.readJson(registryPath)
    : { version: 2, scopes: {} };

  await fs.writeJson(
    registryPath,
    {
      version: 2,
      ...existing,
      scopes: {
        ...(existing.scopes ?? {}),
        [scope.scopeHash]: {
          source: scope.scopeSource,
          createdAt: fixtureTimestamp,
          lastUsedAt: fixtureTimestamp,
          pinned: false,
          settings: settings ?? null,
          active: activeBranch ?? effectiveBranches[0]?.name ?? 'main',
          branches: branchEntries,
        },
      },
    },
    { spaces: 2 },
  );
}

export async function createSessionContinuityFixture(
  options: SessionContinuityFixtureOptions,
): Promise<SessionContinuityFixture> {
  const projectRoot = options.projectRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), options.tempPrefix ?? 'juno-session-continuity-')));
  const ownsProjectRoot = options.projectRoot === undefined;
  await fs.ensureDir(projectRoot);
  await fs.ensureDir(path.join(projectRoot, '.juno_task'));

  const scope = resolveContinueScopeContext({ [CONTINUE_SCOPE_OVERRIDE_ENV_KEY]: options.scope }, undefined, projectRoot);
  const settings = options.settings ?? DEFAULT_SESSION_CONTINUITY_SETTINGS;
  const env = await writeEnvSnapshot(projectRoot, options.scope, scope, options.envSessionId, settings);

  const metadataDirectory = path.join(projectRoot, '.juno_task');
  env.YYLO_SESSION_METADATA_DIRECTORY = metadataDirectory;
  const originalProcessEnv = new Map<string, string | undefined>();
  const keysToSeed = Object.keys(env);
  if (options.seedProcessEnv) {
    for (const [key, value] of Object.entries(env)) {
      originalProcessEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  }

  if (options.config) {
    await fs.writeJson(path.join(projectRoot, '.juno_task', 'config.json'), options.config, { spaces: 2 });
  }

  await writeBranchRegistry(projectRoot, scope, options.branches ?? [], options.activeBranch, options.envSessionId, settings);

  if (options.history !== undefined) {
    await fs.writeJson(path.join(projectRoot, '.juno_task', 'session_history.json'), options.history, { spaces: 2 });
  }

  const restoreProcessEnv = () => {
    for (const key of keysToSeed) {
      if (!options.seedProcessEnv) continue;
      if (!originalProcessEnv.has(key) || originalProcessEnv.get(key) === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalProcessEnv.get(key);
      }
    }
  };

  const readEnvFile = () => fs.readFile(path.join(projectRoot, '.env.yylo'), 'utf-8');
  const readBranchState = () => fs.readJson(path.join(projectRoot, '.juno_task', 'session_continuity.v2.json'));
  const writeEnvSession = async (sessionId: string) => {
    const envPath = path.join(projectRoot, '.env.yylo');
    const existing = (await fs.pathExists(envPath)) ? await fs.readFile(envPath, 'utf-8') : '';
    const line = `${scope.sessionEnvKey}=${quoteEnvValue(sessionId, 'double')}`;
    const pattern = new RegExp(`^(?:export\\s+)?${scope.sessionEnvKey}=.*$`, 'm');
    const next = pattern.test(existing)
      ? existing.replace(pattern, line)
      : `${existing.replace(/\s*$/, '')}\n${line}\n`;
    env[scope.sessionEnvKey] = sessionId;
    await fs.writeFile(envPath, next.replace(/^\n/, ''), 'utf-8');
  };
  const assertEnvSession = async (sessionId: string) => {
    const state = await readBranchState();
    const storedScope = state.scopes[scope.scopeHash];
    expect(storedScope.branches[storedScope.active].session_id).toBe(sessionId);
  };
  const assertActiveBranch = async (branchName: string, sessionId?: string) => {
    const state = await readBranchState();
    expect(state.scopes[scope.scopeHash].active).toBe(branchName);
    if (sessionId !== undefined) {
      expect(state.scopes[scope.scopeHash].branches[branchName].session_id).toBe(sessionId);
    }
  };

  return {
    projectRoot,
    ownsProjectRoot,
    scopeName: options.scope,
    scope,
    env,
    async cleanup() {
      restoreProcessEnv();
      if (ownsProjectRoot) await fs.remove(projectRoot);
    },
    restoreProcessEnv,
    readEnvFile,
    readBranchState,
    writeEnvSession,
    assertEnvSession,
    assertActiveBranch,
    async assertScopeInvariant(expectedActiveBranch: string, expectedSessionId: string) {
      await assertEnvSession(expectedSessionId);
      await assertActiveBranch(expectedActiveBranch, expectedSessionId);
    },
  };
}
