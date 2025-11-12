## Open Issues
<!-- Current status: 0 OPEN ISSUES -->
<OPEN_ISSUES>
</OPEN_ISSUES>

## Recently Resolved Issues (2025-11-12)

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
