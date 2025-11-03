## Open Issues
<!-- Current status: 4 OPEN ISSUES -->
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

<ISSUE>
      File .juno_task/USER_FEEDBACK.md is becoming big, you need to compact it and keep it lean.
      <DATE>2025-10-28</DATE>
   </ISSUE>

   <ISSUE>
      File .juno_task/USER_FEEDBACK.md is becoming big (      39 lines), you need to compact it and keep it lean.
      <DATE>2025-10-28</DATE>
   </ISSUE>
</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

<RESOLVED_ISSUE>
   **Log Cleanup Script Implementation**
   **Status**: ✅ RESOLVED
   **Date**: 2025-11-03
   **RESOLVED_DATE**: 2025-11-03

   **USER_FEEDBACK_QUOTE**: "Need a script to clean up old log files in .juno_task/logs/ directory to manage disk space. The script should archive log files older than 3 days and remove them to free up space."

   **ROOT_CAUSE**: User needed automated log file management to prevent disk space issues from accumulating log files in the .juno_task/logs/ directory.

   **SOLUTION_IMPLEMENTED**:
   1. Created template script directory: src/templates/scripts/
   2. Created clean_logs_folder.sh script with comprehensive log archival logic:
      - Finds log files older than 3 days in .juno_task/logs/*.logs
      - Archives them to .juno_task/logs/archive.zip (creates or appends)
      - Removes archived files to free up space
      - Includes colored console output, error handling, and verification
   3. Updated init command (src/cli/commands/init.ts) to copy scripts from templates to .juno_task/scripts/ during initialization
   4. Implemented automatic execution permission setting (chmod 755) for .sh files
   5. Added build step to copy template scripts to dist/templates/scripts/
   6. Updated project structure documentation in README and CLAUDE.md templates
   7. Framework supports future script additions - just add to src/templates/scripts/

   **TEST_CRITERIA_MET**:
   - ✅ Script created at src/templates/scripts/clean_logs_folder.sh
   - ✅ Script archives log files older than 3 days
   - ✅ Script appends to existing archive.zip (tested with multiple runs)
   - ✅ Script installed to .juno_task/scripts/ during init command
   - ✅ Executable permissions automatically set (755)
   - ✅ Script has comprehensive error handling and colored output
   - ✅ Build successful with template copying
   - ✅ Binary execution tests passing (4 passed, 1 skipped)
   - ✅ Framework ready for future script additions
   - ✅ Project structure documentation updated

   **Files Modified/Created**:
   - Created: juno-task-ts/src/templates/scripts/clean_logs_folder.sh (log archival script)
   - Modified: juno-task-ts/src/cli/commands/init.ts (added copyScriptsFromTemplates method)
   - Modified: juno-task-ts/package.json (added build:copy-templates script)
</RESOLVED_ISSUE>

<!-- Older resolved issues have been archived to preserve space -->
<!-- Check .juno_task/archives/ for historical resolved issues -->
