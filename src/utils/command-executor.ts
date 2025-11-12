/**
 * CommandExecutor - Comprehensive command execution utilities with cross-platform
 * support, streaming, timeout management, and error handling.
 */

import { spawn, exec, ChildProcess, ExecOptions, SpawnOptions } from 'child_process';
import { promisify } from 'util';
import { PassThrough, Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import { join, dirname, isAbsolute, resolve } from 'path';
import fs from 'fs-extra';

const execPromise = promisify(exec);

/**
 * Command execution options
 */
export interface CommandOptions {
  /** Working directory for command execution */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Execution timeout in milliseconds */
  timeout?: number;
  /** Shell to use for execution */
  shell?: string | boolean;
  /** Standard input data */
  input?: string | Buffer;
  /** Encoding for output (default: utf8) */
  encoding?: BufferEncoding;
  /** Maximum buffer size for stdout/stderr */
  maxBuffer?: number;
  /** Kill signal to use on timeout */
  killSignal?: string | number;
  /** Whether to detach the process */
  detached?: boolean;
  /** File descriptors for stdio */
  stdio?: 'inherit' | 'pipe' | 'ignore' | Array<'inherit' | 'pipe' | 'ignore' | number>;
  /** User ID (Unix only) */
  uid?: number;
  /** Group ID (Unix only) */
  gid?: number;
  /** Windows verbatim arguments */
  windowsVerbatimArguments?: boolean;
  /** Hide console window on Windows */
  windowsHide?: boolean;
}

/**
 * Streaming command options
 */
export interface StreamingOptions extends CommandOptions {
  /** Enable real-time stdout streaming */
  streamStdout?: boolean;
  /** Enable real-time stderr streaming */
  streamStderr?: boolean;
  /** Custom stdout handler */
  onStdout?: (data: string) => void;
  /** Custom stderr handler */
  onStderr?: (data: string) => void;
  /** Custom exit handler */
  onExit?: (code: number | null, signal: string | null) => void;
  /** Buffer mode for streaming */
  bufferMode?: 'none' | 'line' | 'chunk';
}

/**
 * Command execution result
 */
export interface CommandResult {
  /** Exit code (0 for success) */
  exitCode: number | null;
  /** Exit signal (if killed by signal) */
  signal: string | null;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Execution duration in milliseconds */
  duration: number;
  /** Process ID */
  pid?: number;
  /** Whether command was killed due to timeout */
  timedOut: boolean;
  /** Whether command was successful (exit code 0) */
  success: boolean;
  /** Error if execution failed */
  error?: Error;
}

/**
 * Streaming command result
 */
export interface StreamingResult extends EventEmitter {
  /** Process instance */
  process: ChildProcess;
  /** Promise that resolves when command completes */
  completion: Promise<CommandResult>;
  /** Kill the process */
  kill: (signal?: string | number) => boolean;
  /** Send input to the process */
  send: (data: string | Buffer) => boolean;
  /** Get current stdout buffer */
  getStdout: () => string;
  /** Get current stderr buffer */
  getStderr: () => string;
}

/**
 * Command validation result
 */
export interface CommandValidation {
  /** Whether command exists */
  exists: boolean;
  /** Full path to command (if found) */
  path?: string;
  /** Version information (if available) */
  version?: string;
  /** Error if validation failed */
  error?: Error;
}

/**
 * Batch execution options
 */
export interface BatchOptions extends CommandOptions {
  /** Maximum number of concurrent executions */
  concurrency?: number;
  /** Whether to stop on first failure */
  stopOnError?: boolean;
  /** Progress callback */
  onProgress?: (completed: number, total: number, current: string) => void;
}

/**
 * Command builder for complex command construction
 */
export class CommandBuilder {
  private command: string;
  private args: string[] = [];
  private options: CommandOptions = {};

  constructor(command: string) {
    this.command = command;
  }

  /**
   * Add arguments to the command
   */
  arg(...args: (string | number | boolean)[]): this {
    this.args.push(...args.map(arg => String(arg)));
    return this;
  }

  /**
   * Add arguments conditionally
   */
  argIf(condition: boolean, ...args: (string | number | boolean)[]): this {
    if (condition) {
      this.arg(...args);
    }
    return this;
  }

  /**
   * Set working directory
   */
  cwd(dir: string): this {
    this.options.cwd = dir;
    return this;
  }

  /**
   * Set environment variables
   */
  env(vars: Record<string, string>): this {
    this.options.env = { ...this.options.env, ...vars };
    return this;
  }

  /**
   * Set timeout
   */
  timeout(ms: number): this {
    this.options.timeout = ms;
    return this;
  }

  /**
   * Set shell
   */
  shell(shell: string | boolean): this {
    this.options.shell = shell;
    return this;
  }

  /**
   * Build the final command string and options
   */
  build(): { command: string; args: string[]; options: CommandOptions } {
    return {
      command: this.command,
      args: this.args,
      options: this.options,
    };
  }

  /**
   * Execute the built command
   */
  async execute(): Promise<CommandResult> {
    const { command, args, options } = this.build();
    return CommandExecutor.getInstance().run(command, args, options);
  }

  /**
   * Execute the built command with streaming
   */
  executeStream(streamOptions?: Partial<StreamingOptions>): StreamingResult {
    const { command, args, options } = this.build();
    return CommandExecutor.getInstance().runWithStreaming(command, args, {
      ...options,
      ...streamOptions,
    });
  }
}

/**
 * CommandExecutor class for comprehensive command execution
 */
export class CommandExecutor {
  private static instance: CommandExecutor;
  private readonly defaultOptions: CommandOptions;

  constructor(defaultOptions: Partial<CommandOptions> = {}) {
    this.defaultOptions = {
      timeout: 30000, // 30 seconds default
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB default
      killSignal: 'SIGTERM',
      shell: true,
      windowsHide: true,
      ...defaultOptions,
    };
  }

  /**
   * Get singleton instance
   */
  public static getInstance(options?: Partial<CommandOptions>): CommandExecutor {
    if (!CommandExecutor.instance) {
      CommandExecutor.instance = new CommandExecutor(options);
    }
    return CommandExecutor.instance;
  }

  /**
   * Execute command and return result
   */
  async run(
    command: string,
    args: string[] = [],
    options: Partial<CommandOptions> = {}
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const opts = { ...this.defaultOptions, ...options };

    // Resolve working directory
    if (opts.cwd && !isAbsolute(opts.cwd)) {
      opts.cwd = resolve(opts.cwd);
    }

    // Ensure working directory exists
    if (opts.cwd) {
      try {
        await fs.ensureDir(opts.cwd);
      } catch (error) {
        return this.createErrorResult(
          startTime,
          new Error(`Working directory does not exist: ${opts.cwd}`)
        );
      }
    }

    try {
      // Use exec for simple commands, spawn for complex ones
      if (args.length === 0 && opts.shell) {
        return await this.execCommand(command, opts, startTime);
      } else {
        return await this.spawnCommand(command, args, opts, startTime);
      }
    } catch (error) {
      return this.createErrorResult(startTime, error as Error);
    }
  }

  /**
   * Execute command with real-time streaming
   */
  runWithStreaming(
    command: string,
    args: string[] = [],
    options: Partial<StreamingOptions> = {}
  ): StreamingResult {
    const opts = { ...this.defaultOptions, ...options };
    const startTime = Date.now();

    // Create result object with EventEmitter
    const result = new EventEmitter() as StreamingResult;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    // Set up buffer modes
    const { bufferMode = 'chunk' } = opts;

    // Spawn process
    const childProcess = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeout,
      killSignal: opts.killSignal as any,
      detached: opts.detached,
      stdio: opts.stdio || 'pipe',
      shell: opts.shell,
      windowsHide: opts.windowsHide,
      windowsVerbatimArguments: opts.windowsVerbatimArguments,
    });

    // Handle stdout
    if (childProcess.stdout) {
      this.setupStreamHandler(
        childProcess.stdout,
        bufferMode,
        (data: string) => {
          stdoutBuffer += data;
          if (opts.streamStdout || opts.onStdout) {
            opts.onStdout?.(data);
            result.emit('stdout', data);
          }
        }
      );
    }

    // Handle stderr
    if (childProcess.stderr) {
      this.setupStreamHandler(
        childProcess.stderr,
        bufferMode,
        (data: string) => {
          stderrBuffer += data;
          if (opts.streamStderr || opts.onStderr) {
            opts.onStderr?.(data);
            result.emit('stderr', data);
          }
        }
      );
    }

    // Create completion promise
    const completion = new Promise<CommandResult>((resolve) => {
      let timedOut = false;
      let timeoutId: NodeJS.Timeout | undefined;

      // Set up timeout
      if (opts.timeout) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          childProcess.kill(opts.killSignal as any);
        }, opts.timeout);
      }

      // Handle process exit
      childProcess.on('exit', (exitCode, signal) => {
        if (timeoutId) clearTimeout(timeoutId);

        const duration = Date.now() - startTime;
        const commandResult: CommandResult = {
          exitCode,
          signal,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          duration,
          pid: childProcess.pid,
          timedOut,
          success: !timedOut && exitCode === 0,
        };

        opts.onExit?.(exitCode, signal);
        result.emit('exit', commandResult);
        resolve(commandResult);
      });

      // Handle process error
      childProcess.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);

        const commandResult = this.createErrorResult(startTime, error);
        result.emit('error', error);
        resolve(commandResult);
      });
    });

    // Add utility methods
    result.process = childProcess;
    result.completion = completion;
    result.kill = (signal?: string | number) => childProcess.kill(signal);
    result.send = (data: string | Buffer) => {
      if (childProcess.stdin) {
        return childProcess.stdin.write(data);
      }
      return false;
    };
    result.getStdout = () => stdoutBuffer;
    result.getStderr = () => stderrBuffer;

    // Send input if provided
    if (opts.input && childProcess.stdin) {
      childProcess.stdin.write(opts.input);
      childProcess.stdin.end();
    }

    return result;
  }

  /**
   * Validate command existence and get information
   */
  async validateCommand(command: string): Promise<CommandValidation> {
    try {
      // Try to get command path
      const whichCommand = process.platform === 'win32' ? 'where' : 'which';
      const result = await this.run(whichCommand, [command], {
        timeout: 5000,
        stdio: 'pipe',
      });

      if (result.success && result.stdout.trim()) {
        const path = result.stdout.trim().split('\n')[0];

        // Try to get version
        let version: string | undefined;
        try {
          const versionResult = await this.run(command, ['--version'], {
            timeout: 5000,
            stdio: 'pipe',
          });
          if (versionResult.success) {
            version = versionResult.stdout.trim().split('\n')[0];
          }
        } catch {
          // Version check failed, but command exists
        }

        return {
          exists: true,
          path,
          version,
        };
      }

      return { exists: false };
    } catch (error) {
      return {
        exists: false,
        error: error as Error,
      };
    }
  }

  /**
   * Execute multiple commands in batch
   */
  async runBatch(
    commands: Array<{ command: string; args?: string[]; options?: Partial<CommandOptions> }>,
    batchOptions: Partial<BatchOptions> = {}
  ): Promise<CommandResult[]> {
    const { concurrency = 3, stopOnError = false, onProgress } = batchOptions;
    const results: Array<{ result: CommandResult; originalIndex: number }> = [];
    // Create queue with original indices
    const queue = commands.map((cmd, index) => ({ ...cmd, originalIndex: index }));
    let completed = 0;

    const executeBatch = async (): Promise<CommandResult[]> => {
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
          const cmd = queue.shift();
          if (!cmd) break;

          onProgress?.(completed, commands.length, cmd.command);

          const result = await this.run(cmd.command, cmd.args || [], {
            ...batchOptions,
            ...cmd.options,
          });

          results.push({ result, originalIndex: cmd.originalIndex });
          completed++;

          if (stopOnError && !result.success) {
            queue.length = 0; // Clear remaining commands
            break;
          }
        }
      });

      await Promise.all(workers);
      // Sort by original order and extract just the results
      return results
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .map(item => item.result);
    };

    return executeBatch();
  }

  /**
   * Create command builder
   */
  command(cmd: string): CommandBuilder {
    return new CommandBuilder(cmd);
  }

  /**
   * Get system shell
   */
  getSystemShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/sh';
  }

  /**
   * Execute using child_process.exec
   */
  private async execCommand(
    command: string,
    options: CommandOptions,
    startTime: number
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const execOptions: ExecOptions = {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        killSignal: options.killSignal as any,
        encoding: options.encoding,
        shell: options.shell as string,
        uid: options.uid,
        gid: options.gid,
        windowsHide: options.windowsHide,
      };

      const child = exec(command, execOptions, (error, stdout, stderr) => {
        const duration = Date.now() - startTime;
        const timedOut = error?.message?.includes('timeout') || false;

        resolve({
          exitCode: error?.code ?? 0,
          signal: error?.signal ?? null,
          stdout: stdout || '',
          stderr: stderr || '',
          duration,
          pid: child.pid,
          timedOut,
          success: !error && !timedOut,
          error: error || undefined,
        });
      });

      // Send input if provided
      if (options.input && child.stdin) {
        child.stdin.write(options.input);
        child.stdin.end();
      }
    });
  }

  /**
   * Execute using child_process.spawn
   */
  private async spawnCommand(
    command: string,
    args: string[],
    options: CommandOptions,
    startTime: number
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let timedOut = false;

      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        detached: options.detached,
        stdio: 'pipe',
        shell: options.shell,
        uid: options.uid,
        gid: options.gid,
        windowsHide: options.windowsHide,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
      };

      const child = spawn(command, args, spawnOptions);

      // Set up timeout
      let timeoutId: NodeJS.Timeout | undefined;
      if (options.timeout) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          child.kill(options.killSignal as any);
        }, options.timeout);
      }

      // Handle stdout
      if (child.stdout) {
        child.stdout.setEncoding(options.encoding || 'utf8');
        child.stdout.on('data', (data) => {
          stdoutBuffer += data;
        });
      }

      // Handle stderr
      if (child.stderr) {
        child.stderr.setEncoding(options.encoding || 'utf8');
        child.stderr.on('data', (data) => {
          stderrBuffer += data;
        });
      }

      // Handle process exit
      child.on('exit', (exitCode, signal) => {
        if (timeoutId) clearTimeout(timeoutId);

        const duration = Date.now() - startTime;
        resolve({
          exitCode,
          signal,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          duration,
          pid: child.pid,
          timedOut,
          success: !timedOut && exitCode === 0,
        });
      });

      // Handle process error
      child.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(this.createErrorResult(startTime, error));
      });

      // Send input if provided
      if (options.input && child.stdin) {
        child.stdin.write(options.input);
        child.stdin.end();
      }
    });
  }

  /**
   * Set up stream handler with different buffer modes
   */
  private setupStreamHandler(
    stream: Readable,
    bufferMode: 'none' | 'line' | 'chunk',
    handler: (data: string) => void
  ): void {
    stream.setEncoding('utf8');

    if (bufferMode === 'line') {
      let buffer = '';
      stream.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(line => handler(line + '\n'));
      });
      stream.on('end', () => {
        if (buffer) handler(buffer);
      });
    } else {
      stream.on('data', handler);
    }
  }

  /**
   * Create error result
   */
  private createErrorResult(startTime: number, error: Error): CommandResult {
    return {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: error.message,
      duration: Date.now() - startTime,
      timedOut: false,
      success: false,
      error,
    };
  }
}

/**
 * Export default instance for convenience
 */
export const commandExecutor = CommandExecutor.getInstance();

/**
 * Convenience functions using default instance
 */
export const run = (command: string, args?: string[], options?: Partial<CommandOptions>) =>
  commandExecutor.run(command, args, options);

export const runWithStreaming = (command: string, args?: string[], options?: Partial<StreamingOptions>) =>
  commandExecutor.runWithStreaming(command, args, options);

export const validateCommand = (command: string) =>
  commandExecutor.validateCommand(command);

export const runBatch = (commands: Array<{ command: string; args?: string[]; options?: Partial<CommandOptions> }>, options?: Partial<BatchOptions>) =>
  commandExecutor.runBatch(commands, options);

export const command = (cmd: string) =>
  commandExecutor.command(cmd);