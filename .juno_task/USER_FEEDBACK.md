## Open Issues
<OPEN_ISSUES>
   <!-- Documentation integrity issues resolved - actual technical issues addressed -->
   <ISSUE>
   Running the main agent , have some duplicated entries on the screen. (The first entries before the actual MCP Start running)

   You have previously solve the issue for start command

   Format of response for verbose mode should be similar to verbose mode

   <TEST_CRITERIA>
   **Correct OUTPUT FORAMAT SIMILAR to start command
   - `timeout 300 node dist/bin/cli.mjs start --mcp-timeout 300000 -s cursor -m auto -v` shows no console pollution
   - `timeout 300 node dist/bin/cli.mjs start --mcp-timeout 300000 -s cursor -m auto` shows clean output
   - Progress callback results remain visible in proper format

   --- 
   Now you need to correct
   - `timeout 300 node dist/bin/cli.mjs --mcp-timeout 300000 -s cursor -m auto -v` shows no console pollution
   - `timeout 300 node dist/bin/cli.mjs --mcp-timeout 300000 -s cursor -m auto` shows clean output
   - Progress callback results remain visible in proper format

   </TEST_CRITERIA>
   </ISSUE>

   <ISSUE>
      Interactive Feedback Command TUI Mode
      Interactive feedback command, should have the same functionality as the headless mode of feedback command
      and it should provide a multiline input for the Issue, and also multiline Optional input for the test criteria

      <Test_CRITERIA>
         Read @.juno_task/specs/TEST_EXECUTABLE.md
         You need to similar to init ui, run a TUI test. with graceful exit.
         and analyze the response of the feedback command based on the user feedback file.
         Similar to init test, use a test project in tmp folder.
         INIT Command is getting tested using
         ``` - TUI: npm --prefix juno-task-ts run test:tui
         - Binary: npm --prefix juno-task-ts run test:binary```

         You need to create and executre and test feedback by creating similar tests
         and name it test:feedback
         Use preserve tmp and check the files afterward. to make sure command perfrom the job correctly.




      </Test_CRITERIA>
   </ISSUE>



   <ISSUE>
      Test issue from USER_FEEDBACK.md validation
      <Test_CRITERIA>This should appear correctly in feedback file</Test_CRITERIA>
      <DATE>2025-10-11</DATE>
   </ISSUE>
</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

**⚠️ VALIDATION REQUIREMENT**: Issues only appear here after:
1. Real user workflow testing with actual CLI binary execution
2. USER_FEEDBACK.md explicitly updated to reflect resolution
3. Issue moved from OPEN_ISSUES to RESOLVED_ISSUE section with timestamp
4. Actual evidence of working functionality provided

<RESOLVED_ISSUE>
   **Duplicate TUI Logging Messages** - RESOLVED 2025-10-10

   **Issue**: Progress messages were appearing twice in verbose mode, creating confusing output:
   ```
   [2:32:01 AM] 🔧  Starting tool: cursor_subagent with args: {...}
   [2:32:01 AM] 🔧  Starting tool: cursor_subagent with args: {...}  (DUPLICATE)
   [2:32:01 AM] ℹ️  Connecting to subagent for: cursor_subagent
   [2:32:01 AM] ℹ️  Connecting to subagent for: cursor_subagent  (DUPLICATE)
   ```

   **Root Cause**: Two progress event handlers were calling the same progress display:
   1. MCP client progress callback
   2. Engine progress callback

   **Fix**: Removed duplicate progress callback in MCP client options, allowing engine to handle all progress events.

   **Test Result**: Commands now show single progress messages:
   ```
   [2:37:13 AM] 🔧  Starting tool: cursor_subagent with args: {...}
   [2:37:13 AM] ℹ️  Connecting to subagent for: cursor_subagent
   [2:37:14 AM] 🤔  Executing: cursor_subagent
   ```

   **Validation**: Test command `timeout 20 node dist/bin/cli.mjs start --mcp-timeout 6000 -s cursor -m auto -v` now shows clean output without duplicates.
</RESOLVED_ISSUE>

<RESOLVED_ISSUE>
   **MCP Server Log Pollution** - RESOLVED 2025-10-10

   **Issue**: MCP server debug logs were appearing on screen instead of being redirected to log files:
   ```
   [MCP] Progress event: {
     progress: 1,
     message: 'Cursor #1: system => 🔧 Cursor Agent initialized (Model: Auto)'
   }
   ```

   **Root Cause**: MCP client was logging progress events to console in debug mode via `console.log("[MCP] Progress event:", progress)`.

   **Fix**:
   1. Removed console.log statement from MCP client progress callback
   2. Ensured progress events are still logged to `.juno_task/logs/subagent_loop_mcp_*.log` files
   3. Maintained proper file-based logging infrastructure

   **Test Result**:
   - Verbose mode now shows clean progress output without MCP debug messages
   - Non-verbose mode shows simple progress indicators
   - MCP progress events are properly routed to log files

   **Validation**: Both test criteria now pass:
   - `timeout 300 node dist/bin/cli.mjs start --mcp-timeout 300000 -s cursor -m auto -v` shows no console pollution
   - `timeout 300 node dist/bin/cli.mjs start --mcp-timeout 300000 -s cursor -m auto` shows clean output
   - Progress callback results remain visible in proper format
</RESOLVED_ISSUE>