import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../../..');

describe('task lifecycle managed-agent launch provenance', () => {
  it('keeps installed runtime/template and executable worker/reviewer contracts byte-identical', () => {
    const runtime = resolve(repository, '.juno_task/scripts/task_lifecycle.py');
    const template = resolve(repository, 'juno-code/src/templates/scripts/task_lifecycle.py');
    const runtimeTests = resolve(repository, '.juno_task/scripts/tests/test_task_lifecycle.py');
    const templateTests = resolve(repository, 'juno-code/src/templates/scripts/tests/test_task_lifecycle.py');
    const runner = resolve(repository, '.juno_task/scripts/managed_agent_runner.py');
    const runnerTemplate = resolve(repository, 'juno-code/src/templates/scripts/managed_agent_runner.py');
    expect(readFileSync(runtime)).toEqual(readFileSync(template));
    expect(readFileSync(runtimeTests)).toEqual(readFileSync(templateTests));
    expect(readFileSync(runner)).toEqual(readFileSync(runnerTemplate));
    const lifecycleSource = readFileSync(runtime, 'utf8');
    expect(lifecycleSource).toContain('invoke_managed_agent_runner');
    expect(lifecycleSource).not.toContain('["yy", "pi"');
    expect(lifecycleSource).not.toContain('subprocess.Popen');
    execFileSync('python3', [runtimeTests,
      'RealGitLifecycleTests.test_worker_launch_provenance_sanitation_prompt_file_roots_capture_and_audit',
      'RealGitLifecycleTests.test_worker_allowed_commit_and_repair_share_canonical_launcher_and_evidence',
      'RealGitLifecycleTests.test_review_launch_sanitizes_env_uses_prompt_file_devnull_and_neutral_roots'], {
      cwd: repository,
      env: { ...process.env, PI_MODEL: 'outer-model', PI_PROVIDER: 'outer-provider', JUNO_MODEL: 'outer-juno-model' },
      stdio: 'pipe',
    });
  });
});
