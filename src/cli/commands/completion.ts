/**
 * Completion Command for juno-code CLI
 *
 * Manages shell completion installation, uninstallation, and status.
 * Supports auto-detection and manual shell selection.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ShellDetector, type ShellType } from '../utils/shell-detector.js';
import { CompletionInstaller } from '../utils/completion-enhanced.js';
import type { GlobalCLIOptions } from '../types.js';

interface CompletionOptions extends GlobalCLIOptions {
  force?: boolean;
  all?: boolean;
}

export class CompletionCommand {
  private shellDetector: ShellDetector;
  private installer: CompletionInstaller;

  constructor() {
    this.shellDetector = new ShellDetector();
    this.installer = new CompletionInstaller();
  }

  /**
   * Register completion command with Commander
   */
  register(program: Command): void {
    const completion = program
      .command('completion')
      .description('Manage shell completion installation and configuration')
      .option('-f, --force', 'Force installation even if validation fails')
      .option('-a, --all', 'Apply operation to all available shells');

    // Install subcommand
    completion
      .command('install [shell]')
      .description('Install shell completion (auto-detect if no shell specified)')
      .action(async (shell?: string, options?: CompletionOptions) => {
        await this.handleInstall(shell as ShellType, options);
      });

    // Uninstall subcommand
    completion
      .command('uninstall [shell]')
      .description('Uninstall shell completion (auto-detect if no shell specified)')
      .action(async (shell?: string, options?: CompletionOptions) => {
        await this.handleUninstall(shell as ShellType, options);
      });

    // Status subcommand
    completion
      .command('status')
      .description('Show shell completion installation status')
      .action(async (options?: CompletionOptions) => {
        await this.handleStatus(options);
      });
  }

  /**
   * Handle completion installation
   */
  private async handleInstall(shell?: ShellType, options?: CompletionOptions): Promise<void> {
    try {
      console.log(chalk.blue('🔧 Installing shell completion...'));

      if (options?.all) {
        await this.installAllShells(options);
        return;
      }

      const targetShells = shell ? [shell] : await this.detectTargetShells();

      if (targetShells.length === 0) {
        console.log(chalk.yellow('⚠️  No compatible shells detected'));
        console.log(chalk.white('Supported shells: bash, zsh, fish, powershell'));
        process.exit(1);
      }

      let successCount = 0;
      let totalCount = targetShells.length;

      for (const targetShell of targetShells) {
        console.log(chalk.blue(`\n📦 Installing completion for ${targetShell}...`));

        // Validate shell environment unless forced
        if (!options?.force) {
          const validation = await this.shellDetector.validateShellEnvironment(targetShell);
          if (!validation.valid) {
            console.log(chalk.red(`❌ Validation failed for ${targetShell}:`));
            validation.issues.forEach(issue => {
              console.log(chalk.red(`   • ${issue}`));
            });

            if (targetShells.length === 1) {
              console.log(chalk.yellow('\n💡 Use --force to skip validation'));
            }
            continue;
          }
        }

        // Install completion
        const result = await this.installer.install(targetShell);

        if (result.success) {
          console.log(chalk.green(`✅ ${result.message}`));

          if (result.warnings && result.warnings.length > 0) {
            console.log(chalk.yellow('\n⚠️  Warnings:'));
            result.warnings.forEach(warning => {
              console.log(chalk.yellow(`   • ${warning}`));
            });
          }

          // Show shell-specific instructions
          this.showPostInstallInstructions(targetShell, result);
          successCount++;
        } else {
          console.log(chalk.red(`❌ ${result.message}`));
        }
      }

      // Summary
      console.log(chalk.blue(`\n📊 Installation Summary:`));
      console.log(chalk.white(`   Success: ${successCount}/${totalCount} shells`));

      if (successCount > 0) {
        console.log(chalk.green('\n🎉 Shell completion installation completed!'));
        console.log(chalk.white('Restart your shell or open a new terminal to activate.'));
      }

    } catch (error) {
      console.error(chalk.red(`❌ Installation failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  }

  /**
   * Handle completion uninstallation
   */
  private async handleUninstall(shell?: ShellType, options?: CompletionOptions): Promise<void> {
    try {
      console.log(chalk.blue('🗑️  Uninstalling shell completion...'));

      if (options?.all) {
        await this.uninstallAllShells(options);
        return;
      }

      const targetShells = shell ? [shell] : await this.detectInstalledShells();

      if (targetShells.length === 0) {
        console.log(chalk.yellow('⚠️  No completions found to uninstall'));
        return;
      }

      let successCount = 0;
      let totalCount = targetShells.length;

      for (const targetShell of targetShells) {
        console.log(chalk.blue(`\n🗑️  Uninstalling completion for ${targetShell}...`));

        const success = await this.installer.uninstall(targetShell);

        if (success) {
          console.log(chalk.green(`✅ Completion removed for ${targetShell}`));
          successCount++;
        } else {
          console.log(chalk.yellow(`⚠️  No completion found for ${targetShell}`));
        }
      }

      // Summary
      console.log(chalk.blue(`\n📊 Uninstallation Summary:`));
      console.log(chalk.white(`   Removed: ${successCount}/${totalCount} shells`));

      if (successCount > 0) {
        console.log(chalk.green('\n🎉 Shell completion uninstallation completed!'));
      }

    } catch (error) {
      console.error(chalk.red(`❌ Uninstallation failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  }

  /**
   * Handle completion status display
   */
  private async handleStatus(options?: CompletionOptions): Promise<void> {
    try {
      console.log(chalk.blue('📋 Shell Completion Status\n'));

      const availableShells = await this.shellDetector.detectAvailableShells();
      const completionStatus = await this.installer.getStatus();

      // Display shell availability
      console.log(chalk.white('🐚 Available Shells:'));
      for (const shell of availableShells) {
        const status = shell.isAvailable ? chalk.green('✅ Available') : chalk.red('❌ Not found');
        const current = shell.isCurrent ? chalk.blue(' (current)') : '';
        console.log(`   ${shell.name}: ${status}${current}`);

        if (shell.isAvailable && options?.verbose) {
          console.log(chalk.dim(`      Executable: ${shell.executable}`));
          console.log(chalk.dim(`      Config: ${shell.configPath}`));
          console.log(chalk.dim(`      Completion: ${shell.completionPath}`));
        }
      }

      // Display completion status
      console.log(chalk.white('\n🔧 Completion Status:'));
      for (const status of completionStatus) {
        if (status.isInstalled) {
          console.log(chalk.green(`   ${status.shell}: ✅ Installed`));
          if (options?.verbose && status.installPath) {
            console.log(chalk.dim(`      Path: ${status.installPath}`));
            if (status.lastInstalled) {
              console.log(chalk.dim(`      Installed: ${status.lastInstalled.toLocaleString()}`));
            }
          }
        } else if (status.error) {
          console.log(chalk.red(`   ${status.shell}: ❌ Error - ${status.error}`));
        } else {
          console.log(chalk.yellow(`   ${status.shell}: ⏳ Not installed`));
        }
      }

      // Show suggestions
      const uninstalledShells = completionStatus
        .filter(status => !status.isInstalled && !status.error)
        .map(status => status.shell);

      if (uninstalledShells.length > 0) {
        console.log(chalk.blue('\n💡 Suggestions:'));
        console.log(chalk.white(`   Install completion: juno-code completion install ${uninstalledShells.join(' ')}`));
      }

      // Show current shell info
      const currentShell = this.shellDetector.getCurrentShell();
      if (currentShell) {
        const currentStatus = completionStatus.find(status => status.shell === currentShell);
        if (currentStatus?.isInstalled) {
          console.log(chalk.green(`\n🎯 Current shell (${currentShell}): Completion active`));
        } else {
          console.log(chalk.yellow(`\n🎯 Current shell (${currentShell}): Completion not installed`));
          console.log(chalk.white(`   Install: juno-code completion install ${currentShell}`));
        }
      }

    } catch (error) {
      console.error(chalk.red(`❌ Status check failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  }

  /**
   * Install completion for all available shells
   */
  private async installAllShells(options?: CompletionOptions): Promise<void> {
    const availableShells = await this.shellDetector.detectAvailableShells();
    const targetShells = availableShells
      .filter(shell => shell.isAvailable)
      .map(shell => shell.name);

    if (targetShells.length === 0) {
      console.log(chalk.yellow('⚠️  No shells available for installation'));
      return;
    }

    console.log(chalk.blue(`Installing completion for all shells: ${targetShells.join(', ')}`));

    for (const shell of targetShells) {
      await this.handleInstall(shell, { ...options, all: false });
    }
  }

  /**
   * Uninstall completion for all installed shells
   */
  private async uninstallAllShells(options?: CompletionOptions): Promise<void> {
    const installedShells = await this.detectInstalledShells();

    if (installedShells.length === 0) {
      console.log(chalk.yellow('⚠️  No completions found to uninstall'));
      return;
    }

    console.log(chalk.blue(`Uninstalling completion for all shells: ${installedShells.join(', ')}`));

    for (const shell of installedShells) {
      await this.handleUninstall(shell, { ...options, all: false });
    }
  }

  /**
   * Detect target shells for installation (current shell or available shells)
   */
  private async detectTargetShells(): Promise<ShellType[]> {
    const currentShell = this.shellDetector.getCurrentShell();

    if (currentShell && await this.shellDetector.commandExists(currentShell)) {
      return [currentShell];
    }

    // Fall back to all available shells
    const availableShells = await this.shellDetector.detectAvailableShells();
    return availableShells
      .filter(shell => shell.isAvailable)
      .map(shell => shell.name);
  }

  /**
   * Detect shells with completion installed
   */
  private async detectInstalledShells(): Promise<ShellType[]> {
    const completionStatus = await this.installer.getStatus();
    return completionStatus
      .filter(status => status.isInstalled)
      .map(status => status.shell);
  }

  /**
   * Show post-installation instructions for specific shell
   */
  private showPostInstallInstructions(shell: ShellType, result: any): void {
    console.log(chalk.blue('\n📋 Next Steps:'));

    switch (shell) {
      case 'bash':
        if (process.platform === 'darwin') {
          console.log(chalk.white('• Add to ~/.bash_profile or ~/.bashrc:'));
        } else {
          console.log(chalk.white('• Add to ~/.bashrc:'));
        }
        console.log(chalk.gray(`   source "${result.installPath}"`));
        console.log(chalk.white('• Reload: source ~/.bashrc'));
        break;

      case 'zsh':
        console.log(chalk.white('• Completion directory added to fpath'));
        console.log(chalk.white('• Reload: source ~/.zshrc'));
        break;

      case 'fish':
        console.log(chalk.green('• Fish completion ready immediately!'));
        console.log(chalk.white('• Open new terminal or reload Fish'));
        break;

      case 'powershell':
        console.log(chalk.white('• Add to PowerShell profile:'));
        console.log(chalk.gray(`   . "${result.installPath}"`));
        console.log(chalk.white('• Reload PowerShell'));
        break;
    }

    console.log(chalk.white('• Test: juno-code <TAB>'));
  }
}

export default CompletionCommand;