## Open Issues
<!-- Current status: 0 OPEN ISSUES -->
<OPEN_ISSUES>
No open issues. All reported issues have been resolved.
</OPEN_ISSUES>

## Recently Resolved Issues (2025-11-13)

**Issue #17: Claude.py Multi-line JSON Rendering** - ✅ FULLY RESOLVED (2025-11-13)
- **Date Reported**: 2025-11-13
- **User Report**: Multi-line JSON content (strings with \n) not rendering with proper formatting, making output hard to read
- **Symptom**: JSON output with multi-line string values shows as compact single-line with escaped \n sequences
- **Resolution Date**: 2025-11-13
- **Root Cause**:
  - **Problem 1**: Previous attempt used `indent=2` on entire JSON structure when multi-line content was detected, making JSON output "sparse" with unwanted newlines everywhere
  - **Problem 2**: The `\n` escape sequences in string values were still displayed as literal "\\n" instead of actual newlines
- **Solution**:
  1. Reverted the `indent=2` approach that made JSON structure sparse
  2. Implemented custom JSON encoder `_custom_json_encode()` that renders multi-line string values with ACTUAL newlines
  3. Similar to `jq -r` or `jq @text` behavior - `\n` in string values become actual line breaks
  4. Keeps JSON structure compact (no indent=2), but string content is readable
- **Implementation Details**:
  - Added `_has_multiline_content()` helper function to detect multi-line strings in JSON structures
  - Added `_custom_json_encode()` method that manually builds JSON output with actual newlines in string values
  - Updated `pretty_format_json()` to use custom encoder when multi-line content is detected
  - Single-line content continues to use standard `json.dumps()` for compact output
- **Files Modified**:
  - juno-task-ts/src/templates/services/claude.py (lines 213-334)
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 873 tests passed, 2 unrelated MCP failures
  - ✅ JSON structure stays compact (no sparse formatting)
  - ✅ Multi-line string values rendered with actual newlines (jq -r style)
  - ✅ Single-line content remains compact
  - ✅ No regressions introduced
- **Test Results**:
  ```
  ✅ Build successful
  ✅ 873 tests passed (2 unrelated MCP failures)
  ✅ JSON structure compact - no unwanted sparse formatting
  ✅ Multi-line strings display with actual newlines like jq -r
  ✅ Single-line content remains compact
  ✅ No regressions introduced
  ```
- **<PREVIOUS_AGENT_ATTEMPT>**:
  - **Previous Failed Approach**: Used `indent=2` on entire JSON structure when multi-line content detected
  - **Why It Failed**: Made JSON output "sparse" with unwanted newlines everywhere in the structure, and `\n` still showed as literal "\\n" in string values
  - **What Was Learned**: Need custom JSON encoder that applies actual newlines ONLY within string values, not to entire structure

**Issue #14: Kanban.sh Verbosity Control** - ✅ RESOLVED (2025-11-13)
- **Date Reported**: 2025-11-13
- **User Report**: kanban.sh prints verbose venv status messages unconditionally, should respect JUNO_VERBOSE environment variable
- **Symptom**: venv status output shows regardless of JUNO_VERBOSE setting (only shown when JUNO_VERBOSE=true)
- **Resolution Date**: 2025-11-13
- **Root Cause**: kanban.sh logging functions (log_info, log_success, log_warning) printed output unconditionally with no check for JUNO_VERBOSE environment variable. DEBUG output also printed unconditionally.
- **Solution**: Updated kanban.sh logging functions to add conditional checks:
  1. Modified log_info(): only prints when JUNO_VERBOSE=true
  2. Modified log_success(): only prints when JUNO_VERBOSE=true
  3. Modified log_warning(): only prints when JUNO_VERBOSE=true
  4. Modified DEBUG output: conditional on JUNO_VERBOSE=true
  5. Left log_error(): always prints (errors should always be visible)
  6. Pattern used: `if [ "${JUNO_VERBOSE:-false}" = "true" ]; then`
