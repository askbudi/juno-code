/**
 * Enhanced Shell Completion Utilities for juno-task-ts CLI
 *
 * Advanced completion features including context-aware suggestions,
 * file path completion, and dynamic project state completion.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import fs from 'fs-extra';
import { glob } from 'glob';
import fastGlob from 'fast-glob';
import { ShellDetector, type ShellType } from './shell-detector.js';

// ============================================================================
// Enhanced Completion Interfaces
// ============================================================================

export interface CompletionContext {
  command: string;
  subcommand?: string;
  currentOption?: string;
  previousArgs: string[];
  workingDirectory: string;
}

export interface FileFilter {
  extensions?: string[];
  includeDirectories?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
}

export interface InstallResult {
  success: boolean;
  installPath: string;
  configPath: string;
  message: string;
  warnings?: string[];
}

// ============================================================================
// Model Suggestions Based on Subagent
// ============================================================================

const MODEL_SUGGESTIONS = {
  claude: ['sonnet-4', 'opus-4.1', 'haiku-4', 'claude-3-5-sonnet-20241022'],
  cursor: ['gpt-5', 'sonnet-4', 'sonnet-4-thinking', 'gpt-4o', 'o1-preview'],
  codex: ['gpt-5', 'gpt-4o', 'o1-preview', 'o1-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']
} as const;

export class ContextAwareCompletion {
  private shellDetector: ShellDetector;

  constructor() {
    this.shellDetector = new ShellDetector();
  }

  /**
   * Get model suggestions based on selected subagent
   */
  getModelSuggestions(subagent: string): string[] {
    const normalizedSubagent = subagent.toLowerCase() as keyof typeof MODEL_SUGGESTIONS;
    return MODEL_SUGGESTIONS[normalizedSubagent] || [];
  }

  /**
   * Get file path completions with filtering
   */
  async getFilePaths(partial: string, filter?: FileFilter): Promise<string[]> {
    try {
      const expandedPath = this.expandPath(partial);
      const dirPath = path.dirname(expandedPath);
      const baseName = path.basename(expandedPath);

      // Build glob pattern
      let pattern = path.join(dirPath, `${baseName}*`);

      // Apply filters
      if (filter?.extensions && filter.extensions.length > 0) {
        const extPattern = filter.extensions.length === 1
          ? filter.extensions[0]
          : `{${filter.extensions.join(',')}}`;
        pattern = path.join(dirPath, `${baseName}*${extPattern}`);
      }

      // Use fast-glob for better performance
      const options = {
        dot: filter?.includeHidden || false,
        onlyFiles: !(filter?.includeDirectories ?? true),
        deep: filter?.maxDepth || 3,
        absolute: false,
        markDirectories: true
      };

      const results = await fastGlob(pattern, options);

      // Convert back to relative paths and filter
      return results
        .map(result => {
          if (partial.startsWith('./')) {
            return `./${result}`;
          } else if (partial.startsWith('../')) {
            return result.startsWith('../') ? result : `../${result}`;
          }
          return result;
        })
        .sort();
    } catch (error) {
      console.error('Error completing file paths:', error);
      return [];
    }
  }

  /**
   * Get session IDs from session history
   */
  async getSessionIds(): Promise<string[]> {
    try {
      const sessionDir = path.join(process.cwd(), '.juno_task', 'sessions');
      if (!(await fs.pathExists(sessionDir))) {
        return [];
      }

      const sessions = await fs.readdir(sessionDir);
      return sessions
        .filter(name => name.match(/^session_\d+$/))
        .map(name => name.replace('session_', ''))
        .sort((a, b) => parseInt(b) - parseInt(a)); // Most recent first
    } catch {
      return [];
    }
  }

  /**
   * Get template names from available templates
   */
  async getTemplateNames(): Promise<string[]> {
    try {
      // Check built-in templates (would be in src/templates)
      const builtinTemplates = ['basic', 'advanced', 'research', 'development'];

      // Check custom templates in project
      const customTemplatesDir = path.join(process.cwd(), '.juno_task', 'templates');
      let customTemplates: string[] = [];

      if (await fs.pathExists(customTemplatesDir)) {
        const files = await fs.readdir(customTemplatesDir);
        customTemplates = files
          .filter(name => name.endsWith('.md') || name.endsWith('.hbs'))
          .map(name => path.basename(name, path.extname(name)));
      }

      return [...builtinTemplates, ...customTemplates].sort();
    } catch {
      return ['basic', 'advanced', 'research', 'development'];
    }
  }

  /**
   * Get configuration file paths
   */
  async getConfigPaths(): Promise<string[]> {
    const configPatterns = [
      '.juno_task/config.json',
      '.juno_task/config.yaml',
      '.juno_task/config.toml',
      'juno-task.config.js',
      'juno-task.config.json',
      'pyproject.toml'
    ];

    const existingConfigs: string[] = [];

    for (const pattern of configPatterns) {
      try {
        const matches = await glob(pattern, { cwd: process.cwd() });
        existingConfigs.push(...matches);
      } catch {
        // Continue on error
      }
    }

    return existingConfigs.sort();
  }

  /**
   * Expand path with tilde and relative path resolution
   */
  expandPath(inputPath: string): string {
    if (inputPath.startsWith('~/')) {
      return path.join(os.homedir(), inputPath.slice(2));
    }
    if (inputPath.startsWith('./') || inputPath.startsWith('../')) {
      return path.resolve(inputPath);
    }
    return inputPath;
  }

  /**
   * Filter file paths by extension
   */
  filterByExtension(paths: string[], extensions: string[]): string[] {
    if (!extensions || extensions.length === 0) {
      return paths;
    }

    return paths.filter(filePath => {
      const ext = path.extname(filePath).toLowerCase();
      return extensions.some(allowedExt =>
        allowedExt.toLowerCase() === ext ||
        allowedExt.toLowerCase() === ext.replace('.', '')
      );
    });
  }
}

