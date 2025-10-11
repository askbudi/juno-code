/**
 * Configuration Profile Management Command for juno-task-ts CLI
 *
 * Provides comprehensive profile management including list, show, set, create,
 * delete, export, and import operations with detailed formatting and validation.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import chalk from 'chalk';
import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import {
  createProfileManager,
  ProfileError,
  ProfileNotFoundError,
  ProfileExistsError,
  CircularInheritanceError
} from '../../core/profiles.js';
import type { ProfileManager, ProfileConfig } from '../../core/profiles.js';
import type { JunoTaskConfig } from '../../types/index.js';
import { ConfigurationError } from '../types.js';

/**
 * Profile display formatter for consistent output
 */
class ProfileDisplayFormatter {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  formatProfileList(profiles: string[], activeProfile: string): void {
    if (profiles.length === 0) {
      console.log(chalk.yellow('No configuration profiles found.'));
      console.log(chalk.gray('\nUse "juno-task config create <name>" to create your first profile.'));
      return;
    }

    console.log(chalk.blue.bold(`\n⚙️  Configuration Profiles (${profiles.length} total)\n`));

    for (const profileName of profiles) {
      const isActive = profileName === activeProfile;
      const icon = isActive ? '●' : '○';
      const color = isActive ? chalk.green.bold : chalk.white;
      const status = isActive ? chalk.green(' (active)') : '';

      console.log(`${color(icon)} ${color(profileName)}${status}`);
    }

    console.log(chalk.gray(`\nActive profile: ${chalk.green(activeProfile)}`));
  }

  formatProfileInfo(profileName: string, profileConfig: ProfileConfig, resolvedConfig: JunoTaskConfig, inheritance: string[]): void {
    console.log(chalk.blue.bold(`\n⚙️  Profile: ${profileName}\n`));

    // Basic information
    console.log(chalk.white.bold('Profile Information:'));
    console.log(`   Name: ${chalk.cyan(profileConfig.name)}`);
    if (profileConfig.description) {
      console.log(`   Description: ${chalk.white(profileConfig.description)}`);
    }

    // Metadata
    if (profileConfig.metadata) {
      console.log(chalk.white.bold('\nMetadata:'));
      console.log(`   Created: ${chalk.gray(new Date(profileConfig.metadata.created).toLocaleString())}`);
      if (profileConfig.metadata.author) {
        console.log(`   Author: ${chalk.gray(profileConfig.metadata.author)}`);
      }
      if (profileConfig.metadata.version) {
        console.log(`   Version: ${chalk.gray(profileConfig.metadata.version)}`);
      }
      if (profileConfig.metadata.tags && profileConfig.metadata.tags.length > 0) {
        console.log(`   Tags: ${chalk.yellow(profileConfig.metadata.tags.join(', '))}`);
      }
    }

    // Inheritance
    if (inheritance.length > 1) {
      console.log(chalk.white.bold('\nInheritance Chain:'));
      for (let i = 0; i < inheritance.length; i++) {
        const isLast = i === inheritance.length - 1;
        const prefix = isLast ? '   └─ ' : '   ├─ ';
        const color = isLast ? chalk.cyan : chalk.gray;
        console.log(`${prefix}${color(inheritance[i])}`);
      }
    }

    // Configuration
    console.log(chalk.white.bold('\nProfile Configuration:'));
    this.formatConfig(profileConfig.config, '   ');

    if (this.verbose) {
      console.log(chalk.white.bold('\nResolved Configuration:'));
      this.formatConfig(resolvedConfig, '   ');
    }
  }

  formatConfig(config: Partial<JunoTaskConfig> | JunoTaskConfig, indent: string = ''): void {
    const entries = Object.entries(config).filter(([_, value]) => value !== undefined);

    if (entries.length === 0) {
      console.log(`${indent}${chalk.gray('(empty)')}`);
      return;
    }

    for (const [key, value] of entries) {
      let displayValue: string;

      if (typeof value === 'boolean') {
        displayValue = value ? chalk.green('true') : chalk.red('false');
      } else if (typeof value === 'number') {
        displayValue = chalk.yellow(value.toString());
      } else {
        displayValue = chalk.white(String(value));
      }

      console.log(`${indent}${chalk.cyan(key)}: ${displayValue}`);
    }
  }

  formatSuccess(message: string): void {
    console.log(chalk.green.bold(`✓ ${message}`));
  }

  formatError(message: string): void {
    console.log(chalk.red.bold(`✗ ${message}`));
  }

  formatWarning(message: string): void {
    console.log(chalk.yellow.bold(`⚠ ${message}`));
  }

  formatInfo(message: string): void {
    console.log(chalk.blue.bold(`ℹ ${message}`));
  }
}

/**
 * List all available configuration profiles
 */
