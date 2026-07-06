import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd(), '..');
const templateScript = path.resolve(process.cwd(), 'src/templates/scripts/parallel_runner.sh');
const runtimeScript = path.resolve(repoRoot, '.juno_task/scripts/parallel_runner.sh');

function runParallel(args: string[], input?: string) {
  return spawnSync('python3', [templateScript, ...args], {
    input,
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('parallel_runner.sh command file foundation', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-runner-commands-test-'));
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  it('keeps the template and runtime scripts synchronized', async () => {
    expect(await fs.pathExists(templateScript)).toBe(true);
    expect(await fs.pathExists(runtimeScript)).toBe(true);
    expect(await fs.readFile(templateScript, 'utf8')).toBe(await fs.readFile(runtimeScript, 'utf8'));
  });

  it('documents commands file mode, linting, generator, schema, and examples in --help', () => {
    const result = runParallel(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--commands-file');
    expect(result.stdout).toContain('--lint-commands-file');
    expect(result.stdout).toContain('--init-commands-example');
    expect(result.stdout).toContain('Command file schema v1');
    expect(result.stdout).toContain('[A-Za-z0-9_.-]+');
    expect(result.stdout).toContain('command strings are shell commands');
    expect(result.stdout).toContain('--tmux-handoff');
    expect(result.stdout).toContain('--max-panes-per-session');
    expect(result.stdout).toContain('dedicates one worker pane/window');
    expect(result.stdout).toContain('per task and never reuses completed workers');
  });

  it('rejects tmux handoff without tmux before starting a run', () => {
    const result = runParallel(['--tmux-handoff', '--items', 'a', '--prompt', 'Analyze {{item}}']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--tmux-handoff requires --tmux');
  });

  it('rejects max panes per session outside tmux handoff mode', () => {
    const result = runParallel(['--max-panes-per-session', '4', '--items', 'a', '--prompt', 'Analyze {{item}}']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--max-panes-per-session requires --tmux-handoff');
  });

  it('rejects non-positive max panes per session values', () => {
    const result = runParallel(['--tmux', 'panes', '--tmux-handoff', '--max-panes-per-session', '0', '--items', 'a', '--prompt', 'Analyze {{item}}']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--max-panes-per-session must be a positive integer');
  });

  it('rejects tmux handoff when task count exceeds parallelism', () => {
    const result = runParallel([
      '--tmux', 'panes',
      '--tmux-handoff',
      '--items', 'a', 'b',
      '--parallel', '1',
      '--prompt', 'Analyze {{item}}',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--tmux-handoff requires one dedicated worker per task');
    expect(result.stderr).toContain('got 2 task(s) with --parallel 1');
  });

  it('keeps batched handoff parent status running until all child statuses complete', async () => {
    const statusA = path.join(testDir, 'a.status.json');
    const statusB = path.join(testDir, 'b.status.json');
    await fs.writeJson(statusA, { state: 'completed', exit_code: 0, started_at: 's1', finished_at: 'f1' });
    await fs.writeJson(statusB, { state: 'running', exit_code: null, started_at: 's2' });

    const code = `
import importlib.machinery, json, pathlib
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(templateScript)}).load_module()
parent = pathlib.Path(${JSON.stringify(testDir)})
manifest = {'child_sessions': [{'status_path': ${JSON.stringify(statusA)}}, {'status_path': ${JSON.stringify(statusB)}}]}
complete, exit_code = mod._refresh_handoff_manifest_status(parent, manifest)
print(json.dumps({'complete': complete, 'exit_code': exit_code, 'manifest': manifest}, sort_keys=True))
pathlib.Path(${JSON.stringify(statusB)}).write_text(json.dumps({'state': 'completed', 'exit_code': 1, 'started_at': 's2', 'finished_at': 'f2'}))
complete, exit_code = mod._refresh_handoff_manifest_status(parent, manifest)
print(json.dumps({'complete': complete, 'exit_code': exit_code, 'manifest': manifest}, sort_keys=True))
`;
    const result = spawnSync('python3', ['-c', code], { cwd: repoRoot, encoding: 'utf8' });

    expect(result.status).toBe(0);
    const [first, second] = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(first.complete).toBe(false);
    expect(first.exit_code).toBe(0);
    expect(first.manifest.completed_child_sessions).toBe(1);
    expect(second.complete).toBe(true);
    expect(second.exit_code).toBe(1);
    expect(second.manifest.completed_child_sessions).toBe(2);
    expect(second.manifest.failed_child_sessions).toBe(1);
    expect(await fs.pathExists(path.join(testDir, 'tmux_handoff_manifest.json'))).toBe(true);
  });

  it('writes a boilerplate command YAML file, refuses overwrite, and lints it successfully', async () => {
    const target = path.join(testDir, 'commands.yaml');

    const created = runParallel(['--init-commands-example', target]);
    expect(created.status).toBe(0);
    const content = await fs.readFile(target, 'utf8');
    expect(content).toContain('schema_version: 1');
    expect(content).toContain('parallel: 2');
    expect(content).toContain('workflow-a');
    expect(content).toContain('workflow_runner.sh');
    expect(content).toContain('timeout_seconds: 300');

    const lint = runParallel(['--lint-commands-file', target]);
    expect(lint.status).toBe(0);
    expect(lint.stdout).toContain('OK: 3 command(s) valid');

    const refused = runParallel(['--init-commands-example', target]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('refusing to overwrite');

    const forced = runParallel(['--init-commands-example', target, '--force']);
    expect(forced.status).toBe(0);
  });

  it('uses command YAML parallel as a default while explicit CLI --parallel wins', async () => {
    const target = path.join(testDir, 'parallel-default.yaml');
    await fs.writeFile(
      target,
      `schema_version: 1
parallel: 1
commands:
  - id: one
    command: [python3, -c, "print('one')"]
  - id: two
    command: [python3, -c, "print('two')"]
`,
    );

    const yamlDefault = runParallel(['--commands-file', target]);
    expect(yamlDefault.status).toBe(0);
    expect(yamlDefault.stdout).toContain('Parallelism: 1');

    const cliOverride = runParallel(['--commands-file', target, '--parallel', '2']);
    expect(cliOverride.status).toBe(0);
    expect(cliOverride.stdout).toContain('Parallelism: 2');
  });

  it('validates ids, uniqueness, command shape, env shape, and timeout in lint mode', async () => {
    const invalid = path.join(testDir, 'invalid.yaml');
    await fs.writeFile(
      invalid,
      `schema_version: 1
commands:
  - id: bad id
    command: echo hi
`,
    );

    const badId = runParallel(['--lint-commands-file', invalid]);
    expect(badId.status).toBe(2);
    expect(badId.stderr).toContain('unsupported characters');

    await fs.writeFile(
      invalid,
      `schema_version: 1
commands:
  - id: one
    command: []
`,
    );
    const emptyArgv = runParallel(['--lint-commands-file', invalid]);
    expect(emptyArgv.status).toBe(2);
    expect(emptyArgv.stderr).toContain('argv list must be non-empty');

    await fs.writeFile(
      invalid,
      `schema_version: 1
env:
  BAD:
    nested: nope
commands:
  - id: one
    command: echo hi
`,
    );
    const badEnv = runParallel(['--lint-commands-file', invalid]);
    expect(badEnv.status).toBe(2);
    expect(badEnv.stderr).toContain('env value');

    await fs.writeFile(
      invalid,
      `schema_version: 1
commands:
  - id: one
    command: echo hi
    timeout_seconds: 0
`,
    );
    const badTimeout = runParallel(['--lint-commands-file', invalid]);
    expect(badTimeout.status).toBe(2);
    expect(badTimeout.stderr).toContain('timeout_seconds must be positive');
  });

  it('accepts command YAML from stdin for linting', () => {
    const result = runParallel(
      ['--lint-commands-file', '-'],
      `schema_version: 1
commands:
  - id: stdin-command
    command:
      - echo
      - ok
`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: 1 command(s) valid in -');
  });
});
