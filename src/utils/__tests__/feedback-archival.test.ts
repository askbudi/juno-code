/**
 * Comprehensive tests for feedback archival system
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';

import {
  archiveResolvedIssues,
  countOpenIssues,
  shouldArchive,
  type ArchivalStats,
  type ArchivalOptions
} from '../feedback-archival.js';

describe('Feedback Archival System', () => {
  const testDir = path.join(__dirname, '../../__temp_test__');
  const feedbackFile = path.join(testDir, 'USER_FEEDBACK.md');
  const archiveDir = path.join(testDir, 'archives');

  beforeEach(async () => {
    // Clean up test directory
    await fs.remove(testDir);
    await fs.ensureDir(testDir);
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.remove(testDir);
  });

  describe('archiveResolvedIssues', () => {
    test('should archive resolved issues and preserve open issues', async () => {
      // Create test feedback file with mixed content
      const feedbackContent = `## Open Issues
<OPEN_ISSUES>

   <ISSUE>
      This is an open issue
      <Test_CRITERIA>Should be resolved</Test_CRITERIA>
      <DATE>2025-10-16</DATE>
   </ISSUE>

   <ISSUE>
      Another open issue
      <DATE>2025-10-16</DATE>
   </ISSUE>

</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

<RESOLVED_ISSUE>
   **Test Issue 1** - RESOLVED 2025-10-15

   This was a test issue that got resolved.

   **Fix Applied**: Test fix was applied successfully.

   **Test Criteria**: ✅ PASSED - Test was successful
</RESOLVED_ISSUE>

<RESOLVED_ISSUE>
   **Test Issue 2** - RESOLVED 2025-10-14

   Another resolved issue for testing.

   **Fix Applied**: Another test fix.
</RESOLVED_ISSUE>`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      // Archive resolved issues
      const options: ArchivalOptions = {
        feedbackFile,
        archiveDir,
        openIssuesThreshold: 10,
        dryRun: false,
        verbose: false
      };

      const result = await archiveResolvedIssues(options);

      // Verify results
      expect(result.archivedCount).toBe(2);
      expect(result.openIssuesCount).toBe(2);
      expect(result.archiveFile).toContain('USER_FEEDBACK_archive_2025.md');

      // Verify archive file was created
      expect(await fs.pathExists(result.archiveFile)).toBe(true);

      // Verify archive file content
      const archiveContent = await fs.readFile(result.archiveFile, 'utf-8');
      expect(archiveContent).toContain('**Test Issue 1** - RESOLVED 2025-10-15');
      expect(archiveContent).toContain('**Test Issue 2** - RESOLVED 2025-10-14');
      expect(archiveContent).toContain('Archive Index');
      expect(archiveContent).toContain('Total archived issues: 2');

      // Verify USER_FEEDBACK.md was compacted
      const updatedContent = await fs.readFile(feedbackFile, 'utf-8');
      expect(updatedContent).toContain('This is an open issue');
      expect(updatedContent).toContain('Another open issue');
      expect(updatedContent).not.toContain('**Test Issue 1**');
      expect(updatedContent).not.toContain('**Test Issue 2**');
      expect(updatedContent).toContain('Check .juno_task/archives/ for historical resolved issues');
    });

    test('should handle empty resolved issues gracefully', async () => {
      // Create feedback file with only open issues
      const feedbackContent = `## Open Issues
<OPEN_ISSUES>

   <ISSUE>
      Only open issue
      <DATE>2025-10-16</DATE>
   </ISSUE>

</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

<!-- No resolved issues yet -->`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const options: ArchivalOptions = {
        feedbackFile,
        archiveDir,
        verbose: true
      };

      const result = await archiveResolvedIssues(options);

      expect(result.archivedCount).toBe(0);
      expect(result.openIssuesCount).toBe(1);
      expect(result.archiveFile).toBe('');
    });

    test('should generate warnings for excessive open issues', async () => {
      // Create feedback with many open issues
      let feedbackContent = `## Open Issues
<OPEN_ISSUES>

`;

      // Add 15 open issues (above threshold of 10)
      for (let i = 1; i <= 15; i++) {
        feedbackContent += `   <ISSUE>
      Open issue ${i}
      <DATE>2025-10-16</DATE>
   </ISSUE>

`;
      }

      feedbackContent += `</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const options: ArchivalOptions = {
        feedbackFile,
        archiveDir,
        openIssuesThreshold: 10
      };

      const result = await archiveResolvedIssues(options);

      expect(result.openIssuesCount).toBe(15);
      expect(result.warningsGenerated).toHaveLength(1);
      expect(result.warningsGenerated[0]).toContain('Found 15 open issues (threshold: 10)');

      // Verify warning was logged
      const logFile = path.join(testDir, 'logs', 'feedback-warnings.log');
      expect(await fs.pathExists(logFile)).toBe(true);
      const logContent = await fs.readFile(logFile, 'utf-8');
      expect(logContent).toContain('Found 15 open issues');
    });

    test('should handle dry run mode', async () => {
      const feedbackContent = `## Open Issues
<OPEN_ISSUES>
   <ISSUE>
      Test issue
      <DATE>2025-10-16</DATE>
   </ISSUE>
</OPEN_ISSUES>

<RESOLVED_ISSUE>
   **Test Issue** - RESOLVED 2025-10-15
   Test resolved issue.
</RESOLVED_ISSUE>`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const options: ArchivalOptions = {
        feedbackFile,
        archiveDir,
        dryRun: true
      };

      const result = await archiveResolvedIssues(options);

      expect(result.archivedCount).toBe(1);
      expect(result.openIssuesCount).toBe(1);

      // Verify no files were actually modified in dry run
      const currentYear = new Date().getFullYear();
      const expectedArchive = path.join(archiveDir, `USER_FEEDBACK_archive_${currentYear}.md`);
      expect(await fs.pathExists(expectedArchive)).toBe(false);

      // Original file should be unchanged
      const originalContent = await fs.readFile(feedbackFile, 'utf-8');
      expect(originalContent).toContain('**Test Issue** - RESOLVED 2025-10-15');
    });

    test('should append to existing archive file', async () => {
      // Create existing archive
      const currentYear = new Date().getFullYear();
      const archiveFile = path.join(archiveDir, `USER_FEEDBACK_archive_${currentYear}.md`);
      const existingArchive = `# User Feedback Archive ${currentYear}

This file contains resolved issues that have been archived from USER_FEEDBACK.md to keep the main file lean.

## Archive Index

- Total archived issues: 1
- Last updated: 2025-10-15

---

<RESOLVED_ISSUE>
   **Existing Issue** - RESOLVED 2025-10-15
   This was already archived.
</RESOLVED_ISSUE>
<!-- Archived on 2025-10-15 -->

`;

      await fs.ensureDir(archiveDir);
      await fs.writeFile(archiveFile, existingArchive, 'utf-8');

      // Create new feedback with resolved issue
      const feedbackContent = `## Open Issues
<OPEN_ISSUES>
</OPEN_ISSUES>

<RESOLVED_ISSUE>
   **New Issue** - RESOLVED 2025-10-16
   This is a new resolved issue.
</RESOLVED_ISSUE>`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const options: ArchivalOptions = {
        feedbackFile,
        archiveDir,
        dryRun: false
      };

      const result = await archiveResolvedIssues(options);

      expect(result.archivedCount).toBe(1);

      // Verify archive was appended to
      const updatedArchive = await fs.readFile(archiveFile, 'utf-8');
      expect(updatedArchive).toContain('**Existing Issue**');
      expect(updatedArchive).toContain('**New Issue**');
      expect(updatedArchive).toContain('Total archived issues: 2');
    });

    test('should throw error for non-existent feedback file', async () => {
      const options: ArchivalOptions = {
        feedbackFile: path.join(testDir, 'nonexistent.md'),
        archiveDir
      };

      await expect(archiveResolvedIssues(options)).rejects.toThrow('Feedback file does not exist');
    });
  });

  describe('countOpenIssues', () => {
    test('should count open issues correctly', async () => {
      const feedbackContent = `## Open Issues
<OPEN_ISSUES>

   <ISSUE>
      Issue 1
      <DATE>2025-10-16</DATE>
   </ISSUE>

   <ISSUE>
      Issue 2
      <Test_CRITERIA>Test criteria</Test_CRITERIA>
      <DATE>2025-10-16</DATE>
   </ISSUE>

   <ISSUE>
      Issue 3
      <DATE>2025-10-16</DATE>
   </ISSUE>

</OPEN_ISSUES>`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const count = await countOpenIssues(feedbackFile);
      expect(count).toBe(3);
    });

    test('should return 0 for non-existent file', async () => {
      const count = await countOpenIssues(path.join(testDir, 'nonexistent.md'));
      expect(count).toBe(0);
    });

    test('should return 0 for empty open issues section', async () => {
      const feedbackContent = `## Open Issues
<OPEN_ISSUES>
   <!-- No open issues -->
</OPEN_ISSUES>`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const count = await countOpenIssues(feedbackFile);
      expect(count).toBe(0);
    });
  });

  describe('shouldArchive', () => {
    test('should recommend archival when resolved issues exist', async () => {
      const feedbackContent = `## Open Issues
<OPEN_ISSUES>
   <ISSUE>
      Open issue
      <DATE>2025-10-16</DATE>
   </ISSUE>
</OPEN_ISSUES>

<RESOLVED_ISSUE>
   **Resolved Issue** - RESOLVED 2025-10-15
   This was resolved.
</RESOLVED_ISSUE>`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const result = await shouldArchive(feedbackFile);

      expect(result.shouldArchive).toBe(true);
      expect(result.reasons).toContain('1 resolved issues can be archived');
      expect(result.stats.openIssuesCount).toBe(1);
      expect(result.stats.resolvedIssuesCount).toBe(1);
    });

    test('should recommend archival when open issues exceed threshold', async () => {
      let feedbackContent = `## Open Issues
<OPEN_ISSUES>

`;

      // Add 12 open issues
      for (let i = 1; i <= 12; i++) {
        feedbackContent += `   <ISSUE>
      Open issue ${i}
      <DATE>2025-10-16</DATE>
   </ISSUE>

`;
      }

      feedbackContent += `</OPEN_ISSUES>`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const result = await shouldArchive(feedbackFile, { openIssuesThreshold: 10 });

      expect(result.shouldArchive).toBe(true);
      expect(result.reasons.some(r => r.includes('12 open issues exceeds threshold (10)'))).toBe(true);
      expect(result.stats.openIssuesCount).toBe(12);
    });

    test('should recommend archival when file size exceeds threshold', async () => {
      // Create large feedback content
      const largeContent = `## Open Issues
<OPEN_ISSUES>
   <ISSUE>
      ${'This is a very long issue description. '.repeat(1000)}
      <DATE>2025-10-16</DATE>
   </ISSUE>
</OPEN_ISSUES>`;

      await fs.writeFile(feedbackFile, largeContent, 'utf-8');

      const result = await shouldArchive(feedbackFile, { fileSizeThreshold: 10 * 1024 }); // 10KB

      expect(result.shouldArchive).toBe(true);
      expect(result.reasons.some(r => r.includes('exceeds threshold'))).toBe(true);
      expect(result.stats.fileSizeBytes).toBeGreaterThan(10 * 1024);
    });

    test('should not recommend archival when no conditions are met', async () => {
      const feedbackContent = `## Open Issues
<OPEN_ISSUES>
   <ISSUE>
      Single issue
      <DATE>2025-10-16</DATE>
   </ISSUE>
</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY

<!-- No resolved issues -->`;

      await fs.writeFile(feedbackFile, feedbackContent, 'utf-8');

      const result = await shouldArchive(feedbackFile);

      expect(result.shouldArchive).toBe(false);
      expect(result.reasons).toHaveLength(0);
      expect(result.stats.openIssuesCount).toBe(1);
      expect(result.stats.resolvedIssuesCount).toBe(0);
    });

    test('should handle non-existent file', async () => {
      const result = await shouldArchive(path.join(testDir, 'nonexistent.md'));

      expect(result.shouldArchive).toBe(false);
      expect(result.reasons).toHaveLength(0);
      expect(result.stats.openIssuesCount).toBe(0);
      expect(result.stats.resolvedIssuesCount).toBe(0);
      expect(result.stats.fileSizeBytes).toBe(0);
      expect(result.stats.lineCount).toBe(0);
    });
  });

  describe('XML parsing edge cases', () => {
    test('should handle malformed XML gracefully', async () => {
      const malformedContent = `## Open Issues
<OPEN_ISSUES>

   <ISSUE>
      Unclosed issue
      <DATE>2025-10-16</DATE>
   <!-- Missing closing tag -->

   <ISSUE>
      Valid issue
      <DATE>2025-10-16</DATE>
   </ISSUE>

</OPEN_ISSUES>

<RESOLVED_ISSUE>
   **Partial resolved issue** - RESOLVED 2025-10-15
   This has no closing tag`;

      await fs.writeFile(feedbackFile, malformedContent, 'utf-8');

      const count = await countOpenIssues(feedbackFile);
      expect(count).toBe(1); // Should find the valid issue

      const shouldArchiveResult = await shouldArchive(feedbackFile);
      expect(shouldArchiveResult.stats.resolvedIssuesCount).toBe(0); // Malformed resolved issue ignored
    });

    test('should handle empty sections', async () => {
      const emptyContent = `## Open Issues
<OPEN_ISSUES>
</OPEN_ISSUES>

## Resolved Issues - VALIDATED FIXES ONLY
`;

      await fs.writeFile(feedbackFile, emptyContent, 'utf-8');

      const options: ArchivalOptions = {
        feedbackFile,
        archiveDir
      };

      const result = await archiveResolvedIssues(options);

      expect(result.archivedCount).toBe(0);
      expect(result.openIssuesCount).toBe(0);
      expect(result.archiveFile).toBe('');
    });

    test('should preserve complex issue structure', async () => {
      const complexContent = `## Open Issues
<OPEN_ISSUES>

   <ISSUE>
      Interactive Feedback Command TUI Mode
      Interactive feedback command, should have the same functionality as the headless mode of feedback command
      and it should provide a multiline input for the Issue, and also multiline Optional input for the test criteria

      <Test_CRITERIA>
         Read @.juno_task/specs/TEST_EXECUTABLE.md
         You need to similar to init ui, run a TUI test. with graceful exit.
         and analyze the response of the feedback command based on the user feedback file.
         Similar to init test, use a test project in tmp folder.
         INIT Command is getting tested using
         \`\`\` - TUI: npm --prefix juno-code run test:tui
         - Binary: npm --prefix juno-code run test:binary\`\`\`

         You need to create and executre and test feedback by creating similar tests
         and name it test:feedback
         Use preserve tmp and check the files afterward. to make sure command perfrom the job correctly.
      </Test_CRITERIA>
      <DATE>2025-10-16</DATE>
   </ISSUE>

</OPEN_ISSUES>`;

      await fs.writeFile(feedbackFile, complexContent, 'utf-8');

      const count = await countOpenIssues(feedbackFile);
      expect(count).toBe(1);

      // Archive and verify structure is preserved
      const options: ArchivalOptions = {
        feedbackFile,
        archiveDir
      };

      const result = await archiveResolvedIssues(options);

      // Should preserve the complex open issue
      const updatedContent = await fs.readFile(feedbackFile, 'utf-8');
      expect(updatedContent).toContain('Interactive Feedback Command TUI Mode');
      expect(updatedContent).toContain('<Test_CRITERIA>');
      expect(updatedContent).toContain('npm --prefix juno-code run test:tui');
    });
  });
});