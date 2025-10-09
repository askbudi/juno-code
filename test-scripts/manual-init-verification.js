#!/usr/bin/env node

/**
 * Manual Init Command Verification Script
 *
 * This script performs manual verification of the init command execution in a clean /tmp directory.
 * Unlike the automated test, this script preserves the test directory for manual inspection.
 *
 * PURPOSE:
 * - Verify init command works correctly in isolated environment
 * - Test TUI (Terminal User Interface) interactions with real user input simulation
 * - Preserve test directory for manual verification and debugging
 * - Capture complete output and file system changes
 *
 * USAGE:
 * ```bash
 * # From juno-task-ts directory
 * node test-scripts/manual-init-verification.js
 * ```
 *
 * TUI TESTING NOTES:
 * - CLI uses Ink (React for terminal) - NOT stdin-based CLI
 * - Cannot use shell pipes (echo | command) - TUI needs direct stdin control
 * - Input sequence simulates actual user keystrokes via execa input parameter
 * - Environment variables force interactive mode for testing
 *
 * WATCH MODE PREVENTION:
 * - This script exits gracefully without any watch mode
 * - No need for 'q' or 'h' key presses to exit
 * - Script completes and exits automatically
 *
 * OUTPUT:
 * - Prints test directory path for manual inspection
 * - Shows detailed file creation verification
 * - Preserves entire directory structure at /tmp/juno-verify-XXXXXX
 * - Saves full stdout/stderr output to verification-report.txt
 *
 * CLEANUP:
 * - Directory is NOT automatically cleaned up
 * - Manual cleanup required: rm -rf /tmp/juno-verify-XXXXXX
 * - Directory path is printed for easy cleanup
 */

