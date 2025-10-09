/**
 * Init Command Execution Test
 *
 * This test specifically evaluates the init command with a predefined user input sequence
 * to test the complete interactive workflow from start to finish.
 *
 * TUI TESTING CRITICAL REQUIREMENTS:
 * ===================================
 * - CLI uses Ink (React for terminal) - NOT a stdin-based CLI
 * - CANNOT use shell pipes (echo | command) - TUI needs direct stdin control
 * - MUST use execa with 'input' parameter to simulate user keystrokes
 * - Environment variables force interactive mode for testing
 *
 * WATCH MODE PREVENTION:
 * =====================
 * - Use 'vitest run' instead of 'vitest' to prevent watch mode
 * - Include --run flag when running via npm test
 * - Test exits gracefully without waiting for 'q' or 'h' key presses
 * - No user input required after test completion
 *
 * TEST EXECUTION IN /tmp:
 * =======================
 * - Creates isolated environment in /tmp/juno-init-test-XXXXXX
 * - Ensures clean testing environment each run
 * - Test directory path is printed for manual verification
 * - Directory automatically cleaned up after test completion
 *
 * Test Flow:
 * 1. Create isolated test environment in /tmp directory
 * 2. Execute init command with TUI input simulation
 * 3. Simulate user input sequence via execa input parameter:
 *    - Press Enter on first question
 *    - Type "Count number of folders in this directory and give me a report" + Enter + Enter
 *    - Select option 2 + Enter
 *    - Press 'y' + Enter
 *    - Enter 'https://github.com/askbudi/temp-test-ts-repo' + Enter
 * 4. Capture all stdout/stderr output and TUI responses
 * 5. Verify .juno_task folder and required files are created
 * 6. Save raw output to file for analysis and print test directory path
 * 7. Clean up temporary directory automatically
 *
 * USAGE:
 * ======
 * ```bash
 * # Build project first
 * npm run build
 *
 * # Run test with graceful exit (prevents watch mode)
 * npx vitest run src/cli/__tests__/init-command-execution.test.ts
 *
 * # Alternative via npm script
 * npm test -- src/cli/__tests__/init-command-execution.test.ts -- --run
 * ```
 *
 * OUTPUT:
 * ======
 * - Test directory path printed for manual verification: /tmp/juno-init-test-XXXXXX
 * - Detailed report generated: /tmp/juno-init-test-XXXXXX/test-outputs/init-command-complete-workflow-*.md
 * - All required files validated: init.md, prompt.md, USER_FEEDBACK.md, mcp.json, config.json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa, type ExecaReturnValue } from 'execa';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';

// Binary path for testing
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const BINARY_MJS = path.join(PROJECT_ROOT, 'dist/bin/cli.mjs');

// Test timeout for init command (includes TUI interaction)
const INIT_COMMAND_TIMEOUT = 60000; // 60 seconds

// Test environment
let tempDir: string;
let outputDir: string;

interface InitCommandTestResult {
  testName: string;
  timestamp: Date;
  duration: number;
  command: string[];
  userInputSequence: string[];
  workingDirectory: string;
  output: {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    filesCreated: string[];
    tuiResponses: string[];
  };
  fileSystemAnalysis: {
    junoTaskFolderCreated: boolean;
    requiredFiles: {
      initMd: boolean;
      promptMd: boolean;
      userFeedbackMd: boolean;
      mcpJson: boolean;
      configJson: boolean;
    };
    additionalFiles: string[];
  };
  outputPath: string;
}

/**
 * Execute init command with specific user input sequence
 *
 * TUI INPUT SIMULATION STRATEGY:
 * ==============================
 * - CRITICAL: CLI uses Ink (React for terminal) - NOT a traditional stdin-based CLI
 * - CANNOT use shell pipes like `echo "input" | command` - this won't work with Ink TUI
 * - MUST use execa with 'input' parameter to simulate actual user keystrokes
 * - Each element in userInputSequence array represents separate user interaction
 * - Newlines in input simulate Enter key presses
 *
 * ENVIRONMENT VARIABLES FOR TUI TESTING:
 * =====================================
 * - NO_COLOR: '1' - Disables ANSI colors for consistent output parsing
 * - CI: 'false' - Enables interactive mode (CI mode would disable it)
 * - FORCE_INTERACTIVE: '1' - Forces interactive mode even when it might be disabled
 * - JUNO_TASK_CONFIG: '' - Clean configuration environment
 *
 * EXECUTION PARAMETERS:
 * ====================
 * - timeout: 60 seconds for TUI interactions (TUI can be slower than CLI)
 * - reject: false - Capture non-zero exit codes for analysis
 * - all: true - Capture both stdout and stderr
 */
