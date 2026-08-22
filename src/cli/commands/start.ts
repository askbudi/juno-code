/**
 * Start command implementation for yylo CLI
 *
 * Acts as a shortcut for: yylo -p "$(cat .juno_task/init.md)" {args}
 * Delegates to the main command handler with .juno_task/init.md as the prompt.
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';

import { mainCommandHandler } from './main.js';
import { loadConfig } from '../../core/config.js';
import { getConfiguredDefaultModelForSubagent } from '../../core/subagent-models.js';
import type { StartCommandOptions, MainCommandOptions } from '../types.js';
import { areLifecycleHooksDisabled, RuntimeError } from '../types.js';
import type { SubagentType } from '../../types/index.js';

/**
 * Load init.md content from .juno_task directory
 */
async function loadInitPrompt(directory: string): Promise<string> {
  const junoTaskDir = path.join(directory, '.juno_task');
  const initFile = path.join(junoTaskDir, 'init.md');

  // Check if .juno_task directory exists
  if (!(await fs.pathExists(junoTaskDir))) {
    throw new RuntimeError(
      'No .juno_task directory found. Run "yylo init" first.',
      junoTaskDir,
    );
  }

  // Check if init.md exists
  if (!(await fs.pathExists(initFile))) {
    throw new RuntimeError('No init.md file found in .juno_task directory', initFile);
  }

  // Read init.md content
  try {
    const content = await fs.readFile(initFile, 'utf-8');

    if (!content.trim()) {
      throw new RuntimeError('init.md file is empty. Please add task instructions.', initFile);
    }

    return content.trim();
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }

    throw new RuntimeError(`Failed to read init.md: ${error}`, initFile);
  }
}

/**
 * Start command handler - delegates to mainCommandHandler with init.md as prompt
 *
 * This implements: yylo start {args} = yylo -p "$(cat .juno_task/init.md)" {args}
 */
