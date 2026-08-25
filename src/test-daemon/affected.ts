/**
 * Affected-test selection for the advisory edit loop (Wave 2 of PDR
 * 7djT8N).
 *
 * Deterministic and cheap: changed files (working tree vs HEAD by default,
 * or vs an explicit base ref) map to test files by repository convention —
 * a changed test file selects itself; a changed source file selects its
 * sibling `<name>.test.ts` and the matching `__tests__/<name>.test.ts` when
 * they exist. Import-graph tracing is deliberately out of scope for the
 * advisory loop and stays on the cold authoritative path.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { gitText } from './identity.js';

export const TEST_FILE_PATTERN = /\.(test|spec)\.(js|ts|tsx|mjs|cjs)$/;

export interface AffectedSelection {
  selected_tests: readonly string[];
  changed_files: readonly string[];
  base: string;
  note?: string;
}

export async function listChangedFiles(
  worktree: string,
  base: string,
): Promise<readonly string[]> {
  const porcelain = await gitText(worktree, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (base !== 'HEAD') {
    const diff = await gitText(worktree, ['diff', '--name-only', base, '--']);
    const merged = new Set<string>();
    for (const line of porcelain.split('\n')) {
      const entry = parsePorcelainLine(line);
      if (entry) merged.add(entry);
    }
    for (const line of diff.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) merged.add(trimmed);
    }
    return [...merged].sort();
  }
  const changed: string[] = [];
  for (const line of porcelain.split('\n')) {
    const entry = parsePorcelainLine(line);
    if (entry) changed.push(entry);
  }
  return changed.sort();
}

function parsePorcelainLine(line: string): string | null {
  if (!line.trim()) return null;
  // XY <path> — paths with special bytes are quoted; keep the raw remainder.
  const raw = line.slice(3).trim();
  if (!raw) return null;
  return unquoteGitPath(raw);
}

function unquoteGitPath(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * Map changed files to candidate test files relative to `projectRoot`.
 * Files outside the project root are ignored (a monorepo worktree may see
 * sibling-project changes that cannot affect this project's advisory loop).
 */
export async function selectAffectedTests(
  projectRoot: string,
  worktree: string,
  base: string = 'HEAD',
): Promise<AffectedSelection> {
  const changed = await listChangedFiles(worktree, base);
  const rootPrefix = projectRoot.endsWith(path.sep)
    ? projectRoot
    : projectRoot + path.sep;
  const inProject = changed.filter((file) => {
    const absolute = path.resolve(worktree, file);
    return absolute === projectRoot || absolute.startsWith(rootPrefix);
  });
  const selected = new Set<string>();
  for (const file of inProject) {
    const relative = path.relative(projectRoot, path.resolve(worktree, file));
    const normalized = relative.split(path.sep).join('/');
    if (TEST_FILE_PATTERN.test(normalized)) {
      selected.add(normalized);
      continue;
    }
    for (const candidate of candidateTestPaths(normalized)) {
      const absolute = path.join(projectRoot, candidate);
      if (await fs.access(absolute).then(() => true).catch(() => false)) {
        selected.add(candidate);
      }
    }
  }
  const selectedTests = [...selected].sort();
  const selection: AffectedSelection = {
    selected_tests: selectedTests,
    changed_files: inProject,
    base,
  };
  if (selectedTests.length === 0) {
    selection.note = 'no affected tests matched the deterministic selection rules';
  }
  return selection;
}

/** Repository convention candidates for a changed non-test source file. */
export function candidateTestPaths(relativeSource: string): readonly string[] {
  const withoutExtension = relativeSource.replace(/\.[^./]+$/, '');
  const directory = path.posix.dirname(withoutExtension);
  const basename = path.posix.basename(withoutExtension);
  const parent = path.posix.dirname(directory);
  const extension = '.test.ts';
  const candidates = new Set<string>();
  candidates.add(`${directory}/${basename}${extension}`);
  candidates.add(`${directory}/__tests__/${basename}${extension}`);
  if (basename === 'index') {
    // An index module is also exercised by its directory's test file.
    candidates.add(`${parent}/${path.posix.basename(directory)}${extension}`);
    candidates.add(
      `${parent}/__tests__/${path.posix.basename(directory)}${extension}`,
    );
  }
  return [...candidates]
    .filter((candidate) => !candidate.startsWith('..'))
    .sort();
}
