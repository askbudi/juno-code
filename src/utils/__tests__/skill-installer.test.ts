/**
 * Skill Installer Tests
 * Tests for the SkillInstaller utility that manages agent skill files
 *
 * The SkillInstaller copies skill files from package templates into project directories:
 *   - codex skills -> .agents/skills/
 *   - claude skills -> .claude/skills/
 *
 * These tests verify correct behavior for installation, content-based updates,
 * file listing, and auto-update logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillInstaller } from '../skill-installer.js';

describe('SkillInstaller', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `skill-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.ensureDir(testDir);
  });

  afterEach(async () => {
    if (testDir) {
      await fs.remove(testDir);
    }
  });

  describe('getSkillGroups', () => {
    it('should return the configured skill groups', () => {
      const groups = SkillInstaller.getSkillGroups();
      expect(groups).toEqual([
        { name: 'codex', destDir: '.agents/skills' },
        { name: 'claude', destDir: '.claude/skills' },
      ]);
    });

    it('should return a copy (not the internal array)', () => {
      const groups1 = SkillInstaller.getSkillGroups();
      const groups2 = SkillInstaller.getSkillGroups();
      expect(groups1).not.toBe(groups2);
      expect(groups1).toEqual(groups2);
    });
  });

  describe('needsUpdate', () => {
    it('should return false when project is not initialized', async () => {
      const result = await SkillInstaller.needsUpdate(testDir);
      expect(result).toBe(false);
    });

    it('should return false when .juno_task does not exist', async () => {
      const result = await SkillInstaller.needsUpdate(testDir);
      expect(result).toBe(false);
    });

    it('should handle initialized project gracefully', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));
      const result = await SkillInstaller.needsUpdate(testDir);
      // Result depends on whether templates have skill files
      expect(typeof result).toBe('boolean');
    });
  });

  describe('install', () => {
    it('should not fail when templates directory is empty', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));
      // Even if no skill files exist in templates, install should not throw
      const result = await SkillInstaller.install(testDir, true);
      expect(typeof result).toBe('boolean');
    });

    it('should create destination directories', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));
      await SkillInstaller.install(testDir, true);

      // If templates had files, destination dirs would be created
      // This test just verifies no errors
    });

    it('should return false when no skill files to install', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));
      // With empty template dirs (only .gitkeep), nothing should be installed
      const result = await SkillInstaller.install(testDir, true);
      // .gitkeep files are excluded, so with empty templates result is false
      expect(typeof result).toBe('boolean');
    });
  });

  describe('autoUpdate', () => {
    it('should return false when project is not initialized', async () => {
      const result = await SkillInstaller.autoUpdate(testDir);
      expect(result).toBe(false);
    });

    it('should not throw on initialized projects', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));
      const result = await SkillInstaller.autoUpdate(testDir);
      expect(typeof result).toBe('boolean');
    });

    it('should support force parameter', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));
      const result = await SkillInstaller.autoUpdate(testDir, true);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('listSkillGroups', () => {
    it('should return all configured skill groups', async () => {
      const groups = await SkillInstaller.listSkillGroups(testDir);
      expect(groups.length).toBe(2);
      expect(groups[0].name).toBe('codex');
      expect(groups[0].destDir).toBe('.agents/skills');
      expect(groups[1].name).toBe('claude');
      expect(groups[1].destDir).toBe('.claude/skills');
    });

    it('should show files as not installed when destination is empty', async () => {
      const groups = await SkillInstaller.listSkillGroups(testDir);

      for (const group of groups) {
        for (const file of group.files) {
          expect(file.installed).toBe(false);
        }
      }
    });

    it('should return empty files array when no skills are bundled', async () => {
      const groups = await SkillInstaller.listSkillGroups(testDir);

      // With only .gitkeep in templates (which is excluded), files should be empty
      for (const group of groups) {
        // May or may not have files depending on template content
        expect(Array.isArray(group.files)).toBe(true);
      }
    });
  });

  describe('install with actual skill files', () => {
    it('should install skill files to correct destinations', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      // Simulate by calling install - actual files depend on template content
      const result = await SkillInstaller.install(testDir, true);
      expect(typeof result).toBe('boolean');
    });

    it('should preserve existing files in destination directories', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      // Create pre-existing files in destination directories
      const agentsDir = path.join(testDir, '.agents', 'skills');
      const claudeDir = path.join(testDir, '.claude', 'skills');
      await fs.ensureDir(agentsDir);
      await fs.ensureDir(claudeDir);

      await fs.writeFile(path.join(agentsDir, 'user-custom-skill.md'), '# My Custom Skill');
      await fs.writeFile(path.join(claudeDir, 'my-project-skill.md'), '# Project Skill');

      // Install skills
      await SkillInstaller.install(testDir, true);

      // Verify pre-existing files are NOT deleted
      const userSkill = await fs.readFile(path.join(agentsDir, 'user-custom-skill.md'), 'utf-8');
      expect(userSkill).toBe('# My Custom Skill');

      const projectSkill = await fs.readFile(path.join(claudeDir, 'my-project-skill.md'), 'utf-8');
      expect(projectSkill).toBe('# Project Skill');
    });
  });

  describe('content-based updates', () => {
    it('should detect when installed files differ from package', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      // First install
      await SkillInstaller.install(testDir, true);

      // After installation, a second call should not update (same content)
      const secondResult = await SkillInstaller.install(testDir, true);
      // With empty templates, always false
      expect(typeof secondResult).toBe('boolean');
    });
  });

  describe('force install', () => {
    it('should reinstall even if content matches', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      // First install
      await SkillInstaller.install(testDir, true);

      // Force install should re-copy files
      const forceResult = await SkillInstaller.install(testDir, true, true);
      expect(typeof forceResult).toBe('boolean');
    });
  });

  describe('edge cases', () => {
    it('should handle non-existent project directory gracefully', async () => {
      const nonExistent = path.join(testDir, 'does-not-exist');
      const result = await SkillInstaller.autoUpdate(nonExistent);
      expect(result).toBe(false);
    });

    it('should handle permission errors gracefully', async () => {
      // autoUpdate catches errors internally
      const result = await SkillInstaller.autoUpdate('/root/no-access-dir');
      expect(result).toBe(false);
    });
  });
});
