/**
 * Concurrent Feedback Collector Utility
 *
 * Reusable class for collecting multiline feedback while other processes are running.
 * - Type/paste feedback (multiline)
 * - Press Enter on a BLANK line to SUBMIT that block
 * - Alternative: Type --- on a line by itself to submit
 * - Multiple blocks allowed; exit with EOF (Ctrl-D / Ctrl-Z then Enter) or Ctrl-C
 * - Progress logs go to stderr; UI/instructions to stdout
 * - NO TTY/Raw mode - simple line-based stdin for AI agent compatibility
 *
 * Can be used standalone or integrated into other commands.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EOL } from 'node:os';
import chalk from 'chalk';
import { setFeedbackActive, isFeedbackActive, flushBufferedProgress, setInputRedisplayCallback } from './feedback-state.js';

export interface FeedbackCollectorOptions {
  /**
   * Command to run for each feedback submission
   * @default 'juno-ts-task'
   */
  command?: string;

  /**
   * Arguments for the feedback command
   * @default ['juno-ts-task', 'feedback']
   */
  commandArgs?: string[];

  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;

  /**
   * Show header/instructions
   * @default true
   */
  showHeader?: boolean;

  /**
   * Custom progress ticker interval (ms)
   * @default 0 (disabled)
   */
  progressInterval?: number;

  /**
   * Progress flush interval (ms) - how often to display buffered progress
   * @default 2000 (2 seconds)
   */
  progressFlushInterval?: number;

  /**
   * Custom feedback submission handler
   * If provided, this will be called instead of spawning the command
   */
  onSubmit?: (feedback: string) => Promise<void>;
}

export interface FeedbackSubmission {
  content: string;
  timestamp: Date;
  submissionNumber: number;
}

/**
 * Concurrent Feedback Collector
 *
 * Manages multiline input collection concurrently with other processes.
 */
export class ConcurrentFeedbackCollector {
  private options: Required<Omit<FeedbackCollectorOptions, 'onSubmit'>> & Pick<FeedbackCollectorOptions, 'onSubmit'>;
  private submissionCount: number = 0;
  private pending: Promise<void> = Promise.resolve();
  private buffer: string = '';
  private carry: string = '';
  private lastLineWasBlank: boolean = false;
  private progressTimer?: NodeJS.Timeout;
  private progressFlushTimer?: NodeJS.Timeout;
  private progressTick: number = 0;
  private startTime: Date = new Date();
  private isActive: boolean = false;
  private submissions: FeedbackSubmission[] = [];
  private lastUserInputTime: number = 0;
  private userInputTimeout: number = 30000; // 30 seconds in milliseconds
  private totalInputLength: number = 0; // Track total characters typed
  private minCharsForBuffering: number = 3; // Minimum characters before activating buffering

  constructor(options: FeedbackCollectorOptions = {}) {
    this.options = {
      command: options.command || 'juno-ts-task',
      commandArgs: options.commandArgs || ['juno-ts-task', 'feedback'],
      verbose: options.verbose || false,
      showHeader: options.showHeader !== undefined ? options.showHeader : true,
      progressInterval: options.progressInterval || 0,
      progressFlushInterval: options.progressFlushInterval ?? 2000, // Default: flush every 2 seconds
      onSubmit: options.onSubmit
    };
  }

  /**
   * Start the feedback collector
   */
  start(): void {
    if (this.isActive) {
      throw new Error('Feedback collector is already running');
    }

    this.isActive = true;
    this.startTime = new Date();

    // Initialize lastUserInputTime to now so the 30s timeout starts from when feedback collection begins
    // Without this, lastUserInputTime=0 would cause immediate flushing (Date.now() - 0 > 30000)
    this.lastUserInputTime = Date.now();

    // Reset total input length counter
    this.totalInputLength = 0;

    // DON'T activate feedback state yet - wait until user has typed at least 3 characters
    // This prevents buffering from activating when stdin is empty
    // setFeedbackActive(true); // MOVED - will be called after user types 3+ chars

    // Set up input redisplay callback to restore user input after progress flushes
    setInputRedisplayCallback(() => this.redisplayCurrentInput());

    // Enable UTF-8 encoding for stdin
    process.stdin.setEncoding('utf8');

    // Show header if enabled
    if (this.options.showHeader) {
      this.printHeader();
    }

    // Start progress ticker if enabled
    if (this.options.progressInterval > 0) {
      this.startProgressTicker();
    }

    // Start progress flush timer to periodically display buffered progress
    if (this.options.progressFlushInterval > 0) {
      this.startProgressFlushTimer();
    }

    // Setup stdin handlers
    this.setupStdinHandlers();

    // Ensure feedback state is reset on process exit
    this.setupExitHandlers();
  }

