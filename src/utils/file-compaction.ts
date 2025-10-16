/**
 * File Compaction Utility for {configFile}.md files (CLAUDE.md/AGENTS.md)
 *
 * Compacts large configuration files by removing historical/resolved content
 * while preserving essential information that agents need on each run.
 */

import * as path from 'node:path';
import fs from 'fs-extra';

export interface CompactionResult {
  originalSize: number;
  compactedSize: number;
  backupPath: string;
  sectionsRemoved: string[];
  sectionsPreserved: string[];
  reductionPercentage: number;
}

export interface CompactionOptions {
  createBackup?: boolean;
  dryRun?: boolean;
  preserveDays?: number; // Keep content newer than this many days
  preservePatterns?: string[]; // Regex patterns to always preserve
}

/**
 * Compacts a config file by removing historical/resolved content
 */
export async function compactConfigFile(
  filePath: string,
  options: CompactionOptions = {}
): Promise<CompactionResult> {
  const {
    createBackup = true,
    dryRun = false,
    preserveDays = 30,
    preservePatterns = []
  } = options;

  // Read original file
  const originalContent = await fs.readFile(filePath, 'utf-8');
  const originalSize = originalContent.length;

  // Create backup before compaction
  let backupPath = '';
  if (createBackup && !dryRun) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);
    const dirname = path.dirname(filePath);
    backupPath = path.join(dirname, `${basename}.backup.${timestamp}${ext}`);
    await fs.writeFile(backupPath, originalContent, 'utf-8');
  }

  // Parse and compact content
  const compactionAnalysis = analyzeMarkdownStructure(originalContent);
  const compactedContent = compactMarkdownContent(
    originalContent,
    compactionAnalysis,
    preserveDays,
    preservePatterns
  );

  // Add compaction header
  const headerComment = `<!-- Last compacted: ${new Date().toISOString().split('T')[0]} -->\n`;
  const finalContent = headerComment + compactedContent;

  const compactedSize = finalContent.length;
  const reductionPercentage = Math.round(((originalSize - compactedSize) / originalSize) * 100);

  // Write compacted content (unless dry run)
  if (!dryRun) {
    await fs.writeFile(filePath, finalContent, 'utf-8');
  }

  return {
    originalSize,
    compactedSize,
    backupPath,
    sectionsRemoved: compactionAnalysis.removableSections,
    sectionsPreserved: compactionAnalysis.essentialSections,
    reductionPercentage
  };
}

interface MarkdownSection {
  title: string;
  content: string;
  startLine: number;
  endLine: number;
  isEssential: boolean;
  isHistorical: boolean;
  containsDate: boolean;
  dateFound?: Date;
}

interface CompactionAnalysis {
  sections: MarkdownSection[];
  essentialSections: string[];
  removableSections: string[];
}

/**
 * Analyzes markdown structure to identify essential vs historical sections
 */
