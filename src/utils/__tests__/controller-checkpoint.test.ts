import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const helper = path.resolve(process.cwd(), 'src/templates/scripts/controller_checkpoint.py');

function run(repo: string, ...args: string[]) {
  return spawnSync('python3', [helper, '--root', repo, ...args], { encoding: 'utf8' });
}

function runWithEnv(repo: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync('python3', [helper, '--root', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('controller_checkpoint.py template script', () => {
  let testDir: string;
  let repo: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-checkpoint-'));
    repo = path.join(testDir, 'repo');
    git(testDir, 'init', '-b', 'task', repo);
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'config', 'user.name', 'Fixture');
    await fs.ensureDir(path.join(repo, '.juno_task', 'tasks'));
    await fs.writeFile(path.join(repo, '.juno_task', 'config.json'), '{}\n');
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'one.md'), 'initial\n');
    await fs.writeFile(path.join(repo, 'product.txt'), 'initial\n');
    git(repo, 'add', '.juno_task/config.json', '.juno_task/tasks/one.md', 'product.txt');
    git(repo, 'commit', '-m', 'initial');
  });

  afterEach(async () => fs.remove(testDir));

  it('commits only explicit allowlisted controller files and supports a clean no-op', async () => {
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'one.md'), 'durable\n');
    const result = run(repo, 'commit', '--message', 'chore(controller): fixture');
    expect(result.status, result.stderr).toBe(0);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('.juno_task/tasks/one.md');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const noOp = run(repo, 'commit', '--message', 'chore(controller): no-op', '--json');
    expect(noOp.status, noOp.stderr).toBe(0);
    expect(JSON.parse(noOp.stdout).outcome).toBe('noop');
  });

  it('blocks dirty product paths and leaves both worktree and index untouched', async () => {
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'one.md'), 'controller\n');
    await fs.writeFile(path.join(repo, 'product.txt'), 'product\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    const result = run(repo, 'commit', '--message', 'must not commit');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('blocked non-controller paths');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('rejects staged or alternate-index work, detached HEAD, conflicts, and unsafe allowlist entries', async () => {
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'one.md'), 'staged\n');
    git(repo, 'add', '.juno_task/tasks/one.md');
    expect(run(repo, 'plan').stderr).toContain('pre-existing staged');
    git(repo, 'restore', '--staged', '.juno_task/tasks/one.md');
    expect(runWithEnv(repo, { GIT_INDEX_FILE: path.join(testDir, 'alternate-index') }, 'plan').stderr).toContain('alternate GIT_INDEX_FILE');
    git(repo, 'restore', '.juno_task/tasks/one.md');
    const attachedHead = git(repo, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), `${attachedHead}\n`);
    expect(run(repo, 'plan').stderr).toContain('named branch');
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/task\n');
    await fs.writeJson(path.join(repo, '.juno_task', 'config.json'), { gitCheckpoint: { include: ['../escape'] } });
    expect(run(repo, 'plan').stderr).toContain('unsafe allowlist');
  });

  it('parses porcelain-v2 renames and commits only the renamed controller path', async () => {
    git(repo, 'mv', '.juno_task/tasks/one.md', '.juno_task/tasks/renamed.md');
    git(repo, 'restore', '--staged', '.juno_task/tasks/one.md', '.juno_task/tasks/renamed.md');
    const result = run(repo, 'commit', '--message', 'chore(controller): rename fixture');
    expect(result.status, result.stderr).toBe(0);
    expect(git(repo, 'show', '--name-status', '--format=', 'HEAD')).toMatch(/R\d+\s+\.juno_task\/tasks\/one\.md\s+\.juno_task\/tasks\/renamed\.md/);
  });

  it('rejects symlink escapes and nested repositories', async () => {
    await fs.mkdir(path.join(testDir, 'outside'));
    await fs.symlink(path.join(testDir, 'outside'), path.join(repo, '.juno_task', 'tasks', 'link'));
    await fs.writeFile(path.join(testDir, 'outside', 'bad.md'), 'bad\n');
    expect(run(repo, 'plan').stderr).toContain('symlink');
    await fs.remove(path.join(repo, '.juno_task', 'tasks', 'link'));
    await fs.ensureDir(path.join(repo, '.juno_task', 'tasks', 'nested'));
    git(path.join(repo, '.juno_task', 'tasks'), 'init', path.join(repo, '.juno_task', 'tasks', 'nested'));
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'nested', 'x'), 'x');
    expect(run(repo, 'plan').stderr).toContain('nested repository');
  });

  it('quarantines a high-confidence stale empty index lock before inspection', async () => {
    const lock = path.join(repo, '.git', 'index.lock');
    await fs.writeFile(lock, '');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(lock, old, old);
    const plan = run(repo, 'plan', '--json');
    expect(plan.status).toBe(2);
    expect(await fs.pathExists(lock)).toBe(true);
    const result = run(repo, 'commit', '--message', 'chore(controller): stale lock fixture', '--json');
    expect(result.status, result.stderr).toBe(0);
    expect(await fs.pathExists(lock)).toBe(false);
    const quarantines = (await fs.readdir(path.join(repo, '.git'))).filter((name) =>
      name.startsWith('index.lock.stale.'),
    );
    expect(quarantines).toHaveLength(1);
  });

  it('rejects submodule dirt and an existing index lock', async () => {
    await fs.writeFile(path.join(repo, '.git', 'index.lock'), 'busy');
    expect(run(repo, 'plan').stderr).toContain('index.lock');
    await fs.remove(path.join(repo, '.git', 'index.lock'));
    const child = path.join(testDir, 'child');
    git(testDir, 'init', '-b', 'main', child);
    git(child, 'config', 'user.email', 'fixture@example.invalid');
    git(child, 'config', 'user.name', 'Fixture');
    await fs.writeFile(path.join(child, 'tracked'), 'initial\n');
    git(child, 'add', 'tracked');
    git(child, 'commit', '-m', 'child initial');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'juno_kanban');
    git(repo, 'commit', '-m', 'add child submodule');
    await fs.writeFile(path.join(repo, 'juno_kanban', 'tracked'), 'dirty\n');
    expect(run(repo, 'plan').stderr).toContain('dirty submodule state');
  });

  it('removes only checkpoint-owned staging when commit fails', async () => {
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'one.md'), 'must remain unstaged\n');
    const bin = path.join(testDir, 'bin');
    await fs.ensureDir(bin);
    const wrapper = path.join(bin, 'git');
    await fs.writeFile(wrapper, `#!/bin/sh\nfor arg in "$@"; do test "$arg" = commit && exit 73; done\nexec ${JSON.stringify(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim())} "$@"\n`);
    await fs.chmod(wrapper, 0o755);
    const result = runWithEnv(repo, { PATH: `${bin}:${process.env.PATH}` }, 'commit', '--message', 'must fail');
    expect(result.status).toBe(2);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toContain('.juno_task/tasks/one.md');
  });

  it('fails promptly when the repository lease is held', async () => {
    const lock = path.join(repo, '.git', 'juno-repository-writer.lock');
    const holder = spawn('python3', ['-c', 'import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(10)', lock], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    const result = run(repo, 'plan');
    holder.kill();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('lease busy');
  });

  it('accepts valid agent grouping while deterministic code owns commits', async () => {
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'one.md'), 'agent grouped\n');
    const command = path.join(testDir, 'agent-ok.py');
    await fs.writeFile(command, `#!/usr/bin/env python3\nimport json\nprint(json.dumps({"schema_version":"juno_controller_checkpoint_agent.v1","groups":[{"paths":[".juno_task/tasks/one.md"],"message":"chore(controller): grouped fixture"}]}))\n`);
    await fs.chmod(command, 0o755);
    const result = spawnSync('python3', [helper, '--root', repo, 'commit', '--agent', '--json'], { encoding: 'utf8', env: { ...process.env, JUNO_CHECKPOINT_AGENT_COMMAND: command } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe('committed');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(controller): grouped fixture');
  });

  it('rejects an agent that mutates the frozen repository state', async () => {
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'one.md'), 'before agent\n');
    const command = path.join(testDir, 'agent-mutate.py');
    await fs.writeFile(command, `#!/usr/bin/env python3\nimport json, pathlib\npathlib.Path('.juno_task/tasks/one.md').write_text('mutated by agent\\n')\nprint(json.dumps({"schema_version":"juno_controller_checkpoint_agent.v1","groups":[{"paths":[".juno_task/tasks/one.md"],"message":"bad"}]}))\n`);
    await fs.chmod(command, 0o755);
    const result = spawnSync('python3', [helper, '--root', repo, 'commit', '--agent'], { encoding: 'utf8', env: { ...process.env, JUNO_CHECKPOINT_AGENT_COMMAND: command } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('content changed');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('rejects invalid, incomplete, timed-out, or mutating agent proposals', async () => {
    await fs.writeFile(path.join(repo, '.juno_task', 'tasks', 'one.md'), 'agent\n');
    const command = path.join(testDir, 'agent.py');
    await fs.writeFile(command, '#!/usr/bin/env python3\nprint("not json")\n');
    await fs.chmod(command, 0o755);
    let result = spawnSync('python3', [helper, '--root', repo, 'commit', '--agent'], { encoding: 'utf8', env: { ...process.env, JUNO_CHECKPOINT_AGENT_COMMAND: command } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('agent proposal');
    await fs.writeFile(command, `#!/usr/bin/env python3\nimport json\nprint(json.dumps({"schema_version":"juno_controller_checkpoint_agent.v1","groups":[]}))\n`);
    result = spawnSync('python3', [helper, '--root', repo, 'commit', '--agent'], { encoding: 'utf8', env: { ...process.env, JUNO_CHECKPOINT_AGENT_COMMAND: command } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('exactly once');
    await fs.writeFile(command, '#!/usr/bin/env python3\nimport time\ntime.sleep(2)\n');
    await fs.writeJson(path.join(repo, '.juno_task', 'config.json'), { gitCheckpoint: { agent: { timeoutSeconds: 1 } } });
    git(repo, 'add', '.juno_task/config.json');
    git(repo, 'commit', '-m', 'configure timeout', '--', '.juno_task/config.json');
    result = spawnSync('python3', [helper, '--root', repo, 'commit', '--agent'], { encoding: 'utf8', env: { ...process.env, JUNO_CHECKPOINT_AGENT_COMMAND: command } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('timed out');
  });

  it('wires checkpoints only at outer finalizers and requires pre-integration ordering', async () => {
    const main = await fs.readFile(path.resolve(process.cwd(), 'src/cli/commands/main.ts'), 'utf8');
    expect(main.indexOf('clearContinueScopeRunning')).toBeLessThan(main.lastIndexOf('checkpointControllerAfterFinalization'));
    const workflow = await fs.readFile(path.resolve(process.cwd(), 'src/templates/scripts/workflow_runner.sh'), 'utf8');
    expect(workflow).toContain('checkpoint_after_finalization(exit_code, "workflow")');
    expect(workflow).toContain('integration_command_text.index("--checkpoint-controller")');
    const parallel = await fs.readFile(path.resolve(process.cwd(), 'src/templates/scripts/parallel_runner.sh'), 'utf8');
    expect(parallel).toContain('finally:\n        # main returns only after task/session summaries');
    const preflight = await fs.readFile(path.resolve(process.cwd(), 'src/templates/scripts/integration_owner_preflight.py'), 'utf8');
    expect(preflight.indexOf('require-clean", "--checkpoint"')).toBeLessThan(preflight.indexOf('initial = [repository_snapshot'));
  });
});
