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
 *
 * Template source directories (in package):
 *   - src/templates/skills/codex/   (development)
 *   - src/templates/skills/claude/  (development)
 *   - dist/templates/skills/codex/  (production)
 *   - dist/templates/skills/claude/ (production)
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

export class SkillInstaller {
  /**
   * Skill groups define which template folders map to which project directories.
   * New agents can be added here without changing any other logic.
   */
  private static readonly SKILL_GROUPS: SkillGroup[] = [
    { name: 'codex', destDir: '.agents/skills' },
    { name: 'claude', destDir: '.claude/skills' },
  ];

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
   * Get list of skill files in a specific skill group template directory.
   * Returns paths relative to the group directory.
   */
  private static async getSkillFiles(groupDir: string): Promise<string[]> {
    if (!await fs.pathExists(groupDir)) {
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
    force = false
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
        if (!await fs.pathExists(destPath)) {
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
        await fs.copy(srcPath, destPath, { overwrite: true });

        // Make executable for .sh and .py files
        if (relFile.endsWith('.sh') || relFile.endsWith('.py')) {
          await fs.chmod(destPath, 0o755);
        }

        installed++;

        if (debug) {
          console.error(`[DEBUG] SkillInstaller: Installed ${group.name}/${relFile} -> ${destPath}`);
        }
      }
    }

    if (installed > 0 && !silent) {
      console.log(`✓ Installed ${installed} skill file(s) for ${group.name} -> ${group.destDir}`);
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
    const debug = process.env.JUNO_CODE_DEBUG === '1';
    let totalInstalled = 0;

    for (const group of this.SKILL_GROUPS) {
      try {
        const count = await this.installGroup(projectDir, group, silent, force);
        totalInstalled += count;
      } catch (error) {
        if (debug) {
          console.error(`[DEBUG] SkillInstaller: Error installing group '${group.name}':`, error);
        }
        if (!silent) {
          console.error(`⚠️  Failed to install skills for ${group.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (totalInstalled > 0 && !silent) {
      console.log(`✓ Total: ${totalInstalled} skill file(s) installed/updated`);
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
      if (!await fs.pathExists(junoTaskDir)) {
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
        console.error('[DEBUG] SkillInstaller: autoUpdate error:', error instanceof Error ? error.message : String(error));
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
      if (!await fs.pathExists(junoTaskDir)) {
        return false;
      }

      const packageSkillsDir = this.getPackageSkillsDir();
      if (!packageSkillsDir) {
        return false;
      }

      for (const group of this.SKILL_GROUPS) {
        const sourceGroupDir = path.join(packageSkillsDir, group.name);
        const destGroupDir = path.join(projectDir, group.destDir);

        const skillFiles = await this.getSkillFiles(sourceGroupDir);

        for (const relFile of skillFiles) {
          const srcPath = path.join(sourceGroupDir, relFile);
          const destPath = path.join(destGroupDir, relFile);

          if (!await fs.pathExists(destPath)) {
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
  static async listSkillGroups(projectDir: string): Promise<{
    name: string;
    destDir: string;
    files: { name: string; installed: boolean; upToDate: boolean }[];
  }[]> {
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

    return results;
  }

  /**
   * Get the list of skill group configurations.
   */
  static getSkillGroups(): SkillGroup[] {
    return [...this.SKILL_GROUPS];
  }
}