async function listProfiles(options: { verbose?: boolean } = {}): Promise<void> {
  try {
    const profileManager = createProfileManager(path.join(process.cwd(), '.juno_task'));
    await profileManager.initialize();

    const profiles = await profileManager.listProfiles();
    const activeProfile = profileManager.getActiveProfileName();

    const formatter = new ProfileDisplayFormatter(options.verbose);
    formatter.formatProfileList(profiles, activeProfile);

    if (options.verbose && profiles.length > 0) {
      console.log(chalk.gray('\nUse "juno-task config show <profile>" for detailed information.'));
    }
  } catch (error) {
    const formatter = new ProfileDisplayFormatter();
    formatter.formatError(`Failed to list profiles: ${error}`);
    process.exit(1);
  }
}

/**
 * Show detailed information about a specific profile
 */
async function showProfile(profileName?: string, options: { verbose?: boolean } = {}): Promise<void> {
  try {
    const profileManager = createProfileManager(path.join(process.cwd(), '.juno_task'));
    await profileManager.initialize();

    // Use active profile if no name specified
    const targetProfile = profileName || profileManager.getActiveProfileName();

    const profileInfo = await profileManager.getProfileInfo(targetProfile);

    const formatter = new ProfileDisplayFormatter(options.verbose);
    formatter.formatProfileInfo(
      targetProfile,
      profileInfo.profile,
      profileInfo.resolvedConfig,
      profileInfo.inheritance
    );

  } catch (error) {
    const formatter = new ProfileDisplayFormatter();
    if (error instanceof ProfileNotFoundError) {
      formatter.formatError(`Profile '${profileName}' not found.`);
      console.log(chalk.gray('\nUse "juno-task config list" to see available profiles.'));
    } else {
      formatter.formatError(`Failed to show profile: ${error}`);
    }
    process.exit(1);
  }
}

/**
 * Set the active configuration profile
 */
async function setActiveProfile(profileName: string): Promise<void> {
  try {
    const profileManager = createProfileManager(path.join(process.cwd(), '.juno_task'));
    await profileManager.initialize();

    await profileManager.setActiveProfile(profileName);

    const formatter = new ProfileDisplayFormatter();
    formatter.formatSuccess(`Active profile set to '${profileName}'`);

  } catch (error) {
    const formatter = new ProfileDisplayFormatter();
    if (error instanceof ProfileNotFoundError) {
      formatter.formatError(`Profile '${profileName}' not found.`);
      console.log(chalk.gray('\nUse "juno-task config list" to see available profiles.'));
    } else {
      formatter.formatError(`Failed to set active profile: ${error}`);
    }
    process.exit(1);
  }
}

/**
 * Create a new configuration profile
 */
async function createProfile(
  profileName: string,
  options: {
    description?: string;
    inherits?: string[];
    author?: string;
    tags?: string[];
    interactive?: boolean;
  } = {}
): Promise<void> {
  try {
    const profileManager = createProfileManager(path.join(process.cwd(), '.juno_task'));
    await profileManager.initialize();

    // Create basic profile structure
    const newProfile: ProfileConfig = {
      name: profileName,
      description: options.description,
      inherits: options.inherits,
      config: {}, // Start with empty config
      metadata: {
        created: new Date().toISOString(),
        author: options.author,
        tags: options.tags,
        version: '1.0.0',
      },
    };

    await profileManager.createProfile(newProfile);

    const formatter = new ProfileDisplayFormatter();
    formatter.formatSuccess(`Profile '${profileName}' created successfully`);

    if (options.interactive) {
      console.log(chalk.gray('\nYou can now configure this profile using:'));
      console.log(chalk.cyan(`  juno-task config edit ${profileName}`));
    }

  } catch (error) {
    const formatter = new ProfileDisplayFormatter();
    if (error instanceof ProfileExistsError) {
      formatter.formatError(`Profile '${profileName}' already exists.`);
      console.log(chalk.gray('Use "juno-task config show <profile>" to view existing profile.'));
    } else if (error instanceof CircularInheritanceError) {
      formatter.formatError(`Circular inheritance detected: ${error.message}`);
    } else {
      formatter.formatError(`Failed to create profile: ${error}`);
    }
    process.exit(1);
  }
}

/**
 * Delete a configuration profile
 */
async function deleteProfile(profileName: string, options: { force?: boolean } = {}): Promise<void> {
  try {
    const profileManager = createProfileManager(path.join(process.cwd(), '.juno_task'));
    await profileManager.initialize();

    // Confirmation for non-force deletion
    if (!options.force) {
      const readline = await import('readline').then(m => m.createInterface({
        input: process.stdin,
        output: process.stdout
      }));

      const answer = await new Promise<string>((resolve) => {
        readline.question(chalk.yellow(`Are you sure you want to delete profile '${profileName}'? (y/N): `), resolve);
      });

      readline.close();

      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(chalk.gray('Profile deletion cancelled.'));
        return;
      }
    }

    await profileManager.deleteProfile(profileName);

    const formatter = new ProfileDisplayFormatter();
    formatter.formatSuccess(`Profile '${profileName}' deleted successfully`);

  } catch (error) {
    const formatter = new ProfileDisplayFormatter();
    if (error instanceof ProfileNotFoundError) {
      formatter.formatError(`Profile '${profileName}' not found.`);
    } else {
      formatter.formatError(`Failed to delete profile: ${error}`);
    }
    process.exit(1);
  }
}

