/**
 * Skill Installer Utility
 * Handles installation and management of agent skill files.
 *
 * Skills are collections of files that are copied to agent-specific directories
 * in the project. Regardless of which subagent is selected, skills for ALL agents
 * are installed so the project is ready for any agent.
 *
 * Destination directories:
 *   - Codex skills  -> {projectDir}/.agents/skills/
 *   - Claude skills -> {projectDir}/.claude/skills/
 *   - Pi skills     -> {projectDir}/.pi/skills/
 *
 * Pi integration:
 *   When Pi skills are installed, a `.pi/settings.json` is created (if missing)
 *   that tells Pi to also load skills from `.claude/skills/`.
 *   We also default `quietStartup: true` to keep Pi startup output clean in
 *   subagent/live workflows where duplicate skill names can generate noisy
 *   collision warnings while still loading the selected canonical skill.
 *   Existing settings are preserved; only the legacy auto-generated file shape
 *   (`{ skills: [".claude/skills"] }`) is upgraded in-place with `quietStartup`.
 *
 * Template source directories (in package):
 *   - src/templates/skills/{codex,claude,pi}/   (development)
 *   - dist/templates/skills/{codex,claude,pi}/  (production)
 */

import fs from 'fs-extra';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Mapping from skill group name to the destination directory relative to project root.
 * Each group corresponds to a subdirectory under src/templates/skills/.
 */
interface SkillGroup {
  /** Name used as sub-folder under templates/skills/ */
  name: string;
  /** Destination directory relative to project root */
  destDir: string;
}

/**
 * Mapping from extension group name to the destination directory relative to project root.
 * Each group corresponds to a subdirectory under src/templates/extensions/.
 */
interface ExtensionGroup {
  /** Name used as sub-folder under templates/extensions/ */
  name: string;
  /** Destination directory relative to project root */
  destDir: string;
}

export class SkillInstaller {
  private static readonly CONTROLLER_AGENT_IGNORES = [
    '/AGENTS.md',
    '/CLAUDE.md',
    '/.agents/',
    '/.claude/',
    '/.pi/',
  ];

  static async isMetadataOnlyController(projectDir: string): Promise<boolean> {
    try {
      const config = await fs.readJson(path.join(projectDir, '.juno_task/config.json'));
      return config?.controllerWorkspace?.mode === 'metadata-only'
        && config.controllerWorkspace.policy === '.juno_task/config/metadata-controller.json';
    } catch {
      return false;
    }
  }

