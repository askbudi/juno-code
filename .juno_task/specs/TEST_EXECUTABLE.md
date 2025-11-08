# Test Executable Specification

## Overview

This document defines the testing requirements and patterns for CLI command TUI (Terminal User Interface) and binary execution tests in the juno-code project.

## Test Types

### 1. TUI Execution Tests

TUI tests simulate real user interaction with the CLI's interactive terminal interface using PTY (pseudo-terminal) or stdin simulation.

#### Requirements:
- **Environment**: Must run in isolated temporary directories (`/tmp/juno-*-test-XXXXXX`)
- **Binary**: Must use built binary (`dist/bin/cli.mjs`) - requires `npm run build` first
- **Preservation**: Support `PRESERVE_TMP=1` environment variable to keep test directories for inspection
- **Artifacts**: Save raw TUI output to `test-artifacts/tui/` directory
- **Timeout**: 60 seconds for TUI interactions
- **Graceful Exit**: Tests must exit cleanly without requiring manual intervention

#### Test Pattern:
```typescript
// 1. Create isolated temp directory
tempDir = await fs.mkdtemp(path.join('/tmp', 'juno-command-tui-'));

// 2. Spawn CLI binary with PTY or stdin simulation
// 3. Simulate user input sequence
// 4. Wait for completion indicators
// 5. Verify file system changes
// 6. Save artifacts and clean up (unless PRESERVE_TMP=1)
```

#### Example Commands:
- **Init Command**: `npm --prefix juno-task-ts run test:tui`
- **Feedback Command**: `npm --prefix juno-task-ts run test:feedback`

### 2. Binary Execution Tests

Binary tests execute CLI commands with command-line arguments (non-interactive mode) to verify functionality.

#### Requirements:
- **Environment**: Isolated temporary directories
- **Binary**: Use built binary (`dist/bin/cli.mjs`)
- **Arguments**: Test command-line flags and options
- **Validation**: Verify file creation, content correctness, and command output
- **Reports**: Generate detailed test reports in markdown format

#### Test Pattern:
```typescript
// 1. Create isolated temp directory
tempDir = await fs.mkdtemp(path.join('/tmp', 'juno-command-test-'));

// 2. Execute command with arguments
const result = await execa('node', [BINARY_MJS, 'command', '--flags'], {
  cwd: tempDir,
  env: { NO_COLOR: '1', ... }
});

// 3. Analyze file system changes
// 4. Validate content and structure
// 5. Generate test report
// 6. Clean up
```

#### Example Commands:
- **Init Command**: `npm --prefix juno-task-ts run test:binary`
- **Feedback Command**: (to be created)

## Test Execution Environment

### Required Environment Variables:
- `RUN_TUI=1` - Enable TUI tests (skipped by default)
- `PRESERVE_TMP=1` - Keep temporary directories after test completion
- `TEST_TMP_DIR=/tmp` - Override base temporary directory
- `TUI_ARTIFACTS_DIR=...` - Override artifact output directory
- `NO_COLOR=1` - Disable ANSI colors for consistent output parsing

### Vitest Configuration:
- **TUI Tests**: Use `vitest.tui.config.ts` with forks pool (single worker)
- **Binary Tests**: Use default vitest config
- **Timeout**: 60 seconds for TUI tests, 30 seconds for binary tests
- **Watch Mode**: Use `vitest run` to prevent watch mode

## Test Validation Criteria

### File System Validation:
1. Verify required files are created in `.juno_task/` directory
2. Check file content matches expected structure
3. Validate XML/JSON formatting is correct
4. Ensure no extraneous files are created

### Content Validation:
1. Verify user input is correctly captured
2. Check that optional fields (like test criteria) are handled correctly
3. Validate date/timestamp formatting
4. Ensure proper XML structure (`<ISSUE>`, `<Test_CRITERIA>`, `<DATE>`)

### User Experience Validation:
1. Verify prompts appear correctly
2. Check multiline input handling
3. Validate graceful exit without errors
4. Ensure output is user-friendly

## Feedback Command Specific Requirements

### TUI Mode:
1. **Issue Input**: Multiline input for issue description (minimum 5 characters)
2. **Test Criteria**: Optional multiline input for test criteria
3. **File Output**: Creates/updates `.juno_task/USER_FEEDBACK.md`
4. **XML Structure**: Proper `<ISSUE><Test_CRITERIA><DATE>` formatting

### Headless Mode:
1. **Issue Flag**: `--issue/-is/--detail/--description` for issue description
2. **Test Criteria Flag**: `-t/--test` or `-tc/--test-criteria` for test criteria
3. **File Output**: Same as TUI mode
4. **XML Structure**: Same as TUI mode

### Test Scenarios:
1. **TUI with Issue Only**: Submit feedback without test criteria
2. **TUI with Issue and Test Criteria**: Submit feedback with test criteria
3. **Headless with Issue Only**: Use flags without test criteria
4. **Headless with Issue and Test Criteria**: Use all flags
5. **File Validation**: Verify USER_FEEDBACK.md structure and content

## Test Artifacts

### Output Files:
- **Raw TUI Output**: `test-artifacts/tui/feedback-command-tui-output-{timestamp}.txt`
- **Test Reports**: `{tempDir}/test-outputs/{test-name}-{timestamp}.md`
- **Preserved Directories**: `/tmp/juno-*-test-XXXXXX` (when PRESERVE_TMP=1)

### Artifact Contents:
- Complete stdout/stderr output
- File system analysis
- Content validation results
- User input sequence
- Test execution metadata

## Best Practices

1. **Isolation**: Always use isolated temporary directories
2. **Cleanup**: Remove temp directories unless PRESERVE_TMP=1
3. **Validation**: Verify both file creation and content correctness
4. **Artifacts**: Save raw output for debugging and analysis
5. **Graceful Exit**: Tests must exit without manual intervention
6. **Error Handling**: Capture and report errors with context
7. **Documentation**: Include clear comments explaining test flow

## Running Tests

### Build First:
```bash
npm run build
```

### TUI Tests:
```bash
# Run feedback TUI test
npm run test:feedback

# Preserve temp directory for inspection
PRESERVE_TMP=1 npm run test:feedback
```

### Binary Tests:
```bash
# Run binary execution tests
npm run test:binary
```

### All Tests:
```bash
# Run all tests
npm test
```

## Success Criteria

A test is considered successful when:
1. ✅ Command executes without errors
2. ✅ Required files are created correctly
3. ✅ File content matches expected structure
4. ✅ User input is correctly captured
5. ✅ Test artifacts are saved
6. ✅ Test exits gracefully
7. ✅ Temporary directories are cleaned up (unless preserved)
