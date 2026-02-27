/**
 * CLI entry point for juno-code
 *
 * Comprehensive TypeScript CLI implementation with full functionality parity
 * to the Python budi-cli. Provides all core commands with interactive and
 * headless support, comprehensive error handling, and real-time progress tracking.
 */

// Configure util.inspect to not truncate long strings in JSON output
import { inspect } from 'node:util';
inspect.defaultOptions.maxStringLength = Infinity;
inspect.defaultOptions.breakLength = Infinity;

import { Command, Option } from 'commander';
import chalk from 'chalk';
import { EXIT_CODES, isCLIError } from '../cli/types.js';

// Session ID getter — set when main.js is loaded, used by SIGINT handler
let _getActiveSessionId: (() => string | null) | null = null;

// Import command configurations
import { configureInitCommand } from '../cli/commands/init.js';
import { configureStartCommand } from '../cli/commands/start.js';
import { configureTestCommand } from '../cli/commands/test.js';
import { configureFeedbackCommand } from '../cli/commands/feedback.js';
import { configureSessionCommand } from '../cli/commands/session.js';
import { configureSetupGitCommand } from '../cli/commands/setup-git.js';
import { configureLogsCommand } from '../cli/commands/logs.js';
import { configureViewLogCommand } from '../cli/commands/view-log.js';
import { configureHelpCommand } from '../cli/commands/help.js';
import { createServicesCommand } from '../cli/commands/services.js';
import { createSkillsCommand } from '../cli/commands/skills.js';
import CompletionCommand from '../cli/commands/completion.js';

// Import version from package.json
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const packageJson = require(join(__dirname, '../../package.json'));
const VERSION = packageJson.version;

/**
 * Normalize verbose flag value to boolean.
 * -v (no value) → true, -v true/1/yes → true, -v false/0/no → false, undefined → true (default on)
 */
function normalizeVerbose(value: unknown): boolean {
  if (value === undefined) return true; // Default: verbose enabled (C4tqUJ)
  if (value === true) return true; // -v without value
  if (value === false) return false;
  const str = String(value).toLowerCase().trim();
  return !['false', '0', 'no'].includes(str);
}

/** Determine if an error is a transient connection/pipe error. */
function isConnectionLikeError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const lower = msg.toLowerCase();
  return [
    'epipe',
    'broken pipe',
    'econnreset',
    'socket hang up',
    'err_socket_closed',
    'connection reset by peer',
  ].some((token) => lower.includes(token));
}

/**
 * Global error handler for CLI operations
 */
function handleCLIError(error: unknown, verbose: boolean = false): void {
  if (isCLIError(error)) {
    // Handle known CLI errors
    console.error(chalk.red.bold(`\n❌ ${error.constructor.name}`));
    console.error(chalk.red(`   ${error.message}`));

    if (error.suggestions?.length) {
      console.error(chalk.yellow('\n💡 Suggestions:'));
      error.suggestions.forEach((suggestion) => {
        console.error(chalk.yellow(`   • ${suggestion}`));
      });
    }

    if (error.showHelp) {
      console.error(chalk.gray('\n   Use --help for usage information'));
    }

    // Map CLI error to exit code
    const exitCode = Object.values(EXIT_CODES).includes((error as any).code)
      ? (error as any).code
      : EXIT_CODES.UNEXPECTED_ERROR;

    process.exit(exitCode);
  }

  // Handle unexpected errors
  console.error(chalk.red.bold('\n❌ Unexpected Error'));
  console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));

  if (verbose && error instanceof Error) {
    console.error(chalk.gray('\n📍 Stack Trace:'));
    console.error(error.stack);
  }

  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
}

/**
 * Setup global CLI options and behaviors
 */
