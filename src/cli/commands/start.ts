/**
 * Start command implementation for juno-task-ts CLI
 *
 * Executes tasks using .juno_task/init.md as the prompt with full MCP integration,
 * real-time progress tracking, session management, and comprehensive error handling.
 */

import * as path from 'node:path';
import * as fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import { createExecutionEngine, createExecutionRequest, ExecutionStatus } from '../../core/engine.js';
import { createSessionManager } from '../../core/session.js';
import { createMCPClient } from '../../mcp/client.js';
import type { StartCommandOptions } from '../types.js';
import { ConfigurationError, MCPError, FileSystemError } from '../types.js';
import type { JunoTaskConfig, SubagentType } from '../../types/index.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ProgressEvent,
  IterationResult
} from '../../core/engine.js';
import type { SessionManager, Session } from '../../core/session.js';

/**
 * Progress display manager for real-time execution feedback
 */
class ProgressDisplay {
  private currentIteration: number = 0;
  private startTime: Date = new Date();
  private lastUpdate: Date = new Date();
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  start(request: ExecutionRequest): void {
    this.startTime = new Date();
    console.log(chalk.blue.bold('\n🚀 Starting Task Execution'));
    console.log(chalk.gray(`   Request ID: ${request.requestId}`));
    console.log(chalk.gray(`   Subagent: ${request.subagent}`));
    console.log(chalk.gray(`   Max Iterations: ${request.maxIterations === -1 ? 'unlimited' : request.maxIterations}`));
    console.log(chalk.gray(`   Working Directory: ${request.workingDirectory}`));

    if (request.model) {
      console.log(chalk.gray(`   Model: ${request.model}`));
    }

    console.log(chalk.blue('\n📋 Task Instructions:'));
    console.log(chalk.white(`   ${request.instruction.substring(0, 200)}${request.instruction.length > 200 ? '...' : ''}`));
    console.log('');
  }

  onProgress(event: ProgressEvent): void {
    this.lastUpdate = new Date();

    if (this.verbose) {
      this.displayVerboseProgress(event);
    } else {
      this.displaySimpleProgress(event);
    }
  }

  onIterationStart(iteration: number): void {
    this.currentIteration = iteration;
    const elapsed = this.getElapsedTime();

    console.log(chalk.yellow(`\n🔄 Iteration ${iteration} started ${chalk.gray(`(${elapsed})`)}`));
  }

  onIterationComplete(result: IterationResult): void {
    const elapsed = this.getElapsedTime();
    const duration = `${result.duration.toFixed(0)}ms`;

    if (result.success) {
      console.log(chalk.green(`✅ Iteration ${result.iterationNumber} completed ${chalk.gray(`(${duration}, total: ${elapsed})`)}`));
    } else {
      console.log(chalk.red(`❌ Iteration ${result.iterationNumber} failed ${chalk.gray(`(${duration}, total: ${elapsed})`)}`));

      if (result.error && this.verbose) {
        console.log(chalk.red(`   Error: ${result.error.message}`));
      }
    }
  }

  onRateLimit(waitTimeMs: number, resetTime?: Date): void {
    const waitMinutes = Math.ceil(waitTimeMs / 60000);
    const resetTimeStr = resetTime ? resetTime.toLocaleTimeString() : 'unknown';

    console.log(chalk.yellow(`\n⏳ Rate limit encountered - waiting ${waitMinutes} minutes (resets at ${resetTimeStr})`));
  }

  onError(error: Error): void {
    console.log(chalk.red(`\n❌ Execution error: ${error.message}`));
  }

