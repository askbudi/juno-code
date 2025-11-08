## Open Issues
<!-- Current status: 0 OPEN ISSUES -->
<OPEN_ISSUES>

</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

<RESOLVED_ISSUE>
   **Juno-Code Branding Consistency Update (juno-task → juno-code)**
   **Status**: ✅ RESOLVED
   **Date**: 2025-11-08
   **RESOLVED_DATE**: 2025-11-08

   **USER_FEEDBACK_QUOTE**: "Update all branding from 'juno-task' to 'juno-code' for consistency across package name, CLI help text, and user-facing documentation"

   **ROOT_CAUSE**: The package was renamed from "juno-task-ts" to "juno-code" but branding throughout the CLI help text, documentation, and command examples still referenced the old "juno-task" naming.

   **SOLUTION_IMPLEMENTED**:
   1. Renamed package from "juno-task-ts" to "juno-code" in package.json
   2. Updated all CLI help text and branding throughout the codebase
   3. Changed all "Juno Task" references to "Juno Code" in user-facing text
   4. Updated all command examples in help text to use "juno-code" binary name
   5. Maintained full backward compatibility while ensuring consistent branding
   6. Updated package metadata and descriptions to reflect new branding

   **TEST_CRITERIA_MET**:
   - ✅ All "juno-task" references updated to "juno-code" in user-facing text
   - ✅ Package.json updated with correct branding ("juno-code")
   - ✅ CLI help text accurate and verified (95/100 accuracy score)
   - ✅ All commands documented in --help are functional
   - ✅ Build successful with new branding
   - ✅ 807 tests passing (2 pre-existing failures unrelated)
   - ✅ Help text verification completed
   - ✅ Binary name consistency maintained throughout documentation

   **Files Modified/Created**:
   - Modified: package.json (updated name, binary, and branding)
   - Modified: Multiple CLI command files for help text updates
   - Modified: Documentation files with new branding
   - Updated: All user-facing command examples and descriptions

</RESOLVED_ISSUE>

<RESOLVED_ISSUE>
   **Environment Variables Renaming (JUNO_TASK → JUNO_CODE) with Backward Compatibility**
   **Status**: ✅ RESOLVED
   **Date**: 2025-11-08
   **RESOLVED_DATE**: 2025-11-08

   **USER_FEEDBACK_QUOTE**: "Update environment variable naming from JUNO_TASK_* to JUNO_CODE_* while maintaining backward compatibility for existing users"

   **ROOT_CAUSE**: Environment variables used JUNO_TASK_* prefix which was inconsistent with the new "juno-code" package branding, but needed to maintain backward compatibility for existing user setups.

   **SOLUTION_IMPLEMENTED**:
   1. Renamed all environment variables from JUNO_TASK_* to JUNO_CODE_* pattern
   2. Implemented full backward compatibility with JUNO_TASK_* variables
   3. Created priority system where JUNO_CODE_* takes precedence over JUNO_TASK_*
   4. Updated all documentation and help text to reference new variable names
   5. Added automatic fallback detection for legacy environment variables
   6. Maintained existing functionality while providing clear upgrade path

   **TEST_CRITERIA_MET**:
   - ✅ All environment variables renamed from JUNO_TASK_* to JUNO_CODE_*
   - ✅ Full backward compatibility maintained with JUNO_TASK_* variables
   - ✅ Priority system: JUNO_CODE_* takes precedence over JUNO_TASK_*
   - ✅ All documentation updated with new environment variable names
   - ✅ Help text verification shows correct variable names
   - ✅ Legacy variables continue to work for existing users
   - ✅ Build successful with environment variable changes
   - ✅ No breaking changes for existing installations

   **Files Modified/Created**:
   - Modified: Environment variable configuration files
   - Modified: CLI help text and documentation
   - Modified: Configuration management system
   - Updated: All references to environment variables in code and docs

</RESOLVED_ISSUE>

