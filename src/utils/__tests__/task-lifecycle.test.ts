import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../../..');

describe('task lifecycle reviewer launch provenance', () => {
  it('keeps installed runtime/template and executable contract tests byte-identical', () => {
    const runtime = resolve(repository, '.juno_task/scripts/task_lifecycle.py');
    const template = resolve(repository, 'juno-code/src/templates/scripts/task_lifecycle.py');
    const runtimeTests = resolve(repository, '.juno_task/scripts/tests/test_task_lifecycle.py');
    const templateTests = resolve(repository, 'juno-code/src/templates/scripts/tests/test_task_lifecycle.py');
    expect(readFileSync(runtime)).toEqual(readFileSync(template));
    expect(readFileSync(runtimeTests)).toEqual(readFileSync(templateTests));
    execFileSync('python3', [runtimeTests, 'RealGitLifecycleTests.test_review_launch_sanitizes_env_uses_prompt_file_devnull_and_neutral_roots'], {
      cwd: repository,
      env: { ...process.env, PI_MODEL: 'outer-model', PI_PROVIDER: 'outer-provider', JUNO_MODEL: 'outer-juno-model' },
      stdio: 'pipe',
    });
  });
});
