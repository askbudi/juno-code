import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd(), '..');
const runtimeScript = path.resolve(repoRoot, '.juno_task/scripts/run_until_completion.sh');
const templateScript = path.resolve(process.cwd(), 'src/templates/scripts/run_until_completion.sh');

/**
 * Real-script regression for the outer iteration bound. A mock juno-code on
 * PATH records every inner invocation; a mock kanban.sh always reports one
 * pending task so the only thing that can stop the loop is the outer bound.
 */
describe('run_until_completion.sh outer --max-iterations bound', () => {
  let testDir: string;
  let projectDir: string;
  let invocationLog: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-until-outer-test-'));
    projectDir = path.join(testDir, 'project');
    invocationLog = path.join(testDir, 'invocations.log');
    const scripts = path.join(projectDir, '.juno_task', 'scripts');
    await fs.ensureDir(scripts);
    await fs.copy(runtimeScript, path.join(scripts, 'run_until_completion.sh'));
    await fs.chmod(path.join(scripts, 'run_until_completion.sh'), 0o755);
    await fs.writeFile(path.join(scripts, 'kanban.sh'), [
      '#!/usr/bin/env bash',
      'echo "[{\\"id\\": \\"MOCK1\\", \\"status\\": \\"todo\\"}]"',
      'echo "{\\"backlog\\":0,\\"done\\":0,\\"in_progress\\":0,\\"todo\\":1,\\"archive\\":0,\\"total\\":1}"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    const stubBin = path.join(testDir, 'bin');
    await fs.ensureDir(stubBin);
    await fs.writeFile(path.join(stubBin, 'juno-code'), [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(invocationLog)}`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    process.env.PATH = `${stubBin}${path.delimiter}${process.env.PATH}`;
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [path.join(projectDir, '.juno_task', 'scripts', 'run_until_completion.sh'), ...args], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
  }

  function recordedInvocations(): string[] {
    if (!fs.existsSync(invocationLog)) return [];
    return fs.readFileSync(invocationLog, 'utf8').split('\n').filter((line) => line.length > 0);
  }

  it('keeps the template and runtime script byte-identical', async () => {
    expect(await fs.pathExists(runtimeScript)).toBe(true);
    expect(await fs.readFile(templateScript, 'utf8')).toBe(await fs.readFile(runtimeScript, 'utf8'));
  });

  it('bounds the outer loop to exactly one iteration for a one-pass session', () => {
    const result = runScript(['--max-iterations', '1', '-p', 'one-pass review']);
    expect(result.status).toBe(0);
    const invocations = recordedInvocations();
    // A completed one-pass session must not silently start a duplicate run.
    expect(invocations).toHaveLength(1);
    // The outer bound never reaches the inner agent invocation.
    expect(invocations[0]).not.toContain('--max-iterations');
    expect(invocations[0]).toBe('-p one-pass review');
  });

  it('bounds the outer loop to N iterations and keeps the flag away from inner runs', () => {
    const result = runScript(['--max-iterations=2', '-p', 'hello']);
    expect(result.status).toBe(0);
    const invocations = recordedInvocations();
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(invocation).not.toContain('--max-iterations');
      expect(invocation).toBe('-p hello');
    }
  });

  it('still honors JUNO_RUN_UNTIL_MAX_ITERATIONS as the environment fallback', () => {
    const result = runScript(['-p', 'hello'], { JUNO_RUN_UNTIL_MAX_ITERATIONS: '1' });
    expect(result.status).toBe(0);
    expect(recordedInvocations()).toHaveLength(1);
  });

  it('rejects invalid --max-iterations values before starting any session', () => {
    const result = runScript(['--max-iterations', 'NaN']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--max-iterations must be a non-negative integer');
    expect(recordedInvocations()).toHaveLength(0);
  });
});
