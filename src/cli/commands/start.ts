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
import { createMCPClient } from '../../mcp/client.js';
import { PerformanceIntegration } from '../utils/performance-integration.js';
import { cliLogger, mcpLogger, engineLogger, sessionLogger, LogLevel } from '../utils/advanced-logger.js';
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

    console.log(color(`[${timestamp}] ${icon} ${backend}${toolId} ${formattedMessage}`));
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

  constructor(
    config: JunoTaskConfig,
    verbose: boolean = false,
    performanceIntegration?: PerformanceIntegration
  ) {
    this.config = config;
    this.progressDisplay = new ProgressDisplay(verbose);
    this.performanceIntegration = performanceIntegration || new PerformanceIntegration();
  }

  async initialize(): Promise<void> {
    this.sessionManager = await createSessionManager(this.config);
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

      // Create MCP client - prioritize server name over server path
      this.performanceIntegration.startTiming(request.requestId, 'mcp_client_creation');
      let mcpClientOptions: any = {
        timeout: this.config.mcpTimeout,
        retries: this.config.mcpRetries,
        workingDirectory: request.workingDirectory,
        debug: this.config.verbose,
        enableProgressStreaming: true,
        sessionId: request.requestId,
        progressCallback: async (event: any) => {
          // Route MCP progress events to the progress display (always active)
          this.progressDisplay.onProgress(event);
        }
      };

      // TEMPORARY: Force server path approach for debugging
      if (false && this.config.mcpServerName) {
        // Use named server (preferred approach)
        mcpClientOptions.serverName = this.config.mcpServerName;

      } else if (this.config.mcpServerPath) {
        // Use server path
        mcpClientOptions.serverPath = this.config.mcpServerPath;

        if (this.config.verbose) {
          console.log(chalk.gray(`   Using MCP server path: ${this.config.mcpServerPath}`));
        }
      } else {
        // TEMPORARY: Force a specific server path for debugging
        mcpClientOptions.serverPath = '/Users/mahdiyar/miniconda3/envs/tmp_test/bin/roundtable-mcp-server';
      }

      mcpClient = createMCPClient(mcpClientOptions);
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
        workingDirectory: allOptions.directory || process.cwd()
      }
    });
    cliLogger.endTimer('config_loading', 'Configuration loaded successfully');

    // Validate project context
    cliLogger.startTimer('project_validation');
    const projectLoader = new ProjectContextLoader(config.workingDirectory);
    await projectLoader.validate();
    cliLogger.endTimer('project_validation', 'Project context validated');

    // Load task instruction
    cliLogger.startTimer('instruction_loading');
    const instruction = await projectLoader.loadInstruction();
    cliLogger.endTimer('instruction_loading', 'Task instruction loaded', LogLevel.DEBUG);

    // Detect git info for context
    const gitInfo = await projectLoader.detectGitInfo();
    if (gitInfo.branch || gitInfo.url) {
      console.log(chalk.gray(`   Git: ${gitInfo.branch || 'unknown'}${gitInfo.url ? ` (${gitInfo.url})` : ''}${gitInfo.commit ? ` @ ${gitInfo.commit}` : ''}`));
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
    const coordinator = new ExecutionCoordinator(config, allOptions.verbose, performanceIntegration);
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
      console.log(chalk.blue(`\n📁 Session ID: ${sessionId}`));
      console.log(chalk.gray('   Use "juno-task session info ' + sessionId + '" for detailed information'));
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
    .option('--show-metrics', 'Display performance metrics summary after execution')
    .option('--show-dashboard', 'Show interactive performance dashboard after execution')
    .option('--show-trends', 'Display performance trends from historical data')
    .option('--save-metrics [file]', 'Save performance metrics to file (default: .juno_task/metrics.json)')
    .option('--metrics-file <path>', 'Specify custom path for metrics file')
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
  $ juno-task start --verbose                        # Show detailed progress
  $ juno-task start --quiet                          # Minimize output
  $ juno-task start --show-metrics                   # Display performance summary
  $ juno-task start --show-dashboard                 # Interactive performance dashboard
  $ juno-task start --show-trends                    # Show historical performance trends
  $ juno-task start --save-metrics                   # Save metrics to .juno_task/metrics.json
  $ juno-task start --save-metrics custom.json       # Save metrics to custom file

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
  - Use Ctrl+C to cancel execution gracefully
    `);
}