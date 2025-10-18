/**
 * Preflight Tests Utility
 *
 * Automated checks that run before each subagent iteration to ensure
 * configuration files and feedback file remain lean and manageable.
 */

import fs from 'fs-extra';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compactConfigFile, shouldCompactFile, formatFileSize } from './file-compaction.js';
import { archiveResolvedIssues, shouldArchive } from './feedback-archival.js';

export interface PreflightConfig {
  /** Threshold for file line count (default: 500) */
  threshold: number;
  /** Whether preflight tests are enabled (default: true) */
  enabled: boolean;
  /** Path to project directory */
  projectPath: string;
  /** Subagent type for determining config file */
  subagent: string;
}

export interface PreflightResult {
  /** Whether any preflight tests were triggered */
  triggered: boolean;
  /** Actions taken during preflight tests */
  actions: PreflightAction[];
}

export interface PreflightAction {
  /** Type of action taken */
  type: 'config_compaction' | 'feedback_compaction' | 'feedback_archival';
  /** File that was checked */
  file: string;
  /** Current line count */
  lineCount: number;
  /** Threshold that was exceeded */
  threshold: number;
  /** Feedback command that was run */
  feedbackCommand?: string;
  /** Compaction results if file was compacted */
  compactionResult?: {
    originalSize: number;
    compactedSize: number;
    reductionPercentage: number;
    backupPath: string;
  };
  /** Archival results if feedback was archived */
  archivalResult?: {
    archivedCount: number;
    openIssuesCount: number;
    archiveFile: string;
    warningsGenerated: string[];
  };
}

/**
 * Get preflight configuration from environment variables
 */
export function getPreflightConfig(projectPath: string, subagent: string): PreflightConfig {
  return {
    threshold: parseInt(process.env.JUNO_PREFLIGHT_THRESHOLD || '500', 10),
    enabled: process.env.JUNO_PREFLIGHT_DISABLED !== 'true',
    projectPath,
    subagent
  };
}

/**
 * Get the appropriate config file for the subagent
 */
function getConfigFile(subagent: string): string {
  const lowerSubagent = subagent.toLowerCase();
  if (lowerSubagent === 'claude') {
    return 'CLAUDE.md';
  } else {
    return 'AGENTS.md';
  }
}

/**
 * Count lines in a file
 */
async function countLines(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.split('\n').length;
  } catch (error) {
    // File doesn't exist or can't be read
    return 0;
  }
}

/**
 * Find the CLI executable path using multiple strategies
 */
function findCliPath(projectPath: string): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Try multiple CLI resolution strategies in order of preference
  const possiblePaths = [
    // 1. Relative to current file (for development/installed package)
    path.resolve(__dirname, '../..', 'dist', 'bin', 'cli.mjs'),
    // 2. Relative to project path (for test environments)
    path.resolve(projectPath, 'node_modules', 'juno-task-ts', 'dist', 'bin', 'cli.mjs'),
    // 3. Current working directory (for when running from project root)
    path.resolve(process.cwd(), 'dist', 'bin', 'cli.mjs'),
    // 4. Project path dist (for test setups that copy the CLI)
    path.resolve(projectPath, 'dist', 'bin', 'cli.mjs')
  ];

  // Find the first path that exists
  for (const cliPath of possiblePaths) {
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  }

  // Fall back to the first path (relative to current file)
  // This will still work if the CLI is globally installed via 'juno-ts-task'
  return possiblePaths[0];
}

/**
 * Run feedback command with specific message
 */
