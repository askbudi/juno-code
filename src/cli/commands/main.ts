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
import { logger, LogLevel } from '../utils/advanced-logger.js';
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
 * Normalize verbose option to numeric level.
 * Accepts number/boolean/string values because Commander can pass optional args as booleans/strings.
 */
function normalizeVerboseLevel(verbose: unknown, quiet: boolean | undefined): number {
  if (quiet) return 0;
  if (verbose === undefined || verbose === null) return 1;

  if (typeof verbose === 'number' && Number.isFinite(verbose)) {
    if (verbose <= 0) return 0;
    if (verbose >= 2) return 2;
    return 1;
  }

  if (typeof verbose === 'boolean') {
    return verbose ? 1 : 0;
  }

  const str = String(verbose).toLowerCase().trim();
  if (['false', 'no', '0'].includes(str)) return 0;
  if (['true', 'yes', '1'].includes(str)) return 1;

  const num = Number(str);
  if (!Number.isNaN(num)) {
    if (num <= 0) return 0;
    if (num >= 2) return 2;
    return 1;
  }

  return 1;
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
      return await this.launchTUIPromptEditor(typeof prompt === 'string' ? prompt : undefined);
    }

    // Handle --prompt-file / -f flag (explicit file-based prompt)
    if (promptFile) {
      return await this.loadPromptFromFile(promptFile);
    }

    // Normalize prompt: Commander sets prompt=true when -p is used without an argument
    // (e.g. `juno-code -p << 'EOF'` where heredoc redirects stdin)
    const promptText = typeof prompt === 'string' ? prompt : undefined;

    if (!promptText) {
      // Auto-detect piped stdin (heredoc, pipe, redirect) — no flag needed
      if (!process.stdin.isTTY) {
        return await this.readPipedStdin();
      }

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
            "Provide prompt text: juno-code claude 'your prompt here'",
            'Use file input: juno-code claude prompt.txt',
            "Pipe via stdin: echo 'prompt' | juno-code claude",
            'Use heredoc: juno-code claude -p << \'EOF\'\\nyour prompt\\nEOF',
            'Shell safety: use single quotes (or -f/stdin) when prompt contains backticks or $()',
            'Use interactive mode: juno-code claude --interactive',
            'Create default prompt file: .juno_task/prompt.md',
          ]);
        }
      }
    }

    // Check if prompt is a file path
    if (await this.isFilePath(promptText)) {
      return await this.loadPromptFromFile(promptText);
    }

    // Direct prompt text
    return promptText.trim();
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

  private async readPipedStdin(): Promise<string> {
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
            new ValidationError('Empty stdin input', [
              'Provide prompt text via stdin',
              "Example: echo 'your prompt' | juno-code claude",
              "Example: juno-code claude << 'EOF'\\nyour prompt\\nEOF",
            ]),
          );
        } else {
          console.error(
            chalk.blue(`📥 Read prompt from stdin (${trimmed.length} chars)`),
          );
          resolve(trimmed);
        }
      });

      process.stdin.on('error', (error) => {
        reject(new RuntimeError(`Failed to read stdin: ${error}`, 'stdin'));
      });
    });
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
 * Module-level session ID tracker — updated during execution, read by SIGINT handler in cli.ts
 */
let _activeSessionId: string | null = null;

/**
 * Get the most recently known sub-agent session ID (for use by signal handlers).
 */
export function getActiveSessionId(): string | null {
  return _activeSessionId;
}

/**
 * Execution progress display for main command
 */
class MainProgressDisplay {
  private startTime: Date = new Date();
  private currentIteration: number = 0;
  private verboseLevel: number;
  private hasStreamedJsonOutput: boolean = false; // Track if we streamed JSON output via progress events
  private sessionIds: Map<number, string> = new Map(); // iteration# → sub-agent session_id
  private latestSessionId: string | null = null; // most recent session_id seen

  constructor(verboseLevel: number = 1) {
    this.verboseLevel = verboseLevel;
  }