// ============================================================================
// Project State Completion
// ============================================================================

export class ProjectStateCompletion {
  /**
   * Get recent session names from history
   */
  async getRecentSessions(): Promise<string[]> {
    try {
      const historyFile = path.join(process.cwd(), '.juno_task', 'session_history.json');
      if (!(await fs.pathExists(historyFile))) {
        return [];
      }

      const history = await fs.readJson(historyFile);
      if (Array.isArray(history.sessions)) {
        return history.sessions
          .slice(0, 10) // Last 10 sessions
          .map((session: any) => session.name || session.id)
          .filter(Boolean);
      }
    } catch {
      // Continue silently
    }
    return [];
  }

  /**
   * Get recent prompt files
   */
  async getRecentPrompts(): Promise<string[]> {
    try {
      const patterns = [
        '.juno_task/*.md',
        '.juno_task/prompts/*.md',
        'prompts/*.md',
        '*.md'
      ];

      const promptFiles: string[] = [];

      for (const pattern of patterns) {
        try {
          const matches = await glob(pattern, {
            cwd: process.cwd(),
            ignore: ['node_modules/**', '.git/**']
          });
          promptFiles.push(...matches);
        } catch {
          // Continue on error
        }
      }

      // Sort by modification time (most recent first)
      const filesWithStats = await Promise.all(
        promptFiles.map(async (file) => {
          try {
            const stats = await fs.stat(file);
            return { file, mtime: stats.mtime };
          } catch {
            return null;
          }
        })
      );

      return filesWithStats
        .filter(Boolean)
        .sort((a, b) => b!.mtime.getTime() - a!.mtime.getTime())
        .slice(0, 10)
        .map(item => item!.file);
    } catch {
      return [];
    }
  }

  /**
   * Get Git remote URLs
   */
  async getGitRemotes(): Promise<string[]> {
    try {
      const { execa } = await import('execa');
      const result = await execa('git', ['remote', '-v'], {
        cwd: process.cwd(),
        reject: false
      });

      if (result.exitCode === 0) {
        return result.stdout
          .split('\n')
          .map(line => line.split('\t')[1]?.split(' ')[0])
          .filter(Boolean)
          .filter((url, index, arr) => arr.indexOf(url) === index); // Remove duplicates
      }
    } catch {
      // Git not available or not a git repo
    }
    return [];
  }

