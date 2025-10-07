/**
 * Shell Detection Utility for juno-task-ts
 *
 * Detects available shells and manages shell-specific configuration paths.
 * Supports bash, zsh, fish, and other common shells.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import fs from 'fs-extra';
import whichPkg from 'which';
const { which } = whichPkg;

export type ShellType = 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd';

export interface ShellInfo {
  name: ShellType;
  executable: string;
  version?: string;
  configPath: string;
  completionPath: string;
  isAvailable: boolean;
  isCurrent: boolean;
}

export interface CompletionStatus {
  shell: ShellType;
  isInstalled: boolean;
  installPath?: string;
  configPath?: string;
  lastInstalled?: Date;
  error?: string;
}

export class ShellDetector {
  private static readonly COMMON_SHELLS: ShellType[] = ['bash', 'zsh', 'fish', 'powershell'];

  /**
   * Detect all available shells on the system
   */
  async detectAvailableShells(): Promise<ShellInfo[]> {
    const shells: ShellInfo[] = [];
    const currentShell = this.getCurrentShell();

    for (const shellName of ShellDetector.COMMON_SHELLS) {
      const configPath = this.getConfigPath(shellName);
      const completionPath = this.getCompletionPath(shellName);

      try {
        const executable = await which(shellName);

        shells.push({
          name: shellName,
          executable: executable || '',
          configPath,
          completionPath,
          isAvailable: !!executable,
          isCurrent: shellName === currentShell
        });
      } catch (error) {
        // Shell not available
        shells.push({
          name: shellName,
          executable: '',
          configPath,
          completionPath,
          isAvailable: false,
          isCurrent: false
        });
      }
    }

    return shells;
  }

  /**
   * Get the current shell from environment
   */
  getCurrentShell(): ShellType | null {
    const shell = process.env.SHELL;
    if (!shell) return null;

    const shellName = path.basename(shell);
    switch (shellName) {
      case 'bash':
        return 'bash';
      case 'zsh':
        return 'zsh';
      case 'fish':
        return 'fish';
      case 'powershell':
      case 'pwsh':
        return 'powershell';
      default:
        return null;
    }
  }

  /**
   * Get shell configuration file path
   */
  getConfigPath(shell: ShellType): string {
    const homeDir = os.homedir();

    switch (shell) {
      case 'bash':
        // Prefer .bashrc on Linux, .bash_profile on macOS
        if (process.platform === 'darwin') {
          return path.join(homeDir, '.bash_profile');
        }
        return path.join(homeDir, '.bashrc');

      case 'zsh':
        return path.join(homeDir, '.zshrc');

      case 'fish':
        return path.join(homeDir, '.config', 'fish', 'config.fish');

      case 'powershell':
        if (process.platform === 'win32') {
          return path.join(homeDir, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
        }
        return path.join(homeDir, '.config', 'powershell', 'Microsoft.PowerShell_profile.ps1');

      default:
        throw new Error(`Unsupported shell: ${shell}`);
    }
  }

  /**
   * Get shell completion script installation path
   */
  getCompletionPath(shell: ShellType): string {
    const homeDir = os.homedir();

    switch (shell) {
      case 'bash':
        // Use user completion directory
        if (process.platform === 'darwin') {
          return path.join('/usr/local/etc/bash_completion.d', 'juno-ts-task');
        }
        return path.join(homeDir, '.local', 'share', 'bash-completion', 'completions', 'juno-ts-task');

      case 'zsh':
        // Use user site-functions directory
        return path.join(homeDir, '.local', 'share', 'zsh', 'site-functions', '_juno-ts-task');

      case 'fish':
        return path.join(homeDir, '.config', 'fish', 'completions', 'juno-ts-task.fish');

      case 'powershell':
        return path.join(homeDir, '.config', 'powershell', 'completions', 'juno-ts-task.ps1');

      default:
        throw new Error(`Unsupported shell: ${shell}`);
    }
  }

  /**
   * Check if a command exists in the system
   */
  async commandExists(command: string): Promise<boolean> {
    try {
      const result = await which(command);
      return !!result;
    } catch {
      return false;
    }
  }

  /**
   * Get the source command to add to shell configuration
   */
  getSourceCommand(shell: ShellType, completionPath: string): string {
    switch (shell) {
      case 'bash':
        return `# juno-ts-task completion\n[ -f "${completionPath}" ] && source "${completionPath}"`;

      case 'zsh':
        // Add to fpath and enable completion
        const zshDir = path.dirname(completionPath);
        return `# juno-ts-task completion\nfpath=("${zshDir}" $fpath)\nautoload -U compinit && compinit`;

      case 'fish':
        // Fish automatically loads completions from ~/.config/fish/completions/
        return `# juno-ts-task completion (automatically loaded)`;

      case 'powershell':
        return `# juno-ts-task completion\n. "${completionPath}"`;

      default:
        throw new Error(`Unsupported shell: ${shell}`);
    }
  }

  /**
   * Check if source command is already present in config file
   */
  async isSourceCommandPresent(configPath: string, sourceCommand: string): Promise<boolean> {
    try {
      if (!(await fs.pathExists(configPath))) {
        return false;
      }

      const content = await fs.readFile(configPath, 'utf-8');
      // Check for the marker comment
      return content.includes('juno-ts-task completion');
    } catch {
      return false;
    }
  }

  /**
   * Get completion installation status for all shells
   */
  async getCompletionStatus(): Promise<CompletionStatus[]> {
    const shells = await this.detectAvailableShells();
    const statuses: CompletionStatus[] = [];

    for (const shell of shells) {
      if (!shell.isAvailable) {
        statuses.push({
          shell: shell.name,
          isInstalled: false,
          error: 'Shell not available'
        });
        continue;
      }

      try {
        const completionExists = await fs.pathExists(shell.completionPath);
        const configExists = await fs.pathExists(shell.configPath);
        const isSourced = configExists && await this.isSourceCommandPresent(
          shell.configPath,
          this.getSourceCommand(shell.name, shell.completionPath)
        );

        let lastInstalled: Date | undefined;
        if (completionExists) {
          const stats = await fs.stat(shell.completionPath);
          lastInstalled = stats.mtime;
        }

        statuses.push({
          shell: shell.name,
          isInstalled: completionExists && (shell.name === 'fish' || isSourced),
          installPath: completionExists ? shell.completionPath : undefined,
          configPath: shell.configPath,
          lastInstalled
        });
      } catch (error) {
        statuses.push({
          shell: shell.name,
          isInstalled: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return statuses;
  }

  /**
   * Ensure directory exists for completion installation
   */
  async ensureCompletionDirectory(shell: ShellType): Promise<void> {
    const completionPath = this.getCompletionPath(shell);
    const completionDir = path.dirname(completionPath);
    await fs.ensureDir(completionDir);
  }

  /**
   * Ensure directory exists for shell configuration
   */
  async ensureConfigDirectory(shell: ShellType): Promise<void> {
    const configPath = this.getConfigPath(shell);
    const configDir = path.dirname(configPath);
    await fs.ensureDir(configDir);
  }

  /**
   * Get shell version information
   */
  async getShellVersion(shell: ShellType): Promise<string | null> {
    try {
      const executable = await which(shell);
      // This is a basic implementation - could be enhanced with actual version detection
      return executable;
    } catch {
      return null;
    }
  }

  /**
   * Validate shell environment
   */
  async validateShellEnvironment(shell: ShellType): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    // Check if shell is available
    if (!(await this.commandExists(shell))) {
      issues.push(`${shell} is not installed or not in PATH`);
    }

    // Check if config directory is writable
    try {
      const configPath = this.getConfigPath(shell);
      const configDir = path.dirname(configPath);
      await fs.access(configDir, fs.constants.W_OK);
    } catch {
      issues.push(`Cannot write to ${shell} configuration directory`);
    }

    // Check if completion directory is writable
    try {
      const completionPath = this.getCompletionPath(shell);
      const completionDir = path.dirname(completionPath);
      await fs.ensureDir(completionDir);
      await fs.access(completionDir, fs.constants.W_OK);
    } catch {
      issues.push(`Cannot write to ${shell} completion directory`);
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }
}

export default ShellDetector;