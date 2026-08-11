import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../../..');

describe('Bolt task workspace managed runtime', () => {
  it('admits exact runtime/template parity paths without opening the scripts root', () => {
    const policies = [
      resolve(repository, '.juno_task/config/task-workspace.json'),
      resolve(repository, 'juno-code/src/templates/config/task-workspace.json'),
    ];
    const runtimePaths = [
      '.juno_task/scripts/workflow_runner.sh',
      '.juno_task/scripts/risk_policy.py',
      '.juno_task/scripts/controller_registration.py',
      '.juno_task/scripts/metadata_controller.py',
      '.juno_task/scripts/tests/test_controller_registration.py',
      '.juno_task/scripts/tests/test_metadata_controller.py',
    ];
    for (const policyPath of policies) {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as { allowed_paths: string[] };
      expect(policy.allowed_paths).toEqual(expect.arrayContaining(runtimePaths));
      expect(policy.allowed_paths).not.toContain('.juno_task/scripts');
      expect(policy.allowed_paths).toContain('juno-code');
    }
  });

  it('declares exact generator and managed parity outputs without admitting their roots', () => {
    const policy = JSON.parse(
      readFileSync(resolve(repository, 'juno-code/src/templates/config/task-workspace.json'), 'utf8'),
    ) as { allowed_paths: string[] };
    const generated = JSON.parse(
      readFileSync(resolve(repository, 'juno-code/scripts/implementation-contract.json'), 'utf8'),
    ) as { source: string; destinations: string[] };
    const managed = JSON.parse(
      readFileSync(resolve(repository, 'juno-code/src/templates/managed-assets.json'), 'utf8'),
    ) as { admissionOutputs: Array<{ source: string; destination: string }> };

    expect(generated.source).toContain('/canonical/');
    expect(generated.destinations).toEqual(
      expect.arrayContaining([
        '.agents/skills/ralph-loop/references/implement.md',
        '.claude/skills/ralph-loop/references/implement.md',
        '.pi/skills/ralph-loop/references/implement.md',
      ]),
    );
    expect(managed.admissionOutputs).toContainEqual({
      source: 'scripts/controller_workspace.py',
      destination: '.juno_task/scripts/controller_workspace.py',
    });
    expect(policy.allowed_paths).not.toEqual(
      expect.arrayContaining(['.agents', '.claude', '.pi', '.juno_task/scripts']),
    );
  });

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