  /**
   * Get template variables for a specific template
   */
  async getTemplateVars(templateName: string): Promise<string[]> {
    try {
      const templatePaths = [
        path.join(process.cwd(), '.juno_task', 'templates', `${templateName}.hbs`),
        path.join(process.cwd(), '.juno_task', 'templates', `${templateName}.md`)
      ];

      for (const templatePath of templatePaths) {
        if (await fs.pathExists(templatePath)) {
          const content = await fs.readFile(templatePath, 'utf-8');

          // Extract handlebars variables: {{variable}}
          const variables = content.match(/\{\{([^}]+)\}\}/g);
          if (variables) {
            return variables
              .map(match => match.replace(/[{}]/g, '').trim())
              .filter(variable => !variable.includes(' ')) // Simple variables only
              .filter((variable, index, arr) => arr.indexOf(variable) === index); // Remove duplicates
          }
        }
      }
    } catch {
      // Continue silently
    }

    // Default template variables
    return ['task', 'subagent', 'gitUrl', 'author', 'description'];
  }

  /**
   * Get configuration keys from existing config files
   */
  async getConfigKeys(): Promise<string[]> {
    try {
      const configPath = path.join(process.cwd(), '.juno_task', 'config.json');
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        return Object.keys(config).sort();
      }
    } catch {
      // Continue silently
    }

    // Default configuration keys
    return [
      'subagent',
      'model',
      'maxIterations',
      'logLevel',
      'mcpServerPath',
      'sessionDir',
      'templateDir',
      'gitUrl'
    ].sort();
  }
}

// ============================================================================
// Completion Installation Manager
// ============================================================================

export class CompletionInstaller {
  private shellDetector: ShellDetector;
  private contextCompletion: ContextAwareCompletion;

  constructor() {
    this.shellDetector = new ShellDetector();
    this.contextCompletion = new ContextAwareCompletion();
  }

  /**
   * Install completion for specific shell
   */
  async install(shell: ShellType): Promise<InstallResult> {
    try {
      // Validate shell environment
      const validation = await this.shellDetector.validateShellEnvironment(shell);
      if (!validation.valid) {
        throw new Error(`Shell environment validation failed: ${validation.issues.join(', ')}`);
      }

      // Ensure directories exist
      await this.shellDetector.ensureCompletionDirectory(shell);
      await this.shellDetector.ensureConfigDirectory(shell);

      // Generate enhanced completion script
      const script = this.generateEnhancedCompletion(shell, 'juno-ts-task');
      const completionPath = this.shellDetector.getCompletionPath(shell);

      // Write completion script
      await fs.writeFile(completionPath, script, 'utf-8');

      // Handle shell configuration
      const configPath = this.shellDetector.getConfigPath(shell);
      const sourceCommand = this.shellDetector.getSourceCommand(shell, completionPath);

      const warnings: string[] = [];

      // Add sourcing to shell config if needed (not for fish)
      if (shell !== 'fish') {
        const isPresent = await this.shellDetector.isSourceCommandPresent(configPath, sourceCommand);
        if (!isPresent) {
          try {
            await fs.appendFile(configPath, `\n\n${sourceCommand}\n`);
          } catch (error) {
            warnings.push(`Could not automatically update ${configPath}. Please add manually: ${sourceCommand}`);
          }
        }
      }

      return {
        success: true,
        installPath: completionPath,
        configPath,
        message: `Completion installed for ${shell}. ${shell === 'fish' ? 'Ready to use!' : 'Restart shell or source config file.'}`,
        warnings
      };

    } catch (error) {
      return {
        success: false,
        installPath: '',
        configPath: '',
        message: `Failed to install completion for ${shell}: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Uninstall completion for specific shell
   */
  async uninstall(shell: ShellType): Promise<boolean> {
    try {
      const completionPath = this.shellDetector.getCompletionPath(shell);

      if (await fs.pathExists(completionPath)) {
        await fs.remove(completionPath);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if completion is installed for specific shell
   */
  async isInstalled(shell: ShellType): Promise<boolean> {
    try {
      const completionPath = this.shellDetector.getCompletionPath(shell);
      return await fs.pathExists(completionPath);
    } catch {
      return false;
    }
  }

  /**
   * Get completion status for all shells
   */
  async getStatus() {
    return await this.shellDetector.getCompletionStatus();
  }

  /**
   * Generate enhanced completion script with context-aware features
   */
  private generateEnhancedCompletion(shell: ShellType, commandName: string): string {
    switch (shell) {
      case 'bash':
        return this.generateEnhancedBashCompletion(commandName);
      case 'zsh':
        return this.generateEnhancedZshCompletion(commandName);
      case 'fish':
        return this.generateEnhancedFishCompletion(commandName);
      default:
        throw new Error(`Unsupported shell: ${shell}`);
    }
  }

  /**
   * Generate enhanced bash completion with context-aware features
   */
  private generateEnhancedBashCompletion(commandName: string): string {
    return `#!/bin/bash

# ${commandName} enhanced completion script for bash
# Generated by juno-task-ts CLI with context-aware features

_${commandName}_completion() {
    local cur prev opts base
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    # Commands
    local commands="init start feedback session setup-git claude cursor codex gemini completion"

    # Global options
    local global_opts="--verbose --quiet --config --log-file --no-color --log-level --help --version"

    # Context-aware model completion
    _${commandName}_complete_model() {
        local subagent="\${COMP_WORDS[1]}"
        case "\$subagent" in
            claude)
                COMPREPLY=( \$(compgen -W "sonnet-4 opus-4.1 haiku-4 claude-3-5-sonnet-20241022" -- \$cur) )
                ;;
            cursor)
                COMPREPLY=( \$(compgen -W "gpt-5 sonnet-4 sonnet-4-thinking gpt-4o o1-preview" -- \$cur) )
                ;;
            codex)
                COMPREPLY=( \$(compgen -W "gpt-5 gpt-4o o1-preview o1-mini" -- \$cur) )
                ;;
            gemini)
                COMPREPLY=( \$(compgen -W "gemini-2.5-pro gemini-2.5-flash gemini-1.5-pro gemini-1.5-flash" -- \$cur) )
                ;;
        esac
    }

