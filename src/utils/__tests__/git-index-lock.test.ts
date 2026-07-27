import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = path.resolve(process.cwd(), 'src/templates/scripts/git_index_lock.py');

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('git_index_lock.py managed template', () => {
  let testDir: string;
  let repo: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-index-lock-'));
    repo = path.join(testDir, 'repo');
    git(testDir, 'init', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'config', 'user.name', 'Fixture');
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'initial\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-m', 'initial');
  });

  afterEach(async () => fs.remove(testDir));

  it('reports a clear checkout without mutation', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const result = spawnSync('python3', [helper, '--repository', repo], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.lock_present).toBe(false);
    expect(receipt.safe_next_action).toBe('proceed');
    expect(receipt.mutation_performed).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('preserves an ownerless lock and emits forensic evidence', async () => {
    const lock = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
    const payload = 'forensic-index-lock\n';
    await fs.writeFile(lock, payload);
    const receiptPath = path.join(testDir, 'receipt.json');
    const result = spawnSync('python3', [helper, '--repository', repo, '--output', receiptPath], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    const receipt = await fs.readJson(receiptPath);
    expect(receipt.lock_present).toBe(true);
    expect(receipt.safe_next_action).toBe('preserve_and_coordinate');
    expect(receipt.lock.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(lock, 'utf8')).toBe(payload);
  });

  it('quarantines only a high-confidence stale empty lock when recovery is requested', async () => {
    const lock = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
    await fs.writeFile(lock, '');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(lock, old, old);
    const result = spawnSync(
      'python3',
      [
        helper,
        '--repository',
        repo,
        '--recover-high-confidence-stale',
        '--stability-seconds',
        '0',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.lock_present).toBe(false);
    expect(receipt.mutation_performed).toBe(true);
    expect(receipt.stale_recovery.outcome).toBe('quarantined');
    expect(await fs.pathExists(lock)).toBe(false);
    expect(await fs.pathExists(receipt.stale_recovery.quarantine_path)).toBe(true);
  });

  it('preserves a young empty lock when recovery is requested', async () => {
    const lock = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
    await fs.writeFile(lock, '');
    const result = spawnSync(
      'python3',
      [
        helper,
        '--repository',
        repo,
        '--recover-high-confidence-stale',
        '--stability-seconds',
        '0',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.lock_present).toBe(true);
    expect(receipt.mutation_performed).toBe(false);
    expect(receipt.stale_recovery.rejection_reasons).toContain('lock_too_new');
    expect(await fs.pathExists(lock)).toBe(true);
  });

  it('resolves the checkout-specific lock for a linked worktree', async () => {
    const linked = path.join(testDir, 'linked');
    git(repo, 'worktree', 'add', '-b', 'linked', linked);
    const lock = git(linked, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
    await fs.writeFile(lock, 'linked-lock\n');
    const result = spawnSync('python3', [helper, '--repository', linked], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).lock_path).toBe(path.resolve(lock));
    expect(await fs.readFile(lock, 'utf8')).toBe('linked-lock\n');
  });
});
