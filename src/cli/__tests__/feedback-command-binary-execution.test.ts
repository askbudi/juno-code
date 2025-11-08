/**
 * Feedback Command Binary Execution Test (headless)
 *
 * Verifies that running the feedback command with flags writes a new ISSUE
 * with optional <Test_CRITERIA> to .juno_task/USER_FEEDBACK.md in a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import * as path from 'node:path';
import * as fs from 'fs-extra';

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const BINARY_MJS = path.join(PROJECT_ROOT, 'dist/bin/cli.mjs');
const BASE_TMP_DIR = process.env.TEST_TMP_DIR || '/tmp';

let tempDir: string;

describe('Feedback Command Binary Execution', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(BASE_TMP_DIR, 'juno-feedback-binary-'));
  });

  afterEach(async () => {
    if (tempDir && await fs.pathExists(tempDir)) {
      try { await fs.remove(tempDir); } catch {}
    }
  });

  it('writes ISSUE with Test_CRITERIA via headless flags', async () => {
    const issue = 'Binary feedback: duplicate logs still present';
    const criteria = 'Run start --verbose and ensure single messages';

    const { exitCode, stdout, stderr } = await execa('node', [
      BINARY_MJS,
      'feedback',
      '--issue', issue,
      '--test', criteria
    ], {
      cwd: tempDir,
      env: { NO_COLOR: '1', NODE_ENV: 'development', JUNO_CODE_CONFIG: '', JUNO_TASK_CONFIG: '' },
      reject: false
    });

    expect(exitCode).toBe(0);
    expect(stdout + stderr).toContain('Feedback added to USER_FEEDBACK.md');

    const feedbackPath = path.join(tempDir, '.juno_task', 'USER_FEEDBACK.md');
    const exists = await fs.pathExists(feedbackPath);
    expect(exists).toBe(true);
    const content = await fs.readFile(feedbackPath, 'utf-8');
    expect(content).toMatch(/<OPEN_ISSUES>[\s\S]*<ISSUE>[\s\S]*Binary feedback:[\s\S]*<Test_CRITERIA>[\s\S]*single messages[\s\S]*<\/Test_CRITERIA>[\s\S]*<\/ISSUE>[\s\S]*<\/OPEN_ISSUES>/);
  });
});

