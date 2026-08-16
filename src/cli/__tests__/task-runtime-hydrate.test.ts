import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { selectTaskWorkspaceRuntime } from '../commands/task.js';

const roots: string[] = [];

async function fixture(): Promise<{ controller: string; canonical: string; packaged: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-task-hydrate-'));
  roots.push(root);
  const controller = path.join(root, 'controller');
  const scripts = path.join(controller, '.juno_task', 'scripts');
  const packagedRoot = path.join(root, 'package', 'templates', 'scripts');
  const canonical = path.join(scripts, 'task_workspace.py');
  const packaged = path.join(packagedRoot, 'task_workspace.py');
  await fs.ensureDir(scripts);
  await fs.ensureDir(packagedRoot);
  await fs.writeFile(canonical, [
    'import sys',
    'print("unsupported task audit operation: hydrate", file=sys.stderr)',
    'raise SystemExit(2)',
  ].join('\n'));
  await fs.writeFile(packaged, [
    'TASK_HYDRATE_RECOVERY_SCHEMA = "juno_task_hydrate_recovery.v1"',
    'def hydrate(controller: object, task_id: str): pass',
    'AUDITED = ("start", "status", "hydrate", "preflight", "finish")',
    'ROUTED = ("start", "status", "hydrate", "preflight", "finish",)',
  ].join('\n'));
  await fs.writeFile(path.join(packagedRoot, 'workflow_runner.sh'), '# packaged runner\n');
  return { controller, canonical, packaged };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('task hydrate recovery runtime routing', () => {
  it('uses the protocol-checked package runtime instead of a stale selected runtime', async () => {
    const { controller, packaged } = await fixture();
    await expect(selectTaskWorkspaceRuntime(controller, 'hydrate', [packaged]))
      .resolves.toBe(packaged);
  });

  it('keeps ordinary task operations bound to the selected controller runtime', async () => {
    const { controller, canonical, packaged } = await fixture();
    await expect(selectTaskWorkspaceRuntime(controller, 'start', [packaged]))
      .resolves.toBe(canonical);
    await expect(selectTaskWorkspaceRuntime(controller, 'status', [packaged]))
      .resolves.toBe(canonical);
  });

  it('fails closed when the packaged hydrate protocol or runner is incomplete', async () => {
    const { controller, packaged } = await fixture();
    await fs.writeFile(packaged, '# incompatible package runtime\n');
    await expect(selectTaskWorkspaceRuntime(controller, 'hydrate', [packaged]))
      .rejects.toThrow('incompatible; refusing stale controller fallback');

    const complete = await fixture();
    await fs.remove(path.join(path.dirname(complete.packaged), 'workflow_runner.sh'));
    await expect(selectTaskWorkspaceRuntime(complete.controller, 'hydrate', [complete.packaged]))
      .rejects.toThrow('incomplete; refusing stale controller fallback');
  });
});
