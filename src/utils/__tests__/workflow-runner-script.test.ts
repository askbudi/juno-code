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
    expect(result.stdout).toContain('--var NAME=VALUE');
    expect(result.stdout).toContain('--run-root');
    expect(result.stdout).toContain('--print-output');
    expect(result.stdout).toContain('summary, none, <step_id>, or');
    expect(result.stdout).toContain('step:<step_id>');
    expect(result.stdout).toContain('--print-step-stdout');
    expect(result.stdout).toContain('--no-print-step-stdout');
    expect(result.stdout).toContain('--init-example NAME PATH');
    expect(result.stdout).toContain('fail_workflow: true');
    expect(result.stdout).toContain('juno-code, yy, and ypl');
    expect(result.stdout).toContain('capture_session: false');
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
    for (const name of ['agent-chain', 'command-pipeline', 'daily-ops']) {
      const target = path.join(testDir, `${name}.yaml`);
      const result = runWorkflow(['--init-example', name, target]);
      expect(result.status).toBe(0);
      expect(await fs.pathExists(target)).toBe(true);
    }
    expect(await fs.pathExists(path.join(repoRoot, '.juno_task', 'workflows', 'agent_chain.yaml'))).toBe(false);
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

  it('auto-detects argv juno commands, reads capture JSON, and exposes session templates', async () => {
    const { executablePath } = await installFakeJunoExecutable(testDir, 'yy');
    const workflowPath = path.join(testDir, 'argv-capture.json');
    const outDir = path.join(testDir, 'argv-capture-out');
    await fs.writeJson(workflowPath, {
      name: 'argv-capture',
      steps: [
        { id: 'first', command: [executablePath, 'pi', 'alpha'] },
        { id: 'resume', command: "printf 'resume={{ steps.first.session_id }} result={{ steps.first.capture_result }}'" },
      ],
    });

    const result = runWorkflow(['--workflow', workflowPath, '--out-dir', outDir, '--print-output', 'resume']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('resume=session-alpha result=captured alpha');
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