  start(request: ExecutionRequest): void {
    this.startTime = new Date();

    // Level 0 (quiet): suppress all start info
    if (this.verboseLevel === 0) return;

    console.error(
      chalk.blue.bold(
        '\n🚀 Executing with ' +
          request.subagent.charAt(0).toUpperCase() +
          request.subagent.slice(1),
      ),
    );

    // Level 1+: always show model, max iterations (helping texts)
    if (request.model) {
      console.error(chalk.gray(`   Model: ${request.model}`));
    }
    console.error(
      chalk.gray(
        `   Max Iterations: ${request.maxIterations === -1 ? 'unlimited' : request.maxIterations}`,
      ),
    );

    // Level 2 only: Request ID, Working Directory (debug info)
    if (this.verboseLevel >= 2) {
      console.error(chalk.gray(`   Request ID: ${request.requestId}`));
      console.error(chalk.gray(`   Working Directory: ${request.workingDirectory}`));
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

    // Capture sub-agent session_id from progress event metadata (claude/pi emit this)
    if (event.metadata?.sessionId && typeof event.metadata.sessionId === 'string') {
      this.latestSessionId = event.metadata.sessionId;
      if (this.currentIteration > 0) {
        this.sessionIds.set(this.currentIteration, event.metadata.sessionId);
      }
      // Update module-level tracker for SIGINT handler
      _activeSessionId = this.latestSessionId;
    }

    // If this is raw JSON output from shell backend (jq-style formatting)
    // OR if this is TEXT format streaming from shell backend (codex.py)
    // Mark that we're streaming output - this means we should NOT print the accumulated result later
    if (
      event.metadata?.rawJsonOutput ||
      (event.metadata?.format === 'text' && event.metadata?.raw === true)
    ) {
      this.hasStreamedJsonOutput = true;
    }

    // Level 0: suppress all streaming output (still track session IDs and hasStreamed)
    if (this.verboseLevel === 0) return;

    // If this is raw JSON output from shell backend (jq-style formatting)
    // Display it with colors and indentation like `claude.py | jq .`
    if (event.metadata?.rawJsonOutput) {
      try {
        // Parse and re-format with indentation
        const jsonObj = JSON.parse(event.content);
        const formattedJson = this.colorizeJson(jsonObj);
        const backend = event.backend ? chalk.cyan(`[${event.backend}]`) : '';

        if (this.verboseLevel >= 2) {
          // Level 2: Show pretty formatted JSON with timestamp and backend prefix on STDERR
          console.error(`${chalk.gray(timestamp)} ${backend} ${formattedJson}`);
        } else {
          // Level 1: Show JSON with backend prefix on STDERR
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
    if (this.verboseLevel === 0) return;
    const elapsed = this.getElapsedTime();
    console.error(chalk.yellow(`\n🔄 Iteration ${iteration} started (${elapsed})`));
  }

  onIterationComplete(success: boolean, duration: number): void {
    if (this.verboseLevel === 0) return;
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

  complete(result: ExecutionResult): void {
    const elapsed = this.getElapsedTime();

    // Level 0 (quiet): only show final result on STDOUT, nothing else
    if (this.verboseLevel === 0) {
      const lastIteration = result.iterations[result.iterations.length - 1];
      if (lastIteration?.toolResult.content && !this.hasStreamedJsonOutput) {
        console.log(lastIteration.toolResult.content);
      }
      return;
    }

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

    // Level 1+: show statistics (helping texts: iteration count, time, failures)
    if (this.verboseLevel >= 1) {
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

    // Show session IDs (always — useful for resuming sessions)
    this.extractSessionIdsFromResult(result);
    if (this.sessionIds.size > 0) {
      console.error(chalk.blue('\n🔑 Session ID(s):'));
      if (this.sessionIds.size === 1) {
        const sessionId = [...this.sessionIds.values()][0];
        console.error(chalk.white(`   ${sessionId}`));
      } else {
        for (const [iteration, sessionId] of this.sessionIds) {
          console.error(chalk.white(`   Iteration ${iteration}: ${sessionId}`));
        }
      }
    } else if (this.latestSessionId) {
      console.error(chalk.blue('\n🔑 Session ID:'));
      console.error(chalk.white(`   ${this.latestSessionId}`));
    } else {
      console.error(chalk.gray('\n🔑 Session ID: could not be extracted'));
    }
  }

  /**
   * Extract session IDs from iteration results' structured payloads
   */
  private extractSessionIdsFromResult(result: ExecutionResult): void {
    for (const iteration of result.iterations) {
      // Skip if we already have a session_id for this iteration (from progress events)
      if (this.sessionIds.has(iteration.iterationNumber)) continue;

      try {
        const payload = JSON.parse(iteration.toolResult.content);
        if (payload.session_id && typeof payload.session_id === 'string') {
          this.sessionIds.set(iteration.iterationNumber, payload.session_id);
          this.latestSessionId = payload.session_id;
          _activeSessionId = this.latestSessionId;
        }
      } catch {
        // Not JSON or no session_id — that's fine (e.g., codex)
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

  constructor(config: any, verboseLevel: number = 1, enableFeedback: boolean = false) {
    this.config = config;
    this.progressDisplay = new MainProgressDisplay(verboseLevel);
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
    // Log backend selection at level 2 (debug)
    if (this.config.verbose >= 2) {
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
    // Normalize verbose early; root CLI path can pass booleans/strings from Commander optional args.
    const effectiveVerbose = normalizeVerboseLevel(options.verbose, options.quiet);

    // Load configuration first so we can resolve defaults from config.json
    const config = await loadConfig({
      baseDir: options.cwd || process.cwd(),
      ...(options.config !== undefined ? { configFile: options.config } : {}),
      cliConfig: {
        verbose: effectiveVerbose,
        quiet: options.quiet || false,
        logLevel: options.logLevel || 'info',
        workingDirectory: options.cwd || process.cwd(),
        // Pass through onHourlyLimit if specified via CLI flag
        ...(options.onHourlyLimit
          ? { onHourlyLimit: options.onHourlyLimit as 'wait' | 'raise' }
          : {}),
      },
    });

    // Set logger level based on effective verbose:
    //   0 (quiet): WARN — suppress INFO/DEBUG, only show warnings and errors
    //   1 (normal): INFO — show important INFO (e.g. quota limits), suppress DEBUG (hook execution details)
    //   2 (verbose): DEBUG — show everything including hook execution tracking
    if (effectiveVerbose >= 2) {
      logger.setLevel(LogLevel.DEBUG);
    } else if (effectiveVerbose === 0) {
      logger.setLevel(LogLevel.WARN);
    } else {
      logger.setLevel(LogLevel.INFO);
    }

    // Apply --no-hooks flag: Commander sets options.hooks to false when --no-hooks is passed
    if (options.hooks === false) {
      config.skipHooks = true;
      if (effectiveVerbose >= 1) {
        console.error(chalk.gray('   Hooks: disabled (--no-hooks)'));
      }
    }

    // Resolve subagent: CLI flag > config.json > DEFAULT_CONFIG
    if (!options.subagent) {
      if (config.defaultSubagent) {
        options.subagent = config.defaultSubagent as SubagentType;
        if (effectiveVerbose >= 1) {
          console.error(chalk.gray(`   Subagent: ${config.defaultSubagent} (from config.json)`));
        }
      } else {
        options.subagent = 'claude' as SubagentType;
        if (effectiveVerbose >= 1) {
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
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
    });

    // Execute
    const coordinator = new MainExecutionCoordinator(
      config,
      effectiveVerbose,
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