function setupGlobalOptions(program: Command): void {
  // Global options available to all commands
  program
    .option(
      '-v, --verbose [value]',
      'Enable verbose output including hook execution (default: true). Disable with -v false, -v 0, or -v no',
    )
    .option('-q, --quiet', 'Quiet mode: suppress agent messages and hook output (alias: --silent)')
    .option('--silent', 'Alias for --quiet')
    .option('-c, --config <path>', 'Configuration file path (.json, .toml, pyproject.toml)')
    .option('-l, --log-file <path>', 'Log file path (auto-generated if not specified)')
    .option('--no-color', 'Disable colored output')
    .option('--log-level <level>', 'Log level for output (error, warn, info, debug, trace)', 'info')
    .option('-s, --subagent <name>', 'Subagent to use (claude, cursor, codex, gemini, pi)')
    .option('-b, --backend <type>', 'Backend type (default: shell)')
    .option('-m, --model <name>', 'Model to use (subagent-specific)')
    .option(
      '--agents <config>',
      'Agents configuration (forwarded to shell backend)',
    )
    .option(
      '--tools <tools...>',
      'Specify the list of available tools from the built-in set (only works with --print mode). Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").',
    )
    .option(
      '--allowed-tools <tools...>',
      'Permission-based filtering of specific tool instances (e.g. "Bash(git:*) Edit"). Default when not specified: Task, Bash, Glob, Grep, ExitPlanMode, Read, Edit, Write, NotebookEdit, WebFetch, TodoWrite, WebSearch, BashOutput, KillShell, Skill, SlashCommand, EnterPlanMode.',
    )
    .option(
      '--disallowed-tools <tools...>',
      'Disallowed tools for Claude. By default, no tools are disallowed',
    )
    .option(
      '--append-allowed-tools <tools...>',
      'Append tools to the default allowed-tools list (mutually exclusive with --allowed-tools).',
    )
    .option('--mcp-timeout <number>', 'Operation timeout in milliseconds (default: 43200000)', parseInt)
    .option(
      '--enable-feedback',
      'Enable interactive feedback mode (F+Enter to enter, Q+Enter to submit)',
    )
    .option('-r, --resume <sessionId>', 'Resume a conversation by session ID (shell backend only)')
    .option('--continue', 'Continue the most recent conversation (shell backend only)')
    .option(
      '--til-completion',
      'Run juno-code in a loop until all kanban tasks are complete (aliases: --until-completion, --run-until-completion, --till-complete)',
    )
    .option('--until-completion', 'Alias for --til-completion')
    .addOption(new Option('--run-until-completion', 'Alias for --til-completion').hideHelp())
    .addOption(new Option('--till-complete', 'Alias for --til-completion').hideHelp())
    .option(
      '--pre-run-hook <hooks...>',
      'Execute named hooks from .juno_task/config.json before each iteration (only with --til-completion)',
    )
    .option(
      '--stale-threshold <n>',
      'Number of stale iterations before exiting (default: 3). Set to 0 to disable. (only with --til-completion)',
      parseInt,
    )
    .option(
      '--no-stale-check',
      'Disable stale iteration detection (alias for --stale-threshold 0). (only with --til-completion)',
    )
    .option(
      '--force-update',
      'Force update scripts, services, and Python dependencies (bypasses 24-hour cache)',
    )
    .option(
      '--on-hourly-limit <behavior>',
      'Behavior when Claude hourly quota limit is reached: "wait" to sleep until reset, "raise" to exit immediately (default: raise)',
    )
    .option(
      '--no-hooks',
      'Skip execution of all lifecycle hooks (START_RUN, START_ITERATION, END_ITERATION, END_RUN)',
    );

  // Global error handling
  program.exitOverride((err) => {
    if (err.code === 'commander.helpDisplayed') {
      process.exit(0);
    }
    if (err.code === 'commander.version') {
      process.exit(0);
    }
    handleCLIError(err, false);
  });

  // Custom help formatting
  program.configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => cmd.name() + ' ' + cmd.usage(),
    commandUsage: (cmd) => cmd.name() + ' ' + cmd.usage(),
    commandDescription: (cmd) => cmd.description(),
  });
}

/**
 * Setup main execution command (default command)
 */
