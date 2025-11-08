# juno-code

TypeScript CLI tool for AI subagent orchestration with code automation.

## Overview

juno-code is an AI-powered development CLI that orchestrates subagents (Claude, Cursor, Codex, Gemini) through MCP (Model Context Protocol) servers. It provides a modern TypeScript implementation with React INK TUI, comprehensive testing infrastructure, and automated feedback collection.

## Installation

This package is available on NPM under multiple names for flexibility:

```bash
# Primary package (recommended)
npm install -g juno-code
```

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- Python 3.8+ (for dependency scripts)
- Git for version control
- NPM or UV package manager

### Quick Start

```bash
# Initialize a new project
juno-code init --task "Your task" --subagent claude --git-url "https://github.com/user/repo"

# Start task execution
juno-code start

# Or use the juno-code command for all operations
juno-code --help

# Collect feedback during execution
juno-collect-feedback
```

### Available Commands

The package installs these binary commands:

- `juno-code` - Main command (recommended)
- `juno-collect-feedback` - Feedback collection utility

## Project Structure

```
.
├── .juno_task/
│   ├── prompt.md          # Production-ready AI instructions
│   ├── init.md            # Task breakdown and constraints
│   ├── plan.md            # Dynamic planning and tracking
│   ├── USER_FEEDBACK.md   # User feedback and issue tracking
│   └── specs/             # Comprehensive specifications
│       ├── README.md      # Specs overview and guide
│       ├── requirements.md # Detailed functional requirements
│       └── architecture.md # System architecture and design
├── CLAUDE.md              # Session documentation and learnings
├── AGENTS.md              # AI agent selection and performance tracking
└── README.md              # This file
```

## AI-Powered Development

This project implements a sophisticated AI development workflow:

1. **Task Analysis**: AI studies existing codebase and requirements
2. **Specification Creation**: Detailed specs with parallel subagents
3. **Implementation**: AI-assisted development (up to 500 parallel agents)
4. **Testing**: Automated testing with dedicated subagents
5. **Documentation**: Continuous documentation updates
6. **Version Control**: Automated Git workflow with smart commits

## Key Features

- **Production-Ready Templates**: Comprehensive templates for AI guidance
- **Parallel Processing**: Up to 500 parallel subagents for analysis
- **Automated Workflows**: Git integration, tagging, and documentation
- **Quality Enforcement**: Strict requirements against placeholder implementations
- **User Feedback Integration**: Continuous feedback loop via USER_FEEDBACK.md
- **Session Management**: Detailed tracking of development sessions

## Configuration

The project uses `claude` as the primary AI subagent with these settings:
- **Parallel Agents**: Up to 500 for analysis, 1 for build/test
- **Quality Standards**: Full implementations required
- **Documentation**: Comprehensive and up-to-date
- **Version Control**: Automated Git workflow



## Development Workflow

1. **Review Task**: Check `.juno_task/init.md` for main task
2. **Check Plan**: Review `.juno_task/plan.md` for current priorities
3. **Provide Feedback**: Use `juno-code feedback` for issues or suggestions
4. **Track Progress**: Monitor AI development through `.juno_task/prompt.md`

---

Created with juno-code on 2025-10-08
using claude as primary AI subagent