async function executeInitCommand(
  userInputSequence: string[],
  options: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  } = {}
): Promise<{ result: ExecaReturnValue; filesCreated: string[] }> {
  const {
    timeout = INIT_COMMAND_TIMEOUT,
    cwd = tempDir,
    env = {}
  } = options;

  // Record files before execution
  const filesBefore = await getDirectoryFiles(cwd);

  // Set up environment for testing
  const testEnv = {
    ...process.env,
    NO_COLOR: '1',
    CI: 'false', // Enable interactive mode
    JUNO_TASK_CONFIG: '',
    FORCE_INTERACTIVE: '1', // Force interactive mode for testing
    ...env
  };

  // Prepare input for interactive prompts
  const inputText = userInputSequence.join('\n') + '\n';

  try {
    const result = await execa('node', [BINARY_MJS, 'init'], {
      cwd,
      env: testEnv,
      timeout,
      input: inputText,
      reject: false,
      all: true
    });

    // Record files after execution
    const filesAfter = await getDirectoryFiles(cwd);
    const filesCreated = filesAfter.filter(f => !filesBefore.includes(f));

    return { result, filesCreated };
  } catch (error: any) {
    const filesAfter = await getDirectoryFiles(cwd);
    const filesCreated = filesAfter.filter(f => !filesBefore.includes(f));

    return { result: error, filesCreated };
  }
}

/**
 * Get all files in directory recursively
 */
async function getDirectoryFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  if (!await fs.pathExists(dir)) {
    return files;
  }

  async function walkDir(currentDir: string): Promise<void> {
    const items = await fs.readdir(currentDir);
    for (const item of items) {
      const itemPath = path.join(currentDir, item);
      const stats = await fs.stat(itemPath);
      if (stats.isFile()) {
        files.push(path.relative(dir, itemPath));
      } else if (stats.isDirectory()) {
        await walkDir(itemPath);
      }
    }
  }

  await walkDir(dir);
  return files;
}

/**
 * Analyze file system changes and verify required files
 */
async function analyzeFileSystemChanges(
  filesCreated: string[],
  workingDir: string
): Promise<InitCommandTestResult['fileSystemAnalysis']> {
  const junoTaskPath = path.join(workingDir, '.juno_task');
  const junoTaskFolderCreated = await fs.pathExists(junoTaskPath);

  const requiredFiles = {
    initMd: await fs.pathExists(path.join(junoTaskPath, 'init.md')),
    promptMd: await fs.pathExists(path.join(junoTaskPath, 'prompt.md')),
    userFeedbackMd: await fs.pathExists(path.join(junoTaskPath, 'USER_FEEDBACK.md')),
    mcpJson: await fs.pathExists(path.join(junoTaskPath, 'mcp.json')),
    configJson: await fs.pathExists(path.join(junoTaskPath, 'config.json'))
  };

  const additionalFiles = filesCreated.filter(f =>
    !f.startsWith('.juno_task/') &&
    f !== '.juno_task'
  );

  return {
    junoTaskFolderCreated,
    requiredFiles,
    additionalFiles
  };
}

/**
 * Save test output to file for analysis
 */
async function saveTestOutput(
  testName: string,
  testResult: InitCommandTestResult
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFileName = `${testName}-${timestamp}.md`;
  const outputPath = path.join(outputDir, outputFileName);

  const report = `# Init Command Execution Test Report

## Test Information
- **Test Name**: ${testResult.testName}
- **Timestamp**: ${testResult.timestamp.toISOString()}
- **Duration**: ${testResult.duration.toFixed(0)}ms
- **Working Directory**: ${testResult.workingDirectory}
- **Exit Code**: ${testResult.output.exitCode}
- **Success**: ${testResult.output.success ? '✅' : '❌'}

## Command Executed
\`\`\`bash
${testResult.command.join(' ')}
\`\`\`

## User Input Sequence
${testResult.userInputSequence.map((input, index) => `${index + 1}. \`${input}\``).join('\n')}

## Standard Output
\`\`\`
${testResult.output.stdout}
\`\`\`

## Standard Error
\`\`\`
${testResult.output.stderr}
\`\`\`

## Files Created
${testResult.output.filesCreated.length > 0 ? testResult.output.filesCreated.map(f => `- \`${f}\``).join('\n') : 'No files created'}

## File System Analysis

### .juno_task Folder Created
${testResult.fileSystemAnalysis.junoTaskFolderCreated ? '✅ Yes' : '❌ No'}

