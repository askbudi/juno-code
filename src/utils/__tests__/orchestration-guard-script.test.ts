import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(process.cwd(), 'src/templates/scripts/orchestration_guard.py');
const roots: string[] = [];

async function fixture(): Promise<{ controller: string; state: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-guard-'));
  roots.push(root);
  const controller = path.join(root, 'controller');
  const state = path.join(root, 'metadata');
  await fs.ensureDir(path.join(controller, '.juno_task', 'scripts'));
  await fs.ensureDir(state);
  await fs.copyFile(
    path.resolve(process.cwd(), 'src/templates/scripts/controller_resolver.py'),
    path.join(controller, '.juno_task', 'scripts', 'controller_resolver.py'),
  );
  childProcess.spawnSync('git', ['init', '-b', 'fixture-controller'], {
    cwd: controller,
    encoding: 'utf8',
  });
  return {
    controller,
    state,
    env: {
      ...process.env,
      JUNO_TASK_ROOT: controller,
      JUNO_CODE_SESSION_METADATA_DIRECTORY: state,
      JUNO_WORKSPACE_ROLE: 'controller',
      JUNO_CONTROLLER_BRANCH: 'fixture-controller',
      JUNO_WORKSPACE_ENFORCEMENT: 'strict',
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.remove(root)));
});

describe('orchestration guard', () => {
  it('fails visibly on overlap and permits a later owner', async () => {
    const { controller, env } = await fixture();
    const first = childProcess.spawn('python3', [script, '--key', 'cron-test', '--', 'python3', '-c', 'import time; time.sleep(1)'], {
      cwd: controller, env, stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const overlap = childProcess.spawnSync('python3', [script, '--key', 'cron-test', '--', 'true'], {
      cwd: controller, env, encoding: 'utf8',
    });
    expect(overlap.status).toBe(2);
    expect(overlap.stderr).toContain('orchestration overlap');
    await new Promise<void>((resolve) => first.on('exit', () => resolve()));
    const later = childProcess.spawnSync('python3', [script, '--key', 'cron-test', '--', 'true'], { cwd: controller, env });
    expect(later.status).toBe(0);
  });

  it('reclaims a stale marker and propagates canonical ownership environment', async () => {
    const { controller, state, env } = await fixture();
    const key = 'stale-test';
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const lock = path.join(state, 'orchestration_locks', `${digest}.lock`);
    await fs.ensureDir(lock);
    await fs.writeJson(path.join(lock, 'owner.json'), { pid: 99999999 });
    const result = childProcess.spawnSync('python3', [script, '--key', key, '--', 'python3', '-c', 'import os; print(os.environ["JUNO_TASK_ROOT"]); print(os.environ["JUNO_CODE_SESSION_METADATA_DIRECTORY"])'], {
      cwd: controller, env, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(controller);
    expect(result.stdout).toContain(state);
    expect(await fs.pathExists(lock)).toBe(false);
  });
});
