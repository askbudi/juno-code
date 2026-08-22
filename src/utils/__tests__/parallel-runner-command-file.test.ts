import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd(), '..');
const templateScript = path.resolve(process.cwd(), 'src/templates/scripts/parallel_runner.sh');
const runtimeScript = path.resolve(repoRoot, '.juno_task/scripts/parallel_runner.sh');
let parallelFixtureController: string | undefined;

function runParallelScript(scriptPath: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  if (!parallelFixtureController) throw new Error('parallel subprocess fixture controller is not initialized');
  return spawnSync('python3', [scriptPath, ...args], {
    input,
    cwd: parallelFixtureController,
    encoding: 'utf8',
    env: {
      ...process.env,
      JUNO_TASK_ROOT: parallelFixtureController,
      JUNO_WORKSPACE_ROLE: 'controller',
      JUNO_WORKSPACE_ENFORCEMENT: 'strict',
      YYLO_SESSION_METADATA_DIRECTORY: path.join(parallelFixtureController, '.test-metadata'),
      PYTHONPATH: path.resolve(process.cwd(), 'src/templates/scripts'),
      ...env,
    },
  });
}

function runParallel(args: string[], input?: string) {
  return runParallelScript(templateScript, args, input);
}

describe('parallel_runner.sh command file foundation', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-runner-commands-test-'));
    parallelFixtureController = path.join(testDir, 'controller');
    const scripts = path.join(parallelFixtureController, '.juno_task', 'scripts');
    const bin = path.join(parallelFixtureController, '.venv_juno', 'bin');
    await fs.ensureDir(scripts);
    await fs.ensureDir(bin);
    await fs.copyFile(
      path.resolve(process.cwd(), 'src/templates/scripts/controller_resolver.py'),
      path.join(scripts, 'controller_resolver.py'),
    );
    const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
    await fs.symlink(python, path.join(bin, 'python'));
    spawnSync('git', ['init', '-b', 'fixture-controller'], { cwd: parallelFixtureController, encoding: 'utf8' });
  });

  afterEach(async () => {
    parallelFixtureController = undefined;
    await fs.remove(testDir);
  });

  it('keeps the template and runtime scripts synchronized', async () => {
    expect(await fs.pathExists(templateScript)).toBe(true);
    expect(await fs.pathExists(runtimeScript)).toBe(true);
    expect(await fs.readFile(templateScript, 'utf8')).toBe(await fs.readFile(runtimeScript, 'utf8'));
  });

  it('warns when a runtime copy differs from the installed parallel template', async () => {
    const templateDir = path.join(testDir, 'templates');
    const staleScript = path.join(testDir, 'parallel_runner.sh');
    await fs.ensureDir(templateDir);
    await fs.copyFile(templateScript, path.join(templateDir, 'parallel_runner.sh'));
    await fs.writeFile(staleScript, `${await fs.readFile(templateScript, 'utf8')}\n# local stale edit\n`);

    const result = runParallelScript(staleScript, ['--help'], undefined, {
      YYLO_SCRIPT_TEMPLATE_DIR: templateDir,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('parallel_runner.sh: warning: this runtime script differs from the installed yylo template.');
    expect(result.stderr).toContain(`installed template: ${await fs.realpath(path.join(templateDir, 'parallel_runner.sh'))}`);
    expect(result.stderr).toContain('update with: yy scripts update --force');
  });

  it('allows parallel stale-runtime warnings to be disabled', async () => {
    const templateDir = path.join(testDir, 'templates');
    const staleScript = path.join(testDir, 'parallel_runner_skip.sh');
    await fs.ensureDir(templateDir);
    await fs.copyFile(templateScript, path.join(templateDir, 'parallel_runner.sh'));
    await fs.writeFile(staleScript, `${await fs.readFile(templateScript, 'utf8')}\n# local stale edit\n`);

    const result = runParallelScript(staleScript, ['--help'], undefined, {
      YYLO_SCRIPT_TEMPLATE_DIR: templateDir,
      YYLO_SKIP_SCRIPT_STALE_CHECK: '1',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('runtime script differs');
  });

  it('decodes escaped double quotes and doubled YAML single quotes identically', () => {
    const probe = (script: string) => spawnSync('python3', ['-c', `
import importlib.machinery, json
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(script)}).load_module()
print(json.dumps([mod._parse_scalar(r'''"say \\"hello\\""'''), mod._parse_scalar("'owner''s task'")]))
`], { cwd: repoRoot, encoding: 'utf8' });
    for (const script of [templateScript, runtimeScript]) {
      const result = probe(script);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual(['say "hello"', "owner's task"]);
    }
  });

  it('filters continuity from parallel child environments without dropping routing/config', () => {
    const code = `
import importlib.machinery, json, os
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(templateScript)}).load_module()
os.environ['YYLO_LAST_SESSION_ID_SCOPE_0123456789ABCDEF'] = 'historical'
os.environ['YYLO_LAST_EXECUTION_SETTINGS'] = 'legacy'
os.environ['YYLO_LAST_SESSION_ID_SCOPE_malformed_old_suffix'] = 'historical-malformed'
os.environ['JUNO_TASK_ROOT'] = '/controller'
os.environ['ARBITRARY_CONFIG'] = 'preserved'
env = mod._build_process_env({'JUNO_MODEL': 'current'})
print(json.dumps({'continuity': sorted(k for k in env if k.startswith('YYLO_LAST_')), 'root': env.get('JUNO_TASK_ROOT'), 'config': env.get('ARBITRARY_CONFIG'), 'model': env.get('JUNO_MODEL')}))
`;
    for (const script of [templateScript, runtimeScript]) {
      const result = spawnSync('python3', ['-c', code.replace(JSON.stringify(templateScript), JSON.stringify(script))], { cwd: repoRoot, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ continuity: [], root: '/controller', config: 'preserved', model: 'current' });
    }
  });

  it('loads and prints help under PATH python3 without evaluating modern generic annotations', () => {
    const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    expect(python.status).toBe(0);

    const result = runParallel(['--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("'type' object is not subscriptable");
    expect(result.stdout).toContain('Run yylo tasks in parallel');
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
    expect(result.stdout).toContain('--no-attach');
    expect(result.stdout).toContain('attach/follow/wait/stop commands');
    expect(result.stdout).toContain('--tmux-handoff');
    expect(result.stdout).toContain('--max-panes-per-session');
    expect(result.stdout).toContain('tabs');
    expect(result.stdout).toContain('one dedicated window/tab per task');
    expect(result.stdout).toContain('dedicates one worker pane/window');
    expect(result.stdout).toContain('per task and never reuses completed workers');
  });

  it('parses tmux tabs as a dedicated window-per-task mode without starting tmux', () => {
    const code = `
import importlib.machinery, json, sys
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(templateScript)}).load_module()
sys.argv = ['parallel_runner.sh', '--tmux', 'tabs', '--items', 'a', 'b', '--prompt', 'Analyze {{item}}']
args = mod.parse_args()
print(json.dumps({'tmux': args.tmux, 'parallel': args.parallel, 'tmux_handoff': args.tmux_handoff, 'tasks': args.kanban}))
`;
    const result = spawnSync('python3', ['-c', code], { cwd: repoRoot, encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      tmux: 'tabs',
      parallel: 2,
      tmux_handoff: true,
      tasks: ['item-001', 'item-002'],
    });
  });

  it('parses --no-attach only for tmux launches', () => {
    const code = `
import importlib.machinery, json, sys
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(templateScript)}).load_module()
sys.argv = ['parallel_runner.sh', '--tmux', 'tabs', '--no-attach', '--items', 'a', '--prompt', 'Analyze {{item}}']
args = mod.parse_args()
print(json.dumps({'tmux': args.tmux, 'no_attach': args.no_attach}))
`;
    const parsed = spawnSync('python3', ['-c', code], { cwd: repoRoot, encoding: 'utf-8' });

    expect(parsed.status).toBe(0);
    expect(JSON.parse(parsed.stdout.trim())).toEqual({ tmux: 'tabs', no_attach: true });

    const headless = runParallel(['--no-attach', '--items', 'a', '--prompt', 'Analyze {{item}}']);
    expect(headless.status).toBe(2);
    expect(headless.stderr).toContain('--no-attach requires --tmux');
  });

  it('warns non-TTY tmux callers that omit --no-attach', () => {
    const code = `
import importlib.machinery, sys
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(templateScript)}).load_module()
sys.argv = ['parallel_runner.sh', '--tmux', 'tabs', '--items', 'a', '--prompt', 'Analyze {{item}}']
mod.parse_args()
`;
    const result = spawnSync('python3', ['-c', code], { cwd: repoRoot, encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('tmux attach was requested from a non-TTY context');
    expect(result.stderr).toContain('Use --no-attach');
  });

  it('wires --no-attach to detached tmux launch semantics', () => {
    const code = `
import importlib.machinery, json, pathlib, tempfile, types
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(templateScript)}).load_module()
tmp = pathlib.Path(tempfile.mkdtemp())
args = types.SimpleNamespace(
    stop_all=False, stop=False, kanban=['item-001'], tmux='tabs', tmux_handoff=True,
    max_panes_per_session=None, no_attach=True, subagent_args_list=[], name='detached-test',
)
mod.parse_args = lambda: args
mod.warn_if_runtime_script_is_stale = lambda name: None
mod._resolve_service_model = lambda value: ('pi', None)
mod.resolve_prompt_source = lambda value, pwd: ('inline', 'Analyze {{item}}')
mod._resolve_output_dir = lambda value: None
mod.cleanup_stale_tmp_artifacts = lambda: 0
mod._write_run_status = lambda *values, **kwargs: None
mod._log_base = tmp
captured = {}
def fake_run(*values, **kwargs):
    captured['attach'] = kwargs.get('attach')
mod.run_tmux_mode = fake_run
mod.main()
print(json.dumps(captured))
`;
    const result = spawnSync('python3', ['-c', code], {
      cwd: parallelFixtureController,
      encoding: 'utf-8',
      env: { ...process.env, JUNO_TASK_ROOT: parallelFixtureController },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({ attach: false });
  });

  it('prints concrete attach, follow, wait, and stop commands for detached launches', () => {
    const code = `
import importlib.machinery, pathlib, sys, tempfile
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(templateScript)}).load_module()
run_dir = pathlib.Path(tempfile.mkdtemp()) / 'run artifacts'
mod.LOG_DIR = run_dir
mod.COMBINED_LOG = run_dir / 'parallel_runner.log'
sys.argv = ['/tmp/parallel runner.sh']
mod._print_detached_tmux_commands('pc-my batch', 'my batch')
`;
    const result = spawnSync('python3', ['-c', code], { cwd: repoRoot, encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Attach: tmux attach -t 'pc-my batch'");
    expect(result.stdout).toContain("Follow: tail -f '");
    expect(result.stdout).toContain('parallel_runner.log');
    expect(result.stdout).toContain('Wait:');
    expect(result.stdout).toContain('parallel_runner_wait.sh');
    expect(result.stdout).toContain('--run-dir');
    expect(result.stdout).toContain('--verbose');
    expect(result.stdout).toContain('parallel runner.sh');
    expect(result.stdout).toContain("--stop --name 'my batch'");
  });

  it('sanitizes tmux tab names from task IDs while preserving uniqueness', () => {
    const code = `
import importlib.machinery, json
mod = importlib.machinery.SourceFileLoader('parallel_runner', ${JSON.stringify(templateScript)}).load_module()
used = set(['coordinator'])
names = [mod._tmux_safe_window_name(tid, i, used) for i, tid in enumerate(['ABC123', 'bad:id', 'bad/id', ''])]
print(json.dumps(names))
`;
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(['ABC123', 'bad-id', 'bad-id-2', 'task-4']);
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

  it('propagates canonical controller and isolated metadata roots across command process boundaries', async () => {
    const target = path.join(testDir, 'environment.json');
    const evidence = path.join(testDir, 'environment-evidence.json');
    const metadata = path.join(testDir, 'metadata');
    await fs.writeJson(target, {
      schema_version: 1,
      parallel: 1,
      commands: [{
        id: 'environment',
        command: ['python3', '-c', `import json, os; open(${JSON.stringify(evidence)}, 'w').write(json.dumps({"task_root": os.environ["JUNO_TASK_ROOT"], "metadata": os.environ["YYLO_SESSION_METADATA_DIRECTORY"]}))`],
      }],
    });

    const controller = await fs.realpath(parallelFixtureController!);
    const result = runParallelScript(templateScript, ['--commands-file', target], undefined, {
      JUNO_CONTROLLER_BRANCH: 'fixture-controller',
      YYLO_SESSION_METADATA_DIRECTORY: metadata,
    });
    expect(result.status).toBe(0);
    expect(await fs.readJson(evidence)).toEqual({ task_root: controller, metadata });
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
