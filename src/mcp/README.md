# MCP Types Module

This module provides comprehensive TypeScript type definitions for Model Context Protocol (MCP) integration in juno-task-ts.

## Overview

The MCP types module implements the exact progress callback patterns identified in the Python budi-cli implementation and provides full compatibility with the @modelcontextprotocol/sdk.

## Key Features

### 📋 **Complete Type Coverage**
- **MCP Server Configuration**: `MCPServerConfig` with server discovery and environment setup
- **Progress Tracking**: `ProgressEvent` and `ProgressCallback` types matching Roundtable format
- **Tool Execution**: `ToolCallRequest` and `ToolCallResult` with comprehensive metadata
- **Subagent Integration**: `SubagentInfo` and `SubagentMapper` for AI backend management
- **Connection Management**: Connection lifecycle and health monitoring types
- **Session Integration**: Session persistence and context tracking types
- **Error Handling**: Comprehensive error hierarchy with recovery strategies

### 🔧 **Type Safety Features**
- **Strict TypeScript compliance** with `exactOptionalPropertyTypes`
- **Readonly interfaces** for configuration immutability
- **Comprehensive enums** for state management
- **Type guards** for runtime type checking
- **Generic utility types** for flexible implementations

### 🎯 **Progress Callback System**
Supports the exact Roundtable MCP server format:
```
"Backend #count: event_type => content"
```

With complete event types:
- `tool_start` - Tool execution begins
- `tool_result` - Tool execution completes
- `thinking` - AI processing updates
- `error` - Error conditions
- `info` - General information

### 🔗 **Subagent Mapping**
Built-in support for all AI backends:
```typescript
const SUBAGENT_TOOL_MAPPING = {
  claude: 'claude_subagent',
  cursor: 'cursor_subagent',
  codex: 'codex_subagent',
  gemini: 'gemini_subagent'
};
```

With alias support:
```typescript
const SUBAGENT_ALIASES = {
  'claude-code': 'claude',
  'claude_code': 'claude',
  'gemini-cli': 'gemini',
  'cursor-agent': 'cursor'
};
```

### 🛡️ **Error Hierarchy**
Comprehensive error types for targeted handling:
- `MCPConnectionError` - Connection issues
- `MCPToolError` - Tool execution failures
- `MCPTimeoutError` - Timeout conditions
- `MCPRateLimitError` - Rate limiting with reset times
- `MCPValidationError` - Input validation failures

### ⚡ **Performance Types**
Built-in performance monitoring:
- Tool execution metrics
- Progress event processing stats
- Connection health tracking
- Resource usage monitoring

## Usage Examples

### Basic Configuration
```typescript
const config: MCPServerConfig = {
  timeout: 3600000, // 1 hour
  retries: 3,
  retryDelay: 1000,
  workingDirectory: process.cwd(),
  environment: {
    'ROUNDTABLE_API_KEY': 'your-key'
  }
};
```

### Progress Tracking
```typescript
const progressCallback: ProgressCallback = async (event: ProgressEvent) => {
  console.log(`${event.backend} #${event.count}: ${event.type} => ${event.content}`);
};
```

### Tool Execution
```typescript
const request: ToolCallRequest = {
  toolName: 'claude_subagent',
  arguments: {
    instruction: 'Analyze this code',
    project_path: '/path/to/project',
    model: 'sonnet-4'
  },
  progressCallback
};
```

### Error Handling
```typescript
try {
  const result = await mcpClient.callTool(request);
} catch (error) {
  if (isMCPError(error)) {
    switch (error.type) {
      case MCPErrorType.RATE_LIMIT:
        console.log(`Rate limited. Reset: ${error.resetTime}`);
        break;
      case MCPErrorType.TIMEOUT:
        console.log(`Timeout after ${error.timeoutMs}ms`);
        break;
    }
  }
}
```

## Type Guards

The module includes comprehensive type guards for runtime type checking:

```typescript
// Check if object is a valid progress event
if (isProgressEvent(data)) {
  console.log(data.backend); // TypeScript knows this is ProgressEvent
}

// Check if error is MCP-specific
if (isMCPError(error)) {
  console.log(error.type); // Access MCP error properties
}

// Validate subagent names
if (isSubagentType(name)) {
  const toolName = SUBAGENT_TOOL_MAPPING[name]; // Type-safe access
}
```

## Constants

Pre-defined constants for common values:

```typescript
// Default configuration values
MCP_DEFAULTS.TIMEOUT        // 3600000ms (1 hour)
MCP_DEFAULTS.RETRIES        // 3 attempts
MCP_DEFAULTS.RETRY_DELAY    // 1000ms

// Progress parsing patterns
PROGRESS_PATTERNS.MAIN      // Main message format regex
PROGRESS_PATTERNS.TOOL_CALLS // Tool call detection patterns
PROGRESS_PATTERNS.RATE_LIMITS // Rate limit message patterns
```

## Integration

This types module is designed to work seamlessly with:

- **@modelcontextprotocol/sdk** - Official MCP SDK
- **juno-task-ts core** - Main application logic
- **TUI components** - Terminal interface integration
- **Session management** - Persistent state tracking
- **Error handling** - Comprehensive error boundaries

## Testing

The module includes comprehensive type tests in `__tests__/types.test.ts` covering:

- Type guard functionality
- Error class inheritance
- Constant value validation
- Type safety enforcement
- Enum correctness

## Implementation Status

### ✅ Completed Components

#### 1. **Error Handler** (`src/mcp/errors.ts`)
Comprehensive error handling system with:

- **Complete Error Hierarchy**: All error classes implemented with proper inheritance
- **Rate Limit Parsing**: Sophisticated parsing of rate limit reset times from various message formats
- **Error Context**: Full context tracking with metadata, retry information, and recovery suggestions
- **Static Factory Methods**: Convenient error creation for common scenarios
- **Type Guards**: Runtime type checking for all error types
- **Recovery Strategies**: Built-in recovery strategy recommendations
- **Comprehensive Testing**: Full test coverage in `__tests__/errors.test.ts`

**Key Features:**
```typescript
// Rate limit parsing from messages
const error = MCPRateLimitError.fromMessage("Rate limit exceeded. Resets at 3:30 PM");
const waitTime = error.getWaitTimeSeconds();

// Connection error with context
const connError = MCPConnectionError.serverNotFound('/missing/server');
console.log(connError.recoverySuggestions); // ['Check server installation path', ...]

// Error recovery strategies
const strategy = getRecoveryStrategy(error); // 'wait', 'retry', 'reconnect', etc.
```

**Integration:**
- Updated `types.ts` to import error classes from dedicated errors module
- Updated `client.ts` imports to use error classes from errors module
- Maintained full backward compatibility with existing code

### 🔄 Next Implementation Steps

1. **MCP Client Implementation** (`src/mcp/client.ts`) - *In Progress*
2. **Progress Parser** (`src/mcp/progress.ts`)
3. **Connection Manager** (`src/mcp/connection.ts`)
4. **Server Path Resolver** (`src/mcp/server-resolver.ts`)

All implementation uses the comprehensive types and error system to ensure type safety and maintainability.