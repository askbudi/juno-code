/**
 * Feedback Archival System for USER_FEEDBACK.md
 *
 * This module provides functionality to archive resolved issues from USER_FEEDBACK.md
 * while keeping the file lean and manageable. It preserves historical data in yearly
 * archive files and warns users when too many open issues accumulate.
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';

export interface ArchivalStats {
  archivedCount: number;
  openIssuesCount: number;
  archiveFile: string;
  warningsGenerated: string[];
}

export interface ArchivalOptions {
  feedbackFile: string;
  archiveDir?: string;
  openIssuesThreshold?: number;
  dryRun?: boolean;
  verbose?: boolean;
}

/**
 * Archive resolved issues from USER_FEEDBACK.md to yearly archive files
 */
export async function archiveResolvedIssues(options: ArchivalOptions): Promise<ArchivalStats> {
  const {
    feedbackFile,
    archiveDir = path.join(path.dirname(feedbackFile), 'archives'),
    openIssuesThreshold = 10,
    dryRun = false,
    verbose = false
  } = options;

  // Ensure feedback file exists
  if (!(await fs.pathExists(feedbackFile))) {
    throw new Error(`Feedback file does not exist: ${feedbackFile}`);
  }

  // Read and parse USER_FEEDBACK.md
  const content = await fs.readFile(feedbackFile, 'utf-8');
  const parsed = parseUserFeedback(content);

  // Count open issues and generate warnings
  const warningsGenerated: string[] = [];
  if (parsed.openIssues.length > openIssuesThreshold) {
    const warning = `Found ${parsed.openIssues.length} open issues (threshold: ${openIssuesThreshold}). Consider reviewing and prioritizing.`;
    warningsGenerated.push(warning);

    // Log warning to file
    const logFile = path.join(path.dirname(feedbackFile), 'logs', 'feedback-warnings.log');
    await fs.ensureDir(path.dirname(logFile));
    const timestamp = new Date().toISOString();
    await fs.appendFile(logFile, `[${timestamp}] ${warning}\n`);
  }

  // If no resolved issues, return early
  if (parsed.resolvedIssues.length === 0) {
    if (verbose) {
      console.log(chalk.yellow('📋 No resolved issues found to archive'));
    }

    return {
      archivedCount: 0,
      openIssuesCount: parsed.openIssues.length,
      archiveFile: '',
      warningsGenerated
    };
  }

  // Generate archive file path for current year
  const currentYear = new Date().getFullYear();
  const archiveFile = path.join(archiveDir, `USER_FEEDBACK_archive_${currentYear}.md`);

  if (!dryRun) {
    // Ensure archive directory exists
    await fs.ensureDir(archiveDir);

    // Archive resolved issues
    await appendToArchive(archiveFile, parsed.resolvedIssues);

    // Update USER_FEEDBACK.md to contain only open issues
    const compactedContent = generateCompactedFeedback(parsed.openIssues, parsed.metadata);
    await fs.writeFile(feedbackFile, compactedContent, 'utf-8');
  }

  if (verbose) {
    console.log(chalk.green(`✅ Archived ${parsed.resolvedIssues.length} resolved issues`));
    console.log(chalk.gray(`   Archive: ${archiveFile}`));
    console.log(chalk.gray(`   Remaining open issues: ${parsed.openIssues.length}`));

    if (warningsGenerated.length > 0) {
      console.log(chalk.yellow(`⚠️  ${warningsGenerated.length} warning(s) generated`));
    }
  }

  return {
    archivedCount: parsed.resolvedIssues.length,
    openIssuesCount: parsed.openIssues.length,
    archiveFile,
    warningsGenerated
  };
}

/**
 * Parse USER_FEEDBACK.md content into structured data
 */
function parseUserFeedback(content: string): {
  openIssues: string[];
  resolvedIssues: string[];
  metadata: string;
} {
  const openIssues: string[] = [];
  const resolvedIssues: string[] = [];
  let metadata = '';

  // Extract open issues section
  const openIssuesMatch = content.match(/<OPEN_ISSUES>([\s\S]*?)<\/OPEN_ISSUES>/);
  if (openIssuesMatch) {
    const openIssuesContent = openIssuesMatch[1];
    const issueMatches = openIssuesContent.match(/<ISSUE>[\s\S]*?<\/ISSUE>/g) || [];

    for (const issueMatch of issueMatches) {
      openIssues.push(issueMatch.trim());
    }
  }

  // Extract resolved issues sections
  const resolvedMatches = content.match(/<RESOLVED_ISSUE>[\s\S]*?<\/RESOLVED_ISSUE>/g) || [];
  for (const resolvedMatch of resolvedMatches) {
    resolvedIssues.push(resolvedMatch.trim());
  }

  // Extract metadata (everything before OPEN_ISSUES and after resolved issues)
  const beforeOpenIssues = content.split('<OPEN_ISSUES>')[0] || '';
  const afterResolvedIssues = content.split(/<\/RESOLVED_ISSUE>[\s\S]*?$/)[0] || content;

  // Find the last resolved issue end and get everything after
  const lastResolvedEnd = content.lastIndexOf('</RESOLVED_ISSUE>');
  let headerMetadata = beforeOpenIssues.trim();

  // If there's a header before open issues, use it
  if (headerMetadata) {
    metadata = headerMetadata;
  } else {
    // Fallback to basic header
    metadata = '## Open Issues';
  }

  return { openIssues, resolvedIssues, metadata };
}

