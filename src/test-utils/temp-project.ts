/**
 * Temporary project utilities for testing
 */

import fs from 'fs-extra';
import path from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

/**
 * Create a temporary project directory with basic structure
 */
export async function createTempProject(): Promise<string> {
  const tempDir = path.join(tmpdir(), `juno-task-test-${uuidv4()}`);
  await fs.ensureDir(tempDir);

  // Create basic juno-task structure
  const junoTaskDir = path.join(tempDir, '.juno_task');
  await fs.ensureDir(junoTaskDir);

  // Create a basic init.md file
  const initContent = `# Test Project

This is a test project for juno-task testing.

## Task Description
Test task for validation purposes.
`;
  await fs.writeFile(path.join(junoTaskDir, 'init.md'), initContent);

  // Create basic USER_FEEDBACK.md
  const feedbackContent = `## Open Issues
<OPEN_ISSUES>
</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY
<RESOLVED_ISSUES>
</RESOLVED_ISSUES>
`;
  await fs.writeFile(path.join(junoTaskDir, 'USER_FEEDBACK.md'), feedbackContent);

  return tempDir;
}

/**
 * Clean up temporary project directory
 */
export async function cleanupTempProject(tempDir: string): Promise<void> {
  try {
    await fs.remove(tempDir);
  } catch (error) {
    // Ignore cleanup errors
    console.warn(`Failed to cleanup temp directory ${tempDir}:`, error);
  }
}

/**
 * Create a large file for testing preflight functionality
 */
export async function createLargeFile(filePath: string, lineCount: number): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const content = Array(lineCount).fill('# Test line for preflight testing\n').join('');
  await fs.writeFile(filePath, content);
}