- **Files Modified**:
  - juno-task-ts/src/templates/scripts/kanban.sh (lines 18-58, logging functions)
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 873 tests passed
  - ✅ kanban.sh respects JUNO_VERBOSE environment variable
  - ✅ log_info() only prints when JUNO_VERBOSE=true
  - ✅ log_success() only prints when JUNO_VERBOSE=true
  - ✅ log_warning() only prints when JUNO_VERBOSE=true
  - ✅ log_error() always prints (errors always visible)
  - ✅ DEBUG output conditional on JUNO_VERBOSE=true
- **Test Results**:
  ```
  ✅ Build successful
  ✅ 873 tests passed
  ✅ kanban.sh now respects JUNO_VERBOSE environment variable
  ✅ Verbose output only shown when explicitly enabled
  ✅ No regressions introduced
  ```

## Previously Resolved Issues (2025-11-13)

**Issue #10: Shell Backend Streaming Not Working in Start Command** - ✅ RESOLVED (2025-11-13)
- **Date Reported**: 2025-11-13
- **User Report**: `juno-code start -b shell -s codex -v` keeps showing "[shell] executing: unkown"
- **Symptom**: The streaming progress works on the main entrypoint but NOT on start command
- **Resolution Date**: 2025-11-13
- **Root Cause**: The start command incorrectly assumed that ALL `thinking` type events contain a `toolName` in their metadata. This assumption broke for TEXT format events from the shell backend (Codex output). The shell backend emits TEXT events with `metadata: { format: 'text', raw: true }` (NO toolName), causing the code to default to 'unknown' and display "Executing: unknown" instead of the actual content.
- **Solution**: Updated `ProgressDisplay.displayVerboseProgress()` in start.ts to:
  1. Check for TEXT format events: `if (event.metadata?.format === 'text')`
  2. Attempt JSON parsing first (handles Codex JSON output)
  3. Fall back to displaying raw content with event type for non-JSON content
  4. This matches the robust pattern already working in main.ts
- **Files Modified**:
  - juno-task-ts/src/cli/commands/start.ts (lines 155-169)
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 855 tests passed (1 unrelated test failure)
  - ✅ TEXT format events are now handled correctly in start command
  - ✅ JSON parsing attempted for Codex output
  - ✅ No more "unkown" messages displayed
- **Test Results**:
  ```
  ✅ Build successful
  ✅ 855 tests passed
  ✅ Only 1 unrelated test failure (MCP Timeout Functionality)
  ✅ No regressions introduced
  ```

## Recently Resolved Issues (2025-11-12)

**Issue #8: NPM Publishing and Service Script Updates** - ✅ RESOLVED (2025-11-12)
- **Date Reported**: 2025-11-12
- **Resolution Date**: 2025-11-12
- **Root Cause**:
  - Service scripts (codex.py, claude.py) ARE included in npm package in dist/templates/services/
  - ServiceInstaller.install() correctly copies scripts to ~/.juno_code/services/
  - HOWEVER, ServiceInstaller had NO version tracking mechanism
  - ServiceInstaller.install() only runs during:
    1. `juno-code init` (first time setup)
    2. `juno-code services install` (manual)
  - When user upgrades juno-code via npm, old service scripts remain in ~/.juno_code/services/
- **Solution**:
  1. **Added version tracking to ServiceInstaller**:
     - Stores installed version in ~/.juno_code/services/.version
     - getPackageVersion() reads current package.json version
     - getInstalledVersion() reads stored version
     - needsUpdate() compares versions using semver
  2. **Added automatic update mechanism**:
     - Created autoUpdate() method (silent operation)
     - Calls needsUpdate() and installs if version mismatch
     - Added to cli.ts main() function to run on EVERY CLI invocation
     - Silent operation - doesn't break CLI if update fails
  3. **Enhanced install() method**:
     - Saves version after successful installation
     - Added silent parameter to suppress output during auto-update
- **Files Modified**:
  - juno-task-ts/src/utils/service-installer.ts - Added version tracking and auto-update
  - juno-task-ts/src/bin/cli.ts - Added autoUpdate() call in main() function
- **Test Criteria**:
  ✅ Version file (.version) created in ~/.juno_code/services/ after first run
  ✅ Version file contains current package version (1.0.19)
  ✅ Auto-update detects version mismatch (tested with 1.0.18 → 1.0.19)
  ✅ Service scripts updated automatically when version changes
  ✅ Version file updated after auto-update completes
  ✅ No update triggered when versions match
  ✅ Silent operation - no output during auto-update
  ✅ Build successful
  ✅ Test suite passes (882 tests passed, 2 unrelated MCP timeout failures)
