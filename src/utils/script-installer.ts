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
   */
  private static readonly REQUIRED_SCRIPTS = [
    'run_until_completion.sh',
    'kanban.sh',
    'install_requirements.sh', // Required by kanban.sh for Python venv creation
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
}
