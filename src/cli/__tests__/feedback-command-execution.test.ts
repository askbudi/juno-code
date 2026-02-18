/**
 * Feedback Command Execution Test
 *
 * This test evaluates the feedback command with command-line arguments (headless mode)
 * to test the complete non-interactive workflow.
 *
 * Test Flow:
 * 1. Create isolated test environment in /tmp directory
 * 2. Execute feedback command with command-line arguments
 * 3. Verify USER_FEEDBACK.md is created with correct structure
 * 4. Validate XML formatting and content
 * 5. Generate test report
 * 6. Clean up temporary directory
 *
 * USAGE:
 * ======
 * ```bash
 * # Build project first
 * npm run build
 *
 * # Run test
 * npx vitest run src/cli/__tests__/feedback-command-execution.test.ts
 * ```
 *
 * OUTPUT:
 * ======
 * - Test directory path printed for manual verification: /tmp/juno-feedback-test-XXXXXX
 * - Detailed report generated: /tmp/juno-feedback-test-XXXXXX/test-outputs/feedback-command-*.md
 * - USER_FEEDBACK.md validated with proper XML structure
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa, type ExecaReturnValue } from 'execa';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { performance } from 'node:perf_hooks';

// Binary path for testing
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const BINARY_MJS = path.join(PROJECT_ROOT, 'dist/bin/cli.mjs');

// Test timeout for feedback command
const FEEDBACK_COMMAND_TIMEOUT = 30000; // 30 seconds

// Test environment
let tempDir: string;
let outputDir: string;

interface FeedbackCommandTestResult {
  testName: string;
  timestamp: Date;
  duration: number;
  command: string[];
  workingDirectory: string;
  output: {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    filesCreated: string[];
  };
  fileSystemAnalysis: {
    junoTaskFolderCreated: boolean;
    userFeedbackMd: boolean;
    feedbackContent: string;
  };
  contentValidation: {
    hasOpenIssues: boolean;
    hasIssueTag: boolean;
    hasTestCriteria: boolean;
    hasDate: boolean;
    issueContent: string;
    testCriteriaContent: string;
  };
  outputPath: string;
}

/**
 * Execute feedback command with command line arguments
 */
