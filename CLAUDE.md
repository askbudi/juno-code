# Claude Development Session Learnings

## Project Overview

This project was initialized on 2025-10-08 using juno-code.

**Main Task**: Build a comprehensive testing framework
**Preferred Subagent**: claude
**Project Root**: /Users/mahdiyar/Code/denmark_insightfactory/playground_juputer/projects/.vibe_trees/budi_cli_ts/juno-task-ts

## Development Environment

### Build System
- Use `npm run build` to build the project
- Test with `npm test` for unit tests
- Use `npm run test:binary` for CLI testing

### Key Commands
- `juno-code start` - Begin task execution
- `juno-code -s claude` - Quick execution with preferred subagent
- `juno-code feedback` - Provide feedback on the process

## Project Structure

```
.
├── .juno_task/
│   ├── prompt.md          # Main task definition with AI instructions
│   ├── init.md            # Initial task breakdown and constraints
│   ├── plan.md            # Dynamic planning and priority tracking
│   ├── USER_FEEDBACK.md   # User feedback and issue tracking
│   └── specs/             # Project specifications
│       ├── README.md      # Specs overview
│       ├── requirements.md # Functional requirements
│       └── architecture.md # System architecture
├── CLAUDE.md              # This file - session documentation
└── README.md              # Project overview
```

## AI Workflow

The project uses a sophisticated AI workflow with:

1. **Task Analysis**: Study existing codebase and requirements
2. **Specification Creation**: Detailed specs for each component
3. **Implementation**: AI-assisted development with parallel subagents
4. **Testing**: Automated testing and validation
5. **Documentation**: Continuous documentation updates
6. **Version Control**: Automated Git workflow management

## Important Notes

- Always check USER_FEEDBACK.md first for user input
- Keep plan.md up to date with current priorities
- Use up to 500 parallel subagents for analysis
- Use only 1 subagent for build/test operations
- Focus on full implementations, not placeholders
- Maintain comprehensive documentation

## Utility Scripts

**run_until_completion.sh (auto-installed):**
- Script auto-installed to `~/.juno_code/scripts/` on first CLI run via ScriptInstaller
- Enables looping juno-code commands until completion_status='COMPLETED'
- Similar to `codex run-until-complete` functionality
- Auto-installation verified on every CLI startup; missing scripts restored automatically

## Current Status Update (2025-12-13)

**⚠️ 1 OPEN ISSUE**
- Issue #56: run_until_completion.sh task check - CANNOT REPRODUCE (awaiting user clarification)

**Recent Resolutions (2025-12-13):**
- Issue #58: run_until_completion.sh -i flag NaN validation fix - RESOLVED (added NaN validation in main.ts before fallback, changed `||` to `??`, completes partial fix from Issue #57, 1024 tests passing)

**Previous Resolutions (2025-12-12):**
- Issue #53: run_until_completion.sh script with auto-install - RESOLVED (ScriptInstaller utility, auto-install in CLI, 1024 tests passing)
- Issue #57: run_until_completion.sh -i flag NaN validation - PARTIAL FIX (added validation to framework.ts/engine.ts but main.ts bypassed it with `||` operator; completed by Issue #58)

**Previous Resolutions (2025-11-30):**
- Issue #37: --tools and --allowedTools as two different parameters - RESOLVED (full separation per Claude CLI spec, 851 tests passing)
- Issue #36: --allowed-tools alias support - RESOLVED (added --allowed-tools and --disallowed-tools aliases for naming consistency, 871 tests passing)

**Previous Resolutions (2025-11-28):**
- Issue #34: Default model for shell backend using deprecated model name - RESOLVED (changed from 'sonnet-4' to ':sonnet' in init.ts line 825)
- Issue #33: --disallowedTools support and CLI argument passthrough - RESOLVED (full tool argument passthrough implemented, 871 tests passing)

**Recent Resolutions (2025-11-27):**
- Issue #32: Inline mode support for juno-code init command - RESOLVED (added description argument, --subagent, --git-repo, --directory options)
- Issue #24: Documentation cleanup - RESOLVED (remove development artifacts)

**Recent Resolutions (2025-11-25):**
- Issue #31: :opus model shorthand support - RESOLVED (now maps to claude-opus-4-5-20251101, updated MODEL_SHORTHANDS in claude.py)
- Issue #30: --agents flag support - RESOLVED (added CLI option and forwarding to shell backend, 853 tests passing)
- Issue #29: Default model sonnet-4-5 - ALREADY RESOLVED (no changes needed, DEFAULT_MODEL already set)
- Issue #28: Model flag passthrough - ALREADY RESOLVED (no changes needed, full passthrough chain already implemented)

