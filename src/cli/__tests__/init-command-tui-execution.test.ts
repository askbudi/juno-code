/**
 * Init Command TUI Execution Test
 *
 * End-to-end interactive test that drives the TUI with real keystrokes,
 * captures raw output to a file, and verifies expected files in .juno_task.
 *
 * How to run:
 * - Build binary first: `npm --prefix juno-task-ts run build`
 * - Run via npm script: `npm --prefix juno-task-ts run test:tui`
 * - Optional env vars:
 *   - `PRESERVE_TMP=1` keep /tmp test dir for manual inspection
 *   - `TEST_TMP_DIR=/tmp` override base tmp dir (default `/tmp`)
 *   - `TUI_ARTIFACTS_DIR=...` set stable artifact output dir (default: test-artifacts/tui)
 *
 * User flow (as requested):
 * 1) Press Enter on the first question (directory)
 * 2) Enter: "Count number of folders in this directory and give me a report"
 *    then press Enter twice (finish multi-line input)
 * 3) Enter: 2 (select Codex)
 * 4) Enter: y (enable Git setup)
 * 5) Enter: https://github.com/askbudi/temp-test-ts-repo
 * 6) Await completion; save raw stdout/stderr; verify files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import stripAnsi from 'strip-ansi';
// Try to load node-pty; if unavailable for current Node, skip this suite.
let pty: typeof import('node-pty') | null = null;
let PTY_AVAILABLE = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pty = require('node-pty');
  PTY_AVAILABLE = !!pty;
} catch {
  PTY_AVAILABLE = false;
}

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const BINARY_MJS = path.join(PROJECT_ROOT, 'dist/bin/cli.mjs');
const BASE_TMP_DIR = process.env.TEST_TMP_DIR || '/tmp';
const ARTIFACTS_DIR = process.env.TUI_ARTIFACTS_DIR || path.join(PROJECT_ROOT, 'test-artifacts', 'tui');

const TUI_TIMEOUT = 60000; // 60 seconds for fast iteration
const RUN_TUI = process.env.RUN_TUI === '1';

let tempDir: string;
let outputDir: string;
let ptyProcess: import('node-pty').IPty | null = null;

function now(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function saveRawOutput(baseDir: string, content: string): Promise<string> {
  const file = path.join(baseDir, `init-command-tui-output-${now()}.txt`);
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

function waitForOutput(ptyProc: pty.IPty, regex: RegExp, options: { timeout?: number } = {}): Promise<string> {
  const { timeout = TUI_TIMEOUT } = options;

  return new Promise((resolve, reject) => {
    let buffer = '';
    let timer: NodeJS.Timeout;

    const onData = (data: string) => {
      buffer += data;
      const cleaned = stripAnsi(buffer);
      if (regex.test(cleaned)) {
        ptyProc.removeListener('data', onData);
        if (timer) clearTimeout(timer);
        resolve(cleaned);
      }
    };

    timer = setTimeout(() => {
      ptyProc.removeListener('data', onData);
      reject(new Error(`Timeout waiting for pattern: ${regex}\nReceived output:\n${stripAnsi(buffer)}`));
    }, timeout);

    ptyProc.on('data', onData);
  });
}

// Skip when PTY is not available, or not explicitly enabled
const suite = RUN_TUI && PTY_AVAILABLE ? describe : describe.skip;

suite('Init Command TUI Execution', () => {
  // No-op: PTY is pre-detected; if unavailable, suite is skipped.
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(BASE_TMP_DIR, 'juno-init-tui-'));
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
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch {}
      ptyProcess = null;
    }
    // Preserve temp dir for manual inspection when requested
    if (tempDir && await fs.pathExists(tempDir)) {
      if (process.env.PRESERVE_TMP === '1') {
        // eslint-disable-next-line no-console
        console.log(`🛑 PRESERVE_TMP=1 set. Temp kept at: ${tempDir}`);
      } else {
        try { await fs.remove(tempDir); } catch {}
      }
    }
  });

  it('should complete interactive init flow and create required files', async () => {
    let fullBuffer = '';

    // Spawn the CLI in a PTY
    if (!pty) {
      // Safety check, should be handled earlier
      throw new Error('node-pty not available');
    }

    ptyProcess = pty.spawn('node', [BINARY_MJS, 'init'], {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: tempDir,
      env: {
        ...process.env,
        NO_COLOR: '1',
        NODE_ENV: 'development',
        CI: '',
        FORCE_INTERACTIVE: '1',
        JUNO_TASK_CONFIG: '',
        TERM: 'xterm-256color'
      }
    });

    ptyProcess.on('data', (d) => { fullBuffer += d; });

    try {
      // Step 1: Directory prompt, accept default (current tempDir)
      await waitForOutput(ptyProcess, /Directory path/);
      ptyProcess.write('\r');

      // Step 2: Task multi-line input
      await waitForOutput(ptyProcess, /📝 Step 2: Main Task/);
      await waitForOutput(ptyProcess, /Describe what you want to build/);
      ptyProcess.write('Count number of folders in this directory and give me a report');
      ptyProcess.write('\r'); // submit first line
      // Finish with double Enter (preserve blank lines in content)
      ptyProcess.write('\r');
      ptyProcess.write('\r');

      // Step 3: Subagent selection -> choose 2 (Codex)
      await waitForOutput(ptyProcess, /👨‍💻 Step 3: Select Coding Editor/);
      await waitForOutput(ptyProcess, /Subagent choice/);
      ptyProcess.write('2');
      ptyProcess.write('\r');

      // Step 4: Git setup -> y, then enter URL
      await waitForOutput(ptyProcess, /🔗 Step 4: Git Setup/);
      await waitForOutput(ptyProcess, /Git setup/);
      ptyProcess.write('y');
      ptyProcess.write('\r');

      await waitForOutput(ptyProcess, /Git URL/);
      ptyProcess.write('https://github.com/askbudi/temp-test-ts-repo');
      ptyProcess.write('\r');

      // Step 5: Save and generation
      await waitForOutput(ptyProcess, /💾 Step 5: Save Project/);
      await waitForOutput(ptyProcess, /✅ Setup complete! Creating project/);

      // Generation messages
      await waitForOutput(ptyProcess, /📁 Creating project directory/);
      await waitForOutput(ptyProcess, /⚙️ Creating project configuration/);
      await waitForOutput(ptyProcess, /🔧 Setting up MCP configuration/);
      await waitForOutput(ptyProcess, /📄 Creating production-ready project files/);

      // Allow generator to finish and process to exit
      // We'll wait for .juno_task/init.md to appear as a signal
      const initPath = path.join(tempDir, '.juno_task', 'init.md');
      const deadline = Date.now() + 30000;
      while (!(await fs.pathExists(initPath))) {
        if (Date.now() > deadline) throw new Error('Timeout waiting for .juno_task/init.md');
        await new Promise(r => setTimeout(r, 300));
      }

      // Save raw output (temp + stable artifacts)
      const cleaned = stripAnsi(fullBuffer);
      const savedPath = await saveRawOutput(outputDir, cleaned);
      const stablePath = path.join(ARTIFACTS_DIR, `init-command-tui-output-${now()}.txt`);
      await fs.writeFile(stablePath, cleaned, 'utf-8');
      console.log(`📄 Raw TUI output saved: ${savedPath}`);
      console.log(`📦 Raw TUI artifact saved: ${stablePath}`);
      console.log(`🧭 Inspect temp dir: ${tempDir}`);

      // Verify required files
      const required = [
        'init.md',
        'prompt.md',
        'USER_FEEDBACK.md',
        'mcp.json',
        'config.json'
      ];

      for (const f of required) {
        const p = path.join(tempDir, '.juno_task', f);
        const exists = await fs.pathExists(p);
        expect(exists).toBe(true);
      }

      // Optional: Validate chosen subagent and git URL in init.md
      const initContent = await fs.readFile(initPath, 'utf-8');
      expect(initContent).toContain('Count number of folders in this directory and give me a report');
      expect(initContent.toLowerCase()).toContain('preferred subagent');
      expect(initContent).toContain('codex');
      expect(initContent).toContain('https://github.com/askbudi/temp-test-ts-repo');

    } catch (err) {
      // On failure, save whatever we saw for debugging (temp + stable)
      const cleaned = stripAnsi(fullBuffer);
      const savedPath = await saveRawOutput(outputDir, cleaned);
      const stablePath = path.join(ARTIFACTS_DIR, `init-command-tui-output-${now()}.txt`);
      await fs.writeFile(stablePath, cleaned, 'utf-8');
      console.log(`❌ TUI test failed. Raw output saved: ${savedPath}`);
      console.log(`📦 Raw TUI artifact saved: ${stablePath}`);
      console.log(`🧭 Inspect temp dir: ${tempDir}`);
      throw err;
    } finally {
      try { if (ptyProcess) ptyProcess.kill(); } catch {}
      ptyProcess = null;
    }
  }, TUI_TIMEOUT);
});
