/**
 * Feedback Command TUI Execution Test
 *
 * Drives the interactive feedback flow, captures raw TUI output,
 * and verifies that USER_FEEDBACK.md is created with ISSUE and optional Test_CRITERIA.
 *
 * Run:
 * - Build first: `npm --prefix juno-task-ts run build`
 * - TUI test: `RUN_TUI=1 npm --prefix juno-task-ts run test:feedback`
 * - Optional env:
 *   - PRESERVE_TMP=1  Keep temp dir
 *   - TEST_TMP_DIR=/tmp  Base tmp dir
 *   - TUI_ARTIFACTS_DIR=...  Artifact output dir
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { execa } from 'execa';
import stripAnsi from 'strip-ansi';

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const BINARY_MJS = path.join(PROJECT_ROOT, 'dist/bin/cli.mjs');
const BASE_TMP_DIR = process.env.TEST_TMP_DIR || '/tmp';
const ARTIFACTS_DIR = process.env.TUI_ARTIFACTS_DIR || path.join(PROJECT_ROOT, 'test-artifacts', 'tui');
const RUN_TUI = process.env.RUN_TUI === '1';
const TUI_TIMEOUT = 60000;

let tempDir: string;
let outputDir: string;

function now(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function saveRawOutput(baseDir: string, content: string): Promise<string> {
  const file = path.join(baseDir, `feedback-command-tui-output-${now()}.txt`);
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

const suite = RUN_TUI ? describe : describe.skip;

suite('Feedback Command TUI Execution', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(BASE_TMP_DIR, 'juno-feedback-tui-'));
    outputDir = path.join(tempDir, 'test-outputs');
    await fs.ensureDir(outputDir);
    await fs.ensureDir(ARTIFACTS_DIR);
  });

  afterEach(async () => {
    if (tempDir && await fs.pathExists(tempDir)) {
      if (process.env.PRESERVE_TMP === '1') {
        // eslint-disable-next-line no-console
        console.log(`🛑 PRESERVE_TMP=1 set. Temp kept at: ${tempDir}`);
      } else {
        try { await fs.remove(tempDir); } catch {}
      }
    }
  });

  it('collects multiline issue and optional test criteria, writing USER_FEEDBACK.md', async () => {
    // Ensure binary exists
    const mjsExists = await fs.pathExists(BINARY_MJS);
    if (!mjsExists) throw new Error(`Binary ${BINARY_MJS} not found. Run build first.`);

    const child = execa('node', [BINARY_MJS, 'feedback', '--interactive'], {
      cwd: tempDir,
      env: {
        ...process.env,
        NO_COLOR: '1',
        NODE_ENV: 'development',
        CI: '',
        FORCE_INTERACTIVE: '1',
        JUNO_TASK_CONFIG: ''
      },
      timeout: TUI_TIMEOUT,
      all: true,
      stdin: 'pipe'
    });

    let buffer = '';
    child.all?.on('data', (d: Buffer | string) => {
      buffer += d.toString();
    });

    const waitFor = async (pattern: RegExp, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const text = stripAnsi(buffer);
        if (pattern.test(text)) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`Timeout waiting for pattern: ${pattern}\nSeen:\n${stripAnsi(buffer)}`);
    };

    // Step 1 prompts
    await waitFor(/📝 Submit Feedback/);
    await waitFor(/📄 Step 1: Describe your issue or feedback/);
    await waitFor(/Describe your issue, bug report, or suggestion/);
    child.stdin?.write('Interactive feedback issue: something is wrong\n');
    child.stdin?.write('with the new feature.\n');
    child.stdin?.write('\n\n'); // double Enter to finish

    // Step 2 prompts and inputs
    await waitFor(/Optional\) Provide Test Criteria/);
    await waitFor(/Add test criteria/);
    child.stdin?.write('y\n');
    await waitFor(/Describe how we should validate the fix/);
    child.stdin?.write('Should reproduce in a temp project and exit cleanly\n');
    child.stdin?.write('\n\n'); // double Enter to finish criteria

    // Completion indicator
    await waitFor(/✅ Feedback added to USER_FEEDBACK.md!/);

    // Wait for process to exit
    try { await child; } catch { /* allow non-zero to bubble via file check */ }

    if (buffer) await saveRawOutput(outputDir, buffer);

    // Validate file system changes
    const feedbackPath = path.join(tempDir, '.juno_task', 'USER_FEEDBACK.md');
    const deadline = Date.now() + 15000;
    while (!(await fs.pathExists(feedbackPath))) {
      if (Date.now() > deadline) throw new Error('Timeout waiting for USER_FEEDBACK.md');
      await new Promise(r => setTimeout(r, 200));
    }

    const content = await fs.readFile(feedbackPath, 'utf-8');
    expect(content).toContain('<OPEN_ISSUES>');
    expect(content).toMatch(/<ISSUE>[\s\S]*Interactive feedback issue:[\s\S]*<\/ISSUE>/);
    expect(content).toMatch(/<Test_CRITERIA>[\s\S]*Should reproduce in a temp project[\s\S]*<\/Test_CRITERIA>/);
  }, TUI_TIMEOUT);
});
