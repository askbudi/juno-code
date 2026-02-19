/**
 * Main command implementation for juno-code CLI
 *
 * Comprehensive main execution command with full specification compliance.
 * Handles direct subagent execution with support for:
 * - File and inline prompts
 * - Interactive input modes
 * - Environment variable integration
 * - Complete validation and error handling
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import { createExecutionEngine, createExecutionRequest } from '../../core/engine.js';
import { ConcurrentFeedbackCollector } from '../../utils/concurrent-feedback-collector.js';
import { writeTerminalProgress } from '../../utils/terminal-progress-writer.js';
import type { MainCommandOptions } from '../types.js';
import { ValidationError, ConfigurationError, RuntimeError } from '../types.js';
import type { SubagentType } from '../../types/index.js';
import type { ExecutionRequest, ExecutionResult } from '../../core/engine.js';
import { ExecutionStatus } from '../../core/engine.js';
import type { ProgressEvent } from '../../types/execution.js';

/**
 * Get the default model for a given subagent type.
 * Returns shorthand model names with ':' prefix for proper resolution by service scripts.
 *
 * This ensures that when no -m flag is provided, each subagent uses its appropriate
 * default model rather than falling back to the config's defaultModel (which may be
 * set for a different subagent).
 */
function getDefaultModelForSubagent(subagent: SubagentType): string {
  const modelDefaults: Record<SubagentType, string> = {
    claude: ':sonnet',
    codex: ':codex', // Expands to gpt-5.3-codex in codex.py
    gemini: ':pro', // Expands to gemini-2.5-pro in gemini.py
    cursor: 'auto',
    pi: ':pi', // Expands to anthropic/claude-sonnet-4-6 in pi.py
  };
  return modelDefaults[subagent] || modelDefaults.claude;
}

/**
 * Check if a model string is compatible with a given subagent.
 * This prevents using Claude model shorthands with Codex, and vice versa.
 *
 * Model shorthands starting with ':' are mapped to specific subagents:
 * - Claude: :sonnet, :haiku, :opus, :claude-*
 * - Codex: :codex, :codex-mini, :gpt-5, :mini
 * - Gemini: :pro, :flash, :gemini-*
 * - Pi: all shorthands accepted (multi-provider agent)
 *
 * Full model names (not shorthands) are always considered compatible
 * as users may have custom configurations.
 */
function isModelCompatibleWithSubagent(model: string, subagent: SubagentType): boolean {
  // Non-shorthand models are always allowed (user explicitly configured them)
  if (!model.startsWith(':')) {
    return true;
  }

  // Define which shorthands belong to which subagent
  const claudeShorthands = [':sonnet', ':haiku', ':opus'];
  const codexShorthands = [':codex', ':codex-mini', ':gpt-5', ':mini'];
  const geminiShorthands = [':pro', ':flash'];

  // Check if shorthand starts with a subagent-specific prefix
  const isClaudeModel = claudeShorthands.includes(model) || model.startsWith(':claude');
  const isCodexModel = codexShorthands.includes(model) || model.startsWith(':gpt');
  const isGeminiModel = geminiShorthands.includes(model) || model.startsWith(':gemini');

  switch (subagent) {
    case 'claude':
      return isClaudeModel || (!isCodexModel && !isGeminiModel);
    case 'codex':
      return isCodexModel || (!isClaudeModel && !isGeminiModel);
    case 'gemini':
      return isGeminiModel || (!isClaudeModel && !isCodexModel);
    case 'cursor':
      return true; // Cursor accepts any model
    case 'pi':
      return true; // Pi is multi-provider — accepts any model shorthand
    default:
      return true;
  }
}

/**
 * Prompt input processor for handling various input types
 */
class PromptProcessor {
  constructor(private options: MainCommandOptions) {}