async function executeFeedbackCommandWithArgs(
  commandArgs: string[],
  options: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  } = {}
): Promise<{ result: ExecaReturnValue; filesCreated: string[] }> {
  const {
    timeout = FEEDBACK_COMMAND_TIMEOUT,
    cwd = tempDir,
    env = {}
  } = options;

  // Record files before execution
  const filesBefore = await getDirectoryFiles(cwd);

  // Set up environment for testing
  const testEnv = {
    ...process.env,
    NO_COLOR: '1',
    NODE_ENV: 'development',
    JUNO_CODE_CONFIG: '',
    JUNO_TASK_CONFIG: '', // Backward compatibility
    ...env
  };

  try {
    const result = await execa('node', [BINARY_MJS, ...commandArgs], {
      cwd,
      env: testEnv,
      timeout,
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
 * Analyze file system changes and verify USER_FEEDBACK.md
 */
async function analyzeFileSystemChanges(
  filesCreated: string[],
  workingDir: string
): Promise<FeedbackCommandTestResult['fileSystemAnalysis']> {
  const junoTaskPath = path.join(workingDir, '.juno_task');
  const junoTaskFolderCreated = await fs.pathExists(junoTaskPath);
  const userFeedbackPath = path.join(junoTaskPath, 'USER_FEEDBACK.md');
  const userFeedbackMd = await fs.pathExists(userFeedbackPath);

  let feedbackContent = '';
  if (userFeedbackMd) {
    feedbackContent = await fs.readFile(userFeedbackPath, 'utf-8');
  }

  return {
    junoTaskFolderCreated,
    userFeedbackMd,
    feedbackContent
  };
}

/**
 * Validate feedback content structure
 */
function validateFeedbackContent(
  content: string,
  expectedIssue?: string,
  expectedTestCriteria?: string
): FeedbackCommandTestResult['contentValidation'] {
  const hasOpenIssues = content.includes('<OPEN_ISSUES>') || content.includes('<OPEN_ISSUES>');
  const hasIssueTag = /<ISSUE>[\s\S]*?<\/ISSUE>/.test(content);
  const hasTestCriteria = /<Test_CRITERIA>[\s\S]*?<\/Test_CRITERIA>/.test(content);
  const hasDate = /<DATE>\d{4}-\d{2}-\d{2}<\/DATE>/.test(content);

  // Extract issue content
  const issueMatch = content.match(/<ISSUE>([\s\S]*?)<\/ISSUE>/);
  const issueContent = issueMatch ? issueMatch[1].trim() : '';

  // Extract test criteria content
  const testCriteriaMatch = content.match(/<Test_CRITERIA>([\s\S]*?)<\/Test_CRITERIA>/);
  const testCriteriaContent = testCriteriaMatch ? testCriteriaMatch[1].trim() : '';

  return {
    hasOpenIssues,
    hasIssueTag,
    hasTestCriteria,
    hasDate,
    issueContent,
    testCriteriaContent
  };
}

/**
 * Save test output to file for analysis
 */
async function saveTestOutput(
  testName: string,
  testResult: FeedbackCommandTestResult
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFileName = `${testName}-${timestamp}.md`;
  const outputPath = path.join(outputDir, outputFileName);

  const report = `# Feedback Command Execution Test Report

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

### USER_FEEDBACK.md Status
${testResult.fileSystemAnalysis.userFeedbackMd ? '✅ Created' : '❌ Missing'}

## Content Validation

### XML Structure
- **Has OPEN_ISSUES tag**: ${testResult.contentValidation.hasOpenIssues ? '✅' : '❌'}
- **Has ISSUE tag**: ${testResult.contentValidation.hasIssueTag ? '✅' : '❌'}
- **Has Test_CRITERIA tag**: ${testResult.contentValidation.hasTestCriteria ? '✅' : '❌'}
- **Has DATE tag**: ${testResult.contentValidation.hasDate ? '✅' : '❌'}

### Issue Content
\`\`\`
${testResult.contentValidation.issueContent || 'No issue content found'}
\`\`\`

### Test Criteria Content
\`\`\`
${testResult.contentValidation.testCriteriaContent || 'No test criteria found'}
\`\`\`

## Analysis Notes
### Command Success Analysis
${testResult.output.success ?
  'The feedback command completed successfully. USER_FEEDBACK.md should be present with proper structure.' :
  'The feedback command failed. Check stderr for error details.'}

### File Creation Analysis
${testResult.fileSystemAnalysis.junoTaskFolderCreated && testResult.fileSystemAnalysis.userFeedbackMd ?
  '✅ USER_FEEDBACK.md was created successfully.' :
  '❌ USER_FEEDBACK.md is missing. The feedback process may not have completed properly.'}

### Content Validation Analysis
${testResult.contentValidation.hasOpenIssues &&
  testResult.contentValidation.hasIssueTag &&
  testResult.contentValidation.hasDate ?
  '✅ Feedback content structure is correct.' :
  '❌ Feedback content structure is invalid or incomplete.'}

### Recommendations
${testResult.output.success && testResult.fileSystemAnalysis.userFeedbackMd &&
  testResult.contentValidation.hasIssueTag && testResult.contentValidation.hasDate ?
  'Test completed successfully. Review the output to ensure the feedback was saved correctly.' :
  'Test failed. Review stderr and consider if the failure is due to environmental issues or actual bugs.'}

---
*Generated by Feedback Command Execution Test Framework*
`;

  await fs.writeFile(outputPath, report, 'utf-8');
  return outputPath;
}

describe('Feedback Command Execution Tests', () => {
  beforeEach(async () => {
    // Create temporary directory for each test
    tempDir = await fs.mkdtemp(path.join('/tmp', 'juno-feedback-test-'));

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
      if (process.env.PRESERVE_TMP === '1') {
        // eslint-disable-next-line no-console
        console.log(`🛑 PRESERVE_TMP=1 set. Temp kept at: ${tempDir}`);
      } else {
        await fs.remove(tempDir);
      }
    }
  });

  it('should execute feedback command with issue and test criteria flags', async () => {
    const startTime = performance.now();
    const testName = 'feedback-command-with-criteria';

    const commandArgs = [
      'feedback',
      '--issue', 'This is a test issue description',
      '--test', 'This is the test criteria for validation'
    ];

    try {
      const { result, filesCreated } = await executeFeedbackCommandWithArgs(commandArgs);

      const duration = performance.now() - startTime;

      // Analyze file system changes
      const fileSystemAnalysis = await analyzeFileSystemChanges(filesCreated, tempDir);

      // Validate content
      const contentValidation = validateFeedbackContent(
        fileSystemAnalysis.feedbackContent,
        'This is a test issue description',
        'This is the test criteria for validation'
      );

      const testResult: FeedbackCommandTestResult = {
        testName,
        timestamp: new Date(),
        duration,
        command: commandArgs,
        workingDirectory: tempDir,
        output: {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          filesCreated
        },
        fileSystemAnalysis,
        contentValidation,
        outputPath: ''
      };

      // Save test output to file
      const outputPath = await saveTestOutput(testName, testResult);
      testResult.outputPath = outputPath;

      // eslint-disable-next-line no-console
      console.log(`\n📊 Test report saved: ${outputPath}`);
      // eslint-disable-next-line no-console
      console.log(`⏱️  Duration: ${duration.toFixed(0)}ms`);
      // eslint-disable-next-line no-console
      console.log(`📁 Files created: ${filesCreated.length}`);
      // eslint-disable-next-line no-console
      console.log(`🎯 Exit code: ${result.exitCode}`);
      // eslint-disable-next-line no-console
      console.log(`📂 Test directory: ${tempDir}`);

      // Assertions
      expect(typeof result.exitCode).toBe('number');

      // Verify .juno_task folder was created
      expect(fileSystemAnalysis.junoTaskFolderCreated).toBe(true);

      // Verify USER_FEEDBACK.md exists
      expect(fileSystemAnalysis.userFeedbackMd).toBe(true);

      // Verify content structure
      expect(contentValidation.hasOpenIssues).toBe(true);
      expect(contentValidation.hasIssueTag).toBe(true);
      expect(contentValidation.hasTestCriteria).toBe(true);
      expect(contentValidation.hasDate).toBe(true);

      // Verify issue content
      expect(contentValidation.issueContent).toContain('This is a test issue description');

      // Verify test criteria content
      expect(contentValidation.testCriteriaContent).toContain('This is the test criteria for validation');

      // eslint-disable-next-line no-console
      console.log('\n📋 Test Summary:');
      // eslint-disable-next-line no-console
      console.log(`   Success: ${testResult.output.success ? '✅' : '❌'}`);
      // eslint-disable-next-line no-console
      console.log(`   .juno_task folder: ${fileSystemAnalysis.junoTaskFolderCreated ? '✅' : '❌'}`);
      // eslint-disable-next-line no-console
      console.log(`   USER_FEEDBACK.md: ${fileSystemAnalysis.userFeedbackMd ? '✅' : '❌'}`);
      // eslint-disable-next-line no-console
      console.log(`   Issue content: ${contentValidation.hasIssueTag ? '✅' : '❌'}`);
      // eslint-disable-next-line no-console
      console.log(`   Test criteria: ${contentValidation.hasTestCriteria ? '✅' : '❌'}`);

    } catch (error) {
      const duration = performance.now() - startTime;

      // Record failed test
      const failedResult: FeedbackCommandTestResult = {
        testName,
        timestamp: new Date(),
        duration,
        command: commandArgs,
        workingDirectory: tempDir,
        output: {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          filesCreated: []
        },
        fileSystemAnalysis: {
          junoTaskFolderCreated: false,
          userFeedbackMd: false,
          feedbackContent: ''
        },
        contentValidation: {
          hasOpenIssues: false,
          hasIssueTag: false,
          hasTestCriteria: false,
          hasDate: false,
          issueContent: '',
          testCriteriaContent: ''
        },
        outputPath: ''
      };

      // Save failed test output
      const outputPath = await saveTestOutput(testName, failedResult);
      // eslint-disable-next-line no-console
      console.log(`\n❌ Test failed. Report saved: ${outputPath}`);

      throw error;
    }
  }, FEEDBACK_COMMAND_TIMEOUT);

  it('should execute feedback command with issue only (no test criteria)', async () => {
    const startTime = performance.now();
    const testName = 'feedback-command-issue-only';

    const commandArgs = [
      'feedback',
      '--issue', 'This is a test issue without test criteria'
    ];

    try {
      const { result, filesCreated } = await executeFeedbackCommandWithArgs(commandArgs);

      const duration = performance.now() - startTime;

      // Analyze file system changes
      const fileSystemAnalysis = await analyzeFileSystemChanges(filesCreated, tempDir);

      // Validate content
      const contentValidation = validateFeedbackContent(
        fileSystemAnalysis.feedbackContent,
        'This is a test issue without test criteria'
      );

      // Verify USER_FEEDBACK.md exists
      expect(fileSystemAnalysis.userFeedbackMd).toBe(true);

      // Verify content structure (should NOT have test criteria)
      expect(contentValidation.hasOpenIssues).toBe(true);
      expect(contentValidation.hasIssueTag).toBe(true);
      expect(contentValidation.hasTestCriteria).toBe(false); // Should NOT have test criteria
      expect(contentValidation.hasDate).toBe(true);

      // Verify issue content
      expect(contentValidation.issueContent).toContain('This is a test issue without test criteria');

      // eslint-disable-next-line no-console
      console.log(`\n✅ Test completed: ${testName}`);
      // eslint-disable-next-line no-console
      console.log(`📂 Test directory: ${tempDir}`);

    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(`\n❌ Test failed: ${testName}`);
      throw error;
    }
  }, FEEDBACK_COMMAND_TIMEOUT);
});
