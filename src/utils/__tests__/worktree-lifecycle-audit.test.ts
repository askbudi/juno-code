import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const helper = path.resolve(process.cwd(), 'src/templates/scripts/worktree_lifecycle_audit.py');
const wiki = path.resolve(process.cwd(), 'src/templates/wiki/git_worktree_lifecycle.md');

describe('packaged worktree lifecycle audit', () => {
  let repository: string;

  beforeEach(async () => {
    repository = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-worktree-audit-'));
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'Juno Test']);
    await fs.writeFile(path.join(repository, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', repository, 'add', 'README.md']);
    execFileSync('git', ['-C', repository, 'commit', '-qm', 'fixture']);
  });

  afterEach(async () => fs.remove(repository));

  it('ships a compilable read-only helper that inventories a clean repository', async () => {
    execFileSync('python3', ['-m', 'py_compile', helper]);
    const output = execFileSync('python3', [helper, '--root', repository, '--json'], {
      encoding: 'utf8',
    });
    const report = JSON.parse(output);
    expect(report.status).toBe('ok');
    expect(report.repositories[0].worktrees).toHaveLength(1);
    expect(JSON.stringify(report)).toContain(repository);
    expect(await fs.readFile(helper, 'utf8')).toContain('Read-only');
  });

  it('blocks automatic cleanup when deinitialized nested Git metadata remains', async () => {
    const gitDirRaw = execFileSync('git', ['-C', repository, 'rev-parse', '--git-dir'], {
      encoding: 'utf8',
    }).trim();
    const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(repository, gitDirRaw);
    await fs.ensureDir(path.join(gitDir, 'modules', 'deinitialized-child'));

    const report = JSON.parse(
      execFileSync('python3', [helper, '--root', repository, '--json'], { encoding: 'utf8' }),
    );
    const worktree = report.repositories[0].worktrees[0];
    expect(worktree.initialized_nested_paths).toContain('git-metadata:deinitialized-child');
    expect(worktree.disposition).toBe('clean_integrated_nested');
    expect(worktree.cleanup_candidate).toBe(false);
  });

  it('keeps installed guidance aligned with the two shipped helper capabilities', async () => {
    const guidance = await fs.readFile(wiki, 'utf8');
    expect(guidance).toContain(
      'worktree_lifecycle_audit.py` owns read-only cleanup classification',
    );
    expect(guidance).toContain(
      'integration_owner_preflight.py` owns target-ref integration leases',
    );
    expect(guidance).not.toContain('--mode cleanup');
    expect(guidance).not.toContain('.juno_task/scripts/tests/');
    expect(guidance).toContain('default diagnostic mode and `controller_checkpoint.py plan` are read-only');
    expect(guidance).toContain('at least 300 seconds old');
    expect(guidance).toContain('stable across two observations plus a final owner/identity check');
    expect(guidance).toContain('it never deletes the lock');
    expect(guidance).toContain('holds the exclusive `juno-repository-writer.lock` lease');
    expect(guidance).toContain('must not be run without equivalent repository-writer coordination');
  });
});