function setupMainCommand(program: Command): void {
  // Main command for direct execution with subagent
  program
    .argument('[prompt_text...]', 'Prompt text (positional, alternative to -p)')
    .option('-p, --prompt [text]', 'Prompt input (file path, inline text, or use with heredoc/stdin)')
    .option('-f, --prompt-file <path>', 'Read prompt from a file (alternative to -p "$(cat file)")')
    .option('-w, --cwd <path>', 'Working directory')
    .option('-i, --max-iterations <number>', 'Maximum iterations (-1 for unlimited)', parseInt)
    .option('-I, --interactive', 'Interactive mode for typing prompts')
    .option('-ip, --interactive-prompt', 'Launch interactive prompt editor')
    .action(async (promptArgs: string[], options, command) => {
      // Merge positional prompt args into options.prompt (if -p not already set)
      if (promptArgs.length > 0 && options.prompt === undefined) {
        options.prompt = promptArgs.join(' ');
      }
      try {
        // Get global options from program
        const globalOptions = program.opts();
        // Merge options with command options taking precedence over global options
        // Only merge defined global options to avoid overwriting command options with undefined
        const definedGlobalOptions = Object.fromEntries(
          Object.entries(globalOptions).filter(([_, v]) => v !== undefined),
        );
        const allOptions = { ...definedGlobalOptions, ...options };

        // Normalize verbose: default true, -v false/0/no disables
        allOptions.verbose = normalizeVerbose(allOptions.verbose);

        // Handle --silent as alias for --quiet
        if (allOptions.silent) {
          allOptions.quiet = true;
        }

        // Handle --til-completion flag and its synonyms: invoke run_until_completion.sh
        if (
          allOptions.tilCompletion ||
          allOptions.untilCompletion ||
          allOptions.runUntilCompletion ||
          allOptions.tillComplete
        ) {
          const { spawn } = await import('node:child_process');
          const path = await import('node:path');
          const fs = await import('fs-extra');

          const scriptPath = path.join(
            process.cwd(),
            '.juno_task',
            'scripts',
            'run_until_completion.sh',
          );

          // Check if script exists
          if (!(await fs.pathExists(scriptPath))) {
            console.error(chalk.red.bold('\n❌ Error: run_until_completion.sh not found'));
            console.error(chalk.red(`   Expected location: ${scriptPath}`));
            console.error(
              chalk.yellow('\n💡 Suggestion: Run "juno-code init" to initialize the project'),
            );
            process.exit(1);
          }

          // Build arguments for run_until_completion.sh
          const scriptArgs: string[] = [];

          // Add --pre-run-hook arguments if provided
          if (allOptions.preRunHook && Array.isArray(allOptions.preRunHook)) {
            for (const hook of allOptions.preRunHook) {
              scriptArgs.push('--pre-run-hook', hook);
            }
          }

          // Forward all juno-code arguments (except --til-completion and its synonyms, and --pre-run-hook)
          const completionFlags = [
            '--til-completion',
            '--until-completion',
            '--run-until-completion',
            '--till-complete',
          ];
          const forwardedArgs = process.argv
            .slice(2)
            .filter((arg) => !completionFlags.includes(arg) && !arg.startsWith('--pre-run-hook'));
          scriptArgs.push(...forwardedArgs);

          // Execute run_until_completion.sh
          const child = spawn(scriptPath, scriptArgs, {
            stdio: 'inherit',
            cwd: process.cwd(),
          });

          // Forward SIGINT and SIGTERM to child process for proper Ctrl+C handling
          // Remove global signal handlers first to prevent conflicts
          process.removeAllListeners('SIGINT');
          process.removeAllListeners('SIGTERM');

          let childExited = false;
          const signalHandler = (signal: NodeJS.Signals) => {
            if (!childExited && child.pid) {
              // Forward signal to child process
              try {
                process.kill(child.pid, signal);
              } catch (err) {
                // Child might have already exited, ignore errors
              }
            }
          };

          process.on('SIGINT', signalHandler);
          process.on('SIGTERM', signalHandler);

          child.on('exit', (code) => {
            childExited = true;
            // Clean up signal handlers
            process.removeListener('SIGINT', signalHandler);
            process.removeListener('SIGTERM', signalHandler);
            process.exit(code || 0);
          });

          child.on('error', (error) => {
            childExited = true;
            // Clean up signal handlers
            process.removeListener('SIGINT', signalHandler);
            process.removeListener('SIGTERM', signalHandler);
            console.error(chalk.red.bold('\n❌ Error executing run_until_completion.sh'));
            console.error(chalk.red(`   ${error.message}`));
            process.exit(1);
          });

          return;
        }

        // Check if we should auto-detect project configuration
        if (
          !globalOptions.subagent &&
          !options.prompt &&
          !options.interactive &&
          !options.interactivePrompt
        ) {
          const fs = await import('fs-extra');
          const path = await import('node:path');
          const cwd = process.cwd();
          const junoTaskDir = path.join(cwd, '.juno_task');

          // Check if project is initialized
          if (await fs.pathExists(junoTaskDir)) {
            console.log(chalk.blue.bold('🎯 Juno Code - Auto-detected Initialized Project\n'));

            // Try to load configuration for auto-detection
            try {
              const { loadConfig } = await import('../core/config.js');
              const config = await loadConfig({
                baseDir: cwd,
                cliConfig: {
                  verbose: allOptions.verbose,
                  quiet: allOptions.quiet || false,
                  logLevel: allOptions.logLevel || 'info',
                  workingDirectory: cwd,
                },
              });

              // Auto-detect subagent from config
              if (!allOptions.subagent && config.defaultSubagent) {
                allOptions.subagent = config.defaultSubagent;
                console.log(
                  chalk.gray(`🤖 Using configured subagent: ${chalk.cyan(config.defaultSubagent)}`),
                );
              }

              // Auto-detect prompt file (.juno_task/prompt.md)
              const promptFile = path.join(junoTaskDir, 'prompt.md');
              if (!allOptions.prompt && (await fs.pathExists(promptFile))) {
                allOptions.prompt = promptFile;
                console.log(
                  chalk.gray(`📄 Using default prompt: ${chalk.cyan('.juno_task/prompt.md')}`),
                );
              }

              // Check if we have enough information to proceed
              if (allOptions.subagent && (allOptions.prompt || (await fs.pathExists(promptFile)))) {
                console.log(chalk.green('✓ Auto-detected project configuration\n'));
                // Import and execute with auto-detected options
                const { mainCommandHandler, getActiveSessionId } = await import('../cli/commands/main.js');
                _getActiveSessionId = getActiveSessionId;
                await mainCommandHandler([], allOptions, command);
                return;
              }
            } catch (configError) {
              console.log(chalk.yellow(`⚠️  Could not load project configuration: ${configError}`));
            }
          }
        }

        // Show help if no arguments provided or auto-detection failed
        if (
          !globalOptions.subagent &&
          !options.prompt &&
          !options.interactive &&
          !options.interactivePrompt
        ) {
          console.log(
            chalk.blue.bold('🎯 Juno Code - TypeScript CLI for AI Subagent Orchestration\n'),
          );
          console.log(chalk.white('To get started:'));
          console.log(chalk.gray('  juno-code init                    # Initialize new project'));
          console.log(chalk.gray('  juno-code start                   # Start execution'));
          console.log(chalk.gray('  juno-code test --generate --run   # AI-powered testing'));
          console.log(
            chalk.gray('  juno-code -s claude "prompt"      # Quick execution with Claude'),
          );
          console.log(
            chalk.gray('  juno-code -s claude -p "prompt"   # Same (explicit -p flag)'),
          );
          console.log(chalk.gray('  juno-code --help                  # Show all commands'));
          console.log('');
          return;
        }

        // Import and execute main command handler dynamically
        const { mainCommandHandler, getActiveSessionId } = await import('../cli/commands/main.js');
        _getActiveSessionId = getActiveSessionId;
        await mainCommandHandler([], { ...options, ...globalOptions }, command);
      } catch (error) {
        handleCLIError(error, options.verbose);
      }
    });
}

/**
 * Display welcome banner with version and environment info
 */
function displayBanner(verbose: boolean = false): void {
  if (verbose) {
    console.error(chalk.blue.bold(`\n🎯 Juno Code v${VERSION} - TypeScript CLI`));
    console.error(chalk.gray(`   Node.js ${process.version} on ${process.platform}`));
    console.error(chalk.gray(`   Working directory: ${process.cwd()}`));
    console.error('');
  }
}

