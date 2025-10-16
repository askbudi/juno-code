/**
 * Concurrent Feedback Collector
 *
 * Minimal multi-submit feedback collector that runs concurrently with ongoing processes.
 * - Type/paste feedback (multiline)
 * - Press Enter on a BLANK line to SUBMIT that block
 * - The feedback block is sent to feedback command via stdin for each submission
 * - Multiple blocks allowed; exit with EOF (Ctrl-D / Ctrl-Z then Enter) or Ctrl-C
 * - Progress logs go to stderr; UI/instructions to stdout
 * - NO TTY/Raw mode - simple line-based stdin for AI agent compatibility
 *
 * Usage:
 *   juno-collect-feedback <command> [arg1 arg2 ...]
 * Example:
 *   juno-collect-feedback node dist/bin/cli.mjs feedback
 *   juno-collect-feedback juno-ts-task feedback
 *
 * OR run standalone:
 *   node dist/bin/feedback-collector.mjs
 */

import { spawn } from 'node:child_process';
import { EOL } from 'node:os';

// Enable UTF-8 encoding for stdin
process.stdin.setEncoding('utf8');

// --- Parse command to run per submission ---
const [, , ...argv] = process.argv;
const cmd = argv.length > 0 ? argv[0] : 'node';
const cmdArgs = argv.length > 0 ? argv.slice(1) : ['dist/bin/cli.mjs', 'feedback'];

// --- Progress ticker (simulates concurrent progress) ---
let tick = 0;
const start = Date.now();
const logTimer = setInterval(() => {
  tick += 1;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  process.stderr.write(`[progress] step=${tick} elapsed=${elapsed}s${EOL}`);
}, 1200);

// --- UI header ---
function printHeader(): void {
  process.stdout.write(
    [
      '',
      '📝 Concurrent Feedback Collector',
      '   Type or paste your feedback. Submit by pressing Enter on an EMPTY line.',
      '   (EOF ends the session: Ctrl-D on macOS/Linux; Ctrl-Z then Enter on Windows.)',
      ''
    ].join(EOL) + EOL
  );
}
printHeader();

// --- Submission queue to keep commands sequential ---
let pending = Promise.resolve();
let submissionCount = 0;

/**
 * Run feedback command with the collected input
 */
function runCommandWithInput(input: string): Promise<number> {
  submissionCount += 1;
  const n = submissionCount;
  process.stderr.write(`${EOL}[submit ${n}] launching "${cmd}" ${cmdArgs.join(' ')}${EOL}`);

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    // Pipe child's output to stderr (treat as logs)
    child.stdout?.on('data', (d) => process.stderr.write(`[submit ${n}] stdout: ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`[submit ${n}] stderr: ${d}`));

    child.on('close', (code) => {
      process.stderr.write(`[submit ${n}] exit code ${code ?? 0}${EOL}`);
      resolve(code ?? 0);
    });

    child.on('error', (err) => {
      process.stderr.write(`[submit ${n}] error: ${err.message}${EOL}`);
      resolve(1);
    });

    // Write the feedback block to child stdin
    if (child.stdin) {
      child.stdin.write(input);
      if (!input.endsWith(EOL)) {
        child.stdin.write(EOL);
      }
      child.stdin.end();
    }
  });
}

/**
 * Enqueue submission to ensure strict sequential order
 */
function enqueueSubmission(input: string): Promise<void> {
  // Ensure strict order by chaining onto `pending`
  pending = pending.then(() => runCommandWithInput(input).then(() => {}));
  return pending;
}

// --- Input handling: multiline buffer; blank line => submit ---
let carry = '';
let buffer = ''; // current feedback block
let lastLineWasBlank = false;

/**
 * Submit the current buffer if it has content
 */
function submitBufferIfAny(): void {
  const content = buffer.trimEnd();
  buffer = ''; // "clean stdin" buffer for the next round

  if (content.length === 0) {
    return;
  }

  process.stdout.write(EOL + '===== SUBMITTING FEEDBACK BLOCK =====' + EOL);
  process.stdout.write(content + EOL);
  process.stdout.write('===== END BLOCK =====' + EOL);

  enqueueSubmission(content).then(() => {
    // After the command finishes (still sequential), re-prompt
    process.stdout.write(EOL + '✅ Submission processed. You can type another block.' + EOL);
  }).catch((err) => {
    process.stderr.write(`Error submitting feedback: ${err}${EOL}`);
  });
}

// Handle stdin data events
process.stdin.on('data', (chunk: string) => {
  carry += chunk;

  // Split into complete lines, keep the last partial in carry
  const parts = carry.split(/\r?\n/);
  carry = parts.pop() ?? '';

  for (const line of parts) {
    const isBlank = line.trim().length === 0;

    if (isBlank && !lastLineWasBlank) {
      // A single blank line means "submit this block"
      submitBufferIfAny();
      lastLineWasBlank = true;
      continue;
    }

    if (!isBlank) {
      // Any non-blank line is part of the current block
      buffer += line + EOL;
      lastLineWasBlank = false;
    } else {
      // Consecutive blank lines: ignore (prevent accidental multiple submits)
      lastLineWasBlank = true;
    }
  }
});

// Handle stdin end event (EOF)
process.stdin.on('end', async () => {
  // If there is remaining partial data, treat as part of the last block
  if (carry.length) {
    buffer += carry;
  }

  submitBufferIfAny();
  await pending; // wait for in-flight submissions

  clearInterval(logTimer);
  process.stderr.write(`${EOL}[progress] done. submissions=${submissionCount}${EOL}`);
  process.exit(0);
});

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  process.stderr.write(`${EOL}[progress] SIGINT received. Finalizing…${EOL}`);

  submitBufferIfAny();
  await pending;

  clearInterval(logTimer);
  process.stderr.write(`[progress] done. submissions=${submissionCount}${EOL}`);
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  process.stderr.write(`${EOL}[error] Uncaught exception: ${err.message}${EOL}`);
  clearInterval(logTimer);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${EOL}[error] Unhandled rejection: ${reason}${EOL}`);
  clearInterval(logTimer);
  process.exit(1);
});
