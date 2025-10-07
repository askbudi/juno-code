# MCP Client Test Project

## Purpose

This is a minimal TypeScript MCP client test project designed to isolate and debug the connection issues described in USER_FEEDBACK.md.

**Problem:** The MCP client connection exits every few milliseconds and isn't working properly.

## Focus Areas

- ✅ Basic connection establishment
- ✅ Connection persistence (don't exit immediately)
- ✅ Proper error handling and debug logging
- ✅ Testing the connection stays alive for at least 30 seconds

## Project Structure

```
mcp-client-test/
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── index.ts              # Main test implementation
└── README.md             # This file
```

## Dependencies

- `@modelcontextprotocol/sdk` - Official MCP TypeScript SDK
- `dotenv` - Environment variable management
- `typescript` - TypeScript compiler
- `@types/node` - Node.js types

## Usage

### Install Dependencies

```bash
cd juno-task-ts/mcp-client-test
npm install
```

### Build and Run

```bash
# Build TypeScript
npm run build

# Run the test (uses default test server path)
npm run start

# Or run with custom server path
npm run start path/to/your/mcp/server.py
```

### Development

```bash
# Build and run in one step
npm run dev

# Or with custom server
npm run dev path/to/server.py
```

## Test Server

The test uses the roundtable MCP test server located at:
`../../../roundtable_mcp_server/roundtable_mcp_server/test_server.py`

## What It Tests

1. **Connection Establishment**: Creates MCP client and connects to server
2. **Basic Operations**: Lists available tools and attempts tool calls
3. **Connection Persistence**: Keeps connection alive for 30+ seconds with health checks
4. **Error Handling**: Comprehensive logging and graceful error handling
5. **Cleanup**: Proper disconnection and resource cleanup

## Expected Output

```
[INFO] 🚀 Starting MCP Client Test Project
[INFO] Using MCP server: /path/to/test_server.py
[INFO] Creating StdioClientTransport...
[INFO] 🎉 Connection established successfully in XXXms!
[INFO] Testing basic operations...
[INFO] ✅ Found N tools:
[INFO]   - tool_name: description
[DEBUG] ⏰ Connection alive for X seconds
[INFO] 🎉 Connection persistence test completed!
[INFO] 🎉 All tests completed successfully!
```

## Debugging Features

- Detailed timestamped logging
- Connection health checks every 5 seconds
- Error stack traces in debug mode
- Graceful shutdown handling
- Connection uptime tracking

## Exit Codes

- `0`: All tests passed successfully
- `1`: Tests failed or error occurred

## Environment Variables

Set `DEBUG=false` in the code to reduce verbose logging.

## Integration with Main Implementation

Once this test project identifies and resolves connection issues, the findings will be used to debug and fix the main MCP client implementation in `../src/mcp/client.ts`.