/**
 * Setup enhanced completion support
 */
function setupCompletion(program: Command): void {
  try {
    const completionCommand = new CompletionCommand();
    completionCommand.register(program);
  } catch (error) {
    // Don't fail CLI startup if completion setup fails
    console.warn(chalk.yellow('⚠️  Warning: Could not setup completion commands'));
  }
}

/**
 * Subagent help text definitions.
 * Each entry provides backend-specific documentation shown via `juno-code <subagent> --help`.
 */
const SUBAGENT_HELP: Record<
  string,
  { description: string; helpText: string }
> = {
  claude: {
    description: 'Execute with Anthropic Claude subagent',
    helpText: `
${chalk.blue.bold('Claude Backend')} — Anthropic Claude Code CLI wrapper

${chalk.blue('Model Shorthands:')}
  :sonnet              claude-sonnet-4-6       ${chalk.gray('(default)')}
  :opus                claude-opus-4-6
  :haiku               claude-haiku-4-5-20251001
  :claude-sonnet-4-5   claude-sonnet-4-5-20250929
  :claude-sonnet-4-6   claude-sonnet-4-6
  :claude-opus-4       claude-opus-4-20250514
  :claude-opus-4-5     claude-opus-4-5-20251101
  :claude-opus-4-6     claude-opus-4-6
  :claude-haiku-4-5    claude-haiku-4-5-20251001

${chalk.blue('Service-Specific Options:')}
  These are forwarded to claude.py and the Claude CLI:
  --permission-mode <mode>  Permission mode: acceptEdits, bypassPermissions, default, plan, skip
  --auto-instruction <txt>  Text prepended to the prompt automatically
  --agents <config>         Agents configuration (forwarded to Claude CLI)
  --additional-args <args>  Extra CLI arguments as a space-separated string

${chalk.blue('Tool Configuration:')}
  --tools <tools...>              Built-in tool set (use "" to disable all)
  --allowed-tools <tools...>      Replace default allowed tools
  --append-allowed-tools <t...>   Add to default allowed tools
  --disallowed-tools <tools...>   Disable specific tools

  Default tools: Task, Bash, Glob, Grep, ExitPlanMode, Read, Edit, Write,
    NotebookEdit, WebFetch, TodoWrite, WebSearch, BashOutput, KillShell,
    Skill, SlashCommand, EnterPlanMode

${chalk.blue('Environment Variables:')}
  CLAUDE_MODEL                    Model override (default: claude-sonnet-4-6)
  CLAUDE_PROJECT_PATH             Project directory
  CLAUDE_AUTO_INSTRUCTION         Auto-instruction text
  CLAUDE_PERMISSION_MODE          Permission mode (default: default)
  CLAUDE_PRETTY                   Pretty-print JSON output (true/false)
  CLAUDE_VERBOSE                  Verbose output (true/false)

${chalk.blue('Examples:')}
  ${chalk.gray('# Basic execution')}
  juno-code claude "Analyze this codebase"

  ${chalk.gray('# Choose a model')}
  juno-code claude -m :opus "Complex refactoring task"
  juno-code claude -m :haiku "Quick analysis"

  ${chalk.gray('# File-based prompt')}
  juno-code claude -f prompt.md

  ${chalk.gray('# Resume a session')}
  juno-code claude --resume <session-id> "Continue the work"
  juno-code claude --continue "Next step"

  ${chalk.gray('# Tool configuration')}
  juno-code claude --disallowed-tools Bash "Read-only analysis"
  juno-code claude --allowed-tools Read Grep "Search only"

  ${chalk.gray('# Pipe prompt via stdin')}
  echo "Explain this code" | juno-code claude
  cat prompt.md | juno-code claude
`,
  },

  pi: {
    description: 'Execute with Pi multi-provider coding agent',
    helpText: `
${chalk.blue.bold('Pi Backend')} — Multi-provider coding agent (Anthropic, OpenAI, Google, Groq, xAI)

${chalk.blue('Model Shorthands:')}
  ${chalk.gray('# Anthropic')}
  :sonnet              anthropic/claude-sonnet-4-6   ${chalk.gray('(default)')}
  :opus                anthropic/claude-opus-4-6
  :haiku               anthropic/claude-haiku-4-5-20251001
  ${chalk.gray('# OpenAI')}
  :gpt-5               openai/gpt-5
  :gpt-4o              openai/gpt-4o
  :o3                  openai/o3
  :codex               openai-codex/gpt-5.3-codex
  ${chalk.gray('# Google')}
  :gemini-pro          google/gemini-2.5-pro
  :gemini-flash        google/gemini-2.5-flash
  ${chalk.gray('# Others')}
  :groq                groq/llama-4-scout-17b-16e-instruct
  :grok                xai/grok-3
  :pi, :default        anthropic/claude-sonnet-4-6

${chalk.blue('Service-Specific Options:')}
  These are forwarded to pi.py and the Pi CLI:
  --provider <name>         LLM provider override (anthropic, openai, google, groq, xai)
  --thinking <level>        Extended thinking: off, minimal, low, medium, high, xhigh
  --tools <list>            Pi tools (comma-separated): read, bash, edit, write, grep, find, ls
  --no-tools                Disable all built-in Pi tools
  --system-prompt <text>    Replace Pi's default system prompt
  --append-system-prompt <text>  Append to Pi's default system prompt
  --no-extensions           Disable Pi TypeScript extensions
  --no-skills               Disable Pi skills
  --no-session              Ephemeral mode — no session persistence
  --auto-instruction <txt>  Text prepended to the prompt automatically
  --additional-args <args>  Extra Pi CLI arguments as a space-separated string

${chalk.blue('Environment Variables:')}
  PI_MODEL                  Model override (default: anthropic/claude-sonnet-4-6)
  PI_PROVIDER               Provider override
  PI_PROJECT_PATH           Project directory
  PI_THINKING               Thinking level
  PI_TOOLS                  Comma-separated tool list
  PI_SYSTEM_PROMPT          Custom system prompt
  PI_APPEND_SYSTEM_PROMPT   Text appended to system prompt
  PI_AUTO_INSTRUCTION       Auto-instruction text
  PI_NO_SESSION             Disable sessions (true/false)
  PI_PRETTY                 Pretty-print JSON output (true/false)
  PI_VERBOSE                Verbose mode (true/false)

${chalk.blue('Examples:')}
  ${chalk.gray('# Basic execution')}
  juno-code pi "Build a REST API endpoint"

  ${chalk.gray('# Use a specific provider and model')}
  juno-code pi -m :gpt-5 "Refactor this module"
  juno-code pi -m openai/gpt-4o --provider openai "Task"
  juno-code pi -m :gemini-pro "Analyze performance"

  ${chalk.gray('# Extended thinking')}
  juno-code pi --thinking high "Complex architecture redesign"

  ${chalk.gray('# Tool and session control')}
  juno-code pi --no-tools "Read-only analysis"
  juno-code pi --no-session "One-off question"
  juno-code pi --resume <session-id> "Continue work"

  ${chalk.gray('# File-based prompt')}
  juno-code pi -f instructions.md
`,
  },

  codex: {
    description: 'Execute with OpenAI Codex subagent',
    helpText: `
${chalk.blue.bold('Codex Backend')} — OpenAI Codex CLI wrapper

${chalk.blue('Model Shorthands:')}
  :codex               gpt-5.3-codex        ${chalk.gray('(default)')}
  :codex-mini          gpt-5.1-codex-mini
  :gpt-5               gpt-5
  :mini                gpt-5-codex-mini

${chalk.blue('Service-Specific Options:')}
  These are forwarded to codex.py and the Codex CLI:
  -c, --config <args>       Additional codex config arguments (repeatable)
  --auto-instruction <txt>  Text prepended to the prompt automatically

  Default configs applied automatically:
    include_apply_patch_tool=true
    use_experimental_streamable_shell_tool=true
    sandbox_mode=danger-full-access

${chalk.blue('Environment Variables:')}
  CODEX_MODEL                     Model override (default: gpt-5.3-codex)
  CODEX_HIDE_STREAM_TYPES         Stream types to suppress (comma-separated)
  JUNO_CODE_HIDE_STREAM_TYPES     Alternative stream type filter

${chalk.blue('Examples:')}
  ${chalk.gray('# Basic execution')}
  juno-code codex "Fix the failing tests"

  ${chalk.gray('# Use a different model')}
  juno-code codex -m :gpt-5 "Implement feature X"
  juno-code codex -m :codex-mini "Quick fix"

  ${chalk.gray('# File-based prompt')}
  juno-code codex -f prompt.md
`,
  },

  gemini: {
    description: 'Execute with Google Gemini subagent',
    helpText: `
${chalk.blue.bold('Gemini Backend')} — Google Gemini CLI wrapper

${chalk.blue('Model Shorthands:')}
  :pro                 gemini-2.5-pro       ${chalk.gray('(default)')}
  :flash               gemini-2.5-flash
  :pro-2.5             gemini-2.5-pro
  :flash-2.5           gemini-2.5-flash
  :pro-3               gemini-3.0-pro
  :flash-3             gemini-3.0-flash

${chalk.blue('Service-Specific Options:')}
  These are forwarded to gemini.py and the Gemini CLI:
  --output-format <fmt>         Output format: stream-json, json, text (default: stream-json)
  --include-directories <dirs>  Comma-separated directories to include for context
  --approval-mode <mode>        Approval mode (e.g., auto_edit). Defaults to --yolo
  --yolo                        Auto-approve all actions (default in headless mode)
  --debug                       Enable Gemini CLI debug output

${chalk.blue('Environment Variables:')}
  GEMINI_API_KEY                Required API key for authentication
  GEMINI_MODEL                  Model override (default: gemini-2.5-pro)
  GEMINI_PROJECT_PATH           Project directory
  GEMINI_OUTPUT_FORMAT          Output format override

${chalk.blue('Examples:')}
  ${chalk.gray('# Basic execution')}
  juno-code gemini "Analyze this codebase"

  ${chalk.gray('# Choose a model')}
  juno-code gemini -m :flash "Quick analysis"
  juno-code gemini -m :pro-3 "Complex task"

  ${chalk.gray('# Include specific directories')}
  juno-code gemini --include-directories "src,tests" "Review code quality"

  ${chalk.gray('# File-based prompt')}
  juno-code gemini -f prompt.md
`,
  },

  cursor: {
    description: 'Execute with Cursor AI subagent',
    helpText: `
${chalk.blue.bold('Cursor Backend')} — Cursor AI editor agent

${chalk.blue('Note:')}
  Cursor uses the Claude service backend (claude.py).
  See ${chalk.cyan('juno-code claude --help')} for model shorthands and service options.

${chalk.blue('Examples:')}
  ${chalk.gray('# Basic execution')}
  juno-code cursor "Refactor this component"

  ${chalk.gray('# With model selection')}
  juno-code cursor -m :sonnet "Analyze code"

  ${chalk.gray('# File-based prompt')}
  juno-code cursor -f prompt.md
`,
  },
};