    # File path completion with filtering
    _${commandName}_complete_files() {
        local extension="\$1"
        if [ -n "\$extension" ]; then
            COMPREPLY=( \$(compgen -f -X "!*.\$extension" -- \$cur) )
        else
            COMPREPLY=( \$(compgen -f -- \$cur) )
        fi
    }

    # Session ID completion
    _${commandName}_complete_sessions() {
        local sessions
        if [ -d ".juno_task/sessions" ]; then
            sessions=\$(ls .juno_task/sessions 2>/dev/null | grep "^session_" | sed 's/session_//' | head -10)
            COMPREPLY=( \$(compgen -W "\$sessions" -- \$cur) )
        fi
    }

    # Command-specific options
    case "\${COMP_WORDS[1]}" in
        init)
            opts="--force --task --subagent --git-url --interactive --template --var \$global_opts"
            case "\$prev" in
                --subagent|-s)
                    COMPREPLY=( \$(compgen -W "claude cursor codex gemini" -- \$cur) )
                    return 0
                    ;;
                --template)
                    COMPREPLY=( \$(compgen -W "basic advanced research development" -- \$cur) )
                    return 0
                    ;;
                --config|-c|--log-file)
                    _${commandName}_complete_files "json yaml toml"
                    return 0
                    ;;
            esac
            ;;
        start)
            opts="--max-iterations --model --directory \$global_opts"
            case "\$prev" in
                --model)
                    _${commandName}_complete_model
                    return 0
                    ;;
                --directory|-d)
                    COMPREPLY=( \$(compgen -d -- \$cur) )
                    return 0
                    ;;
            esac
            ;;
        feedback)
            opts="--file --interactive \$global_opts"
            case "\$prev" in
                --file|-f)
                    _${commandName}_complete_files "md"
                    return 0
                    ;;
            esac
            ;;
        session)
            local subcommands="list info remove clean"
            case "\${COMP_WORDS[2]}" in
                list|ls)
                    opts="--limit --subagent --status \$global_opts"
                    case "\$prev" in
                        --subagent)
                            COMPREPLY=( \$(compgen -W "claude cursor codex gemini" -- \$cur) )
                            return 0
                            ;;
                        --status)
                            COMPREPLY=( \$(compgen -W "running completed failed cancelled" -- \$cur) )
                            return 0
                            ;;
                    esac
                    ;;
                info|show)
                    opts="\$global_opts"
                    # Complete session IDs
                    if [ \$COMP_CWORD -eq 3 ]; then
                        _${commandName}_complete_sessions
                        return 0
                    fi
                    ;;
                remove|rm|delete)
                    opts="--force \$global_opts"
                    if [ \$COMP_CWORD -eq 3 ]; then
                        _${commandName}_complete_sessions
                        return 0
                    fi
                    ;;
                clean|cleanup)
                    opts="--days --empty --force \$global_opts"
                    ;;
                *)
                    opts="\$subcommands \$global_opts"
                    ;;
            esac
            ;;
        completion)
            local completion_commands="install uninstall status"
            case "\${COMP_WORDS[2]}" in
                install|uninstall)
                    if [ \$COMP_CWORD -eq 3 ]; then
                        COMPREPLY=( \$(compgen -W "bash zsh fish" -- \$cur) )
                        return 0
                    fi
                    ;;
                *)
                    opts="\$completion_commands \$global_opts"
                    ;;
            esac
            ;;
        claude|cursor|codex|gemini)
            opts="--max-iterations --model --cwd --interactive --interactive-prompt \$global_opts"
            case "\$prev" in
                --model)
                    _${commandName}_complete_model
                    return 0
                    ;;
                --cwd)
                    COMPREPLY=( \$(compgen -d -- \$cur) )
                    return 0
                    ;;
            esac
            ;;
        *)
            opts="\$commands \$global_opts"
            ;;
    esac

    # Handle option values
    case "\$prev" in
        --log-level)
            COMPREPLY=( \$(compgen -W "error warn info debug trace" -- \$cur) )
            return 0
            ;;
        --config|--log-file)
            _${commandName}_complete_files
            return 0
            ;;
        --directory|--cwd)
            COMPREPLY=( \$(compgen -d -- \$cur) )
            return 0
            ;;
    esac

    COMPREPLY=( \$(compgen -W "\$opts" -- \$cur) )
    return 0
}

