/**
 * Main command implementation for juno-code CLI
 *
 * Comprehensive main execution command with full specification compliance.
 * Handles direct subagent execution with support for:
 * - File and inline prompts
 * - Interactive input modes
 * - TUI prompt editor
 * - Environment variable integration
 * - Complete validation and error handling
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';

import { loadConfig } from '../../core/config.js';
import { createCommand, createOption } from '../framework.js';
import { createExecutionEngine, createExecutionRequest } from '../../core/engine.js';
import { createBackendManager, determineBackendType, getBackendDisplayName } from '../../core/backend-manager.js';
import { createSessionManager } from '../../core/session.js';
import { createMCPClientFromConfig } from '../../mcp/client.js';
import { isHeadlessEnvironment as isHeadless } from '../../utils/environment.js';
import { ConcurrentFeedbackCollector } from '../../utils/concurrent-feedback-collector.js';
import { writeTerminalProgress } from '../../utils/terminal-progress-writer.js';
import type {
  MainCommandOptions,
  CLICommand
} from '../types.js';
import {
  ValidationError,
  ConfigurationError,
  MCPError,
  FileSystemError
} from '../types.js';
import type { SubagentType, JunoTaskConfig } from '../../types/index.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ProgressEvent
} from '../../core/engine.js';
import { ExecutionStatus } from '../../core/engine.js';

/**
 * Prompt input processor for handling various input types
 */
class PromptProcessor {
  constructor(private options: MainCommandOptions) {}

  async processPrompt(): Promise<string> {
    const { prompt, interactivePrompt } = this.options;

    // Handle --interactive-prompt (TUI editor)
    if (interactivePrompt) {
      return await this.launchTUIPromptEditor(prompt);
    }

    if (!prompt) {
      if (this.options.interactive) {
        return await this.collectInteractivePrompt();
      } else {
        // Try default prompt file: .juno_task/prompt.md
        const defaultPromptPath = path.join(process.cwd(), '.juno_task', 'prompt.md');
        if (await fs.pathExists(defaultPromptPath)) {
          console.error(chalk.blue(`📄 Using default prompt: ${chalk.cyan('.juno_task/prompt.md')}`));
          return await this.loadPromptFromFile(defaultPromptPath);
        } else {
          throw new ValidationError(
            'Prompt is required for execution',
            [
              'Provide prompt text: juno-code claude "your prompt here"',
              'Use file input: juno-code claude prompt.txt',
              'Use interactive mode: juno-code claude --interactive',
              'Use TUI editor: juno-code claude --interactive-prompt',
              'Create default prompt file: .juno_task/prompt.md'
            ]
          );
        }
      }
    }

    // Check if prompt is a file path
    if (await this.isFilePath(prompt)) {
      return await this.loadPromptFromFile(prompt);
    }

    // Direct prompt text
    return prompt.trim();
  }

  private async isFilePath(prompt: string): Promise<boolean> {
    // Check if it looks like a file path and exists
    if (prompt.includes('\n') || prompt.length > 500) {
      return false; // Too long or multiline to be a file path
    }

    try {
      const resolvedPath = path.resolve(prompt);
      return await fs.pathExists(resolvedPath);
    } catch {
      return false;
    }
  }

  private async loadPromptFromFile(filePath: string): Promise<string> {
    try {
      const resolvedPath = path.resolve(filePath);
      const content = await fs.readFile(resolvedPath, 'utf-8');

      if (!content.trim()) {
        throw new FileSystemError(
          'Prompt file is empty',
          resolvedPath
        );
      }

      console.error(chalk.blue(`📄 Loaded prompt from: ${chalk.cyan(path.relative(process.cwd(), resolvedPath))}`));
      return content.trim();
    } catch (error) {
      if (error instanceof FileSystemError) {
        throw error;
      }

      throw new FileSystemError(
        `Failed to read prompt file: ${error}`,
        filePath
      );
    }
  }