**Recent Resolutions (2025-11-17):**
- Issue #27: Claude shell backend model selection support - FULLY RESOLVED (implemented shorthand syntax :haiku, :sonnet, :opus with MODEL_SHORTHANDS dictionary and expand_model_shorthand() method, 853 tests passing)

**Recent Resolutions (2025-11-14):**
- Issue #23: CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE environment variable - FULLY RESOLVED (configurable truncation support, default=4, -1=no truncation)
- Issue #22: claude.py pretty mode user message truncation - FULLY RESOLVED (configurable via ENV, default 4 lines with [Truncated...] indicator)
- Issue #20: Nested message formatting - FULLY RESOLVED (enhanced pretty_format_json() to flatten tool_result type content)

**Recent Resolutions (2025-11-13):**
- Issues #18 & #19: Shell backend message formatting - FULLY RESOLVED (removed all prefix clutter from TEXT format output)
- Issue #17: claude.py multi-line rendering - FULLY RESOLVED (custom JSON encoder with actual newlines in string values, jq -r style)
- Issue #14: Kanban.sh verbosity control (respects JUNO_VERBOSE environment variable)
- Shell backend streaming fix in start command (TEXT format events handled correctly)

**Previous Resolutions (2025-11-12):**
- Codex shell backend streaming support - Dual-format JSON/TEXT streaming (commit e7aec56)
- Dynamic version from package.json
- Documentation cleanup
- Test suite stability (logger routing, batch ordering)
- Init command template system
- Message duplication and tool_use content
- Claude.py --pretty flag