complete -F _${commandName}_completion ${commandName}
`;
  }

  /**
   * Generate enhanced zsh completion script
   */
  private generateEnhancedZshCompletion(commandName: string): string {
    return `#compdef ${commandName}

# ${commandName} enhanced completion script for zsh
# Generated by juno-task-ts CLI with context-aware features

_${commandName}() {
    local context state line
    typeset -A opt_args

    # Context-aware model completion
    _${commandName}_models() {
        local subagent="\$words[2]"
        local models
        case "\$subagent" in
            claude) models=(sonnet-4 opus-4.1 haiku-4 claude-3-5-sonnet-20241022) ;;
            cursor) models=(gpt-5 sonnet-4 sonnet-4-thinking gpt-4o o1-preview) ;;
            codex) models=(gpt-5 gpt-4o o1-preview o1-mini) ;;
            gemini) models=(gemini-2.5-pro gemini-2.5-flash gemini-1.5-pro gemini-1.5-flash) ;;
        esac
        _describe 'models' models
    }

    # Session completion
    _${commandName}_sessions() {
        local sessions
        if [[ -d ".juno_task/sessions" ]]; then
            sessions=(\${(f)"\$(ls .juno_task/sessions 2>/dev/null | grep "^session_" | sed 's/session_//' | head -10)"})
            _describe 'sessions' sessions
        fi
    }

    # Template completion
    _${commandName}_templates() {
        local templates=(basic advanced research development)
        _describe 'templates' templates
    }

    local commands=(
        'init:Initialize new juno-task project with template files'
        'start:Start execution using .juno_task/init.md as prompt'
        'feedback:Collect and manage user feedback'
        'session:Manage execution sessions'
        'setup-git:Configure Git repository and upstream URL'
        'completion:Manage shell completion installation'
        'claude:Execute with Claude subagent'
        'cursor:Execute with Cursor subagent'
        'codex:Execute with Codex subagent'
        'gemini:Execute with Gemini subagent'
    )

    local global_opts=(
        '(-v --verbose)'{-v,--verbose}'[Enable verbose output]'
        '(-q --quiet)'{-q,--quiet}'[Disable rich formatting]'
        '(-c --config)'{-c,--config}'[Configuration file path]:file:_files'
        '--log-file[Log file path]:file:_files'
        '--no-color[Disable colored output]'
        '--log-level[Log level]:level:(error warn info debug trace)'
        '(-h --help)'{-h,--help}'[Show help]'
        '(-V --version)'{-V,--version}'[Show version]'
    )

    _arguments -C \\
        "1: :->commands" \\
        "*: :->args" \\
        \$global_opts

    case \$state in
        commands)
            _describe 'commands' commands
            ;;
        args)
            case \$words[2] in
                init)
                    _arguments \\
                        '(-f --force)'{-f,--force}'[Force overwrite existing files]' \\
                        '(-t --task)'{-t,--task}'[Main task description]:task:' \\
                        '(-s --subagent)'{-s,--subagent}'[Preferred subagent]:subagent:(claude cursor codex gemini)' \\
                        '(-g --git-url)'{-g,--git-url}'[Git repository URL]:url:' \\
                        '(-i --interactive)'{-i,--interactive}'[Launch interactive setup]' \\
                        '--template[Template variant]:template:_${commandName}_templates' \\
                        \$global_opts
                    ;;
                start)
                    _arguments \\
                        '(-m --max-iterations)'{-m,--max-iterations}'[Maximum iterations]:number:' \\
                        '--model[Model to use]:model:_${commandName}_models' \\
                        '(-d --directory)'{-d,--directory}'[Project directory]:directory:_directories' \\
                        \$global_opts
                    ;;
                feedback)
                    _arguments \\
                        '(-f --file)'{-f,--file}'[Custom feedback file]:file:_files -g "*.md"' \\
                        '(-i --interactive)'{-i,--interactive}'[Interactive feedback collection]' \\
                        \$global_opts
                    ;;
                session)
                    local session_commands=(
                        'list:List all sessions'
                        'info:Show detailed session information'
                        'remove:Remove one or more sessions'
                        'clean:Clean up old/empty sessions'
                    )
                    case \$words[3] in
                        info|remove)
                            _arguments \\
                                "1: :_describe 'session commands' session_commands" \\
                                "2: :_${commandName}_sessions" \\
                                \$global_opts
                            ;;
                        *)
                            _arguments \\
                                "1: :_describe 'session commands' session_commands" \\
                                \$global_opts
                            ;;
                    esac
                    ;;
                completion)
                    local completion_commands=(
                        'install:Install shell completion'
                        'uninstall:Uninstall shell completion'
                        'status:Show completion installation status'
                    )
                    case \$words[3] in
                        install|uninstall)
                            _arguments \\
                                "1: :_describe 'completion commands' completion_commands" \\
                                "2: :(bash zsh fish)" \\
                                \$global_opts
                            ;;
                        *)
                            _arguments \\
                                "1: :_describe 'completion commands' completion_commands" \\
                                \$global_opts
                            ;;
                    esac
                    ;;
                claude|cursor|codex|gemini)
                    _arguments \\
                        '(-m --max-iterations)'{-m,--max-iterations}'[Maximum iterations]:number:' \\
                        '--model[Model to use]:model:_${commandName}_models' \\
                        '--cwd[Working directory]:directory:_directories' \\
                        '(-i --interactive)'{-i,--interactive}'[Interactive mode]' \\
                        '--interactive-prompt[Launch TUI prompt editor]' \\
                        \$global_opts
                    ;;
            esac
            ;;
    esac
}

