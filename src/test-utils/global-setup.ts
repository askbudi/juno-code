import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertGitMutationSnapshotsUnchanged,
  captureGitMutationSnapshot,
  type GitMutationSnapshot,
} from './git-mutation-sentinel.js';

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

function protectedRoots(): Array<{ identity: string; root: string }> {
  const productRoot = gitValue(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!productRoot) throw new Error(`Juno test mutation sentinel: ${process.cwd()} is not inside a Git checkout`);

  const roots = new Map<string, { identity: string; root: string }>();
  const add = (identity: string, root: string | undefined) => {
    if (!root) return;
    const resolved = fs.realpathSync(path.resolve(root));
    const existing = roots.get(resolved);
    if (existing) existing.identity = `${existing.identity}+${identity}`;
    else roots.set(resolved, { identity, root: resolved });
  };

  add('product/candidate', productRoot);
  add('controller(environment)', process.env.JUNO_TASK_ROOT?.trim());
  add('controller(registration)', gitValue(productRoot, ['config', '--local', '--get', 'juno.controller.path']));

  const extra = process.env.JUNO_CODE_TEST_PROTECTED_GIT_ROOTS?.trim();
  if (extra) {
    for (const [index, root] of extra.split(path.delimiter).filter(Boolean).entries()) {
      add(`protected[${index}]`, root);
    }
  }
  return [...roots.values()];
}

export default function setup() {
  const roots = protectedRoots();
  const before = roots.map(({ identity, root }) => captureGitMutationSnapshot(identity, root));

  // Default test processes receive only suite-owned controller/metadata state.
  // Git-aware runner tests construct narrower per-test controllers as well, so
  // finalization and checkpoint paths cannot fall back to an external checkout.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-code-suite-'));
  const fixtureController = path.join(fixtureRoot, 'controller');
  const fixtureScripts = path.join(fixtureController, '.juno_task', 'scripts');
  const fixtureBin = path.join(fixtureController, '.venv_juno', 'bin');
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixtureBin, { recursive: true });
  execFileSync('git', ['init', '-b', 'fixture-controller', fixtureController], { stdio: 'ignore' });
  const python = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
  fs.symlinkSync(python, path.join(fixtureBin, 'python'));

  process.env.JUNO_CODE_TEST_FIXTURE_ROOT = fixtureRoot;
  process.env.JUNO_TASK_ROOT = fixtureController;
  process.env.JUNO_WORKSPACE_ROLE = 'controller';
  process.env.JUNO_WORKSPACE_ENFORCEMENT = 'strict';
  process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = path.join(fixtureRoot, 'metadata');
  process.env.JUNO_CODE_PROJECT_BOOTSTRAP_WRITES = '1';
  process.env.GIT_OPTIONAL_LOCKS = '0';

  return () => {
    let assertionError: unknown;
    try {
      const after: GitMutationSnapshot[] = roots.map(({ identity, root }) =>
        captureGitMutationSnapshot(identity, root));
      assertGitMutationSnapshotsUnchanged(before, after);
    } catch (error) {
      assertionError = error;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    if (assertionError) throw assertionError;
  };
}