/**
 * Export a configuration profile
 */
async function exportProfile(
  profileName: string,
  outputFile?: string,
  options: { format?: 'json' | 'yaml' } = {}
): Promise<void> {
  try {
    const profileManager = createProfileManager(path.join(process.cwd(), '.juno_task'));
    await profileManager.initialize();

    const format = options.format || 'json';
    const exportData = await profileManager.exportProfile(profileName, format);

    if (outputFile) {
      // Export to file
      await fs.writeFile(outputFile, exportData, 'utf-8');

      const formatter = new ProfileDisplayFormatter();
      formatter.formatSuccess(`Profile '${profileName}' exported to '${outputFile}'`);
    } else {
      // Export to stdout
      console.log(exportData);
    }

  } catch (error) {
    const formatter = new ProfileDisplayFormatter();
    if (error instanceof ProfileNotFoundError) {
      formatter.formatError(`Profile '${profileName}' not found.`);
    } else {
      formatter.formatError(`Failed to export profile: ${error}`);
    }
    process.exit(1);
  }
}

/**
 * Import a configuration profile
 */
async function importProfile(
  inputFile: string,
  options: { format?: 'json' | 'yaml'; force?: boolean } = {}
): Promise<void> {
  try {
    const profileManager = createProfileManager(path.join(process.cwd(), '.juno_task'));
    await profileManager.initialize();

    // Read import data
    const importData = await fs.readFile(inputFile, 'utf-8');
    const format = options.format || (inputFile.endsWith('.yaml') || inputFile.endsWith('.yml') ? 'yaml' : 'json');

    await profileManager.importProfile(importData, format);

    const formatter = new ProfileDisplayFormatter();
    formatter.formatSuccess(`Profile imported successfully from '${inputFile}'`);

  } catch (error) {
    const formatter = new ProfileDisplayFormatter();
    if (error instanceof ProfileExistsError && !options.force) {
      formatter.formatError(`Profile already exists. Use --force to overwrite.`);
    } else {
      formatter.formatError(`Failed to import profile: ${error}`);
    }
    process.exit(1);
  }
}

/**
 * Setup configuration profile command and subcommands
 */
export function setupConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage configuration profiles')
    .helpOption('-h, --help', 'Display help for config command');

  // List profiles
  configCmd
    .command('list')
    .alias('ls')
    .description('List all available configuration profiles')
    .option('-v, --verbose', 'Show detailed information')
    .action(listProfiles);

  // Show profile
  configCmd
    .command('show [profile]')
    .alias('info')
    .description('Show detailed information about a profile (defaults to active profile)')
    .option('-v, --verbose', 'Show resolved configuration')
    .action(showProfile);

  // Set active profile
  configCmd
    .command('set <profile>')
    .alias('use')
    .description('Set the active configuration profile')
    .action(setActiveProfile);

  // Create profile
  configCmd
    .command('create <name>')
    .alias('new')
    .description('Create a new configuration profile')
    .option('-d, --description <description>', 'Profile description')
    .option('--inherits <profiles...>', 'Profiles to inherit from')
    .option('--author <author>', 'Profile author')
    .option('--tags <tags...>', 'Profile tags')
    .option('-i, --interactive', 'Interactive profile creation')
    .action(createProfile);

  // Delete profile
  configCmd
    .command('delete <profile>')
    .alias('remove')
    .alias('rm')
    .description('Delete a configuration profile')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(deleteProfile);

  // Export profile
  configCmd
    .command('export <profile> [file]')
    .description('Export a configuration profile')
    .option('--format <format>', 'Export format (json|yaml)', 'json')
    .action(exportProfile);

  // Import profile
  configCmd
    .command('import <file>')
    .description('Import a configuration profile')
    .option('--format <format>', 'Import format (json|yaml)')
    .option('-f, --force', 'Overwrite existing profile')
    .action(importProfile);

  // Add help examples
  configCmd.on('--help', () => {
    console.log('');
    console.log('Examples:');
    console.log('  $ juno-task config list                    # List all profiles');
    console.log('  $ juno-task config show development        # Show development profile');
    console.log('  $ juno-task config set production          # Set active profile');
    console.log('  $ juno-task config create dev --description "Development settings"');
    console.log('  $ juno-task config export prod prod.json  # Export to file');
    console.log('  $ juno-task config import backup.json     # Import from file');
    console.log('');
  });
}

export default setupConfigCommand;