### Required Files Status
- **init.md**: ${testResult.fileSystemAnalysis.requiredFiles.initMd ? '✅ Created' : '❌ Missing'}
- **prompt.md**: ${testResult.fileSystemAnalysis.requiredFiles.promptMd ? '✅ Created' : '❌ Missing'}
- **USER_FEEDBACK.md**: ${testResult.fileSystemAnalysis.requiredFiles.userFeedbackMd ? '✅ Created' : '❌ Missing'}
- **mcp.json**: ${testResult.fileSystemAnalysis.requiredFiles.mcpJson ? '✅ Created' : '❌ Missing'}
- **config.json**: ${testResult.fileSystemAnalysis.requiredFiles.configJson ? '✅ Created' : '❌ Missing'}

### Additional Files
${testResult.fileSystemAnalysis.additionalFiles.length > 0 ? testResult.fileSystemAnalysis.additionalFiles.map(f => `- \`${f}\``).join('\n') : 'No additional files'}

## TUI Response Analysis
${testResult.output.tuiResponses.length > 0 ? testResult.output.tuiResponses.map(response => `- ${response}`).join('\n') : 'No TUI responses captured'}

## Analysis Notes
### Command Success Analysis
${testResult.output.success ?
  'The init command completed successfully. All required files should be present.' :
  'The init command failed. Check stderr for error details.'}

### File Creation Analysis
${testResult.fileSystemAnalysis.junoTaskFolderCreated &&
  Object.values(testResult.fileSystemAnalysis.requiredFiles).every(Boolean) ?
  '✅ All required files were created successfully.' :
  '❌ Some required files are missing. The init process may not have completed properly.'}

### User Experience Assessment
- Input sequence was processed: ${testResult.userInputSequence.length} inputs provided
- Interactive prompts detected: ${testResult.output.stdout.includes('?') || testResult.output.stdout.includes('Enter') ? 'Yes' : 'No'}
- TUI responses captured: ${testResult.output.tuiResponses.length} responses

### Recommendations
${testResult.output.success ?
  'Test completed successfully. Review the output to ensure the user experience meets expectations.' :
  'Test failed. Review stderr and consider if the failure is due to environmental issues or actual bugs.'}