<RESOLVED_ISSUE>
   **Interactive Feedback Command TUI Mode**
   **Status**: ✅ RESOLVED
   **Date**: 2025-11-08
   **RESOLVED_DATE**: 2025-11-08

   **USER_FEEDBACK_QUOTE**: "Interactive feedback command, should have the same functionality as the headless mode of feedback command and it should provide a multiline input for the Issue, and also multiline Optional input for the test criteria"

   **ROOT_CAUSE**: The TUI mode already had the same functionality as headless mode (both use the same `appendIssueToFeedback` function), but comprehensive tests were missing to validate the functionality and ensure parity.

   **SOLUTION_IMPLEMENTED**:
   1. Created TEST_EXECUTABLE.md specification file in .juno_task/specs/ documenting test requirements and patterns
   2. Enhanced feedback-command-tui-execution.test.ts to match init test patterns:
      - Added comprehensive validation for both scenarios (with and without test criteria)
      - Added artifact saving to stable location (test-artifacts/tui/)
      - Added PRESERVE_TMP support for manual inspection
      - Added detailed logging and directory path printing
      - Added two test cases: with test criteria and without test criteria
   3. Created feedback-command-execution.test.ts for binary execution tests:
      - Tests headless mode with --issue and --test flags
      - Tests headless mode with --issue only (no test criteria)
      - Validates USER_FEEDBACK.md structure and content
      - Generates detailed test reports
   4. Verified test:feedback script in package.json (already existed and correctly configured)
   5. Verified vitest.tui.config.ts includes feedback-command-tui-execution.test.ts

   **TEST_CRITERIA_MET**:
   - ✅ TEST_EXECUTABLE.md specification created in .juno_task/specs/
   - ✅ TUI test enhanced with comprehensive validation (matches init test patterns)
   - ✅ Binary execution test created (similar to init-command-execution.test.ts)
   - ✅ Test:feedback script verified and working (npm run test:feedback)
   - ✅ Both TUI and headless modes use same appendIssueToFeedback function (functionality parity confirmed)
   - ✅ TUI mode provides multiline input for Issue (via promptMultiline)
   - ✅ TUI mode provides optional multiline input for Test Criteria (via promptMultiline)
   - ✅ Binary execution tests passing (2/2 tests passed)
   - ✅ Build successful - npm run build completed without errors
   - ✅ Tests support PRESERVE_TMP=1 for manual inspection
   - ✅ Artifacts saved to test-artifacts/tui/ for debugging

   **Files Modified/Created**:
   - Created: .juno_task/specs/TEST_EXECUTABLE.md (test specification)
   - Modified: src/cli/__tests__/feedback-command-tui-execution.test.ts (enhanced with comprehensive tests)
   - Created: src/cli/__tests__/feedback-command-execution.test.ts (binary execution tests)
   - Verified: package.json test:feedback script (already configured correctly)
   - Verified: vitest.tui.config.ts (already includes feedback test)

</RESOLVED_ISSUE>

<RESOLVED_ISSUE>
   **Hooks System Default State Configuration**
   **Status**: ✅ RESOLVED
   **Date**: 2025-11-07
   **RESOLVED_DATE**: 2025-11-07

   **USER_FEEDBACK_QUOTE**: "for hooks system we need to update the DEFAULT state, that comes on installation (init command). right now in config.json we have hooks:{} we need to change to hooks :{"supported_key":{"commands":[]} } so user could see a list of supported hooks. ONLY for hook: START_ITERATION , have the following commands in the hook config --file=\"CLAUDE.md\"; lines=$(wc -l < \"$file\"); chars=$(wc -m < \"$file\"); if [ \"$lines\" -gt 450 ] || [ \"$chars\" -gt 60000 ]; then juno-kanban \"[Critical] file $file is too large, keep it lean and useful for every run of the agent.\"; fi and another for AGENTS.md. the best way would be to have a place in the codebase for the template of default hooks, so in the future we could easily modify it for adding/removing new commands we like to ship as default hooks of juno-code"

   **ROOT_CAUSE**: The init command was creating config.json with empty hooks object ({}) instead of providing default hooks configuration with file size monitoring commands for CLAUDE.md and AGENTS.md files.

   **SOLUTION_IMPLEMENTED**:
   1. Created src/core/default-hooks.ts with centralized default hooks template
   2. Implemented START_ITERATION hook with file size monitoring for both CLAUDE.md and AGENTS.md
   3. File monitoring commands check for >450 lines or >60000 characters and trigger juno-kanban notifications
   4. Modified config.ts ensureHooksConfig() to use getDefaultHooks() from default-hooks.ts
   5. Updated init.ts createConfigFile() to include hooks field with default configuration
   6. Added auto-migration support for existing configs without hooks
   7. All changes maintain backward compatibility and robust error handling

   **TEST_CRITERIA_MET**:
   - ✅ Default hooks template created in centralized location (src/core/default-hooks.ts)
   - ✅ START_ITERATION hook contains CLAUDE.md monitoring command
   - ✅ START_ITERATION hook contains AGENTS.md monitoring command
   - ✅ Both commands check for >450 lines or >60000 chars with juno-kanban notifications
   - ✅ Init command creates config.json with default hooks instead of empty hooks object
   - ✅ Auto-migration adds default hooks to existing configs missing hooks field
   - ✅ Build successful - npm run build completed without errors
   - ✅ All hooks tests passing (35/35 in utils/__tests__/hooks.test.ts)
   - ✅ All config tests passing (58/58 in core/__tests__/config.test.ts)
   - ✅ Manual verification: init command creates config with populated hooks field
   - ✅ Centralized template supports future modifications for new default hooks

   **Files Modified/Created**:
   - Created: juno-task-ts/src/core/default-hooks.ts (centralized default hooks template)
   - Modified: juno-task-ts/src/core/config.ts (updated ensureHooksConfig to use getDefaultHooks)
   - Modified: juno-task-ts/src/cli/commands/init.ts (added hooks field to config creation)
   - Modified: juno-task-ts/src/core/__tests__/config.test.ts (updated test expectations)
   - Modified: juno-task-ts/src/utils/__tests__/hooks.test.ts (updated test expectations)
</RESOLVED_ISSUE>

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
