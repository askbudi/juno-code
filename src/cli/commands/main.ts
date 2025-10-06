/**
 * Main command implementation for juno-task-ts CLI
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
import * as fs from 'fs-extra';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';

import { loadCLIConfig, createCommand, createOption } from '../framework.js';
import { createExecutionEngine, createExecutionRequest } from '../../core/engine.js';
import { createSessionManager } from '../../core/session.js';
import { createMCPClient } from '../../mcp/client.js';
import { isHeadless } from '../../utils/environment.js';
import type {
  MainCommandOptions,
  ValidationError,
  ConfigurationError,
  MCPError,
  FileSystemError,
  CLICommand
} from '../types.js';
import type { SubagentType, JunoTaskConfig } from '../../types/index.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ProgressEvent,
  ExecutionStatus
} from '../../core/engine.js';

/**
 * Prompt input processor for handling various input types
 */
class PromptProcessor {
  constructor(private options: MainCommandOptions) {}

  async processPrompt(): Promise<string> {
    const { prompt } = this.options;

    if (!prompt) {
      if (this.options.interactive) {
        return await this.collectInteractivePrompt();
      } else {
        throw new ValidationError(
          'Prompt is required for execution',
          [
            'Provide prompt text: juno-task claude "your prompt here"',
            'Use file input: juno-task claude prompt.txt',
            'Use interactive mode: juno-task claude --interactive'
          ]
        );
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

      console.log(chalk.blue(`📄 Loaded prompt from: ${chalk.cyan(path.relative(process.cwd(), resolvedPath))}`));
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

  private async collectInteractivePrompt(): Promise<string> {
    console.log(chalk.blue.bold('\n✏️  Interactive Prompt Mode\n'));
    console.log(chalk.yellow('Enter your prompt (press Ctrl+D when finished):'));
    console.log(chalk.gray('You can type multiple lines. End with Ctrl+D (Unix) or Ctrl+Z (Windows).\n'));

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

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  start(request: ExecutionRequest): void {
    this.startTime = new Date();
    console.log(chalk.blue.bold('\n🚀 Executing with ' + request.subagent.charAt(0).toUpperCase() + request.subagent.slice(1)));

    if (this.verbose) {
      console.log(chalk.gray(`   Request ID: ${request.requestId}`));
      console.log(chalk.gray(`   Max Iterations: ${request.maxIterations === -1 ? 'unlimited' : request.maxIterations}`));
      console.log(chalk.gray(`   Working Directory: ${request.workingDirectory}`));
      if (request.model) {
        console.log(chalk.gray(`   Model: ${request.model}`));
      }
    }

    console.log(chalk.blue('\n📋 Task:'));
    const preview = request.instruction.length > 200
      ? request.instruction.substring(0, 200) + '...'
      : request.instruction;
    console.log(chalk.white(`   ${preview}`));
    console.log('');
  }

  onProgress(event: ProgressEvent): void {
    if (this.verbose) {
      const timestamp = event.timestamp.toLocaleTimeString();
      const content = event.content.length > 100
        ? event.content.substring(0, 100) + '...'
        : event.content;
      console.log(chalk.gray(`[${timestamp}] ${event.type}: ${content}`));
    } else {
      // Simple progress indicator
      process.stdout.write(chalk.blue('.'));
    }
  }

  onIterationStart(iteration: number): void {
    this.currentIteration = iteration;
    if (!this.verbose) {
      process.stdout.write(chalk.yellow(`\n🔄 Iteration ${iteration} `));
    } else {
      const elapsed = this.getElapsedTime();
      console.log(chalk.yellow(`\n🔄 Iteration ${iteration} started (${elapsed})`));
    }
  }

  onIterationComplete(success: boolean, duration: number): void {
    if (!this.verbose) {
      const icon = success ? chalk.green('✓') : chalk.red('✗');
      console.log(` ${icon}`);
    } else {
      const elapsed = this.getElapsedTime();
      const durationText = `${duration.toFixed(0)}ms`;
      if (success) {
        console.log(chalk.green(`✅ Iteration ${this.currentIteration} completed (${durationText}, total: ${elapsed})`));
      } else {
        console.log(chalk.red(`❌ Iteration ${this.currentIteration} failed (${durationText}, total: ${elapsed})`));
      }
    }
  }

  complete(result: ExecutionResult): void {
    const elapsed = this.getElapsedTime();

    if (result.status === ExecutionStatus.COMPLETED) {
      console.log(chalk.green.bold(`\n✅ Execution completed successfully! (${elapsed})`));
    } else {
      console.log(chalk.red.bold(`\n❌ Execution failed (${elapsed})`));
    }

    // Show final result
    const lastIteration = result.iterations[result.iterations.length - 1];
    if (lastIteration && lastIteration.toolResult.content) {
      console.log(chalk.blue('\n📄 Result:'));
      console.log(chalk.white(lastIteration.toolResult.content));
    }

    // Show statistics if verbose
    if (this.verbose) {
      const stats = result.statistics;
      console.log(chalk.blue('\n📊 Statistics:'));
      console.log(chalk.white(`   Total Iterations: ${stats.totalIterations}`));
      console.log(chalk.white(`   Successful: ${stats.successfulIterations}`));
      console.log(chalk.white(`   Failed: ${stats.failedIterations}`));
      console.log(chalk.white(`   Average Duration: ${stats.averageIterationDuration.toFixed(0)}ms`));
      console.log(chalk.white(`   Tool Calls: ${stats.totalToolCalls}`));

      if (stats.rateLimitEncounters > 0) {
        console.log(chalk.yellow(`   Rate Limits: ${stats.rateLimitEncounters}`));
      }
    }
  }

  onError(error: Error): void {
    console.log(chalk.red(`\n❌ Execution error: ${error.message}`));
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

  constructor(config: any, verbose: boolean = false) {
    this.config = config;
    this.progressDisplay = new MainProgressDisplay(verbose);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
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
      // Connect to MCP server
      await mcpClient.connect();

      // Start progress display
      this.progressDisplay.start(request);

      // Execute task
      const result = await engine.execute(request);

      // Complete progress display
      this.progressDisplay.complete(result);

      return result;

    } catch (error) {
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
          'Example: juno-task claude "your prompt"',
          'Use --help for more information'
        ]
      );
    }

    // Load configuration
    const config = await loadConfig({
      baseDir: options.cwd || process.cwd(),
      configFile: options.config,
      cliConfig: {
        verbose: options.verbose,
        quiet: options.quiet,
        logLevel: options.logLevel,
        workingDirectory: options.cwd || process.cwd()
      }
    });

    // Process prompt
    const promptProcessor = new PromptProcessor(options);
    const instruction = await promptProcessor.processPrompt();

    // Create execution request
    const executionRequest = createExecutionRequest({
      instruction,
      subagent: options.subagent,
      workingDirectory: config.workingDirectory,
      maxIterations: options.maxIterations || config.defaultMaxIterations,
      model: options.model || config.defaultModel
    });

    // Execute
    const coordinator = new MainExecutionCoordinator(config, options.verbose);
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
        env: 'JUNO_TASK_SUBAGENT'
      }),
      createOption({
        flags: '-p, --prompt <text|file>',
        description: 'Prompt input (file path or inline text)',
        env: 'JUNO_TASK_PROMPT'
      }),
      createOption({
        flags: '-w, --cwd <path>',
        description: 'Working directory',
        defaultValue: process.cwd(),
        env: 'JUNO_TASK_CWD'
      }),
      createOption({
        flags: '-i, --max-iterations <number>',
        description: 'Maximum iterations (-1 for unlimited)',
        defaultValue: 1,
        env: 'JUNO_TASK_MAX_ITERATIONS'
      }),
      createOption({
        flags: '-m, --model <name>',
        description: 'Model to use (optional, subagent-specific)',
        env: 'JUNO_TASK_MODEL'
      }),
      createOption({
        flags: '-I, --interactive',
        description: 'Interactive mode for typing/pasting prompts',
        defaultValue: false,
        env: 'JUNO_TASK_INTERACTIVE'
      }),
      createOption({
        flags: '--interactive-prompt',
        description: 'Launch Rich TUI prompt editor',
        defaultValue: false
      })
    ],
    examples: [
      {
        command: 'juno-task -s claude -p "Create a REST API"',
        description: 'Execute task with Claude using inline prompt'
      },
      {
        command: 'juno-task -s cursor -p ./task.md -i 3',
        description: 'Execute task with Cursor using file prompt, max 3 iterations'
      },
      {
        command: 'juno-task -s gemini --interactive',
        description: 'Use interactive mode to enter prompt'
      },
      {
        command: 'juno-task -s claude --interactive-prompt',
        description: 'Use enhanced TUI prompt editor'
      }
    ],
    handler: mainCommandHandler
  });
}