/**
 * Append resolved issues to archive file
 */
async function appendToArchive(archiveFile: string, resolvedIssues: string[]): Promise<void> {
  const timestamp = new Date().toISOString().split('T')[0];
  let archiveContent = '';

  // Check if archive file exists
  if (await fs.pathExists(archiveFile)) {
    archiveContent = await fs.readFile(archiveFile, 'utf-8');
  } else {
    // Create new archive with header
    const year = path.basename(archiveFile).match(/(\d{4})/)?.[1] || new Date().getFullYear();
    archiveContent = `# User Feedback Archive ${year}

This file contains resolved issues that have been archived from USER_FEEDBACK.md to keep the main file lean.

## Archive Index

- Total archived issues: ${resolvedIssues.length}
- Last updated: ${timestamp}

---

`;
  }

  // Append resolved issues with archival timestamp
  for (const resolvedIssue of resolvedIssues) {
    archiveContent += `\n${resolvedIssue}\n<!-- Archived on ${timestamp} -->\n\n`;
  }

  // Update archive index if it exists
  if (archiveContent.includes('## Archive Index')) {
    const currentCount = (archiveContent.match(/<RESOLVED_ISSUE>/g) || []).length;
    archiveContent = archiveContent.replace(
      /- Total archived issues: \d+/,
      `- Total archived issues: ${currentCount}`
    );
    archiveContent = archiveContent.replace(
      /- Last updated: [\d-]+/,
      `- Last updated: ${timestamp}`
    );
  }

  await fs.writeFile(archiveFile, archiveContent, 'utf-8');
}

/**
 * Generate compacted USER_FEEDBACK.md with only open issues
 */
function generateCompactedFeedback(openIssues: string[], metadata: string): string {
  let content = metadata.trim() + '\n';

  if (!content.includes('## Open Issues')) {
    content = '## Open Issues\n';
  }

  content += '<OPEN_ISSUES>\n';

  if (openIssues.length === 0) {
    content += '   <!-- No open issues -->\n';
  } else {
    for (const issue of openIssues) {
      content += '\n' + issue + '\n';
    }
  }

  content += '</OPEN_ISSUES>\n\n## Resolved Issues - VALIDATED FIXES ONLY\n\n<!-- Resolved issues have been archived to preserve space -->\n<!-- Check .juno_task/archives/ for historical resolved issues -->\n';

  return content;
}

/**
 * Count open issues in USER_FEEDBACK.md
 */
export async function countOpenIssues(feedbackFile: string): Promise<number> {
  if (!(await fs.pathExists(feedbackFile))) {
    return 0;
  }

  const content = await fs.readFile(feedbackFile, 'utf-8');
  const parsed = parseUserFeedback(content);
  return parsed.openIssues.length;
}

/**
 * Check if archival is needed based on thresholds
 */
export async function shouldArchive(feedbackFile: string, options: {
  openIssuesThreshold?: number;
  fileSizeThreshold?: number;
  lineCountThreshold?: number;
} = {}): Promise<{
  shouldArchive: boolean;
  reasons: string[];
  stats: {
    openIssuesCount: number;
    resolvedIssuesCount: number;
    fileSizeBytes: number;
    lineCount: number;
  };
}> {
  const {
    openIssuesThreshold = 10,
    fileSizeThreshold = 50 * 1024, // 50KB
    lineCountThreshold = 500
  } = options;

  if (!(await fs.pathExists(feedbackFile))) {
    return {
      shouldArchive: false,
      reasons: [],
      stats: { openIssuesCount: 0, resolvedIssuesCount: 0, fileSizeBytes: 0, lineCount: 0 }
    };
  }

  const content = await fs.readFile(feedbackFile, 'utf-8');
  const stats = await fs.stat(feedbackFile);
  const parsed = parseUserFeedback(content);
  const lineCount = content.split('\n').length;

  const reasons: string[] = [];

  if (parsed.resolvedIssues.length > 0) {
    reasons.push(`${parsed.resolvedIssues.length} resolved issues can be archived`);
  }

  if (parsed.openIssues.length > openIssuesThreshold) {
    reasons.push(`${parsed.openIssues.length} open issues exceeds threshold (${openIssuesThreshold})`);
  }

  if (stats.size > fileSizeThreshold) {
    reasons.push(`File size ${(stats.size / 1024).toFixed(1)}KB exceeds threshold (${fileSizeThreshold / 1024}KB)`);
  }

  if (lineCount > lineCountThreshold) {
    reasons.push(`Line count ${lineCount} exceeds threshold (${lineCountThreshold})`);
  }

  return {
    shouldArchive: reasons.length > 0,
    reasons,
    stats: {
      openIssuesCount: parsed.openIssues.length,
      resolvedIssuesCount: parsed.resolvedIssues.length,
      fileSizeBytes: stats.size,
      lineCount
    }
  };
}