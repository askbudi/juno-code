import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const root = path.resolve(process.cwd(), '..');
const helper = path.resolve(process.cwd(), 'src/templates/scripts/integration_owner_preflight.py');

describe('target-ref integration channel', () => {
  it('is compilable and exposes only receipt-gated CAS integration controls', async () => {
    execFileSync('python3', ['-m', 'py_compile', helper]);
    const source = await fs.readFile(helper, 'utf8');
    expect(source).toContain('git_common_dir');
    expect(source).toContain('update-ref');
    expect(source).toContain('partial_local_integration');
    expect(source).toContain('juno-feature/');
    expect(source).toContain('--actual-review-command');
    expect(source).not.toContain('--checkpoint-controller');
    expect(source).not.toContain('other_write_capable_processes');
  });

  it('passes the real Git candidate/CAS/tag/stale-ref suite', () => {
    execFileSync('python3', [
      path.join(root, '.juno_task/scripts/tests/test_integration_concurrency.py'),
    ], { stdio: 'pipe' });
  });
});
