import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repoRoot = path.resolve(process.cwd(), '..');
const templateScript = path.resolve(process.cwd(), 'src/templates/scripts/workflow_runner.sh');
const runtimeScript = path.resolve(repoRoot, '.juno_task/scripts/workflow_runner.sh');
const WORKFLOW_CHILD_TIMEOUT_MS = 30_000;

// This process-heavy file runs real Python/Git subprocesses. Keep the larger
// budget file-scoped while every child remains independently bounded above.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });
afterAll(() => vi.resetConfig());

function runWorkflowScript(scriptPath: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  return spawnSync('python3', [scriptPath, ...args], {
    input,
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: WORKFLOW_CHILD_TIMEOUT_MS,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function runWorkflow(args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  return runWorkflowScript(templateScript, args, input, env);
}

const fakeScopeResolver = `
def resolve_scope(parent_pid, cwd):
    override = os.environ.get('JUNO_CODE_CONTINUE_SCOPE', '').strip()
    if override:
        descriptor = 'JUNO_CODE_CONTINUE_SCOPE:' + override
    else:
        project = str(pathlib.Path(cwd).resolve())
        marker = next((f'{key}:{os.environ[key].strip()}' for key in ['TMUX_PANE','WEZTERM_PANE','KITTY_WINDOW_ID','KITTY_PID','TERM_SESSION_ID','WT_SESSION','ZELLIJ_PANE_ID','STY','WINDOWID','SSH_TTY'] if os.environ.get(key, '').strip()), None)
        if marker:
            descriptor = '\\n'.join(['PROJECT:' + project, 'STABLE_TERMINAL:' + marker])
        else:
            lineage, current = [], parent_pid
            for _ in range(8):
                if not current or current <= 0 or current in lineage: break
                lineage.append(current)
                try:
                    out = subprocess.run(['ps', '-o', 'ppid=', '-p', str(current)], text=True, capture_output=True, timeout=0.5, check=False).stdout.strip()
                    current = int(out) if out else 0
                except Exception: current = 0
            descriptor = '\\n'.join(['PROJECT:' + project, 'SHELL_LINEAGE:' + ('>'.join(map(str, lineage)) if lineage else str(parent_pid))])
    digest = hashlib.sha256(descriptor.encode()).hexdigest()[:16].upper()
    scope = 'SCOPE_' + digest
    return scope

def continuity_path():
    root = pathlib.Path(os.environ.get('JUNO_CODE_SESSION_METADATA_DIRECTORY', pathlib.Path.cwd() / '.juno_task'))
    root.mkdir(parents=True, exist_ok=True)
    return root / 'session_continuity.v2.json'

def persist_scope(scope, session_id, settings):
    state_path = continuity_path()
    try: document = json.loads(state_path.read_text())
    except Exception: document = {'version': 2, 'scopes': {}}
    now = '2026-07-30T00:00:00.000Z'
    previous = document.setdefault('scopes', {}).get(scope, {})
    document['scopes'][scope] = {'source':'test','createdAt':previous.get('createdAt', now),'lastUsedAt':now,'pinned':False,'settings':settings,'active':'main','branches':{'main':{'session_id':session_id,'parent':None,'updated_at':now}}}
    state_path.write_text(json.dumps(document))

def handle_scope_command():
    if len(sys.argv) < 2 or sys.argv[1] != 'continue-scope': return False
    cwd = sys.argv[sys.argv.index('--cwd') + 1]
    parent_pid = int(sys.argv[sys.argv.index('--parent-pid') + 1])
    scope = resolve_scope(parent_pid, cwd)
    if '--handoff-session' in sys.argv:
        session_id = sys.argv[sys.argv.index('--handoff-session') + 1]
        settings = json.loads(sys.argv[sys.argv.index('--handoff-settings') + 1])
        persist_scope(scope, session_id, settings)
    try:
        document = json.loads(continuity_path().read_text())
        scopes = document.get('scopes', {})
        entry = scopes.get(scope, {})
        if not entry and len(scopes) == 1: entry = next(iter(scopes.values()))
        session_id = entry.get('branches', {}).get(entry.get('active'), {}).get('session_id')
    except Exception: session_id = None
    print(json.dumps({'status':'finished' if session_id else 'not_found','hash':scope[6:12],'fullHash':scope,'scopeSource':'test','sessionEnvKey':'JUNO_CODE_LAST_SESSION_ID_' + scope,'settingsEnvKey':'JUNO_CODE_LAST_EXECUTION_SETTINGS_' + scope,'sessionId':session_id,'isCurrentScope':True,'pid':None}))
    return True
`;

async function installFakeJunoExecutable(dir: string, name = 'yy') {
  const binDir = path.join(dir, 'bin');
  await fs.ensureDir(binDir);
  const executablePath = path.join(binDir, name);
  await fs.writeFile(
    executablePath,
    `#!/usr/bin/env python3
import hashlib, json, os, pathlib, subprocess, sys
${fakeScopeResolver}
if handle_scope_command(): raise SystemExit(0)
if len(sys.argv) > 1 and sys.argv[1] == '--quiet': sys.argv.pop(1)
prompt = sys.argv[3] if len(sys.argv) > 3 else sys.argv[2]
print(f"tool={os.environ.get('JUNO_TOOL_ID', 'unset')} capture={os.environ.get('JUNO_SUBAGENT_CAPTURE_PATH', 'unset')}")
capture = os.environ.get('JUNO_SUBAGENT_CAPTURE_PATH')
if capture:
    pathlib.Path(capture).write_text('{invalid json' if prompt == 'invalid' else json.dumps({'type':'result','subtype':'success','is_error':False,'result':'captured ' + prompt,'session_id':'session-' + prompt}) + '\\n')
if prompt != 'invalid': persist_scope(resolve_scope(os.getppid(), pathlib.Path.cwd()), 'session-' + prompt, {'version':1,'subagent':'pi'})
if prompt == 'fail': raise SystemExit(7)
`,
  );
  await fs.chmod(executablePath, 0o755);
  return { binDir, executablePath };
}

async function installFakeChildEvidenceProducer(dir: string) {
  const script = path.join(dir, 'integration_owner_preflight.py');
  await fs.writeFile(script, `#!/usr/bin/env python3
import datetime, hashlib, json, os, pathlib
root = pathlib.Path(os.environ['JUNO_WORKFLOW_CHILD_EVIDENCE_DIR'])
root.mkdir(parents=True, exist_ok=True)
def put(name, value):
    path = root / name
    path.write_text(value, encoding='utf-8')
    return {'path': str(path.resolve()), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
stdout = put('stdout.txt', 'child log\\n')
stderr = put('stderr.txt', '')
response = put('response.txt', 'actual target accepted\\n')
capture = put('capture.json', json.dumps({'session_id':'child-session-1','result':'actual target accepted'}) + '\\n')
receipt_path = root / 'actual-review.json'
receipt_path.write_text(json.dumps({'reviewed_tip':'a' * 40, 'passed':True}) + '\\n', encoding='utf-8')
receipt = {'path': str(receipt_path.resolve()), 'sha256': hashlib.sha256(receipt_path.read_bytes()).hexdigest()}
now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
event = {
 'schema_version':'juno_workflow_child_step.v1', 'child_id':'actual_target_review',
 'role':'actual_target_review', 'parent_workflow_id':os.environ['JUNO_WORKFLOW_ID'],
 'parent_run_id':os.environ['JUNO_WORKFLOW_RUN_ID'], 'parent_step_id':os.environ['JUNO_WORKFLOW_STEP_ID'],
 'parent_step_digest':os.environ['JUNO_WORKFLOW_STEP_DIGEST'], 'invocation_mode':'fresh_session',
 'rendered_command_sha256':hashlib.sha256(b'yy pi review').hexdigest(),
 'rendered_argv_sha256':hashlib.sha256(b'argv').hexdigest(),
 'rendered_prompt_sha256':hashlib.sha256(b'review').hexdigest(), 'started_at':now,
 'completed_at':now, 'duration_seconds':0.01, 'exit_code':0, 'transport_status':'success',
 'semantic_outcome':'accepted', 'session_id':'child-session-1', 'reviewed_target_sha':'a' * 40,
 'artifacts':{'stdout':stdout,'stderr':stderr,'response':response,'capture':capture,'review_receipt':receipt}
}
(root / 'actual_target_review.event.json').write_text(json.dumps(event, sort_keys=True) + '\\n', encoding='utf-8')
print('parent complete')
`);
  await fs.chmod(script, 0o755);
  return script;
}

async function installFakeTopLevelPersistingJuno(dir: string, name = 'yy') {
  const binDir = path.join(dir, 'bin');
  await fs.ensureDir(binDir);
  const executablePath = path.join(binDir, name);
  await fs.writeFile(
    executablePath,
    `#!/usr/bin/env python3
import hashlib, json, os, pathlib, subprocess, sys
${fakeScopeResolver}
if handle_scope_command(): raise SystemExit(0)
prompt = sys.argv[-1] if len(sys.argv) > 1 else 'empty'
scope = resolve_scope(os.getppid(), pathlib.Path.cwd())
persist_scope(scope, 'session-' + prompt, {'version': 1, 'subagent': 'pi'})
print('FINAL ' + prompt)
print('Session ID(s):')
print('  session-' + prompt)
`,
  );
  await fs.chmod(executablePath, 0o755);
  return { binDir, executablePath };
}

describe('workflow_runner.sh template script', () => {
  it('filters continuity from workflow child environments without dropping routing/config', () => {
    for (const script of [templateScript, runtimeScript]) {
      const code = `
import importlib.machinery, json
mod = importlib.machinery.SourceFileLoader('workflow_runner', ${JSON.stringify(script)}).load_module()
env = mod.child_process_environment({
  'JUNO_CODE_LAST_SESSION_ID_SCOPE_0123456789ABCDEF': 'historical',
  'JUNO_CODE_LAST_SESSION_ID_SCOPE_malformed_old_suffix': 'historical-malformed',
  'JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_': 'historical-empty-suffix',
  'JUNO_CODE_LAST_EXECUTION_SETTINGS': 'legacy',
  'JUNO_TASK_ROOT': '/controller',
  'ARBITRARY_CONFIG': 'preserved',
})
print(json.dumps({'continuity': sorted(k for k in env if k.startswith('JUNO_CODE_LAST_')), 'root': env.get('JUNO_TASK_ROOT'), 'config': env.get('ARBITRARY_CONFIG')}))
`;
      const result = spawnSync('python3', ['-c', code], { cwd: repoRoot, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ continuity: [], root: '/controller', config: 'preserved' });
    }
  });
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-runner-test-'));
  }, 30_000);

  afterEach(async () => {
    await fs.remove(testDir);
  }, 30_000);

  it('exists in template scripts and remains synced with runtime script', async () => {
    expect(await fs.pathExists(templateScript)).toBe(true);
    expect(await fs.pathExists(runtimeScript)).toBe(true);
    const templateContent = await fs.readFile(templateScript, 'utf8');
    expect(templateContent).toBe(await fs.readFile(runtimeScript, 'utf8'));
    expect(templateContent).not.toContain('_dt.UTC');
    expect(templateContent).not.toContain('def canonicalize_working_directory');
    expect(templateContent).not.toContain('def resolve_parent_pid');
    expect(templateContent).not.toContain('def build_parent_shell_lineage');
    expect(templateContent).not.toContain('def collect_terminal_scope_markers');
    expect(templateContent).not.toContain('def resolve_continue_scope_context');
    expect(templateContent).toContain('continue-scope');
    expect(templateContent).toContain('--parent-pid');
    expect(templateContent).toContain('directly executed argv-list');
    expect(templateContent).toContain('--candidate-receipt');
    expect(templateContent).toContain('--risk-tier');
    expect(templateContent).toContain('detach_same_sha');
    expect(templateContent).toContain('feature_tag_policy');
    expect(templateContent).toContain('git_common_dir_and_target_ref');
    expect(templateContent).toContain('rebuild_and_rereview');
    expect(templateContent).toContain('local_integration requires schema_version: 2');
    expect(templateContent).toContain('required_fields must include producer_step_digest');
    expect(templateContent).not.toContain('--checkpoint-controller');
  });

  it('accepts the candidate/CAS local-integration contract and rejects the retired checkpoint shape', async () => {
    const workflowPath = path.join(testDir, 'local-integration.json');
    const workflow: any = {
      schema_version: 2,
      workflow_id: 'local_integration_contract',
      workflow_class: 'local_integration',
      risk_tier: 'high',
      integration_step: 'integrate',
      terminal_gate: 'integrate',
      integration_policy: {
        queue: 'automatic_after_review_pass',
        channel_scope: 'git_common_dir_and_target_ref',
        target_movement: 'rebuild_and_rereview',
        checked_out_target: 'detach_same_sha',
      },
      validation_ownership: {
        pre_merge_review: 'pre_merge_review',
        candidate_review: 'candidate_review',
        actual_target_review: 'integrate',
      },
      receipts: [
        {
          id: 'integration',
          producer: 'integrate',
          path: 'integration.json',
          schema_version: 'juno_local_integration.v3',
          required_fields: ['producer_step_digest', 'outcome', 'feature_tag_policy'],
          expected_fields: { outcome: 'integrated' },
        },
      ],
      steps: [
        { id: 'pre_merge_review', command: ['yy', 'pi', 'Review the exact task tip.'] },
        { id: 'candidate_review', command: 'true' },
        {
          id: 'integrate',
          command: [
            'python3',
            '.juno_task/scripts/integration_owner_preflight.py',
            'integrate',
            '--candidate-receipt',
            'candidate.json',
            '--risk-tier',
            'high',
            '--checked-out-target',
            'detach_same_sha',
            '--actual-review-command',
            'yy pi review',
            '--actual-review-receipt',
            'actual.json',
          ],
        },
      ],
    };
    await fs.writeJson(workflowPath, workflow);

    const accepted = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(accepted.status).toBe(0);

    workflow.steps[0].command = ['yy', 'pi', '--resume', 'old-session', 'Review again.'];
    await fs.writeJson(workflowPath, workflow);
    const resumedReview = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(resumedReview.status).not.toBe(0);
    expect(resumedReview.stderr).toMatch(/fresh session without resume/);
    workflow.steps[0].command = ['yy', 'pi', 'Review the exact task tip.'];

    workflow.steps[2].command =
      'python3 .juno_task/scripts/integration_owner_preflight.py --checkpoint-controller --exec-command integrate.sh';
    await fs.writeJson(workflowPath, workflow);
    const retired = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(retired.status).not.toBe(0);
    expect(retired.stderr).toMatch(/directly executed argv-list/);

    workflow.steps[2].command =
      'python3 .juno_task/scripts/integration_owner_preflight.py integrate --candidate-receipt candidate.json --risk-tier high --checked-out-target detach_same_sha --actual-review-command "yy pi review" --actual-review-receipt actual.json';
    await fs.writeJson(workflowPath, workflow);
    const shellOwner = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(shellOwner.status).not.toBe(0);
    expect(shellOwner.stderr).toMatch(/directly executed argv-list/);

    workflow.steps[2].command = [
      'python3', '.juno_task/scripts/integration_owner_preflight.py', 'integrate',
      '--candidate-receipt', 'candidate.json', '--risk-tier', 'high',
      '--checked-out-target', 'detach_same_sha', '--actual-review-command', 'yy pi review',
      '--actual-review-receipt', 'actual.json',
    ];
    workflow.schema_version = 1;
    await fs.writeJson(workflowPath, workflow);
    const legacySchema = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(legacySchema.status).not.toBe(0);
    expect(legacySchema.stderr).toMatch(/schema_version: 2; migration required/);

    workflow.schema_version = 2;
    workflow.receipts[0].required_fields = ['step_digest', 'outcome', 'feature_tag_policy'];
    await fs.writeJson(workflowPath, workflow);
    const undeclaredProducerDigest = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(undeclaredProducerDigest.status).not.toBe(0);
    expect(undeclaredProducerDigest.stderr).toMatch(/must include producer_step_digest/);
  }, 120_000);

  it('warns when a runtime copy differs from the installed workflow template', async () => {
    const templateDir = path.join(testDir, 'templates');
    const staleScript = path.join(testDir, 'workflow_runner.sh');
    await fs.ensureDir(templateDir);
    await fs.copyFile(templateScript, path.join(templateDir, 'workflow_runner.sh'));
    await fs.copyFile(
      path.resolve(process.cwd(), 'src/templates/scripts/workflow_run_evidence.py'),
      path.join(testDir, 'workflow_run_evidence.py'),
    );
    await fs.writeFile(staleScript, `${await fs.readFile(templateScript, 'utf8')}\n# local stale edit\n`);

    const result = runWorkflowScript(staleScript, ['--help'], undefined, {
      JUNO_CODE_SCRIPT_TEMPLATE_DIR: templateDir,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('workflow_runner.sh: warning: this runtime script differs from the installed juno-code template.');
    expect(result.stderr).toContain(`installed template: ${await fs.realpath(path.join(templateDir, 'workflow_runner.sh'))}`);
    expect(result.stderr).toContain('update with: yy scripts update --force');
  });

  it('selects the controller .venv_juno runtime like the Kanban launcher', async () => {
    const workflowPath = path.join(testDir, 'runtime-check.json');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'runtime_check',
      steps: [{ id: 'noop', command: ['printf', 'ok'] }],
    });

    const result = runWorkflow(['lint', '--workflow', workflowPath], undefined, {
      JUNO_DEBUG: 'true',
      VIRTUAL_ENV: '',
    });

    expect(result.status).toBe(0);
    const controllerRoot = process.env.JUNO_TASK_ROOT ? path.resolve(process.env.JUNO_TASK_ROOT) : repoRoot;
    expect(result.stderr).toContain(
      `[DEBUG] workflow_runner.sh Python runtime: ${path.join(controllerRoot, '.venv_juno', 'bin', 'python')}`,
    );
  });

  it('provisions a missing controller venv and preserves activation, argv, and stdin across re-exec', async () => {
    const controller = path.join(testDir, 'controller');
    const scriptsDir = path.join(controller, '.juno_task', 'scripts');
    const installerLog = path.join(testDir, 'installer.log');
    await fs.ensureDir(scriptsDir);
    await fs.writeFile(
      path.join(scriptsDir, 'install_requirements.sh'),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$PWD" == "$EXPECTED_CONTROLLER" ]]
if IFS= read -r unexpected; then
  echo "installer consumed stdin: $unexpected" >&2
  exit 41
fi
mkdir -p .venv_juno/bin
cp "$REAL_PYTHON" .venv_juno/bin/python
chmod +x .venv_juno/bin/python
printf '%s\n' "$PWD" > "$INSTALLER_LOG"
`,
      { mode: 0o755 },
    );

    const harness = `
import importlib.machinery, importlib.util, json, os, pathlib, sys
script, controller = sys.argv[1:]
loader = importlib.machinery.SourceFileLoader("workflow_runner_under_test", script)
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
os.environ["VIRTUAL_ENV"] = "/foreign/project/.venv_juno"
os.environ["PYTHONHOME"] = "/foreign/python-home"
os.environ["PATH"] = "/foreign/project/.venv_juno/bin:" + os.environ.get("PATH", "")
module.sys.argv = [script, "lint", "--workflow", "-"]
def capture_exec(executable, argv, env):
    print(json.dumps({
        "executable": executable,
        "argv": argv,
        "virtual_env": env.get("VIRTUAL_ENV"),
        "path_head": env.get("PATH", "").split(os.pathsep)[0],
        "has_pythonhome": "PYTHONHOME" in env,
        "stdin": sys.stdin.read(),
    }))
    raise SystemExit(0)
module.os.execve = capture_exec
module.ensure_controller_python_environment({"JUNO_TASK_ROOT": controller, "JUNO_CONTROLLER_SOURCE": "test"})
`;
    const input = 'schema_version: 1\nworkflow_id: stdin-preserved\n';
    const result = spawnSync('python3', ['-c', harness, templateScript, controller], {
      cwd: repoRoot,
      input,
      encoding: 'utf8',
      timeout: WORKFLOW_CHILD_TIMEOUT_MS,
      env: {
        ...process.env,
        EXPECTED_CONTROLLER: controller,
        INSTALLER_LOG: installerLog,
        REAL_PYTHON: spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim(),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    const canonicalController = await fs.realpath(controller);
    const expectedVenv = path.join(canonicalController, '.venv_juno');
    expect(await fs.readFile(installerLog, 'utf8')).toBe(`${canonicalController}\n`);
    expect(payload.executable).toBe(path.join(expectedVenv, 'bin', 'python'));
    expect(payload.argv).toEqual([
      path.join(expectedVenv, 'bin', 'python'),
      await fs.realpath(templateScript),
      'lint',
      '--workflow',
      '-',
    ]);
    expect(payload.virtual_env).toBe(expectedVenv);
    expect(payload.path_head).toBe(path.join(expectedVenv, 'bin'));
    expect(payload.has_pythonhome).toBe(false);
    expect(payload.stdin).toBe(input);
  });

  it('allows workflow stale-runtime warnings to be disabled', async () => {
    const templateDir = path.join(testDir, 'templates');
    const staleScript = path.join(testDir, 'workflow_runner_skip.sh');
    await fs.ensureDir(templateDir);
    await fs.copyFile(templateScript, path.join(templateDir, 'workflow_runner.sh'));
    await fs.copyFile(
      path.resolve(process.cwd(), 'src/templates/scripts/workflow_run_evidence.py'),
      path.join(testDir, 'workflow_run_evidence.py'),
    );
    await fs.writeFile(staleScript, `${await fs.readFile(templateScript, 'utf8')}\n# local stale edit\n`);

    const result = runWorkflowScript(staleScript, ['--help'], undefined, {
      JUNO_CODE_SCRIPT_TEMPLATE_DIR: templateDir,
      JUNO_CODE_SKIP_SCRIPT_STALE_CHECK: '1',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('runtime script differs');
  });

  it('documents workflow options, failure policy, and auto capture behavior in --help', () => {
    const result = runWorkflow(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--workflow');
    expect(result.stdout).toContain("'-' to read from stdin");
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('--from-step');
    expect(result.stdout).toContain('--var NAME=VALUE');
    expect(result.stdout).toContain('--run-root');
    expect(result.stdout).toContain('--print-output');
    expect(result.stdout).toContain('summary, none, <step_id>, or');
    expect(result.stdout).toContain('step:<step_id>');
    expect(result.stdout).toContain('--print-step-stdout');
    expect(result.stdout).toContain('--no-print-step-stdout');
    expect(result.stdout).toContain('--tmux');
    expect(result.stdout).toContain('--tmux-session');
    expect(result.stdout).toContain('--init-example NAME PATH');
    expect(result.stdout).toContain('production-triage-handoff');
    expect(result.stdout).toContain('parallel-kanban-review');
    expect(result.stdout).toContain('workflow_runner.sh lint --workflow WORKFLOW.yaml');
    expect(result.stdout).toContain('workflow_runner.sh doctor RUN_DIR');
    expect(result.stdout).toContain('workflow_runner.sh recover-attempt RUN_DIR');
    expect(result.stdout).toContain('detached observer only; the producer remains');
    expect(result.stdout).toContain('attached to this foreground command');
    expect(result.stdout).toContain('fail_workflow: true');
    expect(result.stdout).toContain('juno-code, yy, and ypl');
    expect(result.stdout).toContain('capture_session: false');
    expect(result.stdout).toContain('does not inject --quiet');
    expect(result.stdout).toContain('empty response');
  });

  it('provides dedicated help for lint and doctor helper commands', () => {
    const lintHelp = runWorkflow(['lint', '--help']);
    expect(lintHelp.status).toBe(0);
    expect(lintHelp.stdout).toContain('Lint workflow YAML');
    expect(lintHelp.stdout).toContain('steps.<id>.response');

    const doctorHelp = runWorkflow(['doctor', '--help']);
    expect(doctorHelp.status).toBe(0);
    expect(doctorHelp.stdout).toContain('Inspect a workflow run directory');
    expect(doctorHelp.stdout).toContain('workflow_runner.sh dr');
  });

  it('fallback-parses literal blocks in command and summary.command lists', async () => {
    const workflowPath = path.join(testDir, 'literal-command-lists.yaml');
    await fs.writeFile(
      workflowPath,
      `schema_version: 1
workflow_id: literal_command_lists
steps:
  - id: multiline
    command:
      - printf
      - |
        first line
        second line
summary:
  command:
    - printf
    - |
      summary line one
      summary line two
`,
    );

    const result = runWorkflow(['lint', '--workflow', workflowPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: no issues found');
  });

  it('lints workflow YAML for noisy agent stdout/stderr template usage', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    const workflowPath = path.join(testDir, 'lint-me.yaml');
    await fs.writeFile(
      workflowPath,
      `schema_version: 1
workflow_id: lint_me
steps:
  - id: agent
    command:
      - ${JSON.stringify(executablePath)}
      - pi
      - prompt
  - id: summarize
    command: |
      printf '{{ steps.agent.stdout }} {{ steps.agent.stderr }}'
summary: |
  Agent stdout: {{ steps.agent.stdout }}
  Agent stderr: {{ steps.agent.stderr }}
`,
    );

    const result = runWorkflow(['lint', '--workflow', workflowPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('AGENT_STDOUT_TEMPLATE');
    expect(result.stdout).toContain('NOISY_STEP_STDERR_TEMPLATE');
    expect(result.stdout).toContain('use steps.agent.response');
  });

  it('doctors workflow run artifacts for empty successful agent responses and quiet argv', async () => {
    const runDir = path.join(testDir, 'run');
    await fs.ensureDir(runDir);
    const responsePath = path.join(runDir, '001_agent.response.txt');
    const stdoutPath = path.join(runDir, '001_agent.stdout.txt');
    const stderrPath = path.join(runDir, '001_agent.stderr.txt');
    await fs.writeFile(responsePath, '');
    await fs.writeFile(stdoutPath, '');
    await fs.writeFile(stderrPath, 'logs only\n');
    await fs.writeJson(path.join(runDir, 'manifest.json'), {
      steps: [
        {
          id: 'agent',
          command: ['yy', '--quiet', 'pi', 'prompt'],
          status: 'success',
          response_path: responsePath,
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        },
      ],
    });

    const result = runWorkflow(['dr', runDir]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('EMPTY_SUCCESS_AGENT_RESPONSE');
    expect(result.stdout).toContain('AGENT_QUIET_ARG');
    expect(result.stdout).toContain('SUCCESS_STDERR_ARTIFACT');
  });

  it('writes named example workflows on demand and refuses accidental overwrite', async () => {
    const target = path.join(testDir, 'agent_chain.yaml');

    const first = runWorkflow(['--init-example', 'agent-chain', target]);
    expect(first.status).toBe(0);
    const content = await fs.readFile(target, 'utf8');
    expect(content).toContain('workflow_id: example_agent_chain');
    expect(content).toContain('{{ steps.first_agent.session_id }}');
    expect(content).toContain('- yy');
    expect(content).toContain('- --resume');

    const second = runWorkflow(['--init-example', 'agent-chain', target]);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain('refusing to overwrite');

    const forced = runWorkflow(['--init-example', 'command-pipeline', target, '--force']);
    expect(forced.status).toBe(0);
    expect(await fs.readFile(target, 'utf8')).toContain('workflow_id: example_command_pipeline');
  });

  it('provides all approved boilerplate example names without auto-installing workflows', async () => {
    for (const name of ['agent-chain', 'command-pipeline', 'daily-ops', 'production-triage-handoff', 'parallel-kanban-review']) {
      const target = path.join(testDir, `${name}.yaml`);
      const result = runWorkflow(['--init-example', name, target]);
      expect(result.status).toBe(0);
      expect(await fs.pathExists(target)).toBe(true);
    }
    expect(await fs.pathExists(path.join(repoRoot, '.juno_task', 'workflows', 'agent_chain.yaml'))).toBe(false);
  });

  it('writes practical tmux handoff and kanban review examples that dry-run cleanly', async () => {
    const examples = [
      {
        name: 'production-triage-handoff',
        expected: ['workflow_id: production_triage_handoff', '--tmux panes', '--tmux-handoff', '--max-panes-per-session 4', '--output-dir "{{ out_dir }}/parallel"'],
      },
      {
        name: 'parallel-kanban-review',
        expected: ['workflow_id: parallel_kanban_review', 'TASK_IDS=', 'aggregation_*.json', '--output-dir "{{ out_dir }}/parallel"'],
      },
    ];

    for (const example of examples) {
      const target = path.join(testDir, `${example.name}.yaml`);
      const outDir = path.join(testDir, `${example.name}-out`);
      const init = runWorkflow(['--init-example', example.name, target, '--force']);
      expect(init.status).toBe(0);
      const content = await fs.readFile(target, 'utf8');
      for (const expected of example.expected) {
        expect(content).toContain(expected);
      }

      const dryRun = runWorkflow(['--workflow', target, '--out-dir', outDir, '--dry-run', '--final-output', 'none']);
      expect(dryRun.status).toBe(0);
      const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
      expect(manifest.dry_run).toBe(true);
      expect(manifest.steps.length).toBeGreaterThan(0);
    }
  });

  it('dry-run renders a minimal YAML workflow and writes manifest/summary artifacts', async () => {
    const workflowPath = path.join(testDir, 'workflow.yml');
    const outDir = path.join(testDir, 'out');
    await fs.writeFile(
      workflowPath,
      `name: dry-run-test
vars:
  who: workflow
steps:
  - id: greet
    command: |
      printf 'hello {{ vars.who }}\\n'
summary: |
  status={{ steps.greet.status }}
`,
    );

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("printf 'hello workflow\\n'");
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.dry_run).toBe(true);
    expect(manifest.steps[0].status).toBe('dry_run');
    expect(await fs.readFile(path.join(outDir, 'summary.md'), 'utf8')).toContain('status=dry_run');
  });

  it('persists typed actual-target child evidence in manifests, checkpoints, recovery, and doctor', async () => {
    let managedScripts = path.join(testDir, 'managed-scripts');
    await fs.ensureDir(managedScripts);
    managedScripts = await fs.realpath(managedScripts);
    const managedRunner = path.join(managedScripts, 'workflow_runner.sh');
    await fs.copy(templateScript, managedRunner);
    await fs.copy(path.join(path.dirname(templateScript), 'workflow_run_evidence.py'), path.join(managedScripts, 'workflow_run_evidence.py'));
    const producer = await installFakeChildEvidenceProducer(managedScripts);
    const workflowPath = path.join(testDir, 'child-evidence.json');
    const outDir = path.join(testDir, 'child-evidence-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'child_evidence',
      steps: [{ id: 'integrate', command: [producer, 'integrate', '--actual-review-command', 'yy pi review', '--actual-review-receipt', 'actual.json'] }],
    });

    const interrupted = runWorkflowScript(managedRunner, ['--workflow', workflowPath, '--out-dir', outDir, '--run-root', testDir, '--print-output', 'none'], undefined, {
      JUNO_WORKFLOW_TEST_INTERRUPT_AT: 'checkpoint_before_terminal_manifest',
      JUNO_CODE_SKIP_SCRIPT_STALE_CHECK: '1',
    });
    expect(interrupted.status, `${interrupted.stderr}\n${interrupted.stdout}`).toBe(86);

    const contract = await fs.readJson(path.join(outDir, 'run_contract.json'));
    expect(contract.completed_steps.integrate.child_steps).toHaveLength(1);
    expect(contract.completed_steps.integrate.child_steps[0]).toMatchObject({
      child_id: 'actual_target_review',
      role: 'actual_target_review',
      invocation_mode: 'fresh_session',
      session_id: 'child-session-1',
      semantic_outcome: 'accepted',
      reviewed_target_sha: 'a'.repeat(40),
    });

    const recovery = runWorkflow(['recover-attempt', outDir, '--dry-run']);
    expect(recovery.status, recovery.stderr).toBe(0);
    expect(JSON.parse(recovery.stdout).verified_prefix_steps).toEqual(['integrate']);
    const recovered = runWorkflow(['recover-attempt', outDir]);
    expect(recovered.status, recovered.stderr).toBe(0);

    const recoveredContract = await fs.readJson(path.join(outDir, 'run_contract.json'));
    const recoveredManifest = await fs.readJson(recoveredContract.attempts.at(-1).manifest);
    expect(recoveredManifest.steps[0].child_steps[0].artifacts.response.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(runWorkflow(['doctor', outDir]).status).toBe(0);

    await fs.appendFile(recoveredManifest.steps[0].child_steps[0].artifacts.stdout.path, 'tamper');
    const doctor = runWorkflow(['doctor', outDir]);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain('CHILD_ARTIFACT_HASH_MISMATCH');
  });

  it('withholds child-evidence capability from unrelated workflow steps', async () => {
    const workflowPath = path.join(testDir, 'unrelated-child-capability.json');
    const outDir = path.join(testDir, 'unrelated-child-capability-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'unrelated_child_capability',
      steps: [{ id: 'validate', command: ['python3', '-c', "import os; print(os.environ.get('JUNO_WORKFLOW_CHILD_EVIDENCE_DIR', 'CLEARED'))"] }],
    });
    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);
    expect(result.status, result.stderr).toBe(0);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(await fs.readFile(manifest.steps[0].stdout_path, 'utf8')).toBe('CLEARED\n');
    expect(await fs.pathExists(path.join(outDir, 'child_steps', 'validate'))).toBe(false);
  });

  it('does not grant capability when owner markers are only attacker arguments', async () => {
    const workflowPath = path.join(testDir, 'spoofed-child-capability.json');
    const outDir = path.join(testDir, 'spoofed-child-capability-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'spoofed_child_capability',
      steps: [{
        id: 'attacker',
        command: [
          'python3',
          '-c',
          "import os; print(os.environ.get('JUNO_WORKFLOW_CHILD_EVIDENCE_DIR', 'CLEARED'))",
          'integration_owner_preflight.py',
          'integrate',
          '--actual-review-command',
          'yy pi review',
          '--actual-review-receipt',
          'actual.json',
        ],
      }],
    });
    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);
    expect(result.status, result.stderr).toBe(0);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(await fs.readFile(manifest.steps[0].stdout_path, 'utf8')).toBe('CLEARED\n');
    expect(await fs.pathExists(path.join(outDir, 'child_steps', 'attacker'))).toBe(false);
  });

  it('withholds child-evidence capability from a directly executed same-basename script', async () => {
    const attackerDir = path.join(testDir, 'attacker');
    await fs.ensureDir(attackerDir);
    const attacker = path.join(attackerDir, 'integration_owner_preflight.py');
    await fs.writeFile(attacker, "import os; print(os.environ.get('JUNO_WORKFLOW_CHILD_EVIDENCE_DIR', 'CLEARED'))\n");
    const workflowPath = path.join(testDir, 'same-basename-child-capability.json');
    const outDir = path.join(testDir, 'same-basename-child-capability-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'same_basename_child_capability',
      steps: [{ id: 'attacker', command: ['python3', attacker, 'integrate', '--actual-review-command', 'yy pi review', '--actual-review-receipt', 'actual.json'] }],
    });
    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);
    expect(result.status, result.stderr).toBe(0);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(await fs.readFile(manifest.steps[0].stdout_path, 'utf8')).toBe('CLEARED\n');
    expect(await fs.pathExists(path.join(outDir, 'child_steps', 'attacker'))).toBe(false);
  });

  it('grants child-evidence capability to the exact project-relative canonical owner path', async () => {
    const projectRoot = path.join(testDir, 'relative-owner-project');
    const managedScripts = path.join(projectRoot, '.juno_task', 'scripts');
    await fs.ensureDir(managedScripts);
    const managedRunner = path.join(managedScripts, 'workflow_runner.sh');
    await fs.copy(templateScript, managedRunner);
    await fs.copy(path.join(path.dirname(templateScript), 'workflow_run_evidence.py'), path.join(managedScripts, 'workflow_run_evidence.py'));
    await installFakeChildEvidenceProducer(managedScripts);
    const workflowPath = path.join(testDir, 'relative-owner-child-capability.json');
    const outDir = path.join(testDir, 'relative-owner-child-capability-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'relative_owner_child_capability',
      steps: [{ id: 'integrate', command: ['.juno_task/scripts/integration_owner_preflight.py', 'integrate', '--actual-review-command', 'yy pi review', '--actual-review-receipt', 'actual.json'] }],
    });
    const result = runWorkflowScript(managedRunner, ['--project-root', projectRoot, '--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none'], undefined, { JUNO_CODE_SKIP_SCRIPT_STALE_CHECK: '1' });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].child_steps).toHaveLength(1);
    expect(manifest.steps[0].child_steps[0].semantic_outcome).toBe('accepted');
  });

  it('withholds child-evidence capability from lexical aliases of the canonical owner path', async () => {
    let managedScripts = path.join(testDir, 'managed-alias-scripts');
    await fs.ensureDir(managedScripts);
    managedScripts = await fs.realpath(managedScripts);
    const managedRunner = path.join(managedScripts, 'workflow_runner.sh');
    await fs.copy(templateScript, managedRunner);
    await fs.copy(path.join(path.dirname(templateScript), 'workflow_run_evidence.py'), path.join(managedScripts, 'workflow_run_evidence.py'));
    const owner = path.join(managedScripts, 'integration_owner_preflight.py');
    await fs.writeFile(owner, "#!/usr/bin/env python3\nimport os; print(os.environ.get('JUNO_WORKFLOW_CHILD_EVIDENCE_DIR', 'CLEARED'))\n");
    await fs.chmod(owner, 0o755);
    const alias = `${managedScripts}/../${path.basename(managedScripts)}/integration_owner_preflight.py`;
    const workflowPath = path.join(testDir, 'alias-child-capability.json');
    const outDir = path.join(testDir, 'alias-child-capability-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'alias_child_capability',
      steps: [{ id: 'alias', command: [alias, 'integrate', '--actual-review-command', 'yy pi review', '--actual-review-receipt', 'actual.json'] }],
    });
    const result = runWorkflowScript(managedRunner, ['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none'], undefined, { JUNO_CODE_SKIP_SCRIPT_STALE_CHECK: '1' });
    expect(result.status, result.stderr).toBe(0);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(await fs.readFile(manifest.steps[0].stdout_path, 'utf8')).toBe('CLEARED\n');
    expect(await fs.pathExists(path.join(outDir, 'child_steps', 'alias'))).toBe(false);
  });

  it('accepts stdin workflow via --workflow -', async () => {
    const outDir = path.join(testDir, 'stdin-out');
    const result = runWorkflow(
      ['--workflow', '-', '--out-dir', outDir, '--dry-run', '--final-output', 'none'],
      `name: stdin-test
steps:
  - id: from_stdin
    command: echo stdin-ok
`,
    );

    expect(result.status).toBe(0);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].id).toBe('from_stdin');
    expect(manifest.steps[0].command).toBe('echo stdin-ok');
  });

  it('does not exit non-zero for a failed step by default but reports the failure', async () => {
    const workflowPath = path.join(testDir, 'fail-default.yml');
    const outDir = path.join(testDir, 'fail-default-out');
    await fs.writeFile(
      workflowPath,
      `name: fail-default
steps:
  - id: fail
    command: python3 -c "import sys; print('before-fail'); sys.exit(7)"
  - id: after
    command: echo after-ran
`,
    );

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--final-output', 'none']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('before-fail');
    expect(result.stdout).toContain('after-ran');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.status).toBe('failed');
    expect(manifest.failed_steps).toEqual(['fail']);
    expect(manifest.steps.map((step: { id: string }) => step.id)).toEqual(['fail', 'after']);
  });

  it('exits non-zero when a step opts into fail_workflow', async () => {
    const workflowPath = path.join(testDir, 'fail-fast.yml');
    const outDir = path.join(testDir, 'fail-fast-out');
    await fs.writeFile(
      workflowPath,
      `name: fail-fast
steps:
  - id: fail
    command: python3 -c "import sys; sys.exit(9)"
    fail_workflow: true
  - id: skipped
    command: echo should-not-run
`,
    );

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--final-output', 'none']);

    expect(result.status).toBe(9);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.failed_steps).toEqual(['fail']);
    expect(manifest.steps.map((step: { id: string }) => step.id)).toEqual(['fail']);
  });

  it('renders builtins, direct var aliases, prior step fields, artifact layout, and selected step output', async () => {
    const workflowPath = path.join(testDir, 'context.yml');
    const outDir = path.join(testDir, 'context-out');
    await fs.writeFile(
      workflowPath,
      `schema_version: 1
workflow_id: context-run
vars:
  who: workflow
steps:
  - id: first
    command: printf 'hello {{ who }} {{ today_utc }} {{ repo_root }}'
  - id: second
    command: printf 'status={{ steps.first.status }} exit={{ steps.first.exit_code }} stdout={{ steps.first.stdout }}'
summary: |
  run={{ run_id }} workflow={{ workflow_id }} dir={{ workflow_dir }}
`,
    );

    const result = runWorkflow([
      '--workflow',
      workflowPath,
      '--out-dir',
      outDir,
      '--var',
      'who=override',
      '--print-output',
      'second',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status=success exit=0 stdout=hello override');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.workflow_id).toBe('context-run');
    expect(manifest.repo_root).toBe(repoRoot);
    expect(await fs.pathExists(path.join(outDir, '001_first.stdout.txt'))).toBe(true);
    expect(await fs.pathExists(path.join(outDir, 'summary.stdout.txt'))).toBe(true);
    expect(await fs.readFile(path.join(outDir, 'summary.md'), 'utf8')).toContain('workflow=context-run');
  });

  it('prints color-ready start, response, and end separators while leaving response text plain', async () => {
    const workflowPath = path.join(testDir, 'separators.json');
    const outDir = path.join(testDir, 'separators-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'separators',
      steps: [{ id: 'alpha', command: ['bash', '-lc', 'echo ACTUAL_RESPONSE'] }],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('START: step 1 [alpha]');
    expect(result.stdout).toContain('RESPONSE: step 1 [alpha]');
    expect(result.stdout).toContain('ACTUAL_RESPONSE\n');
    expect(result.stdout).toContain('END: step 1 [alpha] status=success');
  });

  it('runs from a zero-based step index and records skipped prior steps', async () => {
    const workflowPath = path.join(testDir, 'from-index.json');
    const outDir = path.join(testDir, 'from-index-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'from-index',
      steps: [
        { id: 'first', command: ['bash', '-lc', 'echo first'] },
        { id: 'second', command: ['bash', '-lc', 'echo second'] },
        { id: 'third', command: ['bash', '-lc', 'echo third'] },
      ],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--from-step', '1', '--print-output', 'none']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('first\n');
    expect(result.stdout).toContain('second\n');
    expect(result.stdout).toContain('third\n');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.from_step_index).toBe(1);
    expect(manifest.steps.map((step: { status: string }) => step.status)).toEqual(['skipped', 'success', 'success']);
  });

  it('runs from a named step and supports -1 for only the last step', async () => {
    const workflowPath = path.join(testDir, 'from-name.json');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'from-name',
      steps: [
        { id: 'first', command: ['bash', '-lc', 'echo first'] },
        { id: 'second', command: ['bash', '-lc', 'echo second'] },
        { id: 'third', command: ['bash', '-lc', 'echo third'] },
      ],
    });

    const byName = runWorkflow([
      '--workflow',
      workflowPath,
      '--out-dir',
      path.join(testDir, 'from-name-out'),
      '--from-step',
      'second',
      '--print-output',
      'none',
    ]);
    expect(byName.status).toBe(0);
    expect(byName.stdout).not.toContain('first\n');
    expect(byName.stdout).toContain('second\n');
    expect(byName.stdout).toContain('third\n');

    const lastOnly = runWorkflow([
      '--workflow',
      workflowPath,
      '--out-dir',
      path.join(testDir, 'from-last-out'),
      '--from-step',
      '-1',
      '--print-output',
      'none',
    ]);
    expect(lastOnly.status).toBe(0);
    expect(lastOnly.stdout).not.toContain('first\n');
    expect(lastOnly.stdout).not.toContain('second\n');
    expect(lastOnly.stdout).toContain('third\n');
  });

  it('resolves workflow vars against builtins before rendering commands', async () => {
    const workflowPath = path.join(testDir, 'vars.yml');
    const outDir = path.join(testDir, 'vars-out');
    await fs.writeFile(
      workflowPath,
      `schema_version: 1
workflow_id: vars-render
vars:
  run_date: "{{ yesterday_utc }}"
steps:
  - id: show
    command: printf 'date={{ run_date }} vars={{ vars.run_date }}'
`,
    );

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--dry-run', '--final-output', 'none']);

    expect(result.status).toBe(0);
    const manifestText = await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8');
    expect(manifestText).not.toContain('{{ yesterday_utc }}');
    const manifest = JSON.parse(manifestText);
    expect(manifest.steps[0].command).toContain('date=');
    expect(manifest.steps[0].command).not.toContain('{{');
  });

  it('executes summary.command argv lists with the same semantics as step commands', async () => {
    const workflowPath = path.join(testDir, 'summary-argv.json');
    const outDir = path.join(testDir, 'summary-argv-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'summary-argv',
      steps: [{ id: 'first', command: ['bash', '-lc', 'echo first-ok'] }],
      summary: { command: ['bash', '-lc', 'printf "summary sees {{ steps.first.stdout }}"'] },
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);

    expect(result.status).toBe(0);
    expect(await fs.readFile(path.join(outDir, 'summary.stdout.txt'), 'utf8')).toContain('summary sees first-ok');
    expect(await fs.readFile(path.join(outDir, 'summary.command.sh'), 'utf8')).toContain("bash -lc");
    expect(await fs.readFile(path.join(outDir, 'summary.command.sh'), 'utf8')).not.toContain("['bash'");
  });

  it('uses summary.command stdout for summary.md and default selected output', async () => {
    const workflowPath = path.join(testDir, 'summary-output.json');
    const outDir = path.join(testDir, 'summary-output-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'summary-output',
      steps: [{ id: 'first', command: ['bash', '-lc', 'echo step-output'] }],
      summary: { command: ['bash', '-lc', 'echo AGENT-SUMMARY'] },
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--no-print-step-stdout']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AGENT-SUMMARY');
    const semanticSummary = await fs.readFile(path.join(outDir, 'summary.md'), 'utf8');
    expect(semanticSummary).toContain('Controlling gate: none');
    expect(semanticSummary).toContain('Semantic outcome: completed');
    expect(semanticSummary).toMatch(/AGENT-SUMMARY\n$/);
    expect(await fs.readFile(path.join(outDir, 'summary.stdout.txt'), 'utf8')).toBe('AGENT-SUMMARY\n');
  });

  it('creates a dedicated detached tmux observer with live hidden step output', async () => {
    const binDir = path.join(testDir, 'tmux-bin');
    const tmuxLog = path.join(testDir, 'tmux-invocations.log');
    await fs.ensureDir(binDir);
    await fs.writeFile(
      path.join(binDir, 'tmux'),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
if [ "\${1:-}" = "has-session" ]; then exit 1; fi
exit 0
`,
    );
    await fs.chmod(path.join(binDir, 'tmux'), 0o755);
    const workflowPath = path.join(testDir, 'tmux-observer.yml');
    const outDir = path.join(testDir, 'tmux-observer-out');
    await fs.writeFile(
      workflowPath,
      `workflow_id: tmux-observer
steps:
  - id: hidden
    command: python3 -c "import time; print(''.join(map(chr, [76,73,86,69,95,72,73,68,68,69,78,95,79,85,84,80,85,84])), flush=True); time.sleep(0.05)"
`,
    );

    const result = runWorkflow(
      [
        '--workflow',
        workflowPath,
        '--out-dir',
        outDir,
        '--tmux',
        '--tmux-session',
        'review-session',
        '--no-print-step-stdout',
        '--final-output',
        'none',
      ],
      undefined,
      {
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_TMUX_LOG: tmuxLog,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Workflow observer tmux session: review-session");
    expect(result.stdout).toContain("tmux attach -t review-session");
    expect(result.stdout).not.toContain('LIVE_HIDDEN_OUTPUT');
    expect(await fs.readFile(path.join(outDir, 'workflow.live.log'), 'utf8')).toContain('LIVE_HIDDEN_OUTPUT');
    expect(await fs.readFile(tmuxLog, 'utf8')).toContain('new-session -d -s review-session');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.tmux_observer).toMatchObject({ enabled: true, session: 'review-session' });
  });

  it('rejects --tmux-session without --tmux', async () => {
    const workflowPath = path.join(testDir, 'tmux-invalid.yml');
    await fs.writeFile(workflowPath, 'name: invalid\nsteps:\n  - id: one\n    command: echo one\n');

    const result = runWorkflow([
      '--workflow', workflowPath, '--tmux-session', 'orphan',
      '--run-root', testDir, '--out-dir', path.join(testDir, 'tmux-invalid-out'),
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--tmux-session requires --tmux');
  });

  it('--no-print-step-stdout suppresses console stdout while preserving artifact stdout', async () => {
    const workflowPath = path.join(testDir, 'quiet.yml');
    const outDir = path.join(testDir, 'quiet-out');
    await fs.writeFile(
      workflowPath,
      `name: quiet
steps:
  - id: noisy
    command: python3 -c "print(''.join(map(chr, [83, 69, 67, 82, 69, 84, 95, 83, 84, 69, 80, 95, 83, 84, 68, 79, 85, 84])))"
`,
    );

    const result = runWorkflow([
      '--workflow',
      workflowPath,
      '--out-dir',
      outDir,
      '--no-print-step-stdout',
      '--final-output',
      'none',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('SECRET_STEP_STDOUT');
    expect(await fs.readFile(path.join(outDir, 'steps/noisy/stdout.txt'), 'utf8')).toBe(
      'SECRET_STEP_STDOUT\n',
    );
  });

  it('does not inject quiet mode and keeps successful agent stderr out of console output', async () => {
    const binDir = path.join(testDir, 'quiet-bin');
    await fs.ensureDir(binDir);
    const executablePath = path.join(binDir, 'yy');
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env sh
if [ "\${1:-}" = "--quiet" ]; then
  echo SHOULD_NOT_BE_QUIET
  exit 3
fi
echo VERBOSE_INTERNAL_LOG >&2
echo FINAL_ONLY
`,
    );
    await fs.chmod(executablePath, 0o755);
    const workflowPath = path.join(testDir, 'quiet-juno.json');
    const outDir = path.join(testDir, 'quiet-juno-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'quiet-juno',
      steps: [{ id: 'agent', command: [executablePath, 'pi', 'prompt'], capture_session: false }],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FINAL_ONLY');
    expect(result.stdout).not.toContain('VERBOSE_INTERNAL_LOG');
    expect(result.stderr).not.toContain('VERBOSE_INTERNAL_LOG');
    expect(await fs.readFile(path.join(outDir, '001_agent.stderr.txt'), 'utf8')).toContain('VERBOSE_INTERNAL_LOG');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].command).toEqual([executablePath, 'pi', 'prompt']);
  });

  it('marks a detected agent command failed when exit is zero but response is empty', async () => {
    const binDir = path.join(testDir, 'empty-agent-bin');
    await fs.ensureDir(binDir);
    const executablePath = path.join(binDir, 'yy');
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env sh
echo ONLY_LOGS_NO_RESPONSE >&2
exit 0
`,
    );
    await fs.chmod(executablePath, 0o755);
    const workflowPath = path.join(testDir, 'empty-agent.json');
    const outDir = path.join(testDir, 'empty-agent-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'empty-agent',
      steps: [{ id: 'agent', command: [executablePath, 'pi', 'prompt'], capture_session: false }],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('ONLY_LOGS_NO_RESPONSE');
    expect(result.stdout).toContain('(response is empty)');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.status).toBe('failed');
    expect(manifest.failed_steps).toEqual(['agent']);
    expect(manifest.steps[0].status).toBe('failed');
    expect(manifest.steps[0].exit_code).toBe(1);
    expect(manifest.steps[0].transport_exit_code).toBe(0);
    expect(manifest.steps[0].failure_reason).toBe('empty response from detected agent command');
  });

  it('prints canonical captured response for juno commands while preserving raw stdout artifacts', async () => {
    const binDir = path.join(testDir, 'verbose-bin');
    await fs.ensureDir(binDir);
    const executablePath = path.join(binDir, 'yy');
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env sh
if [ "\${1:-}" = "continue-scope" ]; then printf '%s\\n' '{"fullHash":"SCOPE_0123456789ABCDEF","sessionEnvKey":"JUNO_CODE_LAST_SESSION_ID_SCOPE_0123456789ABCDEF","settingsEnvKey":"JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_0123456789ABCDEF"}'; exit 0; fi
echo 'VERBOSE INTERNAL LOG LINE'
printf '{"type":"result","subtype":"success","is_error":false,"result":"FINAL_AGENT_RESPONSE","session_id":"session-final"}\n' > "$JUNO_SUBAGENT_CAPTURE_PATH"
`,
    );
    await fs.chmod(executablePath, 0o755);
    const workflowPath = path.join(testDir, 'canonical-response.json');
    const outDir = path.join(testDir, 'canonical-response-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'canonical-response',
      steps: [{ id: 'agent', command: [executablePath, 'pi', 'prompt'] }],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);

    expect(result.status).toBe(0);
    const responseStart = result.stdout.indexOf('RESPONSE: step 1 [agent]');
    const responseEnd = result.stdout.indexOf('END: step 1 [agent]');
    const responseBlock = result.stdout.slice(responseStart, responseEnd);
    expect(responseBlock).toContain('FINAL_AGENT_RESPONSE');
    expect(responseBlock).not.toContain('VERBOSE INTERNAL LOG LINE');
    expect(await fs.readFile(path.join(outDir, '001_agent.stdout.txt'), 'utf8')).toContain('VERBOSE INTERNAL LOG LINE');
    expect(await fs.readFile(path.join(outDir, '001_agent.response.txt'), 'utf8')).toBe('FINAL_AGENT_RESPONSE');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].response_path).toContain('001_agent.response.txt');
  });

  it('captures current yy footer session ids from stderr without parsing cost values', async () => {
    const binDir = path.join(testDir, 'footer-bin');
    await fs.ensureDir(binDir);
    const executablePath = path.join(binDir, 'yy');
    const footerSessionId = '019f441e-2515-7e76-9500-39e6f3ad525a';
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env sh
if [ "\${1:-}" = "continue-scope" ]; then printf '%s\\n' '{"fullHash":"SCOPE_0123456789ABCDEF","sessionEnvKey":"JUNO_CODE_LAST_SESSION_ID_SCOPE_0123456789ABCDEF","settingsEnvKey":"JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_0123456789ABCDEF"}'; exit 0; fi
printf 'footer response\\n'
printf 'debug cost: $0.999999 before footer\\n' >&2
printf '🔑 Session ID(s):\\n' >&2
printf '   ${footerSessionId}    cost: $0.158907\\n' >&2
`,
    );
    await fs.chmod(executablePath, 0o755);
    const workflowPath = path.join(testDir, 'footer-session.json');
    const outDir = path.join(testDir, 'footer-session-out');
    await fs.writeJson(workflowPath, {
      name: 'footer-session',
      steps: [{ id: 'footer', command: [executablePath, 'pi', 'prompt'] }],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`step 1 [footer]: ${footerSessionId}`);
    expect(result.stdout).not.toContain('0.158907');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].session_id).toBe(footerSessionId);
  });

  it('keeps capture_session false metadata out of tracked project files and disables handoff', async () => {
    const binDir = path.join(testDir, 'bin');
    const executablePath = path.join(binDir, 'yy');
    await fs.ensureDir(binDir);
    await fs.ensureDir(path.join(testDir, '.juno_task'));
    await fs.writeJson(path.join(testDir, '.juno_task', 'session_history.json'), { version: 1, sessions: [{ id: 'tracked' }] });
    await fs.writeJson(path.join(testDir, '.juno_task', 'session_branches.json'), { version: 1, scopes: { tracked: {} } });
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env python3
import json, os, pathlib
root = pathlib.Path(os.environ['JUNO_CODE_SESSION_METADATA_DIRECTORY'])
root.mkdir(parents=True, exist_ok=True)
(root / 'session_history.json').write_text(json.dumps({'version': 1, 'sessions': [{'id': 'artifact'}]}))
(root / 'session_branches.json').write_text(json.dumps({'version': 1, 'scopes': {'artifact': {}}}))
print('response with session_id=session-must-not-be-captured')
`,
    );
    await fs.chmod(executablePath, 0o755);
    const workflowPath = path.join(testDir, 'no-capture.json');
    const outDir = path.join(testDir, 'no-capture-out');
    await fs.writeJson(workflowPath, {
      name: 'no-capture',
      steps: [{ id: 'agent', command: [executablePath, 'pi', 'prompt'], capture_session: false }],
    });

    const result = runWorkflow([
      '--workflow', workflowPath, '--run-root', testDir, '--out-dir', outDir, '--print-output', 'none',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Session ID(s):');
    expect(result.stdout).not.toContain('persisted for yy cc');
    expect(await fs.readJson(path.join(testDir, '.juno_task', 'session_history.json'))).toEqual({ version: 1, sessions: [{ id: 'tracked' }] });
    expect(await fs.readJson(path.join(testDir, '.juno_task', 'session_branches.json'))).toEqual({ version: 1, scopes: { tracked: {} } });
    expect(await fs.readJson(path.join(outDir, 'session_metadata', 'session_history.json'))).toEqual({ version: 1, sessions: [{ id: 'artifact' }] });
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].capture_enabled).toBe(false);
    expect(manifest.steps[0].session_id).toBe('');
    expect(manifest.continue).toBeUndefined();
  });

  it('uses yy rather than dispatching ypl for continue-scope control calls', async () => {
    const { binDir } = await installFakeJunoExecutable(testDir, 'yy');
    const yplPath = path.join(binDir, 'ypl');
    const controlMarker = path.join(testDir, 'ypl-control-dispatch.txt');
    await fs.writeFile(
      yplPath,
      `#!/usr/bin/env sh
if [ "\${1:-}" = "continue-scope" ]; then printf 'unexpected-control-dispatch' > ${JSON.stringify(controlMarker)}; exit 91; fi
exec "$(dirname "$0")/yy" pi --live "$@"
`,
    );
    await fs.chmod(yplPath, 0o755);
    const workflowPath = path.join(testDir, 'ypl-control-boundary.json');
    const outDir = path.join(testDir, 'ypl-control-boundary-out');
    await fs.writeJson(workflowPath, {
      name: 'ypl-control-boundary',
      steps: [{ id: 'agent', command: [yplPath, 'prompt'] }],
    });

    const result = runWorkflow(
      ['--workflow', workflowPath, '--run-root', testDir, '--out-dir', outDir, '--print-output', 'none'],
      undefined,
      { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    );

    expect(result.status).toBe(0);
    expect(await fs.pathExists(controlMarker)).toBe(false);
    expect(result.stdout).toContain('persisted for yy cc');
  });

  it('prints juno step session ids and persists the last one for yy cc continue', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    await fs.ensureDir(path.join(testDir, '.juno_task'));
    await fs.writeJson(path.join(testDir, '.juno_task', 'config.json'), { envFilePath: '.env.juno' });
    const workflowPath = path.join(testDir, 'session-summary.json');
    const outDir = path.join(testDir, 'session-summary-out');
    await fs.writeJson(workflowPath, {
      name: 'session-summary',
      steps: [
        { id: 'first', command: [executablePath, 'pi', 'alpha'] },
        { id: 'second', command: [executablePath, 'pi', 'omega'] },
      ],
    });

    const result = runWorkflow(
      ['--workflow', workflowPath, '--run-root', testDir, '--out-dir', outDir, '--print-output', 'none'],
      undefined,
      { JUNO_CODE_CONTINUE_SCOPE: 'workflow-test-scope' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Session ID(s):');
    expect(result.stdout).toContain('step 1 [first]: session-alpha');
    expect(result.stdout).toContain('step 2 [second]: session-omega');
    expect(result.stdout).toContain('handoff: step 2 [second] persisted for yy cc');
    expect(result.stdout).toContain('metadata_file: session_continuity.v2.json');
    expect(await fs.pathExists(path.join(testDir, '.env.juno'))).toBe(false);
  });

  it('captures summary.command sessions and uses summary as the default yy cc handoff', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    await fs.ensureDir(path.join(testDir, '.juno_task'));
    await fs.writeJson(path.join(testDir, '.juno_task', 'config.json'), { envFilePath: '.env.juno' });
    const workflowPath = path.join(testDir, 'summary-session.json');
    const outDir = path.join(testDir, 'summary-session-out');
    await fs.writeJson(workflowPath, {
      name: 'summary-session',
      steps: [{ id: 'normal', command: [executablePath, 'pi', 'normal'] }],
      summary: { command: [executablePath, 'pi', 'summary'] },
    });

    const result = runWorkflow(
      ['--workflow', workflowPath, '--run-root', testDir, '--out-dir', outDir],
      undefined,
      { JUNO_CODE_CONTINUE_SCOPE: 'workflow-summary-session' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('captured summary');
    expect(result.stdout).toContain('Session ID(s):');
    expect(result.stdout).toContain('step 1 [normal]: session-normal');
    expect(result.stdout).toContain('summary [summary]: session-summary');
    expect(result.stdout).toContain('handoff: summary [summary] persisted for yy cc');
    expect(result.stdout.indexOf('captured summary')).toBeLessThan(result.stdout.indexOf('Session ID(s):'));
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.summary.session_id).toBe('session-summary');
    expect(manifest.summary.capture_result).toBe('captured summary');
    expect(manifest.continue.step_id).toBe('summary');
    expect(manifest.continue.session_id).toBe('session-summary');
    expect(result.stdout).toContain('metadata_file: session_continuity.v2.json');
    expect(await fs.pathExists(path.join(testDir, '.env.juno'))).toBe(false);
  });

  it('keeps default yy cc handoff on the last successful agent when summary.command fails with a session', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    await fs.ensureDir(path.join(testDir, '.juno_task'));
    await fs.writeJson(path.join(testDir, '.juno_task', 'config.json'), { envFilePath: '.env.juno' });
    const workflowPath = path.join(testDir, 'failed-summary-session.json');
    const outDir = path.join(testDir, 'failed-summary-session-out');
    await fs.writeJson(workflowPath, {
      name: 'failed-summary-session',
      steps: [{ id: 'normal', command: [executablePath, 'pi', 'normal'] }],
      summary: { command: [executablePath, 'pi', 'fail'] },
    });

    const result = runWorkflow(
      ['--workflow', workflowPath, '--run-root', testDir, '--out-dir', outDir, '--print-output', 'none'],
      undefined,
      { JUNO_CODE_CONTINUE_SCOPE: 'workflow-failed-summary-session' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('summary [summary]: session-fail');
    expect(result.stdout).toContain('handoff: step 1 [normal] persisted for yy cc');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.summary.session_id).toBe('session-fail');
    expect(manifest.summary.exit_code).toBe(7);
    expect(manifest.continue.step_id).toBe('normal');
    expect(manifest.continue.session_id).toBe('session-normal');
  });

  it('adopts top-level yy continue snapshots and persists them to the caller scope for yy cc', async () => {
    const { executablePath } = await installFakeTopLevelPersistingJuno(testDir, 'yy');
    await fs.ensureDir(path.join(testDir, '.juno_task'));
    await fs.writeJson(path.join(testDir, '.juno_task', 'config.json'), { envFilePath: '.env.juno' });
    const workflowPath = path.join(testDir, 'top-level-session.json');
    const outDir = path.join(testDir, 'top-level-session-out');
    await fs.writeJson(workflowPath, {
      name: 'top-level-session',
      steps: [{ id: 'agent', command: [executablePath, 'pi', 'child'] }],
    });

    const result = runWorkflow([
      '--workflow',
      workflowPath,
      '--run-root',
      testDir,
      '--out-dir',
      outDir,
      '--print-output',
      'none',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('step 1 [agent]: session-child');
    expect(result.stdout).toContain('metadata_file: session_continuity.v2.json');
    expect(await fs.pathExists(path.join(testDir, '.env.juno'))).toBe(false);
    const manifestPath = path.join(outDir, 'manifest.json');
    expect(await fs.pathExists(manifestPath)).toBe(true);
    const manifest = await fs.readJson(manifestPath);
    expect(manifest.steps[0].session_id).toBe('session-child');
    expect(manifest.continue.step_id).toBe('agent');
    const doctor = runWorkflow(['doctor', outDir]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('Workflow doctor');
  });

  it('supports continue_from_step to persist a non-last agent session', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    await fs.ensureDir(path.join(testDir, '.juno_task'));
    await fs.writeJson(path.join(testDir, '.juno_task', 'config.json'), { envFilePath: '.env.juno' });
    const workflowPath = path.join(testDir, 'continue-from-step.json');
    const outDir = path.join(testDir, 'continue-from-step-out');
    await fs.writeJson(workflowPath, {
      name: 'continue-from-step',
      continue_from_step: 'first',
      steps: [
        { id: 'first', command: [executablePath, 'pi', 'alpha'] },
        { id: 'second', command: [executablePath, 'pi', 'omega'] },
      ],
    });

    const result = runWorkflow([
      '--workflow',
      workflowPath,
      '--run-root',
      testDir,
      '--out-dir',
      outDir,
      '--print-output',
      'none',
      ], undefined, { JUNO_CODE_CONTINUE_SCOPE: 'workflow-continue-from-step' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('metadata_file: session_continuity.v2.json');
    expect(await fs.pathExists(path.join(testDir, '.env.juno'))).toBe(false);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.continue.step_id).toBe('first');
    expect(manifest.continue.session_id).toBe('session-alpha');
  });

  it('persists continue settings for option-style yy -s/--subagent commands', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    await fs.ensureDir(path.join(testDir, '.juno_task'));
    await fs.writeJson(path.join(testDir, '.juno_task', 'config.json'), { envFilePath: '.env.juno' });
    const workflowPath = path.join(testDir, 'option-style-subagent.json');
    const outDir = path.join(testDir, 'option-style-subagent-out');
    await fs.writeJson(workflowPath, {
      name: 'option-style-subagent',
      continue_from_step: 'first',
      steps: [
        { id: 'first', command: [executablePath, '-s', 'pi', 'alpha'] },
        { id: 'second', command: [executablePath, '--subagent', 'pi', 'omega'] },
      ],
    });

    const result = runWorkflow(
      ['--workflow', workflowPath, '--run-root', testDir, '--out-dir', outDir, '--print-output', 'none'],
      undefined,
      { JUNO_CODE_CONTINUE_SCOPE: 'workflow-option-style-subagent' },
    );

    expect(result.status).toBe(0);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.continue.step_id).toBe('first');
    expect(manifest.continue.session_id).toBe('session-alpha');
    expect(manifest.continue.scope_hash).toMatch(/^SCOPE_[A-F0-9]{16}$/);
    expect(result.stdout).toContain('metadata_file: session_continuity.v2.json');
    expect(await fs.pathExists(path.join(testDir, '.env.juno'))).toBe(false);
  });

  it('supports continue_from_step summary override when summary is not the default last successful session', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    await fs.ensureDir(path.join(testDir, '.juno_task'));
    await fs.writeJson(path.join(testDir, '.juno_task', 'config.json'), { envFilePath: '.env.juno' });
    const workflowPath = path.join(testDir, 'continue-from-summary.json');
    const outDir = path.join(testDir, 'continue-from-summary-out');
    await fs.writeJson(workflowPath, {
      name: 'continue-from-summary',
      continue_from_step: 'summary',
      steps: [{ id: 'normal', command: [executablePath, 'pi', 'normal'] }],
      summary: { command: [executablePath, 'pi', 'fail'] },
    });

    const result = runWorkflow(
      ['--workflow', workflowPath, '--run-root', testDir, '--out-dir', outDir, '--print-output', 'none'],
      undefined,
      { JUNO_CODE_CONTINUE_SCOPE: 'workflow-continue-from-summary' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('handoff: summary [summary] persisted for yy cc');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.continue.step_id).toBe('summary');
    expect(manifest.continue.session_id).toBe('session-fail');
  });

  it('fails strict continue_from_step summary when summary has no session id', async () => {
    const workflowPath = path.join(testDir, 'continue-from-summary-missing-session.json');
    await fs.writeJson(workflowPath, {
      name: 'continue-from-summary-missing-session',
      continue_from_step: 'summary',
      steps: [{ id: 'plain', command: 'printf done' }],
      summary: { command: 'printf summary' },
    });

    const result = runWorkflow([
      '--workflow', workflowPath, '--print-output', 'none',
      '--run-root', testDir, '--out-dir', path.join(testDir, 'continue-from-summary-missing-out'),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("continue_from_step 'summary' did not match an executed Juno invocation with a session_id");
  });

  it('fails strict continue_from_step when the selected step has no session id', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    const workflowPath = path.join(testDir, 'continue-from-missing-session.json');
    await fs.writeJson(workflowPath, {
      name: 'continue-from-missing-session',
      continue_from_step: 'plain',
      steps: [
        { id: 'agent', command: [executablePath, 'pi', 'alpha'] },
        { id: 'plain', command: 'printf done' },
      ],
    });

    const result = runWorkflow([
      '--workflow', workflowPath, '--print-output', 'none',
      '--run-root', testDir, '--out-dir', path.join(testDir, 'continue-from-missing-out'),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("continue_from_step 'plain' selected step 2 [plain], but it did not produce a session_id");
  });

  it('auto-detects argv juno commands, reads capture JSON, and exposes session templates', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    const workflowPath = path.join(testDir, 'argv-capture.json');
    const outDir = path.join(testDir, 'argv-capture-out');
    await fs.writeJson(workflowPath, {
      name: 'argv-capture',
      steps: [
        { id: 'first', command: [executablePath, 'pi', 'alpha'] },
        { id: 'resume', command: "printf 'resume={{ steps.first.session_id }} result={{ steps.first.capture_result }} response={{ steps.first.response }}'" },
      ],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'resume']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('resume=session-alpha result=captured alpha response=captured alpha');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].capture_enabled).toBe(true);
    expect(manifest.steps[0].session_id).toBe('session-alpha');
    expect(manifest.steps[0].capture_result).toBe('captured alpha');
    expect(await fs.pathExists(manifest.steps[0].capture_json)).toBe(true);
  });

  it('auto-detects shell-string juno commands and injects capture env only for that step', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    const workflowPath = path.join(testDir, 'string-capture.json');
    const outDir = path.join(testDir, 'string-capture-out');
    await fs.writeJson(workflowPath, {
      name: 'string-capture',
      steps: [
        { id: 'first', command: `${executablePath} pi beta` },
        { id: 'plain', command: 'printf "tool=${JUNO_TOOL_ID-unset} capture=${JUNO_SUBAGENT_CAPTURE_PATH-unset}"' },
      ],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'plain']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tool=unset capture=unset');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].capture_enabled).toBe(true);
    expect(manifest.steps[0].session_id).toBe('session-beta');
    expect(manifest.steps[1].capture_enabled).toBe(false);
  });

  it('honors capture_session false for juno commands', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    const workflowPath = path.join(testDir, 'capture-disabled.json');
    const outDir = path.join(testDir, 'capture-disabled-out');
    await fs.writeJson(workflowPath, {
      name: 'capture-disabled',
      steps: [{ id: 'first', capture_session: false, command: [executablePath, 'pi', 'gamma'] }],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'first']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tool=unset capture=unset');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].capture_enabled).toBe(false);
    expect(manifest.steps[0].capture_json).toBe('');
  });

  it('records invalid capture JSON as a warning without failing the workflow', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    const workflowPath = path.join(testDir, 'invalid-capture.json');
    const outDir = path.join(testDir, 'invalid-capture-out');
    await fs.writeJson(workflowPath, {
      name: 'invalid-capture',
      steps: [{ id: 'bad_capture', command: [executablePath, 'pi', 'invalid'] }],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--final-output', 'none']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('warning: invalid capture JSON');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.status).toBe('success');
    expect(manifest.steps[0].capture_enabled).toBe(true);
    expect(manifest.steps[0].capture_warning).toContain('invalid capture JSON');
    expect(manifest.steps[0].session_id).toBe('');
  });

  it('resumes only from immutable workflow and receipt evidence', async () => {
    const workflowPath = path.join(testDir, 'receipt-resume.json');
    const outDir = path.join(testDir, 'receipt-resume-out');
    const receiptPath = path.join(testDir, 'producer-receipt.json');
    const markerPath = path.join(testDir, 'mutation-count.txt');
    const producerCode = [
      'import json, os, pathlib',
      `marker = pathlib.Path(${JSON.stringify(markerPath)})`,
      "marker.write_text(marker.read_text() + 'x' if marker.exists() else 'x')",
      `pathlib.Path(${JSON.stringify(receiptPath)}).write_text(json.dumps({` +
        "'schema_version':'fixture.v1','producer_step_digest':os.environ['JUNO_WORKFLOW_STEP_DIGEST'],'outcome':'completed'}))",
    ].join('; ');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'receipt-resume',
      receipts: [
        {
          id: 'producer_receipt',
          producer: 'producer',
          path: receiptPath,
          schema_version: 'fixture.v1',
          required_fields: ['producer_step_digest', 'outcome'],
          expected_fields: { outcome: 'completed' },
        },
      ],
      terminal_gate: 'gate',
      steps: [
        { id: 'producer', command: ['python3', '-c', producerCode] },
        { id: 'gate', requires_receipts: ['producer_receipt'], command: ['true'] },
      ],
    });

    const first = runWorkflow([
      '--workflow', workflowPath,
      '--project-root', testDir,
      '--out-dir', outDir,
      '--print-output', 'none',
    ]);
    expect(first.status).toBe(0);
    const resumed = runWorkflow([
      '--workflow', workflowPath,
      '--project-root', testDir,
      '--out-dir', outDir,
      '--from-step', 'gate',
      '--print-output', 'none',
    ]);
    expect(resumed.status).toBe(0);
    expect(await fs.readFile(markerPath, 'utf8')).toBe('x');
    let manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].status).toBe('reused_verified');
    expect((await fs.readJson(path.join(outDir, 'run_contract.json'))).attempts).toHaveLength(2);

    const receipt = await fs.readJson(receiptPath);
    receipt.note = 'tampered';
    await fs.writeJson(receiptPath, receipt);
    const rejected = runWorkflow([
      '--workflow', workflowPath,
      '--project-root', testDir,
      '--out-dir', outDir,
      '--from-step', 'gate',
      '--print-output', 'none',
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('artifact_sha256');
    manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].status).toBe('reused_verified');
    expect(await fs.readFile(markerPath, 'utf8')).toBe('x');
  });

  it('selectively amends from a verified prefix without re-executing its producer', async () => {
    const workflowPath = path.join(testDir, 'selective-amendment.json');
    const parentOut = path.join(testDir, 'selective-parent');
    const amendedOut = path.join(testDir, 'selective-amended');
    const markerPath = path.join(testDir, 'producer-count.txt');
    const gateMarkerPath = path.join(testDir, 'gate-count.txt');
    const producerCode = [
      'import json, os, pathlib',
      `marker = pathlib.Path(${JSON.stringify(markerPath)})`,
      "marker.write_text(marker.read_text() + 'x' if marker.exists() else 'x')",
      "receipt = pathlib.Path(os.environ['JUNO_WORKFLOW_RECEIPT_PRODUCER_RECEIPT'])",
      "receipt.parent.mkdir(parents=True, exist_ok=True)",
      "receipt.write_text(json.dumps({'schema_version':'fixture.v1','producer_step_digest':os.environ['JUNO_WORKFLOW_STEP_DIGEST'],'outcome':'completed'}))",
    ].join('; ');
    const workflow = (receiptDir: string) => ({
      schema_version: 1,
      workflow_id: 'selective-amendment',
      amendment_mode: 'harness_only_validation',
      receipts: [{
        id: 'producer_receipt',
        producer: 'producer',
        path: `{{ out_dir }}/${receiptDir}/producer.json`,
        schema_version: 'fixture.v1',
        required_fields: ['producer_step_digest', 'outcome'],
        expected_fields: { outcome: 'completed' },
      }],
      terminal_gate: 'gate',
      steps: [
        { id: 'producer', command: ['python3', '-c', producerCode] },
        {
          id: 'gate',
          requires_receipts: ['producer_receipt'],
          command: ['python3', '-c', `from pathlib import Path; Path(${JSON.stringify(gateMarkerPath)}).write_text('gate')`],
        },
      ],
    });
    await fs.writeJson(workflowPath, workflow('candidates'));

    const first = runWorkflow([
      '--workflow', workflowPath, '--project-root', testDir,
      '--out-dir', parentOut, '--print-output', 'none',
    ]);
    expect(first.status).toBe(0);
    await fs.remove(gateMarkerPath);
    await fs.writeJson(workflowPath, workflow('reviews'));

    const amended = runWorkflow([
      '--workflow', workflowPath, '--project-root', testDir,
      '--out-dir', amendedOut, '--amends-run', parentOut,
      '--from-step', 'gate', '--print-output', 'none',
    ]);
    expect(amended.status).toBe(0);
    expect(amended.stdout).toContain('Revalidate/reuse: producer');
    expect(amended.stdout).toContain('Execute: gate');
    expect(await fs.readFile(markerPath, 'utf8')).toBe('x');
    expect(await fs.readFile(gateMarkerPath, 'utf8')).toBe('gate');
    expect(await fs.pathExists(path.join(amendedOut, 'reviews', 'producer.json'))).toBe(true);
    const manifest = await fs.readJson(path.join(amendedOut, 'manifest.json'));
    expect(manifest.steps[0].status).toBe('amendment_revalidated');
    expect(manifest.amendment_plan.reused_steps).toEqual(['producer']);
    const contract = await fs.readJson(path.join(amendedOut, 'run_contract.json'));
    expect(contract.completed_steps.producer.receipts.producer_receipt.lineage).toBe('amendment_revalidated');
    expect(contract.completed_steps.producer.receipts.producer_receipt.inherited_from).toContain('/candidates/producer.json');
  });

  it('rejects tampered amendment evidence before executing the requested suffix', async () => {
    const workflowPath = path.join(testDir, 'tampered-amendment.json');
    const parentOut = path.join(testDir, 'tampered-parent');
    const amendedOut = path.join(testDir, 'tampered-amended');
    const receiptPath = path.join(parentOut, 'receipt.json');
    const suffixMarker = path.join(testDir, 'suffix-ran.txt');
    const producerCode = [
      'import json, os, pathlib',
      "path = pathlib.Path(os.environ['JUNO_WORKFLOW_RECEIPT_EVIDENCE'])",
      "path.parent.mkdir(parents=True, exist_ok=True)",
      "path.write_text(json.dumps({'schema_version':'fixture.v1','producer_step_digest':os.environ['JUNO_WORKFLOW_STEP_DIGEST']}))",
    ].join('; ');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'tampered-amendment',
      amendment_mode: 'harness_only_validation',
      receipts: [{
        id: 'evidence', producer: 'producer', path: '{{ out_dir }}/receipt.json',
        schema_version: 'fixture.v1', required_fields: ['producer_step_digest'],
      }],
      steps: [
        { id: 'producer', command: ['python3', '-c', producerCode] },
        { id: 'suffix', requires_receipts: ['evidence'], command: ['bash', '-lc', `touch ${JSON.stringify(suffixMarker)}`] },
      ],
    });
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    await fs.remove(suffixMarker);
    const tampered = await fs.readJson(receiptPath);
    tampered.changed = true;
    await fs.writeJson(receiptPath, tampered);

    const rejected = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('artifact_sha256');
    expect(await fs.pathExists(suffixMarker)).toBe(false);
  });

  it('rejects a tampered hash-bound parent manifest before selective amendment dispatch', async () => {
    const workflowPath = path.join(testDir, 'manifest-tamper.json');
    const parentOut = path.join(testDir, 'manifest-parent');
    const amendedOut = path.join(testDir, 'manifest-amended');
    const suffixMarker = path.join(testDir, 'manifest-suffix.txt');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'manifest-tamper',
      amendment_mode: 'harness_only_validation',
      steps: [
        { id: 'producer', command: ['bash', '-lc', 'printf trusted'] },
        { id: 'suffix', command: ['bash', '-lc', `touch ${JSON.stringify(suffixMarker)}`] },
      ],
    });
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    await fs.remove(suffixMarker);
    const parentContract = await fs.readJson(path.join(parentOut, 'run_contract.json'));
    const manifestPath = parentContract.attempts.at(-1).manifest;
    const manifest = await fs.readJson(manifestPath);
    manifest.steps[0].response = 'tampered';
    await fs.writeJson(manifestPath, manifest);

    const rejected = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('manifest hash mismatch');
    expect(await fs.pathExists(suffixMarker)).toBe(false);
  });

  it('fails closed when the newest parent attempt manifest is missing', async () => {
    const workflowPath = path.join(testDir, 'missing-newest-manifest.json');
    const parentOut = path.join(testDir, 'missing-newest-parent');
    const amendedOut = path.join(testDir, 'missing-newest-amended');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'missing-newest-manifest',
      amendment_mode: 'harness_only_validation',
      steps: [
        { id: 'prefix', command: ['bash', '-lc', 'printf prefix'] },
        { id: 'suffix', command: ['bash', '-lc', 'printf suffix'] },
      ],
    });
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    const contractPath = path.join(parentOut, 'run_contract.json');
    const contract = await fs.readJson(contractPath);
    contract.attempts.push({
      attempt_id: 'newer', status: 'failed', semantic_status: 'failed',
      manifest: path.join(parentOut, 'attempts', 'newer', 'manifest.json'),
      manifest_sha256: '0'.repeat(64),
    });
    await fs.writeJson(contractPath, contract);

    const rejected = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('newest workflow attempt manifest is missing');
  });

  it('binds the newest parent attempt ID to its hash-bound manifest', async () => {
    const workflowPath = path.join(testDir, 'attempt-identity.json');
    const parentOut = path.join(testDir, 'attempt-identity-parent');
    const amendedOut = path.join(testDir, 'attempt-identity-amended');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'attempt-identity',
      amendment_mode: 'harness_only_validation',
      steps: [
        { id: 'prefix', command: ['bash', '-lc', 'printf prefix'] },
        { id: 'suffix', command: ['bash', '-lc', 'printf suffix'] },
      ],
    });
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    const contractPath = path.join(parentOut, 'run_contract.json');
    const contract = await fs.readJson(contractPath);
    contract.attempts.at(-1).attempt_id = 'forged-attempt';
    await fs.writeJson(contractPath, contract);

    const rejected = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('attempt identity does not match');
  });

  it('rejects cross-attempt mixing between manifest context and completed evidence', async () => {
    const workflowPath = path.join(testDir, 'attempt-mismatch.json');
    const parentOut = path.join(testDir, 'attempt-mismatch-parent');
    const amendedOut = path.join(testDir, 'attempt-mismatch-amended');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'attempt-mismatch',
      amendment_mode: 'harness_only_validation',
      steps: [
        { id: 'prefix', command: ['bash', '-lc', 'printf prefix'] },
        { id: 'suffix', command: ['bash', '-lc', 'printf suffix'] },
      ],
    });
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    const contractPath = path.join(parentOut, 'run_contract.json');
    const contract = await fs.readJson(contractPath);
    const attempt = contract.attempts.at(-1);
    const manifest = await fs.readJson(attempt.manifest);
    manifest.steps[0].status = 'reused_verified';
    manifest.steps[0].reused_from_attempt = 'different-attempt';
    await fs.writeJson(attempt.manifest, manifest);
    attempt.manifest_sha256 = createHash('sha256').update(await fs.readFile(attempt.manifest)).digest('hex');
    await fs.writeJson(contractPath, contract);

    const rejected = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('completed evidence attempt mismatch');
  });

  it('rejects removed or weakened receipt contracts for skipped producers', async () => {
    const workflowPath = path.join(testDir, 'removed-prefix-receipt.json');
    const parentOut = path.join(testDir, 'removed-prefix-parent');
    const amendedOut = path.join(testDir, 'removed-prefix-amended');
    const producerCode = [
      'import json, os, pathlib',
      "path = pathlib.Path(os.environ['JUNO_WORKFLOW_RECEIPT_EVIDENCE'])",
      "path.parent.mkdir(parents=True, exist_ok=True)",
      "path.write_text(json.dumps({'schema_version':'fixture.v1','producer_step_digest':os.environ['JUNO_WORKFLOW_STEP_DIGEST']}))",
    ].join('; ');
    const steps = [
      { id: 'producer', command: ['python3', '-c', producerCode] },
      { id: 'suffix', command: ['bash', '-lc', 'printf suffix'] },
    ];
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'removed-prefix-receipt',
      amendment_mode: 'harness_only_validation',
      receipts: [{
        id: 'evidence', producer: 'producer', path: '{{ out_dir }}/evidence.json',
        schema_version: 'fixture.v1', required_fields: ['producer_step_digest'],
      }],
      steps,
    });
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'removed-prefix-receipt',
      amendment_mode: 'harness_only_validation',
      steps,
    });

    const rejected = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('producer receipt set changed');
  });

  it('rejects newly declared skipped-producer receipts without a parent hash anchor', async () => {
    const workflowPath = path.join(testDir, 'missing-anchor.json');
    const parentOut = path.join(testDir, 'missing-anchor-parent');
    const amendedOut = path.join(testDir, 'missing-anchor-amended');
    const suffixMarker = path.join(testDir, 'missing-anchor-suffix.txt');
    const baseWorkflow = {
      schema_version: 1,
      workflow_id: 'missing-anchor',
      amendment_mode: 'harness_only_validation',
      steps: [
        { id: 'producer', command: ['bash', '-lc', 'printf complete'] },
        { id: 'suffix', command: ['bash', '-lc', `touch ${JSON.stringify(suffixMarker)}`] },
      ],
    };
    await fs.writeJson(workflowPath, baseWorkflow);
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    await fs.remove(suffixMarker);
    await fs.writeJson(workflowPath, {
      ...baseWorkflow,
      receipts: [{
        id: 'new_evidence', producer: 'producer', path: '{{ out_dir }}/new.json',
        schema_version: 'fixture.v1', required_fields: ['producer_step_digest'],
      }],
    });

    const rejected = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('producer receipt set changed');
    expect(await fs.pathExists(suffixMarker)).toBe(false);
  });

  it('reuses hash-bound dynamic prefix commands rendered from predecessor responses', async () => {
    const workflowPath = path.join(testDir, 'dynamic-prefix.json');
    const parentOut = path.join(testDir, 'dynamic-prefix-parent');
    const amendedOut = path.join(testDir, 'dynamic-prefix-amended');
    const secondMarker = path.join(testDir, 'dynamic-second.txt');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'dynamic-prefix',
      amendment_mode: 'harness_only_validation',
      steps: [
        { id: 'first', command: ['bash', '-lc', 'printf alpha'] },
        { id: 'second', command: ['bash', '-lc', `printf '{{ steps.first.response }}' > ${JSON.stringify(secondMarker)}`] },
        { id: 'suffix', command: ['bash', '-lc', 'printf suffix'] },
      ],
    });
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    expect(await fs.readFile(secondMarker, 'utf8')).toBe('alpha');
    await fs.remove(secondMarker);

    const amended = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(amended.status).toBe(0);
    expect(await fs.pathExists(secondMarker)).toBe(false);
    const manifest = await fs.readJson(path.join(amendedOut, 'manifest.json'));
    expect(manifest.steps.slice(0, 2).map((step: { status: string }) => step.status)).toEqual([
      'amendment_revalidated', 'amendment_revalidated',
    ]);
  });

  it('preserves the original completed producer attempt across amendment generations', async () => {
    const workflowPath = path.join(testDir, 'multi-generation-lineage.json');
    const parentOut = path.join(testDir, 'lineage-parent');
    const firstAmendmentOut = path.join(testDir, 'lineage-amendment-one');
    const secondAmendmentOut = path.join(testDir, 'lineage-amendment-two');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'multi-generation-lineage',
      amendment_mode: 'harness_only_validation',
      steps: [
        { id: 'prefix', command: ['bash', '-lc', 'printf prefix'] },
        { id: 'suffix', command: ['bash', '-lc', 'printf suffix'] },
      ],
    });
    expect(runWorkflow(['--workflow', workflowPath, '--out-dir', parentOut, '--print-output', 'none']).status).toBe(0);
    const originalContract = await fs.readJson(path.join(parentOut, 'run_contract.json'));
    const originalAttempt = originalContract.completed_steps.prefix.attempt_id;
    expect(runWorkflow([
      '--workflow', workflowPath, '--out-dir', firstAmendmentOut,
      '--amends-run', parentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]).status).toBe(0);
    expect(runWorkflow([
      '--workflow', workflowPath, '--out-dir', secondAmendmentOut,
      '--amends-run', firstAmendmentOut, '--from-step', 'suffix', '--print-output', 'none',
    ]).status).toBe(0);
    const secondContract = await fs.readJson(path.join(secondAmendmentOut, 'run_contract.json'));
    expect(secondContract.completed_steps.prefix.attempt_id).toBe(originalAttempt);
  });

  it('keeps full amendments runnable when the parent has only a run contract', async () => {
    const workflowPath = path.join(testDir, 'full-amendment.json');
    const parentOut = path.join(testDir, 'contract-only-parent');
    const amendedOut = path.join(testDir, 'full-amendment-out');
    await fs.ensureDir(parentOut);
    await fs.writeJson(path.join(parentOut, 'run_contract.json'), {
      schema_version: 'juno_workflow_run_contract.v1',
      workflow_id: 'full-amendment',
      attempts: [],
    });
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'full-amendment',
      amendment_mode: 'harness_only_validation',
      steps: [{ id: 'only', command: ['bash', '-lc', 'printf amended'] }],
    });
    const result = runWorkflow([
      '--workflow', workflowPath, '--out-dir', amendedOut,
      '--amends-run', parentOut, '--print-output', 'none',
    ]);
    expect(result.status).toBe(0);
    expect((await fs.readJson(path.join(amendedOut, 'run_contract.json'))).amendment_of.manifest).toBeUndefined();
  });

  it('lints contradictory hardcoded receipt paths and points to the canonical receipt context', async () => {
    const workflowPath = path.join(testDir, 'receipt-path-conflict.json');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'receipt_path_conflict',
      receipts: [{
        id: 'verified', producer: 'producer',
        path: '{{ out_dir }}/candidates/verified.json',
        schema_version: 'fixture.v1', required_fields: ['producer_step_digest'],
      }],
      steps: [{ id: 'producer', command: "printf 'write {{ out_dir }}/reviews/verified.json'" }],
    });
    const result = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('hardcodes receipt path');
    expect(result.stdout).toContain('{{ receipts.verified.path }}');
  });

  it('rejects receipt IDs that cannot map unambiguously to templates and environment variables', async () => {
    const workflowPath = path.join(testDir, 'ambiguous-receipt-id.json');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'ambiguous_receipt_id',
      receipts: [{
        id: 'review.pass', producer: 'producer', path: 'review.json',
        schema_version: 'fixture.v1', required_fields: ['producer_step_digest'],
      }],
      steps: [{ id: 'producer', command: 'true' }],
    });
    const result = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('use lowercase letters, numbers, and underscores');
  });

  it('does not flag unrelated JSON outputs that merely share a receipt basename', async () => {
    const workflowPath = path.join(testDir, 'receipt-path-non-conflict.json');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'receipt_path_non_conflict',
      receipts: [{
        id: 'candidate_report', producer: 'producer',
        path: '{{ out_dir }}/candidates/report.json',
        schema_version: 'fixture.v1', required_fields: ['producer_step_digest'],
      }],
      steps: [{
        id: 'producer',
        command: "printf 'receipt={{receipts.candidate_report.path}} diagnostic={{ out_dir }}/reviews/report.json'",
      }],
    });
    const result = runWorkflow(['lint', '--workflow', workflowPath]);
    expect(result.status).toBe(0);
  });

  it('recovers a complete checkpoint without rerunning the successful prefix', async () => {
    const workflowPath = path.join(testDir, 'recover-complete.json');
    const outDir = path.join(testDir, 'recover-complete-out');
    const prefixMarker = path.join(testDir, 'prefix-count.txt');
    const suffixMarker = path.join(testDir, 'suffix-count.txt');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'recover-complete',
      steps: [
        { id: 'prefix', command: ['bash', '-lc', `printf x >> ${JSON.stringify(prefixMarker)}; printf prefix`] },
        { id: 'suffix', command: ['bash', '-lc', `printf y >> ${JSON.stringify(suffixMarker)}; printf suffix`] },
      ],
    });
    const interrupted = runWorkflow([
      '--workflow', workflowPath, '--project-root', testDir, '--out-dir', outDir, '--print-output', 'none',
    ], undefined, { JUNO_WORKFLOW_TEST_INTERRUPT_AT: 'checkpoint_before_terminal_manifest' });
    expect(interrupted.status).toBe(86);
    expect(await fs.readFile(prefixMarker, 'utf8')).toBe('x');
    expect(await fs.pathExists(suffixMarker)).toBe(false);
    expect(await fs.pathExists(path.join(outDir, 'manifest.json'))).toBe(false);

    const dry = runWorkflow(['recover-attempt', outDir, '--dry-run']);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout).verified_prefix_steps).toEqual(['prefix']);
    expect((await fs.readJson(path.join(outDir, 'run_contract.json'))).attempts).toHaveLength(0);
    const recovered = runWorkflow(['recover-attempt', outDir]);
    expect(recovered.status).toBe(0);
    const recovery = JSON.parse(recovered.stdout);
    expect(recovery.first_invalid_step).toBe('suffix');
    const contract = await fs.readJson(path.join(outDir, 'run_contract.json'));
    expect(contract.attempts.at(-1).status).toBe('interrupted');
    expect(contract.attempts.at(-1).recovery_reason).toBe('recovered_from_step_checkpoints');
    expect(await fs.pathExists(path.join(outDir, 'manifest.json'))).toBe(false);
    const doctor = runWorkflow(['doctor', '--json', outDir]);
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout).status).toBe('ok');

    const resumed = runWorkflow([
      '--workflow', workflowPath, '--project-root', testDir, '--out-dir', outDir,
      '--from-step', 'suffix', '--print-output', 'none',
    ]);
    expect(resumed.status).toBe(0);
    expect(await fs.readFile(prefixMarker, 'utf8')).toBe('x');
    expect(await fs.readFile(suffixMarker, 'utf8')).toBe('y');
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.steps[0].status).toBe('reused_verified');
  });

  it.each([
    'command_success_before_artifacts',
    'artifacts_before_checkpoint',
  ])('never reuses incomplete evidence interrupted at %s', async (point) => {
    const workflowPath = path.join(testDir, `${point}.json`);
    const outDir = path.join(testDir, `${point}-out`);
    const markerPath = path.join(testDir, `${point}-count.txt`);
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: `incomplete-${point}`,
      steps: [{ id: 'write', command: ['bash', '-lc', `printf x >> ${JSON.stringify(markerPath)}`] }],
    });
    expect(runWorkflow([
      '--workflow', workflowPath, '--project-root', testDir, '--out-dir', outDir, '--print-output', 'none',
    ], undefined, { JUNO_WORKFLOW_TEST_INTERRUPT_AT: point }).status).toBe(86);
    const contract = await fs.readJson(path.join(outDir, 'run_contract.json'));
    expect(contract.completed_steps).toEqual({});
    const recovered = runWorkflow(['recover-attempt', outDir]);
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout).verified_prefix_steps).toEqual([]);
  });

  it.each([
    'summary_before_attempt_manifest',
    'attempt_manifest_before_record',
    'attempt_record_before_root_manifest',
  ])('recovers or consumes hash-bound metadata across terminal write boundary %s', async (point) => {
    const workflowPath = path.join(testDir, `${point}.json`);
    const outDir = path.join(testDir, `${point}-out`);
    await fs.writeJson(workflowPath, {
      schema_version: 1, workflow_id: `terminal-${point}`,
      steps: [{ id: 'only', command: ['bash', '-lc', 'printf complete'] }],
    });
    expect(runWorkflow([
      '--workflow', workflowPath, '--project-root', testDir, '--out-dir', outDir, '--print-output', 'none',
    ], undefined, { JUNO_WORKFLOW_TEST_INTERRUPT_AT: point }).status).toBe(86);
    const contract = await fs.readJson(path.join(outDir, 'run_contract.json'));
    if (point === 'attempt_record_before_root_manifest') {
      expect(contract.attempts).toHaveLength(1);
      expect(runWorkflow(['doctor', outDir]).status).toBe(0);
      expect(runWorkflow(['recover-attempt', outDir]).status).not.toBe(0);
    } else {
      expect(contract.attempts).toHaveLength(0);
      expect(runWorkflow(['recover-attempt', outDir]).status).toBe(0);
    }
  });

  it('fails recovery closed for artifact, workflow, variable, frozen-input, and receipt drift', async () => {
    const workflowPath = path.join(testDir, 'recovery-drift.json');
    const frozenPath = path.join(testDir, 'frozen.txt');
    const receiptPath = path.join(testDir, 'recovery-receipt.json');
    const outDir = path.join(testDir, 'recovery-drift-out');
    await fs.writeFile(frozenPath, 'frozen');
    const producerCode = `import json,os,pathlib; pathlib.Path(${JSON.stringify(receiptPath)}).write_text(json.dumps({'schema_version':'fixture.v1','producer_step_digest':os.environ['JUNO_WORKFLOW_STEP_DIGEST']})); print('complete',end='')`;
    await fs.writeJson(workflowPath, {
      schema_version: 1, workflow_id: 'recovery-drift', vars: { mode: 'approved' },
      frozen_inputs: [{ id: 'input', path: frozenPath }],
      receipts: [{ id: 'evidence', producer: 'only', path: receiptPath, schema_version: 'fixture.v1', required_fields: ['producer_step_digest'] }],
      steps: [{ id: 'only', command: ['python3', '-c', producerCode] }],
    });
    expect(runWorkflow([
      '--workflow', workflowPath, '--project-root', testDir, '--out-dir', outDir,
      '--print-output', 'none',
    ], undefined, { JUNO_WORKFLOW_TEST_INTERRUPT_AT: 'checkpoint_before_terminal_manifest' }).status).toBe(86);
    const contract = await fs.readJson(path.join(outDir, 'run_contract.json'));
    await fs.writeFile(contract.completed_steps.only.artifacts.stdout.path, 'tampered');
    let rejected = runWorkflow(['recover-attempt', outDir]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('hash mismatch');
    await fs.writeFile(contract.completed_steps.only.artifacts.stdout.path, 'complete');
    const receipt = await fs.readJson(receiptPath);
    receipt.tampered = true;
    await fs.writeJson(receiptPath, receipt);
    rejected = runWorkflow(['recover-attempt', outDir]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('artifact_sha256');
    delete receipt.tampered;
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
    await fs.writeFile(frozenPath, 'changed');
    rejected = runWorkflow(['recover-attempt', outDir]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('frozen_input');
    await fs.writeFile(frozenPath, 'frozen');
    const workflow = await fs.readJson(workflowPath);
    workflow.vars.mode = 'drifted';
    await fs.writeJson(workflowPath, workflow);
    rejected = runWorkflow(['recover-attempt', outDir]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('workflow source');
  });

  it('refuses recovery while a signalled caller leaves a step process active', async () => {
    const workflowPath = path.join(testDir, 'active-recovery.json');
    const outDir = path.join(testDir, 'active-recovery-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1, workflow_id: 'active-recovery',
      steps: [{ id: 'active', command: ['bash', '-lc', 'sleep 30'] }],
    });
    const child = spawn('python3', [templateScript, '--workflow', workflowPath, '--project-root', testDir,
      '--out-dir', outDir, '--print-output', 'none'], { cwd: repoRoot, env: process.env, stdio: 'ignore' });
    const activePath = path.join(outDir, 'active_step.json');
    for (let index = 0; index < 100 && !(await fs.pathExists(activePath)); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const active = await fs.readJson(activePath);
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    const refused = runWorkflow(['recover-attempt', outDir]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('active or its process state is ambiguous');
    try { process.kill(-active.process_group_id, 'SIGTERM'); } catch {}
  });

  it('fails ENOSPC capture persistence without creating a reusable checkpoint', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    const workflowPath = path.join(testDir, 'enospc.json');
    const outDir = path.join(testDir, 'enospc-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1, workflow_id: 'enospc',
      steps: [{ id: 'only', command: [executablePath, 'pi', 'capture'] }],
    });
    const result = runWorkflow([
      '--workflow', workflowPath, '--project-root', testDir, '--out-dir', outDir, '--print-output', 'none',
    ], undefined, {
      JUNO_WORKFLOW_TEST_INTERRUPT_AT: 'capture_before_checkpoint',
      JUNO_WORKFLOW_TEST_INTERRUPT_MODE: 'enospc',
    });
    expect(result.status).not.toBe(0);
    expect((await fs.readJson(path.join(outDir, 'run_contract.json'))).completed_steps).toEqual({});
  });

  it('separates semantic terminal failure from successful transport', async () => {
    const workflowPath = path.join(testDir, 'semantic-terminal.json');
    const outDir = path.join(testDir, 'semantic-terminal-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'semantic-terminal',
      terminal_gate: 'review',
      steps: [
        {
          id: 'review',
          expected_outcomes: ['PASS'],
          command: ['bash', '-lc', 'printf transport-success'],
        },
      ],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'none']);
    expect(result.status).toBe(1);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.semantic_status).toBe('failed');
    expect(manifest.steps[0].transport_exit_code).toBe(0);
    expect(manifest.steps[0].exit_code).toBe(1);
    expect(manifest.steps[0].failure_reason).toContain('missing JUNO_WORKFLOW_OUTCOME footer');
  });

  it('keeps terminal-gated dry runs successful and labels them dry_run', async () => {
    const workflowPath = path.join(testDir, 'terminal-dry-run.json');
    const outDir = path.join(testDir, 'terminal-dry-run-out');
    await fs.writeJson(workflowPath, {
      schema_version: 1,
      workflow_id: 'terminal-dry-run',
      terminal_gate: 'gate',
      steps: [{ id: 'gate', expected_outcomes: ['PASS'], command: ['false'] }],
    });

    const result = runWorkflow([
      '--workflow', workflowPath,
      '--out-dir', outDir,
      '--dry-run',
      '--print-output', 'none',
    ]);
    expect(result.status).toBe(0);
    const manifest = await fs.readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.semantic_status).toBe('dry_run');
    expect(manifest.status).toBe('success');
  });

  it('fails explicitly when advanced YAML is used without Python PyYAML', async () => {
    const workflowPath = path.join(testDir, 'advanced-without-pyyaml.yaml');
    await fs.writeFile(
      workflowPath,
      `schema_version: 1
workflow_id: advanced_without_pyyaml
receipts:
  - id: evidence
    producer: producer
    path: receipt.json
    schema_version: evidence.v1
steps:
  - id: producer
    command: true
`,
    );

    const result = spawnSync('python3', ['-S', templateScript, 'lint', '--workflow', workflowPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('advanced workflow contracts require Python PyYAML or JSON input');
  });
});