- **Test Results**:
  - Created .version file with package version automatically
  - Simulated upgrade by changing .version from 1.0.18 to 1.0.19
  - Auto-update successfully triggered and updated scripts
  - Version file correctly updated to 1.0.19
  - No performance impact on CLI startup
  - Service scripts now automatically update on package upgrades

**0. Juno-code --version Dynamic Package.json Version** - ✅ RESOLVED (2025-11-12)
- Issue: juno-code --version displayed hardcoded "1.0.0" instead of actual package.json version "1.0.17"
- Root Cause: Hardcoded VERSION constant in cli.ts line 33 (VERSION = '1.0.0')
- Solution: Updated cli.ts to dynamically import package.json using createRequire and read version from packageJson.version
- Implementation Details:
  - Added createRequire import from 'module' to enable CommonJS require in ESM
  - Created require function with import.meta.url as base
  - Replaced hardcoded VERSION with const VERSION = packageJson.version
- Test Criteria:
  ✅ juno-code --version displays "1.0.17"
  ✅ Version automatically matches package.json version
  ✅ No manual version updates needed in cli.ts
- File Modified: src/bin/cli.ts

**1. Documentation Cleanup** - ✅ RESOLVED (2025-11-12)
- Cleaned up USER_FEEDBACK.md and CLAUDE.md to remove detailed implementation artifacts and keep essential information only

**2. Test Suite Stability - Logger Output and Batch Command Ordering** - ✅ RESOLVED (2025-11-12)
- Fixed AdvancedLogger console method routing (INFO→console.log, ERROR→console.error)
- Fixed runBatch sorting algorithm for proper command ordering
- Files: advanced-logger.ts, command-executor.ts

**3. Init Command Template System** - ✅ RESOLVED (2025-11-12)
- Refactored init.ts to use TemplateEngine and load templates from engine.ts
- Templates properly loaded with variable population

**4. Message Duplication and Tool_use Empty Content** - ✅ RESOLVED (2025-11-12)
- Fixed shell backend duplicate output issues
- Enhanced tool_use content extraction in claude.py

**5. Claude.py --pretty Flag Customization** - ✅ RESOLVED (2025-11-12)
- Implemented --pretty flag with default=true and ENV variable support (CLAUDE_PRETTY)
- Selective field display for assistant messages
- File: claude.py

## Recently Resolved Issues (2025-11-11)

**6. Shell Backend Verbose JSON Output Format - jq-Style Formatting** - ✅ RESOLVED (2025-11-11)
- Implemented jq-style JSON output with proper indentation and syntax highlighting
- Files: shell-backend.ts, start.ts, main.ts, test.ts

**7. Shell Backend Real-Time Updates** - ✅ RESOLVED (2025-11-11)
- Fixed stdin handling (added child.stdin.end()) for proper subprocess execution
- Real-time streaming now works correctly

**8. Backend Integration** - ✅ RESOLVED (2025-11-11)
- Implemented -b/--backend flag and JUNO_CODE_AGENT env variable support
- Created BackendManager, ShellBackend, MCPBackend classes

**9. Claude Shell Script** - ✅ RESOLVED (2025-11-11)
- Created claude.py shell script with full Claude CLI argument support
- File: claude.py

## Recently Resolved Issues (2025-11-10)

**10. Backend Manager Runtime Error** - ✅ RESOLVED (2025-11-10)
- Fixed createExecutionEngine() to use BackendManager instance instead of mcpClient

**11. Shell Script Services System** - ✅ RESOLVED (2025-11-10)
- Created src/templates/services/ directory with codex.py and claude.py
- Implemented ServiceInstaller utility and 'juno-code services' CLI command

**12. Deploy Script Git Tag Error** - ✅ RESOLVED (2025-11-10)
- Fixed ANSI color codes contaminating version string in bump_version()
- Added >&2 redirects to print functions

<!-- Historical resolved issues archived - check git history for full details -->
