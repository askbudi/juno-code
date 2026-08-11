import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../../..');

describe('Bolt merge queue managed runtime', () => {
  it('ships one deterministic engine with real-Git conflict canaries', () => {
    const runtime = resolve(repository, 'juno-code/src/templates/scripts/merge_queue.py');
    const tests = resolve(repository, 'juno-code/src/templates/scripts/tests/test_merge_queue.py');
    const source = readFileSync(runtime, 'utf8');
    expect(source).toContain('LOCK_EX | fcntl.LOCK_NB');
    expect(source).toContain('"update-ref", target_ref');
    expect(source).toContain('def merge_resolve(');
    expect(source).not.toContain('integration_candidate');
    expect(source).not.toContain('controller-sync');
    expect(source).not.toContain('managed_agent_runner');
    execFileSync('python3', [tests], {
      cwd: repository,
      env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/juno-merge-queue-test-pycache' },
      stdio: 'pipe',
    });
  }, 300_000);
});
