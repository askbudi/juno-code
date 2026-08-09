import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = resolve(process.cwd(), 'src/templates/scripts/git_flow.py');

describe('legacy Git-flow hard cut', () => {
  it('retains status/sync/push but contains no controller reconciliation executor', () => {
    const source = readFileSync(helper, 'utf8');
    expect(source).toContain('def status_payload(');
    expect(source).toContain('def sync(');
    expect(source).toContain('def push(');
    expect(source).not.toContain('def controller_sync(');
    expect(source).not.toContain('auto_after_integration');
    expect(source).not.toContain('integration_owner_preflight');
    expect(source).not.toContain('worktree_lifecycle');
  });

  it('refuses the removed command before resolving or mutating a repository', () => {
    const result = spawnSync('python3', [helper, 'controller-sync'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/juno-git-flow-hard-cut-pycache' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('removed');
    expect(result.stderr).toContain('yy task');
    expect(result.stderr).toContain('yy merge');
  });
});