  async processPrompt(): Promise<string> {
    const { prompt, promptFile, interactivePrompt } = this.options;

    // Handle --interactive-prompt (TUI editor)
    if (interactivePrompt) {
      return await this.launchTUIPromptEditor(prompt);
    }

    // Handle --prompt-file / -f flag (explicit file-based prompt)
    if (promptFile) {
      return await this.loadPromptFromFile(promptFile);
    }

    if (!prompt) {
      if (this.options.interactive) {
        return await this.collectInteractivePrompt();
      } else {
        // Try default prompt file: .juno_task/prompt.md
        const defaultPromptPath = path.join(process.cwd(), '.juno_task', 'prompt.md');
        if (await fs.pathExists(defaultPromptPath)) {
          console.error(
            chalk.blue(`📄 Using default prompt: ${chalk.cyan('.juno_task/prompt.md')}`),
          );
          return await this.loadPromptFromFile(defaultPromptPath);
        } else {
          throw new ValidationError('Prompt is required for execution', [
            'Provide prompt text: juno-code claude "your prompt here"',
            'Use file input: juno-code claude prompt.txt',
            'Use interactive mode: juno-code claude --interactive',
            'Use TUI editor: juno-code claude --interactive-prompt',
            'Create default prompt file: .juno_task/prompt.md',
          ]);
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
        throw new RuntimeError('Prompt file is empty', resolvedPath);
      }

      console.error(
        chalk.blue(
          `📄 Loaded prompt from: ${chalk.cyan(path.relative(process.cwd(), resolvedPath))}`,
        ),
      );
      return content.trim();
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw error;
      }

      throw new RuntimeError(`Failed to read prompt file: ${error}`, filePath);
    }
  }

  private async launchTUIPromptEditor(_initialValue?: string): Promise<string> {
    // TUI system has been removed; redirect to readline-based interactive prompt
    console.error(chalk.yellow('Using interactive prompt mode...'));
    return await this.collectInteractivePrompt();
  }