/**
 * Create command aliases for each subagent with dedicated help text.
 * Each subagent command shows backend-specific options, model shorthands, and examples.
 */
function setupAliases(program: Command): void {
  const subagents = ['claude', 'cursor', 'codex', 'gemini', 'pi'];

  for (const subagent of subagents) {
    const help = SUBAGENT_HELP[subagent];
    const cmd = program
      .command(subagent)
      .description(help.description)
      .argument('[prompt...]', 'Prompt text or file path')
      .option('-p, --prompt [text]', 'Prompt input (inline text, or use with heredoc/stdin)')
      .option('-f, --prompt-file <path>', 'Read prompt from a file')
      .option('-w, --cwd <path>', 'Working directory')
      .option('-i, --max-iterations <number>', 'Maximum iterations (-1 for unlimited)', parseInt)
      .option('-m, --model <name>', 'Model to use (see model shorthands below)')
      .option('-r, --resume <sessionId>', 'Resume a conversation by session ID')
      .option('--continue', 'Continue the most recent conversation')
      .option('-I, --interactive', 'Interactive mode for typing prompts')
      .addHelpText('after', help.helpText)
      .action(async (prompt, options, command) => {
        try {
          const { mainCommandHandler, getActiveSessionId } = await import('../cli/commands/main.js');
          _getActiveSessionId = getActiveSessionId;
          const promptText = Array.isArray(prompt) ? prompt.join(' ') : prompt;
          // Get global options and merge with command options
          const globalOptions = program.opts();
          // Normalize verbose and handle --silent alias
          const normalizedVerbose = normalizeVerbose(globalOptions.verbose);
          const isQuietAlias = globalOptions.silent || options.silent;
          await mainCommandHandler(
            [],
            {
              ...globalOptions,
              ...options,
              verbose: normalizedVerbose,
              quiet: globalOptions.quiet || options.quiet || isQuietAlias || false,
              subagent,
              prompt: promptText,
            },
            command,
          );
        } catch (error) {
          handleCLIError(error, options.verbose);
        }
      });

    // Pass through unknown options to the backend service
    cmd.allowUnknownOption(true);
  }
}

