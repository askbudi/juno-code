/**
 * Services Command
 * Manages juno-code service scripts (install, list, uninstall)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ServiceInstaller } from '../../utils/service-installer.js';

export function createServicesCommand(): Command {
  const servicesCmd = new Command('services')
    .description('Manage juno-code service scripts')
    .addHelpText('after', `
Examples:
  $ juno-code services install            Install service scripts to ~/.juno_code/services/
  $ juno-code services install --force    Reinstall/refresh service scripts (codex.py/claude.py/gemini.py)
  $ juno-code services list               List installed service scripts
  $ juno-code services status             Check installation status
  $ juno-code services uninstall          Remove all service scripts
  $ juno-code services path               Show services directory path

Service scripts are Python/shell scripts that provide additional functionality
and can be customized by users. They are installed to ~/.juno_code/services/
where users can modify or extend them.
    `);

  // Install subcommand
  servicesCmd
    .command('install')
    .description('Install service scripts to ~/.juno_code/services/')
    .option('-f, --force', 'Force reinstallation even if already installed')
    .action(async (options) => {
      try {
        const isInstalled = await ServiceInstaller.isInstalled();

        if (isInstalled && !options.force) {
          console.log(chalk.yellow('⚠ Services are already installed'));
          console.log(chalk.dim(`  Location: ${ServiceInstaller.getServicesDir()}`));
          console.log(chalk.dim('  Use --force to reinstall'));
          return;
        }

        console.log(chalk.blue('Installing service scripts...'));
        await ServiceInstaller.install();

        const services = await ServiceInstaller.listServices();
        console.log(chalk.green(`\n✓ Successfully installed ${services.length} service(s):`));
        services.forEach(service => {
          console.log(chalk.dim(`  - ${service}`));
        });
        console.log(chalk.dim(`\nLocation: ${ServiceInstaller.getServicesDir()}`));
      } catch (error) {
        console.error(chalk.red('✗ Installation failed:'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // List subcommand
  servicesCmd
    .command('list')
    .alias('ls')
    .description('List installed service scripts')
    .action(async () => {
      try {
        const isInstalled = await ServiceInstaller.isInstalled();

        if (!isInstalled) {
          console.log(chalk.yellow('⚠ No services installed'));
          console.log(chalk.dim('  Run: juno-code services install'));
          return;
        }

        const services = await ServiceInstaller.listServices();

        if (services.length === 0) {
          console.log(chalk.yellow('⚠ No services found'));
          return;
        }

        console.log(chalk.blue(`Installed services (${services.length}):`));
        services.forEach(service => {
          const servicePath = ServiceInstaller.getServicePath(service);
          console.log(chalk.green(`  ✓ ${service}`));
          console.log(chalk.dim(`    ${servicePath}`));
        });
      } catch (error) {
        console.error(chalk.red('✗ Failed to list services:'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Status subcommand
  servicesCmd
    .command('status')
    .description('Check installation status')
    .action(async () => {
      try {
        const isInstalled = await ServiceInstaller.isInstalled();
        const servicesDir = ServiceInstaller.getServicesDir();

        console.log(chalk.blue('Services Status:'));
        console.log(chalk.dim(`  Directory: ${servicesDir}`));

        if (isInstalled) {
          const services = await ServiceInstaller.listServices();
          console.log(chalk.green(`  Status: Installed (${services.length} service(s))`));

          if (services.length > 0) {
            console.log(chalk.dim('\n  Available services:'));
            services.forEach(service => {
              console.log(chalk.dim(`    - ${service}`));
            });
          }
        } else {
          console.log(chalk.yellow('  Status: Not installed'));
          console.log(chalk.dim('  Run: juno-code services install'));
        }
      } catch (error) {
        console.error(chalk.red('✗ Failed to check status:'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Path subcommand
  servicesCmd
    .command('path')
    .description('Show services directory path')
    .action(() => {
      console.log(ServiceInstaller.getServicesDir());
    });

  // Uninstall subcommand
  servicesCmd
    .command('uninstall')
    .description('Remove all service scripts')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      try {
        const isInstalled = await ServiceInstaller.isInstalled();

        if (!isInstalled) {
          console.log(chalk.yellow('⚠ No services installed'));
          return;
        }

        if (!options.yes) {
          console.log(chalk.yellow('⚠ This will remove all service scripts'));
          console.log(chalk.dim(`  Location: ${ServiceInstaller.getServicesDir()}`));
          console.log(chalk.dim('  Use --yes to skip this prompt'));
          return;
        }

        console.log(chalk.blue('Uninstalling service scripts...'));
        await ServiceInstaller.uninstall();
        console.log(chalk.green('✓ Services uninstalled successfully'));
      } catch (error) {
        console.error(chalk.red('✗ Uninstallation failed:'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  return servicesCmd;
}
