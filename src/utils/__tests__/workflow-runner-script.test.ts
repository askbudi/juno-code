import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd(), '..');
const templateScript = path.resolve(process.cwd(), 'src/templates/scripts/workflow_runner.sh');
const runtimeScript = path.resolve(repoRoot, '.juno_task/scripts/workflow_runner.sh');

function runWorkflow(args: string[], input?: string) {
  return spawnSync('python3', [templateScript, ...args], {
    input,
    cwd: repoRoot,
    encoding: 'utf8',
  });
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

  it('exits non-zero when a step opts into fail_on_error', async () => {
    const workflowPath = path.join(testDir, 'fail-fast.yml');
    const outDir = path.join(testDir, 'fail-fast-out');
    await fs.writeFile(
      workflowPath,
      `name: fail-fast
steps:
  - id: fail
    command: python3 -c "import sys; sys.exit(9)"
    fail_on_error: true
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
});
