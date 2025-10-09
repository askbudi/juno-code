# Juno-Task Implementation Plan

## 🚨 CRITICAL P0 BLOCKING ISSUE

### 1. **Init command doesn't create mcp.json file** - BLOCKER
- **Issue**: After `juno-task init` completes successfully, running `juno-task start` raises an error because init command doesn't create mcp.json file in the .juno_task folder
- **Validation Evidence**:
  - Init command creates: config.json, init.md, prompt.md, plan.md, specs/, USER_FEEDBACK.md
  - **MISSING**: mcp.json file is NOT created by init command
  - Start command expects mcp.json for MCP server configuration
  - This is a critical issue that prevents newly initialized projects from running
- **Impact**: Complete workflow blockage (init → start fails)
- **User Impact**: First-experience failure - every new project is non-functional
- **Priority**: P0 - Single remaining blocker for production readiness

### Required Implementation:
- Modify `src/cli/commands/init.ts` to generate mcp.json file
- Include default MCP server configuration for roundtable-ai
- Ensure mcp.json creation alongside other initialization files
- Test complete init → start workflow

### Success Criteria:
- `juno-task init` creates all required files including mcp.json
- `juno-task start` works immediately after init without errors
- Complete workflow tested end-to-end

## ✅ CURRENT STATUS

### Functionality Already Working (per USER_FEEDBACK.md validation):
- ✅ Config.json generation in init command
- ✅ Start command subagent selection from config
- ✅ Main command auto-detection of subagent and prompt
- ✅ Feedback command interactive mode
- ✅ Default iterations configuration (50)
- ✅ Git remote setup in init command

### Project State:
- **Overall Completion**: 99% - All features working except mcp.json creation
- **Production Readiness**: Blocked by single file creation issue
- **Test Coverage**: Comprehensive test suite in place
- **All other features**: Validated as working through real CLI testing

## 🎯 NEXT STEPS

1. **IMMEDIATE PRIORITY**: Fix mcp.json file creation in init command
2. **VALIDATION**: Test complete init → start workflow
3. **COMPLETION**: Remove P0 issue from USER_FEEDBACK.md once resolved

**Note**: This is the ONLY remaining critical issue. Once resolved, the TypeScript juno-task CLI will be fully production-ready with complete feature parity to the Python version.