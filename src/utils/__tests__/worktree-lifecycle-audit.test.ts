import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const helper = path.resolve(process.cwd(), 'src/templates/scripts/worktree_lifecycle.py');
const wiki = path.resolve(process.cwd(), 'src/templates/wiki/git_worktree_lifecycle.md');

describe('packaged worktree lifecycle', () => {
  it('ships one compilable create/verify/audit/cleanup authority', async () => {
    execFileSync('python3', ['-m', 'py_compile', helper]);
    const source = await fs.readFile(helper, 'utf8');
    for (const command of ['create', 'verify', 'audit', 'cleanup']) expect(source).toContain(`"${command}"`);
    expect(source).toContain('unreachable_from_target');
    expect(source).toContain('active_process');
    expect(source).toContain('worktree", "prune", "--dry-run"');
    expect(source).not.toContain('force');
  });

  it('documents backing tests and separate release authority', async () => {
    const guidance = await fs.readFile(wiki, 'utf8');
    expect(guidance).toContain('Real Git/worktree tests matter');
    expect(guidance).toContain('Package-install tests matter');
    expect(guidance).toContain('vX.Y.Z');
    expect(guidance).toContain('There is no automatic force mode');
    expect(guidance).not.toContain('worktree_lifecycle_audit.py');
  });
});
