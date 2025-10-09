# test_init_real

test mcp.json creation

## Overview

This project uses juno-task for AI-powered development with claude as the primary AI subagent.

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- juno-task CLI installed
- Git for version control

### Quick Start

```bash
# Start task execution with production-ready AI instructions
juno-task start

# Or use main command with preferred subagent
juno-task -s claude

# Provide feedback on the development process
juno-task feedback
```

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
3. **Provide Feedback**: Use `juno-task feedback` for issues or suggestions
4. **Track Progress**: Monitor AI development through `.juno_task/prompt.md`

---

Created with juno-task on 2025-10-09
using claude as primary AI subagent
