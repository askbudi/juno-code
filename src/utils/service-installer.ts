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
  private static readonly SERVICES_DIR = path.join(homedir(), '.juno_code', 'services');
  private static readonly VERSION_FILE = path.join(homedir(), '.juno_code', 'services', '.version');

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
      return semver.gt(packageVersion, installedVersion);
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

    // Try dist/templates/services first (production)
    let servicesPath = path.join(__dirname, '..', '..', 'templates', 'services');
    if (fs.existsSync(servicesPath)) {
      return servicesPath;
    }

    // Try src/templates/services (development)
    servicesPath = path.join(__dirname, '..', 'templates', 'services');
    if (fs.existsSync(servicesPath)) {
      return servicesPath;
    }

    throw new Error('Could not find services directory in package');
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
   */
  static async autoUpdate(): Promise<boolean> {
    try {
      const needsUpdate = await this.needsUpdate();
      if (needsUpdate) {
        await this.install(true);
        return true;
      }
      return false;
    } catch {
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