export async function startCommandHandler(
  _args: any,
  options: StartCommandOptions,
  command: Command,
): Promise<void> {
  try {
    // Get working directory from options or use current directory
    const workingDirectory = options.directory || process.cwd();

    // Load init.md content
    const initPrompt = await loadInitPrompt(workingDirectory);

    // Load config to get default subagent if not provided via command line
    // This matches the behavior of the original start command
    const config = await loadConfig({
      baseDir: workingDirectory,
      configFile: (options as any).config,
      cliConfig: {
        verbose: options.quiet ? 0 : (options.verbose ?? 1),
        quiet: options.quiet || false,
        logLevel: (options as any).logLevel || 'info',
        workingDirectory,
      },
    });

    // The subagent should come from:
    // 1. Command line option (options.subagent)
    // 2. Config file (config.defaultSubagent)
    // 3. Default fallback ('claude')
    const subagent = options.subagent || config.defaultSubagent || 'claude';
    const backend = options.backend || config.defaultBackend || 'shell';
    const maxIterations = options.maxIterations ?? config.defaultMaxIterations ?? 50;
    const model =
      options.model ||
      getConfiguredDefaultModelForSubagent(config, subagent as SubagentType) ||
      config.defaultModel;

    // Handle dry-run mode - validate configuration and exit without executing
    if (options.dryRun) {
      console.log(chalk.blue.bold('\n🔍 dry-run mode: Validating configuration...\n'));

      console.log(chalk.white('Configuration Summary:'));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.cyan('  Working Directory: ') + workingDirectory);
      console.log(chalk.cyan('  Subagent:          ') + subagent);
      console.log(chalk.cyan('  Backend:           ') + backend);
      console.log(chalk.cyan('  Max Iterations:    ') + maxIterations);
      if (model) {
        console.log(chalk.cyan('  Model:             ') + model);
      }
      if (options.agents) {
        console.log(chalk.cyan('  Agents Config:     ') + options.agents);
      }
      console.log(chalk.gray('─'.repeat(50)));

      // Validate init.md exists and has content
      console.log(chalk.white('\nInit Prompt:'));
      console.log(chalk.gray('─'.repeat(50)));
      const promptPreview =
        initPrompt.length > 200 ? initPrompt.substring(0, 200) + '...' : initPrompt;
      console.log(chalk.gray(promptPreview));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.gray(`  (${initPrompt.length} characters total)`));

      // Check if required files exist
      const junoTaskDir = path.join(workingDirectory, '.juno_task');
      const configFile = path.join(junoTaskDir, 'config.json');
      const configExists = await fs.pathExists(configFile);

      console.log(chalk.white('\nFile Validation:'));
      console.log(chalk.green('  ✓ .juno_task/init.md exists'));
      if (configExists) {
        console.log(chalk.green('  ✓ .juno_task/config.json exists'));
      } else {
        console.log(chalk.yellow('  ⚠ .juno_task/config.json not found (using defaults)'));
      }

      console.log(chalk.green.bold('\n✅ dry-run complete: Configuration is valid'));
      console.log(chalk.gray('   Remove --dry-run flag to execute\n'));

      return;
    }

    // Convert StartCommandOptions to MainCommandOptions
    // The start command should pass through all options to the main command
    // Build MainCommandOptions, omitting undefined values to satisfy exactOptionalPropertyTypes
    const mainOptions: MainCommandOptions = {
      subagent: subagent as any, // Will be validated by mainCommandHandler
      prompt: initPrompt, // Use init.md content as the prompt
      // Start command never uses interactive modes
      interactive: false,
      interactivePrompt: false,
      // Spread optional properties only when defined
      ...(options.backend !== undefined ? { backend: options.backend } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.agents !== undefined ? { agents: options.agents } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.appendAllowedTools !== undefined ? { appendAllowedTools: options.appendAllowedTools } : {}),
      ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      ...(options.cloneSession !== undefined ? { cloneSession: options.cloneSession } : {}),
      ...(options.cloneFromSession !== undefined ? { cloneFromSession: options.cloneFromSession } : {}),
      ...(options.continue !== undefined ? { continue: options.continue } : {}),
      ...(options.directory !== undefined ? { cwd: options.directory } : {}),
      ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
      ...(options.quiet !== undefined ? { quiet: options.quiet } : {}),
      ...((options as any).config !== undefined ? { config: (options as any).config } : {}),
      ...((options as any).logLevel !== undefined ? { logLevel: (options as any).logLevel } : {}),
      ...(options.enableFeedback !== undefined ? { enableFeedback: options.enableFeedback } : {}),
      // Normalize --no-hooks/--no-hook before delegating to the shared main handler.
      ...(areLifecycleHooksDisabled(options)
        ? { hooks: false }
        : options.hooks !== undefined
          ? { hooks: options.hooks }
          : {}),
    };

    // Delegate to mainCommandHandler with the prompt from init.md
    await mainCommandHandler([], mainOptions, command);
  } catch (error) {
    // Re-throw errors - mainCommandHandler will handle them
    if (error instanceof RuntimeError) {
      console.error(chalk.red.bold('\n❌ File System Error'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach((suggestion) => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(5);
    }

    throw error;
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
    .option('-b, --backend <type>', 'Backend type (default: shell)')
    .option('-i, --max-iterations <number>', 'Maximum number of iterations', parseInt)
    .option('-m, --model <name>', 'Model to use for execution')
    .option(
      '--agents <config>',
      'Agents configuration (forwarded to shell backend)',
    )
    .option('-d, --directory <path>', 'Project directory (default: current)')
    .option('--enable-feedback', 'Enable concurrent feedback collection during execution')
    .option('--show-metrics', 'Display performance metrics summary after execution')
    .option('--show-dashboard', 'Show interactive performance dashboard after execution')
    .option('--show-trends', 'Display performance trends from historical data')
    .option(
      '--save-metrics [file]',
      'Save performance metrics to file (default: .juno_task/metrics.json)',
    )
    .option('--metrics-file <path>', 'Specify custom path for metrics file')
    .option('--dry-run', 'Validate configuration and exit without executing')
    .action(async (options, command) => {
      // Merge global options with command-specific options
      // Global options include: -v/--verbose, -q/--quiet, -c/--config, etc.
      const allOptions = command.optsWithGlobals
        ? command.optsWithGlobals()
        : { ...command.opts(), ...options };

      // Set default metrics file if save-metrics is used without value
      if (allOptions.saveMetrics === true) {
        allOptions.saveMetrics = true;
        allOptions.metricsFile = allOptions.metricsFile || '.juno_task/metrics.json';
      }
      await startCommandHandler([], allOptions, command);
    })
    .addHelpText(
      'after',
      `
Examples:
  $ yylo start                                   # Start execution in current directory
  $ yylo start -s claude                        # Use claude subagent
  $ yylo start --subagent cursor                # Use cursor subagent
  $ yylo start -s codex --max-iterations 10     # Use codex with 10 iterations
  $ yylo start --model sonnet-4                 # Use specific model
  $ yylo start --directory ./my-project         # Execute in specific directory
  $ yylo start --enable-feedback                # Enable feedback collection while running
  $ yylo start --verbose                        # Show detailed progress
  $ yylo start --quiet                          # Minimize output
  $ yylo start --show-metrics                   # Display performance summary
  $ yylo start --show-dashboard                 # Interactive performance dashboard
  $ yylo start --show-trends                    # Show historical performance trends
  $ yylo start --save-metrics                   # Save metrics to .juno_task/metrics.json
  $ yylo start --save-metrics custom.json       # Save metrics to custom file

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
  YYLO_BACKEND            Backend type (default: shell)
  YYLO_MAX_ITERATIONS     Default maximum iterations
  YYLO_MODEL              Default model to use
  YYLO_MCP_TIMEOUT        Operation timeout in milliseconds

Notes:
  - Requires .juno_task/init.md file (created by 'yylo init')
  - Creates a new session for tracking execution
  - Progress is displayed in real-time
  - Performance metrics are collected automatically
  - Use --enable-feedback to submit feedback while execution is running
  - Use Ctrl+C to cancel execution gracefully

Backend:
  shell                        Shell script backend (default)
                               Executes scripts from ~/.yylo/services/
                               Supports subagent.py, subagent.sh, or subagent-specific scripts
    `,
    );
}