  complete(result: ExecutionResult): void {
    const elapsed = this.getElapsedTime();
    const stats = result.statistics;

    console.log(chalk.green.bold(`\n✅ Execution Complete! ${chalk.gray(`(${elapsed})`)}`));

    console.log(chalk.blue('\n📊 Execution Summary:'));
    console.log(chalk.white(`   Status: ${this.getStatusDisplay(result.status)}`));
    console.log(chalk.white(`   Total Iterations: ${stats.totalIterations}`));
    console.log(chalk.white(`   Successful: ${stats.successfulIterations}`));
    console.log(chalk.white(`   Failed: ${stats.failedIterations}`));
    console.log(chalk.white(`   Average Iteration Time: ${stats.averageIterationDuration.toFixed(0)}ms`));
    console.log(chalk.white(`   Total Tool Calls: ${stats.totalToolCalls}`));

    if (stats.rateLimitEncounters > 0) {
      console.log(chalk.yellow(`   Rate Limit Encounters: ${stats.rateLimitEncounters}`));
      console.log(chalk.yellow(`   Rate Limit Wait Time: ${(stats.rateLimitWaitTime / 1000).toFixed(1)}s`));
    }

    if (Object.keys(stats.errorBreakdown).length > 0) {
      console.log(chalk.red('   Error Breakdown:'));
      Object.entries(stats.errorBreakdown).forEach(([type, count]) => {
        console.log(chalk.red(`     ${type}: ${count}`));
      });
    }
  }

  private displayVerboseProgress(event: ProgressEvent): void {
    const timestamp = event.timestamp.toLocaleTimeString();
    const backend = event.backend ? `[${event.backend}]` : '';
    const toolId = event.toolId ? `{${event.toolId}}` : '';

    console.log(chalk.gray(`[${timestamp}] ${backend}${toolId} ${event.type}: ${event.content}`));
  }

  private displaySimpleProgress(event: ProgressEvent): void {
    const dots = '.'.repeat((this.currentIteration % 3) + 1);
    process.stdout.write(chalk.gray(`\r   Processing${dots}   `));
  }

  private getElapsedTime(): string {
    const elapsed = Date.now() - this.startTime.getTime();
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  private getStatusDisplay(status: ExecutionStatus): string {
    switch (status) {
      case ExecutionStatus.COMPLETED:
        return chalk.green('Completed');
      case ExecutionStatus.FAILED:
        return chalk.red('Failed');
      case ExecutionStatus.CANCELLED:
        return chalk.yellow('Cancelled');
      case ExecutionStatus.TIMEOUT:
        return chalk.red('Timeout');
      case ExecutionStatus.RATE_LIMITED:
        return chalk.yellow('Rate Limited');
      default:
        return chalk.gray(status);
    }
  }
}

/**
 * Project context validator and loader
 */
class ProjectContextLoader {
  constructor(private directory: string) {}

  async validate(): Promise<void> {
    const junoTaskDir = path.join(this.directory, '.juno_task');

    if (!(await fs.pathExists(junoTaskDir))) {
      throw new FileSystemError(
        'No .juno_task directory found. Run "juno-task init" first.',
        junoTaskDir
      );
    }

    const initFile = path.join(junoTaskDir, 'init.md');
    if (!(await fs.pathExists(initFile))) {
      throw new FileSystemError(
        'No init.md file found in .juno_task directory',
        initFile
      );
    }
  }

  async loadInstruction(): Promise<string> {
    const initFile = path.join(this.directory, '.juno_task', 'init.md');

    try {
      const content = await fs.readFile(initFile, 'utf-8');

      if (!content.trim()) {
        throw new FileSystemError(
          'init.md file is empty. Please add task instructions.',
          initFile
        );
      }

      return content.trim();
    } catch (error) {
      if (error instanceof FileSystemError) {
        throw error;
      }

      throw new FileSystemError(
        `Failed to read init.md: ${error}`,
        initFile
      );
    }
  }