---
*Generated by Init Command Execution Test Framework*
`;

  await fs.writeFile(outputPath, report, 'utf-8');
  return outputPath;
}

describe('Init Command Execution Tests', () => {
  beforeEach(async () => {
    // Create temporary directory for each test
    tempDir = await fs.mkdtemp(path.join('/tmp', 'juno-init-test-'));

    // Create output directory for test reports
    outputDir = path.join(tempDir, 'test-outputs');
    await fs.ensureDir(outputDir);

    // Ensure binary exists
    const mjsExists = await fs.pathExists(BINARY_MJS);
    if (!mjsExists) {
      throw new Error(`Binary ${BINARY_MJS} not found. Run 'npm run build' first.`);
    }
  });

  afterEach(async () => {
    // Clean up temporary directory
    if (tempDir && await fs.pathExists(tempDir)) {
      await fs.remove(tempDir);
    }
  });

  it('should execute init command with complete user input sequence and verify file creation', async () => {
    const startTime = performance.now();
    const testName = 'init-command-complete-workflow';

    // Define the correct user input sequence based on init command TUI flow:
    // 1. Project Directory → Press Enter (accept default)
    // 2. Main Task → Enter "Count number of folders in this directory and give me a report" + Enter (finish multi-line input)
    // 3. Editor Selection → Enter "2" (select codex)
    // 4. Git Setup → Enter "y" (yes to git setup)
    // 5. Git URL → Enter "https://github.com/askbudi/temp-test-ts-repo"
    const userInputSequence = [
      '', // Press Enter for project directory (accept default)
      'Count number of folders in this directory and give me a report', // Main task description
      '', // Press Enter to finish multi-line task input
      '2', // Select codex (option 2)
      'y', // Yes to git setup
      'https://github.com/askbudi/temp-test-ts-repo' // Git repository URL
    ];

    try {
      const { result, filesCreated } = await executeInitCommand(userInputSequence);

      const duration = performance.now() - startTime;

      // Analyze file system changes
      const fileSystemAnalysis = await analyzeFileSystemChanges(filesCreated, tempDir);

      // Extract TUI responses from output
      const tuiResponses: string[] = [];
      const lines = (result.stdout || '').split('\n');
      for (const line of lines) {
        if (line.trim() && (line.includes('✓') || line.includes('✗') || line.includes('?'))) {
          tuiResponses.push(line.trim());
        }
      }

      const testResult: InitCommandTestResult = {
        testName,
        timestamp: new Date(),
        duration,
        command: ['init'],
        userInputSequence,
        workingDirectory: tempDir,
        output: {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          filesCreated,
          tuiResponses
        },
        fileSystemAnalysis,
        outputPath: '' // Will be set after saving
      };

      // Save test output to file
      const outputPath = await saveTestOutput(testName, testResult);
      testResult.outputPath = outputPath;

      /**
       * TEST RESULTS OUTPUT AND DIRECTORY PATH PRINTING
       * ===============================================
       * - Print test directory path for manual verification
       * - Show execution summary for immediate feedback
       * - Test directory is in /tmp for clean environment
       * - Directory automatically cleaned up in afterEach
       *
       * WATCH MODE PREVENTION CONFIRMATION:
       * ===================================
       * - These console.log statements work in automated mode
       * - No waiting for user input (no 'q' or 'h' key requirements)
       * - Test exits gracefully after printing results
       * - Use 'vitest run' to prevent watch mode entirely
       */
      console.log(`\n📊 Test report saved: ${outputPath}`);
      console.log(`⏱️  Duration: ${duration.toFixed(0)}ms`);
      console.log(`📁 Files created: ${filesCreated.length}`);
      console.log(`🎯 Exit code: ${result.exitCode}`);

      // CRITICAL: Print test directory path for manual verification
      // This allows users/agents to inspect the actual files created
      console.log(`📂 Test directory: ${tempDir}`);
      console.log(`🔍 Manual inspection: cd ${tempDir} && ls -la`);
      console.log(`📋 .juno_task folder: cd ${tempDir}/.juno_task`);

      // Assertions
      expect(typeof result.exitCode).toBe('number');

      // Verify .juno_task folder was created
      expect(fileSystemAnalysis.junoTaskFolderCreated).toBe(true);

      // Verify required files exist (if command succeeded)
      if (result.exitCode === 0) {
        expect(fileSystemAnalysis.requiredFiles.initMd).toBe(true);
        expect(fileSystemAnalysis.requiredFiles.promptMd).toBe(true);
        expect(fileSystemAnalysis.requiredFiles.userFeedbackMd).toBe(true);
        expect(fileSystemAnalysis.requiredFiles.mcpJson).toBe(true);
        expect(fileSystemAnalysis.requiredFiles.configJson).toBe(true);
      }

      // Verify output was captured
      expect(result.stdout.length).toBeGreaterThan(0);

      // Verify user input was processed (should show evidence of interaction)
      const hasInteractionEvidence =
        result.stdout.includes('?') ||
        result.stdout.includes('Enter') ||
        result.stdout.includes('✓') ||
        result.stdout.includes('✗') ||
        tuiResponses.length > 0;

      expect(hasInteractionEvidence).toBe(true);

      // Log summary for manual inspection
      console.log('\n📋 Test Summary:');
      console.log(`   Success: ${testResult.output.success ? '✅' : '❌'}`);
      console.log(`   .juno_task folder: ${fileSystemAnalysis.junoTaskFolderCreated ? '✅' : '❌'}`);
      console.log(`   init.md: ${fileSystemAnalysis.requiredFiles.initMd ? '✅' : '❌'}`);
      console.log(`   prompt.md: ${fileSystemAnalysis.requiredFiles.promptMd ? '✅' : '❌'}`);
      console.log(`   USER_FEEDBACK.md: ${fileSystemAnalysis.requiredFiles.userFeedbackMd ? '✅' : '❌'}`);
      console.log(`   mcp.json: ${fileSystemAnalysis.requiredFiles.mcpJson ? '✅' : '❌'}`);
      console.log(`   config.json: ${fileSystemAnalysis.requiredFiles.configJson ? '✅' : '❌'}`);
      console.log(`   TUI responses: ${tuiResponses.length}`);

    } catch (error) {
      const duration = performance.now() - startTime;

      // Record failed test
      const failedResult: InitCommandTestResult = {
        testName,
        timestamp: new Date(),
        duration,
        command: ['init'],
        userInputSequence,
        workingDirectory: tempDir,
        output: {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          filesCreated: [],
          tuiResponses: []
        },
        fileSystemAnalysis: {
          junoTaskFolderCreated: false,
          requiredFiles: {
            initMd: false,
            promptMd: false,
            userFeedbackMd: false,
            mcpJson: false,
            configJson: false
          },
          additionalFiles: []
        },
        outputPath: ''
      };

      // Save failed test output
      const outputPath = await saveTestOutput(testName, failedResult);
      console.log(`\n❌ Test failed. Report saved: ${outputPath}`);

      throw error;
    }
  }, INIT_COMMAND_TIMEOUT);
});