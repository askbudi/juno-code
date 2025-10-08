# juno-task-ts

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/owner/juno-task-ts/actions)
[![Test Coverage](https://img.shields.io/badge/coverage-96.91%25-brightgreen)](https://github.com/owner/juno-task-ts)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3.3-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/badge/npm-1.0.0-blue)](https://www.npmjs.com/package/juno-task-ts)

**Production-Ready TypeScript CLI for AI Subagent Orchestration via MCP Protocol**

A comprehensive TypeScript implementation of the juno-task CLI tool that provides seamless integration with multiple AI subagents (Claude, Cursor, Codex, Gemini) through the Model Context Protocol (MCP). Features a modern terminal UI, robust session management, and enterprise-grade reliability with 98%+ completion status.

## 🚀 Project Overview

juno-task-ts transforms how developers interact with AI coding assistants by providing:

- **🤖 Universal AI Integration**: Connect to Claude, Cursor, Codex, and Gemini through standardized MCP protocol
- **🖥️ Modern Terminal UI**: Interactive TUI with real-time progress tracking and visual feedback
- **⚡ Dual Execution Modes**: Interactive mode with rich UI or headless mode for automation/CI
- **📊 Session Management**: Persistent tracking, analytics, and history for all execution sessions
- **🎯 Production Ready**: 96.91% test coverage, strict TypeScript, enterprise-grade error handling
- **🔄 Real-time Progress**: Live updates from MCP server with detailed progress callbacks
- **📋 Template System**: Handlebars-based project initialization and scaffolding

## 🎯 Key Features

### ✅ **Full MCP Integration**
- Native Model Context Protocol implementation
- Automatic server discovery and connection management
- Real-time bidirectional communication with AI subagents
- Progress event parsing and callback system

### ✅ **Modern Terminal Interface**
- Component-based TUI built with React/Ink
- Real-time progress visualization
- Interactive prompts and dialogs
- Responsive design that adapts to terminal size

### ✅ **Flexible Execution Modes**
- **Interactive Mode**: Rich TUI with visual progress and controls
- **Headless Mode**: Silent operation perfect for automation and CI/CD
- **Prompt Editor**: Built-in editor for complex task descriptions

### ✅ **Enterprise-Grade Architecture**
- **Type Safety**: Strict TypeScript with zero `any` types
- **Error Handling**: Comprehensive error recovery and reporting
- **Configuration**: Multiple config sources with proper precedence
- **Logging**: Structured logging with configurable levels
- **Testing**: 96.91% test coverage across unit, integration, and E2E tests

### ✅ **Session & State Management**
- Persistent session storage and tracking
- Execution history and analytics
- Session cleanup and management tools
- Context preservation across runs

## 📦 Installation

### Global Installation
```bash
npm install -g juno-task-ts
```

### Local Installation
```bash
npm install juno-task-ts
```

### Build from Source
```bash
git clone https://github.com/owner/juno-task-ts.git
cd juno-task-ts
npm install
npm run build
npm link  # For global CLI access
```

## 🚀 Quick Start

### Initialize a New Project
```bash
# Initialize with interactive setup
juno-task init

# Quick initialization with specific subagent
juno-task init --task "Create a REST API with FastAPI" --subagent claude

# Initialize in specific directory
juno-task init ./my-project --interactive
```

### Execute Tasks
```bash
# Start execution using .juno_task/init.md
juno-task start

# Direct execution with Claude
juno-task claude "Analyze this codebase and suggest improvements"

# Verbose mode with progress tracking
juno-task start --verbose

# Headless mode for automation
juno-task start --quiet --no-color
```

### Interactive Mode
```bash
# Launch interactive prompt editor
juno-task --interactive-prompt

# Launch main interactive mode
juno-task main --interactive
```

## 📚 Commands Reference

### Core Commands

#### `juno-task init [options] [directory]`
Initialize new juno-task project with template files

```bash
# Interactive initialization
juno-task init --interactive

# Specify task and subagent
juno-task init --task "Build a web scraper" --subagent cursor

# Initialize with template
juno-task init --template typescript-api
```

**Options:**
- `--task <description>` - Task description for the project
- `--subagent <name>` - AI subagent to use (claude, cursor, codex, gemini)
- `--interactive` - Interactive mode for guided setup
- `--template <name>` - Template to use for initialization
- `--dry-run` - Show what would be created without creating files

#### `juno-task start [options]`
Start execution using .juno_task/init.md as prompt

```bash
# Basic start
juno-task start

# With specific subagent and iterations
juno-task start --subagent claude --max-iterations 5

# Verbose mode with progress tracking
juno-task start --verbose --log-level debug
```

**Options:**
- `--subagent <name>` - Override default subagent
- `--max-iterations <number>` - Maximum iterations (-1 for unlimited)
- `--verbose` - Enable detailed progress output
- `--model <name>` - Specific model to use

#### `juno-task session [subcommand] [args...]`
Manage execution sessions

```bash
# List recent sessions
juno-task session list --limit 10

# Show session details
juno-task session info <session-id>

# Remove specific session
juno-task session remove <session-id>

# Clean old sessions
juno-task session clean --days 7
```

**Subcommands:**
- `list` - List execution sessions
- `info <id>` - Show detailed session information
- `remove <id>` - Remove specific session
- `clean` - Clean up old sessions

#### `juno-task feedback [options] [text...]`
Collect and manage user feedback

```bash
# Quick feedback
juno-task feedback "Great tool, works perfectly!"

# Interactive feedback collection
juno-task feedback --interactive

# Rate your experience
juno-task feedback --rating 5 "Excellent AI integration"
```

#### `juno-task setup-git [options] [url]`
Configure Git repository and upstream URL

```bash
# Setup with remote URL
juno-task setup-git https://github.com/owner/repo

# Initialize local repository only
juno-task setup-git --local-only
```

### Global Options

All commands support these global options:

- `-v, --verbose` - Enable verbose output with detailed progress
- `-q, --quiet` - Disable rich formatting, use plain text
- `-c, --config <path>` - Configuration file path
- `--log-file <path>` - Log file path
- `--no-color` - Disable colored output
- `--log-level <level>` - Log level (error, warn, info, debug, trace)
- `--cwd <path>` - Working directory
- `-V, --version` - Display version information
- `-h, --help` - Display help information

## 🚀 Shell Completion

juno-task-ts provides intelligent shell completion across multiple shells with context-aware suggestions for commands, options, file paths, models, sessions, and more.

### Overview

The shell completion system offers:

- **Multi-shell support**: bash, zsh, fish, and PowerShell
- **Context-aware completions**: Dynamic suggestions based on command context
- **File path completion**: Smart filtering for relevant file types
- **Model and session completion**: Auto-complete available models and session IDs
- **Template completion**: Suggestions for available project templates
- **Auto-installation**: Automatic shell detection and setup

### Installation

#### Automatic Installation (Recommended)

The completion system automatically detects your shell and installs the appropriate completion script:

```bash
# Install completion for your current shell
juno-task completion install

# Check installation status
juno-task completion status
```

#### Manual Installation by Shell

**Bash:**
```bash
# Install completion
juno-task completion install --shell bash

# Or manually add to .bashrc
echo 'eval "$(juno-task completion bash)"' >> ~/.bashrc
source ~/.bashrc
```

**Zsh:**
```bash
# Install completion
juno-task completion install --shell zsh

# Or manually add to .zshrc
echo 'eval "$(juno-task completion zsh)"' >> ~/.zshrc
source ~/.zshrc
```

**Fish:**
```bash
# Install completion
juno-task completion install --shell fish

# Or manually add to Fish config
juno-task completion fish > ~/.config/fish/completions/juno-task.fish
```

**PowerShell:**
```powershell
# Install completion
juno-task completion install --shell powershell

# Or manually add to PowerShell profile
juno-task completion powershell >> $PROFILE
```

### Features

#### Command and Option Completion

Tab completion works for all commands and their options:

```bash
juno-task <TAB>
# Suggests: init, start, session, feedback, setup-git, completion

juno-task init --<TAB>
# Suggests: --task, --subagent, --interactive, --template, --dry-run

juno-task start --subagent <TAB>
# Suggests: claude, cursor, codex, gemini
```

#### File Path Completion

Smart file path completion with context-aware filtering:

```bash
juno-task init <TAB>
# Shows directories for project initialization

juno-task --config <TAB>
# Shows .json, .toml, and pyproject.toml files

juno-task --log-file <TAB>
# Shows .log files and suggests log directory paths
```

#### Model Completion

Auto-complete available models for each subagent:

```bash
juno-task start --model <TAB>
# For Claude: claude-3-5-sonnet-20241022, claude-3-haiku-20240307, etc.
# For Cursor: gpt-4-turbo-preview, gpt-3.5-turbo, etc.
# For Codex: code-davinci-002, text-davinci-003, etc.
```

#### Session Completion

Complete session IDs and session-related operations:

```bash
juno-task session info <TAB>
# Shows available session IDs

juno-task session remove <TAB>
# Shows session IDs with preview information
```

#### Template Completion

Auto-complete available project templates:

```bash
juno-task init --template <TAB>
# Suggests: typescript-api, react-app, python-cli, nextjs-app, etc.
```

### Examples

#### Basic Command Completion
```bash
# Type and press TAB
juno-task s<TAB>
# Completes to: juno-task start

# Continue with options
juno-task start --v<TAB>
# Completes to: juno-task start --verbose
```

#### File Path Completion
```bash
# Initialize in specific directory
juno-task init my-pr<TAB>
# Completes to available directories starting with "my-pr"

# Use custom config file
juno-task --config ~/.jun<TAB>
# Completes to: juno-task --config ~/.juno-task/config.json
```

#### Session Management
```bash
# View session information
juno-task session info <TAB>
# Shows list like:
# 2024-01-15_10-30-45_init_claude    2024-01-15_14-22-10_start_cursor

# Remove old sessions
juno-task session remove 2024-01-<TAB>
# Shows sessions from January 2024 with details
```

#### Model Selection
```bash
# Start with specific model
juno-task start --subagent claude --model <TAB>
# Shows Claude-specific models:
# claude-3-5-sonnet-20241022    claude-3-haiku-20240307    claude-3-opus-20240229
```

### Troubleshooting

#### Completion Not Working

**Check installation status:**
```bash
juno-task completion status
# Shows installation status for your shell
```

**Reinstall completion:**
```bash
juno-task completion uninstall
juno-task completion install
```

**Manual verification:**
```bash
# Test completion generation
juno-task completion bash > /tmp/test-completion.sh
source /tmp/test-completion.sh
```

#### Bash-specific Issues

**If completions don't load automatically:**
```bash
# Check if bash-completion is installed
brew install bash-completion  # macOS
apt-get install bash-completion  # Ubuntu/Debian

# Ensure completion is sourced
echo 'source ~/.bashrc' >> ~/.bash_profile
```

#### Zsh-specific Issues

**If completions are slow or not working:**
```bash
# Rebuild completion cache
rm ~/.zcompdump*
compinit

# Check zsh completion system
autoload -U compinit && compinit
```

#### Fish-specific Issues

**If completions don't appear:**
```bash
# Check Fish completion directory
ls ~/.config/fish/completions/juno-task.fish

# Reload Fish configuration
fish -c "source ~/.config/fish/config.fish"
```

#### PowerShell-specific Issues

**If completions aren't loaded:**
```powershell
# Check PowerShell profile
Test-Path $PROFILE

# Create profile if it doesn't exist
New-Item -ItemType File -Path $PROFILE -Force

# Reload profile
. $PROFILE
```

### Advanced Usage

#### Custom Completion Contexts

The completion system adapts to different contexts:

```bash
# Different suggestions based on subagent
juno-task start --subagent claude --model <TAB>    # Claude models
juno-task start --subagent cursor --model <TAB>    # OpenAI models

# Context-aware file filtering
juno-task --config <TAB>                           # Config files only
juno-task session clean --output <TAB>             # Log/output files
```

#### Performance Optimization

For large projects with many files, completion performance can be optimized:

```bash
# Set completion cache timeout (in seconds)
export JUNO_TASK_COMPLETION_CACHE=300

# Disable file completion for specific commands
export JUNO_TASK_COMPLETION_NO_FILES=1
```

## ⚙️ Configuration

juno-task-ts supports multiple configuration sources with proper precedence:

**Precedence Order** (highest to lowest):
1. CLI arguments
2. Environment variables
3. Configuration files
4. Built-in defaults

### Environment Variables

All CLI options can be configured via environment variables with the `JUNO_TASK_` prefix:

```bash
# Core settings
export JUNO_TASK_SUBAGENT=claude
export JUNO_TASK_VERBOSE=true
export JUNO_TASK_MAX_ITERATIONS=5

# MCP configuration
export JUNO_TASK_MCP_SERVER_PATH=/path/to/roundtable-ai
export JUNO_TASK_MCP_TIMEOUT=30000

# Logging and output
export JUNO_TASK_LOG_LEVEL=debug
export JUNO_TASK_LOG_FILE=./logs/juno-task.log
export NO_COLOR=1  # Disable colored output
```

### Configuration Files

Supported formats: `.json`, `.toml`, `pyproject.toml`

**Example `juno-task.json`:**
```json
{
  "defaultSubagent": "claude",
  "defaultMaxIterations": 10,
  "verbose": true,
  "logLevel": "info",
  "mcpTimeout": 30000,
  "workingDirectory": "./workspace",
  "sessionDirectory": "./sessions"
}
```

**Example `.toml`:**
```toml
[juno-task]
defaultSubagent = "cursor"
defaultMaxIterations = 15
verbose = false
logLevel = "warn"

[juno-task.mcp]
timeout = 45000
serverPath = "/usr/local/bin/roundtable-ai"
```

### Configuration Discovery

juno-task-ts automatically searches for configuration files in:

1. Current working directory
2. Parent directories (up to repository root)
3. User home directory (`~/.juno-task/config.json`)
4. System-wide (`/etc/juno-task/config.json`)

## 🔧 MCP Integration

### Roundtable MCP Server Setup

juno-task-ts connects to the Roundtable MCP server for AI subagent orchestration:

```bash
# Install Roundtable MCP server
pip install roundtable-ai

# Configure server path
export JUNO_TASK_MCP_SERVER_PATH=$(which roundtable-ai)

# Test connection
juno-task start --verbose  # Will show MCP connection status
```

### Progress Tracking

When `--verbose` is enabled, juno-task-ts provides real-time progress updates:

```
🎯 Juno Task - Starting execution...
🔗 MCP: Connected to roundtable server
🤖 Subagent: claude (claude-3-5-sonnet-20241022)
📋 Task: Analyze codebase and suggest improvements

⏳ [1/5] Initializing analysis...
🔍 [2/5] Scanning project structure...
📊 [3/5] Analyzing code quality...
💡 [4/5] Generating recommendations...
✅ [5/5] Complete! Generated 12 improvement suggestions
```

### Subagent Selection

Choose the best AI subagent for your task:

- **claude** - Excellent for complex reasoning and code analysis
- **cursor** - Optimized for code editing and refactoring
- **codex** - Strong at code generation and completion
- **gemini** - Good for multimodal tasks and documentation

### Model Configuration

Specify models per subagent:

```bash
# Use specific Claude model
juno-task claude "Fix this bug" --model claude-3-5-sonnet-20241022

# Use GPT-4 for Codex
juno-task codex "Generate tests" --model gpt-4-turbo-preview
```

## 📖 Examples & Use Cases

### Web Development
```bash
# Initialize React project
juno-task init --task "Create React app with TypeScript and Tailwind" --subagent cursor

# Add authentication
juno-task start --subagent claude
# (edit .juno_task/init.md: "Add JWT authentication to the React app")
```

### API Development
```bash
# FastAPI project
juno-task init --task "Build REST API with FastAPI, SQLAlchemy, and Pydantic"

# Add specific features
juno-task claude "Add user registration endpoint with email validation"
```

### Code Analysis
```bash
# Analyze existing codebase
juno-task claude "Analyze this Python project for performance bottlenecks and security issues" --verbose

# Generate documentation
juno-task cursor "Generate comprehensive README and API documentation"
```

### Testing & Quality
```bash
# Generate test suite
juno-task codex "Create comprehensive test suite with pytest and coverage reporting"

# Code review
juno-task claude "Review this PR and suggest improvements" --max-iterations 3
```

### DevOps & Automation
```bash
# Setup CI/CD
juno-task gemini "Create GitHub Actions workflow for testing and deployment"

# Infrastructure as Code
juno-task claude "Create Terraform configuration for AWS deployment"
```

## 🛠️ Development

### Prerequisites

- Node.js 18+
- TypeScript 5.0+
- npm or yarn

### Setup Development Environment

```bash
# Clone repository
git clone https://github.com/owner/juno-task-ts.git
cd juno-task-ts

# Install dependencies
npm install

# Build project
npm run build

# Run tests
npm test

# Start development mode
npm run dev

# Type checking
npm run typecheck

# Linting and formatting
npm run lint
npm run format
```

### Testing

juno-task-ts maintains 96.91% test coverage across multiple test types:

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Run specific test types
npm run test:unit        # Unit tests
npm run test:integration # Integration tests
npm run test:e2e        # End-to-end tests

# Watch mode during development
npm run test:watch
```

### Build System

Uses `tsup` for fast, optimized builds:

```bash
# Production build
npm run build

# Development build with watch
npm run build:watch

# Clean build artifacts
npm run clean
```

### Project Structure

```
src/
├── bin/           # CLI entry points
├── cli/           # Command-line interface
│   ├── commands/  # Individual commands
│   ├── utils/     # CLI utilities
│   └── framework.ts
├── core/          # Core business logic
│   ├── engine.ts  # Execution engine
│   ├── session.ts # Session management
│   └── config.ts  # Configuration
├── mcp/           # MCP client implementation
│   ├── client.ts  # MCP client
│   ├── types.ts   # MCP type definitions
│   └── errors.ts  # MCP error handling
├── tui/           # Terminal user interface
│   ├── apps/      # TUI applications
│   ├── components/# UI components
│   └── hooks/     # React hooks
├── templates/     # Template system
│   ├── engine.ts  # Template engine
│   └── types.ts   # Template types
├── utils/         # Utility functions
├── types/         # TypeScript type definitions
└── __tests__/     # Test files
```

## 🔧 Troubleshooting

### Common Issues

#### MCP Connection Failed
```
Error: Failed to connect to MCP server
```

**Solutions:**
1. Verify Roundtable MCP server is installed: `pip install roundtable-ai`
2. Check server path: `which roundtable-ai`
3. Set environment variable: `export JUNO_TASK_MCP_SERVER_PATH=$(which roundtable-ai)`
4. Test with verbose mode: `juno-task start --verbose`

#### CLI Not Found After Installation
```
command not found: juno-task
```

**Solutions:**
1. Global install: `npm install -g juno-task-ts`
2. Check npm global bin: `npm config get prefix`
3. Add to PATH: `export PATH=$PATH:$(npm config get prefix)/bin`
4. Use npx: `npx juno-task-ts --help`

#### ESM Import Errors
```
Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph
```

**Solutions:**
1. Use Node.js 18+: `node --version`
2. Use ESM entry point: `node dist/bin/cli.mjs` instead of `cli.js`
3. Update package.json type: `"type": "module"`

#### Session Directory Permissions
```
Error: Permission denied creating session directory
```

**Solutions:**
1. Check permissions: `ls -la ~/.juno-task/`
2. Create directory: `mkdir -p ~/.juno-task/sessions`
3. Fix permissions: `chmod 755 ~/.juno-task/`
4. Use custom directory: `juno-task --config '{"sessionDirectory": "./sessions"}'`

#### High Memory Usage
```
Process killed due to memory usage
```

**Solutions:**
1. Limit iterations: `--max-iterations 5`
2. Use headless mode: `--quiet --no-color`
3. Increase Node.js memory: `node --max-old-space-size=4096`
4. Clean old sessions: `juno-task session clean --days 1`

### Debug Mode

Enable comprehensive debugging:

```bash
# Enable debug logs
juno-task start --log-level debug --verbose

# Output to file
juno-task start --log-file debug.log --verbose

# Environment variable
DEBUG=juno-task:* juno-task start
```

### Performance Optimization

For better performance:

```bash
# Use headless mode
juno-task start --quiet

# Limit iterations
juno-task start --max-iterations 3

# Use faster subagent
juno-task start --subagent cursor  # Generally faster than claude
```

## 🔄 Migration from Python budi-cli

juno-task-ts is a TypeScript reimplementation of the Python budi-cli. Key differences:

### Command Changes
| Python budi-cli | juno-task-ts | Notes |
|----------------|--------------|-------|
| `budi-cli` | `juno-task` | New command name |
| `--subagent` | `--subagent` | Same option |
| `--prompt` | `--prompt` | Same option |
| `init --wizard` | `init --interactive` | Renamed for clarity |

### Configuration Migration

**Python config** (`budi.toml`):
```toml
[budi]
default_subagent = "claude"
max_iterations = 10
```

**TypeScript config** (`juno-task.json`):
```json
{
  "defaultSubagent": "claude",
  "defaultMaxIterations": 10
}
```

### Environment Variables
| Python | TypeScript |
|--------|------------|
| `BUDI_CLI_*` | `JUNO_TASK_*` |
| `BUDI_SUBAGENT` | `JUNO_TASK_SUBAGENT` |

### Migration Script

```bash
#!/bin/bash
# migrate-to-juno-task.sh

# Backup existing config
cp budi.toml budi.toml.bak 2>/dev/null

# Install juno-task-ts
npm install -g juno-task-ts

# Convert environment variables
if [ ! -z "$BUDI_SUBAGENT" ]; then
    export JUNO_TASK_SUBAGENT="$BUDI_SUBAGENT"
fi

# Initialize juno-task in existing project
juno-task init --interactive

echo "Migration complete! Test with: juno-task --help"
```

## 📄 License & Credits

### License
MIT License - see [LICENSE](LICENSE) file for details.

### Credits

- **Original Concept**: Based on the Python budi-cli project
- **MCP Protocol**: Anthropic's Model Context Protocol
- **Contributors**: Development Team and Open Source Community
- **Dependencies**: Built with TypeScript, React/Ink, Commander.js, and other excellent open source projects

### Acknowledgments

Special thanks to:
- The Python budi-cli project for the original concept and architecture
- Anthropic for the Model Context Protocol specification
- The TypeScript and Node.js communities for excellent tooling
- All contributors and users providing feedback and improvements

---

## 🔗 Links

- **Documentation**: [GitHub Pages](https://github.com/owner/juno-task-ts#readme)
- **Issues**: [GitHub Issues](https://github.com/owner/juno-task-ts/issues)
- **Discussions**: [GitHub Discussions](https://github.com/owner/juno-task-ts/discussions)
- **NPM Package**: [npmjs.com/package/juno-task-ts](https://www.npmjs.com/package/juno-task-ts)
- **License**: [MIT License](LICENSE)

---

<p align="center">
  <b>juno-task-ts</b> - Production-Ready TypeScript CLI for AI Subagent Orchestration
  <br>
  Built with ❤️ by the Development Team
</p>