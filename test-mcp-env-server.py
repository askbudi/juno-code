#!/usr/bin/env python3
"""
Test MCP server that exposes a tool to print all environment variables.
This server is used to verify that environment variables are correctly passed
from the juno-task-ts MCP client to the MCP server process.
"""

import os
import json
import sys
from typing import Any

# MCP protocol implementation
def read_message():
    """Read a JSON-RPC message from stdin."""
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)

def write_message(message: dict[str, Any]):
    """Write a JSON-RPC message to stdout."""
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

def send_error(request_id: Any, code: int, message: str):
    """Send an error response."""
    write_message({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": code,
            "message": message
        }
    })

def send_result(request_id: Any, result: Any):
    """Send a successful response."""
    write_message({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result
    })

def get_all_env_vars() -> dict[str, str]:
    """Get all environment variables as a dictionary."""
    return dict(os.environ)

def handle_initialize(request_id: Any, params: dict[str, Any]):
    """Handle the initialize request."""
    send_result(request_id, {
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "test-env-server",
            "version": "1.0.0"
        }
    })

def handle_tools_list(request_id: Any):
    """Handle the tools/list request."""
    send_result(request_id, {
        "tools": [
            {
                "name": "get_env_vars",
                "description": "Returns all environment variables available in the MCP server process",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        ]
    })

def handle_tools_call(request_id: Any, params: dict[str, Any]):
    """Handle the tools/call request."""
    tool_name = params.get("name")

    if tool_name != "get_env_vars":
        send_error(request_id, -32601, f"Unknown tool: {tool_name}")
        return

    # Get all environment variables
    env_vars = get_all_env_vars()

    # Return as formatted JSON string
    send_result(request_id, {
        "content": [
            {
                "type": "text",
                "text": json.dumps(env_vars, indent=2, sort_keys=True)
            }
        ]
    })

def main():
    """Main server loop."""
    # Debug: Write startup info to stderr
    sys.stderr.write("Test MCP Environment Server starting...\n")
    sys.stderr.flush()

    while True:
        try:
            message = read_message()
            if message is None:
                break

            method = message.get("method")
            request_id = message.get("id")
            params = message.get("params", {})

            if method == "initialize":
                handle_initialize(request_id, params)
            elif method == "initialized":
                # Notification, no response needed
                pass
            elif method == "tools/list":
                handle_tools_list(request_id)
            elif method == "tools/call":
                handle_tools_call(request_id, params)
            elif method == "ping":
                send_result(request_id, {})
            else:
                send_error(request_id, -32601, f"Unknown method: {method}")

        except Exception as e:
            sys.stderr.write(f"Error: {str(e)}\n")
            sys.stderr.flush()
            if 'request_id' in locals():
                send_error(request_id, -32603, str(e))

if __name__ == "__main__":
    main()
