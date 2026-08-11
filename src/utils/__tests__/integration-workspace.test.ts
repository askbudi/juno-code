import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../../..');

describe('integration workspace managed runtime', () => {
  it('ships one guarded engine with real-Git registration, sync, receipt, and submodule tests', () => {
    const runtime = resolve(repository, 'juno-code/src/templates/scripts/integration_workspace.py');
    const tests = resolve(
      repository,
      'juno-code/src/templates/scripts/tests/test_integration_workspace.py',
    );
    const source = readFileSync(runtime, 'utf8');
    expect(source).toContain('def status_payload(');
    expect(source).toContain('def sync(');
    expect(source).toContain('def register(');
    expect(source).toContain('def managed_policy_projection(');
    expect(source).toContain('def managed_runtime_refresh(');
    expect(source).toContain('def managed_runtime_inspect(');
    expect(source).toContain('Path("/tmp")');
    expect(source).not.toContain('import git_flow');
    execFileSync('python3', [tests], {
      cwd: repository,
      env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/juno-integration-workspace-test-pycache' },
      stdio: 'pipe',
    });
  }, 30_000);
});
