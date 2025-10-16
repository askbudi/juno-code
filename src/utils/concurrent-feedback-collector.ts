/**
 * Concurrent Feedback Collector Utility
 *
 * Reusable class for collecting multiline feedback while other processes are running.
 * - Type/paste feedback (multiline)
 * - Press Enter on a BLANK line to SUBMIT that block
 * - Multiple blocks allowed; exit with EOF (Ctrl-D / Ctrl-Z then Enter) or Ctrl-C
 * - Progress logs go to stderr; UI/instructions to stdout
 * - NO TTY/Raw mode - simple line-based stdin for AI agent compatibility
 *
 * Can be used standalone or integrated into other commands.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EOL } from 'node:os';
import chalk from 'chalk';

export interface FeedbackCollectorOptions {
  /**
   * Command to run for each feedback submission
   * @default 'node'
   */
  command?: string;

  /**
   * Arguments for the feedback command
   * @default ['dist/bin/cli.mjs', 'feedback']
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
  private progressTick: number = 0;
  private startTime: Date = new Date();
  private isActive: boolean = false;
  private submissions: FeedbackSubmission[] = [];

  constructor(options: FeedbackCollectorOptions = {}) {
    this.options = {
      command: options.command || 'node',
      commandArgs: options.commandArgs || ['dist/bin/cli.mjs', 'feedback'],
      verbose: options.verbose || false,
      showHeader: options.showHeader !== undefined ? options.showHeader : true,
      progressInterval: options.progressInterval || 0,
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

    // Setup stdin handlers
    this.setupStdinHandlers();
  }

  /**
   * Stop the feedback collector
   */
  async stop(): Promise<void> {
    if (!this.isActive) {
      return;
    }

    this.isActive = false;

    // Stop progress ticker
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }

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
   * Print header instructions
   */
  private printHeader(): void {
    process.stdout.write(
      [
        '',
        chalk.blue.bold('📝 Feedback Collection Enabled'),
        chalk.gray('   Type or paste your feedback. Submit by pressing Enter on an EMPTY line.'),
        chalk.gray('   (Continue working - your progress updates will be shown below)'),
        ''
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

      // If there is remaining partial data, treat as part of the last block
      if (this.carry.length) {
        this.buffer += this.carry;
      }

      this.submitBufferIfAny();
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
    const isBlank = line.trim().length === 0;

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
