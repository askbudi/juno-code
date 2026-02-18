# Preflight to Hooks Migration Guide

## Overview

The preflight logic has been migrated to use the hooks system. This provides more flexibility and better integration with the existing execution flow.

## What Changed

### Removed
- `src/utils/preflight.ts` - Preflight utility module
- `src/utils/__tests__/preflight*.test.ts` - Preflight test files
- Preflight calls from `src/core/engine.ts`
- Environment variables:
  - `JUNO_PREFLIGHT_THRESHOLD`
  - `JUNO_PREFLIGHT_DISABLED`

### Added
- `hooks/check-file-sizes.sh` - Shell script for file size monitoring
- `config-examples/config-with-file-monitoring.json` - Example configuration
- This migration guide

## Migration Steps

### 1. Update Configuration

Replace preflight environment variables with hooks configuration in your `config.json`:

**Before (preflight):**
```bash
export JUNO_PREFLIGHT_THRESHOLD=500
export JUNO_PREFLIGHT_DISABLED=false
```

**After (hooks):**
```json
{
  "hooks": {
    "START_ITERATION": {
      "commands": [
        "./hooks/check-file-sizes.sh"
      ]
    }
  }
}
```

### 2. Configure File Monitoring

The file monitoring functionality is now available as a hook script. Configure it using:

**Environment Variables:**
- `JUNO_FILE_SIZE_THRESHOLD` - Line count threshold (default: 500)
- `JUNO_FILE_SIZE_MONITORING` - Enable/disable monitoring (default: true)

**Example Configuration:**
```json
{
  "mcpServerCommand": "npx -y @anthropic-ai/mcp-server-filesystem",
  "mcpServerArgs": ["--port", "3001"],
  "mcpPort": 3001,
  "mcpTimeout": 86400000,
  "maxIterations": 50,
  "defaultSubagent": "claude",
  "hooks": {
    "START_ITERATION": {
      "commands": [
        "./hooks/check-file-sizes.sh"
      ]
    }
  }
}
```

### 3. Hook Script Features

The `check-file-sizes.sh` script provides equivalent functionality to the old preflight system:

- **File Size Monitoring**: Checks `USER_FEEDBACK.md` and config files (`CLAUDE.md`/`AGENTS.md`)
- **Threshold Checking**: Configurable line count threshold
- **Feedback Integration**: Triggers feedback commands when files are too large
- **Context Awareness**: Uses hook environment variables for context

### 4. Hook Environment Variables

The hook script receives these environment variables automatically:

- `HOOK_TYPE` - The type of hook (START_ITERATION)
- `ITERATION` - Current iteration number
- `SESSION_ID` - Session identifier
- `RUN_ID` - Run identifier
- `JUNO_SUBAGENT` - Current subagent (claude, cursor, etc.)
- `JUNO_WORKING_DIRECTORY` - Working directory

## Benefits of Migration

### 1. Flexibility
- Custom scripts can be added easily
- Multiple commands per hook
- Shell scripting power for complex logic

### 2. Better Integration
- Hooks are part of the execution flow
- Error handling is consistent
- Logging is integrated

### 3. Configurability
- Enable/disable via configuration
- Custom thresholds per project
- Environment-specific settings

## Usage Examples

### Basic File Monitoring
```json
{
  "hooks": {
    "START_ITERATION": {
      "commands": ["./hooks/check-file-sizes.sh"]
    }
  }
}
```

### Custom Threshold
```bash
export JUNO_FILE_SIZE_THRESHOLD=1000
```

### Disable Monitoring
```bash
export JUNO_FILE_SIZE_MONITORING=false
```

### Multiple Hook Commands
```json
{
  "hooks": {
    "START_ITERATION": {
      "commands": [
        "./hooks/check-file-sizes.sh",
        "echo 'Starting iteration $ITERATION'",
        "npm run pre-iteration-check"
      ]
    }
  }
}
```

## Troubleshooting

### Script Not Executing
1. Ensure the script is executable: `chmod +x hooks/check-file-sizes.sh`
2. Check the script path in configuration
3. Verify hooks are enabled in configuration

### Environment Variables Not Available
- Hook environment variables are injected automatically
- Custom variables can be set in hook configuration
- Check the `executeHook` function for available variables

### File Monitoring Not Working
1. Check `JUNO_FILE_SIZE_MONITORING` is not set to false
2. Verify file paths are correct
3. Check script permissions and bash availability

## Custom Hook Development

You can create custom hooks for other monitoring tasks:

```bash
#!/bin/bash
# Custom hook example

echo "Custom hook executing in iteration $ITERATION"
echo "Session: $SESSION_ID"
echo "Working directory: $JUNO_WORKING_DIRECTORY"
echo "Subagent: $JUNO_SUBAGENT"

# Your custom logic here
```

Register it in configuration:
```json
{
  "hooks": {
    "START_RUN": {
      "commands": ["./hooks/custom-setup.sh"]
    },
    "START_ITERATION": {
      "commands": [
        "./hooks/check-file-sizes.sh",
        "./hooks/custom-pre-iteration.sh"
      ]
    },
    "END_ITERATION": {
      "commands": ["./hooks/custom-post-iteration.sh"]
    },
    "END_RUN": {
      "commands": ["./hooks/custom-cleanup.sh"]
    }
  }
}
```