_${commandName} "\$@"
`;
  }

  /**
   * Generate enhanced fish completion script
   */
  private generateEnhancedFishCompletion(commandName: string): string {
    return `# ${commandName} enhanced completion script for fish
# Generated by juno-task-ts CLI with context-aware features

# Context-aware model completion
function __${commandName}_complete_models
    set -l subagent (commandline -opc)[2]
    switch \$subagent
        case claude
            echo -e "sonnet-4\\nopus-4.1\\nhaiku-4\\nclaude-3-5-sonnet-20241022"
        case cursor
            echo -e "gpt-5\\nsonnet-4\\nsonnet-4-thinking\\ngpt-4o\\no1-preview"
        case codex
            echo -e "gpt-5\\ngpt-4o\\no1-preview\\no1-mini"
        case gemini
            echo -e "gemini-2.5-pro\\ngemini-2.5-flash\\ngemini-1.5-pro\\ngemini-1.5-flash"
    end
end

# Session ID completion
function __${commandName}_complete_sessions
    if test -d .juno_task/sessions
        ls .juno_task/sessions 2>/dev/null | grep "^session_" | sed 's/session_//' | head -10
    end
end

# Template completion
function __${commandName}_complete_templates
    echo -e "basic\\nadvanced\\nresearch\\ndevelopment"
