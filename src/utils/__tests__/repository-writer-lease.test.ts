import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const writerGuard = path.resolve(process.cwd(), 'src/templates/scripts/repository_writer_guard.py');
const integrationPreflight = path.resolve(
  process.cwd(),
  'src/templates/scripts/integration_owner_preflight.py',
);

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function initializeRepository(repository: string, cwd: string) {
  expect(run('git', ['init', '-b', 'main', repository], cwd).status).toBe(0);
  expect(run('git', ['-C', repository, 'config', 'user.email', 'fixture@example.invalid'], cwd).status).toBe(0);
  expect(run('git', ['-C', repository, 'config', 'user.name', 'Fixture'], cwd).status).toBe(0);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'fixture\n');
  expect(run('git', ['-C', repository, 'add', 'tracked.txt'], cwd).status).toBe(0);
  expect(run('git', ['-C', repository, 'commit', '-m', 'fixture'], cwd).status).toBe(0);
}

describe('repository-scoped Juno writer leases', () => {
  let testDir: string;
  let repository: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-writer-lease-'));
    repository = path.join(testDir, 'repository');
    initializeRepository(repository, testDir);
  });

  afterEach(async () => fs.remove(testDir));

  it('blocks integration for the same Git common directory while allowing unrelated repositories', async () => {
    const unrelated = path.join(testDir, 'unrelated');
    initializeRepository(unrelated, testDir);
    const inventory = path.join(testDir, 'empty-processes.json');
    await fs.writeJson(inventory, []);

    const holder = spawn(
      'python3',
      [writerGuard, '--cwd', repository, '--', 'python3', '-c', 'import time; time.sleep(3)'],
      { cwd: testDir, stdio: 'ignore' },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const blocked = run(
        'python3',
        [
          integrationPreflight,
          '--root', repository,
          '--repository', `root=${repository},refs/heads/main`,
          '--quiescence-seconds', '0',
          '--process-inventory-json', inventory,
        ],
        testDir,
      );
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain('integration lease busy');

      const allowed = run(
        'python3',
        [
          integrationPreflight,
          '--root', unrelated,
          '--repository', `root=${unrelated},refs/heads/main`,
          '--quiescence-seconds', '0',
          '--process-inventory-json', inventory,
        ],
        testDir,
      );
      expect(allowed.status).toBe(0);
    } finally {
      holder.kill('SIGTERM');
    }
  });
});
