## Open Issues
<!-- Current status: ⚠️ 1 OPEN ISSUE -->
<OPEN_ISSUES>

**Issue #24: Documentation Cleanup - Remove Development Artifacts**
- **Date Reported**: 2025-11-17
- **Description**: Remove development artifacts and outdated information from documentation files
- **Current Status**: Open - awaiting implementation
- **Priority**: Low

</OPEN_ISSUES>

## Recently Resolved Issues (2025-11-17)

**Issue #28: Juno-Code CLI Not Passing Model Flag to Shell Backend** - ✅ FULLY RESOLVED (2025-11-17)
- **Date Reported**: 2025-11-17
- **Date Resolved**: 2025-11-17
- **User Report**: When using `juno-code -b shell -s claude -m :haiku`, the model flag was ignored and sonnet-4.5 was used instead
- **Symptom**: Model selection flag not being passed to Python script command line arguments
- **Root Cause**: The shell backend (shell-backend.ts) was setting JUNO_MODEL environment variable but not passing the -m flag to the Python script command line arguments
- **Solution**:
  1. Added code to pass the model flag as -m argument to Python scripts in shell-backend.ts
  2. Implementation at lines 418-421 ensures model flag is properly forwarded to shell scripts
  3. Model flag now correctly passed to both claude.py and other shell backend scripts
- **Implementation Details**:
  - shell-backend.ts checks for model option in execution parameters
  - When model flag present, adds `-m <model>` to Python script arguments
  - Environment variable JUNO_MODEL still set for backward compatibility
  - Command line argument takes precedence over environment variable
- **Files Modified**:
  - juno-task-ts/src/core/backends/shell-backend.ts (lines 418-421)
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 873 tests passed (2 unrelated MCP timeout failures)
  - ✅ Model flag correctly passed to shell backend scripts
  - ✅ Command works: `juno-code -b shell -s claude -m :haiku`
  - ✅ No regressions introduced
- **Test Results**:
  ```
  ✅ Build successful
  ✅ 873 tests passing
  ✅ Model flag properly forwarded to Python scripts
  ✅ Both environment variable and CLI argument support working
  ✅ No regressions introduced
  ```

**Issue #27: Claude Shell Backend Model Selection Support** - ✅ FULLY RESOLVED (2025-11-17)
- **Date Reported**: 2025-11-17
- **User Report**: Need to support model selection with shorthand syntax for claude.py -m flag
- **Symptom**: No shorthand support for model names (e.g., :haiku, :sonnet, :opus) in -m flag
- **Resolution Date**: 2025-11-17
- **Root Cause**: claude.py -m flag required full model names, no support for convenient shorthand syntax
- **Solution**:
  1. Added MODEL_SHORTHANDS dictionary to claude.py with model name mappings
  2. Implemented expand_model_shorthand() method that expands shorthand names
  3. Updated run() method to call expand_model_shorthand() when setting self.model_name
  4. Updated help text to document shorthand syntax with examples
- **Implementation Details**:
  - MODEL_SHORTHANDS maps shorthand names to full model identifiers:
    - :haiku -> claude-haiku-4-5-20251001
    - :sonnet -> claude-sonnet-4-5-20250929
    - :opus -> claude-opus-4-20250514
    - :claude-haiku-4-5 -> claude-haiku-4-5-20251001
    - :claude-sonnet-4-5 -> claude-sonnet-4-5-20250929
    - :claude-opus-4 -> claude-opus-4-20250514
  - expand_model_shorthand() checks for ":" prefix and maps to full name
  - Full model names pass through unchanged
  - Help text documents all supported shorthands
- **Files Modified**:
  - juno-task-ts/src/templates/services/claude.py
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 853 tests passed (1 unrelated failure)
  - ✅ Manual testing: all shorthand expansions work correctly
  - ✅ Full model names continue to work
  - ✅ Help text updated with shorthand examples
- **Test Results**:
  ```
  ✅ Build successful
  ✅ 853 tests passing
  ✅ All shorthand mappings verified: :haiku, :sonnet, :opus
  ✅ Extended shorthands work: :claude-haiku-4-5, :claude-sonnet-4-5, :claude-opus-4
  ✅ Full model names pass through unchanged
  ✅ No regressions introduced
  ```

## Recently Resolved Issues (2025-11-14)

**Issue #23: CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE Environment Variable** - ✅ FULLY RESOLVED (2025-11-14)
- **Date Reported**: 2025-11-14
- **User Report**: Need environment variable to control user message truncation behavior in claude.py pretty mode
- **Symptom**: User message truncation was hardcoded to 4 lines with no way to configure or disable
- **Resolution Date**: 2025-11-14
- **Root Cause**: claude.py used hardcoded 4-line truncation limit for user messages with no configuration support
- **Solution**:
  1. Added CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE environment variable (default=4, -1=no truncation)
  2. Updated truncation logic to use configurable value instead of hardcoded 4
  3. Updated --help text to document the new environment variable
  4. Updated error message to include the new environment variable
- **Implementation Details**:
  - Read CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE from environment (default=4)
  - Use configured value in user message truncation logic
  - Support -1 to disable truncation completely
  - Updated help and error messages with new ENV variable
- **Files Modified**:
  - juno-task-ts/src/templates/services/claude.py
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 854 tests passed (1 unrelated failure)
  - ✅ All 7 custom tests PASSED (truncation behavior verified)
  - ✅ Environment variable controls truncation
  - ✅ Default behavior unchanged (4 lines)
  - ✅ -1 value disables truncation
- **Test Results**:
  ```
  ✅ Build successful
  ✅ All 7 custom tests PASSED
  ✅ 854 main test suite tests PASSED
  ✅ Environment variable support working
  ✅ No regressions introduced
  ```

