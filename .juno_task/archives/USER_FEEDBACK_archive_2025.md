# User Feedback Archive 2025

This file contains resolved issues that have been archived from USER_FEEDBACK.md to keep the main file lean.

## Archive Index

- Total archived issues: 1
- Last updated: 2025-10-16

---


<RESOLVED_ISSUE>
   **Duplicate Progress Callback Messages in Main Command** - RESOLVED 2025-10-14

   **Issue**: Progress messages were appearing twice in verbose mode for main command execution, creating confusing output. The first few lines before MCP start were duplicated on screen.

   **Example of duplication (before fix)**:
   ```
   [4:04:45 PM] tool_start: Starting cursor_subagent with arguments: {...}
   [4:04:45 PM] tool_start: Starting cursor_subagent with arguments: {...}  // DUPLICATE
   [4:04:46 PM] info: Connecting to MCP server for cursor_subagent
   [4:04:46 PM] info: Connecting to MCP server for cursor_subagent  // DUPLICATE
   [4:04:46 PM] thinking: Executing cursor_subagent on subagent
   [4:04:46 PM] thinking: Executing cursor_subagent on subagent  // DUPLICATE
   ```

   **Root Cause**: Both MCP client progressCallback and engine onProgress handlers were forwarding the same progress events to MainProgressDisplay, creating duplicate output.

   **Fix Applied**: Removed duplicate engine progress handler in src/cli/commands/main.ts, keeping only MCP client progressCallback for progress event routing.

   **Test Criteria**:
   - Command: `timeout 30 node dist/bin/cli.mjs -s cursor -m auto -v`
   - Expected: No console pollution, clean output, progress callback results visible
   - Result: ✅ PASSED - Each progress message now appears exactly once

</RESOLVED_ISSUE>
<!-- Archived on 2025-10-16 -->

