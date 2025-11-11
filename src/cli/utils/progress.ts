/**
 * Progress display utilities for juno-task-ts CLI
 *
 * Provides consistent progress indication, spinner components, and
 * real-time status updates with both verbose and quiet modes.
 */

import chalk from 'chalk';
import type { ProgressEvent, ProgressEventType } from '../../types/index.js';

/**
 * Progress bar configuration
 */
interface ProgressBarConfig {
  width: number;
  complete: string;
  incomplete: string;
  clear: boolean;
  stream: NodeJS.WriteStream;
}

/**
 * Spinner configuration
 */
interface SpinnerConfig {
  frames: string[];
  interval: number;
  stream: NodeJS.WriteStream;
}

/**
 * Simple progress bar implementation
 */
export class ProgressBar {
  private config: ProgressBarConfig;
  private current: number = 0;
  private total: number = 100;
  private startTime: Date = new Date();

  constructor(total: number = 100, config: Partial<ProgressBarConfig> = {}) {
    this.total = total;
    this.config = {
      width: 40,
      complete: '█',
      incomplete: '░',
      clear: true,
      stream: process.stdout,
      ...config
    };
  }

  /**
   * Update progress
   */
  update(current: number, message?: string): void {
    this.current = Math.min(current, this.total);
    this.render(message);
  }

  /**
   * Increment progress
   */
  tick(increment: number = 1, message?: string): void {
    this.update(this.current + increment, message);
  }

  /**
   * Complete progress bar
   */
  complete(message?: string): void {
    this.update(this.total, message);
    this.config.stream.write('\n');
  }

  /**
   * Render progress bar
   */
  private render(message?: string): void {
    const percentage = this.total > 0 ? (this.current / this.total) : 0;
    const completeLength = Math.round(this.config.width * percentage);
    const incompleteLength = this.config.width - completeLength;

    const complete = this.config.complete.repeat(completeLength);
    const incomplete = this.config.incomplete.repeat(incompleteLength);

    const percentageText = `${Math.round(percentage * 100)}%`.padStart(4);
    const progressText = `[${complete}${incomplete}] ${percentageText}`;

    const elapsed = Date.now() - this.startTime.getTime();
    const rate = this.current > 0 ? this.current / (elapsed / 1000) : 0;
    const eta = this.current > 0 && rate > 0 ? (this.total - this.current) / rate : 0;

    const timeText = this.current === this.total
      ? `${(elapsed / 1000).toFixed(1)}s`
      : `ETA: ${eta.toFixed(0)}s`;

    let output = `\r${chalk.blue(progressText)} ${chalk.gray(timeText)}`;

    if (message) {
      output += ` ${chalk.white(message)}`;
    }

    this.config.stream.write(output);
  }
}

/**
 * Loading spinner implementation
 */
export class Spinner {
  private config: SpinnerConfig;
  private interval: NodeJS.Timeout | null = null;
  private currentFrame: number = 0;
  private isSpinning: boolean = false;
  private message: string = '';

  constructor(config: Partial<SpinnerConfig> = {}) {
    this.config = {
      frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      interval: 80,
      stream: process.stdout,
      ...config
    };
  }

  /**
   * Start spinning
   */
  start(message: string = ''): void {
    if (this.isSpinning) {
      return;
    }

    this.message = message;
    this.isSpinning = true;
    this.currentFrame = 0;

    this.interval = setInterval(() => {
      this.render();
      this.currentFrame = (this.currentFrame + 1) % this.config.frames.length;
    }, this.config.interval);
  }

  /**
   * Update spinner message
   */
  update(message: string): void {
    this.message = message;
  }

  /**
   * Stop spinning with success
   */
  succeed(message?: string): void {
    this.stop(chalk.green('✓'), message);
  }

  /**
   * Stop spinning with failure
   */
  fail(message?: string): void {
    this.stop(chalk.red('✗'), message);
  }

  /**
   * Stop spinning with warning
   */
  warn(message?: string): void {
    this.stop(chalk.yellow('⚠'), message);
  }

  /**
   * Stop spinning with info
   */
  info(message?: string): void {
    this.stop(chalk.blue('ℹ'), message);
  }

  /**
   * Stop spinning
   */
  stop(symbol?: string, message?: string): void {
    if (!this.isSpinning) {
      return;
    }

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.isSpinning = false;

    // Clear current line
    this.config.stream.write('\r' + ' '.repeat(process.stdout.columns || 80) + '\r');

    if (symbol) {
      const finalMessage = message || this.message;
      this.config.stream.write(`${symbol} ${finalMessage}\n`);
    }
  }

  /**
   * Render current frame
   */
  private render(): void {
    const frame = this.config.frames[this.currentFrame];
    const output = `\r${chalk.cyan(frame)} ${this.message}`;
    this.config.stream.write(output);
  }
}

/**
 * Multi-step progress tracker
 */
export class StepProgress {
  private steps: Array<{ name: string; status: 'pending' | 'running' | 'completed' | 'failed' }>;
  private currentStepIndex: number = -1;
  private verbose: boolean;

  constructor(steps: string[], verbose: boolean = false) {
    this.steps = steps.map(name => ({ name, status: 'pending' }));
    this.verbose = verbose;
  }

  /**
   * Start next step
   */
  nextStep(): void {
    // Complete current step if running
    if (this.currentStepIndex >= 0 && this.steps[this.currentStepIndex].status === 'running') {
      this.steps[this.currentStepIndex].status = 'completed';
    }

    // Start next step
    this.currentStepIndex++;
    if (this.currentStepIndex < this.steps.length) {
      this.steps[this.currentStepIndex].status = 'running';
      this.render();
    }
  }

