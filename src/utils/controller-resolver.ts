import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { existsSync as requireExists } from 'node:fs';

export type ControllerOperation = 'diagnostic' | 'kanban' | 'orchestration' | 'session-write';

export interface ControllerResolution {
  path: string;
  source: 'environment' | 'registration' | 'current-root';
  expected_branch: string | null;
  actual_branch: string | null;
  role: 'controller' | 'task' | 'integration-owner';
  enforcement: 'off' | 'warn' | 'strict';
  operation: ControllerOperation;
  valid: boolean;
  diagnostics: string[];
}

/** Invoke the installed shared resolver so wrappers, runners, and Node use one contract. */
export function resolveController(
  workingDirectory: string,
  operation: ControllerOperation = 'diagnostic',
): ControllerResolution {
  let search = path.resolve(workingDirectory);
  let resolver = path.join(search, '.juno_task', 'scripts', 'controller_resolver.py');
  while (!requireExists(resolver) && search !== path.dirname(search)) {
    search = path.dirname(search);
    resolver = path.join(search, '.juno_task', 'scripts', 'controller_resolver.py');
  }
  if (!requireExists(resolver)) {
    return {
      path: path.resolve(workingDirectory),
      source: 'current-root',
      expected_branch: null,
      actual_branch: null,
      role: 'controller',
      enforcement: 'off',
      operation,
      valid: true,
      diagnostics: ['controller resolver is not installed; using backward-compatible current root'],
    };
  }
  const output = execFileSync('python3', [resolver, '--cwd', workingDirectory, '--operation', operation], {
    cwd: workingDirectory,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(output) as ControllerResolution;
}

export function controllerEnvironment(
  workingDirectory: string,
  operation: ControllerOperation = 'orchestration',
): NodeJS.ProcessEnv {
  const resolution = resolveController(workingDirectory, operation);
  return {
    ...process.env,
    JUNO_TASK_ROOT: resolution.path,
    JUNO_CONTROLLER_SOURCE: resolution.source,
    JUNO_WORKSPACE_ROLE: resolution.role,
  };
}