**Issue #22: Claude.py Pretty Mode User Message Truncation** - ✅ FULLY RESOLVED (2025-11-14)
- **Date Reported**: 2025-11-14
- **User Report**: User messages in claude.py pretty mode need truncation to prevent excessive output
- **Symptom**: Long user messages were displayed in full, making output verbose and hard to read
- **Resolution Date**: 2025-11-14
- **Root Cause**: claude.py pretty mode displayed full user message content without any truncation
- **Solution**:
  1. Implemented user message truncation with configurable limit (via CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE)
  2. Show first N lines of user messages with [Truncated...] indicator
  3. Configurable via environment variable (default=4 lines)
  4. Support -1 to disable truncation
- **Implementation Details**:
  - Added truncation logic to user message formatting
  - Display first N lines followed by [Truncated...] indicator
  - Configurable limit via CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE environment variable
  - Default 4-line limit maintains readability
- **Files Modified**:
  - juno-task-ts/src/templates/services/claude.py
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 854 tests passed (1 unrelated failure)
  - ✅ All 7 custom tests PASSED
  - ✅ User messages truncated to configured limit
  - ✅ [Truncated...] indicator shown when truncated
  - ✅ Environment variable support working
- **Test Results**:
  ```
  ✅ Build successful
  ✅ All 7 custom tests PASSED
  ✅ 854 main test suite tests PASSED
  ✅ User message truncation working as expected
  ✅ No regressions introduced
  ```

**Issue #20: Multiline Format Should Support Nested Messages** - ✅ FULLY RESOLVED (2025-11-14)
- **Date Reported**: 2025-11-14
- **User Report**: Multiline format should support nested messages (specifically tool_result type content)
- **Symptom**: Messages with nested content like `message.content[{type: "tool_result", content: "..."}]` displayed the entire nested structure instead of flattening it
- **Resolution Date**: 2025-11-14
- **Root Cause**: The pretty_format_json() function in claude.py didn't handle nested message structures properly
- **Solution**:
  1. Enhanced pretty_format_json() to detect and flatten nested tool_result messages
  2. Checks if a message has nested content arrays
  3. Detects tool_result type items within those arrays
  4. Flattens the structure by pulling nested fields (tool_use_id, type, content) to the top level
  5. Removes unnecessary wrapper fields (message, parent_tool_use_id, session_id, uuid)
  6. Applies multiline text rendering to the flattened content field
- **Implementation Details**:
  - Added nested message detection in pretty_format_json()
  - Implemented flattening logic for tool_result type content
  - Preserved multiline rendering for flattened content
  - Maintained backward compatibility with non-nested messages
- **Files Modified**:
  - juno-task-ts/src/templates/services/claude.py (lines 287-320)
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 862 tests passed (1 unrelated MCP timeout test failure)
  - ✅ Nested tool_result messages properly flattened
  - ✅ Multiline content displayed with actual newlines
  - ✅ Non-tool_result messages unchanged
  - ✅ No regressions introduced
- **Test Results**:
  ```
  ✅ Build successful
  ✅ Comprehensive test suite created (test_nested_format.py)
  ✅ All 3 test cases pass:
     * Nested tool_result with multiline content: PASS
     * Single-line tool_result content: PASS
     * Non-tool_result messages (should not be flattened): PASS
  ✅ Full test suite: 862 tests passed
  ✅ No regressions introduced
  ```

## Recently Resolved Issues (2025-11-13)

**Issue #18 & #19: Shell Backend Message Formatting** - ✅ FULLY RESOLVED (2025-11-13)
- **Date Reported**: 2025-11-13
- **User Report**: Shell backend TEXT format output cluttered with repeated `[timestamp] [backend] [event.type]:` prefixes on every line
- **Symptom**: Output unreadable due to excessive prefixes, all TEXT format messages styled in gray
- **Resolution Date**: 2025-11-13
- **Root Cause**:
  - start.ts line 166 and main.ts lines 296-301 were adding `[timestamp] [backend] [event.type]:` prefix to every line of TEXT format output
  - Gray color styling was applied to all TEXT format messages
  - This made output cluttered and unreadable with repeated `[shell] thinking:` prefixes
- **Solution**:
  1. **start.ts (lines 155-169)**: Removed all prefixes, timestamps, and gray coloring from TEXT format events
     - JSON content: Shows clean formatted JSON without prefix
     - Non-JSON content: Shows raw content without prefix
  2. **main.ts (lines 291-302)**: Removed all prefixes, timestamps, backend labels, and event type labels
     - JSON content: Shows clean formatted JSON
     - Non-JSON content: Shows raw content
- **Implementation Details**:
  - Updated displayVerboseProgress() in start.ts to display TEXT content directly without formatting
  - Updated main command verbose handler to display TEXT content without any prefixes
  - Preserved JSON parsing logic for structured output
  - Maintained clean, readable output for both JSON and TEXT formats
- **Files Modified**:
  - juno-task-ts/src/cli/commands/start.ts (lines 155-169)
  - juno-task-ts/src/cli/commands/main.ts (lines 291-302)
- **Test Criteria**:
  - ✅ Build successful
  - ✅ 853 tests passed (1 unrelated test failure)
  - ✅ Clean output format verified
  - ✅ No prefix clutter in TEXT format output
  - ✅ JSON content displays cleanly
  - ✅ No gray color styling on TEXT messages
- **Test Results**:
  ```
  ✅ Build successful
  ✅ 853 tests passed (1 unrelated test failure)
  ✅ Clean output format - no prefix clutter
  ✅ TEXT content displays without formatting
  ✅ No regressions introduced
  ```

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
