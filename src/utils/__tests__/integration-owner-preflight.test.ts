import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = path.resolve(process.cwd(), 'src/templates/scripts/integration_owner_preflight.py');

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

describe('integration_owner_preflight.py template script', () => {
  let testDir: string;
  let repository: string;
  let inventoryPath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-owner-test-'));
    repository = path.join(testDir, 'repo');
    inventoryPath = path.join(testDir, 'processes.json');
    expect(run('git', ['init', '-b', 'main', repository], testDir).status).toBe(0);
    expect(run('git', ['-C', repository, 'config', 'user.email', 'fixture@example.invalid'], testDir).status).toBe(0);
    expect(run('git', ['-C', repository, 'config', 'user.name', 'Fixture'], testDir).status).toBe(0);
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'initial\n');
    expect(run('git', ['-C', repository, 'add', 'tracked.txt'], testDir).status).toBe(0);
    expect(run('git', ['-C', repository, 'commit', '-m', 'initial'], testDir).status).toBe(0);
    await fs.writeJson(inventoryPath, []);
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  it('holds leases through a clean command and writes a redacted receipt', async () => {
    const receiptPath = path.join(testDir, 'integration-owner.json');
    const result = run(
      'python3',
      [
        helper,
        '--root', testDir,
        '--repository', `root=${repository},refs/heads/main`,
        '--quiescence-seconds', '0',
        '--process-inventory-json', inventoryPath,
        '--output', receiptPath,
        '--exec-command', '/usr/bin/true',
      ],
      testDir,
    );

    expect(result.status).toBe(0);
    const receipt = await fs.readJson(receiptPath);
    expect(receipt.passed).toBe(true);
    expect(receipt.leases_held_through_command).toBe(true);
    expect(receipt.signals_sent).toBe(0);
    expect(receipt.command).toHaveProperty('argv_sha256');
    expect(receipt.command).not.toHaveProperty('argv');
    expect(receipt.repositories.writers).toEqual([]);
    expect(receipt.repositories.writers_after).toEqual([]);
    expect(receipt.repositories.process_inventory_count).toBe(0);
    expect(receipt.repositories.process_candidates).toEqual([]);
    expect(receipt.repositories.process_candidates_after).toEqual([]);
  });

  it('checkpoints and proves the controller clean before integration leases', async () => {
    const checkpoint = path.resolve(process.cwd(), 'src/templates/scripts/controller_checkpoint.py');
    await fs.ensureDir(path.join(repository, '.juno_task', 'scripts'));
    await fs.ensureDir(path.join(repository, '.juno_task', 'tasks'));
    await fs.copyFile(checkpoint, path.join(repository, '.juno_task', 'scripts', 'controller_checkpoint.py'));
    await fs.writeFile(path.join(repository, '.juno_task', 'tasks', 'state.md'), 'initial\n');
    expect(run('git', ['-C', repository, 'add', '.juno_task/tasks/state.md', '.juno_task/scripts/controller_checkpoint.py'], testDir).status).toBe(0);
    expect(run('git', ['-C', repository, 'commit', '-m', 'controller baseline'], testDir).status).toBe(0);
    await fs.writeFile(path.join(repository, '.juno_task', 'tasks', 'state.md'), 'durable\n');
    const receiptPath = path.join(testDir, 'checkpoint-preflight.json');
    const result = run('python3', [
      helper,
      '--root', testDir,
      '--checkpoint-controller', repository,
      '--repository', `root=${repository},refs/heads/main`,
      '--quiescence-seconds', '0',
      '--process-inventory-json', inventoryPath,
      '--output', receiptPath,
    ], testDir);
    expect(result.status, result.stderr).toBe(0);
    const receipt = await fs.readJson(receiptPath);
    expect(receipt.controller_checkpoint.outcome).toBe('committed');
    expect(run('git', ['-C', repository, 'status', '--porcelain'], testDir).stdout).toBe('');
  });

  it('rejects a dirty integration owner before executing a command', async () => {
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'dirty\n');
    const result = run(
      'python3',
      [
        helper,
        '--root', testDir,
        '--repository', `root=${repository},refs/heads/main`,
        '--quiescence-seconds', '0',
        '--process-inventory-json', inventoryPath,
        '--exec-command', '/usr/bin/true',
      ],
      testDir,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('clean: expected=true actual=false');
  });

  it('allows a Juno writer proven to belong to a different Git common directory', async () => {
    await fs.writeJson(inventoryPath, [
      {
        pid: 987653,
        ppid: 1,
        command: 'workflow_runner.sh --workflow unrelated.yaml',
        cwd_git_common_dir: path.join(testDir, 'different.git'),
      },
    ]);
    const result = run(
      'python3',
      [
        helper,
        '--root', testDir,
        '--repository', `root=${repository},refs/heads/main`,
        '--quiescence-seconds', '0',
        '--process-inventory-json', inventoryPath,
      ],
      testDir,
    );

    expect(result.status).toBe(0);
  });

  it('rejects external Juno writers when their repository scope is unknown', async () => {
    await fs.writeJson(inventoryPath, [
      { pid: 987654, ppid: 1, command: 'yy -s codex secret-prompt' },
    ]);
    const result = run(
      'python3',
      [
        helper,
        '--root', testDir,
        '--repository', `root=${repository},refs/heads/main`,
        '--quiescence-seconds', '0',
        '--process-inventory-json', inventoryPath,
      ],
      testDir,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('other_write_capable_processes');
    expect(result.stderr).not.toContain('secret-prompt');
  });
});
