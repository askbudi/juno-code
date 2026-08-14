import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const helper = path.resolve(process.cwd(), 'src/templates/scripts/worktree_hydration.py');

describe('worktree hydration helper', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-worktree-hydration-'));
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    await fs.writeFile(path.join(root, '.gitignore'), '.env\n');
    spawnSync('git', ['-C', root, 'add', '.gitignore'], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { encoding: 'utf8' });
  });

  afterEach(async () => fs.remove(root));

  it('copies only an explicit absolute env source without echo and enforces mode 0600', async () => {
    const source = path.join(root, '..', `${path.basename(root)}.approved-env`);
    await fs.writeFile(source, 'SECRET_MARKER=do-not-print\n');
    const result = spawnSync('python3', [helper, '--project-root', root, 'copy-env', '--source', source, '--destination', '.env'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('SECRET_MARKER');
    expect((await fs.stat(path.join(root, '.env'))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(root, '.env'), 'utf8')).toBe('SECRET_MARKER=do-not-print\n');
    await fs.remove(source);
  });

  it('rejects tracked hydration drift', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), '.env\nchanged\n');
    const result = spawnSync('python3', [helper, '--project-root', root, 'verify-clean'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('tracked or unignored worktree drift');
  });
});
