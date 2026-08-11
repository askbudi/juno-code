import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { resolveController, type WorkspaceRole } from './controller-resolver.js';

export const WORKSPACE_TOPOLOGY_SCHEMA = 'juno.workspace-topology.v1' as const;

export type FindingSeverity = 'error' | 'warning' | 'info';
export interface WorkspaceFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  evidence: string[];
  nextCommand: string | null;
}

export interface WorktreeState {
  path: string;
  head: string | null;
  branch: string | null;
  role: WorkspaceRole;
  roleAuthority: string | null;
  taskId: string | null;
  taskIdentityComplete: boolean;
  clean: boolean | null;
  prunable: boolean;
}

export interface WorkspaceTopology {
  schemaVersion: typeof WORKSPACE_TOPOLOGY_SCHEMA;
  repository: { managed: boolean; root: string | null; identity: string | null };
  invocation: {
    cwd: string;
    root: string | null;
    role: WorkspaceRole;
    roleAuthority: string | null;
    managed: boolean;
  };
  resolver: {
    status: 'installed' | 'missing' | 'invalid';
    path: string | null;
    diagnostics: string[];
  };
  controller: {
    path: string | null;
    configuredRef: string | null;
    ref: string | null;
    head: string | null;
    valid: boolean;
    runtimeVersion: string | null;
    generation: string | null;
  };
  target: { ref: string | null; sha: string | null; owners: string[] };
  integration: {
    status: 'unique' | 'missing' | 'multiple';
    owner: WorktreeState | null;
    candidates: string[];
    legacyRegistration: { path: string | null; prunable: boolean };
    relation: { ahead: number | null; behind: number | null };
  };
  tasks: WorktreeState[];
  worktrees: WorktreeState[];
  submodules: Array<{
    path: string;
    sha: string;
    state: 'initialized' | 'uninitialized' | 'wrong-gitlink' | 'conflict';
  }>;
  runtime: { cliVersion: string; controllerVersion: string | null; drift: boolean };
  findings: WorkspaceFinding[];
  healthy: boolean;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch {
    return null;
  }
}

function config(cwd: string, key: string, worktree = false): string | null {
  return git(cwd, ['config', ...(worktree ? ['--worktree'] : ['--local']), '--get', key]);
}

function normalizeRef(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith('refs/heads/') ? value : `refs/heads/${value}`;
}

function findResolver(start: string): string | null {
  let cursor = path.resolve(start);
  for (;;) {
    const candidate = path.join(cursor, '.juno_task', 'scripts', 'controller_resolver.py');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function parseWorktrees(
  repo: string,
): Array<{ path: string; head: string | null; branch: string | null; prunable: boolean }> {
  const value = git(repo, ['worktree', 'list', '--porcelain']) ?? '';
  const records: Array<{
    path: string;
    head: string | null;
    branch: string | null;
    prunable: boolean;
  }> = [];
  for (const block of value.split(/\n\n+/).filter(Boolean)) {
    const lines = block.split('\n');
    const root = lines.find((line) => line.startsWith('worktree '))?.slice(9);
    if (!root) continue;
    records.push({
      path: path.resolve(root),
      head: lines.find((line) => line.startsWith('HEAD '))?.slice(5) ?? null,
      branch: lines.find((line) => line.startsWith('branch '))?.slice(7) ?? null,
      prunable: lines.some((line) => line.startsWith('prunable')),
    });
  }
  return records;
}

function inspectWorktree(
  record: { path: string; head: string | null; branch: string | null; prunable: boolean },
  controllerPath: string | null,
): WorktreeState {
  if (record.prunable || !existsSync(record.path)) {
    return {
      ...record,
      role: 'unregistered',
      roleAuthority: null,
      taskId: null,
      taskIdentityComplete: false,
      clean: null,
    };
  }
  const entries = new Map<string, string>();
  for (const line of (
    git(record.path, ['config', '--worktree', '--get-regexp', '^juno\\.workspace\\.']) ?? ''
  ).split('\n')) {
    const separator = line.indexOf(' ');
    if (separator > 0)
      entries.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1));
  }
  const persisted = entries.get('juno.workspace.role') ?? null;
  const role: WorkspaceRole =
    record.path === controllerPath
      ? 'controller'
      : persisted === 'controller' ||
          persisted === 'controller-retired' ||
          persisted === 'task' ||
          persisted === 'integration-owner'
        ? persisted
        : 'unregistered';
  const taskId = entries.get('juno.workspace.taskid') ?? null;
  const identity = ['manifestidentity', 'createreceiptsha256', 'expectedpathssha256'].every((key) =>
    Boolean(entries.get(`juno.workspace.${key}`)),
  );
  return {
    ...record,
    role,
    roleAuthority: entries.get('juno.workspace.roleauthority') ?? null,
    taskId,
    taskIdentityComplete: role === 'task' && Boolean(taskId) && identity,
    clean:
      role === 'task' || role === 'integration-owner'
        ? git(record.path, ['status', '--porcelain', '--untracked-files=normal']) === ''
        : null,
  };
}