/**
 * Configure environment variable integration
 * Supports JUNO_CODE_* environment variables
 */
function configureEnvironment(): void {
  // New JUNO_CODE_* environment variables (priority)
  const newEnvVars = [
    'JUNO_CODE_SUBAGENT',
    'JUNO_CODE_PROMPT',
    'JUNO_CODE_CWD',
    'JUNO_CODE_MAX_ITERATIONS',
    'JUNO_CODE_MODEL',
    'JUNO_CODE_LOG_FILE',
    'JUNO_CODE_VERBOSE',
    'JUNO_CODE_QUIET',
    'JUNO_CODE_CONFIG',
    'JUNO_CODE_MCP_TIMEOUT',
    'JUNO_CODE_NO_COLOR',
    'JUNO_CODE_ENABLE_FEEDBACK',
  ];

  // Helper function to process environment variables
  const processEnvVar = (envVar: string, prefix: string) => {
    const value = process.env[envVar];
    if (
      value &&
      !process.argv.includes(`--${envVar.toLowerCase().replace(prefix, '').replace(/_/g, '-')}`)
    ) {
      // Environment variable is set but not overridden by CLI argument
      const option = envVar.toLowerCase().replace(prefix, '').replace(/_/g, '-');

      switch (option) {
        case 'verbose':
          // JUNO_CODE_VERBOSE supports true/false/0/1/no/yes — pass value through for normalization
          if (value.toLowerCase() === 'false' || value === '0' || value.toLowerCase() === 'no') {
            process.argv.push('--verbose', 'false');
          } else if (value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes') {
            process.argv.push('--verbose');
          }
          break;
        case 'quiet':
        case 'no-color':
        case 'enable-feedback':
          if (value.toLowerCase() === 'true' || value === '1') {
            process.argv.push(`--${option}`);
          }
          break;
        default:
          process.argv.push(`--${option}`, value);
      }
      return true; // Indicates value was processed
    }
    return false;
  };

  // Process JUNO_CODE_* variables
  for (const envVar of newEnvVars) {
    processEnvVar(envVar, 'juno_code_');
  }

  // Handle JUNO_INTERACTIVE_FEEDBACK_MODE environment variable (user-requested alternative)
  // This is an alias for --enable-feedback, provides user-friendly environment variable name
  if (!process.argv.includes('--enable-feedback')) {
    const feedbackMode = process.env.JUNO_INTERACTIVE_FEEDBACK_MODE;
    if (feedbackMode && (feedbackMode.toLowerCase() === 'true' || feedbackMode === '1')) {
      process.argv.push('--enable-feedback');
    }
  }

  // Handle NO_COLOR standard
  if (process.env.NO_COLOR && !process.argv.includes('--no-color')) {
    process.argv.push('--no-color');
  }

  // Handle CI environment
  if (process.env.CI && !process.argv.includes('--quiet')) {
    process.argv.push('--quiet');
  }
}

/**
 * Main CLI function
 */
