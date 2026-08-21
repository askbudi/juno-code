import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd(), '..');
const templateScript = path.resolve(process.cwd(), 'src/templates/scripts/parallel_runner.sh');
const runtimeScript = path.resolve(repoRoot, '.juno_task/scripts/parallel_runner.sh');

/**
 * The runtime guard must fire before any later import or runtime type
 * evaluation can surface an opaque interpreter error. We simulate an
 * unsupported interpreter by faking sys.version_info before executing the
 * script, which exercises the guard exactly as an old host Python would.
 */
function runGuardProbe(scriptPath: string, fakedVersion: string) {
  const probe = [
    'import sys, runpy',
    `sys.version_info = ${fakedVersion}`,
    `runpy.run_path(${JSON.stringify(scriptPath)}, run_name="__main__")`,
  ].join('\n');
  return spawnSync('python3', ['-c', probe], { encoding: 'utf8' });
}

describe('parallel_runner.sh Python runtime guard', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-runner-guard-test-'));
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  it('keeps the template and runtime script byte-identical', async () => {
    expect(await fs.pathExists(runtimeScript)).toBe(true);
    expect(await fs.readFile(templateScript, 'utf8')).toBe(await fs.readFile(runtimeScript, 'utf8'));
  });

  it('parses on a modern interpreter without triggering the guard', () => {
    const result = spawnSync('python3', ['-c',
      'import ast, sys; ast.parse(open(sys.argv[1]).read())', templateScript], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  it('fails early with actionable guidance on an unsupported interpreter', () => {
    for (const script of [templateScript, runtimeScript]) {
      const result = runGuardProbe(script, '(3, 8, 10, "final", 0)');
      expect(result.status).not.toBe(0);
      const output = result.stderr;
      expect(output).toContain('parallel_runner: unsupported Python 3.8.10');
      expect(output).toContain('3.10 or newer is required');
      expect(output).toContain('Detected interpreter:');
      // Fallback guidance is present even when no managed runtime exists.
      expect(output).toContain('yy scripts update --force');
      expect(output).toContain('.venv_juno/bin/python');
      // No opaque traceback may precede the guard message.
      const tracebackIndex = output.indexOf('Traceback');
      const guardIndex = output.indexOf('parallel_runner: unsupported Python');
      if (tracebackIndex !== -1) {
        expect(guardIndex).toBeLessThan(tracebackIndex);
      }
    }
  });

  it('recommends the managed virtualenv interpreter when one is present', async () => {
    const projectRoot = path.join(testDir, 'project');
    await fs.ensureDir(projectRoot);
    const scripts = path.join(projectRoot, '.juno_task', 'scripts');
    await fs.ensureDir(scripts);
    await fs.copy(templateScript, path.join(scripts, 'parallel_runner.sh'));
    const venvPython = path.join(projectRoot, '.venv_juno', 'bin', 'python');
    await fs.ensureDir(path.dirname(venvPython));
    await fs.writeFile(venvPython, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = runGuardProbe(path.join(scripts, 'parallel_runner.sh'), '(3, 9, 18, "final", 0)');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('parallel_runner: unsupported Python 3.9.18');
    expect(result.stderr).toContain(`${venvPython} ${path.join(scripts, 'parallel_runner.sh')} --help`);
  });
});