  /**
   * Mark current step as failed
   */
  fail(message?: string): void {
    if (this.currentStepIndex >= 0) {
      this.steps[this.currentStepIndex].status = 'failed';
      this.render();

      if (message) {
        console.log(chalk.red(`   ${message}`));
      }
    }
  }

  /**
   * Complete all steps
   */
  complete(): void {
    if (this.currentStepIndex >= 0) {
      this.steps[this.currentStepIndex].status = 'completed';
    }
    this.render();
  }

  /**
   * Render step progress
   */
  private render(): void {
    if (!this.verbose) {
      // Simple single-line progress
      const completed = this.steps.filter(s => s.status === 'completed').length;
      const total = this.steps.length;
      const current = this.currentStepIndex >= 0 ? this.steps[this.currentStepIndex].name : '';

      process.stdout.write(`\r[${completed}/${total}] ${current}`);

      if (completed === total) {
        console.log(chalk.green(' ✓'));
      }
    } else {
      // Detailed multi-line progress
      console.log(chalk.blue('\n📋 Progress:'));
      this.steps.forEach((step, index) => {
        const icon = this.getStepIcon(step.status);
        const color = this.getStepColor(step.status);
        console.log(`   ${color(icon)} ${step.name}`);
      });
    }
  }

  /**
   * Get icon for step status
   */
  private getStepIcon(status: string): string {
    switch (status) {
      case 'completed':
        return '✓';
      case 'running':
        return '⠧';
      case 'failed':
        return '✗';
      default:
        return '○';
    }
  }

  /**
   * Get color for step status
   */
  private getStepColor(status: string): typeof chalk.green {
    switch (status) {
      case 'completed':
        return chalk.green;
      case 'running':
        return chalk.blue;
      case 'failed':
        return chalk.red;
      default:
        return chalk.gray;
    }
  }
}

/**
 * Progress event formatter for MCP events
 */
export class ProgressEventFormatter {
  private verbose: boolean;
  private lastUpdateTime: Date = new Date();

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  /**
   * Format progress event for display
   */
  format(event: ProgressEvent): string | null {
    const now = new Date();

    // Throttle updates in non-verbose mode
    if (!this.verbose && now.getTime() - this.lastUpdateTime.getTime() < 500) {
      return null;
    }

    this.lastUpdateTime = now;

    if (this.verbose) {
      return this.formatVerbose(event);
    } else {
      return this.formatSimple(event);
    }
  }

  /**
   * Format verbose progress event
   */
  private formatVerbose(event: ProgressEvent): string {
    const timestamp = event.timestamp.toLocaleTimeString();
    const typeColor = this.getEventTypeColor(event.type);
    const backend = event.backend ? `[${event.backend}]` : '';
    const toolId = event.toolId ? `{${event.toolId}}` : '';

    // If this is a raw JSON event (from shell backend with outputRawJson=true),
    // output the full content without truncation
    const content = event.metadata?.rawJson
      ? event.content  // Full JSON output
      : event.content; // Original content (already formatted)

    return `${chalk.gray(timestamp)} ${backend}${toolId} ${typeColor(event.type)}: ${content}`;
  }

  /**
   * Format simple progress event
   */
  private formatSimple(event: ProgressEvent): string {
    const icon = this.getEventTypeIcon(event.type);
    const preview = event.content.length > 50
      ? event.content.substring(0, 50) + '...'
      : event.content;

    return `${icon} ${chalk.gray(preview)}`;
  }

  /**
   * Get color for event type
   */
  private getEventTypeColor(type: ProgressEventType): typeof chalk.green {
    switch (type) {
      case 'tool_start':
        return chalk.blue;
      case 'tool_result':
        return chalk.green;
      case 'thinking':
        return chalk.yellow;
      case 'error':
        return chalk.red;
      case 'info':
      default:
        return chalk.white;
    }
  }

  /**
   * Get icon for event type
   */
  private getEventTypeIcon(type: ProgressEventType): string {
    switch (type) {
      case 'tool_start':
        return '🔧';
      case 'tool_result':
        return '✅';
      case 'thinking':
        return '🤔';
      case 'error':
        return '❌';
      case 'info':
      default:
        return 'ℹ️';
    }
  }
}

/**
 * Quiet mode progress reporter (minimal output)
 */
export class QuietProgress {
  private startTime: Date = new Date();
  private lastDot: Date = new Date();

  /**
   * Show minimal progress indication
   */
  update(): void {
    const now = new Date();

    // Show a dot every 5 seconds in quiet mode
    if (now.getTime() - this.lastDot.getTime() > 5000) {
      process.stdout.write('.');
      this.lastDot = now;
    }
  }

  /**
   * Complete progress
   */
  complete(success: boolean): void {
    const elapsed = Date.now() - this.startTime.getTime();
    const icon = success ? chalk.green('✓') : chalk.red('✗');
    const time = `${(elapsed / 1000).toFixed(1)}s`;

    console.log(` ${icon} ${chalk.gray(time)}`);
  }
}

/**
 * Progress factory for creating appropriate progress indicators
 */
export class ProgressFactory {
  /**
   * Create progress indicator based on mode
   */
  static create(
    type: 'bar' | 'spinner' | 'steps' | 'events' | 'quiet',
    options: any = {}
  ): any {
    switch (type) {
      case 'bar':
        return new ProgressBar(options.total, options.config);
      case 'spinner':
        return new Spinner(options.config);
      case 'steps':
        return new StepProgress(options.steps, options.verbose);
      case 'events':
        return new ProgressEventFormatter(options.verbose);
      case 'quiet':
        return new QuietProgress();
      default:
        throw new Error(`Unknown progress type: ${type}`);
    }
  }
}