/**
 * Start command implementation for juno-task-ts CLI
 *
 * Executes tasks using .juno_task/init.md as the prompt with full MCP integration,
 * real-time progress tracking, session management, and comprehensive error handling.
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import { createExecutionEngine, createExecutionRequest, ExecutionStatus } from '../../core/engine.js';
import { createSessionManager } from '../../core/session.js';
import { createMCPClientFromConfig } from '../../mcp/client.js';
import { PerformanceIntegration } from '../utils/performance-integration.js';
import { cliLogger, mcpLogger, engineLogger, sessionLogger, LogLevel } from '../utils/advanced-logger.js';
import { ConcurrentFeedbackCollector } from '../../utils/concurrent-feedback-collector.js';
import type { StartCommandOptions } from '../types.js';
import { ConfigurationError, MCPError, FileSystemError, ValidationError } from '../types.js';
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
    process.stderr.write(chalk.blue.bold('\n🚀 Starting Task Execution') + '\n');
    process.stderr.write(chalk.gray(`   Request ID: ${request.requestId}`) + '\n');
    process.stderr.write(chalk.gray(`   Subagent: ${request.subagent}`) + '\n');
    process.stderr.write(chalk.gray(`   Max Iterations: ${request.maxIterations === -1 ? 'unlimited' : request.maxIterations}`) + '\n');
    process.stderr.write(chalk.gray(`   Working Directory: ${request.workingDirectory}`) + '\n');

    if (request.model) {
      process.stderr.write(chalk.gray(`   Model: ${request.model}`) + '\n');
    }

    process.stderr.write(chalk.blue('\n📋 Task Instructions:') + '\n');
    process.stderr.write(chalk.white(`   ${request.instruction.substring(0, 200)}${request.instruction.length > 200 ? '...' : ''}`) + '\n');
    process.stderr.write('\n');
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

    process.stderr.write(chalk.yellow(`\n🔄 Iteration ${iteration} started ${chalk.gray(`(${elapsed})`)}`) + '\n');
  }

  onIterationComplete(result: IterationResult): void {
    const elapsed = this.getElapsedTime();
    const duration = `${result.duration.toFixed(0)}ms`;

    if (result.success) {
      process.stderr.write(chalk.green(`✅ Iteration ${result.iterationNumber} completed ${chalk.gray(`(${duration}, total: ${elapsed})`)}`) + '\n');
    } else {
      process.stderr.write(chalk.red(`❌ Iteration ${result.iterationNumber} failed ${chalk.gray(`(${duration}, total: ${elapsed})`)}`) + '\n');

      if (result.error && this.verbose) {
        process.stderr.write(chalk.red(`   Error: ${result.error.message}`) + '\n');
      }
    }
  }

  onRateLimit(waitTimeMs: number, resetTime?: Date): void {
    const waitMinutes = Math.ceil(waitTimeMs / 60000);
    const resetTimeStr = resetTime ? resetTime.toLocaleTimeString() : 'unknown';

    process.stderr.write(chalk.yellow(`\n⏳ Rate limit encountered - waiting ${waitMinutes} minutes (resets at ${resetTimeStr})`) + '\n');
  }

  onError(error: Error): void {
    process.stderr.write(chalk.red(`\n❌ Execution error: ${error.message}`) + '\n');
  }

  complete(result: ExecutionResult): void {
    const elapsed = this.getElapsedTime();
    const stats = result.statistics;

    process.stderr.write(chalk.green.bold(`\n✅ Execution Complete! ${chalk.gray(`(${elapsed})`)}`) + '\n');

    process.stderr.write(chalk.blue('\n📊 Execution Summary:') + '\n');
    process.stderr.write(chalk.white(`   Status: ${this.getStatusDisplay(result.status)}`) + '\n');
    process.stderr.write(chalk.white(`   Total Iterations: ${stats.totalIterations}`) + '\n');
    process.stderr.write(chalk.white(`   Successful: ${stats.successfulIterations}`) + '\n');
    process.stderr.write(chalk.white(`   Failed: ${stats.failedIterations}`) + '\n');
    process.stderr.write(chalk.white(`   Average Iteration Time: ${stats.averageIterationDuration.toFixed(0)}ms`) + '\n');
    process.stderr.write(chalk.white(`   Total Tool Calls: ${stats.totalToolCalls}`) + '\n');

    if (stats.rateLimitEncounters > 0) {
      process.stderr.write(chalk.yellow(`   Rate Limit Encounters: ${stats.rateLimitEncounters}`) + '\n');
      process.stderr.write(chalk.yellow(`   Rate Limit Wait Time: ${(stats.rateLimitWaitTime / 1000).toFixed(1)}s`) + '\n');
    }

    if (Object.keys(stats.errorBreakdown).length > 0) {
      process.stderr.write(chalk.red('   Error Breakdown:') + '\n');
      Object.entries(stats.errorBreakdown).forEach(([type, count]) => {
        process.stderr.write(chalk.red(`     ${type}: ${count}`) + '\n');
      });
    }
  }

  private displayVerboseProgress(event: ProgressEvent): void {
    const timestamp = event.timestamp.toLocaleTimeString();
    const backend = event.backend ? `[${event.backend}]` : '';
    const toolId = event.toolId ? `{${event.toolId.split('_')[0]}}` : '';

    // Extract tool name from metadata if available
    const toolName = event.metadata?.toolName || 'unknown';
    const phase = event.metadata?.phase || '';
    const duration = event.metadata?.duration;

    // Format message based on event type
    let formattedMessage = event.content;
    let icon = '';
    let color = chalk.gray;

    switch (event.type) {
      case 'tool_start':
        icon = '🔧';
        color = chalk.blue;
        formattedMessage = `Starting tool: ${toolName}`;
        if (event.metadata?.arguments) {
          formattedMessage += ` with args: ${JSON.stringify(event.metadata.arguments)}`;
        }
        break;
      case 'tool_result':
        icon = '✅';
        color = chalk.green;
        formattedMessage = `Tool completed: ${toolName}`;
        if (duration) {
          formattedMessage += ` (${duration}ms)`;
        }
        break;
      case 'thinking':
        icon = '🤔';
        color = chalk.yellow;
        formattedMessage = `Executing: ${toolName}`;
        break;
      case 'error':
        icon = '❌';
        color = chalk.red;
        formattedMessage = `Tool failed: ${toolName}`;
        if (duration) {
          formattedMessage += ` (${duration}ms)`;
        }
        break;
      case 'info':
        icon = 'ℹ️';
        color = chalk.cyan;
        if (phase === 'connection') {
          formattedMessage = `Connecting to subagent for: ${toolName}`;
        }
        break;
      default:
        formattedMessage = event.content;
        break;
    }

    process.stderr.write(color(`[${timestamp}] ${icon} ${backend}${toolId} ${formattedMessage}`) + '\n');
  }

  private displaySimpleProgress(event: ProgressEvent): void {
    // Show meaningful tool progress information
    const toolName = event.metadata?.toolName;

    if (event.type === 'tool_start' && toolName) {
      process.stdout.write(chalk.blue(`\r🔧 Calling ${toolName}...`));
    } else if (event.type === 'tool_result' && toolName) {
      const duration = event.metadata?.duration;
      const durationText = duration ? ` (${duration}ms)` : '';
      process.stdout.write(chalk.green(`\r✅ ${toolName} completed${durationText}`));
    } else if (event.type === 'thinking') {
      process.stdout.write(chalk.gray(`\r💭 Thinking...`));
    } else if (event.type === 'error') {
      process.stdout.write(chalk.red(`\r❌ Error: ${event.content.substring(0, 50)}...`));
    } else {
      // Fallback to dots for other events
      const dots = '.'.repeat((this.currentIteration % 3) + 1);
      process.stdout.write(chalk.gray(`\r   Processing${dots}   `));
    }
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
  private performanceIntegration: PerformanceIntegration;
  private currentSession: Session | null = null;
  private feedbackCollector: ConcurrentFeedbackCollector | null = null;
  private enableFeedback: boolean = false;

  constructor(
    config: JunoTaskConfig,
    verbose: boolean = false,
    performanceIntegration?: PerformanceIntegration,
    enableFeedback: boolean = false
  ) {
    this.config = config;
    this.progressDisplay = new ProgressDisplay(verbose);
    this.performanceIntegration = performanceIntegration || new PerformanceIntegration();
    this.enableFeedback = enableFeedback;
  }

  async initialize(): Promise<void> {
    this.sessionManager = await createSessionManager(this.config);

    // Initialize feedback collector if enabled
    if (this.enableFeedback) {
      this.feedbackCollector = new ConcurrentFeedbackCollector({
        command: 'juno-ts-task',
        commandArgs: ['feedback'],
        verbose: this.config.verbose,
        showHeader: true,
        progressInterval: 0 // Don't use built-in ticker, we have our own progress display
      });
    }
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    // Start performance monitoring
    const performanceCollector = this.performanceIntegration.startMonitoring({
      sessionId: request.requestId,
      command: 'start',
      arguments: [],
      options: {},
      startTime: Date.now()
    });

    // Declare variables at function scope for cleanup access
    let mcpClient: any = null;
    let engine: any = null;

    try {
      // Create session
      this.performanceIntegration.startTiming(request.requestId, 'session_creation');
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
      this.performanceIntegration.endTiming(request.requestId, 'session_creation');

      // Create MCP client using proper configuration from .juno_task/mcp.json
      this.performanceIntegration.startTiming(request.requestId, 'mcp_client_creation');
      mcpClient = await createMCPClientFromConfig(
        this.config.mcpServerName,
        request.workingDirectory,
        {
          timeout: this.config.mcpTimeout,
          retries: this.config.mcpRetries,
          debug: this.config.verbose,
          enableProgressStreaming: true,
          sessionId: request.requestId,
          progressCallback: async (event: any) => {
            // Route MCP progress events to the progress display (always active)
            this.progressDisplay.onProgress(event);
          }
        }
      );
      this.performanceIntegration.endTiming(request.requestId, 'mcp_client_creation');

      // Create execution engine
      this.performanceIntegration.startTiming(request.requestId, 'engine_creation');
      engine = createExecutionEngine(this.config, mcpClient);
      this.performanceIntegration.endTiming(request.requestId, 'engine_creation');

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
        this.performanceIntegration.startTiming(request.requestId, `iteration_${iterationNumber}`);
      });

      engine.on('iteration:complete', ({ iterationResult }) => {
        this.progressDisplay.onIterationComplete(iterationResult);
        const iterationTime = this.performanceIntegration.endTiming(request.requestId, `iteration_${iterationResult.iterationNumber}`);
        this.performanceIntegration.recordIteration(
          request.requestId,
          iterationResult.success,
          iterationTime
        );
      });

    engine.on('rate-limit:start', ({ waitTimeMs, error }) => {
      this.progressDisplay.onRateLimit(waitTimeMs, error.resetTime);
    });

      engine.on('execution:error', ({ error }) => {
        this.progressDisplay.onError(error);
      });

      // Connect to MCP server
      this.performanceIntegration.startTiming(request.requestId, 'mcp_connection');
      await mcpClient.connect();
      this.performanceIntegration.endTiming(request.requestId, 'mcp_connection');

      // Start progress display
      this.progressDisplay.start(request);

      // Start feedback collector if enabled
      if (this.feedbackCollector) {
        process.stderr.write(chalk.gray('   Feedback collection: enabled (submit with blank line)') + '\n');
        this.feedbackCollector.start();
      }

      // Execute task
      this.performanceIntegration.startTiming(request.requestId, 'task_execution');
      const result = await engine.execute(request);
      this.performanceIntegration.endTiming(request.requestId, 'task_execution');

      // Complete progress display
      this.progressDisplay.complete(result);

      // Update session with results
      this.performanceIntegration.startTiming(request.requestId, 'session_completion');
      await this.sessionManager.completeSession(this.currentSession.info.id, {
        success: result.status === ExecutionStatus.COMPLETED,
        output: result.iterations[result.iterations.length - 1]?.toolResult.content || '',
        finalState: {
          status: result.status,
          statistics: result.statistics,
          iterations: result.iterations.length
        }
      });
      this.performanceIntegration.endTiming(request.requestId, 'session_completion');

      return result;

    } catch (error) {
      // Handle execution error
      if (this.currentSession) {
        await this.sessionManager.completeSession(this.currentSession.info.id, {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Record failed execution
      this.performanceIntegration.recordIteration(request.requestId, false);
      throw error;

    } finally {
      // Cleanup
      this.performanceIntegration.startTiming(request.requestId, 'cleanup');
      try {
        // Stop feedback collector if running
        if (this.feedbackCollector) {
          await this.feedbackCollector.stop();
          const submissionCount = this.feedbackCollector.getSubmissionCount();
          if (submissionCount > 0) {
            process.stderr.write(chalk.blue(`\n📝 Total feedback submissions: ${submissionCount}`) + '\n');
          }
        }

        if (mcpClient) {
          await mcpClient.disconnect();
        }
        if (engine) {
          await engine.shutdown();
        }
      } catch (cleanupError) {
        console.warn(chalk.yellow(`Warning: Cleanup error: ${cleanupError}`));
      }
      this.performanceIntegration.endTiming(request.requestId, 'cleanup');
    }
  }

  getSessionId(): string | null {
    return this.currentSession?.info.id || null;
  }

  getPerformanceIntegration(): PerformanceIntegration {
    return this.performanceIntegration;
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
    // Get global options from command's parent program
    const globalOptions = command.parent?.opts() || {};
    const allOptions = { ...options, ...globalOptions };

    // Successfully merged global and local options
    console.log(chalk.blue.bold('🎯 Juno Task - Start Execution'));

    // Set logging level based on options
    const logLevel = allOptions.logLevel ? LogLevel[allOptions.logLevel.toUpperCase() as keyof typeof LogLevel] : LogLevel.INFO;
    cliLogger.startTimer('start_command_total');
    cliLogger.info('Starting execution command', { options: allOptions, directory: allOptions.directory || process.cwd() });

    // Load configuration
    cliLogger.startTimer('config_loading');
    const config = await loadConfig({
      baseDir: allOptions.directory || process.cwd(),
      configFile: allOptions.config,
      cliConfig: {
        verbose: allOptions.verbose || false,
        quiet: allOptions.quiet || false,
        logLevel: allOptions.logLevel || 'info',
        workingDirectory: allOptions.directory || process.cwd(),
        mcpTimeout: allOptions.mcpTimeout
      }
    });
    cliLogger.endTimer('config_loading', 'Configuration loaded successfully');

    // Validate project context
    cliLogger.startTimer('project_validation');
    const projectLoader = new ProjectContextLoader(config.workingDirectory);
    await projectLoader.validate();
    cliLogger.endTimer('project_validation', 'Project context validated');

    // If dry-run: validate config and environment then exit early
    if ((allOptions as any).dryRun) {
      console.log(chalk.green('✓ Configuration loaded successfully'));
      console.log(chalk.green('✓ Project context validated'));
      console.log(chalk.green('✓ Dry run successful — no execution performed'));
      cliLogger.endTimer('start_command_total', 'Dry run completed successfully');
      process.exit(0);
    }

    // Load task instruction
    cliLogger.startTimer('instruction_loading');
    const instruction = await projectLoader.loadInstruction();
    cliLogger.endTimer('instruction_loading', 'Task instruction loaded', LogLevel.DEBUG);

    // Detect git info for context
    const gitInfo = await projectLoader.detectGitInfo();
    if (gitInfo.branch || gitInfo.url) {
      process.stderr.write(chalk.gray(`   Git: ${gitInfo.branch || 'unknown'}${gitInfo.url ? ` (${gitInfo.url})` : ''}${gitInfo.commit ? ` @ ${gitInfo.commit}` : ''}`) + '\n');
    }

    // Validate subagent if provided via command line
    if (allOptions.subagent) {
      const validSubagents: SubagentType[] = ['claude', 'cursor', 'codex', 'gemini'];
      if (!validSubagents.includes(allOptions.subagent)) {
        throw new ValidationError(
          `Invalid subagent: ${allOptions.subagent}`,
          [
            `Use one of: ${validSubagents.join(', ')}`,
            'Run `juno-task help start` for examples'
          ]
        );
      }
    }

    // Create execution request with subagent override
    const selectedSubagent = allOptions.subagent || config.defaultSubagent;

    const executionRequest = createExecutionRequest({
      instruction,
      subagent: selectedSubagent,
      workingDirectory: config.workingDirectory,
      maxIterations: allOptions.maxIterations || config.defaultMaxIterations,
      model: allOptions.model || config.defaultModel
    });

    // Apply command-line overrides
    if (allOptions.maxIterations !== undefined) {
      (executionRequest as any).maxIterations = allOptions.maxIterations;
    }
    if (allOptions.model) {
      (executionRequest as any).model = allOptions.model;
    }

    // Create performance integration
    const performanceIntegration = new PerformanceIntegration();

    // Create and initialize coordinator
    const coordinator = new ExecutionCoordinator(
      config,
      allOptions.verbose,
      performanceIntegration,
      allOptions.enableFeedback || false
    );
    await coordinator.initialize();

    // Execute
    const result = await coordinator.execute(executionRequest);

    // Complete performance monitoring
    const finalMetrics = await performanceIntegration.completeMonitoring(
      executionRequest.requestId,
      {
        verbose: options.verbose,
        showMetrics: options.showMetrics,
        showDashboard: options.showDashboard,
        saveMetrics: options.saveMetrics,
        metricsFile: options.metricsFile
      }
    );

    // Print session information
    const sessionId = coordinator.getSessionId();
    if (sessionId) {
      process.stderr.write(chalk.blue(`\n📁 Session ID: ${sessionId}`) + '\n');
      process.stderr.write(chalk.gray('   Use "juno-task session info ' + sessionId + '" for detailed information') + '\n');
      sessionLogger.info('Session completed', {
        sessionId,
        status: result.status,
        iterations: result.iterations?.length || 0
      });

      // Show performance trends if requested
      if (options.showTrends) {
        performanceIntegration.displayTrends(10);
      }
    }

    // Complete command timing
    cliLogger.endTimer('start_command_total', 'Start command completed successfully');

    // Set exit code based on result
    const exitCode = result.status === ExecutionStatus.COMPLETED ? 0 : 1;
    cliLogger.info('Command execution finished', { exitCode, status: result.status });
    process.exit(exitCode);

  } catch (error) {
    if (error instanceof ConfigurationError) {
      cliLogger.error('Configuration error occurred', error.message, { suggestions: error.suggestions });
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
    .option('-s, --subagent <name>', 'Subagent to use (claude, cursor, codex, gemini)')
    .option('-i, --max-iterations <number>', 'Maximum number of iterations', parseInt)
    .option('-m, --model <name>', 'Model to use for execution')
    .option('-d, --directory <path>', 'Project directory (default: current)')
    .option('--enable-feedback', 'Enable concurrent feedback collection during execution')
    .option('--show-metrics', 'Display performance metrics summary after execution')
    .option('--show-dashboard', 'Show interactive performance dashboard after execution')
    .option('--show-trends', 'Display performance trends from historical data')
    .option('--save-metrics [file]', 'Save performance metrics to file (default: .juno_task/metrics.json)')
    .option('--metrics-file <path>', 'Specify custom path for metrics file')
    .option('--dry-run', 'Validate configuration and exit without executing')
    .action(async (options, command) => {
      // Set default metrics file if save-metrics is used without value
      if (options.saveMetrics === true) {
        options.saveMetrics = true;
        options.metricsFile = options.metricsFile || '.juno_task/metrics.json';
      }
      await startCommandHandler([], options, command);
    })
    .addHelpText('after', `
Examples:
  $ juno-task start                                   # Start execution in current directory
  $ juno-task start -s claude                        # Use claude subagent
  $ juno-task start --subagent cursor                # Use cursor subagent
  $ juno-task start -s codex --max-iterations 10     # Use codex with 10 iterations
  $ juno-task start --model sonnet-4                 # Use specific model
  $ juno-task start --directory ./my-project         # Execute in specific directory
  $ juno-task start --enable-feedback                # Enable feedback collection while running
  $ juno-task start --verbose                        # Show detailed progress
  $ juno-task start --quiet                          # Minimize output
  $ juno-task start --show-metrics                   # Display performance summary
  $ juno-task start --show-dashboard                 # Interactive performance dashboard
  $ juno-task start --show-trends                    # Show historical performance trends
  $ juno-task start --save-metrics                   # Save metrics to .juno_task/metrics.json
  $ juno-task start --save-metrics custom.json       # Save metrics to custom file

Feedback Collection:
  --enable-feedback             Enable concurrent feedback collection
                                Type multiline feedback and submit with blank line
                                Continue monitoring app progress while typing
                                Feedback is sent to the feedback command automatically

Performance Options:
  --show-metrics                Show performance summary after execution
  --show-dashboard              Launch interactive performance dashboard
  --show-trends                 Display historical performance trends
  --save-metrics [file]         Save metrics to file (optional filename)
  --metrics-file <path>         Custom metrics file path

Environment Variables:
  JUNO_TASK_MAX_ITERATIONS      Default maximum iterations
  JUNO_TASK_MODEL              Default model to use
  JUNO_TASK_MCP_SERVER_PATH    Path to MCP server executable
  JUNO_TASK_MCP_TIMEOUT        MCP operation timeout (ms)

Notes:
  - Requires .juno_task/init.md file (created by 'juno-task init')
  - Creates a new session for tracking execution
  - Progress is displayed in real-time
  - Performance metrics are collected automatically
  - Use --enable-feedback to submit feedback while execution is running
  - Use Ctrl+C to cancel execution gracefully
    `);
}
