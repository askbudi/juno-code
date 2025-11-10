/**
 * Service Installer Utility
 * Handles installation and management of juno-code service scripts
 */

import fs from 'fs-extra';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export class ServiceInstaller {
  private static readonly SERVICES_DIR = path.join(homedir(), '.juno_code', 'services');

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
   */
  static async install(): Promise<void> {
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

      console.log(`✓ Services installed to: ${this.SERVICES_DIR}`);
    } catch (error) {
      throw new Error(`Failed to install services: ${error instanceof Error ? error.message : String(error)}`);
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
