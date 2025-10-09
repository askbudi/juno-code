# Claude Development Session Learnings

## Project Overview

This project was initialized on 2025-10-09 using juno-task.

**Main Task**: test task
**Preferred Subagent**: claude
**Project Root**: /Users/mahdiyar/Code/denmark_insightfactory/playground_juputer/projects/.vibe_trees/budi_cli_ts/juno-task-ts/test_mcp_timeout

## Development Environment

### Build System
- Use `npm run build` to build the project
- Test with `npm test` for unit tests
- Use `npm run test:binary` for CLI testing

### Key Commands
- `juno-task start` - Begin task execution
- `juno-task -s claude` - Quick execution with preferred subagent
- `juno-task feedback` - Provide feedback on the process

## Project Structure

```
.
├── .juno_task/
│   ├── prompt.md          # Main task definition with AI instructions
│   ├── init.md            # Initial task breakdown and constraints
│   ├── plan.md            # Dynamic planning and priority tracking
│   ├── USER_FEEDBACK.md   # User feedback and issue tracking
│   └── specs/             # Project specifications
│       ├── README.md      # Specs overview
│       ├── requirements.md # Functional requirements
│       └── architecture.md # System architecture
├── CLAUDE.md              # This file - session documentation
└── README.md              # Project overview
```

## AI Workflow

The project uses a sophisticated AI workflow with:

1. **Task Analysis**: Study existing codebase and requirements
2. **Specification Creation**: Detailed specs for each component
3. **Implementation**: AI-assisted development with parallel subagents
4. **Testing**: Automated testing and validation
5. **Documentation**: Continuous documentation updates
6. **Version Control**: Automated Git workflow management

## Important Notes

- Always check USER_FEEDBACK.md first for user input
- Keep plan.md up to date with current priorities
- Use up to 500 parallel subagents for analysis
- Use only 1 subagent for build/test operations
- Focus on full implementations, not placeholders
- Maintain comprehensive documentation

## Session Progress

This file will be updated as development progresses to track:
- Key decisions and their rationale
- Important learnings and discoveries
- Build/test optimization techniques
- Solutions to complex problems
- Performance improvements and optimizations