  static async assertInstallAllowed(projectDir: string): Promise<void> {
    if (!(await this.isMetadataOnlyController(projectDir))) return;
    const ignorePath = path.join(projectDir, '.gitignore');
    const lines = new Set(
      (await fs.readFile(ignorePath, 'utf8').catch(() => ''))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const missing = this.CONTROLLER_AGENT_IGNORES.filter((entry) => !lines.has(entry));
    if (missing.length > 0) {
      throw new Error(
        `Metadata-controller agent surface requires the reviewed ignored-runtime policy; missing .gitignore entries: ${missing.join(', ')}`,
      );
    }
  }

  /**
   * Skill groups define which template folders map to which project directories.
   * New agents can be added here without changing any other logic.
   */
  private static readonly SKILL_GROUPS: SkillGroup[] = [
    { name: 'codex', destDir: '.agents/skills' },
    { name: 'claude', destDir: '.claude/skills' },
    { name: 'pi', destDir: '.pi/skills' },
  ];

  /**
   * Extension groups define which template folders map to which project directories.
   * Extensions are loaded by the agent at runtime (e.g., Pi loads from .pi/extensions/).
   */
  private static readonly EXTENSION_GROUPS: ExtensionGroup[] = [
    { name: 'pi', destDir: '.pi/extensions' },
  ];

  private static readonly DEFAULT_PI_SETTINGS = {
    skills: ['.claude/skills'],
    quietStartup: true,
  };

  /**
   * Get the templates skills directory from the package
   */
  private static getPackageSkillsDir(): string | null {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    const candidates = [
      path.join(__dirname, '..', '..', 'templates', 'skills'), // dist (production)
      path.join(__dirname, '..', 'templates', 'skills'), // src (development)
    ];

    for (const skillsPath of candidates) {
      if (fs.existsSync(skillsPath)) {
        return skillsPath;
      }
    }

    if (process.env.JUNO_CODE_DEBUG === '1') {
      console.error('[DEBUG] SkillInstaller: Could not find templates/skills directory');
      console.error('[DEBUG] Tried:', candidates);
    }

    return null;
  }

  /**
   * Get the templates extensions directory from the package
   */
  private static getPackageExtensionsDir(): string | null {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    const candidates = [
      path.join(__dirname, '..', '..', 'templates', 'extensions'), // dist (production)
      path.join(__dirname, '..', 'templates', 'extensions'), // src (development)
    ];

    for (const extPath of candidates) {
      if (fs.existsSync(extPath)) {
        return extPath;
      }
    }

    if (process.env.JUNO_CODE_DEBUG === '1') {
      console.error('[DEBUG] SkillInstaller: Could not find templates/extensions directory');
    }

    return null;
  }

  private static getPackageControllerAgentDir(): string | null {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(__dirname, '..', '..', 'templates', 'controller-agent'),
      path.join(__dirname, '..', 'templates', 'controller-agent'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  private static async installControllerInstructions(
    projectDir: string,
    silent: boolean,
    force: boolean,
  ): Promise<number> {
    if (!(await this.isMetadataOnlyController(projectDir))) return 0;
    const source = this.getPackageControllerAgentDir();
    if (!source) throw new Error('Package controller-agent instructions are missing');
    let installed = 0;
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      const src = path.join(source, filename);
      const dest = path.join(projectDir, filename);
      const same = await fs.pathExists(dest)
        && (await fs.readFile(src)).equals(await fs.readFile(dest));
      if (!force && same) continue;
      await fs.copy(src, dest, { overwrite: true });
      installed += 1;
    }
    if (installed > 0 && !silent) {
      console.log(`✓ Installed ${installed} ignored controller instruction file(s)`);
    }
    return installed;
  }

  /**
   * Get list of skill files in a specific skill group template directory.
   * Returns paths relative to the group directory.
   */
  private static async getSkillFiles(groupDir: string): Promise<string[]> {
    if (!(await fs.pathExists(groupDir))) {
      return [];
    }

    const files: string[] = [];

    const walk = async (dir: string, prefix: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip hidden files like .gitkeep, __pycache__, .DS_Store
        if (entry.name.startsWith('.') || entry.name === '__pycache__') {
          continue;
        }
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), relPath);
        } else {
          files.push(relPath);
        }
      }
    };

    await walk(groupDir, '');
    return files;
  }

  /**
   * Install skills for a single skill group.
   * Only copies skill files, does NOT delete or modify any other files in the destination.
   *
   * @param projectDir - The project root directory
   * @param group - The skill group to install
   * @param silent - If true, suppresses console output
   * @param force - If true, overwrite even if content is identical
   * @returns number of files installed or updated
   */
  private static async installGroup(
    projectDir: string,
    group: SkillGroup,
    silent = true,
    force = false,
  ): Promise<number> {
    const debug = process.env.JUNO_CODE_DEBUG === '1';
    const packageSkillsDir = this.getPackageSkillsDir();

    if (!packageSkillsDir) {
      if (debug) {
        console.error('[DEBUG] SkillInstaller: Package skills directory not found');
      }
      return 0;
    }

    const sourceGroupDir = path.join(packageSkillsDir, group.name);
    const destGroupDir = path.join(projectDir, group.destDir);

    const skillFiles = await this.getSkillFiles(sourceGroupDir);

    if (skillFiles.length === 0) {
      if (debug) {
        console.error(`[DEBUG] SkillInstaller: No skill files found for group '${group.name}'`);
      }
      return 0;
    }

    // Ensure destination directory exists (but do not remove existing content)
    await fs.ensureDir(destGroupDir);

    let installed = 0;

    for (const relFile of skillFiles) {
      const srcPath = path.join(sourceGroupDir, relFile);
      const destPath = path.join(destGroupDir, relFile);

      // Ensure parent directory exists for nested files
      const destParent = path.dirname(destPath);
      await fs.ensureDir(destParent);

      let shouldCopy = force;

      if (!shouldCopy) {
        if (!(await fs.pathExists(destPath))) {
          shouldCopy = true;
        } else {
          // Content-based comparison
          const [srcContent, destContent] = await Promise.all([
            fs.readFile(srcPath, 'utf-8'),
            fs.readFile(destPath, 'utf-8'),
          ]);
          if (srcContent !== destContent) {
            shouldCopy = true;
          }
        }
      }

      if (shouldCopy) {
        // Development templates may use relative symlinks to shared scripts.
        // Materialize their contents so the installed skill is self-contained
        // and chmod never targets a dangling link in the project.
        await fs.copy(srcPath, destPath, { overwrite: true, dereference: true });

        // Make executable for .sh and .py files
        if (relFile.endsWith('.sh') || relFile.endsWith('.py')) {
          await fs.chmod(destPath, 0o755);
        }

        installed++;

        if (debug) {
          console.error(
            `[DEBUG] SkillInstaller: Installed ${group.name}/${relFile} -> ${destPath}`,
          );
        }
      }
    }

    if (installed > 0 && !silent) {
      console.log(`✓ Installed ${installed} skill file(s) for ${group.name} -> ${group.destDir}`);
    }

    return installed;
  }

  /**
   * Install extensions for a single extension group.
   * Uses the same content-based copy strategy as skill installation.
   *
   * @param projectDir - The project root directory
   * @param group - The extension group to install
   * @param silent - If true, suppresses console output
   * @param force - If true, overwrite even if content is identical
   * @returns number of files installed or updated
   */
  private static async installExtensionGroup(
    projectDir: string,
    group: ExtensionGroup,
    silent = true,
    force = false,
  ): Promise<number> {
    const debug = process.env.JUNO_CODE_DEBUG === '1';
    const packageExtDir = this.getPackageExtensionsDir();

    if (!packageExtDir) {
      if (debug) {
        console.error('[DEBUG] SkillInstaller: Package extensions directory not found');
      }
      return 0;
    }

    const sourceGroupDir = path.join(packageExtDir, group.name);
    const destGroupDir = path.join(projectDir, group.destDir);

    const extFiles = await this.getSkillFiles(sourceGroupDir);

    if (extFiles.length === 0) {
      if (debug) {
        console.error(
          `[DEBUG] SkillInstaller: No extension files found for group '${group.name}'`,
        );
      }
      return 0;
    }

    await fs.ensureDir(destGroupDir);

    let installed = 0;

    for (const relFile of extFiles) {
      const srcPath = path.join(sourceGroupDir, relFile);
      const destPath = path.join(destGroupDir, relFile);

      const destParent = path.dirname(destPath);
      await fs.ensureDir(destParent);

      let shouldCopy = force;

      if (!shouldCopy) {
        if (!(await fs.pathExists(destPath))) {
          shouldCopy = true;
        } else {
          const [srcContent, destContent] = await Promise.all([
            fs.readFile(srcPath, 'utf-8'),
            fs.readFile(destPath, 'utf-8'),
          ]);
          if (srcContent !== destContent) {
            shouldCopy = true;
          }
        }
      }

      if (shouldCopy) {
        await fs.copy(srcPath, destPath, { overwrite: true });
        installed++;

        if (debug) {
          console.error(
            `[DEBUG] SkillInstaller: Installed extension ${group.name}/${relFile} -> ${destPath}`,
          );
        }
      }
    }

    if (installed > 0 && !silent) {
      console.log(
        `✓ Installed ${installed} extension file(s) for ${group.name} -> ${group.destDir}`,
      );
    }

    return installed;
  }

  /**
   * Install skills for all skill groups.
   * This copies skill files to the appropriate project directories while
   * preserving any existing files the user may have added.
   *
   * @param projectDir - The project root directory
   * @param silent - If true, suppresses console output
   * @param force - If true, overwrite even if content matches
   * @returns true if any skill files were installed or updated
   */
  static async install(projectDir: string, silent = false, force = false): Promise<boolean> {
    await this.assertInstallAllowed(projectDir);
    const debug = process.env.JUNO_CODE_DEBUG === '1';
    let totalInstalled = await this.installControllerInstructions(projectDir, silent, force);

    for (const group of this.SKILL_GROUPS) {
      try {
        const count = await this.installGroup(projectDir, group, silent, force);
        totalInstalled += count;
      } catch (error) {
        if (debug) {
          console.error(`[DEBUG] SkillInstaller: Error installing group '${group.name}':`, error);
        }
        if (!silent) {
          console.error(
            `⚠️  Failed to install skills for ${group.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Install extensions for all extension groups
    for (const group of this.EXTENSION_GROUPS) {
      try {
        const count = await this.installExtensionGroup(projectDir, group, silent, force);
        totalInstalled += count;
      } catch (error) {
        if (debug) {
          console.error(
            `[DEBUG] SkillInstaller: Error installing extensions for '${group.name}':`,
            error,
          );
        }
        if (!silent) {
          console.error(
            `⚠️  Failed to install extensions for ${group.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Provision Pi settings file (create only if missing, never overwrite)
    try {
      await this.ensurePiSettings(projectDir, silent);
    } catch (error) {
      if (debug) {
        console.error('[DEBUG] SkillInstaller: Error provisioning Pi settings:', error);
      }
    }

    if (totalInstalled > 0 && !silent) {
      console.log(`✓ Total: ${totalInstalled} skill/extension file(s) installed/updated`);
    }

    return totalInstalled > 0;
  }

  /**
   * Auto-update skills on CLI startup.
   * Only installs/updates if the project is initialized (.juno_task exists).
   * Silently does nothing if no skill files are bundled or project is not initialized.
   *
   * @param projectDir - The project root directory
   * @param force - If true, force reinstall all skills
   * @returns true if any updates occurred
   */
  static async autoUpdate(projectDir: string, force = false): Promise<boolean> {
    try {
      const debug = process.env.JUNO_CODE_DEBUG === '1';

      // Only install skills for initialized projects
      const junoTaskDir = path.join(projectDir, '.juno_task');
      if (!(await fs.pathExists(junoTaskDir))) {
        return false;
      }

      if (debug) {
        console.error(`[DEBUG] SkillInstaller: Auto-updating skills (force=${force})`);
      }

      const updated = await this.install(projectDir, true, force);

      if (updated && debug) {
        console.error('[DEBUG] SkillInstaller: Skills auto-updated successfully');
      }

      return updated;
    } catch (error) {
      if (process.env.JUNO_CODE_DEBUG === '1') {
        console.error(
          '[DEBUG] SkillInstaller: autoUpdate error:',
          error instanceof Error ? error.message : String(error),
        );
      }
      return false;
    }
  }

  /**
   * Check if any skills need to be installed or updated.
   *
   * @param projectDir - The project root directory
   * @returns true if any skills are missing or outdated
   */
  static async needsUpdate(projectDir: string): Promise<boolean> {
    try {
      const junoTaskDir = path.join(projectDir, '.juno_task');
      if (!(await fs.pathExists(junoTaskDir))) {
        return false;
      }

      const packageSkillsDir = this.getPackageSkillsDir();
      if (!packageSkillsDir) {
        return false;
      }

      if (await this.isMetadataOnlyController(projectDir)) {
        const source = this.getPackageControllerAgentDir();
        if (!source) return true;
        for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
          const src = path.join(source, filename);
          const dest = path.join(projectDir, filename);
          if (!(await fs.pathExists(dest))) return true;
          if (!(await fs.readFile(src)).equals(await fs.readFile(dest))) return true;
        }
      }

      for (const group of this.SKILL_GROUPS) {
        const sourceGroupDir = path.join(packageSkillsDir, group.name);
        const destGroupDir = path.join(projectDir, group.destDir);

        const skillFiles = await this.getSkillFiles(sourceGroupDir);

        for (const relFile of skillFiles) {
          const srcPath = path.join(sourceGroupDir, relFile);
          const destPath = path.join(destGroupDir, relFile);

          if (!(await fs.pathExists(destPath))) {
            return true;
          }

          const [srcContent, destContent] = await Promise.all([
            fs.readFile(srcPath, 'utf-8'),
            fs.readFile(destPath, 'utf-8'),
          ]);
          if (srcContent !== destContent) {
            return true;
          }
        }
      }

      // Check extension groups
      const packageExtDir = this.getPackageExtensionsDir();
      if (packageExtDir) {
        for (const group of this.EXTENSION_GROUPS) {
          const sourceGroupDir = path.join(packageExtDir, group.name);
          const destGroupDir = path.join(projectDir, group.destDir);

          const extFiles = await this.getSkillFiles(sourceGroupDir);

          for (const relFile of extFiles) {
            const srcPath = path.join(sourceGroupDir, relFile);
            const destPath = path.join(destGroupDir, relFile);

            if (!(await fs.pathExists(destPath))) {
              return true;
            }

            const [srcContent, destContent] = await Promise.all([
              fs.readFile(srcPath, 'utf-8'),
              fs.readFile(destPath, 'utf-8'),
            ]);
            if (srcContent !== destContent) {
              return true;
            }
          }
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * List all skill groups and their installation status.
   *
   * @param projectDir - The project root directory
   * @returns Array of skill group status objects
   */
  static async listSkillGroups(projectDir: string): Promise<
    {
      name: string;
      destDir: string;
      files: { name: string; installed: boolean; upToDate: boolean }[];
    }[]
  > {
    const packageSkillsDir = this.getPackageSkillsDir();
    const results = [];

    for (const group of this.SKILL_GROUPS) {
      const sourceGroupDir = packageSkillsDir ? path.join(packageSkillsDir, group.name) : '';
      const destGroupDir = path.join(projectDir, group.destDir);

      const skillFiles = packageSkillsDir ? await this.getSkillFiles(sourceGroupDir) : [];

      const files = [];
      for (const relFile of skillFiles) {
        const srcPath = path.join(sourceGroupDir, relFile);
        const destPath = path.join(destGroupDir, relFile);

        const installed = await fs.pathExists(destPath);
        let upToDate = false;

        if (installed) {
          try {
            const [srcContent, destContent] = await Promise.all([
              fs.readFile(srcPath, 'utf-8'),
              fs.readFile(destPath, 'utf-8'),
            ]);
            upToDate = srcContent === destContent;
          } catch {
            upToDate = false;
          }
        }

        files.push({ name: relFile, installed, upToDate });
      }

      results.push({
        name: group.name,
        destDir: group.destDir,
        files,
      });
    }

    // Include extension groups
    const packageExtDir = this.getPackageExtensionsDir();
    for (const group of this.EXTENSION_GROUPS) {
      const sourceGroupDir = packageExtDir ? path.join(packageExtDir, group.name) : '';
      const destGroupDir = path.join(projectDir, group.destDir);

      const extFiles = packageExtDir ? await this.getSkillFiles(sourceGroupDir) : [];

      const files = [];
      for (const relFile of extFiles) {
        const srcPath = path.join(sourceGroupDir, relFile);
        const destPath = path.join(destGroupDir, relFile);

        const installed = await fs.pathExists(destPath);
        let upToDate = false;

        if (installed) {
          try {
            const [srcContent, destContent] = await Promise.all([
              fs.readFile(srcPath, 'utf-8'),
              fs.readFile(destPath, 'utf-8'),
            ]);
            upToDate = srcContent === destContent;
          } catch {
            upToDate = false;
          }
        }

        files.push({ name: relFile, installed, upToDate });
      }

      results.push({
        name: `ext:${group.name}`,
        destDir: group.destDir,
        files,
      });
    }

    return results;
  }

  private static isLegacyGeneratedPiSettings(settings: unknown): settings is { skills: string[] } {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return false;
    }

    const settingsObject = settings as Record<string, unknown>;
    const keys = Object.keys(settingsObject);
    if (keys.length !== 1 || keys[0] !== 'skills') {
      return false;
    }

    const skills = settingsObject.skills;
    return Array.isArray(skills) && skills.length === 1 && skills[0] === '.claude/skills';
  }

  /**
   * Ensure Pi agent settings file exists with cross-agent skill loading.
   *
   * Creates `.pi/settings.json` if it does not exist, configured to also
   * load skills from `.claude/skills/` and with `quietStartup: true` to
   * reduce noisy startup diagnostics in subagent runs.
   *
   * Existing user settings are preserved. The only in-place update is a
   * one-time upgrade for the legacy auto-generated settings shape
   * (`{ skills: ['.claude/skills'] }`) by appending `quietStartup: true`.
   *
   * @param projectDir - The project root directory
   * @param silent - If true, suppresses console output
   */
  static async ensurePiSettings(projectDir: string, silent = true): Promise<void> {
    const debug = process.env.JUNO_CODE_DEBUG === '1';
    const piDir = path.join(projectDir, '.pi');
    const settingsPath = path.join(piDir, 'settings.json');

    if (await fs.pathExists(settingsPath)) {
      try {
        const existing = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as unknown;

        if (this.isLegacyGeneratedPiSettings(existing)) {
          const upgraded = { ...existing, quietStartup: true };
          await fs.writeFile(settingsPath, JSON.stringify(upgraded, null, 2) + '\n');

          if (debug) {
            console.error(
              `[DEBUG] SkillInstaller: Upgraded legacy Pi settings with quietStartup at ${settingsPath}`,
            );
          }

          if (!silent) {
            console.log('✓ Updated .pi/settings.json (enabled quietStartup for cleaner output)');
          }
        } else if (debug) {
          console.error('[DEBUG] SkillInstaller: Pi settings.json already exists, preserving user config');
        }
      } catch (error) {
        if (debug) {
          console.error(
            '[DEBUG] SkillInstaller: Failed to parse existing Pi settings.json, preserving as-is:',
            error,
          );
        }
      }
      return;
    }

    await fs.ensureDir(piDir);

    await fs.writeFile(settingsPath, JSON.stringify(this.DEFAULT_PI_SETTINGS, null, 2) + '\n');

    if (debug) {
      console.error(`[DEBUG] SkillInstaller: Created Pi settings.json at ${settingsPath}`);
    }

    if (!silent) {
      console.log('✓ Created .pi/settings.json (loads Claude skills + quiet startup by default)');
    }
  }

  /**
   * Get the list of skill group configurations.
   */
  static getSkillGroups(): SkillGroup[] {
    return [...this.SKILL_GROUPS];
  }
}