async function main(): Promise<void> {
  const program = new Command();

  // Configure environment
  configureEnvironment();

  // Check for --force-update flag early
  const isForceUpdate = process.argv.includes('--force-update');

  // Auto-update service scripts if package version changed (silent operation)
  // This ensures users always have the latest service scripts after npm upgrade
  try {
    const { ServiceInstaller } = await import('../utils/service-installer.js');

    if (isForceUpdate) {
      console.log(
        chalk.blue('🔄 Force updating service scripts (codex.py, claude.py, gemini.py)...'),
      );
    }

    const updated = await ServiceInstaller.autoUpdate(isForceUpdate);

    // Show update message in force update mode or JUNO_CODE_DEBUG
    if (
      updated &&
      (isForceUpdate ||
        process.env.JUNO_CODE_DEBUG === '1')
    ) {
      if (isForceUpdate) {
        console.log(chalk.green('✓ Service scripts reinstalled'));
      } else {
        console.error('[DEBUG] Service scripts auto-updated to latest version');
      }
    }
  } catch (error) {
    // Log error in debug mode, but don't break CLI
    if (process.env.JUNO_CODE_DEBUG === '1') {
      console.error(
        '[DEBUG] Service auto-update failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Auto-update project scripts (e.g., run_until_completion.sh) in .juno_task/scripts/
  // This ensures scripts are always in sync with the package version (installs missing + updates outdated)
  // If --force-update flag is present, force reinstall all scripts and bypass Python dependency cache

  try {
    const { ScriptInstaller } = await import('../utils/script-installer.js');

    if (isForceUpdate) {
      // Force update all scripts and Python dependencies
      console.log(chalk.blue('🔄 Force updating scripts and Python dependencies...'));
      await ScriptInstaller.forceUpdateAll(process.cwd(), false);
      console.log(chalk.green('✓ Force update completed'));
    } else {
      // Normal auto-update (only missing/outdated scripts)
      const updated = await ScriptInstaller.autoUpdate(process.cwd(), true);

      // Show update message in JUNO_CODE_DEBUG mode
      if (updated && process.env.JUNO_CODE_DEBUG === '1') {
        console.error('[DEBUG] Project scripts auto-updated in .juno_task/scripts/');
      }
    }
  } catch (error) {
    // Log error in debug mode, but don't break CLI
    if (process.env.JUNO_CODE_DEBUG === '1') {
      console.error(
        '[DEBUG] Script auto-update failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Auto-update agent skill files in .agents/skills/ and .claude/skills/
  // Skills are installed for ALL agents regardless of which subagent is selected
  try {
    const { SkillInstaller } = await import('../utils/skill-installer.js');

    if (isForceUpdate) {
      console.log(chalk.blue('🔄 Force updating agent skill files...'));
      await SkillInstaller.autoUpdate(process.cwd(), true);
      console.log(chalk.green('✓ Agent skill files updated'));
    } else {
      const updated = await SkillInstaller.autoUpdate(process.cwd());

      if (updated && process.env.JUNO_CODE_DEBUG === '1') {
        console.error('[DEBUG] Agent skill files auto-updated');
      }
    }
  } catch (error) {
    if (process.env.JUNO_CODE_DEBUG === '1') {
      console.error(
        '[DEBUG] Skill auto-update failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Basic program setup
  program
    .name('juno-code')
    .description('TypeScript implementation of juno-code CLI tool for AI subagent orchestration')
    .version(VERSION, '-V, --version', 'Display version information')
    .helpOption('-h, --help', 'Display help information');

  // Setup global options and behaviors
  setupGlobalOptions(program);

  // Display banner if verbose (default: true unless explicitly disabled with -v false/0/no, or --quiet/--silent)
  const isQuiet = process.argv.includes('--quiet') || process.argv.includes('-q') || process.argv.includes('--silent');
  const isVerbose = !isQuiet && normalizeVerbose(
    process.argv.includes('--verbose') || process.argv.includes('-v')
      ? (() => {
          // Find the value after -v/--verbose (if any)
          const idx = process.argv.indexOf('--verbose') !== -1
            ? process.argv.indexOf('--verbose')
            : process.argv.indexOf('-v');
          const next = process.argv[idx + 1];
          // If next arg exists and doesn't start with '-', it's the value
          if (next && !next.startsWith('-')) return next;
          return true; // -v without value
        })()
      : undefined, // no -v flag at all → normalizeVerbose returns true (default)
  );
  displayBanner(isVerbose);

  // Configure all commands
  configureInitCommand(program);
  configureStartCommand(program);
  configureTestCommand(program);
  configureFeedbackCommand(program);
  configureSessionCommand(program);
  configureSetupGitCommand(program);
  configureLogsCommand(program);
  configureViewLogCommand(program);
  configureHelpCommand(program);
  program.addCommand(createServicesCommand());
  program.addCommand(createSkillsCommand());

  // Setup completion
  setupCompletion(program);

  // Setup aliases
  setupAliases(program);

  // Setup main command (must be last)
  setupMainCommand(program);

  // Add comprehensive help (scoped to root command only — 'before'/'after' not 'beforeAll'/'afterAll')
  program.addHelpText(
    'before',
    `
${chalk.blue.bold('🎯 Juno Code')} - TypeScript CLI for AI Subagent Orchestration

`,
  );

  program.addHelpText(
    'after',
    `
${chalk.blue.bold('Examples:')}
  ${chalk.gray('# Initialize new project (interactive mode)')}
  juno-code init

  ${chalk.gray('# Initialize with inline mode (automation-friendly)')}
  juno-code init "Build a REST API" --subagent claude --git-repo https://github.com/user/repo

  ${chalk.gray('# Start execution using .juno_task/init.md')}
  juno-code start

  ${chalk.gray('# AI-powered testing')}
  juno-code test --generate --run
  juno-code test src/utils.ts --subagent claude
  juno-code test --analyze --coverage

  ${chalk.gray('# Quick execution with Claude')}
  juno-code claude "Analyze this codebase and suggest improvements"

  ${chalk.gray('# Pipe prompt via stdin (heredoc, pipe, redirect)')}
  echo "Analyze this codebase" | juno-code -s claude
  juno-code -s claude << 'EOF'
  Analyze this codebase and suggest improvements
  EOF

  ${chalk.gray('# Interactive project setup')}
  juno-code init --interactive

  ${chalk.gray('# Manage sessions')}
  juno-code session list
  juno-code session info abc123

  ${chalk.gray('# Enable feedback collection globally')}
  juno-code --enable-feedback start

  ${chalk.gray('# Collect feedback')}
  juno-code feedback --interactive

  ${chalk.gray('# Setup Git repository')}
  juno-code setup-git https://github.com/askbudi/juno-code

  ${chalk.gray('# Verbose is ON by default. Disable with:')}
  juno-code -v false -s claude "prompt"
  juno-code -v 0 -s claude "prompt"
  juno-code -v no -s claude "prompt"

  ${chalk.gray('# Quiet mode (suppress agent output and hooks):')}
  juno-code --quiet -s claude "prompt"
  juno-code --silent -s claude "prompt"

${chalk.blue.bold('Environment Variables:')}
  JUNO_CODE_SUBAGENT              Default subagent (claude, cursor, codex, gemini, pi)
  JUNO_CODE_CONFIG                Configuration file path
  JUNO_CODE_VERBOSE               Verbose output (true/false/0/1/no/yes, default: true)
  JUNO_CODE_ENABLE_FEEDBACK       Enable concurrent feedback collection (true/false)
  JUNO_CODE_MCP_TIMEOUT           Operation timeout in milliseconds
  JUNO_CODE_ON_HOURLY_LIMIT       Behavior when quota limit reached (wait/raise)
  JUNO_INTERACTIVE_FEEDBACK_MODE  Enable interactive feedback mode (true/false)
  NO_COLOR                        Disable colored output (standard)

${chalk.blue.bold('Configuration:')}
  Configuration can be specified via:
  1. Command line arguments (highest priority)
  2. Environment variables
  3. Configuration files (.json, .toml, pyproject.toml)
  4. Built-in defaults (lowest priority)

${chalk.blue.bold('Support:')}
  Documentation: https://github.com/askbudi/juno-code#readme
  Issues: https://github.com/askbudi/juno-code/issues
  Website: https://askbudi.ai
  License: MIT

`,
  );

  // Parse and execute
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    handleCLIError(error, isVerbose);
  }
}

/**
 * Global error handlers
 */
process.on('unhandledRejection', async (reason, promise) => {
  try {
    if (isConnectionLikeError(reason)) {
      // Log and continue (don’t exit) for transient pipe/socket issues
      const { getMCPLogger } = await import('../utils/logger.js');
      const logger = getMCPLogger();
      await logger.error(`[Process][unhandledRejection][connection] ${String(reason)}`, false);
      const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
      if (verbose) {
        console.error(chalk.yellow('\n⚠️  Transient connection issue (continuing):'));
        console.error(chalk.gray('   Reason:'), reason);
      }
      return; // do not exit
    }
  } catch {
    // fall through to default handler
  }
  console.error(chalk.red.bold('\n💥 Unhandled Promise Rejection'));
  console.error(chalk.red('   This is likely a bug. Please report it.'));
  console.error(chalk.gray('   Promise:'), promise);
  console.error(chalk.gray('   Reason:'), reason);
  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
});

process.on('uncaughtException', async (error) => {
  try {
    if (isConnectionLikeError(error)) {
      const { getMCPLogger } = await import('../utils/logger.js');
      const logger = getMCPLogger();
      await logger.error(`[Process][uncaughtException][connection] ${error.message}`, false);
      const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
      if (verbose) {
        console.error(chalk.yellow('\n⚠️  Transient connection exception (continuing):'));
        console.error(chalk.gray('   Error:'), error.message);
      }
      return; // do not exit
    }
  } catch {
    // ignore and fall through
  }
  console.error(chalk.red.bold('\n💥 Uncaught Exception'));
  console.error(chalk.red('   This is likely a bug. Please report it.'));
  console.error(chalk.gray('   Error:'), error.message);
  console.error(chalk.gray('   Stack:'), error.stack);
  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
});

// Handle Ctrl+C gracefully — show session ID so user can resume later
process.on('SIGINT', () => {
  const sessionId = _getActiveSessionId?.();
  if (sessionId) {
    console.log(chalk.cyan(`\n\n🔑 Session ID: ${sessionId}`));
  } else {
    console.log(''); // blank line before cancellation message
  }
  console.log(chalk.yellow('⚠️  Execution cancelled by user'));
  process.exit(EXIT_CODES.SUCCESS);
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n\n⚠️  Execution terminated'));
  process.exit(EXIT_CODES.SUCCESS);
});

// Export for testing
export { main, handleCLIError };

// Always run main() when this file is executed as a CLI
// The shebang ensures this is only executed when run as a command
main().catch((error) => {
  console.error(chalk.red.bold('\n💥 Fatal Error'));
  console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));
  process.exit(EXIT_CODES.UNEXPECTED_ERROR);
});