  private async launchTUIPromptEditor(initialValue?: string): Promise<string> {
    try {
      // Dynamic import to avoid loading TUI in headless environments
      const { launchPromptEditor, isTUISupported, safeTUIExecution } = await import('../../tui/index.js');

      console.error(chalk.blue.bold('\n🎨 Launching TUI Prompt Editor...\n'));

      return await safeTUIExecution(
        // TUI function
        async () => {
          const result = await launchPromptEditor({
            initialValue: initialValue || '',
            title: `Prompt Editor - ${this.options.subagent}`,
            maxLength: 10000
          });

          if (!result) {
            throw new ValidationError(
              'Prompt editor was cancelled',
              ['Try again with --interactive-prompt', 'Use --interactive for simple input']
            );
          }

          return result;
        },
        // Fallback function
        async () => {
          console.error(chalk.yellow('TUI not available, falling back to interactive mode...'));
          return await this.collectInteractivePrompt();
        }
      );

    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }

      throw new ValidationError(
        `Failed to launch TUI prompt editor: ${error}`,
        [
          'Try using --interactive for simple input',
          'Ensure terminal supports TUI',
          'Check that dependencies are installed'
        ]
      );
    }
  }

  private async collectInteractivePrompt(): Promise<string> {
    console.error(chalk.blue.bold('\n✏️  Interactive Prompt Mode\n'));
    console.error(chalk.yellow('Enter your prompt (press Ctrl+D when finished):'));
    console.error(chalk.gray('You can type multiple lines. End with Ctrl+D (Unix) or Ctrl+Z (Windows).\n'));

    return new Promise((resolve, reject) => {
      let input = '';

      process.stdin.setEncoding('utf8');
      process.stdin.resume();

      process.stdin.on('data', (chunk) => {
        input += chunk;
      });

      process.stdin.on('end', () => {
        const trimmed = input.trim();
        if (!trimmed) {
          reject(new ValidationError(
            'Empty prompt provided',
            ['Provide meaningful prompt text', 'Use --help for usage examples']
          ));
        } else {
          resolve(trimmed);
        }
      });

      process.stdin.on('error', (error) => {
        reject(new FileSystemError(
          `Failed to read interactive input: ${error}`,
          'stdin'
        ));
      });
    });
  }
}

/**
 * Execution progress display for main command
 */
class MainProgressDisplay {
  private startTime: Date = new Date();
  private currentIteration: number = 0;
  private verbose: boolean;
  private hasStreamedJsonOutput: boolean = false; // Track if we streamed JSON output via progress events

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  start(request: ExecutionRequest): void {
    this.startTime = new Date();
    console.error(chalk.blue.bold('\n🚀 Executing with ' + request.subagent.charAt(0).toUpperCase() + request.subagent.slice(1)));

    if (this.verbose) {
      console.error(chalk.gray(`   Request ID: ${request.requestId}`));
      console.error(chalk.gray(`   Max Iterations: ${request.maxIterations === -1 ? 'unlimited' : request.maxIterations}`));
      console.error(chalk.gray(`   Working Directory: ${request.workingDirectory}`));
      if (request.model) {
        console.error(chalk.gray(`   Model: ${request.model}`));
      }
    }

    console.error(chalk.blue('\n📋 Task:'));
    const preview = request.instruction.length > 200
      ? request.instruction.substring(0, 200) + '...'
      : request.instruction;
    console.error(chalk.white(`   ${preview}`));
    console.error('');
  }

  onProgress(event: ProgressEvent): void {
    const timestamp = event.timestamp.toLocaleTimeString();

    // If this is raw JSON output from shell backend (jq-style formatting)
    // OR if this is TEXT format streaming from shell backend (codex.py)
    // Mark that we're streaming output - this means we should NOT print the accumulated result later
    if (event.metadata?.rawJsonOutput || (event.metadata?.format === 'text' && event.metadata?.raw === true)) {
      this.hasStreamedJsonOutput = true;
    }

    // If this is raw JSON output from shell backend (jq-style formatting)
    // Display it with colors and indentation like `claude.py | jq .`
    if (event.metadata?.rawJsonOutput) {

      try {
        // Parse and re-format with indentation
        const jsonObj = JSON.parse(event.content);
        const formattedJson = this.colorizeJson(jsonObj);
        const backend = event.backend ? chalk.cyan(`[${event.backend}]`) : '';

        if (this.verbose) {
          // Verbose mode: Show pretty formatted JSON with timestamp and backend prefix on STDERR
          // Raw JSON is already printed by stdout (shell backend streams it directly)
          console.error(`${chalk.gray(timestamp)} ${backend} ${formattedJson}`);
        } else {
          // Non-verbose mode: Show JSON with backend prefix on STDERR
          console.error(`${backend} ${formattedJson}`);
        }
        return;
      } catch (error) {
        // If JSON parsing fails, fall back to raw output
        const backend = event.backend ? `[${event.backend}]` : '';
        console.error(`${chalk.gray(timestamp)} ${backend} ${event.content}`);
        return;
      }
    }

    // Try to parse content as JSON for jq-style formatting
    // This handles codex output which sends TEXT format but contains JSON
    try {
      const jsonObj = JSON.parse(event.content);
      const formattedJson = this.colorizeJson(jsonObj);
      // Show clean JSON output without prefixes (user wants clean output)
      console.error(formattedJson);
      return;
    } catch (error) {
      // Not JSON - show raw content without prefix (user wants clean output)
      console.error(event.content);
    }
  }

