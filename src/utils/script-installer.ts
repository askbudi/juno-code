/**
 * Script Installer Utility
 * Handles automatic installation of project-level scripts from templates
 *
 * Unlike ServiceInstaller (which installs to ~/.juno_code/services/),
 * this installer manages scripts in the project's .juno_task/scripts/ directory.
 */

import fs from 'fs-extra';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export class ScriptInstaller {
  /**
   * Scripts that should be auto-installed if missing
   * These are critical scripts that users expect to be available
   */
  /**
   * Required scripts include both standalone scripts and their dependencies.
   * kanban.sh depends on install_requirements.sh for Python venv setup.
   * Slack integration scripts allow fetching tasks from Slack and responding.
   * Hook scripts are stored in the hooks/ subdirectory.
   */
  private static readonly REQUIRED_SCRIPTS = [
    'run_until_completion.sh',
    'kanban.sh',
    'install_requirements.sh', // Required by kanban.sh for Python venv creation
    // Shared utilities
    'attachment_downloader.py', // File attachment downloading utility (used by Slack/GitHub)
    // Slack integration scripts
    'slack_state.py', // State management for Slack integration
    'slack_fetch.py', // Core logic for fetching Slack messages
    'slack_fetch.sh', // Wrapper script for Slack fetch
    'slack_respond.py', // Core logic for sending responses to Slack
    'slack_respond.sh', // Wrapper script for Slack respond
    // GitHub integration script (single-file architecture)
    'github.py', // Unified GitHub integration (fetch, respond, sync)
    // Claude Code hooks (stored in hooks/ subdirectory)
    'hooks/session_counter.sh', // Session message counter hook for warning about long sessions
    // Log scanning utility
    'log_scanner.sh', // Scans log files for errors/exceptions and creates kanban bug reports
  ];

  /**
   * Get the templates scripts directory from the package
   */
  private static getPackageScriptsDir(): string | null {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    const candidates = [
      path.join(__dirname, '..', '..', 'templates', 'scripts'), // dist (production)
      path.join(__dirname, '..', 'templates', 'scripts'), // src (development)
    ];

    for (const scriptsPath of candidates) {
      if (fs.existsSync(scriptsPath)) {
        return scriptsPath;
      }
    }

    if (process.env.JUNO_CODE_DEBUG === '1') {
      console.error('[DEBUG] ScriptInstaller: Could not find templates/scripts directory');
      console.error('[DEBUG] Tried:', candidates);
    }

    return null;
  }

  /**
   * Check if a specific script exists in the project's .juno_task/scripts/ directory
   */
  static async scriptExists(projectDir: string, scriptName: string): Promise<boolean> {
    const scriptPath = path.join(projectDir, '.juno_task', 'scripts', scriptName);
    return fs.pathExists(scriptPath);
  }

  /**
   * Install a specific script to the project's .juno_task/scripts/ directory
   * @param projectDir - The project root directory
   * @param scriptName - Name of the script to install (e.g., 'run_until_completion.sh')
   * @param silent - If true, suppresses console output
   * @returns true if script was installed, false if installation was skipped or failed
   */
  static async installScript(projectDir: string, scriptName: string, silent = false): Promise<boolean> {
    try {
      const packageScriptsDir = this.getPackageScriptsDir();
      if (!packageScriptsDir) {
        if (!silent && process.env.JUNO_CODE_DEBUG === '1') {
          console.error('[DEBUG] ScriptInstaller: Package scripts directory not found');
        }
        return false;
      }

      const sourcePath = path.join(packageScriptsDir, scriptName);
      if (!await fs.pathExists(sourcePath)) {
        if (!silent && process.env.JUNO_CODE_DEBUG === '1') {
          console.error(`[DEBUG] ScriptInstaller: Source script not found: ${sourcePath}`);
        }
        return false;
      }

      // Ensure .juno_task/scripts directory exists
      const destDir = path.join(projectDir, '.juno_task', 'scripts');
      await fs.ensureDir(destDir);

      const destPath = path.join(destDir, scriptName);

      // Ensure parent directory exists for scripts in subdirectories (e.g., hooks/session_counter.sh)
      const destParentDir = path.dirname(destPath);
      if (destParentDir !== destDir) {
        await fs.ensureDir(destParentDir);
      }

      // Copy the script
      await fs.copy(sourcePath, destPath, { overwrite: true });

      // Make executable
      if (scriptName.endsWith('.sh') || scriptName.endsWith('.py')) {
        await fs.chmod(destPath, 0o755);
      }

      if (!silent) {
        console.log(`✓ Installed script: ${scriptName} to .juno_task/scripts/`);
      }

      if (process.env.JUNO_CODE_DEBUG === '1') {
        console.error(`[DEBUG] ScriptInstaller: Installed ${scriptName} to ${destPath}`);
      }

      return true;
    } catch (error) {
      if (!silent && process.env.JUNO_CODE_DEBUG === '1') {
        console.error(`[DEBUG] ScriptInstaller: Failed to install ${scriptName}:`, error);
      }
      return false;
    }
  }

  /**
   * Check which required scripts are missing from the project
   * @param projectDir - The project root directory
   * @returns Array of missing script names
   */
  static async getMissingScripts(projectDir: string): Promise<string[]> {
    const missing: string[] = [];

    for (const script of this.REQUIRED_SCRIPTS) {
      if (!await this.scriptExists(projectDir, script)) {
        missing.push(script);
      }
    }

    return missing;
  }

  /**
   * Auto-install any missing required scripts
   * This should be called on CLI startup for initialized projects
   * @param projectDir - The project root directory
   * @param silent - If true, suppresses console output
   * @returns true if any scripts were installed
   */
  static async autoInstallMissing(projectDir: string, silent = true): Promise<boolean> {
    try {
      // First check if .juno_task exists (project is initialized)
      const junoTaskDir = path.join(projectDir, '.juno_task');
      if (!await fs.pathExists(junoTaskDir)) {
        // Project not initialized, skip
        return false;
      }

      const missing = await this.getMissingScripts(projectDir);

      if (missing.length === 0) {
        return false;
      }

      if (process.env.JUNO_CODE_DEBUG === '1') {
        console.error(`[DEBUG] ScriptInstaller: Missing scripts: ${missing.join(', ')}`);
      }

      let installedAny = false;
      for (const script of missing) {
        const installed = await this.installScript(projectDir, script, silent);
        if (installed) {
          installedAny = true;
        }
      }

      if (installedAny && !silent) {
        console.log(`✓ Auto-installed ${missing.length} missing script(s)`);
      }

      return installedAny;
    } catch (error) {
      if (process.env.JUNO_CODE_DEBUG === '1') {
        console.error('[DEBUG] ScriptInstaller: autoInstallMissing error:', error);
      }
      return false;
    }
  }

  /**
   * Update a script if the package version is newer (by content comparison)
   * @param projectDir - The project root directory
   * @param scriptName - Name of the script to update
   * @param silent - If true, suppresses console output
   * @returns true if script was updated
   */
  static async updateScriptIfNewer(projectDir: string, scriptName: string, silent = true): Promise<boolean> {
    try {
      const packageScriptsDir = this.getPackageScriptsDir();
      if (!packageScriptsDir) {
        return false;
      }

      const sourcePath = path.join(packageScriptsDir, scriptName);
      const destPath = path.join(projectDir, '.juno_task', 'scripts', scriptName);

      // If destination doesn't exist, install it
      if (!await fs.pathExists(destPath)) {
        return this.installScript(projectDir, scriptName, silent);
      }

      // Compare contents
      const [sourceContent, destContent] = await Promise.all([
        fs.readFile(sourcePath, 'utf-8'),
        fs.readFile(destPath, 'utf-8'),
      ]);

      if (sourceContent !== destContent) {
        // Update the script
        await fs.copy(sourcePath, destPath, { overwrite: true });

        if (scriptName.endsWith('.sh') || scriptName.endsWith('.py')) {
          await fs.chmod(destPath, 0o755);
        }

        if (!silent) {
          console.log(`✓ Updated script: ${scriptName}`);
        }

        if (process.env.JUNO_CODE_DEBUG === '1') {
          console.error(`[DEBUG] ScriptInstaller: Updated ${scriptName} (content changed)`);
        }

        return true;
      }

      return false;
    } catch (error) {
      if (process.env.JUNO_CODE_DEBUG === '1') {
        console.error(`[DEBUG] ScriptInstaller: updateScriptIfNewer error for ${scriptName}:`, error);
      }
      return false;
    }
  }

  /**
   * Get the path to a script in the project's .juno_task/scripts/ directory
   */
  static getScriptPath(projectDir: string, scriptName: string): string {
    return path.join(projectDir, '.juno_task', 'scripts', scriptName);
  }

  /**
   * List all required scripts and their installation status
   */
  static async listRequiredScripts(projectDir: string): Promise<{ name: string; installed: boolean }[]> {
    const results = [];

    for (const script of this.REQUIRED_SCRIPTS) {
      results.push({
        name: script,
        installed: await this.scriptExists(projectDir, script),
      });
    }

    return results;
  }

  /**
   * Get scripts that need updates based on content comparison
   * @param projectDir - The project root directory
   * @returns Array of script names that have different content from package version
   */
  static async getOutdatedScripts(projectDir: string): Promise<string[]> {
    const outdated: string[] = [];

    const packageScriptsDir = this.getPackageScriptsDir();
    if (!packageScriptsDir) {
      return outdated;
    }

    for (const script of this.REQUIRED_SCRIPTS) {
      const sourcePath = path.join(packageScriptsDir, script);
      const destPath = path.join(projectDir, '.juno_task', 'scripts', script);

      // Skip if source doesn't exist
      if (!await fs.pathExists(sourcePath)) {
        continue;
      }

      // If destination doesn't exist, it's missing not outdated
      if (!await fs.pathExists(destPath)) {
        continue;
      }

      // Compare contents
      try {
        const [sourceContent, destContent] = await Promise.all([
          fs.readFile(sourcePath, 'utf-8'),
          fs.readFile(destPath, 'utf-8'),
        ]);

        if (sourceContent !== destContent) {
          outdated.push(script);
        }
      } catch {
        // On error, assume it needs update
        outdated.push(script);
      }
    }

    return outdated;
  }

  /**
   * Check if any scripts need installation or update
   * @param projectDir - The project root directory
   * @returns true if any scripts need to be installed or updated
   */
  static async needsUpdate(projectDir: string): Promise<boolean> {
    try {
      // First check if .juno_task exists (project is initialized)
      const junoTaskDir = path.join(projectDir, '.juno_task');
      if (!await fs.pathExists(junoTaskDir)) {
        return false;
      }

      const missing = await this.getMissingScripts(projectDir);
      if (missing.length > 0) {
        return true;
      }

      const outdated = await this.getOutdatedScripts(projectDir);
      return outdated.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Automatically update scripts - installs missing AND updates outdated scripts
   * Similar to ServiceInstaller.autoUpdate(), this ensures project scripts
   * are always in sync with the package version.
   *
   * This should be called on every CLI run to ensure scripts are up-to-date.
   * @param projectDir - The project root directory
   * @param silent - If true, suppresses console output
   * @param force - If true, reinstall all scripts regardless of content comparison
   * @returns true if any scripts were installed or updated
   */
  static async autoUpdate(projectDir: string, silent = true, force = false): Promise<boolean> {
    try {
      const debug = process.env.JUNO_CODE_DEBUG === '1';

      // First check if .juno_task exists (project is initialized)
      const junoTaskDir = path.join(projectDir, '.juno_task');
      if (!await fs.pathExists(junoTaskDir)) {
        return false;
      }

      let scriptsToUpdate: string[];

      if (force) {
        // Force update: reinstall all required scripts
        scriptsToUpdate = [...this.REQUIRED_SCRIPTS];
        if (debug) {
          console.error(`[DEBUG] ScriptInstaller: Force update - reinstalling all ${scriptsToUpdate.length} scripts`);
        }
      } else {
        const missing = await this.getMissingScripts(projectDir);
        const outdated = await this.getOutdatedScripts(projectDir);

        if (debug) {
          if (missing.length > 0) {
            console.error(`[DEBUG] ScriptInstaller: Missing scripts: ${missing.join(', ')}`);
          }
          if (outdated.length > 0) {
            console.error(`[DEBUG] ScriptInstaller: Outdated scripts: ${outdated.join(', ')}`);
          }
        }

        if (missing.length === 0 && outdated.length === 0) {
          return false;
        }

        scriptsToUpdate = [...new Set([...missing, ...outdated])];
      }

      let updatedAny = false;
      for (const script of scriptsToUpdate) {
        const installed = await this.installScript(projectDir, script, silent);
        if (installed) {
          updatedAny = true;
        }
      }

      if (updatedAny) {
        if (debug) {
          console.error(`[DEBUG] ScriptInstaller: Updated ${scriptsToUpdate.length} script(s)`);
        }
        if (!silent) {
          console.log(`✓ Updated ${scriptsToUpdate.length} script(s) in .juno_task/scripts/`);
        }
      }

      return updatedAny;
    } catch (error) {
      if (process.env.JUNO_CODE_DEBUG === '1') {
        console.error('[DEBUG] ScriptInstaller: autoUpdate error:', error);
      }
      return false;
    }
  }

  /**
   * Force update all scripts and run install_requirements.sh with --force-update
   * This bypasses the 24-hour cache and reinstalls all Python dependencies
   * @param projectDir - The project root directory
   * @param silent - If true, suppresses console output
   * @returns true if update was successful
   */
  static async forceUpdateAll(projectDir: string, silent = false): Promise<boolean> {
    const debug = process.env.JUNO_CODE_DEBUG === '1';

    try {
      // First, force update all scripts
      const scriptsUpdated = await this.autoUpdate(projectDir, silent, true);

      if (debug || !silent) {
        console.log('✓ Force updated all scripts in .juno_task/scripts/');
      }

      // Then run install_requirements.sh with --force-update
      const scriptsDir = path.join(projectDir, '.juno_task', 'scripts');
      const installScript = path.join(scriptsDir, 'install_requirements.sh');

      if (await fs.pathExists(installScript)) {
        if (debug || !silent) {
          console.log('Running install_requirements.sh --force-update...');
        }

        const { execSync } = await import('child_process');
        try {
          const output = execSync(`${installScript} --force-update`, {
            cwd: projectDir,
            encoding: 'utf8',
            stdio: 'pipe'
          });

          if (output && output.trim() && (debug || !silent)) {
            console.log(output);
          }

          if (!silent) {
            console.log('✓ Python dependencies force updated (cache bypassed)');
          }
        } catch (error: any) {
          if (error.stdout && error.stdout.trim() && (debug || !silent)) {
            console.log(error.stdout);
          }
          if (error.status !== 0) {
            console.error(`⚠️  install_requirements.sh failed: ${error.message || error.stderr}`);
          }
        }
      }

      return scriptsUpdated;
    } catch (error) {
      if (debug) {
        console.error('[DEBUG] ScriptInstaller: forceUpdateAll error:', error);
      }
      return false;
    }
  }
}
