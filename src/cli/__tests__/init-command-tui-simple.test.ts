/**
 * Simple TUI Test to verify node-pty functionality
 * This is a minimal test to verify that node-pty can interact with the init command
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import pty from 'node-pty';
import stripAnsi from 'strip-ansi';

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const BINARY_MJS = path.join(PROJECT_ROOT, 'dist/bin/cli.mjs');
const TUI_TIMEOUT = 30000; // 30 seconds for simple test

let tempDir: string;
let ptyProcess: pty.IPty | null = null;

function waitForOutput(
  ptyProc: pty.IPty,
  regex: RegExp,
  options: { timeout?: number } = {}
): Promise<string> {
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
      reject(new Error(
        `Timeout waiting for pattern: ${regex}\n` +
        `Received output:\n${stripAnsi(buffer)}`
      ));
    }, timeout);

    ptyProc.on('data', onData);
  });
}

describe('Simple TUI Verification', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-simple-tui-'));
    const mjsExists = await fs.pathExists(BINARY_MJS);
    if (!mjsExists) {
      throw new Error(`Binary ${BINARY_MJS} not found. Run 'npm run build' first.`);
    }
  });

  afterEach(async () => {
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch (error) {
        // Ignore errors during cleanup
      }
      ptyProcess = null;
    }

    if (tempDir && await fs.pathExists(tempDir)) {
      try {
        await fs.remove(tempDir);
      } catch (error) {
        // Ignore errors during cleanup
      }
    }
  });

  it('should start interactive mode and show first prompt', async () => {
    console.log('🧪 Testing basic TUI startup...');

    // Create PTY process
    ptyProcess = pty.spawn('node', [BINARY_MJS, 'init'], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
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
      }
    });

    try {
      // Wait for interactive setup message
      console.log('🔍 Waiting for interactive setup message...');
      const output1 = await waitForOutput(
        ptyProcess,
        /🚀 Starting simple interactive setup.../
      );

      console.log('✅ Found interactive setup message');
      expect(stripAnsi(output1)).toContain('🚀 Starting simple interactive setup...');

      // Wait for project directory prompt
      console.log('🔍 Waiting for project directory prompt...');
      const output2 = await waitForOutput(
        ptyProcess,
        /📁 Step 1: Project Directory.*Enter the target directory for your project/
      );

      console.log('✅ Found project directory prompt');
      expect(stripAnsi(output2)).toContain('📁 Step 1: Project Directory');
      expect(stripAnsi(output2)).toContain('Enter the target directory for your project');

      // Send Enter to accept default
      console.log('📝 Sending Enter to accept default directory...');
      ptyProcess.write('\r');

      // Wait a moment for the next prompt
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Kill the process gracefully
      ptyProcess.write('\x03'); // Ctrl+C

      console.log('✅ Simple TUI test completed successfully');

    } catch (error) {
      console.error('❌ Simple TUI test failed:', error);
      throw error;
    }
  }, TUI_TIMEOUT);
});