  /**
   * Colorize JSON object for pretty terminal output (jq-style)
   */
  private colorizeJson(obj: any): string {
    const json = JSON.stringify(obj, null, 2);

    // Apply colors to different JSON elements
    let colored = json
      // Keys (property names)
      .replace(/"([^"]+)":/g, (match, key) => `${chalk.blue(`"${key}"`)}:`)
      // String values
      .replace(/: "([^"]*)"/g, (match, value) => `: ${chalk.green(`"${value}"`)}`)
      // Numbers
      .replace(/: (\d+\.?\d*)/g, (match, num) => `: ${chalk.yellow(num)}`)
      // Booleans and null
      .replace(/: (true|false|null)/g, (match, val) => `: ${chalk.magenta(val)}`);

    return colored;
  }

  /**
   * Get color for event type (MCP-style)
   */
  private getEventTypeColor(type: string): typeof chalk.green {
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

  onIterationStart(iteration: number): void {
    this.currentIteration = iteration;
    if (!this.verbose) {
      process.stderr.write(chalk.yellow(`\n🔄 Iteration ${iteration} `));
    } else {
      const elapsed = this.getElapsedTime();
      console.error(chalk.yellow(`\n🔄 Iteration ${iteration} started (${elapsed})`));
    }
  }

  onIterationComplete(success: boolean, duration: number): void {
    if (!this.verbose) {
      const icon = success ? chalk.green('✓') : chalk.red('✗');
      console.error(` ${icon}`);
    } else {
      const elapsed = this.getElapsedTime();
      const durationText = `${duration.toFixed(0)}ms`;
      if (success) {
        console.error(chalk.green(`✅ Iteration ${this.currentIteration} completed (${durationText}, total: ${elapsed})`));
      } else {
        console.error(chalk.red(`❌ Iteration ${this.currentIteration} failed (${durationText}, total: ${elapsed})`));
      }
    }
  }

  complete(result: ExecutionResult): void {
    const elapsed = this.getElapsedTime();

    // Send completion status to STDERR (progress messages)
    if (result.status === ExecutionStatus.COMPLETED) {
      console.error(chalk.green.bold(`\n✅ Execution completed successfully! (${elapsed})`));
    } else {
      console.error(chalk.red.bold(`\n❌ Execution failed (${elapsed})`));
    }

    // Show final result heading on STDERR, actual result content on STDOUT
    // NOTE: If we streamed JSON output via progress events (hasStreamedJsonOutput=true),
    // skip printing the accumulated toolResult.content to avoid duplication
    const lastIteration = result.iterations[result.iterations.length - 1];
    if (lastIteration && lastIteration.toolResult.content && !this.hasStreamedJsonOutput) {
      console.error(chalk.blue('\n📄 Result:'));
      // Final result goes to STDOUT for variable capture
      console.log(lastIteration.toolResult.content);
    }

    // Show statistics on STDERR if verbose
    if (this.verbose) {
      const stats = result.statistics;
      console.error(chalk.blue('\n📊 Statistics:'));
      console.error(chalk.white(`   Total Iterations: ${stats.totalIterations}`));
      console.error(chalk.white(`   Successful: ${stats.successfulIterations}`));
      console.error(chalk.white(`   Failed: ${stats.failedIterations}`));
      console.error(chalk.white(`   Average Duration: ${stats.averageIterationDuration.toFixed(0)}ms`));
      console.error(chalk.white(`   Tool Calls: ${stats.totalToolCalls}`));

      if (stats.rateLimitEncounters > 0) {
        console.error(chalk.yellow(`   Rate Limits: ${stats.rateLimitEncounters}`));
      }
    }
  }

  onError(error: Error): void {
    console.error(chalk.red(`\n❌ Execution error: ${error.message}`));
  }

  private getElapsedTime(): string {
    const elapsed = Date.now() - this.startTime.getTime();
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }
}

