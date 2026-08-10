import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectWorkspaceTopology, workspaceLocation } from '../workspace-topology.js';

const fixtures: string[] = [];
function run(cwd: string, ...args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function git(cwd: string, ...args: string[]): string {
  return run(cwd, 'git', ...args);
}

function cli(args: string[], cwd: string) {
  return spawnSync(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('src/bin/cli.ts'), ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        JUNO_TASK_ROOT: '',
        JUNO_CONTROLLER_BRANCH: '',
        JUNO_WORKSPACE_ROLE: '',
        JUNO_WORKSPACE_ENFORCEMENT: '',
      },
    },
  );
}

function fixture(): { primary: string; controller: string; integration: string; task: string } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'juno-topology-')));
  fixtures.push(base);
  const primary = path.join(base, 'primary');
  mkdirSync(primary);
  git(primary, 'init', '-q');
  git(primary, 'config', 'user.email', 'test@example.com');
  git(primary, 'config', 'user.name', 'Test');
  writeFileSync(path.join(primary, 'README.md'), 'fixture\n');
  git(primary, 'add', 'README.md');
  git(primary, 'commit', '-qm', 'initial');
  git(primary, 'branch', 'target');
  git(primary, 'branch', 'controller');
  const controller = path.join(base, 'controller');
  const integration = path.join(base, 'integration');
  const task = path.join(base, 'task-T1');
  git(primary, 'worktree', 'add', '-q', controller, 'controller');
  git(primary, 'worktree', 'add', '-q', '--detach', integration, 'target');
  git(primary, 'worktree', 'add', '-q', '-b', 'juno/task-T1', task, 'target');
  for (const root of [primary, controller, integration, task])
    mkdirSync(path.join(root, '.juno_task', 'scripts'), { recursive: true });
  const resolver = path.resolve(process.cwd(), 'src/templates/scripts/controller_resolver.py');
  for (const root of [primary, controller, integration, task])
    writeFileSync(
      path.join(root, '.juno_task/scripts/controller_resolver.py'),
      readFileSync(resolver),
    );
  mkdirSync(path.join(controller, '.juno_task', 'config'), { recursive: true });
  writeFileSync(
    path.join(controller, '.juno_task/config/task-workspace.json'),
    JSON.stringify({ target_ref: 'refs/heads/target' }),
  );
  git(primary, 'config', 'extensions.worktreeConfig', 'true');
  git(primary, 'config', 'juno.controller.path', controller);
  // Deliberately short: normalized comparison must remain valid and diagnose spelling drift.
  git(primary, 'config', 'juno.controller.branch', 'controller');
  git(controller, 'config', '--worktree', 'juno.workspace.role', 'controller');
  git(integration, 'config', '--worktree', 'juno.workspace.role', 'integration-owner');
  git(
    integration,
    'config',
    '--worktree',
    'juno.workspace.roleAuthority',
    'protected-integration.v1',
  );
  git(task, 'config', '--worktree', 'juno.workspace.role', 'task');
  git(task, 'config', '--worktree', 'juno.workspace.taskId', 'T1');
  for (const key of ['manifestIdentity', 'createReceiptSha256', 'expectedPathsSha256'])
    git(task, 'config', '--worktree', `juno.workspace.${key}`, 'identity');
  return { primary, controller, integration, task };
}

afterEach(() => {
  for (const item of fixtures.splice(0)) spawnSync('rm', ['-rf', item]);
});

