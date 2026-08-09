import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../../..');

describe('Bolt task workspace managed runtime', () => {
  it('ships one small standalone engine with real-Git contract tests', () => {
    const runtime = resolve(repository, 'juno-code/src/templates/scripts/task_workspace.py');
    const tests = resolve(repository, 'juno-code/src/templates/scripts/tests/test_task_workspace.py');
    const source = readFileSync(runtime, 'utf8');
    expect(source).toContain('def start(');
    expect(source).toContain('def status(');
    expect(source).toContain('def finish(');
    expect(source).not.toContain('task_lifecycle');
    expect(source).not.toContain('integration_candidate');
    expect(source).not.toContain('managed_agent_runner');
    execFileSync('python3', [tests], {
      cwd: repository,
      env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/juno-task-workspace-test-pycache' },
      stdio: 'pipe',
    });
  }, 30_000);
});