  /**
   * Stop the feedback collector
   */
  async stop(): Promise<void> {
    if (!this.isActive) {
      return;
    }

    this.isActive = false;

    // Set global feedback state to inactive (re-enables progress output)
    setFeedbackActive(false);

    // Clear input redisplay callback
    setInputRedisplayCallback(null);

    // Stop progress ticker
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }

    // Stop progress flush timer
    if (this.progressFlushTimer) {
      clearInterval(this.progressFlushTimer);
      this.progressFlushTimer = undefined;
    }

    // Flush any remaining buffered progress
    flushBufferedProgress();

    // Submit any remaining buffer
    this.submitBufferIfAny();

    // Wait for pending submissions
    await this.pending;

    // Remove stdin handlers
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('end');

    if (this.options.verbose) {
      process.stderr.write(`${EOL}[feedback-collector] Stopped. Total submissions: ${this.submissionCount}${EOL}`);
    }
  }

  /**
   * Get all submissions
   */
  getSubmissions(): FeedbackSubmission[] {
    return [...this.submissions];
  }

  /**
   * Get submission count
   */
  getSubmissionCount(): number {
    return this.submissionCount;
  }

  /**
   * Check if collector is active
   */
  isRunning(): boolean {
    return this.isActive;
  }

  /**
   * Redisplay the current user input after progress events are flushed
   * This maintains visual continuity so user sees their partial input restored
   */
  private redisplayCurrentInput(): void {
    if (!this.isActive) {
      return;
    }

    // Combine both buffer (accumulated complete lines) and carry (current incomplete line)
    const fullInput = this.buffer + this.carry;

    if (fullInput.length > 0) {
      // Write a fresh prompt with ALL the user's accumulated input
      // Show it in a compact way - just the last few lines to maintain context
      const lines = fullInput.split(/\r?\n/);
      const visibleLines = lines.slice(-3); // Show last 3 lines for context

      if (lines.length > 3) {
        process.stdout.write(chalk.gray(`... (${lines.length - 3} more lines above)\n`));
      }

      // Display each line with continuation marker
      for (let i = 0; i < visibleLines.length - 1; i++) {
        process.stdout.write(chalk.cyan('│ ') + visibleLines[i] + '\n');
      }

      // Last line with the active prompt
      process.stdout.write(chalk.cyan.bold('> ') + visibleLines[visibleLines.length - 1]);
    } else {
      // No partial input, just show the prompt
      process.stdout.write(chalk.cyan.bold('> '));
    }
  }

  /**
   * Print header instructions
   */
  private printHeader(): void {
    const border = '═'.repeat(60);
    process.stdout.write(
      [
        '',
        chalk.blue.bold('╔' + border + '╗'),
        chalk.blue.bold('║') + chalk.yellow.bold('  📝 FEEDBACK COLLECTION ENABLED  ') + ' '.repeat(25) + chalk.blue.bold('║'),
        chalk.blue.bold('╠' + border + '╣'),
        chalk.blue.bold('║') + chalk.white('  Type or paste your multiline feedback below:') + ' '.repeat(12) + chalk.blue.bold('║'),
        chalk.blue.bold('║') + chalk.green('  • Submit: Press Enter on a BLANK line') + ' '.repeat(19) + chalk.blue.bold('║'),
        chalk.blue.bold('║') + chalk.green('  • Alternative: Type --- on a line by itself') + ' '.repeat(13) + chalk.blue.bold('║'),
        chalk.blue.bold('║') + chalk.green('  • Exit: Press Ctrl-D (or Ctrl-Z on Windows)') + ' '.repeat(13) + chalk.blue.bold('║'),
        chalk.blue.bold('║') + chalk.gray('  Progress updates will appear below while you type...') + ' '.repeat(5) + chalk.blue.bold('║'),
        chalk.blue.bold('╚' + border + '╝'),
        chalk.cyan.bold('> ') + chalk.gray('(Type your feedback here)')
      ].join(EOL) + EOL
    );
  }

  /**
   * Start progress ticker
   */
  private startProgressTicker(): void {
    this.progressTimer = setInterval(() => {
      this.progressTick += 1;
      const elapsed = ((Date.now() - this.startTime.getTime()) / 1000).toFixed(1);
      process.stderr.write(`[progress] tick=${this.progressTick} elapsed=${elapsed}s${EOL}`);
    }, this.options.progressInterval);
  }

  /**
   * Start progress flush timer to periodically display buffered progress
   * Only flushes if 30s has passed since last user input (inactivity timeout)
   */
  private startProgressFlushTimer(): void {
    this.progressFlushTimer = setInterval(() => {
      const now = Date.now();
      const timeSinceLastInput = now - this.lastUserInputTime;

      // Only flush if 30s has passed since last user input
      // This prevents interrupting user while they're actively typing
      if (timeSinceLastInput >= this.userInputTimeout) {
        flushBufferedProgress();
      }
    }, this.options.progressFlushInterval);
  }

  /**
   * Setup exit handlers to ensure feedback state is reset
   */
  private setupExitHandlers(): void {
    const cleanup = () => {
      if (this.isActive) {
        setFeedbackActive(false);
      }
    };

    // Handle various exit scenarios
    process.on('SIGINT', cleanup);   // Ctrl-C
    process.on('SIGTERM', cleanup);  // Termination signal
    process.on('exit', cleanup);     // Normal exit
    process.on('uncaughtException', cleanup);  // Uncaught exceptions
  }

  /**
   * Setup stdin event handlers
   */
  private setupStdinHandlers(): void {
    // Handle stdin data events
    process.stdin.on('data', (chunk: string) => {
      if (!this.isActive) return;

      // Update last user input time - this resets the 30s inactivity timer
      this.lastUserInputTime = Date.now();

      // Track total input length (buffer + carry + new chunk)
      this.totalInputLength += chunk.length;

      // Activate buffering mode only after user has typed at least 3 characters
      // This prevents buffering from activating when stdin is empty
      if (!isFeedbackActive() && this.totalInputLength >= this.minCharsForBuffering) {
        setFeedbackActive(true);
        if (this.options.verbose) {
          process.stderr.write(`[feedback-collector] Buffering activated after ${this.totalInputLength} characters typed\n`);
        }
      }

      this.carry += chunk;

      // Split into complete lines, keep the last partial in carry
      const parts = this.carry.split(/\r?\n/);
      this.carry = parts.pop() ?? '';

      for (const line of parts) {
        this.processLine(line);
      }
    });

    // Handle stdin end event (EOF)
    process.stdin.on('end', async () => {
      if (!this.isActive) return;

      // If there is remaining partial data, treat as part of the last block
      if (this.carry.length) {
        this.buffer += this.carry;
      }

      this.submitBufferIfAny();
      await this.pending;

      if (this.progressTimer) {
        clearInterval(this.progressTimer);
      }

      // Reset feedback state when feedback ends via EOF
      setFeedbackActive(false);

      if (this.options.verbose) {
        process.stderr.write(`${EOL}[feedback-collector] EOF received. Total submissions: ${this.submissionCount}${EOL}`);
      }
    });
  }

  /**
   * Process a single line of input
   */
  private processLine(line: string): void {
    const trimmed = line.trim();
    const isBlank = trimmed.length === 0;
    const isDelimiter = trimmed === '---';

    // Check for delimiter submission
    if (isDelimiter) {
      this.submitBufferIfAny();
      this.lastLineWasBlank = false;
      return;
    }

    if (isBlank && !this.lastLineWasBlank) {
      // A single blank line means "submit this block"
      this.submitBufferIfAny();
      this.lastLineWasBlank = true;
      return;
    }

    if (!isBlank) {
      // Any non-blank line is part of the current block
      this.buffer += line + EOL;
      this.lastLineWasBlank = false;
    } else {
      // Consecutive blank lines: ignore (prevent accidental multiple submits)
      this.lastLineWasBlank = true;
    }
  }

  /**
   * Submit the current buffer if it has content
   */
  private submitBufferIfAny(): void {
    const content = this.buffer.trimEnd();
    this.buffer = ''; // Clean buffer for the next round

    if (content.length === 0) {
      return;
    }

    process.stdout.write(EOL + chalk.cyan('===== SUBMITTING FEEDBACK BLOCK =====') + EOL);
    process.stdout.write(content + EOL);
    process.stdout.write(chalk.cyan('===== END BLOCK =====') + EOL);

    // Flush any buffered progress when user submits feedback
    // This ensures they see all accumulated updates
    flushBufferedProgress();

    this.enqueueSubmission(content).catch((err) => {
      process.stderr.write(`${EOL}[feedback-collector] Error submitting feedback: ${err}${EOL}`);
    });
  }

  /**
   * Enqueue submission to ensure strict sequential order
   */
  private enqueueSubmission(input: string): Promise<void> {
    // Ensure strict order by chaining onto `pending`
    this.pending = this.pending.then(async () => {
      await this.runFeedbackSubmission(input);
    });
    return this.pending;
  }

  /**
   * Run feedback submission (either via command or custom handler)
   */
  private async runFeedbackSubmission(input: string): Promise<void> {
    this.submissionCount += 1;
    const n = this.submissionCount;
    const submission: FeedbackSubmission = {
      content: input,
      timestamp: new Date(),
      submissionNumber: n
    };

    this.submissions.push(submission);

    if (this.options.onSubmit) {
      // Use custom submission handler
      if (this.options.verbose) {
        process.stderr.write(`${EOL}[feedback-collector ${n}] Using custom submission handler${EOL}`);
      }

      try {
        await this.options.onSubmit(input);
        if (this.options.verbose) {
          process.stderr.write(`[feedback-collector ${n}] Custom handler completed${EOL}`);
        }
        process.stdout.write(EOL + chalk.green('✅ Feedback submitted successfully. You can type another block.') + EOL);
        process.stdout.write(EOL + chalk.cyan.bold('> ') + chalk.gray('(Ready for next feedback)') + EOL);
      } catch (error) {
        process.stderr.write(`[feedback-collector ${n}] Custom handler error: ${error}${EOL}`);
        process.stdout.write(EOL + chalk.red('❌ Feedback submission failed. Please try again.') + EOL);
      }
    } else {
      // Use command spawning
      await this.runCommandWithInput(n, input);
    }
  }

  /**
   * Run feedback command with the collected input
   */
  private async runCommandWithInput(n: number, input: string): Promise<void> {
    if (this.options.verbose) {
      process.stderr.write(`${EOL}[feedback-collector ${n}] Launching "${this.options.command}" ${this.options.commandArgs.join(' ')}${EOL}`);
    }

    return new Promise((resolve) => {
      const child = spawn(this.options.command, this.options.commandArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Pipe child's output to stderr (treat as logs)
      child.stdout?.on('data', (d) => {
        if (this.options.verbose) {
          process.stderr.write(`[feedback-collector ${n}] stdout: ${d}`);
        }
      });

      child.stderr?.on('data', (d) => {
        if (this.options.verbose) {
          process.stderr.write(`[feedback-collector ${n}] stderr: ${d}`);
        }
      });

      child.on('close', (code) => {
        if (this.options.verbose) {
          process.stderr.write(`[feedback-collector ${n}] exit code ${code ?? 0}${EOL}`);
        }

        if (code === 0) {
          process.stdout.write(EOL + chalk.green('✅ Feedback submitted successfully. You can type another block.') + EOL);
          process.stdout.write(EOL + chalk.cyan.bold('> ') + chalk.gray('(Ready for next feedback)') + EOL);
        } else {
          process.stdout.write(EOL + chalk.red('❌ Feedback submission failed. Please try again.') + EOL);
        }

        resolve();
      });

      child.on('error', (err) => {
        process.stderr.write(`[feedback-collector ${n}] error: ${err.message}${EOL}`);
        process.stdout.write(EOL + chalk.red('❌ Feedback submission failed. Please try again.') + EOL);
        resolve();
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
}

/**
 * Create and start a feedback collector
 */
export function createFeedbackCollector(options?: FeedbackCollectorOptions): ConcurrentFeedbackCollector {
  const collector = new ConcurrentFeedbackCollector(options);
  return collector;
}
