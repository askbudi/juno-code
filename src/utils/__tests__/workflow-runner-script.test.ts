import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd(), '..');
const templateScript = path.resolve(process.cwd(), 'src/templates/scripts/workflow_runner.sh');
const runtimeScript = path.resolve(repoRoot, '.juno_task/scripts/workflow_runner.sh');

function runWorkflow(args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  return spawnSync('python3', [templateScript, ...args], {
    input,
    cwd: repoRoot,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

async function installFakeJunoExecutable(dir: string, name = 'yy') {
  const binDir = path.join(dir, 'bin');
  await fs.ensureDir(binDir);
  const executablePath = path.join(binDir, name);
  await fs.writeFile(
    executablePath,
    `#!/usr/bin/env sh
if [ "\${1:-}" = "--quiet" ]; then shift; fi
printf 'tool=%s capture=%s\\n' "\${JUNO_TOOL_ID-unset}" "\${JUNO_SUBAGENT_CAPTURE_PATH-unset}"
if [ -n "\${JUNO_SUBAGENT_CAPTURE_PATH:-}" ]; then
  prompt="\${3:-$2}"
  if [ "$prompt" = "invalid" ]; then
    printf '{invalid json' > "$JUNO_SUBAGENT_CAPTURE_PATH"
  else
    printf '{"type":"result","subtype":"success","is_error":false,"result":"captured %s","session_id":"session-%s"}\n' "$prompt" "$prompt" > "$JUNO_SUBAGENT_CAPTURE_PATH"
  fi
fi
`,
  );
  await fs.chmod(executablePath, 0o755);
  return { binDir, executablePath };
}

describe('workflow_runner.sh template script', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-runner-test-'));
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  it('exists in template scripts and remains synced with runtime script', async () => {
    expect(await fs.pathExists(templateScript)).toBe(true);
    expect(await fs.pathExists(runtimeScript)).toBe(true);
    expect(await fs.readFile(templateScript, 'utf8')).toBe(await fs.readFile(runtimeScript, 'utf8'));
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
    expect(result.stdout).toContain('--init-example NAME PATH');
    expect(result.stdout).toContain('production-triage-handoff');
    expect(result.stdout).toContain('parallel-kanban-review');
    expect(result.stdout).toContain('workflow_runner.sh lint --workflow WORKFLOW.yaml');
    expect(result.stdout).toContain('workflow_runner.sh doctor RUN_DIR');
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
    expect(await fs.readFile(path.join(outDir, 'summary.md'), 'utf8')).toBe('AGENT-SUMMARY\n');
    expect(await fs.readFile(path.join(outDir, 'summary.stdout.txt'), 'utf8')).toBe('AGENT-SUMMARY\n');
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
    expect(manifest.steps[0].exit_code).toBe(0);
    expect(manifest.steps[0].failure_reason).toBe('empty response from detected agent command');
  });

  it('prints canonical captured response for juno commands while preserving raw stdout artifacts', async () => {
    const binDir = path.join(testDir, 'verbose-bin');
    await fs.ensureDir(binDir);
    const executablePath = path.join(binDir, 'yy');
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env sh
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
    expect(result.stdout).toContain('Juno session ids:');
    expect(result.stdout).toContain('step 1 [first]: session-alpha');
    expect(result.stdout).toContain('step 2 [second]: session-omega');
    expect(result.stdout).toContain('continue: last session persisted for yy cc');
    const envFile = await fs.readFile(path.join(testDir, '.env.juno'), 'utf8');
    expect(envFile).toContain('session-omega');
    expect(envFile).toContain('JUNO_CODE_LAST_SESSION_ID_SCOPE_');
    expect(envFile).toContain('JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_');
    expect(envFile).toContain('\\"subagent\\":\\"pi\\"');
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
});
