/**
 * Service Installer Utility
 * Handles installation and management of juno-code service scripts
 */

import fs from 'fs-extra';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import semver from 'semver';

export class ServiceInstaller {
  private static readonly REQUIRED_SCRIPTS = ['codex.py', 'claude.py', 'gemini.py'];
  private static readonly SERVICES_DIR = path.join(homedir(), '.juno_code', 'services');
  private static readonly VERSION_FILE = path.join(homedir(), '.juno_code', 'services', '.version');

  private static missingScripts(baseDir: string): string[] {
    return this.REQUIRED_SCRIPTS.filter(file => !fs.existsSync(path.join(baseDir, file)));
  }

  private static async missingScriptsAsync(baseDir: string): Promise<string[]> {
    const results = await Promise.all(
      this.REQUIRED_SCRIPTS.map(async file => ({
        file,
        exists: await fs.pathExists(path.join(baseDir, file)),
      }))
    );
    return results.filter(result => !result.exists).map(result => result.file);
  }

  /**
   * Get the current package version
   */
  private static getPackageVersion(): string {
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const require = createRequire(import.meta.url);

      // Try to find package.json
      let packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = require(packageJsonPath);
        return packageJson.version;
      }

      // Try alternative path for development
      packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = require(packageJsonPath);
        return packageJson.version;
      }

      return '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * Get the installed services version
   */
  private static async getInstalledVersion(): Promise<string | null> {
    try {
      const exists = await fs.pathExists(this.VERSION_FILE);
      if (!exists) {
        return null;
      }

      const version = await fs.readFile(this.VERSION_FILE, 'utf-8');
      return version.trim();
    } catch {
      return null;
    }
  }

  /**
   * Save the current package version to the version file
   */
  private static async saveVersion(): Promise<void> {
    const version = this.getPackageVersion();
    await fs.writeFile(this.VERSION_FILE, version, 'utf-8');
  }

  /**
   * Check if services need to be updated based on version
   */
  static async needsUpdate(): Promise<boolean> {
    try {
      const packageVersion = this.getPackageVersion();
      const installedVersion = await this.getInstalledVersion();

      // If no version file exists, needs update
      if (!installedVersion) {
        return true;
      }

      // If services directory doesn't exist, needs update
      const exists = await fs.pathExists(this.SERVICES_DIR);
      if (!exists) {
        return true;
      }

      // Compare versions using semver
      // If package version is greater, definitely needs update
      if (semver.gt(packageVersion, installedVersion)) {
        return true;
      }

      // If versions are equal, check if service files actually exist
      // This handles the case where npm install happened but service scripts
      // weren't properly installed (or user deleted them)
      if (semver.eq(packageVersion, installedVersion)) {
        const missingInstalled = await this.missingScriptsAsync(this.SERVICES_DIR);
        if (missingInstalled.length > 0) {
          return true;
        }

        // Compare contents with package versions; update if mismatch
        try {
          const packageServicesDir = this.getPackageServicesDir();
          const missingPackageScripts = this.missingScripts(packageServicesDir);
          if (missingPackageScripts.length > 0) {
            throw new Error(`Missing required service scripts: ${missingPackageScripts.join(', ')}`);
          }

          for (const script of this.REQUIRED_SCRIPTS) {
            const packageScript = path.join(packageServicesDir, script);
            const installedScript = path.join(this.SERVICES_DIR, script);
            const [pkg, inst] = await Promise.all([
              fs.readFile(packageScript, 'utf-8'),
              fs.readFile(installedScript, 'utf-8'),
            ]);
            if (pkg !== inst) {
              return true;
            }
          }

          // In development, always update to get latest changes to other files
          const isDevelopment = packageServicesDir.includes('/src/');
          if (isDevelopment) {
            return true;
          }
        } catch {
          // On any comparison error, err on the side of updating
          return true;
        }
      }

      return false;
    } catch {
      // On any error, assume update is needed
      return true;
    }
  }

  /**
   * Get the path to the services directory in the package
   */
  private static getPackageServicesDir(): string {
    // This will work both in development and production
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    const candidates = [
      path.join(__dirname, '..', '..', 'templates', 'services'), // dist (production)
      path.join(__dirname, '..', 'templates', 'services'), // src (development)
    ];

    for (const servicesPath of candidates) {
      if (!fs.existsSync(servicesPath)) {
        continue;
      }

      const missing = this.missingScripts(servicesPath);
      if (missing.length === 0) {
        return servicesPath;
      }

      if (process.env.JUNO_CODE_DEBUG === '1') {
        console.error(`[DEBUG] Services path missing required scripts (${servicesPath}): ${missing.join(', ')}`);
      }
    }

    throw new Error(
      'Could not find services directory in package containing codex.py, claude.py, and gemini.py. ' +
      'Try reinstalling juno-code or re-running npm run build to refresh service scripts.'
    );
  }

  /**
   * Install all service scripts to ~/.juno_code/services/
   * @param silent - If true, suppresses console output
   */
  static async install(silent = false): Promise<void> {
    try {
      // Ensure the services directory exists
      await fs.ensureDir(this.SERVICES_DIR);

      // Get the package services directory
      const packageServicesDir = this.getPackageServicesDir();

      // Copy all service files
      await fs.copy(packageServicesDir, this.SERVICES_DIR, {
        overwrite: true,
        preserveTimestamps: true,
      });

      const missingAfterCopy = await this.missingScriptsAsync(this.SERVICES_DIR);
      if (missingAfterCopy.length > 0) {
        throw new Error(`Installed services missing required service scripts: ${missingAfterCopy.join(', ')}`);
      }

      // Ensure scripts are executable
      const files = await fs.readdir(this.SERVICES_DIR);
      for (const file of files) {
        const filePath = path.join(this.SERVICES_DIR, file);
        const stat = await fs.stat(filePath);
        if (stat.isFile() && (file.endsWith('.py') || file.endsWith('.sh'))) {
          await fs.chmod(filePath, 0o755);
        }
      }

      // Save the current version
      await this.saveVersion();

      if (!silent) {
        console.log(`✓ Services installed to: ${this.SERVICES_DIR}`);
      }
    } catch (error) {
      throw new Error(`Failed to install services: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Automatically update services if needed (silent operation)
   * This should be called on every CLI run to ensure services are up-to-date
   * @param force - If true, force reinstall services regardless of version
   */
  static async autoUpdate(force = false): Promise<boolean> {
    try {
      const debug = process.env.JUNO_CODE_DEBUG === '1';

      if (debug) {
        const packageVersion = this.getPackageVersion();
        const installedVersion = await this.getInstalledVersion();
        console.error(`[DEBUG] Package version: ${packageVersion}, Installed version: ${installedVersion || 'not found'}`);
      }

      const needsUpdate = force || await this.needsUpdate();

      if (debug) {
        console.error(`[DEBUG] Needs update: ${needsUpdate}${force ? ' (forced)' : ''}`);
      }

      if (needsUpdate) {
        await this.install(true);

        if (debug) {
          console.error(`[DEBUG] Service scripts updated successfully`);
        }

        return true;
      }
      return false;
    } catch (error) {
      // Log error in debug mode
      if (process.env.JUNO_CODE_DEBUG === '1') {
        console.error('[DEBUG] autoUpdate error:', error instanceof Error ? error.message : String(error));
      }
      // Silent failure - don't break CLI if update fails
      return false;
    }
  }

  /**
   * Check if services are installed
   */
  static async isInstalled(): Promise<boolean> {
    try {
      const exists = await fs.pathExists(this.SERVICES_DIR);
      if (!exists) {
        return false;
      }

      // Check if at least one service file exists
      const files = await fs.readdir(this.SERVICES_DIR);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get the path to the services directory
   */
  static getServicesDir(): string {
    return this.SERVICES_DIR;
  }

  /**
   * Get the path to a specific service
   */
  static getServicePath(serviceName: string): string {
    return path.join(this.SERVICES_DIR, serviceName);
  }

  /**
   * List all installed services
   */
  static async listServices(): Promise<string[]> {
    try {
      const exists = await fs.pathExists(this.SERVICES_DIR);
      if (!exists) {
        return [];
      }

      const files = await fs.readdir(this.SERVICES_DIR);
      return files.filter(file => file.endsWith('.py') || file.endsWith('.sh'));
    } catch {
      return [];
    }
  }

  /**
   * Uninstall all services
   */
  static async uninstall(): Promise<void> {
    try {
      const exists = await fs.pathExists(this.SERVICES_DIR);
      if (exists) {
        await fs.remove(this.SERVICES_DIR);
        console.log('✓ Services uninstalled');
      }
    } catch (error) {
      throw new Error(`Failed to uninstall services: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