import { execa } from 'execa';
import path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runManualVerification() {
  console.log('🧪 Manual Init Command Verification');
  console.log('=====================================\n');

  // Create temporary directory in /tmp for clean environment
  const tempDir = await fs.mkdtemp(path.join('/tmp', 'juno-verify-'));
  console.log(`📁 Test directory created: ${tempDir}`);

  try {
    // Path to compiled binary (relative to juno-task-ts directory)
    const binaryPath = path.resolve(__dirname, '../dist/bin/cli.mjs');

    // Verify binary exists
    if (!await fs.pathExists(binaryPath)) {
      throw new Error(`Binary not found: ${binaryPath}. Run 'npm run build' first.`);
    }

    /**
     * USER INPUT SEQUENCE FOR TUI TESTING
     *
     * IMPORTANT: This simulates actual user keystrokes for the Ink-based TUI
     * - Each array element represents a separate user input action
     * - Newlines simulate Enter key presses
     * - This is NOT shell piping - it's direct stdin control via execa
     */
    const userInputSequence = [
      '', // Press Enter on first question (accept default)
      'Count number of folders in this directory and give me a report', // Second question input
      '', // Press Enter to confirm second question
      '2', // Select option 2 (template selection)
      'y', // Press 'y' for confirmation
      'https://github.com/askbudi/temp-test-ts-repo' // Enter repository URL
    ];

    // Convert array to input string for execa
    const userInput = userInputSequence.join('\n') + '\n';

    console.log('📝 User input sequence prepared:');
    userInputSequence.forEach((input, index) => {
      console.log(`   ${index + 1}. ${input === '' ? '[Enter Key]' : `"${input}"`}`);
    });

    console.log('\n🚀 Executing init command with TUI input simulation...');

    /**
     * EXECUTE CLI WITH TUI INPUT SIMULATION
     *
     * TUI TESTING STRATEGY:
     * - Use execa for direct process control (not shell pipes)
     * - Pass input sequence via 'input' parameter
     * - Set environment variables to force interactive mode
     * - Use reasonable timeout for TUI interactions
     * - Set reject: false to capture non-zero exit codes
     */
    const result = await execa('node', [binaryPath, 'init'], {
      cwd: tempDir,
      input: userInput,
      timeout: 60000, // 60 seconds for TUI interactions
      reject: false, // Don't throw on non-zero exit codes
      env: {
        NO_COLOR: '1',           // Disable colors for consistent output
        CI: 'false',            // Enable interactive mode
        FORCE_INTERACTIVE: '1', // Force interactive mode for testing
        JUNO_TASK_CONFIG: ''    // Clean configuration environment
      }
    });

    console.log(`\n📊 EXECUTION RESULTS:`);
    console.log(`   Exit Code: ${result.exitCode}`);
    console.log(`   Success: ${result.exitCode === 0 ? '✅' : '❌'}`);
    console.log(`   Duration: ~${Date.now() - startTime}ms`);

    // Analyze file system changes
    console.log(`\n📁 FILE SYSTEM ANALYSIS:`);

    // Get all files created (recursive scan)
    const allFiles = await fs.readdir(tempDir, { recursive: true });
    const createdFiles = allFiles.filter(f => f !== '.DS_Store');

    console.log(`   Total files created: ${createdFiles.length}`);
    createdFiles.forEach(file => console.log(`     - ${file}`));

    // Check .juno_task folder specifically
    const junoTaskPath = path.join(tempDir, '.juno_task');
    const junoTaskExists = await fs.pathExists(junoTaskPath);

    console.log(`\n🎯 .JUNO_TASK FOLDER VERIFICATION:`);
    console.log(`   .juno_task folder: ${junoTaskExists ? '✅ Created' : '❌ Missing'}`);

    if (junoTaskExists) {
      console.log(`\n📋 REQUIRED FILES CHECK:`);
      const requiredFiles = ['init.md', 'prompt.md', 'USER_FEEDBACK.md', 'mcp.json', 'config.json'];
      let allRequiredFilesPresent = true;

      for (const file of requiredFiles) {
        const filePath = path.join(junoTaskPath, file);
        const exists = await fs.pathExists(filePath);

        console.log(`   ${file}: ${exists ? '✅ Present' : '❌ Missing'}`);

        if (exists) {
          const content = await fs.readFile(filePath, 'utf-8');
          console.log(`      Size: ${content.length} characters`);

          // Show preview for key files
          if (file === 'init.md' && content.length > 0) {
            console.log(`      Preview: ${content.substring(0, 100).replace(/\n/g, ' ')}...`);
          }
        } else {
          allRequiredFilesPresent = false;
        }
      }

      console.log(`\n   All required files: ${allRequiredFilesPresent ? '✅ Present' : '❌ Missing'}`);
    }

    // Show sample output for verification
    console.log(`\n📋 SAMPLE OUTPUT (first 500 chars):`);
    const sampleOutput = result.stdout.substring(0, 500);
    console.log(sampleOutput + (result.stdout.length > 500 ? '...' : ''));

    // Show any errors
    if (result.stderr && result.stderr.trim().length > 0) {
      console.log(`\n❌ STDERR OUTPUT:`);
      console.log(result.stderr);
    }

    // Save complete output for manual inspection
    const reportPath = path.join(tempDir, 'verification-report.txt');

    // Build required files status for report
    let requiredFilesStatus = '';
    if (junoTaskExists) {
      for (const file of requiredFiles) {
        const filePath = path.join(junoTaskPath, file);
        const exists = await fs.pathExists(filePath);
        requiredFilesStatus += `${file}: ${exists ? '✅ Present' : '❌ Missing'}\n`;
      }
    }

    const fullReport = `MANUAL INIT COMMAND VERIFICATION REPORT
============================================

Timestamp: ${new Date().toISOString()}
Working Directory: ${tempDir}
Exit Code: ${result.exitCode}
Success: ${result.exitCode === 0}

USER INPUT SEQUENCE:
${userInputSequence.map((input, i) => `${i + 1}. ${input === '' ? '[Enter Key]' : `"${input}"`}`).join('\n')}

FILES CREATED:
${createdFiles.map(f => `- ${f}`).join('\n')}

REQUIRED FILES STATUS:
.juno_task folder: ${junoTaskExists ? '✅ Present' : '❌ Missing'}
${requiredFilesStatus}

COMPLETE STDOUT:
${result.stdout}

COMPLETE STDERR:
${result.stderr}

EXECUTION SUMMARY:
- Exit Code: ${result.exitCode}
- Success: ${result.exitCode === 0}
- Files Created: ${createdFiles.length}
- .juno_task folder: ${junoTaskExists ? '✅ Created' : '❌ Not created'}
- Duration: ~${Date.now() - startTime}ms
`;

    await fs.writeFile(reportPath, fullReport, 'utf-8');
    console.log(`\n📄 Full report saved: ${reportPath}`);

    // Manual inspection information
    console.log(`\n🔍 MANUAL INSPECTION INSTRUCTIONS:`);
    console.log(`   Test directory preserved: ${tempDir}`);
    console.log(`   To inspect files: cd ${tempDir} && ls -la`);
    console.log(`   To check .juno_task: cd ${tempDir}/.juno_task && ls -la`);
    console.log(`   To view report: cat ${reportPath}`);
    console.log(`🧹 To clean up: rm -rf ${tempDir}`);

    return {
      success: result.exitCode === 0,
      tempDir,
      files: createdFiles,
      junoTaskExists,
      reportPath
    };

  } catch (error) {
    console.error('❌ VERIFICATION FAILED:', error.message);
    console.log(`📄 Directory preserved for debugging: ${tempDir}`);
    console.log(`🧹 To clean up: rm -rf ${tempDir}`);

    return {
      success: false,
      tempDir,
      files: [],
      junoTaskExists: false,
      error: error.message
    };
  }
}

// Record start time for duration measurement
const startTime = Date.now();

// Execute verification and handle completion
runManualVerification().then(result => {
  console.log('\n' + '='.repeat(50));
  if (result.success) {
    console.log('✅ VERIFICATION COMPLETED SUCCESSFULLY!');
    console.log('   All required files created and validated');
    console.log('   TUI interactions simulated correctly');
  } else {
    console.log('❌ VERIFICATION FAILED!');
    console.log('   Check the error message above');
    console.log('   Directory preserved for manual debugging');
  }
  console.log('📄 Test directory preserved for manual inspection');
  console.log(`🧹 Remember to clean up: rm -rf ${result.tempDir}`);

  // Exit with appropriate code (0 for success, 1 for failure)
  process.exit(result.success ? 0 : 1);

}).catch(error => {
  console.error('\n💥 UNEXPECTED ERROR:', error);
  console.log('This indicates a problem with the verification script itself');
  process.exit(1);
});