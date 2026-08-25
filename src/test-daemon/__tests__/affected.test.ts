/**
 * Affected-test selection tests (Wave 2 of PDR 7djT8N). Deterministic,
 * convention-based selection: changed tests select themselves; changed
 * sources select existing sibling/`__tests__` test files; foreign-project
 * changes select nothing.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateTestPaths, selectAffectedTests } from '../affected.js';

let worktree: string;
let projectRoot: string;

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).toString();
}

beforeAll(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'yylo-daemon-affected-'));
  git(worktree, ['init', '--initial-branch=main']);
  git(worktree, ['config', 'user.email', 'daemon@test']);
  git(worktree, ['config', 'user.name', 'Daemon Test']);
  projectRoot = path.join(worktree, 'juno-code');
  await fs.mkdir(path.join(projectRoot, 'src', 'utils', '__tests__'), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{}\n');
  await fs.writeFile(
    path.join(projectRoot, 'src', 'utils', 'logger.ts'),
    'export const x = 1;\n',
  );
  await fs.writeFile(
    path.join(projectRoot, 'src', 'utils', '__tests__', 'logger.test.ts'),
    'test();\n',
  );
  await fs.writeFile(
    path.join(projectRoot, 'src', 'utils', 'plain.test.ts'),
    'test();\n',
  );
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-m', 'init']);
});

afterAll(async () => {
  await fs.rm(worktree, { recursive: true, force: true });
});

describe('candidate test path convention', () => {
  it('maps sibling and __tests__ candidates', () => {
    expect(candidateTestPaths('src/utils/logger.ts')).toEqual([
      'src/utils/__tests__/logger.test.ts',
      'src/utils/logger.test.ts',
    ]);
  });

  it('also considers the directory test for index modules', () => {
    expect(candidateTestPaths('src/utils/index.ts')).toContain('src/utils.test.ts');
    expect(candidateTestPaths('src/utils/index.ts')).toContain(
      'src/__tests__/utils.test.ts',
    );
  });
});

describe('selectAffectedTests', () => {
  it('selects changed test files directly', async () => {
    await fs.writeFile(
      path.join(projectRoot, 'src', 'utils', 'plain.test.ts'),
      'test(); // edited\n',
    );
    const selection = await selectAffectedTests(projectRoot, worktree);
    expect(selection.selected_tests).toContain('src/utils/plain.test.ts');
    expect(selection.base).toBe('HEAD');
  });

  it('maps an edited source file to its __tests__ suite when it exists', async () => {
    await fs.writeFile(
      path.join(projectRoot, 'src', 'utils', 'logger.ts'),
      'export const x = 2;\n',
    );
    const selection = await selectAffectedTests(projectRoot, worktree);
    expect(selection.selected_tests).toContain('src/utils/__tests__/logger.test.ts');
  });

  it('ignores changes outside the project root', async () => {
    await fs.writeFile(path.join(worktree, 'other-project.txt'), 'x\n');
    const selection = await selectAffectedTests(projectRoot, worktree);
    expect(
      selection.changed_files.every((file) => file.startsWith('juno-code/')),
    ).toBe(true);
    await fs.rm(path.join(worktree, 'other-project.txt'));
  });

  it('reports an explicit note when nothing is affected', async () => {
    git(worktree, ['add', '.']);
    git(worktree, ['commit', '-m', 'clean']);
    const selection = await selectAffectedTests(projectRoot, worktree);
    expect(selection.selected_tests).toEqual([]);
    expect(selection.note).toContain('no affected tests');
  });
});
