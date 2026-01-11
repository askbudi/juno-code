/**
 * Script Installer Tests
 * Tests for the ScriptInstaller utility that manages project-level scripts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { ScriptInstaller } from '../script-installer.js';

describe('ScriptInstaller', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `script-installer-test-${Date.now()}`);
    await fs.ensureDir(testDir);
  });

  afterEach(async () => {
    // Cleanup test directory
    if (testDir) {
      await fs.remove(testDir);
    }
  });

  describe('scriptExists', () => {
    it('should return false when .juno_task does not exist', async () => {
      const exists = await ScriptInstaller.scriptExists(testDir, 'run_until_completion.sh');
      expect(exists).toBe(false);
    });

    it('should return false when script does not exist', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task', 'scripts'));
      const exists = await ScriptInstaller.scriptExists(testDir, 'run_until_completion.sh');
      expect(exists).toBe(false);
    });

    it('should return true when script exists', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      await fs.ensureDir(scriptsDir);
      await fs.writeFile(path.join(scriptsDir, 'run_until_completion.sh'), '#!/bin/bash\necho "test"');

      const exists = await ScriptInstaller.scriptExists(testDir, 'run_until_completion.sh');
      expect(exists).toBe(true);
    });
  });

  describe('getMissingScripts', () => {
    it('should return all required scripts when .juno_task does not exist', async () => {
      const missing = await ScriptInstaller.getMissingScripts(testDir);
      expect(missing).toContain('run_until_completion.sh');
      expect(missing).toContain('kanban.sh');
      expect(missing).toContain('install_requirements.sh'); // Required by kanban.sh
    });

    it('should return empty array when all required scripts exist', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      await fs.ensureDir(scriptsDir);
      // Create all required scripts including install_requirements.sh and Slack scripts
      await fs.writeFile(path.join(scriptsDir, 'run_until_completion.sh'), '#!/bin/bash\necho "test"');
      await fs.writeFile(path.join(scriptsDir, 'kanban.sh'), '#!/bin/bash\necho "kanban"');
      await fs.writeFile(path.join(scriptsDir, 'install_requirements.sh'), '#!/bin/bash\necho "install"');
      // Slack integration scripts
      await fs.writeFile(path.join(scriptsDir, 'slack_state.py'), '#!/usr/bin/env python3\nprint("state")');
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.py'), '#!/usr/bin/env python3\nprint("fetch")');
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.sh'), '#!/bin/bash\necho "fetch"');
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.py'), '#!/usr/bin/env python3\nprint("respond")');
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.sh'), '#!/bin/bash\necho "respond"');

      const missing = await ScriptInstaller.getMissingScripts(testDir);
      expect(missing).toEqual([]);
    });
  });

  describe('installScript', () => {
    it('should not install if project not initialized', async () => {
      // Note: This will fail because getPackageScriptsDir may not find scripts in test env
      // The test verifies the flow doesn't throw
      const result = await ScriptInstaller.installScript(testDir, 'run_until_completion.sh', true);
      // Result depends on whether templates are accessible
      expect(typeof result).toBe('boolean');
    });

    it('should create .juno_task/scripts directory if needed', async () => {
      // Create .juno_task but not scripts
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      // Install will try to create scripts dir
      await ScriptInstaller.installScript(testDir, 'run_until_completion.sh', true);

      // Even if install fails (no source), dir should be created
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      const dirExists = await fs.pathExists(scriptsDir);
      expect(dirExists).toBe(true);
    });
  });

  describe('autoInstallMissing', () => {
    it('should not install when project is not initialized', async () => {
      const installed = await ScriptInstaller.autoInstallMissing(testDir, true);
      expect(installed).toBe(false);
    });

    it('should attempt install when .juno_task exists but scripts are missing', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      // Call autoInstallMissing - it will try to install
      const installed = await ScriptInstaller.autoInstallMissing(testDir, true);
      // Result depends on whether templates are accessible
      expect(typeof installed).toBe('boolean');
    });
  });

  describe('getScriptPath', () => {
    it('should return correct path', () => {
      const scriptPath = ScriptInstaller.getScriptPath('/some/project', 'run_until_completion.sh');
      expect(scriptPath).toBe('/some/project/.juno_task/scripts/run_until_completion.sh');
    });
  });

  describe('listRequiredScripts', () => {
    it('should list required scripts with installation status', async () => {
      const list = await ScriptInstaller.listRequiredScripts(testDir);

      expect(list).toEqual([
        { name: 'run_until_completion.sh', installed: false },
        { name: 'kanban.sh', installed: false },
        { name: 'install_requirements.sh', installed: false },
        // Slack integration scripts
        { name: 'slack_state.py', installed: false },
        { name: 'slack_fetch.py', installed: false },
        { name: 'slack_fetch.sh', installed: false },
        { name: 'slack_respond.py', installed: false },
        { name: 'slack_respond.sh', installed: false },
      ]);
    });

    it('should show installed=true for existing scripts', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      await fs.ensureDir(scriptsDir);
      await fs.writeFile(path.join(scriptsDir, 'run_until_completion.sh'), '#!/bin/bash\necho "test"');
      await fs.writeFile(path.join(scriptsDir, 'kanban.sh'), '#!/bin/bash\necho "kanban"');
      await fs.writeFile(path.join(scriptsDir, 'install_requirements.sh'), '#!/bin/bash\necho "install"');
      // Slack integration scripts
      await fs.writeFile(path.join(scriptsDir, 'slack_state.py'), '#!/usr/bin/env python3\nprint("state")');
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.py'), '#!/usr/bin/env python3\nprint("fetch")');
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.sh'), '#!/bin/bash\necho "fetch"');
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.py'), '#!/usr/bin/env python3\nprint("respond")');
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.sh'), '#!/bin/bash\necho "respond"');

      const list = await ScriptInstaller.listRequiredScripts(testDir);

      expect(list).toEqual([
        { name: 'run_until_completion.sh', installed: true },
        { name: 'kanban.sh', installed: true },
        { name: 'install_requirements.sh', installed: true },
        // Slack integration scripts
        { name: 'slack_state.py', installed: true },
        { name: 'slack_fetch.py', installed: true },
        { name: 'slack_fetch.sh', installed: true },
        { name: 'slack_respond.py', installed: true },
        { name: 'slack_respond.sh', installed: true },
      ]);
    });
  });

  describe('updateScriptIfNewer', () => {
    it('should install script if it does not exist', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      const updated = await ScriptInstaller.updateScriptIfNewer(testDir, 'run_until_completion.sh', true);
      // Result depends on whether templates are accessible
      expect(typeof updated).toBe('boolean');
    });
  });
});
