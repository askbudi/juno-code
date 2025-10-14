/**
 * Preflight Tests Utility
 *
 * Automated checks that run before each subagent iteration to ensure
 * configuration files and feedback file remain lean and manageable.
 */

import fs from 'fs-extra';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

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
  type: 'config_compaction' | 'feedback_compaction';
  /** File that was checked */
  file: string;
  /** Current line count */
  lineCount: number;
  /** Threshold that was exceeded */
  threshold: number;
  /** Feedback command that was run */
  feedbackCommand?: string;
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
 * Run feedback command with specific message
 */
async function runFeedbackCommand(projectPath: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(projectPath, 'dist', 'bin', 'cli.mjs');
    const feedbackCommand = `node "${cliPath}" feedback --issue "${message}"`;

    const child = spawn('node', [
      path.join(projectPath, 'dist', 'bin', 'cli.mjs'),
      'feedback',
      '--issue',
      message
    ], {
      cwd: projectPath,
      stdio: 'pipe',
      shell: false
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Feedback command failed with exit code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Check if a file needs compaction and run feedback command if needed
 */
async function checkAndCompactFile(
  projectPath: string,
  filePath: string,
  threshold: number,
  feedbackMessage: string,
  fileType: 'config' | 'feedback'
): Promise<PreflightAction | null> {
  const fullPath = path.join(projectPath, filePath);
  const lineCount = await countLines(fullPath);

  if (lineCount > threshold) {
    try {
      await runFeedbackCommand(projectPath, feedbackMessage);

      return {
        type: fileType === 'config' ? 'config_compaction' : 'feedback_compaction',
        file: filePath,
        lineCount,
        threshold,
        feedbackCommand: `feedback --issue "${feedbackMessage}"`
      };
    } catch (error) {
      console.warn(`Failed to run feedback command for ${filePath}:`, error);
      return null;
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

  // Check config file (CLAUDE.md or AGENTS.md)
  const configFile = getConfigFile(config.subagent);
  const configAction = await checkAndCompactFile(
    config.projectPath,
    configFile,
    config.threshold,
    `[System Feedback]{configFile}.md is very large, you need to compact it. And keep essential information that the agent needs on each run, remember this file is not a place to save project updates and progress and you need to keep it compacts and right to the point.`,
    'config'
  );

  if (configAction) {
    result.triggered = true;
    result.actions.push(configAction);
  }

  // Check USER_FEEDBACK.md
  const feedbackAction = await checkAndCompactFile(
    config.projectPath,
    '.juno_task/USER_FEEDBACK.md',
    config.threshold,
    `@.juno_task/USER_FEEDBACK.md needs to kept lean, and any verified Resolved Issue should archive from this file. Compact this file and remember to keep the OPEN ISSUES as it is. If there are many open issues, Give user a warning about it. So they could manage it manually`,
    'feedback'
  );

  if (feedbackAction) {
    result.triggered = true;
    result.actions.push(feedbackAction);
  }

  // Log summary if actions were taken
  if (result.triggered) {
    console.log(`\n🔍 Preflight tests triggered ${result.actions.length} action(s):`);
    for (const action of result.actions) {
      console.log(`  📝 ${action.file}: ${action.lineCount} lines (threshold: ${action.threshold})`);
    }
    console.log('');
  } else {
    // Log that preflight tests ran but no actions were needed
    console.log(`\n🔍 Preflight tests: No actions needed (all files within ${config.threshold} line threshold)\n`);
  }

  return result;
}