/**
 * Main command execution coordinator
 */
class MainExecutionCoordinator {
  private config: any;
  private progressDisplay: MainProgressDisplay;
  private feedbackCollector: ConcurrentFeedbackCollector | null = null;
  private enableFeedback: boolean = false;

  constructor(config: any, verbose: boolean = false, enableFeedback: boolean = false) {
    this.config = config;
    this.progressDisplay = new MainProgressDisplay(verbose);
    this.enableFeedback = enableFeedback;

    // Initialize feedback collector if enabled
    if (this.enableFeedback) {
      this.feedbackCollector = new ConcurrentFeedbackCollector({
        command: 'juno-code',
        commandArgs: ['feedback'],
        verbose: this.config.verbose,
        showHeader: true,
        progressInterval: 0 // Don't use built-in ticker, we have our own progress display
      });
    }
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    // Determine backend type from request
    const selectedBackend = determineBackendType(
      request.backend,
      process.env.JUNO_CODE_AGENT || process.env.JUNO_CODE_BACKEND,
      this.config.defaultBackend || 'mcp'
    );

    // Log backend selection if verbose
    if (this.config.verbose) {
      console.error(chalk.gray(`   Backend: ${getBackendDisplayName(selectedBackend)}`));
    }

    // Create backend manager with selected backend
    const backendManager = createBackendManager({
      defaultBackend: selectedBackend,
      availableBackends: ['mcp', 'shell'],
      backendConfigs: {
        mcp: {},
        shell: {}
      }
    });

    // Create execution engine
    const engine = createExecutionEngine(this.config, backendManager);

    // Set up progress callback
    engine.onProgress(async (event: any) => {
      // Route progress events to the progress display (always show progress)
      this.progressDisplay.onProgress(event);
    });

    // Set up event handlers
    engine.on('iteration:start', ({ iterationNumber }) => {
      this.progressDisplay.onIterationStart(iterationNumber);
    });

    engine.on('iteration:complete', ({ iterationResult }) => {
      this.progressDisplay.onIterationComplete(
        iterationResult.success,
        iterationResult.duration
      );
    });

    engine.on('execution:error', ({ error }) => {
      this.progressDisplay.onError(error);
    });

    try {
      // Start progress display
      this.progressDisplay.start(request);

      // Start feedback collector if enabled
      if (this.feedbackCollector) {
        writeTerminalProgress(chalk.gray('   Feedback collection: enabled (Type F+Enter to enter feedback mode)') + '\n');
        this.feedbackCollector.start();
      }

      // Execute task
      const result = await engine.execute(request);

      // Complete progress display
      this.progressDisplay.complete(result);

      return result;

    } catch (error) {
      throw error;

    } finally {
      // Stop feedback collector if it was started
      if (this.feedbackCollector) {
        await this.feedbackCollector.stop();
      }

      // Cleanup
      try {
        await engine.shutdown();
        await backendManager.cleanup();
      } catch (cleanupError) {
        console.warn(chalk.yellow(`Warning: Cleanup error: ${cleanupError}`));
      }
    }
  }
}

/**
 * Main command handler
 */