async function runFeedbackCommand(projectPath: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cliPath = findCliPath(projectPath);

    // Check if CLI exists, otherwise try using global command
    const useGlobalCommand = !fs.existsSync(cliPath);

    let child;
    if (useGlobalCommand) {
      // Try using global 'juno-ts-task' command
      child = spawn('juno-ts-task', [
        'feedback',
        '--issue',
        message
      ], {
        cwd: projectPath,
        stdio: 'pipe',
        shell: true
      });
    } else {
      // Use local CLI path
      child = spawn('node', [
        cliPath,
        'feedback',
        '--issue',
        message
      ], {
        cwd: projectPath,
        stdio: 'pipe',
        shell: false
      });
    }

    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const errorMsg = `Feedback command failed with exit code ${code}${stderr ? `\nStderr: ${stderr}` : ''}`;
        reject(new Error(errorMsg));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Check if a config file needs compaction and compact it directly
 */
async function checkAndCompactConfigFile(
  projectPath: string,
  filePath: string,
  threshold: number
): Promise<PreflightAction | null> {
  const fullPath = path.join(projectPath, filePath);
  const lineCount = await countLines(fullPath);

  // Check if file needs compaction (convert line threshold to size threshold)
  const needsCompaction = await shouldCompactFile(fullPath, 30); // 30KB threshold

  if (lineCount > threshold && needsCompaction) {
    try {
      // FIRST: Trigger feedback command with specific message format
      const feedbackMessage = `File ${filePath} is becoming big, you need to compact it and keep it lean.`;
      console.log(`\n⚠️  Triggering feedback for ${filePath} (${lineCount} lines > ${threshold} threshold)...`);

      try {
        await runFeedbackCommand(projectPath, feedbackMessage);
        console.log(`✅ Feedback command executed successfully for ${filePath}`);
      } catch (feedbackError) {
        console.warn(`Warning: Feedback command failed for ${filePath}:`, feedbackError);
        // Continue with automatic compaction even if feedback fails
      }

      // THEN: Auto-compact the file
      console.log(`\n🗜️  Auto-compacting ${filePath} (${lineCount} lines > ${threshold} threshold)...`);

      const result = await compactConfigFile(fullPath, {
        createBackup: true,
        dryRun: false,
        preserveDays: 30,
        preservePatterns: [
          'CRITICAL',
          'OPEN ISSUES',
          'BUILD.*LOOP',
          'TEST PATTERNS',
          'UX.*TUI',
          'important-instruction-reminders'
        ]
      });

      console.log(`✅ ${filePath} compacted: ${formatFileSize(result.originalSize)} → ${formatFileSize(result.compactedSize)} (${result.reductionPercentage}% reduction)`);

      return {
        type: 'config_compaction',
        file: filePath,
        lineCount,
        threshold,
        feedbackCommand: `feedback --issue "${feedbackMessage}"`,
        compactionResult: {
          originalSize: result.originalSize,
          compactedSize: result.compactedSize,
          reductionPercentage: result.reductionPercentage,
          backupPath: result.backupPath
        }
      };
    } catch (error) {
      console.warn(`Failed to compact ${filePath}:`, error);
      return null;
    }
  }

  return null;
}

/**
 * Check if a feedback file needs archival and perform archival
 */
async function checkAndArchiveFeedbackFile(
  projectPath: string,
  filePath: string,
  threshold: number
): Promise<PreflightAction | null> {
  const fullPath = path.join(projectPath, filePath);
  const lineCount = await countLines(fullPath);

  // Check if archival is needed using the archival system
  const archivalCheck = await shouldArchive(fullPath, {
    openIssuesThreshold: 10,
    fileSizeThreshold: 50 * 1024, // 50KB
    lineCountThreshold: threshold
  });

  if (archivalCheck.shouldArchive) {
    try {
      // FIRST: Trigger feedback command with specific message format
      const feedbackMessage = `File ${filePath} is becoming big, you need to compact it and keep it lean.`;
      console.log(`\n⚠️  Triggering feedback for ${filePath} (${archivalCheck.reasons.join(', ')})...`);

      try {
        await runFeedbackCommand(projectPath, feedbackMessage);
        console.log(`✅ Feedback command executed successfully for ${filePath}`);
      } catch (feedbackError) {
        console.warn(`Warning: Feedback command failed for ${filePath}:`, feedbackError);
        // Continue with automatic archival even if feedback fails
      }

      // THEN: Auto-archive the file
      console.log(`\n📋 Auto-archiving ${filePath} (${archivalCheck.reasons.join(', ')})...`);

      // Perform archival
      const archivalResult = await archiveResolvedIssues({
        feedbackFile: fullPath,
        archiveDir: path.join(path.dirname(fullPath), 'archives'),
        openIssuesThreshold: 10,
        dryRun: false,
        verbose: false
      });

      console.log(`✅ ${filePath} archived: ${archivalResult.archivedCount} resolved issues → ${archivalResult.archiveFile}`);
      console.log(`   Remaining open issues: ${archivalResult.openIssuesCount}`);

      if (archivalResult.warningsGenerated.length > 0) {
        console.log(`⚠️  Warnings: ${archivalResult.warningsGenerated.join(', ')}`);
      }

      return {
        type: 'feedback_archival',
        file: filePath,
        lineCount,
        threshold,
        feedbackCommand: `feedback --issue "${feedbackMessage}"`,
        archivalResult: {
          archivedCount: archivalResult.archivedCount,
          openIssuesCount: archivalResult.openIssuesCount,
          archiveFile: archivalResult.archiveFile,
          warningsGenerated: archivalResult.warningsGenerated
        }
      };
    } catch (error) {
      console.warn(`Failed to archive ${filePath}:`, error);

      // Fallback to feedback command if archival fails
      try {
        const feedbackMessage = `File ${filePath} is becoming big, you need to compact it and keep it lean.`;
        await runFeedbackCommand(projectPath, feedbackMessage);

        return {
          type: 'feedback_compaction',
          file: filePath,
          lineCount,
          threshold,
          feedbackCommand: `feedback --issue "${feedbackMessage}"`
        };
      } catch (fallbackError) {
        console.warn(`Failed to run fallback feedback command for ${filePath}:`, fallbackError);
        return null;
      }
    }
  }

  return null;
}

/**
 * Run preflight tests before subagent iteration
 */
export async function runPreflightTests(config: PreflightConfig): Promise<PreflightResult> {
  const result: PreflightResult = {
    triggered: false,
    actions: []
  };

  // Skip if disabled
  if (!config.enabled) {
    return result;
  }

  // Check config file (CLAUDE.md or AGENTS.md) and compact directly
  const configFile = getConfigFile(config.subagent);
  const configAction = await checkAndCompactConfigFile(
    config.projectPath,
    configFile,
    config.threshold
  );

  if (configAction) {
    result.triggered = true;
    result.actions.push(configAction);
  }

  // Check USER_FEEDBACK.md and archive resolved issues automatically
  const feedbackAction = await checkAndArchiveFeedbackFile(
    config.projectPath,
    '.juno_task/USER_FEEDBACK.md',
    config.threshold
  );

  if (feedbackAction) {
    result.triggered = true;
    result.actions.push(feedbackAction);
  }

  // Log summary if actions were taken
  if (result.triggered) {
    console.log(`\n🔍 Preflight tests triggered ${result.actions.length} action(s):`);
    for (const action of result.actions) {
      if (action.type === 'feedback_archival') {
        console.log(`  📋 ${action.file}: Archived ${action.archivalResult?.archivedCount || 0} resolved issues`);
      } else {
        console.log(`  📝 ${action.file}: ${action.lineCount} lines (threshold: ${action.threshold})`);
      }
    }
    console.log('');
  } else {
    // Log that preflight tests ran but no actions were needed
    console.log(`\n🔍 Preflight tests: No actions needed (all files within ${config.threshold} line threshold)\n`);
  }

  return result;
}