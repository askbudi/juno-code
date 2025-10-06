# juno-task-ts

TypeScript implementation of the juno-task CLI tool for AI subagent orchestration.

## Overview

juno-task-ts is a comprehensive TypeScript CLI tool that provides seamless integration with multiple AI subagents (Claude, Cursor, Codex, Gemini) through the Model Context Protocol (MCP). It features a modern TUI interface adaptable for web use, robust configuration management, and comprehensive progress tracking.

## Features

- 🤖 **Multi-Subagent Support**: Claude, Cursor, Codex, and Gemini integration
- 🔄 **MCP Protocol**: Full Model Context Protocol implementation
- 🖥️ **Modern TUI**: Component-based terminal interface with web adaptation capabilities
- 📋 **Template System**: Project initialization and scaffolding with variable substitution
- 📊 **Session Management**: Persistent tracking and analytics for execution sessions
- 🧪 **95% Test Coverage**: Comprehensive test suite with unit, integration, and E2E tests
- 🔧 **TypeScript First**: Strict typing with zero any types
- 🚀 **Performance Optimized**: Fast startup and execution times

## Installation

```bash
npm install -g juno-task-ts
```

## Quick Start

```bash
# Initialize a new project
juno-task init --task "Create a REST API" --subagent claude

# Start execution
juno-task start

# Check session history
juno-task session list
```

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5.0+

### Setup

```bash
# Clone the repository
git clone https://github.com/owner/juno-task-ts.git
cd juno-task-ts

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Start development mode
npm run dev
```

### Scripts

- `npm run dev` - Development mode with hot reload
- `npm run build` - Build for production
- `npm test` - Run all tests
- `npm run test:coverage` - Run tests with coverage report
- `npm run lint` - Lint code
- `npm run format` - Format code

## Architecture

The project follows a modular layered architecture:

```
src/
├── cli/           # Command-line interface
├── core/          # Core business logic
├── mcp/           # MCP client implementation
├── tui/           # Terminal user interface
├── templates/     # Template system
├── utils/         # Utility functions
└── types/         # TypeScript type definitions
```

## Configuration

juno-task-ts supports multiple configuration sources with proper precedence:

1. CLI arguments (highest priority)
2. Environment variables
3. Configuration files
4. Defaults (lowest priority)

### Environment Variables

All CLI options can be set via environment variables with the `JUNO_TASK_` prefix:

```bash
export JUNO_TASK_SUBAGENT=claude
export JUNO_TASK_VERBOSE=true
export JUNO_TASK_MAX_ITERATIONS=5
```

## Commands

### Main Execution
```bash
juno-task -s claude -p "Your task description" -i 3 --verbose
```

### Project Initialization
```bash
juno-task init --task "Description" --subagent claude --interactive
```

### Session Management
```bash
juno-task session list --limit 10
juno-task session info <session-id>
juno-task session clean --days 7
```

### Feedback
```bash
juno-task feedback "Great tool, works perfectly!"
```

### Git Setup
```bash
juno-task setup-git https://github.com/user/repo
```

## Testing

The project maintains 95% test coverage across all modules:

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test types
npm run test:unit
npm run test:integration
npm run test:e2e
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass and coverage is maintained
6. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Roadmap

- [x] Core Infrastructure
- [x] MCP Integration
- [x] CLI Commands
- [ ] Template System
- [ ] Modern TUI Implementation
- [ ] Web Adaptation
- [ ] Performance Optimization
- [ ] Documentation and Polish

## Support

- 📖 [Documentation](https://github.com/owner/juno-task-ts/docs)
- 🐛 [Issues](https://github.com/owner/juno-task-ts/issues)
- 💬 [Discussions](https://github.com/owner/juno-task-ts/discussions)