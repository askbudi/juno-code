/**
 * Skills Command
 * Manages juno-code agent skill files (install, list, status)
 *
 * Skills are collections of files installed into agent-specific directories:
 *   - Codex skills  -> {projectDir}/.agents/skills/
 *   - Claude skills -> {projectDir}/.claude/skills/
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { SkillInstaller } from '../../utils/skill-installer.js';

export function createSkillsCommand(): Command {
  const skillsCmd = new Command('skills')
    .description('Manage agent skill files')
    .addHelpText('after', `
Examples:
  $ juno-code skills install            Install skill files to project directories
  $ juno-code skills install --force    Force reinstall all skill files
  $ juno-code skills list               List skill groups and their files
  $ juno-code skills status             Check installation status

Skill files are copied from the juno-code package into the project:
  - Codex skills  -> .agents/skills/
  - Claude skills -> .claude/skills/

Skills are installed for ALL agents regardless of which subagent is selected.
Existing files in the destination directories are preserved.
    `);

  // Install subcommand
  skillsCmd
    .command('install')
    .description('Install skill files to project directories')
    .option('-f, --force', 'Force reinstall even if files are up-to-date')
    .action(async (options) => {
      try {
        const projectDir = process.cwd();

        if (!options.force) {
          const needsUpdate = await SkillInstaller.needsUpdate(projectDir);
          if (!needsUpdate) {
            console.log(chalk.yellow('⚠ All skill files are up-to-date'));
            console.log(chalk.dim('  Use --force to reinstall'));
            return;
          }
        }

        console.log(chalk.blue('Installing skill files...'));
        const installed = await SkillInstaller.install(projectDir, false, options.force);

        if (installed) {
          console.log(chalk.green('\n✓ Skill files installed successfully'));
        } else {
          console.log(chalk.yellow('⚠ No skill files to install (templates may be empty)'));
        }
      } catch (error) {
        console.error(chalk.red('✗ Installation failed:'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // List subcommand
  skillsCmd
    .command('list')
    .alias('ls')
    .description('List skill groups and their files')
    .action(async () => {
      try {
        const projectDir = process.cwd();
        const groups = await SkillInstaller.listSkillGroups(projectDir);

        if (groups.length === 0) {
          console.log(chalk.yellow('⚠ No skill groups configured'));
          return;
        }

        let hasAnyFiles = false;
        for (const group of groups) {
          console.log(chalk.blue.bold(`\n${group.name} skills -> ${group.destDir}/`));

          if (group.files.length === 0) {
            console.log(chalk.dim('  (no skill files bundled yet)'));
            continue;
          }

          hasAnyFiles = true;
          for (const file of group.files) {
            const statusIcon = !file.installed
              ? chalk.red('✗')
              : file.upToDate
                ? chalk.green('✓')
                : chalk.yellow('↻');
            const statusLabel = !file.installed
              ? chalk.dim('not installed')
              : file.upToDate
                ? chalk.dim('up-to-date')
                : chalk.yellow('outdated');
            console.log(`  ${statusIcon} ${file.name} ${statusLabel}`);
          }
        }

        if (!hasAnyFiles) {
          console.log(chalk.dim('\nNo skill files bundled yet. Add files to src/templates/skills/<agent>/ to bundle skills.'));
        }
      } catch (error) {
        console.error(chalk.red('✗ Failed to list skills:'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Status subcommand
  skillsCmd
    .command('status')
    .description('Check skill installation status')
    .action(async () => {
      try {
        const projectDir = process.cwd();
        const groups = await SkillInstaller.listSkillGroups(projectDir);
        const skillGroups = SkillInstaller.getSkillGroups();

        console.log(chalk.blue('Skills Status:\n'));

        console.log(chalk.dim('  Skill groups:'));
        for (const sg of skillGroups) {
          console.log(chalk.dim(`    ${sg.name} -> ${sg.destDir}/`));
        }

        const needsUpdate = await SkillInstaller.needsUpdate(projectDir);
        console.log(`\n  ${needsUpdate ? chalk.yellow('⚠ Updates available') : chalk.green('✓ All skills up-to-date')}`);

        let totalFiles = 0;
        let installedFiles = 0;
        let outdatedFiles = 0;

        for (const group of groups) {
          for (const file of group.files) {
            totalFiles++;
            if (file.installed) {
              installedFiles++;
              if (!file.upToDate) {
                outdatedFiles++;
              }
            }
          }
        }

        if (totalFiles > 0) {
          console.log(chalk.dim(`\n  Files: ${installedFiles}/${totalFiles} installed, ${outdatedFiles} outdated`));
        } else {
          console.log(chalk.dim('\n  No skill files bundled yet'));
        }

        if (needsUpdate) {
          console.log(chalk.dim('\n  Run: juno-code skills install'));
        }
      } catch (error) {
        console.error(chalk.red('✗ Failed to check status:'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  return skillsCmd;
}