**Previous Resolutions (2025-11-11):**
- Backend Integration System Implementation (Issue #6)
- Claude Shell Script Flag Format Issue
- NPM Registry Binary Linking Issue and ENV Damage During Transfer to Subagents (2025-11-09)
- ENV Variable Corruption During Transit with Path Prefixing (2025-11-09)

### ✅ 0 OPEN ISSUES (Last updated: 2025-11-30)

## Most Recently Resolved Issues (2025-11-30)

### Issue #37: --tools and --allowedTools Are Two Different Parameters - RESOLVED

**Root Cause:**
- Issue #36 incorrectly treated --tools and --allowed-tools as aliases when they should be TWO DIFFERENT parameters per Claude CLI specification
- --tools controls which built-in Claude tools are available (only works with --print mode)
- --allowedTools is permission-based filtering of specific tool instances
- They serve different purposes and should both be supported independently

**Solution:**
1. Updated cli.ts help text to clarify the difference
2. Added allowedTools field to TypeScript types (separate from tools)
3. Updated main.ts and start.ts to pass both parameters separately
4. Updated engine.ts ExecutionRequest interface to include tools, allowedTools, disallowedTools, agents
5. Updated createExecutionRequest to accept and assign allowedTools
6. Updated ToolCallRequest creation to pass both tools and allowedTools (removed type assertions)
7. Updated shell-backend.ts to build command with both --tools and --allowedTools flags
8. Updated claude.py to support both --tools and --allowedTools argument parsers
9. Updated claude.py command building to pass both to Claude CLI

**Test Results:**
- Build successful
- 851 tests passing (1 unrelated test failure)

**Files Modified:**
- juno-task-ts/src/bin/cli.ts (help text)
- juno-task-ts/src/cli/types.ts (added allowedTools field)
- juno-task-ts/src/cli/commands/main.ts (pass both parameters)
- juno-task-ts/src/cli/commands/start.ts (pass both parameters)
- juno-task-ts/src/core/engine.ts (ExecutionRequest interface, createExecutionRequest, ToolCallRequest creation)
- juno-task-ts/src/core/backends/shell-backend.ts (command building for both flags)
- juno-task-ts/src/templates/services/claude.py (argument parsers and command building)

**Date Resolved:** 2025-11-30

### Issue #36: Add --allowed-tools Flag Support to juno-code CLI - RESOLVED

**Root Cause:**
- Naming clarity issue - --tools already existed and supported multiple values via action="append", but users wanted --allowed-tools (plural) to match --disallowed-tools (plural) for consistency

**Solution:**
1. Added --allowed-tools as alias to --tool in claude.py (line 136)
2. Added --disallowed-tools as alias to --disallowed-tool in claude.py (line 143)
3. Added --allowed-tools as CLI option in cli.ts (line 108)
4. Updated main.ts to handle both allowedTools and tools options (lines 589-590, 595)
5. Full passthrough chain: CLI → ExecutionRequest → ToolCallRequest → shell-backend → claude.py

**Test Results:**
- Build successful
- 871 tests passing

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py (lines 136, 143)
- juno-task-ts/src/bin/cli.ts (line 108)
- juno-task-ts/src/cli/commands/main.ts (lines 589-590, 595)

**Date Resolved:** 2025-11-30

## Most Recently Resolved Issues (2025-11-27)

### Issue #32: Add Inline Mode Support to juno-code init Command - RESOLVED

**Root Cause:**
- The init command only supported interactive mode, making automation difficult

**Solution:**
1. Added positional `[description]` argument to trigger inline mode
2. Added `--subagent` option to specify AI subagent (claude, codex, gemini, cursor)
3. Added `--git-repo` option (alias for existing --git-url)
4. Added `--directory` option for target directory
5. Maintained backward compatibility: no args = interactive mode
6. Added `--interactive` flag to force interactive mode even with description
7. Updated help text with comprehensive examples for both modes

**Test Results:**
- Manual testing confirmed all modes work correctly
- Tested: inline mode with description only, with all options, with different subagents
- Tested: interactive mode still works as default
- All init tests passing (3 passed, 26 skipped)
- No regressions in existing functionality

**Files Modified:**
- juno-task-ts/src/cli/commands/init.ts (configureInitCommand function)
- juno-task-ts/src/cli/__tests__/init.test.ts (updated test expectations)

**Date Resolved:** 2025-11-27

### Issue #24: Documentation Cleanup - RESOLVED

**Root Cause:**
- Documentation files contained development artifacts and outdated information

**Solution:**
- Marked as resolved, cleanup completed

**Date Resolved:** 2025-11-27

## Most Recently Resolved Issues (2025-11-25)

### Issue #31: Add :opus Model Shorthand Support - RESOLVED

**Root Cause:**
- :opus shorthand mapped to old model (claude-opus-4-20250514) instead of latest Opus 4.5

**Solution:**
- Updated MODEL_SHORTHANDS dictionary in claude.py to map :opus to claude-opus-4-5-20251101
- Added :claude-opus-4-5 shorthand

**Test Results:**
- Build successful
- 853 tests passing

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py (lines 26-34)

**Date Resolved:** 2025-11-25

### Issue #30: Add --agents Flag Support - RESOLVED

**Root Cause:**
- --agents flag not defined in CLI option definitions

**Solution:**
- Added agents option to MainCommandOptions and StartCommandOptions interfaces
- Registered --agents option in main and start commands
- Backend infrastructure already in place

**Test Results:**
- Build successful
- 853 tests passing (updated main.test.ts from 7 to 8 options)

**Files Modified:**
- juno-task-ts/src/cli/types.ts
- juno-task-ts/src/cli/commands/main.ts
- juno-task-ts/src/cli/commands/start.ts
- juno-task-ts/src/cli/__tests__/main.test.ts

**Date Resolved:** 2025-11-25

### Issue #29: Default Model sonnet-4-5 - ALREADY RESOLVED

**Status:**
- DEFAULT_MODEL already set to "claude-sonnet-4-5-20250929" (line 21)
- No changes needed

**Date Resolved:** 2025-11-25

### Issue #28: Shell Backend Model Flag Passing - ALREADY RESOLVED

**Root Cause:**
- None - full passthrough chain already implemented

**Solution:**
- No changes needed
- Verified full passthrough chain: CLI options → createExecutionRequest → ToolCallRequest → shell backend -m flag

**Status:**
- Already resolved in previous work

**Date Resolved:** 2025-11-25

## Most Recently Resolved Issues (2025-11-17)

### Issue #27: Claude Shell Backend Model Selection Support - FULLY RESOLVED

**Root Cause:**
- claude.py -m flag required full model names with no support for convenient shorthand syntax

**Solution:**
1. Added MODEL_SHORTHANDS dictionary to claude.py with model name mappings
2. Implemented expand_model_shorthand() method that expands shorthand names
3. Updated run() method to call expand_model_shorthand() when setting self.model_name
4. Updated help text to document shorthand syntax with examples

**Implementation:**
- MODEL_SHORTHANDS maps shorthand names to full model identifiers:
  - :haiku -> claude-haiku-4-5-20251001
  - :sonnet -> claude-sonnet-4-5-20250929
  - :opus -> claude-opus-4-20250514
  - :claude-haiku-4-5 -> claude-haiku-4-5-20251001
  - :claude-sonnet-4-5 -> claude-sonnet-4-5-20250929
  - :claude-opus-4 -> claude-opus-4-20250514
- expand_model_shorthand() checks for ":" prefix and maps to full name
- Full model names pass through unchanged for backward compatibility

**Test Results:**
- Build successful
- 853 tests passed (1 unrelated failure)
- Manual testing confirmed all shorthand expansions work correctly
- Help text updated with shorthand examples

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py

**Date Resolved:** 2025-11-17

## Most Recently Resolved Issues (2025-11-14)

### Issue #23: CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE Environment Variable - FULLY RESOLVED

**Root Cause:**
- claude.py used hardcoded 4-line truncation limit for user messages with no configuration support

**Solution:**
1. Added CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE environment variable (default=4, -1=no truncation)
2. Updated truncation logic to use configurable value instead of hardcoded 4
3. Updated --help text and error message to document new environment variable

**Implementation:**
- Read CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE from environment (default=4)
- Use configured value in user message truncation logic
- Support -1 to disable truncation completely
- Updated help and error messages with new ENV variable

**Test Results:**
- Build successful
- 854 tests passed (1 unrelated failure)
- All 7 custom tests PASSED (truncation behavior verified)
- Environment variable controls truncation as expected
- No regressions introduced

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py

**Date Resolved:** 2025-11-14

### Issue #22: Claude.py Pretty Mode User Message Truncation - FULLY RESOLVED

**Root Cause:**
- claude.py pretty mode displayed full user message content without any truncation

**Solution:**
1. Implemented user message truncation with configurable limit (via CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE)
2. Show first N lines of user messages with [Truncated...] indicator
3. Configurable via environment variable (default=4 lines)
4. Support -1 to disable truncation

**Implementation:**
- Added truncation logic to user message formatting
- Display first N lines followed by [Truncated...] indicator
- Configurable limit via CLAUDE_USER_MESSAGE_PRETTY_TRUNCATE environment variable
- Default 4-line limit maintains readability

**Test Results:**
- Build successful
- 854 tests passed (1 unrelated failure)
- All 7 custom tests PASSED
- User messages truncated to configured limit
- [Truncated...] indicator shown when truncated
- No regressions introduced

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py

**Date Resolved:** 2025-11-14

### Issue #20: Multiline Format Nested Messages - FULLY RESOLVED

**Root Cause:**
- The pretty_format_json() function in claude.py didn't handle nested message structures properly
- Messages with nested content like `message.content[{type: "tool_result", content: "..."}]` displayed entire nested structures instead of flattening them

**Solution:**
1. Enhanced pretty_format_json() to detect and flatten nested tool_result messages
2. Checks if a message has nested content arrays
3. Detects tool_result type items within those arrays
4. Flattens structure by pulling nested fields (tool_use_id, type, content) to top level
5. Removes unnecessary wrapper fields (message, parent_tool_use_id, session_id, uuid)
6. Applies multiline text rendering to the flattened content field

**Implementation:**
- Added nested message detection in pretty_format_json()
- Implemented flattening logic for tool_result type content
- Preserved multiline rendering for flattened content
- Maintained backward compatibility with non-nested messages

**Test Results:**
- Build successful
- 862 tests passed (1 unrelated MCP timeout failure)
- Comprehensive test suite created (test_nested_format.py)
- All 3 test cases pass:
  * Nested tool_result with multiline content: PASS
  * Single-line tool_result content: PASS
  * Non-tool_result messages (should not be flattened): PASS
- No regressions introduced

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py (lines 287-320)

**Date Resolved:** 2025-11-14

## Most Recently Resolved Issues (2025-11-13)

### Issues #18 & #19: Shell Backend Message Formatting - FULLY RESOLVED

**Root Cause:**
- start.ts line 166 and main.ts lines 296-301 were adding `[timestamp] [backend] [event.type]:` prefix to every line of TEXT format output
- Gray color styling was applied to all TEXT format messages
- This made output cluttered and unreadable with repeated `[shell] thinking:` prefixes

**Solution:**
1. **start.ts (lines 155-169)**: Removed all prefixes, timestamps, and gray coloring from TEXT format events
   - JSON content: Shows clean formatted JSON without prefix
   - Non-JSON content: Shows raw content without prefix
2. **main.ts (lines 291-302)**: Removed all prefixes, timestamps, backend labels, and event type labels
   - JSON content: Shows clean formatted JSON
   - Non-JSON content: Shows raw content

**Implementation:**
- Updated displayVerboseProgress() in start.ts to display TEXT content directly without formatting
- Updated main command verbose handler to display TEXT content without any prefixes
- Preserved JSON parsing logic for structured output
- Maintained clean, readable output for both JSON and TEXT formats

**Test Results:**
- Build successful
- 853 tests passed (1 unrelated test failure)
- Clean output format verified
- No prefix clutter in TEXT format output
- JSON content displays cleanly
- No gray color styling on TEXT messages

**Files Modified:**
- juno-task-ts/src/cli/commands/start.ts (lines 155-169)
- juno-task-ts/src/cli/commands/main.ts (lines 291-302)

**Date Resolved:** 2025-11-13

### Issue #17: Claude.py Multi-line JSON Rendering - FULLY RESOLVED

**Root Cause:**
- **Problem 1**: Previous attempt used `indent=2` on entire JSON structure when multi-line content was detected, making JSON output "sparse" with unwanted newlines everywhere
- **Problem 2**: The `\n` escape sequences in string values were still displayed as literal "\\n" instead of actual newlines

**Final Solution:**
1. Reverted the `indent=2` approach that made JSON structure sparse
2. Implemented custom JSON encoder `_custom_json_encode()` that renders multi-line string values with ACTUAL newlines
3. Similar to `jq -r` or `jq @text` behavior - `\n` in string values become actual line breaks
4. Keeps JSON structure compact (no indent=2), but string content is readable

**Implementation:**
- Added `_has_multiline_content()` helper function to detect multi-line strings
- Added `_custom_json_encode()` method that manually builds JSON output with actual newlines in string values
- Updated `pretty_format_json()` to use custom encoder when multi-line content is detected
- Single-line content continues to use standard `json.dumps()` for compact output

**Test Results:**
- Build successful
- 873 tests passed (2 unrelated MCP failures)
- JSON structure stays compact (no sparse formatting)
- Multi-line string values rendered with actual newlines (jq -r style)
- Single-line content remains compact
- No regressions introduced

**Files Modified:**
- juno-task-ts/src/templates/services/claude.py (lines 213-334)

**Date Resolved:** 2025-11-13

## Backend Integration System Learnings (2025-11-11)

### **Critical Patterns & Architecture**

**Backend Manager Pattern:**
- CRITICAL: Use factory pattern with lazy loading for backend implementations
- Abstract Backend interface enforces consistent API across all backend types
- Resource cleanup must be implemented in all backends to prevent memory leaks
- Backend availability checking prevents runtime failures

**Shell Backend Implementation:**
- Process management requires timeout handling and proper signal cleanup
- JSON streaming requires buffering for partial objects - use line-by-line parsing
- Environment variable passing pattern: JUNO_* prefix for all script variables
- Script discovery follows priority: specific scripts → generic scripts → error

**CLI Integration Pattern:**
- CLI arguments take precedence over environment variables over defaults
- Help text must document all options with examples for user clarity
- Validate backend types early to provide clear error messages
- Support both long and short forms: `-b` and `--backend`

**JSON Streaming Architecture:**
- Buffer incomplete JSON lines to handle streaming output properly
- Convert shell script JSON events to internal progress event format
- Emit thinking events for non-JSON output to maintain visibility
- Use event counter for ordering and debugging

**Critical Implementation Notes:**
- Backend interface must support progress callbacks for real-time feedback
- Shell backend requires both Python and shell script support
- Error handling should provide specific guidance (script not found, permissions, etc.)
- Test coverage must include both backend types and CLI integration

**Recently Resolved Issues (2025-11-12):**
1. ✅ Codex Shell Backend Streaming Support - RESOLVED
   - Issue: codex.py was missing streaming features, preventing real-time streaming output
   - Previous Failed Attempt: Enhanced codex.py with JSON streaming support like claude.py (--json flag, --pretty flag, pretty_format_json()), which FAILED because codex returns TEXT-based updates, NOT JSON
   - Root Cause: codex.py was forcing JSON output when Codex CLI outputs TEXT format by default; shell backend only handled JSON parsing, not TEXT streaming
   - Solution:
     1. Updated codex.py to remove JSON formatting (removed --json/--pretty flags, removed pretty_format_json(), simplified run_codex() to stream text as-is)
     2. Updated shell-backend.ts to handle both JSON (Claude) and TEXT (Codex) formats - try JSON parsing first, fall back to TEXT mode
   - Test Results: Real-time streaming works for both codex and claude with shell backend, dual-format support operational
   - Status: ✅ RESOLVED - Shell backend now supports both JSON and TEXT streaming formats
   - Date: 2025-11-12
   - Commit: e7aec56

2. ✅ Juno-code --version Dynamic Package.json Version - RESOLVED
   - Issue: juno-code --version displayed hardcoded "1.0.0" instead of actual package.json version "1.0.17"
   - Root Cause: Hardcoded VERSION constant in cli.ts line 33 (VERSION = '1.0.0')
   - Solution: Updated cli.ts to dynamically import package.json using createRequire and read version from packageJson.version
   - Test Results: juno-code --version now displays "1.0.17" matching package.json
   - Status: ✅ RESOLVED - Version automatically matches package.json, no manual updates needed
   - Date: 2025-11-12

3. ✅ Test Suite Stability - Logger Output and Batch Command Ordering - RESOLVED
   - Issue: Two test failures - logger routing INFO to console.error and batch command ordering issues
   - Root Cause: AdvancedLogger was using incorrect console methods and runBatch sorting algorithm had ordering issues
   - Solution: Fixed AdvancedLogger to use correct console methods (INFO→console.log, ERROR→console.error) and fixed runBatch sorting algorithm
   - Test Results: start.test.ts and command-executor.test.ts failures resolved, all tests passing
   - Status: ✅ RESOLVED - Test suite stability achieved
   - Date: 2025-11-12

**Previously Resolved Issues (2025-11-11):**
1. ✅ Backend Integration CLI Option Missing - RESOLVED
   - Issue: CLI integration for backend selection was broken - both -b/--backend flag and JUNO_CODE_AGENT environment variable were not working properly
   - Root Cause: Main command handler was NOT implementing backend selection, only start command had backend support
   - Solution: Updated main.ts to add backend selection logic, added -b/--backend CLI option to main command and subagent aliases, updated MainCommandOptions interface
   - Test Results: All 4 test scenarios passing - environment variable and CLI flag work for both main command and start subcommand, 790 tests passed
   - Files Modified: main.ts, cli.ts, types.ts
   - Status: ✅ RESOLVED - Backend selection working for all command types
   - Date: 2025-11-11

2. ✅ Backend Integration System Implementation (Issue #6) - RESOLVED
   - Issue: juno-code needed flexible backend system to support both MCP servers and shell script execution
   - Root Cause: System was limited to MCP backend only, needed support for alternative execution methods
   - Solution: Comprehensive backend integration system with manager, shell backend, and CLI integration
   - Key Features:
     * Backend Manager (src/core/backend-manager.ts) with 'mcp' and 'shell' backend support
     * Shell Backend (src/core/backends/shell-backend.ts) for executing scripts from ~/.juno_code/services/
     * CLI Integration with -b/--backend option for backend selection
     * Environment variable support (JUNO_CODE_AGENT) for default backend configuration
     * Dynamic script detection (subagent-specific and fallback scripts)
     * JSON streaming support with progress event conversion
   - Integration: Enhanced start command, engine integration, comprehensive help documentation
   - Test Results: Build successful, 755 tests passed, CLI help documents all backend options
   - Status: ✅ RESOLVED - Full backend integration system operational
   - Date: 2025-11-11

2. ✅ Claude Shell Script Flag Format Issue - RESOLVED
   - Issue: claude.py -p 'prompt text' not working correctly due to argument ordering issue
   - Root Cause: Prompt was being added after --allowed-tools flag, causing Claude CLI to treat prompt as tool name
   - Solution: Fixed command argument ordering in build_claude_command method, moved prompt before --allowed-tools
   - Key Features: claude.py -p works correctly, proper argument parsing by Claude CLI
   - Test Results: All scenarios validated - claude.py -p works, help text displays, scripts execute normally
   - Status: ✅ RESOLVED - Command argument ordering issue fixed
   - Date: 2025-11-11

**Previously Resolved Issues (2025-11-09):**
1. ✅ NPM Registry Binary Linking Issue - RESOLVED
   - Issue: After installing juno-code from npm registry, binary was linking to cli.mjs instead of juno-code.sh wrapper
   - Root Cause: generate-variants.js was creating unnecessary complexity; git tag had ANSI color codes in version string
   - Solution: Removed generate-variants.js, simplified publish-all.sh to publish directly, fixed bump_version() to suppress ANSI output
   - Test Results: Build successful, deployment dry-run successful, scripts properly copied to dist
   - Status: ✅ RESOLVED - Users now get full Python environment activation when installing from npm registry
   - Date: 2025-11-09

2. ✅ ENV Damage During Transfer to Subagents - RESOLVED
   - Issue: ENV variables get damaged during transfer from juno-code to roundtable-ai subagents
   - Root Cause: kanban.sh was missing complete Python environment activation logic that was present in bootstrap.sh
   - Solution: Added complete env activation logic including is_in_venv_juno(), activate_venv(), ensure_python_environment()
   - Test Results: Build successful with enhanced kanban.sh script, scripts properly copied to dist/templates/scripts/
   - Status: ✅ RESOLVED - ENV variables properly preserved during subagent execution
   - Date: 2025-11-09

**Most Recently Completed (2025-11-09):**
1. ✅ ENV Variable Corruption During Transit with Path Prefixing - RESOLVED
   - Issue: ENV variables getting corrupted during transit with URLs and API endpoints being treated as file paths
   - Root Cause: resolveConfigPaths() function in src/mcp/config.ts was applying path resolution logic to all ENV values
   - Solution: Added URL detection using regex pattern to skip path resolution for URLs (http://, https://, ftp://, etc.)
   - Key features: Preserve original values for API endpoints and URLs, continue path resolution only for actual file paths
   - Integration: ENV variables now preserve original values during juno-code → roundtable-ai transfer
   - Test results: Build successful with URL detection logic, mixed ENV value types handled correctly
   - Status: ✅ RESOLVED - URLs and non-path ENV variables maintain original format during transfer
   - Date: 2025-11-09
   - Git commit: 60d8450 (ENV corruption fix)

2. ✅ Install Requirements Script Virtual Environment Detection Fix - RESOLVED
   - Issue: Virtual environment detection was incorrectly logging "verified by uv" when uv detection was failing
   - Root Cause: Script used flawed detection logic without actually testing if uv would work with the environment
   - Solution: Added comprehensive find_best_python() function (lines 105-151) and enhanced install_with_uv() function (lines 153-230) with real uv compatibility testing
   - Key features: Creates .venv_juno with best Python version when needed, handles three scenarios properly, eliminates false positive logging
   - Integration: Enhanced install_with_uv() function with actual uv pip list verification
   - Test results: Virtual environment detection now works correctly in all scenarios
   - Status: ✅ RESOLVED - Script provides accurate virtual environment detection and handling
   - Date: 2025-11-09

2. ✅ Python Version Support Update - RESOLVED
   - Issue: Need Python 3.10-3.13 support for virtual environment creation (preferably 3.13)
   - Root Cause: Install script used system's default Python version which could be incompatible with dependencies
   - Solution: Created find_best_python() function that searches for python3.13, python3.12, python3.11, python3.10 in preference order
   - Key features: Validates each version is 3.10+, provides helpful error messages, works with both uv and pip
   - Integration: Both install_with_uv() and install_with_pip() functions use best available version
   - Test results: Virtual environments created with Python 3.10+ versions, build successful
   - Status: ✅ RESOLVED - Python version compatibility ensured for all installations
   - Date: 2025-11-09

3. ✅ Python 3.8.19 Version Issue - RESOLVED
   - Issue: Script defaulted to system Python 3.8.19 causing dependency failures due to incompatible version
   - Root Cause: Install script used older system Python version below minimum requirements for project dependencies
   - Solution: find_best_python() function ensures Python 3.10+ selection, explicit version checking prevents incompatible usage
   - Key features: Prioritizes newer Python versions, clear error messages for version requirements, fallback validation
   - Integration: Version checking integrated into both installation methods
   - Test results: No longer defaults to incompatible Python versions, dependency installation succeeds
   - Status: ✅ RESOLVED - Python version compatibility issues eliminated
   - Date: 2025-11-09

**Previously Completed (2025-11-08):**
1. ✅ Juno-Code Branding Consistency Update - RESOLVED
   - Issue: Update all branding from "juno-task" to "juno-code" for consistency across package and CLI
   - Solution: Comprehensive branding update with renamed package, updated CLI help text, and consistent command examples
   - Key features: Complete rebranding while maintaining functionality, package name changed to "juno-code"
   - Integration: All user-facing text updated, help system reflects new branding
   - Test results: 807/808 tests passing, build successful, help text verification completed
   - Status: ✅ RESOLVED - Branding consistency achieved across entire project
   - Date: 2025-11-08

2. ✅ Environment Variables Renaming (JUNO_TASK → JUNO_CODE) - RESOLVED
   - Issue: Environment variables used old JUNO_TASK_* prefix, needed update to JUNO_CODE_* with backward compatibility
   - Solution: Renamed all variables to JUNO_CODE_* pattern with full backward compatibility for JUNO_TASK_*
   - Key features: Priority system (JUNO_CODE_* over JUNO_TASK_*), no breaking changes for existing users
   - Integration: Automatic fallback detection, clear documentation of new variable names
   - Test results: All environment variable functionality maintained, help text updated
   - Status: ✅ RESOLVED - Environment variables updated with backward compatibility
   - Date: 2025-11-08

**Previously Completed (2025-11-07):**
1. ✅ Implement.md Template Addition to Init Command - RESOLVED
   - Issue: implement.md template needed to be added to init command for project initialization
   - Solution: Added template to src/templates/engine.ts and updated src/cli/commands/init.ts file creation
   - Key features: Template provides project implementation guidance and structure for new projects
   - Integration: Automatically created during init command with proper file structure
   - Test results: All template engine tests passing (18/18), build successful
   - Status: ✅ RESOLVED - Template now created during initialization
   - Date: 2025-11-07

**Previously Completed (2025-11-03):**
1. ✅ Log Cleanup Script Implementation - RESOLVED
   - Issue: Need automated log file management to prevent disk space issues from accumulating log files
   - Solution: Created comprehensive log archival script system with template-based approach
   - Key features: Archives log files older than 3 days, automated installation via init command, framework supports future script additions
   - Script location: src/templates/scripts/clean_logs_folder.sh
   - Integration: Automatically copied to .juno_task/scripts/ during init with executable permissions
   - Test results: Binary execution tests passing, comprehensive error handling and colored output

**Previously Completed (2025-10-27):**
2. ✅ New Feedback Mode Requirement - f+enter/q+enter - RESOLVED
   - Issue: Enhanced feedback mode requiring f+enter (feedback submission) and q+enter (quit) key combinations
   - Solution: Implemented f+enter/q+enter state machine for intuitive feedback mode interaction
   - Technical details: State machine handles key combination recognition and appropriate actions
   - Test results: 848/850 tests passing (2 pre-existing failures unrelated), build successful

**Previously Completed (2025-10-24):**
2. ✅ Hook System Configuration Documentation Enhancement - RESOLVED
   - Issue: When creating hooks key in config.json file, include all available hooks with empty command arrays for syntax clarity
   - Solution: Enhanced ensureHooksConfig() function in src/core/config.ts to include all 4 hook types (START_RUN, START_ITERATION, END_ITERATION, END_RUN) with empty command arrays
   - Technical details: Auto-migration support for existing configs, robust error handling where failed hooks log errors but don't stop application
   - Test results: 824/826 tests passing (2 pre-existing failures unrelated)

**Previously Completed (2025-10-19):**
2. ✅ Feedback UX Enhancement - Smart Buffering with User Input Timeout - Fixed initialization timing bug
   - Root cause: `lastUserInputTime` initialized to `0` (Unix epoch), causing immediate constant progress flushing
   - Solution: Added `this.lastUserInputTime = Date.now();` in start() method in src/utils/concurrent-feedback-collector.ts
   - Test results: 804/806 tests passing, buffer now flushes only after 30s of actual inactivity

**Previously Completed (2025-10-18):**
3. ✅ Preflight File Size Monitoring - Fixed by improving CLI path resolution with fallback strategies
   - Root cause: CLI path resolution failed in test environments during preflight monitoring
   - Solution: Added multiple CLI resolution strategies with fallback to global command in src/utils/preflight.ts
   - Test results: All 15 preflight tests passing, 788/790 total tests passing

4. ✅ MCP Progress Events User Input Visibility - Fixed by adding stream synchronization
   - Root cause: No synchronization between stderr (progress) and stdout (input redisplay) streams
   - Solution: Added setImmediate wrapper and newline before redisplay in src/utils/feedback-state.ts
   - Test results: Tests passing, manual verification successful

**Recently Completed:**
5. ✅ MCP Server Progress Output Buffering - Real-Time Display Restored (2025-10-17)
6. ✅ MCP Progress formatting regression - restored colored, human-readable JSON output (2025-10-17)
7. ✅ User Input Mixing with App Updates - Fixed terminal line coordination (2025-10-17)
8. ✅ MCP Environment Variables Security Fix - complete process isolation (2025-10-16)
9. ✅ File Compaction System - `juno-code feedback compact` (16/16 tests passing)
10. ✅ Concurrent Feedback Collector - `juno-collect-feedback` (No TTY, multiline paste support)
11. ✅ juno-code Feedback Integration - `juno-code start --enable-feedback` (Concurrent feedback collection)


### 2025-10-16 — MCP Environment Variables Security Fix RESOLVED

- **Issue**: SECURITY VULNERABILITY - Environment variables configured in `.juno_task/mcp.json` were being overwritten, AND parent process environment was being inherited without user consent
- **Root Cause Discovery**: Three separate attempts revealed progressive security requirements:
  1. **2025-10-16 First Attempt**: Fixed environment variable loading from config but variables still overwritten by hardcoded values
  2. **2025-10-17 Second Attempt**: Fixed overwriting but introduced `...process.env` spreading, creating security risk by inheriting parent environment
  3. **2025-10-16 Final Resolution**: Complete process isolation - removed ALL `...process.env` spreading
- **Security Requirements**: MCP server processes must have complete environment isolation:
  - NO inheritance from parent process environment
  - ONLY hardcoded secure defaults + explicit user configuration
  - Prevents accidental exposure of sensitive parent environment variables
- **Final Solution**: Updated all three StdioClientTransport creation points in `src/mcp/client.ts`:
  - Line 646: Removed `...process.env`, kept only hardcoded defaults + user config
  - Line 779: Same security fix for per-operation connections
  - Line 798: Same security fix for direct server path connections
  - Environment merging: `hardcoded_defaults` + `user_config` (NO parent env)
- **Test Results**:
  - ✅ Build successful, 573 unit tests passing
  - ✅ Security verification: no parent environment inheritance
  - ✅ User configuration properly applied from mcp.json
  - ✅ Complete process isolation achieved
- **Key Learning**: Always validate security requirements before implementing environment variable fixes. Process isolation is critical for MCP server security.

## Session Progress

This file will be updated as development progresses to track:
- Key decisions and their rationale
- Important learnings and discoveries
- Build/test optimization techniques
- Solutions to complex problems
- Performance improvements and optimizations
