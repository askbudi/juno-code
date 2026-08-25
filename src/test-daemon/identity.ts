/**
 * Daemon identity computation for the YYLO advisory test daemon (Wave 2 of
 * PDR 7djT8N).
 *
 * One daemon identity binds: repository root, physical worktree, project
 * root, dependency-lock digest, runtime-generation digest (Vitest version +
 * configuration/global-setup bytes), and the Node toolchain. Any drift
 * materializes a different identity — and therefore a different daemon —
 * rather than reusing warm state across incompatible generations.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  digestCanonical,
  ENVIRONMENT_BINDING_KEYS,
  type DaemonIdentity,
  type DaemonRuntimeGenerationIdentity,
  type DaemonToolchainIdentity,
  type TreeSnapshot,
} from './protocol.js';

const execFileAsync = promisify(execFile);

/** Files whose bytes define the warm runtime generation. */
export const RUNTIME_GENERATION_INPUTS = [
  'package.json',
  'vitest.config.ts',
  'vitest.fast.config.ts',
  'src/test-utils/global-setup.ts',
  'src/test-utils/setup.ts',
  'src/test-utils/fixture-base-cache.ts',
  'src/test-utils/resource-lock.ts',
] as const;

export const DEPENDENCY_LOCK_RELATIVE_PATH = 'package-lock.json';

export class DaemonIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonIdentityError';
  }
}

export async function gitText(
  root: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', root, ...args],
    {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    },
  );
  return stdout;
}

export interface RepositoryTopology {
  readonly worktree: string;
  readonly repositoryRoot: string;
}

export async function resolveRepositoryTopology(
  projectRoot: string,
): Promise<RepositoryTopology> {
  const realRoot = await fs.realpath(projectRoot);
  try {
    const worktree = (await gitText(realRoot, ['rev-parse', '--show-toplevel'])).trim();
    const repositoryRoot = (
      await gitText(realRoot, ['rev-parse', '--git-common-dir'])
    ).trim();
    if (!worktree || !repositoryRoot) {
      throw new DaemonIdentityError(`not a Git checkout: ${realRoot}`);
    }
    return {
      worktree: await fs.realpath(worktree),
      repositoryRoot: path.resolve(worktree, repositoryRoot),
    };
  } catch (error) {
    if (error instanceof DaemonIdentityError) throw error;
    throw new DaemonIdentityError(
      `cannot resolve Git topology for ${realRoot}: ${(error as Error).message}`,
    );
  }
}

export function toolchainIdentity(
  versions: NodeJS.ProcessVersions = process.versions,
  platform: string = process.platform,
  arch: string = process.arch,
): DaemonToolchainIdentity {
  return {
    node: versions.node,
    platform,
    arch,
  };
}

export async function dependencyLockDigest(
  projectRoot: string,
): Promise<{ path: string; sha256: string }> {
  const lockPath = path.join(projectRoot, DEPENDENCY_LOCK_RELATIVE_PATH);
  try {
    const bytes = await fs.readFile(lockPath);
    return {
      path: DEPENDENCY_LOCK_RELATIVE_PATH,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw new DaemonIdentityError(
      `missing dependency lock ${lockPath}; the daemon requires an exact-lock project`,
    );
  }
}

export async function runtimeGenerationDigest(
  projectRoot: string,
  vitestVersion: string,
): Promise<DaemonRuntimeGenerationIdentity> {
  const parts: string[] = [`vitest@${vitestVersion}`];
  const inputs: string[] = [`vitest.version=${vitestVersion}`];
  for (const relative of RUNTIME_GENERATION_INPUTS) {
    const absolute = path.join(projectRoot, relative);
    try {
      const bytes = await fs.readFile(absolute);
      parts.push(
        `${relative}=${createHash('sha256').update(bytes).digest('hex')}`,
      );
      inputs.push(relative);
    } catch {
      // Missing optional inputs (for example vitest.fast.config.ts in a
      // consumer project) are recorded as absent rather than fatal.
      parts.push(`${relative}=<absent>`);
    }
  }
  const sha256 = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
  return { sha256, inputs };
}

export function daemonIdentityFromParts(
  protocolVersion: string,
  topology: RepositoryTopology,
  projectRoot: string,
  dependencyLock: { path: string; sha256: string },
  runtimeGeneration: DaemonRuntimeGenerationIdentity,
  toolchain: DaemonToolchainIdentity,
): DaemonIdentity {
  const material = {
    protocol_version: protocolVersion,
    repository_root: topology.repositoryRoot,
    worktree: topology.worktree,
    project_root: projectRoot,
    dependency_lock: dependencyLock,
    runtime_generation: { sha256: runtimeGeneration.sha256 },
    toolchain,
  };
  return {
    ...material,
    dependency_lock: dependencyLock,
    runtime_generation: runtimeGeneration,
    identity_sha256: digestCanonical(material),
  };
}

/**
 * HEAD plus a digest over the full working-tree state (tracked changes and
 * untracked files). The advisory edit loop edits are uncommitted, so HEAD
 * alone is not a sufficient tree identity.
 */
export async function treeSnapshot(worktree: string): Promise<TreeSnapshot> {
  const [head, porcelain] = await Promise.all([
    gitText(worktree, ['rev-parse', 'HEAD']),
    gitText(worktree, ['status', '--porcelain', '--untracked-files=all'], {
      timeoutMs: 30_000,
    }),
  ]);
  const headSha = head.trim();
  const digest = createHash('sha256')
    .update(`head=${headSha}\n`)
    .update(porcelain)
    .digest('hex');
  return { head: headSha, digest };
}

/**
 * Digest over the exact per-request input closure: selected test files plus
 * the runtime-generation inputs. Both client and daemon compute it
 * independently; disagreement means the closure changed in flight.
 */
export async function inputClosureDigest(
  projectRoot: string,
  selectedTests: readonly string[],
  runtimeGeneration: DaemonRuntimeGenerationIdentity,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`runtime=${runtimeGeneration.sha256}\n`);
  const sorted = [...selectedTests].sort();
  for (const relative of sorted) {
    const absolute = path.resolve(projectRoot, relative);
    if (!absolute.startsWith(projectRoot + path.sep) && absolute !== projectRoot) {
      throw new DaemonIdentityError(
        `selected test ${JSON.stringify(relative)} escapes the project root`,
      );
    }
    try {
      const bytes = await fs.readFile(absolute);
      hash.update(`${relative}=${createHash('sha256').update(bytes).digest('hex')}\n`);
    } catch {
      hash.update(`${relative}=<absent>\n`);
    }
  }
  return hash.digest('hex');
}

export function currentEnvironmentBinding(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string | null> {
  const binding: Record<string, string | null> = {};
  for (const key of ENVIRONMENT_BINDING_KEYS) {
    const value = environment[key];
    binding[key] = value === undefined || value === '' ? null : value;
  }
  // Vitest pins NODE_ENV='test' when unset (both cold CLI children and the
  // daemon pre-init pin); the binding must normalize identically on both
  // sides or every request would mismatch a freshly started daemon.
  if (binding.NODE_ENV === null) binding.NODE_ENV = 'test';
  return binding;
}