  async detectGitInfo(): Promise<{ branch?: string; url?: string; commit?: string }> {
    try {
      const { execa } = await import('execa');

      const [branchResult, urlResult, commitResult] = await Promise.allSettled([
        execa('git', ['branch', '--show-current'], { cwd: this.directory }),
        execa('git', ['remote', 'get-url', 'origin'], { cwd: this.directory }),
        execa('git', ['rev-parse', 'HEAD'], { cwd: this.directory })
      ]);

      return {
        branch: branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : undefined,
        url: urlResult.status === 'fulfilled' ? urlResult.value.stdout.trim() : undefined,
        commit: commitResult.status === 'fulfilled' ? commitResult.value.stdout.trim().substring(0, 8) : undefined
      };
    } catch {
      return {};
    }
  }
}

/**
 * Execution coordinator that manages the full execution lifecycle
 */
class ExecutionCoordinator {
  private config: JunoTaskConfig;
  private sessionManager: SessionManager;
  private progressDisplay: ProgressDisplay;
  private currentSession: Session | null = null;

  constructor(config: JunoTaskConfig, verbose: boolean = false) {
    this.config = config;
    this.progressDisplay = new ProgressDisplay(verbose);
  }

  async initialize(): Promise<void> {
    this.sessionManager = await createSessionManager(this.config);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    // Create session
    this.currentSession = await this.sessionManager.createSession({
      name: `Execution ${new Date().toISOString()}`,
      subagent: request.subagent,
      config: this.config,
      tags: ['cli', 'start-command'],
      metadata: {
        requestId: request.requestId,
        workingDirectory: request.workingDirectory,
        maxIterations: request.maxIterations,
        model: request.model
      }
    });

    // Create MCP client
    const mcpClient = createMCPClient({
      serverPath: this.config.mcpServerPath,
      timeout: this.config.mcpTimeout,
      retries: this.config.mcpRetries,
      workingDirectory: request.workingDirectory,
      debug: this.config.verbose
    });

    // Create execution engine
    const engine = createExecutionEngine(this.config, mcpClient);

    // Set up progress callbacks
    engine.onProgress(async (event: ProgressEvent) => {
      this.progressDisplay.onProgress(event);

      // Record in session
      await this.sessionManager.addHistoryEntry(this.currentSession!.info.id, {
        type: 'system',
        content: `${event.type}: ${event.content}`,
        data: event,
        iteration: event.metadata?.iteration
      });
    });

    // Set up event handlers
    engine.on('iteration:start', ({ iterationNumber }) => {
      this.progressDisplay.onIterationStart(iterationNumber);
    });

    engine.on('iteration:complete', ({ iterationResult }) => {
      this.progressDisplay.onIterationComplete(iterationResult);
    });

    engine.on('rate-limit:start', ({ waitTimeMs, error }) => {
      this.progressDisplay.onRateLimit(waitTimeMs, error.resetTime);
    });

    engine.on('execution:error', ({ error }) => {
      this.progressDisplay.onError(error);
    });

    try {
      // Connect to MCP server
      await mcpClient.connect();

      // Start progress display
      this.progressDisplay.start(request);

      // Execute task
      const result = await engine.execute(request);

      // Complete progress display
      this.progressDisplay.complete(result);

      // Update session with results
      await this.sessionManager.completeSession(this.currentSession.info.id, {
        success: result.status === ExecutionStatus.COMPLETED,
        output: result.iterations[result.iterations.length - 1]?.toolResult.content || '',
        finalState: {
          status: result.status,
          statistics: result.statistics,
          iterations: result.iterations.length
        }
      });

      return result;

    } catch (error) {
      // Handle execution error
      if (this.currentSession) {
        await this.sessionManager.completeSession(this.currentSession.info.id, {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      throw error;

    } finally {
      // Cleanup
      try {
        await mcpClient.disconnect();
        await engine.shutdown();
      } catch (cleanupError) {
        console.warn(chalk.yellow(`Warning: Cleanup error: ${cleanupError}`));
      }
    }
  }

  getSessionId(): string | null {
    return this.currentSession?.info.id || null;
  }
}

/**
 * Main start command handler
 */
export async function startCommandHandler(
  args: any,
  options: StartCommandOptions,
  command: Command
): Promise<void> {
  try {
    console.log(chalk.blue.bold('🎯 Juno Task - Start Execution'));

    // Load configuration
    const config = await loadConfig({
      baseDir: options.directory || process.cwd(),
      configFile: options.config,
      cliConfig: {
        verbose: options.verbose || false,
        quiet: options.quiet || false,
        logLevel: options.logLevel || 'info',
        workingDirectory: options.directory || process.cwd()
      }
    });

    // Validate project context
    const projectLoader = new ProjectContextLoader(config.workingDirectory);
    await projectLoader.validate();

    // Load task instruction
    const instruction = await projectLoader.loadInstruction();

    // Detect git info for context
    const gitInfo = await projectLoader.detectGitInfo();
    if (gitInfo.branch || gitInfo.url) {
      console.log(chalk.gray(`   Git: ${gitInfo.branch || 'unknown'}${gitInfo.url ? ` (${gitInfo.url})` : ''}${gitInfo.commit ? ` @ ${gitInfo.commit}` : ''}`));
    }

    // Create execution request
    const executionRequest = createExecutionRequest({
      instruction,
      subagent: config.defaultSubagent,
      workingDirectory: config.workingDirectory,
      maxIterations: options.maxIterations || config.defaultMaxIterations,
      model: options.model || config.defaultModel
    });

    // Apply command-line overrides
    if (options.maxIterations !== undefined) {
      (executionRequest as any).maxIterations = options.maxIterations;
    }
    if (options.model) {
      (executionRequest as any).model = options.model;
    }

    // Create and initialize coordinator
    const coordinator = new ExecutionCoordinator(config, options.verbose);
    await coordinator.initialize();

    // Execute
    const result = await coordinator.execute(executionRequest);

    // Print session information
    const sessionId = coordinator.getSessionId();
    if (sessionId) {
      console.log(chalk.blue(`\n📁 Session ID: ${sessionId}`));
      console.log(chalk.gray('   Use "juno-task session info ' + sessionId + '" for detailed information'));
    }

    // Set exit code based on result
    const exitCode = result.status === ExecutionStatus.COMPLETED ? 0 : 1;
    process.exit(exitCode);

  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(chalk.red.bold('\n❌ Configuration Error'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(2);
    }

    if (error instanceof FileSystemError) {
      console.error(chalk.red.bold('\n❌ File System Error'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(5);
    }

    if (error instanceof MCPError) {
      console.error(chalk.red.bold('\n❌ MCP Error'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(4);
    }

    // Unexpected error
    console.error(chalk.red.bold('\n❌ Unexpected Error'));
    console.error(chalk.red(`   ${error}`));

    if (options.verbose) {
      console.error('\n📍 Stack Trace:');
      console.error(error);
    }

    process.exit(99);
  }
}

/**
 * Configure the start command for Commander.js
 */
export function configureStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start execution using .juno_task/init.md as prompt')
    .option('-m, --max-iterations <number>', 'Maximum number of iterations', parseInt)
    .option('--model <name>', 'Model to use for execution')
    .option('-d, --directory <path>', 'Project directory (default: current)')
    .action(async (options, command) => {
      await startCommandHandler([], options, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-task start                                   # Start execution in current directory
  $ juno-task start --max-iterations 10              # Limit to 10 iterations
  $ juno-task start --model sonnet-4                 # Use specific model
  $ juno-task start --directory ./my-project         # Execute in specific directory
  $ juno-task start --verbose                        # Show detailed progress
  $ juno-task start --quiet                          # Minimize output

Environment Variables:
  JUNO_TASK_MAX_ITERATIONS      Default maximum iterations
  JUNO_TASK_MODEL              Default model to use
  JUNO_TASK_MCP_SERVER_PATH    Path to MCP server executable
  JUNO_TASK_MCP_TIMEOUT        MCP operation timeout (ms)

Notes:
  - Requires .juno_task/init.md file (created by 'juno-task init')
  - Creates a new session for tracking execution
  - Progress is displayed in real-time
  - Use Ctrl+C to cancel execution gracefully
    `);
}