  private async collectInteractivePrompt(): Promise<string> {
    console.error(chalk.blue.bold('\n✏️  Interactive Prompt Mode\n'));
    console.error(chalk.yellow('Enter your prompt (press Ctrl+D when finished):'));
    console.error(
      chalk.gray('You can type multiple lines. End with Ctrl+D (Unix) or Ctrl+Z (Windows).\n'),
    );

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
          reject(
            new ValidationError('Empty prompt provided', [
              'Provide meaningful prompt text',
              'Use --help for usage examples',
            ]),
          );
        } else {
          resolve(trimmed);
        }
      });

      process.stdin.on('error', (error) => {
        reject(new RuntimeError(`Failed to read interactive input: ${error}`, 'stdin'));
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
    console.error(
      chalk.blue.bold(
        '\n🚀 Executing with ' +
          request.subagent.charAt(0).toUpperCase() +
          request.subagent.slice(1),
      ),
    );

    if (this.verbose) {
      console.error(chalk.gray(`   Request ID: ${request.requestId}`));
      console.error(
        chalk.gray(
          `   Max Iterations: ${request.maxIterations === -1 ? 'unlimited' : request.maxIterations}`,
        ),
      );
      console.error(chalk.gray(`   Working Directory: ${request.workingDirectory}`));
      if (request.model) {
        console.error(chalk.gray(`   Model: ${request.model}`));
      }
    }

    console.error(chalk.blue('\n📋 Task:'));
    const preview =
      request.instruction.length > 200
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
    if (
      event.metadata?.rawJsonOutput ||
      (event.metadata?.format === 'text' && event.metadata?.raw === true)
    ) {
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
    const colored = json
      // Keys (property names)
      .replace(/"([^"]+)":/g, (_match, key) => `${chalk.blue(`"${key}"`)}:`)
      // String values
      .replace(/: "([^"]*)"/g, (_match, value) => `: ${chalk.green(`"${value}"`)}`)
      // Numbers
      .replace(/: (\d+\.?\d*)/g, (_match, num) => `: ${chalk.yellow(num)}`)
      // Booleans and null
      .replace(/: (true|false|null)/g, (_match, val) => `: ${chalk.magenta(val)}`);

    return colored;
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
        console.error(
          chalk.green(
            `✅ Iteration ${this.currentIteration} completed (${durationText}, total: ${elapsed})`,
          ),
        );
      } else {
        console.error(
          chalk.red(
            `❌ Iteration ${this.currentIteration} failed (${durationText}, total: ${elapsed})`,
          ),
        );
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
    const structuredOutput = (lastIteration?.toolResult.metadata as any)?.structuredOutput === true;
    const shouldPrintResult = Boolean(
      lastIteration &&
        lastIteration.toolResult.content &&
        (!this.hasStreamedJsonOutput || structuredOutput),
    );

    if (shouldPrintResult) {
      console.error(chalk.blue('\n📄 Result:'));
      // Final result goes to STDOUT for variable capture
      console.log(lastIteration!.toolResult.content);
    }

    // Show statistics on STDERR if verbose
    if (this.verbose) {
      const stats = result.statistics;
      console.error(chalk.blue('\n📊 Statistics:'));
      console.error(chalk.white(`   Total Iterations: ${stats.totalIterations}`));
      console.error(chalk.white(`   Successful: ${stats.successfulIterations}`));
      console.error(chalk.white(`   Failed: ${stats.failedIterations}`));
      console.error(
        chalk.white(`   Average Duration: ${stats.averageIterationDuration.toFixed(0)}ms`),
      );
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
        progressInterval: 0, // Don't use built-in ticker, we have our own progress display
      });
    }
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    // Log backend selection if verbose
    if (this.config.verbose) {
      console.error(chalk.gray(`   Backend: Shell Scripts`));
    }

    // Create execution engine (backend is created internally)
    const engine = createExecutionEngine(this.config);

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
      this.progressDisplay.onIterationComplete(iterationResult.success, iterationResult.duration);
    });

    engine.on('execution:error', ({ error }) => {
      this.progressDisplay.onError(error);
    });

    try {
      // Start progress display
      this.progressDisplay.start(request);

      // Start feedback collector if enabled
      if (this.feedbackCollector) {
        writeTerminalProgress(
          chalk.gray('   Feedback collection: enabled (Type F+Enter to enter feedback mode)') +
            '\n',
        );
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
  _args: string[],
  options: MainCommandOptions,
  _command: Command,
): Promise<void> {
  try {
    // Load configuration first so we can resolve defaults from config.json
    // Load configuration
    const config = await loadConfig({
      baseDir: options.cwd || process.cwd(),
      ...(options.config !== undefined ? { configFile: options.config } : {}),
      cliConfig: {
        verbose: options.verbose || false,
        quiet: options.quiet || false,
        logLevel: options.logLevel || 'info',
        workingDirectory: options.cwd || process.cwd(),
        // Pass through onHourlyLimit if specified via CLI flag
        ...(options.onHourlyLimit
          ? { onHourlyLimit: options.onHourlyLimit as 'wait' | 'raise' }
          : {}),
      },
    });

    // Apply --no-hooks flag: Commander sets options.hooks to false when --no-hooks is passed
    if (options.hooks === false) {
      config.skipHooks = true;
      if (options.verbose) {
        console.error(chalk.gray('   Hooks: disabled (--no-hooks)'));
      }
    }

    // Resolve subagent: CLI flag > config.json > DEFAULT_CONFIG
    if (!options.subagent) {
      if (config.defaultSubagent) {
        options.subagent = config.defaultSubagent as SubagentType;
        if (options.verbose) {
          console.error(chalk.gray(`   Subagent: ${config.defaultSubagent} (from config.json)`));
        }
      } else {
        options.subagent = 'claude' as SubagentType;
        if (options.verbose) {
          console.error(chalk.gray(`   Subagent: claude (default)`));
        }
      }
    }

    // Validate subagent
    const validSubagents: SubagentType[] = ['claude', 'cursor', 'codex', 'gemini', 'pi'];
    if (!validSubagents.includes(options.subagent)) {
      throw new ValidationError(`Invalid subagent: ${options.subagent}`, [
        `Use one of: ${validSubagents.join(', ')}`,
        'Example: juno-code claude "your prompt"',
        'Use --help for more information',
      ]);
    }

    // Process prompt
    const promptProcessor = new PromptProcessor(options);
    const instruction = await promptProcessor.processPrompt();

    // Backend is always 'shell' (only backend type)
    const selectedBackend = 'shell' as const;

    // Check if --allowed-tools and --append-allowed-tools are used together (mutually exclusive)
    if (options.allowedTools && options.appendAllowedTools) {
      console.error(
        chalk.red(
          '\n❌ Error: --allowed-tools and --append-allowed-tools are mutually exclusive. Use one or the other.',
        ),
      );
      process.exit(1);
    }

    // Validate maxIterations - check for NaN (e.g., from parseInt('invalid'))
    // This must happen BEFORE the fallback logic, otherwise NaN || default = default (silent failure)
    if (options.maxIterations !== undefined && Number.isNaN(options.maxIterations)) {
      throw new ValidationError('Max iterations must be a valid number', [
        'Use -1 for unlimited iterations',
        'Use positive integers like 1, 5, or 10',
        'Example: -i 5',
      ]);
    }

    // Determine the model to use:
    // 1. If -m flag is provided, use that
    // 2. If config has a defaultModel AND the selected subagent matches config's defaultSubagent
    //    AND the model is compatible with the subagent, use config's model
    // 3. Otherwise, use the appropriate default model for the selected subagent
    //
    // The compatibility check prevents using Claude model shorthands (e.g., :sonnet) with Codex,
    // which can happen with legacy config.json files created before the per-subagent model fix.
    const configModelIsValid =
      config.defaultModel &&
      config.defaultSubagent === options.subagent &&
      isModelCompatibleWithSubagent(config.defaultModel, options.subagent);

    const resolvedModel =
      options.model ||
      (configModelIsValid ? config.defaultModel : undefined) ||
      getDefaultModelForSubagent(options.subagent);

    // Create execution request
    // Pass both --tools and --allowed-tools as separate parameters
    // Use nullish coalescing (??) instead of || to properly handle 0 or NaN values
    const executionRequest = createExecutionRequest({
      instruction,
      subagent: options.subagent,
      backend: selectedBackend,
      workingDirectory: config.workingDirectory,
      maxIterations: options.maxIterations ?? config.defaultMaxIterations,
      model: resolvedModel,
      ...(options.agents !== undefined ? { agents: options.agents } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.appendAllowedTools !== undefined ? { appendAllowedTools: options.appendAllowedTools } : {}),
      ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      ...(options.continue !== undefined ? { continueConversation: options.continue } : {}),
    });

    // Execute
    const coordinator = new MainExecutionCoordinator(
      config,
      options.verbose,
      options.enableFeedback || false,
    );
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
        error.suggestions.forEach((suggestion) => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(1);
      return;
    } else if (error instanceof ConfigurationError) {
      console.error(chalk.red.bold('\n❌ Configuration Error'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach((suggestion) => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(2);
      return;
    } else if (error instanceof RuntimeError) {
      console.error(chalk.red.bold('\n❌ File System Error'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach((suggestion) => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(5);
      return;
    } else {
      // Unexpected error
      console.error(chalk.red.bold('\n❌ Unexpected Error'));
      console.error(chalk.red(`   ${error}`));

      if (options.verbose) {
        console.error('\n📍 Stack Trace:');
        console.error(error);
      }

      process.exit(99);
      return;
    }
  }
}

// Export for testing
export { getDefaultModelForSubagent, isModelCompatibleWithSubagent };