export async function mainCommandHandler(
  args: string[],
  options: MainCommandOptions,
  command: Command
): Promise<void> {
  try {
    // Validate subagent
    const validSubagents: SubagentType[] = ['claude', 'cursor', 'codex', 'gemini'];
    if (!validSubagents.includes(options.subagent)) {
      throw new ValidationError(
        `Invalid subagent: ${options.subagent}`,
        [
          `Use one of: ${validSubagents.join(', ')}`,
          'Example: juno-code claude "your prompt"',
          'Use --help for more information'
        ]
      );
    }

    // Load configuration
    const config = await loadConfig({
      baseDir: options.cwd || process.cwd(),
      configFile: options.config,
      cliConfig: {
        verbose: options.verbose || false,
        quiet: options.quiet || false,
        logLevel: options.logLevel || 'info',
        workingDirectory: options.cwd || process.cwd()
      }
    });

    // Process prompt
    const promptProcessor = new PromptProcessor(options);
    const instruction = await promptProcessor.processPrompt();

    // Determine backend type from options, environment variable, or config default
    const selectedBackend = determineBackendType(
      options.backend,
      process.env.JUNO_CODE_AGENT || process.env.JUNO_CODE_BACKEND,
      config.defaultBackend || 'mcp'
    );

    // Log backend selection if verbose
    if (options.verbose) {
      console.error(chalk.gray(`   Backend: ${getBackendDisplayName(selectedBackend)}`));
    }

    // Check if --agents flag is used with non-shell backend
    if (options.agents && selectedBackend !== 'shell') {
      console.error(chalk.yellow('\n⚠️  Note: --agents flag is only supported with shell backend and will be ignored'));
    }

    // Check if --tools, --allowed-tools or --disallowed-tools flags are used with non-shell backend
    if ((options.tools || options.allowedTools || options.disallowedTools) && selectedBackend !== 'shell') {
      console.error(chalk.yellow('\n⚠️  Note: --tools, --allowed-tools and --disallowed-tools flags are only supported with shell backend and will be ignored'));
    }

    // Create execution request
    // Pass both --tools and --allowed-tools as separate parameters
    const executionRequest = createExecutionRequest({
      instruction,
      subagent: options.subagent,
      backend: selectedBackend,
      workingDirectory: config.workingDirectory,
      maxIterations: options.maxIterations || config.defaultMaxIterations,
      model: options.model || config.defaultModel,
      agents: options.agents,
      tools: options.tools,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools
    });

    // Execute
    const coordinator = new MainExecutionCoordinator(config, options.verbose, options.enableFeedback || false);
    const result = await coordinator.execute(executionRequest);

    // Set exit code based on result
    const exitCode = result.status === ExecutionStatus.COMPLETED ? 0 : 1;
    process.exit(exitCode);

  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(chalk.red.bold('\n❌ Validation Error'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(1);
    }

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
 * Create the main execution command according to specification
 */
export function createMainCommand(): CLICommand {
  return createCommand({
    name: 'main',
    description: 'Execute subagents in a loop with iterative prompt execution',
    options: [
      createOption({
        flags: '-s, --subagent <type>',
        description: 'Subagent to use',
        required: true,
        choices: ['claude', 'cursor', 'codex', 'gemini', 'claude-code', 'claude_code', 'gemini-cli', 'cursor-agent'],
        env: 'JUNO_CODE_SUBAGENT'
      }),
      createOption({
        flags: '-p, --prompt <text|file>',
        description: 'Prompt input (file path or inline text)',
        env: 'JUNO_CODE_PROMPT'
      }),
      createOption({
        flags: '-w, --cwd <path>',
        description: 'Working directory',
        defaultValue: process.cwd(),
        env: 'JUNO_CODE_CWD'
      }),
      createOption({
        flags: '-i, --max-iterations <number>',
        description: 'Maximum iterations (-1 for unlimited)',
        env: 'JUNO_CODE_MAX_ITERATIONS'
      }),
      createOption({
        flags: '-m, --model <name>',
        description: 'Model to use (optional, subagent-specific)',
        env: 'JUNO_CODE_MODEL'
      }),
      createOption({
        flags: '--agents <config>',
        description: 'Agents configuration (forwarded to shell backend, ignored for MCP)',
        env: 'JUNO_CODE_AGENTS'
      }),
      createOption({
        flags: '-I, --interactive',
        description: 'Interactive mode for typing/pasting prompts',
        defaultValue: false,
        env: 'JUNO_CODE_INTERACTIVE'
      }),
      createOption({
        flags: '--interactive-prompt',
        description: 'Launch Rich TUI prompt editor',
        defaultValue: false
      })
    ],
    examples: [
      {
        command: 'juno-code -s claude -p "Create a REST API"',
        description: 'Execute task with Claude using inline prompt'
      },
      {
        command: 'juno-code -s cursor -p ./task.md -i 3',
        description: 'Execute task with Cursor using file prompt, max 3 iterations'
      },
      {
        command: 'juno-code -s gemini --interactive',
        description: 'Use interactive mode to enter prompt'
      },
      {
        command: 'juno-code -s claude --interactive-prompt',
        description: 'Use enhanced TUI prompt editor'
      }
    ],
    handler: mainCommandHandler
  });
}