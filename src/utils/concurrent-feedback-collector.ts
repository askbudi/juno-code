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
/**
 * Feedback collector mode states
 */
enum FeedbackMode {
  NORMAL = 'normal',           // Normal mode - MCP progress shown, waiting for f+enter
  FEEDBACK = 'feedback'        // Feedback mode - MCP progress buffered, collecting feedback until q+enter
}

export class ConcurrentFeedbackCollector {
  private options: Required<Omit<FeedbackCollectorOptions, 'onSubmit'>> & Pick<FeedbackCollectorOptions, 'onSubmit'>;
  private submissionCount: number = 0;
  private pending: Promise<void> = Promise.resolve();
  private buffer: string = '';
  private carry: string = '';
  private progressTimer?: NodeJS.Timeout;
  private progressFlushTimer?: NodeJS.Timeout;
  private progressTick: number = 0;
  private startTime: Date = new Date();
  private isActive: boolean = false;
  private submissions: FeedbackSubmission[] = [];
  private feedbackMode: FeedbackMode = FeedbackMode.NORMAL; // Current feedback mode state

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

    // Start in NORMAL mode - MCP progress shown, waiting for f+enter
    this.feedbackMode = FeedbackMode.NORMAL;

    // DON'T activate feedback buffering state yet - only when user enters feedback mode
    // This ensures MCP progress is shown normally until f+enter

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

    // Progress flush timer not needed in new f+enter/q+enter mode
    // Progress is only buffered when IN feedback mode (between f+enter and q+enter)

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

    // Exit feedback mode if still in it
    if (this.feedbackMode === FeedbackMode.FEEDBACK) {
      this.exitFeedbackMode();
    }

    // Clear input redisplay callback
    setInputRedisplayCallback(null);

    // Stop progress ticker
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }

    // Flush any remaining buffered progress
    flushBufferedProgress();

    // Submit any remaining buffer if in feedback mode
    if (this.buffer.trim().length > 0) {
      this.submitFeedback();
    }

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
        chalk.blue.bold('║') + chalk.white('  MCP progress updates shown normally until you enter feedback mode') + chalk.blue.bold('║'),
        chalk.blue.bold('║') + chalk.green('  • Enter feedback mode: Type F (or f) then press Enter') + ' '.repeat(5) + chalk.blue.bold('║'),
        chalk.blue.bold('║') + chalk.green('  • Exit & submit feedback: Type Q (or q) then press Enter') + ' '.repeat(2) + chalk.blue.bold('║'),
        chalk.blue.bold('║') + chalk.gray('  Progress updates paused only WHILE in feedback mode') + ' '.repeat(7) + chalk.blue.bold('║'),
        chalk.blue.bold('║') + chalk.gray('  Exit: Press Ctrl-D (or Ctrl-Z on Windows)') + ' '.repeat(16) + chalk.blue.bold('║'),
        chalk.blue.bold('╚' + border + '╝'),
        chalk.cyan.bold('> ') + chalk.gray('(Type F+Enter to start giving feedback)')
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
   * Enter feedback mode - start buffering MCP progress
   */
  private enterFeedbackMode(): void {
    this.feedbackMode = FeedbackMode.FEEDBACK;
    setFeedbackActive(true); // Start buffering MCP progress
    this.buffer = ''; // Clear any existing buffer

    process.stdout.write(EOL + chalk.yellow.bold('📝 FEEDBACK MODE ACTIVE') + chalk.gray(' (MCP progress paused)') + EOL);
    process.stdout.write(chalk.gray('Type your multiline feedback. When done, type Q+Enter to submit and exit.') + EOL);
    process.stdout.write(chalk.cyan.bold('> ') + chalk.gray('(Type your feedback here)') + EOL);

    if (this.options.verbose) {
      process.stderr.write(`[feedback-collector] Entered FEEDBACK mode - MCP progress buffering activated${EOL}`);
    }
  }

  /**
   * Exit feedback mode - stop buffering MCP progress
   */
  private exitFeedbackMode(): void {
    this.feedbackMode = FeedbackMode.NORMAL;
    setFeedbackActive(false); // Stop buffering MCP progress

    if (this.options.verbose) {
      process.stderr.write(`[feedback-collector] Exited FEEDBACK mode - MCP progress restored${EOL}`);
    }
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

      // If in feedback mode and there's content, submit it
      if (this.feedbackMode === FeedbackMode.FEEDBACK && this.buffer.trim().length > 0) {
        this.submitFeedback();
      }

      // Exit feedback mode if still in it
      if (this.feedbackMode === FeedbackMode.FEEDBACK) {
        this.exitFeedbackMode();
      }

      await this.pending;

      if (this.progressTimer) {
        clearInterval(this.progressTimer);
      }

      if (this.options.verbose) {
        process.stderr.write(`${EOL}[feedback-collector] EOF received. Total submissions: ${this.submissionCount}${EOL}`);
      }
    });
  }

  /**
   * Process a single line of input
   */
  private processLine(line: string): void {
    const trimmed = line.trim().toLowerCase(); // Case insensitive

    // Handle mode transitions
    if (this.feedbackMode === FeedbackMode.NORMAL) {
      // In NORMAL mode, look for 'f' command to enter feedback mode
      if (trimmed === 'f') {
        this.enterFeedbackMode();
        return;
      }
      // Ignore other input in NORMAL mode - just show prompt again
      if (trimmed.length > 0) {
        process.stdout.write(chalk.gray('Type F+Enter to enter feedback mode, or Ctrl-D to exit') + EOL);
        process.stdout.write(chalk.cyan.bold('> '));
      }
      return;
    }

    // In FEEDBACK mode, look for 'q' command to exit and submit
    if (this.feedbackMode === FeedbackMode.FEEDBACK) {
      if (trimmed === 'q') {
        this.submitFeedback();
        this.exitFeedbackMode();

        // Show ready prompt for next feedback
        process.stdout.write(EOL + chalk.cyan.bold('> ') + chalk.gray('(Type F+Enter for another feedback, or Ctrl-D to exit)') + EOL);
        return;
      }

      // Any other line is part of the feedback content
      this.buffer += line + EOL;
    }
  }

  /**
   * Submit the current feedback buffer
   */
  private submitFeedback(): void {
    const content = this.buffer.trimEnd();
    this.buffer = ''; // Clean buffer for the next round

    if (content.length === 0) {
      process.stdout.write(EOL + chalk.yellow('⚠️  No feedback content to submit') + EOL);
      return;
    }

    process.stdout.write(EOL + chalk.green.bold('✅ Feedback registered and being processed...') + EOL);
    if (this.options.verbose) {
      process.stdout.write(chalk.gray('Feedback content:') + EOL);
      process.stdout.write(content + EOL);
      process.stdout.write(chalk.cyan('===== END BLOCK =====') + EOL);
    }

    // Flush any buffered progress when user submits feedback
    // This shows accumulated MCP logs that were buffered during feedback mode
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