function analyzeMarkdownStructure(content: string): CompactionAnalysis {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  const essentialSections: string[] = [];
  const removableSections: string[] = [];

  let currentSection: Partial<MarkdownSection> = {};
  let sectionLines: string[] = [];
  let lineIndex = 0;

  // Essential patterns that should always be preserved
  const essentialPatterns = [
    /OPTIMIZED BUILD\/TEST LOOP/i,
    /CURRENT OPEN ISSUES/i,
    /TEST PATTERNS/i,
    /UX-FOCUSED TUI/i,
    /Build\/Test Quick Notes/i,
    /CRITICAL:/i,
    /important-instruction-reminders/i
  ];

  // Historical patterns that can be removed if old enough
  const historicalPatterns = [
    /RESOLVED/i,
    /^### \d{4}-\d{2}-\d{2}/,  // Date-based sections
    /PREVIOUS_AGENT_ATTEMPT/i,
    /Status.*✅/i,
    /DOCUMENTATION INTEGRITY FAILURE/i
  ];

  // Process each line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for section headers (### or ##)
    const headerMatch = line.match(/^(#{2,3})\s+(.+)$/);

    if (headerMatch) {
      // Save previous section
      if (currentSection.title) {
        const section = finalizeSection(currentSection, sectionLines, lineIndex - sectionLines.length, i - 1);
        sections.push(section);

        if (section.isEssential) {
          essentialSections.push(section.title);
        } else if (section.isHistorical) {
          removableSections.push(section.title);
        }
      }

      // Start new section
      currentSection = {
        title: headerMatch[2].trim(),
        startLine: i
      };
      sectionLines = [line];
    } else {
      sectionLines.push(line);
    }

    lineIndex = i;
  }

  // Handle last section
  if (currentSection.title) {
    const section = finalizeSection(currentSection, sectionLines, lineIndex - sectionLines.length + 1, lineIndex);
    sections.push(section);

    if (section.isEssential) {
      essentialSections.push(section.title);
    } else if (section.isHistorical) {
      removableSections.push(section.title);
    }
  }

  return { sections, essentialSections, removableSections };

  function finalizeSection(
    section: Partial<MarkdownSection>,
    lines: string[],
    startLine: number,
    endLine: number
  ): MarkdownSection {
    const content = lines.join('\n');
    const title = section.title || 'Untitled Section';

    // Check if section is essential
    const isEssential = essentialPatterns.some(pattern =>
      pattern.test(title) || pattern.test(content)
    );

    // Check if section is historical
    const isHistorical = historicalPatterns.some(pattern =>
      pattern.test(title) || pattern.test(content)
    );

    // Extract date if present
    const dateMatch = content.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const dateFound = dateMatch ? new Date(dateMatch[1]) : undefined;
    const containsDate = !!dateFound;

    return {
      title,
      content,
      startLine,
      endLine,
      isEssential,
      isHistorical,
      containsDate,
      dateFound
    };
  }
}

/**
 * Compacts markdown content by removing historical sections
 */
function compactMarkdownContent(
  content: string,
  analysis: CompactionAnalysis,
  preserveDays: number,
  preservePatterns: string[]
): string {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - preserveDays);

  const compiledPatterns = preservePatterns.map(pattern => new RegExp(pattern, 'i'));

  let compactedContent = '';
  const lines = content.split('\n');

  for (const section of analysis.sections) {
    let shouldPreserve = false;

    // Always preserve essential sections
    if (section.isEssential) {
      shouldPreserve = true;
    }
    // Preserve recent historical sections
    else if (section.isHistorical && section.dateFound && section.dateFound > cutoffDate) {
      shouldPreserve = true;
    }
    // Preserve sections matching custom patterns
    else if (compiledPatterns.some(pattern =>
      pattern.test(section.title) || pattern.test(section.content)
    )) {
      shouldPreserve = true;
    }
    // Remove old historical sections
    else if (section.isHistorical && section.dateFound && section.dateFound <= cutoffDate) {
      shouldPreserve = false;
    }
    // Default: preserve unless clearly historical
    else if (!section.isHistorical) {
      shouldPreserve = true;
    }

    if (shouldPreserve) {
      // Extract section content from original lines
      const sectionLines = lines.slice(section.startLine, section.endLine + 1);
      compactedContent += sectionLines.join('\n') + '\n\n';
    }
  }

  return compactedContent.trim();
}

/**
 * Get file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Check if a file needs compaction based on size or age
 */
export async function shouldCompactFile(
  filePath: string,
  sizeThresholdKB: number = 50,
  ageThresholdDays: number = 30
): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    const sizeKB = stats.size / 1024;

    // Check size threshold
    if (sizeKB > sizeThresholdKB) {
      return true;
    }

    // Check age threshold
    const daysSinceModified = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceModified > ageThresholdDays) {
      return true;
    }

    return false;
  } catch (error) {
    return false; // File doesn't exist or can't be accessed
  }
}