function readTargetRef(controller: string | null, repo: string): string | null {
  if (!controller) return null;
  try {
    const policy = JSON.parse(
      readFileSync(path.join(controller, '.juno_task', 'config', 'task-workspace.json'), 'utf8'),
    ) as { target_ref?: unknown; repository?: unknown };
    return typeof policy.target_ref === 'string' ? normalizeRef(policy.target_ref) : null;
  } catch {
    // An older controller may have no task policy; legacy Git-flow config is diagnostic-only.
    const branch = config(repo, 'juno.gitFlow.integrationBranch');
    return normalizeRef(branch);
  }
}

function counts(
  repo: string,
  left: string | null,
  right: string | null,
): { ahead: number | null; behind: number | null } {
  if (!left || !right) return { ahead: null, behind: null };
  const value = git(repo, ['rev-list', '--left-right', '--count', `${left}...${right}`]);
  const match = value?.match(/^(\d+)\s+(\d+)$/);
  return match
    ? { ahead: Number(match[1]), behind: Number(match[2]) }
    : { ahead: null, behind: null };
}

function submodules(repo: string): WorkspaceTopology['submodules'] {
  const output = git(repo, ['submodule', 'status', '--recursive']);
  if (!output) return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const marker = line[0];
      const parts = line.slice(1).trim().split(/\s+/);
      return {
        path: parts[1] ?? '',
        sha: parts[0] ?? '',
        state:
          marker === '-'
            ? ('uninitialized' as const)
            : marker === '+'
              ? ('wrong-gitlink' as const)
              : marker === 'U'
                ? ('conflict' as const)
                : ('initialized' as const),
      };
    });
}

