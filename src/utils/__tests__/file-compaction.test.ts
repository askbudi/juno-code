/**
 * Tests for file compaction utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import fs from 'fs-extra';
import {
  compactConfigFile,
  formatFileSize,
  shouldCompactFile,
  type CompactionResult,
  type CompactionOptions
} from '../file-compaction.js';

describe('File Compaction Utility', () => {
  const testDir = path.join(__dirname, '__temp_compaction_tests__');
  const testFilePath = path.join(testDir, 'test-config.md');

  // Sample CLAUDE.md-like content for testing
  const sampleContent = `# Sample Config File

### OPTIMIZED BUILD/TEST LOOP

\`\`\`bash
npm run build && node dist/bin/cli.mjs --help
\`\`\`

### CURRENT OPEN ISSUES - PRIORITY TASKS

**1. Critical Issue** (2024-10-16)
- This is an important issue that should be preserved
- Priority: High

### TEST PATTERNS & LEARNINGS

**TypeScript Import Debugging:**
- When importing enums/types, distinguish between type imports and value imports
- This section contains essential patterns

### 2024-10-10 — Old Resolved Issue

**<PREVIOUS_AGENT_ATTEMPT>**
- Issue: Some old bug that was fixed
- Root Cause: Ancient problem
- Status: ✅ RESOLVED - This should be removed

**Implementation Details:**
\`\`\`typescript
// Old code that's no longer relevant
const oldFunction = () => {};
\`\`\`

### 2023-12-01 — Very Old Historical Section

This is very old content from last year that should definitely be removed.

**Status**: ✅ RESOLVED - Ancient fix

### UX-FOCUSED TUI DEVELOPMENT PATTERNS

**Intuitive Keyboard Controls:**
- CRITICAL: Follow standard text editor conventions
- This section should be preserved as it's essential

### important-instruction-reminders

Do what has been asked; nothing more, nothing less.
This section should always be preserved.
`;

  beforeEach(async () => {
    await fs.ensureDir(testDir);
    await fs.writeFile(testFilePath, sampleContent, 'utf-8');
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  describe('compactConfigFile', () => {
    it('should compact file and create backup', async () => {
      const result = await compactConfigFile(testFilePath, {
        createBackup: true,
        dryRun: false,
        preserveDays: 30
      });

      expect(result).toMatchObject({
        originalSize: expect.any(Number),
        compactedSize: expect.any(Number),
        backupPath: expect.stringMatching(/test-config\.backup\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/),
        sectionsRemoved: expect.any(Array),
        sectionsPreserved: expect.any(Array),
        reductionPercentage: expect.any(Number)
      });

      // Verify backup exists
      expect(await fs.pathExists(result.backupPath)).toBe(true);

      // Verify original file still exists and is modified
      expect(await fs.pathExists(testFilePath)).toBe(true);

      // Check that compacted content is smaller
      expect(result.compactedSize).toBeLessThan(result.originalSize);
      expect(result.reductionPercentage).toBeGreaterThan(0);
    });

    it('should preserve essential sections', async () => {
      await compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: false,
        preserveDays: 30
      });

      const compactedContent = await fs.readFile(testFilePath, 'utf-8');

      // Should preserve essential sections
      expect(compactedContent).toContain('OPTIMIZED BUILD/TEST LOOP');
      expect(compactedContent).toContain('CURRENT OPEN ISSUES');
      expect(compactedContent).toContain('TEST PATTERNS & LEARNINGS');
      expect(compactedContent).toContain('UX-FOCUSED TUI DEVELOPMENT');
      expect(compactedContent).toContain('important-instruction-reminders');
      expect(compactedContent).toContain('CRITICAL: Follow standard text editor');

      // Should remove old historical sections
      expect(compactedContent).not.toContain('2023-12-01 — Very Old Historical Section');
      expect(compactedContent).not.toContain('Ancient fix');
    });

    it('should preserve recent historical sections', async () => {
      // Create content with recent date
      const recentDate = new Date().toISOString().split('T')[0]; // Today
      const contentWithRecentDate = sampleContent.replace(
        '2024-10-10 — Old Resolved Issue',
        `${recentDate} — Recent Resolved Issue`
      );
      await fs.writeFile(testFilePath, contentWithRecentDate, 'utf-8');

      await compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: false,
        preserveDays: 30
      });

      const compactedContent = await fs.readFile(testFilePath, 'utf-8');

      // Should preserve recent sections
      expect(compactedContent).toContain(`${recentDate} — Recent Resolved Issue`);

      // Should still remove very old sections
      expect(compactedContent).not.toContain('2023-12-01 — Very Old Historical Section');
    });

    it('should respect custom preserve patterns', async () => {
      await compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: false,
        preserveDays: 30,
        preservePatterns: ['Old Resolved Issue']
      });

      const compactedContent = await fs.readFile(testFilePath, 'utf-8');

      // Should preserve section matching custom pattern
      expect(compactedContent).toContain('2024-10-10 — Old Resolved Issue');
    });

    it('should work in dry run mode', async () => {
      const originalContent = await fs.readFile(testFilePath, 'utf-8');

      const result = await compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: true,
        preserveDays: 30
      });

      const currentContent = await fs.readFile(testFilePath, 'utf-8');

      // File should not be modified in dry run
      expect(currentContent).toBe(originalContent);

      // But should still return compaction results
      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.compactedSize).toBeGreaterThan(0);
    });

    it('should add compaction header', async () => {
      await compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: false,
        preserveDays: 30
      });

      const compactedContent = await fs.readFile(testFilePath, 'utf-8');
      const today = new Date().toISOString().split('T')[0];

      expect(compactedContent).toContain(`<!-- Last compacted: ${today} -->`);
    });
  });

  describe('shouldCompactFile', () => {
    it('should return true for large files', async () => {
      // Create a large file (> 50KB default threshold)
      const largeContent = 'A'.repeat(60 * 1024); // 60KB
      const largePath = path.join(testDir, 'large-file.md');
      await fs.writeFile(largePath, largeContent, 'utf-8');

      const shouldCompact = await shouldCompactFile(largePath, 50);
      expect(shouldCompact).toBe(true);
    });

    it('should return false for small files', async () => {
      // Use the sample content which is small
      const shouldCompact = await shouldCompactFile(testFilePath, 50);
      expect(shouldCompact).toBe(false);
    });

    it('should return false for non-existent files', async () => {
      const shouldCompact = await shouldCompactFile('/nonexistent/file.md', 50);
      expect(shouldCompact).toBe(false);
    });

    it('should use custom thresholds', async () => {
      // Test with very small threshold
      const shouldCompact = await shouldCompactFile(testFilePath, 0.001); // 1 byte
      expect(shouldCompact).toBe(true);
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(formatFileSize(0)).toBe('0 B');
      expect(formatFileSize(1023)).toBe('1023 B');
      expect(formatFileSize(1024)).toBe('1 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB'); // 1.5 * 1024
      expect(formatFileSize(1048576)).toBe('1 MB');
      expect(formatFileSize(1073741824)).toBe('1 GB');
    });
  });

  describe('compaction analysis', () => {
    it('should identify historical vs essential sections correctly', async () => {
      const result = await compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: true,
        preserveDays: 30
      });

      expect(result.sectionsPreserved).toContain('OPTIMIZED BUILD/TEST LOOP');
      expect(result.sectionsPreserved).toContain('CURRENT OPEN ISSUES - PRIORITY TASKS');
      expect(result.sectionsPreserved).toContain('TEST PATTERNS & LEARNINGS');
      expect(result.sectionsPreserved).toContain('UX-FOCUSED TUI DEVELOPMENT PATTERNS');

      expect(result.sectionsRemoved).toContain('2023-12-01 — Very Old Historical Section');
    });

    it('should handle malformed markdown gracefully', async () => {
      const malformedContent = `
# Broken File

### Missing closing sections
Some content without proper structure

### Another Section
More content

Random text without headers
`;

      await fs.writeFile(testFilePath, malformedContent, 'utf-8');

      // Should not throw error
      await expect(compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: false,
        preserveDays: 30
      })).resolves.toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty files', async () => {
      await fs.writeFile(testFilePath, '', 'utf-8');

      const result = await compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: false,
        preserveDays: 30
      });

      expect(result.originalSize).toBe(0);
      expect(result.compactedSize).toBeGreaterThan(0); // Header added
    });

    it('should handle files with only headers', async () => {
      const headersOnly = `
### Header 1
### Header 2
### Header 3
`;

      await fs.writeFile(testFilePath, headersOnly, 'utf-8');

      await expect(compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: false,
        preserveDays: 30
      })).resolves.toBeDefined();
    });

    it('should handle permission errors gracefully', async () => {
      // Mock fs.writeFile to throw permission error
      const mockWriteFile = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(
        new Error('EACCES: permission denied')
      );

      await expect(compactConfigFile(testFilePath, {
        createBackup: false,
        dryRun: false,
        preserveDays: 30
      })).rejects.toThrow('EACCES: permission denied');

      mockWriteFile.mockRestore();
    });
  });
});