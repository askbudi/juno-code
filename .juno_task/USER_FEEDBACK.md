## Open Issues
<OPEN_ISSUES>

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
      When running juno-ts-task with -v
      there is no sign of running preflights. (either that it is ok and there is no condition is matching or a condition is matching and then a report on the taken step.)
      <Test_CRITERIA>Run juno-task-ts with -v flag and verify preflight test execution is visible in output</Test_CRITERIA>
      <DATE>2025-10-14</DATE>
   </ISSUE>


   <ISSUE>
      [System Feedback]{configFile}.md is very large, you need to compact it. And keep essential information that the agent needs on each run, remember this file is not a place to save project updates and progress and you need to keep it compacts and right to the point.
      <DATE>2025-10-14</DATE>
   </ISSUE>

   <ISSUE>
      @.juno_task/USER_FEEDBACK.md needs to kept lean, and any verified Resolved Issue should archive from this file. Compact this file and remember to keep the OPEN ISSUES as it is. If there are many open issues, Give user a warning about it. So they could manage it manually
      <DATE>2025-10-14</DATE>
   </ISSUE>

   <ISSUE>
      [System Feedback]{configFile}.md is very large, you need to compact it. And keep essential information that the agent needs on each run, remember this file is not a place to save project updates and progress and you need to keep it compacts and right to the point.
      <DATE>2025-10-14</DATE>
   </ISSUE>

   <ISSUE>
      @.juno_task/USER_FEEDBACK.md needs to kept lean, and any verified Resolved Issue should archive from this file. Compact this file and remember to keep the OPEN ISSUES as it is. If there are many open issues, Give user a warning about it. So they could manage it manually
      <DATE>2025-10-14</DATE>
   </ISSUE>
</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

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

<RESOLVED_ISSUE>
   **Preflight Tests Implementation** - RESOLVED 2025-10-14

   **Issue**: Need to implement preflight tests that run on each subagent iteration to check file sizes and run automated feedback commands when files exceed thresholds.

   **Requirements from USER_FEEDBACK.md**:
   - Run preflight tests on each iteration
   - Check file line counts against threshold (default: 500)
   - Check config files (CLAUDE.md/AGENTS.md) and .juno_task/USER_FEEDBACK.md
   - Run automated feedback command when files exceed threshold
   - Support environment variable configuration (JUNO_PREFLIGHT_THRESHOLD, JUNO_PREFLIGHT_DISABLED)

   **Implementation Details**:
   - Created `src/utils/preflight.ts` with comprehensive preflight tests functionality
   - Integrated preflight tests into engine's `executeIteration` method (runs on first iteration only)
   - Added environment variable support for threshold and enable/disable configuration
   - Implemented automated feedback command execution with specific messages for each file type
   - Added progress event emission for preflight test results
   - Updated tsup.config.ts to include preflight utility in build
   - Updated CLI help documentation with environment variables

   **Key Files Modified/Created**:
   - `src/utils/preflight.ts` (NEW) - Core preflight tests implementation
   - `src/core/engine.ts` - Integration into execution flow
   - `tsup.config.ts` - Build configuration update
   - `src/bin/cli.ts` - Help documentation update

   **Test Criteria**:
   - Create file with >500 lines (test-large-file.md with 610 lines)
   - Run command: `JUNO_PREFLIGHT_THRESHOLD=500 node dist/bin/cli.mjs start -s claude -m "test" --max-iterations 1 --mcp-timeout 30000`
   - Expected: Preflight tests detect large files and run automated feedback command
   - Result: ✅ PASSED - Preflight tests successfully detected 606-line USER_FEEDBACK.md and executed feedback command

   **Environment Variables Supported**:
   - `JUNO_PREFLIGHT_THRESHOLD` - Line count threshold (default: 500)
   - `JUNO_PREFLIGHT_DISABLED` - Disable preflight tests (set to 'true' to disable)

   **Example Output**:
   ```
   🔍 Preflight tests triggered 1 action(s):
     📝 .juno_task/USER_FEEDBACK.md: 606 lines (threshold: 500)
   ```

   **Note**: Fixed fs-extra import pattern issue (`import * as fs` → `import fs`) for proper tsup bundling compatibility.