export function inspectWorkspaceTopology(
  workingDirectory: string,
  cliVersion: string,
): WorkspaceTopology {
  const cwd = realpathSync(path.resolve(workingDirectory));
  const rootText = git(cwd, ['rev-parse', '--show-toplevel']);
  const repo = rootText ? path.resolve(rootText) : null;
  const identityText = repo
    ? git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    : null;
  const identity = identityText ? path.resolve(repo!, identityText) : null;
  const resolverPath = findResolver(cwd);
  let resolverStatus: WorkspaceTopology['resolver']['status'] = resolverPath
    ? 'installed'
    : 'missing';
  let resolverDiagnostics: string[] = [];
  let controllerPath: string | null = repo ? config(repo, 'juno.controller.path') : null;
  let invocationRole: WorkspaceRole = 'unregistered';
  if (resolverPath) {
    try {
      const resolution = resolveController(cwd, 'diagnostic', {
        ignoreEnvironmentAssertions: true,
      });
      controllerPath = resolution.path;
      invocationRole = resolution.role;
      resolverDiagnostics = resolution.diagnostics;
    } catch (error) {
      resolverStatus = 'invalid';
      resolverDiagnostics = [error instanceof Error ? error.message : String(error)];
    }
  }
  controllerPath = controllerPath ? path.resolve(controllerPath) : null;
  const configuredRef = repo ? config(repo, 'juno.controller.branch') : null;
  const controllerRef =
    controllerPath && existsSync(controllerPath)
      ? git(controllerPath, ['symbolic-ref', '--quiet', 'HEAD'])
      : null;
  const controllerHead =
    controllerPath && existsSync(controllerPath)
      ? git(controllerPath, ['rev-parse', 'HEAD'])
      : null;
  const sameIdentity = Boolean(
    controllerPath &&
      identity &&
      git(controllerPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']) &&
      path.resolve(
        controllerPath,
        git(controllerPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])!,
      ) === identity,
  );
  const controllerValid =
    resolverStatus === 'installed' &&
    Boolean(
      controllerHead && sameIdentity && normalizeRef(configuredRef) === normalizeRef(controllerRef),
    );
  const targetRef = repo ? readTargetRef(controllerPath, repo) : null;
  const targetSha =
    repo && targetRef ? git(repo, ['rev-parse', '--verify', `${targetRef}^{commit}`]) : null;
  const rawWorktrees = repo ? parseWorktrees(repo) : [];
  const worktrees = rawWorktrees.map((item) => inspectWorktree(item, controllerPath));
  const invocation = repo ? worktrees.find((item) => item.path === repo) : undefined;
  if (resolverStatus !== 'installed') invocationRole = 'unregistered';
  else if (invocation) invocationRole = invocation.role;
  const integrationCandidates = worktrees.filter(
    (item) => item.role === 'integration-owner' && !item.prunable,
  );
  const integrationOwner = integrationCandidates.length === 1 ? integrationCandidates[0]! : null;
  const integrationStatus =
    integrationCandidates.length === 0
      ? 'missing'
      : integrationCandidates.length === 1
        ? 'unique'
        : 'multiple';
  const targetOwners = worktrees
    .filter((item) => item.branch === targetRef)
    .map((item) => item.path);
  const legacyPath = repo ? config(repo, 'juno.gitFlow.integrationCheckout') : null;
  const legacyRecord = legacyPath
    ? rawWorktrees.find((item) => item.path === path.resolve(legacyPath))
    : undefined;
  const relation = counts(repo ?? cwd, integrationOwner?.head ?? null, targetSha);
  const runtimeVersion =
    controllerPath && existsSync(controllerPath)
      ? config(controllerPath, 'juno.controller.runtimeVersion', true)
      : null;
  const generation =
    controllerPath && existsSync(controllerPath)
      ? config(controllerPath, 'juno.controller.generation', true)
      : null;
  const findings: WorkspaceFinding[] = [];
  const add = (
    code: string,
    severity: FindingSeverity,
    message: string,
    evidence: string[],
    nextCommand: string | null,
  ) => findings.push({ code, severity, message, evidence, nextCommand });
  if (!repo)
    add('not-git-repository', 'error', 'Invocation is not inside a Git worktree.', [cwd], null);
  if (resolverStatus === 'missing')
    add(
      'resolver-missing',
      'warning',
      'Workspace is unmanaged because no installed controller resolver was found.',
      [cwd],
      'yy init',
    );
  if (resolverStatus === 'invalid')
    add(
      'resolver-invalid',
      'error',
      'The installed controller resolver rejected this workspace.',
      resolverDiagnostics,
      'yy doctor workspace',
    );
  if (repo && !controllerValid)
    add(
      'controller-invalid',
      'error',
      'Registered controller identity, repository, or branch is invalid.',
      [controllerPath ?? 'missing', configuredRef ?? 'missing', controllerRef ?? 'detached'],
      'yy migrate registration plan',
    );
  if (integrationStatus !== 'unique')
    add(
      `integration-owner-${integrationStatus}`,
      'error',
      `Integration owner registration is ${integrationStatus}.`,
      integrationCandidates.map((item) => item.path),
      'yy integration repair --dry-run',
    );
  for (const candidate of integrationCandidates) {
    if (candidate.clean === false)
      add(
        'integration-owner-dirty',
        'error',
        'Integration owner candidate has local changes.',
        [candidate.path],
        'yy integration status',
      );
    if (candidate.branch)
      add(
        'integration-owner-attached',
        'error',
        'Integration owner candidate is attached to a branch.',
        [candidate.path, candidate.branch],
        'yy integration repair --dry-run',
      );
    if (targetSha && candidate.head !== targetSha)
      add(
        'integration-owner-stale',
        'warning',
        'Integration owner candidate HEAD differs from the local target.',
        [candidate.path, candidate.head ?? 'missing', targetSha],
        'yy integration status',
      );
  }
  if (targetOwners.length) {
    for (const owner of targetOwners) {
      const state = worktrees.find((item) => item.path === owner);
      if (state?.role !== 'integration-owner')
        add(
          'target-owner-role-mismatch',
          'error',
          'Target ref is owned by a worktree with an unexpected role.',
          [owner, state?.role ?? 'unregistered', targetRef ?? 'missing'],
          'yy integration repair --dry-run',
        );
    }
  }
  if (legacyPath && (!legacyRecord || legacyRecord.prunable))
    add(
      'legacy-integration-prunable',
      'warning',
      'Legacy integration registration points to a missing or prunable worktree.',
      [legacyPath],
      'yy integration repair --dry-run',
    );
  for (const task of worktrees.filter((item) => item.role === 'task' && !item.taskIdentityComplete))
    add(
      'task-identity-incomplete',
      'error',
      'Task worktree has incomplete lifecycle identity.',
      [task.path, task.taskId ?? 'missing task id'],
      'yy task status',
    );
  for (const task of worktrees.filter(
    (item) => item.role === 'controller' && item.path !== controllerPath,
  ))
    add(
      'suspicious-worktree-role',
      'warning',
      'Non-controller worktree carries the controller role.',
      [task.path],
      'yy doctor workspace',
    );
  for (const task of worktrees.filter(
    (item) => item.branch?.startsWith('refs/heads/juno/task-') && item.role !== 'task',
  ))
    add(
      'task-role-mismatch',
      'error',
      'Task-named worktree does not carry persisted task authority.',
      [task.path, task.branch!, task.role],
      'yy task status',
    );
  if (runtimeVersion && runtimeVersion !== cliVersion)
    add(
      'runtime-version-drift',
      'warning',
      'Invoked CLI and controller runtime versions differ.',
      [cliVersion, runtimeVersion],
      'yy scripts doctor',
    );
  const moduleState = repo ? submodules(repo) : [];
  for (const module of moduleState.filter((item) => item.state !== 'initialized'))
    add(
      'submodule-not-initialized',
      'error',
      'A submodule is not initialized at its recorded gitlink.',
      [module.path, module.sha],
      'git submodule status --recursive',
    );
  return {
    schemaVersion: WORKSPACE_TOPOLOGY_SCHEMA,
    repository: {
      managed: resolverStatus === 'installed' && controllerValid,
      root: repo,
      identity,
    },
    invocation: {
      cwd,
      root: repo,
      role: invocationRole,
      roleAuthority: invocation?.roleAuthority ?? null,
      managed: resolverStatus === 'installed',
    },
    resolver: { status: resolverStatus, path: resolverPath, diagnostics: resolverDiagnostics },
    controller: {
      path: controllerPath,
      configuredRef,
      ref: controllerRef,
      head: controllerHead,
      valid: controllerValid,
      runtimeVersion,
      generation,
    },
    target: { ref: targetRef, sha: targetSha, owners: targetOwners },
    integration: {
      status: integrationStatus,
      owner: integrationOwner,
      candidates: integrationCandidates.map((item) => item.path),
      legacyRegistration: {
        path: legacyPath ? path.resolve(legacyPath) : null,
        prunable: Boolean(legacyPath && (!legacyRecord || legacyRecord.prunable)),
      },
      relation,
    },
    tasks: worktrees.filter((item) => item.role === 'task'),
    worktrees,
    submodules: moduleState,
    runtime: {
      cliVersion,
      controllerVersion: runtimeVersion,
      drift: Boolean(runtimeVersion && runtimeVersion !== cliVersion),
    },
    findings,
    healthy: !findings.some((item) => item.severity === 'error'),
  };
}

export function workspaceLocation(
  topology: WorkspaceTopology,
  kind: 'controller' | 'integration' | 'target' | 'task',
  taskId?: string,
): string {
  let matches: string[] = [];
  if (kind === 'controller' && topology.controller.valid && topology.controller.path)
    matches = [topology.controller.path];
  if (kind === 'integration') matches = topology.integration.candidates;
  if (kind === 'target') matches = topology.target.owners;
  if (kind === 'task')
    matches = topology.tasks
      .filter((item) => item.taskId === taskId && item.taskIdentityComplete)
      .map((item) => item.path);
  if (matches.length !== 1)
    throw new Error(
      `Cannot resolve ${kind}${taskId ? ` ${taskId}` : ''}: expected exactly one workspace, found ${matches.length}.`,
    );
  return matches[0]!;
}
