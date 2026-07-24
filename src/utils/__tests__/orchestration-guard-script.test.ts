import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(process.cwd(), '..');
const script = path.join(projectRoot, '.juno_task', 'scripts', 'orchestration_guard.py');
const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = path.join('/tmp', `juno-guard-${process.pid}-${Date.now()}`);
  roots.push(root);
  await fs.ensureDir(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.remove(root);
});

describe('orchestration guard', () => {
  it('fails visibly on overlap and permits a later owner', async () => {
    const state = await stateRoot();
    const env = { ...process.env, JUNO_TASK_ROOT: projectRoot, JUNO_CODE_SESSION_METADATA_DIRECTORY: state, JUNO_WORKSPACE_ROLE: 'controller' };
    const first = childProcess.spawn('python3', [script, '--key', 'cron-test', '--', 'python3', '-c', 'import time; time.sleep(1)'], {
      cwd: projectRoot, env, stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const overlap = childProcess.spawnSync('python3', [script, '--key', 'cron-test', '--', 'true'], {
      cwd: projectRoot, env, encoding: 'utf8',
    });
    expect(overlap.status).toBe(2);
    expect(overlap.stderr).toContain('orchestration overlap');
    await new Promise<void>((resolve) => first.on('exit', () => resolve()));
    const later = childProcess.spawnSync('python3', [script, '--key', 'cron-test', '--', 'true'], { cwd: projectRoot, env });
    expect(later.status).toBe(0);
  });

  it('reclaims a stale marker and propagates canonical ownership environment', async () => {
    const state = await stateRoot();
    const key = 'stale-test';
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const lock = path.join(state, 'orchestration_locks', `${digest}.lock`);
    await fs.ensureDir(lock);
    await fs.writeJson(path.join(lock, 'owner.json'), { pid: 99999999 });
    const env = { ...process.env, JUNO_TASK_ROOT: projectRoot, JUNO_CODE_SESSION_METADATA_DIRECTORY: state, JUNO_WORKSPACE_ROLE: 'controller' };
    const result = childProcess.spawnSync('python3', [script, '--key', key, '--', 'python3', '-c', 'import os; print(os.environ["JUNO_TASK_ROOT"]); print(os.environ["JUNO_CODE_SESSION_METADATA_DIRECTORY"])'], {
      cwd: projectRoot, env, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(projectRoot);
    expect(result.stdout).toContain(state);
    expect(await fs.pathExists(lock)).toBe(false);
  });
});
