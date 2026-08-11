import fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';

/** Every project-local root that `scripts update --force` may mutate. */
export const MANAGED_UPDATE_ROOTS = [
  '.juno_task/scripts',
  '.juno_task/prompts',
  '.juno_task/wiki',
  '.juno_task/config',
  '.juno_task/config.json',
  '.juno_task/managed-assets.json',
  '.juno_task/managed-conflicts',
  '.juno_task/managed-specializations',
  '.juno_task/.requirements-cache',
  '.venv_juno',
  'scripts/git-flow.sh',
  '.agents',
  '.claude',
  '.pi',
  'AGENTS.md',
  'CLAUDE.md',
] as const;

export async function assertSafeManagedWritePath(
  projectRoot: string,
  destination: string,
): Promise<void> {
  const root = path.resolve(projectRoot);
  const target = path.resolve(destination);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Managed asset path escapes project root: ${destination}`);
  }
  const relative = path.relative(root, target);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (await fs.pathExists(cursor) && (await fs.lstat(cursor)).isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link managed path component: ${path.relative(root, cursor)}`);
    }
  }
}

/**
 * Snapshot all update-owned roots and restore them if any later phase fails.
 * The snapshot lives outside the project, so rollback does not depend on a
 * partially replaced runtime. fs-extra preserves bytes, links, and modes.
 */
export async function withManagedUpdateRollback<T>(
  projectDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const projectRoot = path.resolve(projectDir);
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-managed-update-'));
  const present = new Set<string>();
  try {
    for (const relative of MANAGED_UPDATE_ROOTS) {
      const source = path.join(projectRoot, relative);
      if (!(await fs.pathExists(source))) continue;
      present.add(relative);
      const snapshot = path.join(snapshotRoot, relative);
      await fs.ensureDir(path.dirname(snapshot));
      await fs.copy(source, snapshot, {
        dereference: false,
        preserveTimestamps: true,
        errorOnExist: true,
      });
    }

    try {
      return await operation();
    } catch (error) {
      for (const relative of [...MANAGED_UPDATE_ROOTS].reverse()) {
        const destination = path.join(projectRoot, relative);
        await fs.remove(destination);
        if (!present.has(relative)) continue;
        const snapshot = path.join(snapshotRoot, relative);
        await fs.ensureDir(path.dirname(destination));
        await fs.copy(snapshot, destination, {
          dereference: false,
          preserveTimestamps: true,
          errorOnExist: true,
        });
      }
      throw error;
    }
  } finally {
    await fs.remove(snapshotRoot);
  }
}
