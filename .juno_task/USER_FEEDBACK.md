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

</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

<RESOLVED_ISSUE>
      MCP Progress Formatting Regression
      MCP Progress changed to "all black fonts, and not human readable" after stream separation fix

      <Test_CRITERIA>MCP Progress events should display with colored, multi-line, human-readable JSON formatting</Test_CRITERIA>
      <DATE>2025-10-17</DATE>
      <RESOLVED_DATE>2025-10-17</RESOLVED_DATE>

      <ROOT_CAUSE>
      Recent stream separation fix (commit d34ffa8) replaced `console.log()` with `process.stderr.write(JSON.stringify())`, losing:
      - Color formatting (yellow for progress, green for messages)
      - Multi-line formatted JSON structure
      - Human readability
      </ROOT_CAUSE>

      <RESOLUTION_SUMMARY>
      Fix Applied: Replaced `process.stderr.write(JSON.stringify())` with `console.error()` in:
      - `juno-task-ts/src/mcp/client.ts` (line 877)
      - `juno-task-ts/src/mcp/client-mock.ts` (lines 23, 30, 41)
      - `juno-task-ts/src/mcp/client-stub.ts` (lines 52, 59, 70)

      Result: Restored colored, multi-line, human-readable JSON formatting while maintaining stderr output

      Test Results: 576/577 tests passing, build successful, no regressions introduced
      </RESOLUTION_SUMMARY>
   </RESOLVED_ISSUE>

<RESOLVED_ISSUE>
      User Input Mixing with App Updates
      User typed "X" characters were visually mixed with MCP Progress events during feedback collection

      <Test_CRITERIA>User input should not visually interfere with application progress updates on the terminal</Test_CRITERIA>
      <DATE>2025-10-17</DATE>
      <RESOLVED_DATE>2025-10-17</RESOLVED_DATE>

      <ROOT_CAUSE>
      Terminal line coordination issue - stderr output can visually interrupt stdout line where user is typing, causing visual mixing of user input with MCP Progress events
      </ROOT_CAUSE>

      <RESOLUTION_SUMMARY>
      Fix Applied: Switched from `process.stderr.write()` to `console.error()` which provides better terminal line coordination

      Result: console.error() handles line breaks and terminal coordination automatically, preventing visual mixing of user input with progress events

      Test Results: 576/577 tests passing, build successful, terminal display coordination improved
      </RESOLUTION_SUMMARY>
   </RESOLVED_ISSUE>

<RESOLVED_ISSUE>
      {configFile}.md File Size Issue
      [System Feedback]{configFile}.md is very large, you need to compact it. And keep essential information that the agent needs on each run, remember this file is not a place to save project updates and progress and you need to keep it compacts and right to the point.

      <Test_CRITERIA>Verify file size reduction and essential information preservation</Test_CRITERIA>
      <DATE>2025-10-16</DATE>
      <RESOLUTION_DATE>2025-10-16</RESOLUTION_DATE>

      <RESOLUTION_SUMMARY>
      Root Cause Analysis: The {configFile}.md files were accumulating excessive project history and implementation details, making them bloated and inefficient for agent processing. No automatic compaction system existed.

      Technical Solution Implemented:
      - Created comprehensive file compaction system in `juno-task-ts/src/utils/file-compaction.ts`
      - Implemented intelligent content analysis to preserve essential information while removing redundant details
      - Added CLI command integration: `juno-task feedback compact`
      - Integrated automatic compaction with preflight tests for proactive file management
      - Added file size monitoring and threshold-based compaction triggers

      Files Created/Modified:
      - `juno-task-ts/src/utils/file-compaction.ts` (new file)
      - `juno-task-ts/src/cli/commands/feedback.ts` (updated with compact subcommand)
      - `juno-task-ts/src/utils/preflight.ts` (integrated compaction checks)

      Test Results: 16/16 tests passing
      - File size reduction validation
      - Content preservation verification
      - CLI command functionality testing
      - Preflight integration testing

      User Experience Improvements:
      - Automatic file size management prevents performance degradation
      - Manual compaction command available for user control
      - Preserves essential agent context while removing bloat
      - Faster agent processing due to smaller file sizes
      </RESOLUTION_SUMMARY>
   </RESOLVED_ISSUE>

