import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../../..');

describe('Bolt task workspace managed runtime', () => {
  it('schedules only managed-install lock sharers on one exclusive focused lane', () => {
    for (const policyPath of [
      resolve(repository, '.juno_task/config/task-workspace.json'),
      resolve(repository, 'juno-code/src/templates/config/task-workspace.json'),
    ]) {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
        focused_validation: Array<{
          id: string;
          argv: string[];
          resource?: { id: string; lock_path: string; wait_timeout_seconds: number };
        }>;
      };
      expect(policy.focused_validation.map(({ id }) => id)).toEqual([
        'task-workspace', 'integration-workspace', 'script-installer',
      ]);
      const [task, integration, installer] = policy.focused_validation;
      expect(task?.resource).toEqual(installer?.resource);
      expect(task?.resource).toMatchObject({
        id: 'yylo-real-git-managed-install',
        lock_path: '/tmp/yylo-focused-real-git-managed-install.lock',
      });
      expect(task!.resource!.wait_timeout_seconds).toBe(1200);
      expect(integration?.resource).toBeUndefined();
      expect(task?.argv).toContain('src/utils/__tests__/task-workspace.test.ts');
      expect(installer?.argv).toContain('src/utils/__tests__/script-installer.test.ts');
      expect(integration?.argv).toContain('src/utils/__tests__/integration-workspace.test.ts');
    }
  });

  it('routes benchmark changes through test, typecheck, and build', () => {
    for (const policyPath of [
      resolve(repository, '.juno_task/config/task-workspace.json'),
      resolve(repository, 'juno-code/src/templates/config/task-workspace.json'),
    ]) {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
        validation_profiles: Array<{ id: string; path_roots: string[]; commands: Array<{ id: string }> }>;
      };
      const benchmark = policy.validation_profiles.find(({ id }) => id === 'benchmark-suite');
      expect(benchmark?.path_roots).toEqual(['juno-benchmark']);
      expect(benchmark?.commands.map(({ id }) => id)).toEqual([
        'benchmark-test', 'benchmark-typecheck', 'benchmark-build',
      ]);
    }
  });

  it('hydrates the private monorepo directory rather than a public brand path', () => {
    for (const workflowPath of [
      resolve(repository, '.juno_task/config/worktree-hydration.yaml'),
      resolve(repository, 'juno-code/src/templates/config/worktree-hydration.yaml'),
    ]) {
      const workflow = readFileSync(workflowPath, 'utf8');
      expect(workflow).toContain('"verify-node-lock", "--cwd", "juno-code"');
      expect(workflow).toContain('"hydrate-node", "--cwd", "juno-code"');
      expect(workflow).toContain('"verify-node-lock", "--cwd", "juno-benchmark"');
      expect(workflow).toContain('"hydrate-node", "--cwd", "juno-benchmark"');
      expect(workflow).not.toContain('"--prefix", "yylo"');
    }
  });

  it('admits exact runtime/template parity paths without opening the scripts root', () => {
    const policies = [
      resolve(repository, '.juno_task/config/task-workspace.json'),
      resolve(repository, 'juno-code/src/templates/config/task-workspace.json'),
    ];
    const runtimePaths = [
      '.juno_task/scripts/workflow_runner.sh',
      '.juno_task/scripts/parallel_runner.sh',
      '.juno_task/scripts/run_until_completion.sh',
      '.juno_task/scripts/risk_policy.py',
      '.juno_task/scripts/controller_registration.py',
      '.juno_task/scripts/metadata_controller.py',
      '.juno_task/scripts/tests/test_controller_registration.py',
      '.juno_task/scripts/tests/test_metadata_controller.py',
      '.juno_task/scripts/await_blocker.py',
      '.juno_task/scripts/install_requirements.sh',
      '.juno_task/scripts/invocation_correlation.py',
      '.juno_task/scripts/release_gate.py',
      '.juno_task/scripts/release_train.py',
      '.juno_task/scripts/target_runtime_provenance.py',
      '.juno_task/scripts/task_workflow_helper.py',
      '.juno_task/scripts/tests/test_release_train.py',
      '.juno_task/scripts/tests/test_risk_policy.py',
      '.juno_task/scripts/wiki_lint.py',
      '.juno_task/scripts/worktree_hydration.py',
      '.juno_task/managed-assets.json',
    ];
    for (const policyPath of policies) {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as { allowed_paths: string[] };
      expect(policy.allowed_paths).toEqual(expect.arrayContaining(runtimePaths));
      expect(policy.allowed_paths).not.toContain('.juno_task/scripts');
      expect(policy.allowed_paths).toContain('juno-code');
    }
  });

  it('declares unique generator and managed parity destinations without admitting their roots', () => {
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
    const canonicalRootDestinations = [
      '.agents/skills/ralph-loop/references/implement.md',
      '.claude/skills/ralph-loop/references/implement.md',
      '.pi/skills/ralph-loop/references/implement.md',
    ];
    const declaredDestinationOwners = [
      ...generated.destinations.map((destination) => ({
        source: generated.source,
        destination,
      })),
      ...managed.admissionOutputs.map(({ source, destination }) => ({
        source: `juno-code/src/templates/${source}`,
        destination,
      })),
    ];
    expect(new Set(declaredDestinationOwners.map(({ destination }) => destination)).size).toBe(
      declaredDestinationOwners.length,
    );
    for (const destination of canonicalRootDestinations) {
      expect(declaredDestinationOwners.filter((row) => row.destination === destination)).toEqual([
        { source: generated.source, destination },
      ]);
    }

    const skillFiles = [
      'kanban-workflow/SKILL.md',
      'plan-kanban-tasks/SKILL.md',
      'ralph-loop/SKILL.md',
      'ralph-loop/references/first_check.md',
      'understand-project/SKILL.md',
    ];
    const skillOutputs = [
      ...skillFiles.map((file) => ({
        source: `skills/codex/${file}`,
        destination: `.agents/skills/${file}`,
      })),
      {
        source: 'scripts/kanban.sh',
        destination: '.agents/skills/ralph-loop/scripts/kanban.sh',
      },
      ...skillFiles.map((file) => ({
        source: `skills/claude/${file}`,
        destination: `.claude/skills/${file}`,
      })),
      {
        source: 'scripts/kanban.sh',
        destination: '.claude/skills/ralph-loop/scripts/kanban.sh',
      },
      ...skillFiles.map((file) => ({
        source: `skills/pi/${file}`,
        destination: `.pi/skills/${file}`,
      })),
      {
        source: 'extensions/pi/juno-skill-preprocessor.ts',
        destination: '.pi/extensions/juno-skill-preprocessor.ts',
      },
    ];
    expect(managed.admissionOutputs).toEqual(
      expect.arrayContaining([
        {
          source: 'scripts/controller_workspace.py',
          destination: '.juno_task/scripts/controller_workspace.py',
        },
        {
          source: 'scripts/migration_inventory.py',
          destination: '.juno_task/scripts/migration_inventory.py',
        },
        {
          source: 'scripts/controller_checkpoint.py',
          destination: '.juno_task/scripts/controller_checkpoint.py',
        },
        ...skillOutputs,
      ]),
    );
    expect(managed.admissionOutputs).toHaveLength(3 + skillOutputs.length);
    expect(policy.allowed_paths).not.toEqual(
      expect.arrayContaining(['.agents', '.claude', '.pi', '.juno_task/scripts']),
    );
  });

  it('keeps guarded runtime-bootstrap admission representation-neutral', () => {
    const runtime = readFileSync(
      resolve(repository, 'juno-code/src/templates/scripts/task_workspace.py'), 'utf8',
    );
    const admission = runtime.slice(
      runtime.indexOf('def require_metadata_only_controller('),
      runtime.indexOf('\ndef _file_sha256('),
    );
    expect(admission).not.toContain('core.sparseCheckout');
    expect(admission).toContain('exact registered metadata-only controller');
    expect(admission).toContain(
      'required_checks = {"branch_exact", "tracked_boundary", "product_absent", "role"}',
    );
  });

  it('ships one small standalone engine with sparse, orphan, and negative real-Git contracts', () => {
    const runtime = resolve(repository, 'juno-code/src/templates/scripts/task_workspace.py');
    const tests = resolve(repository, 'juno-code/src/templates/scripts/tests/test_task_workspace.py');
    const source = readFileSync(runtime, 'utf8');
    const testSource = readFileSync(tests, 'utf8');
    expect(source).toContain('def start(');
    expect(source).toContain('def status(');
    expect(source).toContain('def finish(');
    expect(source).not.toContain('task_lifecycle');
    expect(source).not.toContain('integration_candidate');
    expect(source).toContain('def managed_task_run(');
    expect(source.match(/managed_agent_runner/g) ?? []).toHaveLength(1);
    expect(testSource).toContain('test_sparse_metadata_controller_runtime_bootstrap');
    expect(testSource).toContain('test_orphan_metadata_only_controller_runtime_bootstrap_without_sparse_checkout');
    expect(testSource).toContain('test_runtime_bootstrap_refuses_product_bearing_metadata_controller');
    execFileSync('python3', [tests], {
      cwd: repository,
      env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/juno-task-workspace-test-pycache' },
      stdio: 'pipe',
    });
  }, 120_000);
});
