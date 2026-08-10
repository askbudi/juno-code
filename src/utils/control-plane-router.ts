import path from 'node:path';
import type { ControllerOperation, ControllerResolution, WorkspaceRole } from './controller-resolver.js';
import { resolveController } from './controller-resolver.js';
import { buildChildProcessEnvironment } from '../core/child-process-environment.js';

export type RoutedControlPlane = {
  controllerRoot: string;
  invocationRoot: string;
  invocationRole: WorkspaceRole;
  resolution: ControllerResolution;
  env: NodeJS.ProcessEnv;
};

/**
 * Resolve an explicitly supported control-plane operation without weakening the
 * resolver's direct-write policy for the invoking product checkout.
 */
export function routeControlPlane(
  workingDirectory: string,
  operation: ControllerOperation,
): RoutedControlPlane {
  // Diagnostic resolution validates persisted topology without pretending that
  // the product checkout itself is performing the eventual controller write.
  const resolution = resolveController(workingDirectory, 'diagnostic', {
    ignoreEnvironmentAssertions: true,
  });
  const controllerRoot = path.resolve(resolution.path);
  let invocationRoot = path.resolve(resolution.current_root);
  let invocationRole = resolution.role;
  const forwardedRoot = process.env.JUNO_CONTROL_INVOCATION_ROOT?.trim();
  const forwardedRole = process.env.JUNO_CONTROL_INVOCATION_ROLE?.trim();
  const forwardedEffective = process.env.JUNO_CONTROL_EFFECTIVE_ROOT?.trim();
  if (forwardedRoot || forwardedRole || forwardedEffective) {
    if (!forwardedRoot || !forwardedRole || path.resolve(forwardedEffective ?? '') !== controllerRoot) {
      throw new Error('Incomplete or mismatched forwarded control-plane audit identity.');
    }
    const origin = resolveController(forwardedRoot, 'diagnostic', {
      ignoreEnvironmentAssertions: true,
    });
    if (
      !origin.valid || path.resolve(origin.path) !== controllerRoot ||
      origin.role !== forwardedRole || !['controller', 'task', 'integration-owner'].includes(origin.role)
    ) {
      throw new Error('Forwarded control-plane audit identity no longer matches registered workspace authority.');
    }
    invocationRoot = path.resolve(origin.current_root);
    invocationRole = origin.role;
  }
  if (
    resolution.resolver !== 'installed' ||
    !resolution.valid ||
    !['controller', 'task', 'integration-owner'].includes(invocationRole)
  ) {
    throw new Error(
      `Control-plane routing requires a valid registered controller, task, or integration-owner workspace. Run \`yy doctor workspace\` from ${invocationRoot}.`,
    );
  }
  const env = buildChildProcessEnvironment(process.env, {
    JUNO_TASK_ROOT: controllerRoot,
    JUNO_CONTROLLER_SOURCE: resolution.source,
    JUNO_WORKSPACE_ROLE: 'controller',
    JUNO_WORKSPACE_ENFORCEMENT: 'strict',
    JUNO_CONTROL_INVOCATION_ROOT: invocationRoot,
    JUNO_CONTROL_INVOCATION_ROLE: invocationRole,
    JUNO_CONTROL_EFFECTIVE_ROOT: controllerRoot,
    JUNO_CONTROL_OPERATION: operation,
  });
  if (resolution.expected_branch) env.JUNO_CONTROLLER_BRANCH = resolution.expected_branch;
  else delete env.JUNO_CONTROLLER_BRANCH;
  return {
    controllerRoot,
    invocationRoot,
    invocationRole,
    resolution: { ...resolution, operation },
    env,
  };
}
