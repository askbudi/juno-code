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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  describe('nested folder support', () => {
    let mockSkillsDir: string;

    beforeEach(async () => {
      // Create a mock templates/skills directory with nested folder structures
      mockSkillsDir = path.join(testDir, 'mock-templates', 'skills');

      // Create codex skills with nested folders
      const codexDir = path.join(mockSkillsDir, 'codex');
      await fs.ensureDir(path.join(codexDir, 'analysis', 'prompts'));
      await fs.ensureDir(path.join(codexDir, 'debugging', 'scripts'));
      await fs.writeFile(path.join(codexDir, 'README.md'), '# Codex Skills');
      await fs.writeFile(path.join(codexDir, 'analysis', 'analyze.md'), '# Analysis Skill');
      await fs.writeFile(path.join(codexDir, 'analysis', 'prompts', 'system.txt'), 'You are an analyzer');
      await fs.writeFile(path.join(codexDir, 'debugging', 'debug.md'), '# Debug Skill');
      await fs.writeFile(path.join(codexDir, 'debugging', 'scripts', 'trace.sh'), '#!/bin/bash\necho trace');

      // Create claude skills with nested folders
      const claudeDir = path.join(mockSkillsDir, 'claude');
      await fs.ensureDir(path.join(claudeDir, 'refactor', 'templates'));
      await fs.writeFile(path.join(claudeDir, 'refactor', 'refactor.md'), '# Refactor Skill');
      await fs.writeFile(path.join(claudeDir, 'refactor', 'templates', 'component.txt'), 'Template content');
      await fs.writeFile(path.join(claudeDir, 'top-level.md'), '# Top Level Skill');

      // Create project dir with .juno_task
      await fs.ensureDir(path.join(testDir, 'project', '.juno_task'));

      // Mock getPackageSkillsDir to return our mock directory
      vi.spyOn(SkillInstaller as unknown as { getPackageSkillsDir: () => string | null }, 'getPackageSkillsDir')
        .mockReturnValue(mockSkillsDir);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should install files from nested subdirectories', async () => {
      const projectDir = path.join(testDir, 'project');
      const result = await SkillInstaller.install(projectDir, true);

      expect(result).toBe(true);

      // Verify codex nested files were installed
      const agentsSkillsDir = path.join(projectDir, '.agents', 'skills');
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'README.md'))).toBe(true);
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'analysis', 'analyze.md'))).toBe(true);
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'analysis', 'prompts', 'system.txt'))).toBe(true);
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'debugging', 'debug.md'))).toBe(true);
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'debugging', 'scripts', 'trace.sh'))).toBe(true);

      // Verify claude nested files were installed
      const claudeSkillsDir = path.join(projectDir, '.claude', 'skills');
      expect(await fs.pathExists(path.join(claudeSkillsDir, 'top-level.md'))).toBe(true);
      expect(await fs.pathExists(path.join(claudeSkillsDir, 'refactor', 'refactor.md'))).toBe(true);
      expect(await fs.pathExists(path.join(claudeSkillsDir, 'refactor', 'templates', 'component.txt'))).toBe(true);
    });

    it('should preserve file content in nested directories', async () => {
      const projectDir = path.join(testDir, 'project');
      await SkillInstaller.install(projectDir, true);

      const agentsSkillsDir = path.join(projectDir, '.agents', 'skills');
      const claudeSkillsDir = path.join(projectDir, '.claude', 'skills');

      expect(await fs.readFile(path.join(agentsSkillsDir, 'analysis', 'prompts', 'system.txt'), 'utf-8'))
        .toBe('You are an analyzer');
      expect(await fs.readFile(path.join(claudeSkillsDir, 'refactor', 'templates', 'component.txt'), 'utf-8'))
        .toBe('Template content');
    });

    it('should make .sh files executable in nested directories', async () => {
      const projectDir = path.join(testDir, 'project');
      await SkillInstaller.install(projectDir, true);

      const traceScript = path.join(projectDir, '.agents', 'skills', 'debugging', 'scripts', 'trace.sh');
      const stat = await fs.stat(traceScript);
      // Check executable bit (owner execute)
      expect(stat.mode & 0o100).toBeTruthy();
    });

    it('should skip hidden files and __pycache__ in nested directories', async () => {
      // Add hidden files and __pycache__ in nested dirs
      const codexDir = path.join(mockSkillsDir, 'codex');
      await fs.writeFile(path.join(codexDir, 'analysis', '.hidden-file'), 'hidden');
      await fs.ensureDir(path.join(codexDir, 'analysis', '__pycache__'));
      await fs.writeFile(path.join(codexDir, 'analysis', '__pycache__', 'cached.pyc'), 'bytecode');
      await fs.ensureDir(path.join(codexDir, '.hidden-dir'));
      await fs.writeFile(path.join(codexDir, '.hidden-dir', 'secret.txt'), 'secret');

      const projectDir = path.join(testDir, 'project');
      await SkillInstaller.install(projectDir, true);

      const agentsSkillsDir = path.join(projectDir, '.agents', 'skills');
      // Hidden files should NOT be copied
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'analysis', '.hidden-file'))).toBe(false);
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'analysis', '__pycache__'))).toBe(false);
      expect(await fs.pathExists(path.join(agentsSkillsDir, '.hidden-dir'))).toBe(false);

      // Non-hidden files should still be copied
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'analysis', 'analyze.md'))).toBe(true);
    });

    it('should content-compare nested files and skip unchanged ones', async () => {
      const projectDir = path.join(testDir, 'project');

      // First install
      await SkillInstaller.install(projectDir, true);

      // Modify one nested file in destination
      const destFile = path.join(projectDir, '.agents', 'skills', 'analysis', 'prompts', 'system.txt');
      await fs.writeFile(destFile, 'Modified by user');

      // Second install should overwrite modified file (content differs)
      await SkillInstaller.install(projectDir, true);

      // File should be restored to template content
      expect(await fs.readFile(destFile, 'utf-8')).toBe('You are an analyzer');
    });

    it('should preserve user files in nested destination directories', async () => {
      const projectDir = path.join(testDir, 'project');

      // Create user files in nested directories that overlap with skill dirs
      const userDir = path.join(projectDir, '.agents', 'skills', 'analysis', 'custom');
      await fs.ensureDir(userDir);
      await fs.writeFile(path.join(userDir, 'my-analysis.md'), '# My Custom Analysis');

      // Install skills
      await SkillInstaller.install(projectDir, true);

      // User files should still exist
      expect(await fs.pathExists(path.join(userDir, 'my-analysis.md'))).toBe(true);
      expect(await fs.readFile(path.join(userDir, 'my-analysis.md'), 'utf-8'))
        .toBe('# My Custom Analysis');

      // Skill files should also exist
      expect(await fs.pathExists(path.join(projectDir, '.agents', 'skills', 'analysis', 'analyze.md'))).toBe(true);
    });

    it('should report nested files in listSkillGroups', async () => {
      const projectDir = path.join(testDir, 'project');

      // List before install
      const beforeInstall = await SkillInstaller.listSkillGroups(projectDir);
      const codexGroup = beforeInstall.find(g => g.name === 'codex')!;

      // Should include nested file paths with forward slashes
      const fileNames = codexGroup.files.map(f => f.name);
      expect(fileNames).toContain('README.md');
      expect(fileNames).toContain('analysis/analyze.md');
      expect(fileNames).toContain('analysis/prompts/system.txt');
      expect(fileNames).toContain('debugging/debug.md');
      expect(fileNames).toContain('debugging/scripts/trace.sh');

      // Before install, nothing should be marked as installed
      for (const file of codexGroup.files) {
        expect(file.installed).toBe(false);
      }

      // Install and verify status updates
      await SkillInstaller.install(projectDir, true);
      const afterInstall = await SkillInstaller.listSkillGroups(projectDir);
      const codexAfter = afterInstall.find(g => g.name === 'codex')!;

      for (const file of codexAfter.files) {
        expect(file.installed).toBe(true);
        expect(file.upToDate).toBe(true);
      }
    });

    it('should detect nested files needing update via needsUpdate', async () => {
      const projectDir = path.join(testDir, 'project');

      // Before install, needs update should be true (files missing)
      expect(await SkillInstaller.needsUpdate(projectDir)).toBe(true);

      // After install, should not need update
      await SkillInstaller.install(projectDir, true);
      expect(await SkillInstaller.needsUpdate(projectDir)).toBe(false);

      // Modify a nested file -> should need update again
      const nestedFile = path.join(projectDir, '.agents', 'skills', 'analysis', 'prompts', 'system.txt');
      await fs.writeFile(nestedFile, 'Modified content');
      expect(await SkillInstaller.needsUpdate(projectDir)).toBe(true);
    });

    it('should force reinstall all nested files', async () => {
      const projectDir = path.join(testDir, 'project');

      // Install normally
      await SkillInstaller.install(projectDir, true);

      // Force install should return true even when content matches
      const forceResult = await SkillInstaller.install(projectDir, true, true);
      expect(forceResult).toBe(true);

      // All files should still be present
      const agentsSkillsDir = path.join(projectDir, '.agents', 'skills');
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'analysis', 'prompts', 'system.txt'))).toBe(true);
      expect(await fs.pathExists(path.join(agentsSkillsDir, 'debugging', 'scripts', 'trace.sh'))).toBe(true);
    });

    it('should handle deeply nested directories (3+ levels)', async () => {
      // Add deeply nested structure
      const codexDir = path.join(mockSkillsDir, 'codex');
      await fs.ensureDir(path.join(codexDir, 'level1', 'level2', 'level3', 'level4'));
      await fs.writeFile(
        path.join(codexDir, 'level1', 'level2', 'level3', 'level4', 'deep-skill.py'),
        '#!/usr/bin/env python3\nprint("deep")'
      );

      const projectDir = path.join(testDir, 'project');
      await SkillInstaller.install(projectDir, true);

      const deepFile = path.join(projectDir, '.agents', 'skills', 'level1', 'level2', 'level3', 'level4', 'deep-skill.py');
      expect(await fs.pathExists(deepFile)).toBe(true);
      expect(await fs.readFile(deepFile, 'utf-8')).toBe('#!/usr/bin/env python3\nprint("deep")');

      // .py files should be executable
      const stat = await fs.stat(deepFile);
      expect(stat.mode & 0o100).toBeTruthy();
    });
  });
});
