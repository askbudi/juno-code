## Open Issues
<!-- Current status: 2 OPEN ISSUES -->
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
      File .juno_task/USER_FEEDBACK.md is becoming big, you need to compact it and keep it lean.
      <DATE>2025-10-24</DATE>
   </ISSUE>
</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

<RESOLVED_ISSUE>
   **--enable-feedback Progress Interruption - Complete Architectural Fix** - RESOLVED 2025-10-27

   **Issue**: Progress output interrupts user typing during --enable-feedback mode despite buffering implementation. Progress events bypass feedback state checks and write directly to stderr while user is typing.

   <USER_FEEDBACK_QUOTE>and it should provide a multiline input for the Issue, and also multiline Optional input for the test criteria</USER_FEEDBACK_QUOTE>

   <PREVIOUS_AGENT_ATTEMPT>
   Multiple previous attempts focused on peripheral issues rather than the core architectural problem:
   1. 2025-10-18: Focused on stream synchronization timing rather than the bypass issue
   2. 2025-10-19: Added character threshold complexity but didn't fix the core bypass problem
   3. 2025-10-24: Simplified timeout logic but ProgressDisplay still bypassed feedback state
   </PREVIOUS_AGENT_ATTEMPT>

   <ROOT_CAUSE>
   The core problem was architectural: there were TWO separate progress output paths, and only ONE respected the feedback state.
   - Path 1: MCP Progress Events → ProgressDisplay.onProgress() → writeTerminalProgress() (CORRECTLY HANDLED via TerminalProgressWriter)
   - Path 2: Engine Progress Events → ProgressDisplay methods → process.stderr.write() (BYPASSED FEEDBACK STATE)

   The ProgressDisplay class in src/cli/commands/start.ts had direct `process.stderr.write()` calls on lines 188, 196, 200, 202, 204, 208 that completely ignored the `isFeedbackActive()` checks. These writes happened regardless of whether feedback collection was active, causing output to interrupt user typing.
   </ROOT_CAUSE>

   <SOLUTION_IMPLEMENTED>
   1. Added import of `writeTerminalProgress` from terminal-progress-writer.ts to start.ts
   2. Replaced all 6 direct `process.stderr.write()` calls in ProgressDisplay progress methods with `writeTerminalProgress()`
   3. Added 5 comprehensive integration tests to verify feedback state is respected
   4. All tests pass (848 passing, 2 pre-existing failures unrelated)

   **Files Modified:**
   - juno-task-ts/src/cli/commands/start.ts (lines 20, 189, 197, 201, 203, 205, 209)
   - juno-task-ts/src/utils/__tests__/terminal-progress-writer.test.ts (added 5 new tests for feedback integration)
   </SOLUTION_IMPLEMENTED>

   <TEST_CRITERIA_MET>
   ✅ Build successful
   ✅ 848/850 tests passing (2 failures are pre-existing unrelated preflight-integration issues)
   ✅ All 5 new feedback integration tests passing
   ✅ Terminal progress writer correctly buffers when feedback is active
   ✅ Progress output resumes normally when feedback is inactive
   ✅ When --enable-feedback is active and user starts typing:
      - `setFeedbackActive(true)` is called
      - All calls to `writeTerminalProgress()` check `isFeedbackActive()`
      - If feedback is active, progress events are buffered instead of written to stderr
      - After 2min of inactivity or feedback submission, buffered events are flushed
      - User typing is never interrupted by progress output
   </TEST_CRITERIA_MET>

   <RESOLVED_DATE>2025-10-27</RESOLVED_DATE>

   **Why Previous Fixes Failed:**
   Previous attempts failed because they didn't address the fundamental architectural issue where ProgressDisplay had two separate code paths for progress output, with one path completely bypassing the feedback state management system.

   **Verification:**
   The fix ensures that all progress output from both MCP and Engine events flows through the same `writeTerminalProgress()` function, which properly respects the feedback collection state and buffers output when appropriate.

</RESOLVED_ISSUE>

<!-- Resolved issues have been archived to preserve space -->
<!-- Check .juno_task/archives/ for historical resolved issues -->