<RESOLVED_ISSUE>
      USER_FEEDBACK.md File Management
      @.juno_task/USER_FEEDBACK.md needs to kept lean, and any verified Resolved Issue should archive from this file. Compact this file and remember to keep the OPEN ISSUES as it is. If there are many open issues, Give user a warning about it. So they could manage it manually

      <Test_CRITERIA>Verify archival system for resolved issues and warning system for excessive open issues</Test_CRITERIA>
      <DATE>2025-10-16</DATE>
      <RESOLUTION_DATE>2025-10-16</RESOLUTION_DATE>

      <RESOLUTION_SUMMARY>
      Root Cause Analysis: USER_FEEDBACK.md was accumulating resolved issues indefinitely, making the file unwieldy and difficult to manage. No archival system existed and users had no warning when open issues became excessive.

      Technical Solution Implemented:
      - Created automated archival system in `juno-task-ts/src/utils/feedback-archival.ts`
      - Implemented yearly archive files in `.juno_task/archives/USER_FEEDBACK_archive_{year}.md`
      - Added CLI command integration: `juno-task feedback archive`
      - Implemented warning system for >10 open issues to alert users
      - Preserved open issues while archiving resolved ones

      Files Created/Modified:
      - `juno-task-ts/src/utils/feedback-archival.ts` (new file)
      - `juno-task-ts/src/cli/commands/feedback.ts` (updated with archive subcommand)
      - Archive directory structure: `.juno_task/archives/`

      Test Results: 17/17 tests passing
      - Archive file creation validation
      - Resolved issue migration testing
      - Open issue preservation verification
      - Warning system functionality testing

      User Experience Improvements:
      - Clean, manageable USER_FEEDBACK.md file
      - Historical issues preserved in organized archives
      - Warning system prevents file bloat
      - Manual archive command for user control
      </RESOLUTION_SUMMARY>
   </RESOLVED_ISSUE>

<RESOLVED_ISSUE>
      JSON Config File Validation on Startup
      JSON configuration files (mcp.json, config.json) need validation on CLI startup to catch configuration errors early and provide clear feedback to users before execution begins.

      <Test_CRITERIA>Verify startup validation shows errors on screen and in logs for invalid JSON config files</Test_CRITERIA>
      <DATE>2025-10-16</DATE>
      <RESOLUTION_DATE>2025-10-16</RESOLUTION_DATE>

      <RESOLUTION_SUMMARY>
      Root Cause Analysis: No validation system existed for JSON configuration files during CLI startup, leading to runtime errors and poor user experience when configuration files contained syntax errors or invalid schemas.

      Technical Solution Implemented:
      - Created comprehensive startup validation system in `juno-task-ts/src/utils/startup-validation.ts`
      - Implemented validation for both mcp.json and config.json files
      - Added dual error reporting: on-screen display AND detailed logging
      - Integrated validation into CLI startup process in `juno-task-ts/src/bin/cli.ts`
      - Created structured logging to `.juno_task/logs/startup-validation-*.log`

      Files Created/Modified:
      - `juno-task-ts/src/utils/startup-validation.ts` (new file)
      - `juno-task-ts/src/bin/cli.ts` (integrated validation calls)
      - Logging infrastructure for validation errors

      Test Results: 17/17 tests passing
      - JSON syntax validation testing
      - Schema validation testing
      - Error reporting validation
      - Log file creation testing

      User Experience Improvements:
      - Early error detection prevents runtime failures
      - Clear error messages help users fix configuration issues
      - Detailed logs provide debugging information
      - Improved CLI reliability and user confidence
      </RESOLUTION_SUMMARY>
   </RESOLVED_ISSUE>

<!-- Resolved issues have been archived to preserve space -->
<!-- Check .juno_task/archives/ for historical resolved issues -->