describe('normalized workspace topology', () => {
  it('discovers linked roles, normalizes controller refs, and resolves script-safe paths', () => {
    const value = fixture();
    const report = inspectWorkspaceTopology(path.join(value.task, '.juno_task'), '2.1.1');
    expect(report.schemaVersion).toBe('juno.workspace-topology.v1');
    expect(report.invocation.role).toBe('task');
    expect(report.invocation.roleAuthority).toBeNull();
    expect(report.controller.valid).toBe(true);
    expect(report.findings.map((item) => item.code)).toContain('controller-ref-spelling-drift');
    expect(report.integration.owner?.path).toBe(value.integration);
    expect(workspaceLocation(report, 'controller')).toBe(value.controller);
    expect(workspaceLocation(report, 'integration')).toBe(value.integration);
    expect(workspaceLocation(report, 'task', 'T1')).toBe(value.task);

    const controllerReport = inspectWorkspaceTopology(value.controller, '2.1.1');
    expect(controllerReport.invocation).toMatchObject({
      root: value.controller,
      role: 'controller',
      roleAuthority: null,
    });
    const nested = path.join(value.integration, 'nested', 'directory');
    mkdirSync(nested, { recursive: true });
    const integrationReport = inspectWorkspaceTopology(nested, '2.1.1');
    expect(integrationReport.invocation).toMatchObject({
      root: value.integration,
      role: 'integration-owner',
      roleAuthority: 'protected-integration.v1',
    });
  });

  it('shows non-Git and unrelated Git invocations as unmanaged', () => {
    const nonGit = realpathSync(mkdtempSync(path.join(tmpdir(), 'juno-non-git-')));
    const unrelated = realpathSync(mkdtempSync(path.join(tmpdir(), 'juno-unrelated-')));
    fixtures.push(nonGit, unrelated);
    git(unrelated, 'init', '-q');

    const nonGitReport = inspectWorkspaceTopology(nonGit, '2.1.1');
    expect(nonGitReport.repository.root).toBeNull();
    expect(nonGitReport.findings.map((item) => item.code)).toContain('not-git-repository');
    const unrelatedReport = inspectWorkspaceTopology(unrelated, '2.1.1');
    expect(unrelatedReport.repository.root).toBe(unrelated);
    expect(unrelatedReport.invocation).toMatchObject({
      role: 'unregistered',
      roleAuthority: null,
      managed: false,
    });
  });

  it('shows missing resolver as unmanaged rather than valid controller truth', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'juno-unmanaged-'));
    fixtures.push(base);
    git(base, 'init', '-q');
    const report = inspectWorkspaceTopology(base, '2.1.1');
    expect(report.resolver.status).toBe('missing');
    expect(report.invocation.role).toBe('unregistered');
    expect(report.invocation.managed).toBe(false);
    expect(report.repository.managed).toBe(false);
    expect(() => workspaceLocation(report, 'controller')).toThrow(/found 0/);
  });

  it('diagnoses missing/multiple, dirty, and attached integration owners and fails where ambiguity closed', () => {
    const value = fixture();
    git(value.integration, 'config', '--worktree', '--unset', 'juno.workspace.role');
    let report = inspectWorkspaceTopology(value.controller, '2.1.1');
    expect(report.integration.status).toBe('missing');
    expect(() => workspaceLocation(report, 'integration')).toThrow(/found 0/);

    git(value.integration, 'config', '--worktree', 'juno.workspace.role', 'integration-owner');
    git(value.integration, 'checkout', '-qb', 'unexpected-integration-branch');
    writeFileSync(path.join(value.integration, 'dirty'), 'dirty');
    git(value.primary, 'config', '--worktree', 'juno.workspace.role', 'integration-owner');
    git(
      value.primary,
      'config',
      '--worktree',
      'juno.workspace.roleAuthority',
      'protected-integration.v1',
    );
    report = inspectWorkspaceTopology(value.controller, '2.1.1');
    const codes = report.findings.map((item) => item.code);
    expect(report.integration.status).toBe('multiple');
    expect(codes).toEqual(
      expect.arrayContaining([
        'integration-owner-multiple',
        'integration-owner-dirty',
        'integration-owner-attached',
      ]),
    );
    expect(() => workspaceLocation(report, 'integration')).toThrow(/found 2/);
  });

  it('detects stale owners, wrong-role target holders, and task-role mismatch', () => {
    const value = fixture();
    git(value.primary, 'checkout', 'target');
    writeFileSync(path.join(value.primary, 'later'), 'later');
    git(value.primary, 'add', 'later');
    git(value.primary, 'commit', '-qm', 'advance target');
    git(value.task, 'config', '--worktree', 'juno.workspace.role', 'controller');
    const report = inspectWorkspaceTopology(value.controller, '2.1.1');
    const codes = report.findings.map((item) => item.code);
    expect(codes).toContain('integration-owner-stale');
    expect(codes).toContain('target-owner-role-mismatch');
    expect(codes).toContain('task-role-mismatch');
    expect(workspaceLocation(report, 'target')).toBe(value.primary);
  });

  it('diagnoses wrong controller path/ref and a prunable legacy registration', () => {
    const value = fixture();
    git(value.primary, 'config', 'juno.controller.path', path.join(path.dirname(value.primary), 'missing'));
    let report = inspectWorkspaceTopology(value.task, '2.1.1');
    expect(report.resolver.status).toBe('invalid');
    expect(report.findings.map((item) => item.code)).toContain('controller-invalid');

    git(value.primary, 'config', 'juno.controller.path', value.controller);
    git(value.primary, 'config', 'juno.controller.branch', 'wrong-controller-ref');
    const legacy = path.join(path.dirname(value.primary), 'legacy-integration');
    git(value.primary, 'worktree', 'add', '-q', '--detach', legacy, 'target');
    git(value.primary, 'config', 'juno.gitFlow.integrationCheckout', legacy);
    spawnSync('rm', ['-rf', legacy]);
    report = inspectWorkspaceTopology(value.task, '2.1.1');
    const codes = report.findings.map((item) => item.code);
    expect(report.resolver.status).toBe('invalid');
    expect(codes).toContain('controller-invalid');
    expect(codes).toContain('legacy-integration-prunable');
  });

  it('exposes parseable, quiet CLI projections and doctor/where exit behavior', () => {
    const value = fixture();
    const jsonInfo = cli(['info', '--json', '--cwd', value.integration], value.integration);
    expect(jsonInfo.status, jsonInfo.stderr).toBe(0);
    expect(jsonInfo.stderr).toBe('');
    expect(JSON.parse(jsonInfo.stdout)).toMatchObject({
      schemaVersion: 'juno.workspace-topology.v1',
      invocation: { role: 'integration-owner', roleAuthority: 'protected-integration.v1' },
    });

    const humanInfo = cli(['info', '--cwd', value.integration], value.integration);
    expect(humanInfo.status, humanInfo.stderr).toBe(0);
    expect(humanInfo.stderr).toBe('');
    expect(humanInfo.stdout).toContain('Juno workspace (juno.workspace-topology.v1)');
    expect(humanInfo.stdout).toContain('Role authority');

    const where = cli(['where', 'controller', '--cwd', value.task], value.task);
    expect(where.status, where.stderr).toBe(0);
    expect(where.stderr).toBe('');
    expect(where.stdout.trim()).toBe(value.controller);

    git(value.primary, 'config', '--worktree', 'juno.workspace.role', 'integration-owner');
    git(
      value.primary,
      'config',
      '--worktree',
      'juno.workspace.roleAuthority',
      'protected-integration.v1',
    );
    const doctor = cli(['doctor', 'workspace', '--json', '--cwd', value.task], value.task);
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toBe('');
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      schemaVersion: 'juno.workspace-topology.v1',
      healthy: false,
      integration: { status: 'multiple' },
    });
    const ambiguous = cli(['where', 'integration', '--cwd', value.task], value.task);
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stdout).toBe('');
  }, 60_000);

  it('does not mutate Git or filesystem state', () => {
    const value = fixture();
    const before =
      run(value.primary, 'git', 'for-each-ref', '--format=%(refname) %(objectname)') +
      run(value.primary, 'git', 'worktree', 'list', '--porcelain');
    inspectWorkspaceTopology(value.integration, '2.1.1');
    const after =
      run(value.primary, 'git', 'for-each-ref', '--format=%(refname) %(objectname)') +
      run(value.primary, 'git', 'worktree', 'list', '--porcelain');
    expect(after).toBe(before);
  });
});
