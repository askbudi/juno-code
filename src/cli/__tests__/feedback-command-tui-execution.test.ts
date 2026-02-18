/**
 * Feedback Command TUI Execution Test
 *
 * End-to-end interactive test that drives the TUI with real keystrokes,
 * captures raw output to a file, and verifies USER_FEEDBACK.md creation.
 *
 * How to run:
 * - Build binary first: `npm --prefix juno-code run build`
 * - Run via npm script: `npm --prefix juno-code run test:feedback`
 * - Optional env vars:
 *   - `PRESERVE_TMP=1` keep /tmp test dir for manual inspection
 *   - `TEST_TMP_DIR=/tmp` override base tmp dir (default `/tmp`)
 *   - `TUI_ARTIFACTS_DIR=...` set stable artifact output dir (default: test-artifacts/tui)
 *
 * Test scenarios:
 * 1. Issue with test criteria - full flow
 * 2. Issue without test criteria - minimal flow
 *
 * User flow:
 * 1) Enter multiline issue description, finish with double Enter
 * 2) Optionally add test criteria (y/n), if yes enter multiline criteria
 * 3) Await completion; save raw stdout/stderr; verify USER_FEEDBACK.md
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
    // eslint-disable-next-line no-console
    console.log(`🧪 TUI temp directory: ${tempDir}`);

    const mjsExists = await fs.pathExists(BINARY_MJS);
    if (!mjsExists) {
      throw new Error(`Binary ${BINARY_MJS} not found. Run 'npm run build' first.`);
    }
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

  it('should collect multiline issue with test criteria and write USER_FEEDBACK.md', async () => {
    let fullBuffer = '';

    const child = execa('node', [BINARY_MJS, 'feedback', '--interactive'], {
      cwd: tempDir,
      env: {
        ...process.env,
        NO_COLOR: '1',
        NODE_ENV: 'development',
        CI: '',
        FORCE_INTERACTIVE: '1',
        JUNO_CODE_CONFIG: '',
        JUNO_TASK_CONFIG: '', // Backward compatibility
        TERM: 'xterm-256color'
      },
      timeout: TUI_TIMEOUT,
      all: true,
      stdin: 'pipe'
    });

    child.all?.on('data', (d: Buffer | string) => {
      fullBuffer += d.toString();
    });

    const waitFor = async (pattern: RegExp, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const text = stripAnsi(fullBuffer);
        if (pattern.test(text)) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`Timeout waiting for pattern: ${pattern}\nSeen:\n${stripAnsi(fullBuffer)}`);
    };

    try {
      // Step 1: Issue description prompts
      await waitFor(/📝 Submit Feedback/);
      await waitFor(/📄 Step 1: Describe your issue or feedback/);
      await waitFor(/Describe your issue, bug report, or suggestion/);
      
      // Enter multiline issue
      child.stdin?.write('Interactive feedback issue: something is wrong\n');
      child.stdin?.write('with the new feature.\n');
      child.stdin?.write('This needs to be fixed urgently.\n');
      child.stdin?.write('\n\n'); // double Enter to finish

      // Step 2: Test criteria prompts
      await waitFor(/🧪 Step 2: \(Optional\) Provide Test Criteria/);
      await waitFor(/Would you like to add test criteria/);
      await waitFor(/Add test criteria/);
      child.stdin?.write('y\n'); // Yes, add test criteria
      
      await waitFor(/Describe how we should validate the fix/);
      child.stdin?.write('Should reproduce in a temp project and exit cleanly\n');
      child.stdin?.write('Test should verify the fix works correctly\n');
      child.stdin?.write('\n\n'); // double Enter to finish criteria

      // Completion indicator
      await waitFor(/✅ Feedback added to USER_FEEDBACK.md!/);

      // Wait for process to exit
      try { await child; } catch { /* allow non-zero to bubble via file check */ }

      // Save raw output (temp + stable artifacts)
      const cleaned = stripAnsi(fullBuffer);
      const savedPath = await saveRawOutput(outputDir, cleaned);
      const stablePath = path.join(ARTIFACTS_DIR, `feedback-command-tui-output-${now()}.txt`);
      await fs.writeFile(stablePath, cleaned, 'utf-8');
      // eslint-disable-next-line no-console
      console.log(`📄 Raw TUI output saved: ${savedPath}`);
      // eslint-disable-next-line no-console
      console.log(`📦 Raw TUI artifact saved: ${stablePath}`);
      // eslint-disable-next-line no-console
      console.log(`🧭 Inspect temp dir: ${tempDir}`);

      // Validate file system changes
      const feedbackPath = path.join(tempDir, '.juno_task', 'USER_FEEDBACK.md');
      const deadline = Date.now() + 15000;
      while (!(await fs.pathExists(feedbackPath))) {
        if (Date.now() > deadline) throw new Error('Timeout waiting for USER_FEEDBACK.md');
        await new Promise(r => setTimeout(r, 200));
      }

      const content = await fs.readFile(feedbackPath, 'utf-8');
      
      // Verify structure
      expect(content).toContain('<OPEN_ISSUES>');
      expect(content).toContain('</OPEN_ISSUES>');
      
      // Verify issue content
      expect(content).toMatch(/<ISSUE>[\s\S]*Interactive feedback issue:[\s\S]*something is wrong[\s\S]*with the new feature[\s\S]*<\/ISSUE>/);
      
      // Verify test criteria content
      expect(content).toMatch(/<Test_CRITERIA>[\s\S]*Should reproduce in a temp project[\s\S]*Test should verify the fix works correctly[\s\S]*<\/Test_CRITERIA>/);
      
      // Verify date is present
      expect(content).toMatch(/<DATE>\d{4}-\d{2}-\d{2}<\/DATE>/);

      // eslint-disable-next-line no-console
      console.log('\n✅ Test completed successfully');
      // eslint-disable-next-line no-console
      console.log(`📋 Feedback file: ${feedbackPath}`);

    } catch (err) {
      // On failure, save whatever we saw for debugging (temp + stable)
      const cleaned = stripAnsi(fullBuffer);
      const savedPath = await saveRawOutput(outputDir, cleaned);
      const stablePath = path.join(ARTIFACTS_DIR, `feedback-command-tui-output-${now()}.txt`);
      await fs.writeFile(stablePath, cleaned, 'utf-8');
      // eslint-disable-next-line no-console
      console.log(`❌ TUI test failed. Raw output saved: ${savedPath}`);
      // eslint-disable-next-line no-console
      console.log(`📦 Raw TUI artifact saved: ${stablePath}`);
      // eslint-disable-next-line no-console
      console.log(`🧭 Inspect temp dir: ${tempDir}`);
      throw err;
    } finally {
      try { if (child.stdin) child.stdin.end(); } catch {}
    }
  }, TUI_TIMEOUT);

  it('should collect multiline issue without test criteria and write USER_FEEDBACK.md', async () => {
    let fullBuffer = '';

    const child = execa('node', [BINARY_MJS, 'feedback', '--interactive'], {
      cwd: tempDir,
      env: {
        ...process.env,
        NO_COLOR: '1',
        NODE_ENV: 'development',
        CI: '',
        FORCE_INTERACTIVE: '1',
        JUNO_CODE_CONFIG: '',
        JUNO_TASK_CONFIG: '', // Backward compatibility
        TERM: 'xterm-256color'
      },
      timeout: TUI_TIMEOUT,
      all: true,
      stdin: 'pipe'
    });

    child.all?.on('data', (d: Buffer | string) => {
      fullBuffer += d.toString();
    });

    const waitFor = async (pattern: RegExp, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const text = stripAnsi(fullBuffer);
        if (pattern.test(text)) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`Timeout waiting for pattern: ${pattern}\nSeen:\n${stripAnsi(fullBuffer)}`);
    };

    try {
      // Step 1: Issue description prompts
      await waitFor(/📝 Submit Feedback/);
      await waitFor(/📄 Step 1: Describe your issue or feedback/);
      await waitFor(/Describe your issue, bug report, or suggestion/);
      
      // Enter multiline issue
      child.stdin?.write('Simple feedback without test criteria\n');
      child.stdin?.write('This is a basic issue report.\n');
      child.stdin?.write('\n\n'); // double Enter to finish

      // Step 2: Test criteria prompts - decline
      await waitFor(/🧪 Step 2: \(Optional\) Provide Test Criteria/);
      await waitFor(/Would you like to add test criteria/);
      await waitFor(/Add test criteria/);
      child.stdin?.write('n\n'); // No, skip test criteria

      // Completion indicator
      await waitFor(/✅ Feedback added to USER_FEEDBACK.md!/);

      // Wait for process to exit
      try { await child; } catch { /* allow non-zero to bubble via file check */ }

      // Save raw output
      const cleaned = stripAnsi(fullBuffer);
      const savedPath = await saveRawOutput(outputDir, cleaned);
      const stablePath = path.join(ARTIFACTS_DIR, `feedback-command-tui-output-no-criteria-${now()}.txt`);
      await fs.writeFile(stablePath, cleaned, 'utf-8');

      // Validate file system changes
      const feedbackPath = path.join(tempDir, '.juno_task', 'USER_FEEDBACK.md');
      const deadline = Date.now() + 15000;
      while (!(await fs.pathExists(feedbackPath))) {
        if (Date.now() > deadline) throw new Error('Timeout waiting for USER_FEEDBACK.md');
        await new Promise(r => setTimeout(r, 200));
      }

      const content = await fs.readFile(feedbackPath, 'utf-8');
      
      // Verify structure
      expect(content).toContain('<OPEN_ISSUES>');
      
      // Verify issue content
      expect(content).toMatch(/<ISSUE>[\s\S]*Simple feedback without test criteria[\s\S]*This is a basic issue report[\s\S]*<\/ISSUE>/);
      
      // Verify NO test criteria
      expect(content).not.toContain('<Test_CRITERIA>');
      
      // Verify date is present
      expect(content).toMatch(/<DATE>\d{4}-\d{2}-\d{2}<\/DATE>/);

    } catch (err) {
      const cleaned = stripAnsi(fullBuffer);
      const savedPath = await saveRawOutput(outputDir, cleaned);
      const stablePath = path.join(ARTIFACTS_DIR, `feedback-command-tui-output-no-criteria-${now()}.txt`);
      await fs.writeFile(stablePath, cleaned, 'utf-8');
      // eslint-disable-next-line no-console
      console.log(`❌ TUI test failed. Raw output saved: ${savedPath}`);
      throw err;
    } finally {
      try { if (child.stdin) child.stdin.end(); } catch {}
    }
  }, TUI_TIMEOUT);
});
