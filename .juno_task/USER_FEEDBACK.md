## Open Issues
<!-- Current status: 0 OPEN ISSUES -->
<OPEN_ISSUES>

</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

<!-- Older resolved issues have been archived to preserve space -->
<!-- Check .juno_task/archives/ for historical resolved issues -->

**10. Shell Backend Verbose JSON Output Format - jq-Style Formatting** (Date: 2025-11-11, Resolved: 2025-11-11)

**Issue:**
Shell backend verbose mode was showing pipe-separated format instead of human-readable JSON format with colors and indentation like `claude.py | jq .` output.

**User Report:**
```
Now -b shell shows progress in this format:
6:37:37 PM [shell] thinking: type=assistant | message_id=msg_01W5v2PyYWCjSXdmhY4Mjksx | model=claude-sonnet-4-20250514 | tokens=3/1

It is not a correct format
I want to see progress in human readable json format.
I want to see the progress similar to doing this: claude.py {args...} | jq .

juno-code -b shell -v
should have the same output format as mcp backend of juno-code, when json streaming response is getting printed on screen with the right colors and indention and it is human readable.
```

<PREVIOUS_AGENT_ATTEMPT>
**INCOMPLETE RESOLUTION (2025-11-11):**
Previous agent implemented MCP-style pipe-separated formatting (type=X | subtype=Y | ...), but user wanted jq-style JSON output with proper indentation and colors, not pipe-separated text. The user specifically requested the same format as `claude.py | jq .` output.
</PREVIOUS_AGENT_ATTEMPT>

**Root Cause:**
Shell backend was formatting events into pipe-separated text format instead of preserving and colorizing the raw JSON output with proper indentation.

**Solution Implemented:**
1. Updated shell-backend.ts convertClaudeEventToProgress() to pass raw JSON line when outputRawJson=true
2. Changed metadata flag from mcpStyleFormat to rawJsonOutput to indicate jq-style formatting needed
3. Created colorizeJson() helper method in all progress display classes (ProgressDisplay, MainProgressDisplay, TestProgressDisplay)
4. Implemented JSON syntax highlighting with colors: blue for keys, green for strings, yellow for numbers, magenta for booleans
5. Added proper JSON formatting with 2-space indentation using JSON.stringify(obj, null, 2)
6. Maintained timestamp and backend prefix format: `[timestamp] [backend] {formatted_json}`

**Test Criteria:**
✅ Shell backend outputs raw JSON with proper indentation
✅ JSON is colorized with syntax highlighting (keys, strings, numbers, booleans)
✅ Format matches `claude.py | jq .` style output
✅ Timestamp and backend prefix are preserved
✅ Real-time streaming maintains JSON format integrity
✅ Build succeeds without errors

**Test Results:**
✅ Build: Successful compilation
✅ Real CLI Test: `./dist/bin/cli.mjs -s claude -m sonnet-4.5 -i 1 -b shell -v -p "echo hello world"` works perfectly
✅ JSON Format: Output shows properly formatted JSON with 2-space indentation:
    ```
    6:51:00 PM [shell] {
      "type": "assistant",
      "message": {
        "model": "claude-sonnet-4-5-20250929",
        ...
      }
    }
    ```
✅ Colors: JSON keys in blue, strings in green, numbers in yellow, booleans in magenta
✅ Human Readable: Format is clean, indented, and easy to read (matches jq style)
✅ Streaming: Each JSON event appears in real-time with proper formatting
✅ Backend Prefix: Timestamp and [shell] prefix maintained for context

**Files Modified:**
- juno-task-ts/src/core/backends/shell-backend.ts (updated convertClaudeEventToProgress to pass raw JSON, changed metadata flag)
- juno-task-ts/src/cli/commands/start.ts (added colorizeJson method, updated displayVerboseProgress to handle rawJsonOutput)
- juno-task-ts/src/cli/commands/main.ts (added colorizeJson method, updated onProgress to handle rawJsonOutput)
- juno-task-ts/src/cli/commands/test.ts (added colorizeJson method, updated onProgress to handle rawJsonOutput)

**Status:** ✅ RESOLVED - Shell backend now outputs jq-style formatted JSON with colors and proper indentation

**11. Shell Backend Pretty JSON Output Format Enhancement** (Date: 2025-11-11, Resolved: 2025-11-12)

**Issue:**
User wanted ability to customize JSON output from claude.py script with a --pretty flag that defaults to True, allowing selective display of fields and hiding verbose information like usage and stop_reason.

**Root Cause:**
User wanted ability to customize JSON output from claude.py script with a --pretty flag that defaults to True, allowing selective display of fields and hiding verbose information like usage and stop_reason.

**Solution Implemented:**
1. Added `--pretty` flag to claude.py with default value "true" (accepts "true"/"false")
2. Added ENV variable support (CLAUDE_PRETTY) for controlling pretty output without CLI arg
3. Implemented `pretty_format_json()` method that:
   - For "type=assistant" messages: shows only datetime, content, and counter
   - For other message types: shows full message with datetime and counter prepended
   - Adds message counter (#1, #2, #3...) to track streaming messages
4. Pretty formatting is applied during streaming output, maintaining real-time display
5. When --pretty=false: outputs raw streaming JSON (original behavior)
6. When --pretty=true (default): outputs formatted JSON with selected fields

**Test Criteria:**
✅ --pretty flag added with default=true
✅ --pretty true shows formatted output (datetime, content for assistant, full message for others)
✅ --pretty false shows raw JSON output
✅ ENV variable CLAUDE_PRETTY=true/false works correctly
✅ Message counter (#1, #2, #3) increments correctly
✅ jq piping works with pretty output
✅ Build succeeds without errors
✅ Streaming output maintains real-time display

**Test Results:**
✅ Help Text: `claude.py --help` shows `--pretty {true,false}` option with ENV var note
✅ Pretty True: `python3 claude.py -p "say hello" --pretty true` outputs formatted JSON with datetime and counter
✅ Pretty False: `python3 claude.py -p "say hi" --pretty false` outputs raw JSON (original format)
✅ ENV Variable: `env CLAUDE_PRETTY=false python3 claude.py -p "test"` respects ENV setting
✅ Assistant Messages: Simplified to show only {"datetime": "...", "content": "...", "counter": "#N"}
✅ Other Messages: Full message with {"datetime": "...", "counter": "#N", ...original fields}
✅ jq Piping: `python3 claude.py -p "test" --pretty true | jq -c '.counter'` extracts fields correctly
✅ Message Counter: Increments correctly (#1, #2, #3) across all message types
✅ Build: Successfully compiled and copied to dist/templates/services/

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py (added --pretty flag, CLAUDE_PRETTY ENV support, pretty_format_json method, message counter)

**Status:** ✅ RESOLVED - Pretty JSON output formatting implemented with --pretty flag and ENV variable support
