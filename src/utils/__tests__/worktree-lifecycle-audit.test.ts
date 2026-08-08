import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const helper = path.resolve(process.cwd(), 'src/templates/scripts/worktree_lifecycle.py');
const wiki = path.resolve(process.cwd(), 'src/templates/wiki/git_worktree_lifecycle.md');

describe('packaged worktree lifecycle', () => {
  it('ships one compilable create/verify/audit/release-target/cleanup authority', async () => {
    execFileSync('python3', ['-m', 'py_compile', helper]);
    const source = await fs.readFile(helper, 'utf8');
    for (const command of ['create', 'verify', 'audit', 'release-target', 'cleanup']) expect(source).toContain(`"${command}"`);
    expect(source).toContain('unreachable_from_target');
    expect(source).toContain('active_process');
    expect(source).toContain('--deinitialized-submodule');
    expect(source).toContain('canonical_path_mismatch');
    expect(source).toContain('canonical_path_resolution_changed');
    expect(source).toContain('controller_nested_integration_owner');
    expect(source).toContain('embedded_submodule_primary');
    expect(source).toContain('update-ref", "--no-deref", "HEAD"');
    expect(source).toContain('preserved_unknown_non_blocking');
    expect(source).toContain('tracked_worktree_dirty');
    expect(source).toContain('index_dirty');
    expect(source).not.toContain('choices=("detach_same_sha", "remove")');
    expect(source).toContain('gitlink_unreachable_from_approved_repository');
    expect(source).toContain('worktree", "prune", "--dry-run"');
    expect(source).not.toContain('force');
  });

  it('documents one public lifecycle, backing tests, and separate release authority', async () => {
    const guidance = await fs.readFile(wiki, 'utf8');
    expect(guidance).toContain('yy lifecycle run --manifest');
    expect(guidance).toContain('Real Git/worktree tests matter');
    expect(guidance).toContain('Package-install tests matter');
    expect(guidance).toContain('Release, push, publication, deployment');
    expect(guidance).toContain('without force');
    expect(guidance).toContain('workflow_runner.sh doctor');
    expect(guidance).toContain('There is no adapter, schema translation, or dual integration runtime');
    expect(guidance).not.toContain('verify --manifest CREATE_RECEIPT --path DISPLAY_PATH');
    expect(guidance).not.toContain('--nested-owner-receipt');
    expect(guidance).not.toContain('worktree_lifecycle_audit.py');
  });
});
