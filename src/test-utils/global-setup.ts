import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertGitMutationSnapshotsUnchanged,
  captureGitMutationSnapshot,
  type GitMutationSnapshot,
} from './git-mutation-sentinel.js';
import {
  createColdFixture,
  createFixtureOverlay,
  ensureFixtureBase,
  fixtureBaseKey,
  fixtureIdentityForRepository,
  FIXTURE_BASE_DISABLE_ENV,
  type FixtureOverlay,
} from './fixture-base-cache.js';

/** Optional phase report consumed by scripts/test-performance/benchmark-profile.mjs. */
function reportPhases(phases: Record<string, number | string | null>): void {
  const target = process.env.YYLO_TEST_GLOBAL_SETUP_PHASE_REPORT?.trim();
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify({ schema_version: 'juno.test.global_setup.phases.v1', ...phases }, null, 2)}\n`,
    );
  } catch {
    // Phase reporting is diagnostic only; never fail setup on it.
  }
}

function gitValue(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function protectedRoots(
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Array<{ identity: string; root: string }> {
  const productRoot = gitValue(cwd, ['rev-parse', '--show-toplevel']);
  if (!productRoot) throw new Error(`Juno test mutation sentinel: ${cwd} is not inside a Git checkout`);

  const roots = new Map<string, { identity: string; root: string }>();
  const add = (identity: string, root: string | undefined) => {
    if (!root) return;
    const resolved = fs.realpathSync(path.resolve(root));
    const existing = roots.get(resolved);
    if (existing) existing.identity = `${existing.identity}+${identity}`;
    else roots.set(resolved, { identity, root: resolved });
  };

  add('product/candidate', productRoot);
  // The registered controller is shared, live state: users and other yy
  // sessions may legitimately checkpoint tasks or feedback while this suite
  // runs. Test processes are rebound below to a suite-owned fixture controller,
  // so implicitly freezing the shared controller creates a race without adding
  // isolation. Callers that own an otherwise external root can still opt it in
  // explicitly through YYLO_TEST_PROTECTED_GIT_ROOTS.
  const extra = environment.YYLO_TEST_PROTECTED_GIT_ROOTS?.trim();
  if (extra) {
    for (const [index, root] of extra.split(path.delimiter).filter(Boolean).entries()) {
      add(`protected[${index}]`, root);
    }
  }
  return [...roots.values()];
}

export default function setup() {
  const phases: Record<string, number | null> = {};

  const roots = protectedRoots();
  const before = roots.map(({ identity, root }) => captureGitMutationSnapshot(identity, root));

  // Wave 1 (7djT8N): the suite-owned fixture controller is materialized once
  // per identity into a sealed content-addressed base; every run copies a
  // disposable overlay. Cold fallback preserves the pre-cache construction
  // when the cache is disabled or its root is unusable.
  let fixture: FixtureOverlay;
  let baseKey: string | null = null;
  const fixtureStarted = process.hrtime.bigint();
  const cacheDisabled = process.env[FIXTURE_BASE_DISABLE_ENV] === '1';
  if (cacheDisabled) {
    fixture = createColdFixture();
  } else {
    try {
      const identity = fixtureIdentityForRepository(path.resolve(import.meta.dirname, '../../..'));
      const key = fixtureBaseKey(identity);
      const base = ensureFixtureBase(key, identity);
      baseKey = base.key;
      const overlayStarted = process.hrtime.bigint();
      fixture = createFixtureOverlay(base);
      phases.overlay_ms = Number(process.hrtime.bigint() - overlayStarted) / 1e6;
    } catch {
      fixture = createColdFixture();
    }
  }
  phases.total_setup_ms = Number(process.hrtime.bigint() - fixtureStarted) / 1e6;
  phases.cold = fixture.cold ? 1 : 0;
  reportPhases({ base_key: baseKey, ...phases });

  const fixtureRoot = fixture.root;
  const fixtureController = fixture.controllerPath;
  process.env.YYLO_TEST_FIXTURE_ROOT = fixtureRoot;
  process.env.JUNO_TASK_ROOT = fixtureController;
  process.env.JUNO_WORKSPACE_ROLE = 'controller';
  process.env.JUNO_WORKSPACE_ENFORCEMENT = 'strict';
  process.env.YYLO_SESSION_METADATA_DIRECTORY = path.join(fixtureRoot, 'metadata');
  process.env.YYLO_PROJECT_BOOTSTRAP_WRITES = '1';
  process.env.GIT_OPTIONAL_LOCKS = '0';

  return () => {
    const teardownStarted = process.hrtime.bigint();
    let assertionError: unknown;
    try {
      const after: GitMutationSnapshot[] = roots.map(({ identity, root }) =>
        captureGitMutationSnapshot(identity, root));
      assertGitMutationSnapshotsUnchanged(before, after);
    } catch (error) {
      assertionError = error;
    }
    try {
      fixture.release();
    } catch {
      // Overlay cleanup is best effort; the mutation-sentinel assertion below
      // remains the authoritative teardown gate.
    }
    const teardownMs = Number(process.hrtime.bigint() - teardownStarted) / 1e6;
    reportPhases({ base_key: baseKey, ...phases, total_teardown_ms: teardownMs });
    if (assertionError) throw assertionError;
  };
}