end

# Commands
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'init' -d 'Initialize new juno-task project'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'start' -d 'Start execution using init.md'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'feedback' -d 'Collect and manage feedback'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'session' -d 'Manage execution sessions'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'setup-git' -d 'Configure Git repository'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'completion' -d 'Manage shell completion'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'claude' -d 'Execute with Claude'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'cursor' -d 'Execute with Cursor'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'codex' -d 'Execute with Codex'
complete -c ${commandName} -f -n '__fish_use_subcommand' -a 'gemini' -d 'Execute with Gemini'

# Global options
complete -c ${commandName} -s v -l verbose -d 'Enable verbose output'
complete -c ${commandName} -s q -l quiet -d 'Disable rich formatting'
complete -c ${commandName} -s c -l config -d 'Configuration file path' -r
complete -c ${commandName} -l log-file -d 'Log file path' -r
complete -c ${commandName} -l no-color -d 'Disable colored output'
complete -c ${commandName} -l log-level -d 'Log level' -xa 'error warn info debug trace'
complete -c ${commandName} -s h -l help -d 'Show help'
complete -c ${commandName} -s V -l version -d 'Show version'

# Init command options
complete -c ${commandName} -f -n '__fish_seen_subcommand_from init' -s f -l force -d 'Force overwrite'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from init' -s t -l task -d 'Main task description' -r
complete -c ${commandName} -f -n '__fish_seen_subcommand_from init' -s s -l subagent -d 'Preferred subagent' -xa 'claude cursor codex gemini'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from init' -s g -l git-url -d 'Git repository URL' -r
complete -c ${commandName} -f -n '__fish_seen_subcommand_from init' -s i -l interactive -d 'Interactive setup'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from init' -l template -d 'Template variant' -a '(__${commandName}_complete_templates)'

# Start command options
complete -c ${commandName} -f -n '__fish_seen_subcommand_from start' -s m -l max-iterations -d 'Maximum iterations' -r
complete -c ${commandName} -f -n '__fish_seen_subcommand_from start' -l model -d 'Model to use' -a '(__${commandName}_complete_models)'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from start' -s d -l directory -d 'Project directory' -xa '(__fish_complete_directories)'

# Feedback command options
complete -c ${commandName} -f -n '__fish_seen_subcommand_from feedback' -s f -l file -d 'Custom feedback file' -xa '(__fish_complete_suffix .md)'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from feedback' -s i -l interactive -d 'Interactive feedback'

# Session command options
complete -c ${commandName} -f -n '__fish_seen_subcommand_from session' -a 'list' -d 'List sessions'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from session' -a 'info' -d 'Show session info'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from session' -a 'remove' -d 'Remove sessions'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from session' -a 'clean' -d 'Clean up sessions'

# Session info/remove completion with session IDs
complete -c ${commandName} -f -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from info remove' -a '(__${commandName}_complete_sessions)'

# Completion command options
complete -c ${commandName} -f -n '__fish_seen_subcommand_from completion' -a 'install' -d 'Install completion'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from completion' -a 'uninstall' -d 'Uninstall completion'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from completion' -a 'status' -d 'Show status'

# Completion shell selection
complete -c ${commandName} -f -n '__fish_seen_subcommand_from completion; and __fish_seen_subcommand_from install uninstall' -a 'bash zsh fish'

# Subagent command options
complete -c ${commandName} -f -n '__fish_seen_subcommand_from claude cursor codex gemini' -s m -l max-iterations -d 'Maximum iterations' -r
complete -c ${commandName} -f -n '__fish_seen_subcommand_from claude cursor codex gemini' -l model -d 'Model to use' -a '(__${commandName}_complete_models)'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from claude cursor codex gemini' -l cwd -d 'Working directory' -xa '(__fish_complete_directories)'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from claude cursor codex gemini' -s i -l interactive -d 'Interactive mode'
complete -c ${commandName} -f -n '__fish_seen_subcommand_from claude cursor codex gemini' -l interactive-prompt -d 'TUI prompt editor'
`;
  }
}

// Export enhanced completion utilities
export default {
  ContextAwareCompletion,
  ProjectStateCompletion,
  CompletionInstaller
};