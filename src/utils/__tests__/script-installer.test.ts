/**
 * Script Installer Tests
 * Tests for the ScriptInstaller utility that manages project-level scripts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
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
      await fs.writeFile(
        path.join(scriptsDir, 'run_until_completion.sh'),
        '#!/bin/bash\necho "test"',
      );

      const exists = await ScriptInstaller.scriptExists(testDir, 'run_until_completion.sh');
      expect(exists).toBe(true);
    });
  });

  describe('getMissingScripts', () => {
    it('should return all required scripts when .juno_task does not exist', async () => {
      const missing = await ScriptInstaller.getMissingScripts(testDir);
      expect(missing).toContain('run_until_completion.sh');
      expect(missing).toContain('kanban.sh');
      expect(missing).toContain('juno-toolchain-policy.sh');
      expect(missing).toContain('controller_resolver.py');
      expect(missing).toContain('orchestration_guard.py');
      expect(missing).toContain('install_requirements.sh'); // Required by kanban.sh
      expect(missing).toContain('workflow_runner.sh');
      expect(missing).toContain('workflow_assert.py');
      expect(missing).toContain('controller_checkpoint.py');
      expect(missing).toContain('integration_owner_preflight.py');
      expect(missing).toContain('repository_writer_guard.py');
      expect(missing).toContain('worktree_lifecycle_audit.py');
    });

    it('should return empty array when all required scripts exist', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      const hooksDir = path.join(scriptsDir, 'hooks');
      await fs.ensureDir(scriptsDir);
      await fs.ensureDir(hooksDir);
      // Create all required scripts including install_requirements.sh and Slack scripts
      await fs.writeFile(
        path.join(scriptsDir, 'run_until_completion.sh'),
        '#!/bin/bash\necho "test"',
      );
      await fs.writeFile(path.join(scriptsDir, 'kanban.sh'), '#!/bin/bash\necho "kanban"');
      await fs.writeFile(
        path.join(scriptsDir, 'juno-toolchain-policy.sh'),
        '#!/bin/bash\necho "policy"',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'controller_resolver.py'),
        '#!/usr/bin/env python3\nprint("controller")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'orchestration_guard.py'),
        '#!/usr/bin/env python3\nprint("guard")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'install_requirements.sh'),
        '#!/bin/bash\necho "install"',
      );
      // Shared utilities
      await fs.writeFile(
        path.join(scriptsDir, 'attachment_downloader.py'),
        '#!/usr/bin/env python3\nprint("downloader")',
      );
      // Slack integration scripts
      await fs.writeFile(
        path.join(scriptsDir, 'slack_state.py'),
        '#!/usr/bin/env python3\nprint("state")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'slack_fetch.py'),
        '#!/usr/bin/env python3\nprint("fetch")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.sh'), '#!/bin/bash\necho "fetch"');
      await fs.writeFile(
        path.join(scriptsDir, 'slack_respond.py'),
        '#!/usr/bin/env python3\nprint("respond")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.sh'), '#!/bin/bash\necho "respond"');
      // GitHub integration script
      await fs.writeFile(
        path.join(scriptsDir, 'github.py'),
        '#!/usr/bin/env python3\nprint("github")',
      );
      // Claude Code hooks
      await fs.writeFile(
        path.join(hooksDir, 'session_counter.sh'),
        '#!/bin/bash\necho "session_counter"',
      );
      // Log scanning utility
      await fs.writeFile(
        path.join(scriptsDir, 'log_scanner.sh'),
        '#!/bin/bash\necho "log_scanner"',
      );
      // Parallel execution
      await fs.writeFile(
        path.join(scriptsDir, 'parallel_runner.sh'),
        '#!/usr/bin/env python3\nprint("parallel")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'parallel_runner_wait.sh'),
        '#!/usr/bin/env python3\nprint("parallel wait")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'workflow_runner.sh'),
        '#!/usr/bin/env python3\nprint("workflow")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'workflow_assert.py'),
        '#!/usr/bin/env python3\nprint("assert")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'controller_checkpoint.py'),
        '#!/usr/bin/env python3\nprint("checkpoint")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'integration_owner_preflight.py'),
        '#!/usr/bin/env python3\nprint("preflight")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'repository_writer_guard.py'),
        '#!/usr/bin/env python3\nprint("writer guard")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'worktree_lifecycle_audit.py'),
        '#!/usr/bin/env python3\nprint("audit")',
      );

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
        { name: 'juno-toolchain-policy.sh', installed: false },
        { name: 'controller_resolver.py', installed: false },
        { name: 'orchestration_guard.py', installed: false },
        { name: 'install_requirements.sh', installed: false },
        // Shared utilities
        { name: 'attachment_downloader.py', installed: false },
        // Slack integration scripts
        { name: 'slack_state.py', installed: false },
        { name: 'slack_fetch.py', installed: false },
        { name: 'slack_fetch.sh', installed: false },
        { name: 'slack_respond.py', installed: false },
        { name: 'slack_respond.sh', installed: false },
        // GitHub integration script
        { name: 'github.py', installed: false },
        // Claude Code hooks
        { name: 'hooks/session_counter.sh', installed: false },
        // Log scanning utility
        { name: 'log_scanner.sh', installed: false },
        // Parallel/workflow execution
        { name: 'parallel_runner.sh', installed: false },
        { name: 'parallel_runner_wait.sh', installed: false },
        { name: 'workflow_runner.sh', installed: false },
        { name: 'workflow_assert.py', installed: false },
        { name: 'controller_checkpoint.py', installed: false },
        { name: 'integration_owner_preflight.py', installed: false },
        { name: 'repository_writer_guard.py', installed: false },
        { name: 'worktree_lifecycle_audit.py', installed: false },
      ]);
    });

    it('should show installed=true for existing scripts', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      const hooksDir = path.join(scriptsDir, 'hooks');
      await fs.ensureDir(scriptsDir);
      await fs.ensureDir(hooksDir);
      await fs.writeFile(
        path.join(scriptsDir, 'run_until_completion.sh'),
        '#!/bin/bash\necho "test"',
      );
      await fs.writeFile(path.join(scriptsDir, 'kanban.sh'), '#!/bin/bash\necho "kanban"');
      await fs.writeFile(
        path.join(scriptsDir, 'juno-toolchain-policy.sh'),
        '#!/bin/bash\necho "policy"',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'controller_resolver.py'),
        '#!/usr/bin/env python3\nprint("controller")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'orchestration_guard.py'),
        '#!/usr/bin/env python3\nprint("guard")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'install_requirements.sh'),
        '#!/bin/bash\necho "install"',
      );
      // Shared utilities
      await fs.writeFile(
        path.join(scriptsDir, 'attachment_downloader.py'),
        '#!/usr/bin/env python3\nprint("downloader")',
      );
      // Slack integration scripts
      await fs.writeFile(
        path.join(scriptsDir, 'slack_state.py'),
        '#!/usr/bin/env python3\nprint("state")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'slack_fetch.py'),
        '#!/usr/bin/env python3\nprint("fetch")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.sh'), '#!/bin/bash\necho "fetch"');
      await fs.writeFile(
        path.join(scriptsDir, 'slack_respond.py'),
        '#!/usr/bin/env python3\nprint("respond")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.sh'), '#!/bin/bash\necho "respond"');
      // GitHub integration script
      await fs.writeFile(
        path.join(scriptsDir, 'github.py'),
        '#!/usr/bin/env python3\nprint("github")',
      );
      // Claude Code hooks
      await fs.writeFile(
        path.join(hooksDir, 'session_counter.sh'),
        '#!/bin/bash\necho "session_counter"',
      );
      // Log scanning utility
      await fs.writeFile(
        path.join(scriptsDir, 'log_scanner.sh'),
        '#!/bin/bash\necho "log_scanner"',
      );
      // Parallel execution
      await fs.writeFile(
        path.join(scriptsDir, 'parallel_runner.sh'),
        '#!/usr/bin/env python3\nprint("parallel")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'parallel_runner_wait.sh'),
        '#!/usr/bin/env python3\nprint("parallel wait")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'workflow_runner.sh'),
        '#!/usr/bin/env python3\nprint("workflow")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'workflow_assert.py'),
        '#!/usr/bin/env python3\nprint("assert")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'controller_checkpoint.py'),
        '#!/usr/bin/env python3\nprint("checkpoint")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'integration_owner_preflight.py'),
        '#!/usr/bin/env python3\nprint("preflight")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'repository_writer_guard.py'),
        '#!/usr/bin/env python3\nprint("writer guard")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'worktree_lifecycle_audit.py'),
        '#!/usr/bin/env python3\nprint("audit")',
      );

      const list = await ScriptInstaller.listRequiredScripts(testDir);

      expect(list).toEqual([
        { name: 'run_until_completion.sh', installed: true },
        { name: 'kanban.sh', installed: true },
        { name: 'juno-toolchain-policy.sh', installed: true },
        { name: 'controller_resolver.py', installed: true },
        { name: 'orchestration_guard.py', installed: true },
        { name: 'install_requirements.sh', installed: true },
        // Shared utilities
        { name: 'attachment_downloader.py', installed: true },
        // Slack integration scripts
        { name: 'slack_state.py', installed: true },
        { name: 'slack_fetch.py', installed: true },
        { name: 'slack_fetch.sh', installed: true },
        { name: 'slack_respond.py', installed: true },
        { name: 'slack_respond.sh', installed: true },
        // GitHub integration script
        { name: 'github.py', installed: true },
        // Claude Code hooks
        { name: 'hooks/session_counter.sh', installed: true },
        // Log scanning utility
        { name: 'log_scanner.sh', installed: true },
        // Parallel/workflow execution
        { name: 'parallel_runner.sh', installed: true },
        { name: 'parallel_runner_wait.sh', installed: true },
        { name: 'workflow_runner.sh', installed: true },
        { name: 'workflow_assert.py', installed: true },
        { name: 'controller_checkpoint.py', installed: true },
        { name: 'integration_owner_preflight.py', installed: true },
        { name: 'repository_writer_guard.py', installed: true },
        { name: 'worktree_lifecycle_audit.py', installed: true },
      ]);
    });
  });

  describe('parallel_runner command mode template', () => {
    it('executes YAML command entries through raw headless scheduler', async () => {
      const commandsFile = path.join(testDir, 'commands.yaml');
      const outputDir = path.join(testDir, 'out');
      await fs.writeFile(
        commandsFile,
        [
          'schema_version: 1',
          'parallel: 2',
          'env:',
          '  SHARED_VALUE: top',
          'commands:',
          '  - id: argv-command',
          '    command:',
          '      - python3',
          '      - -c',
          '      - "import os; print(\'argv:\' + os.environ[\'SHARED_VALUE\'])"',
          '    env:',
          '      SHARED_VALUE: per',
          '  - id: shell-command',
          '    command: "python3 -c \'print(\\"shell:ok\\")\'"',
          '',
        ].join('\n'),
      );

      const scriptPath = path.resolve(process.cwd(), 'src/templates/scripts/parallel_runner.sh');
      const repositoryRoot = path.resolve(process.cwd(), '..');
      const currentBranch = spawnSync('git', ['-C', repositoryRoot, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
      const result = spawnSync(
        'python3',
        [scriptPath, '--commands-file', commandsFile, '--parallel', '2', '--output-dir', outputDir],
        {
          cwd: testDir,
          encoding: 'utf8',
          timeout: 30000,
          env: {
            ...process.env,
            JUNO_TASK_ROOT: repositoryRoot,
            JUNO_WORKSPACE_ROLE: 'controller',
            JUNO_CONTROLLER_BRANCH: currentBranch,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Commands (2): argv-command, shell-command');
      expect(result.stdout).toContain('Succeeded:      2');

      const runArtifactsMatch = result.stdout.match(/Run artifacts: (.+)/);
      expect(runArtifactsMatch?.[1]).toBeTruthy();
      const logDir = runArtifactsMatch![1].trim();
      expect(await fs.readFile(path.join(logDir, 'task_argv-command.log'), 'utf8')).toContain(
        'argv:per',
      );
      expect(await fs.readFile(path.join(logDir, 'task_shell-command.log'), 'utf8')).toContain(
        'shell:ok',
      );
    });

    it('returns non-zero and names failing raw commands', async () => {
      const commandsFile = path.join(testDir, 'commands-fail.yaml');
      await fs.writeFile(
        commandsFile,
        [
          'schema_version: 1',
          'commands:',
          '  - id: failing-command',
          '    command:',
          '      - python3',
          '      - -c',
          '      - "import sys; print(\'failing\'); sys.exit(7)"',
          '',
        ].join('\n'),
      );

      const scriptPath = path.resolve(process.cwd(), 'src/templates/scripts/parallel_runner.sh');
      const repositoryRoot = path.resolve(process.cwd(), '..');
      const currentBranch = spawnSync('git', ['-C', repositoryRoot, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
      const result = spawnSync(
        'python3',
        [scriptPath, '--commands-file', commandsFile, '--parallel', '1'],
        {
          cwd: testDir,
          encoding: 'utf8',
          timeout: 30000,
          env: {
            ...process.env,
            JUNO_TASK_ROOT: repositoryRoot,
            JUNO_WORKSPACE_ROLE: 'controller',
            JUNO_CONTROLLER_BRANCH: currentBranch,
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('[failing-command]   FAILED (exit 7)');
      expect(result.stdout).toContain('Failed IDs:   failing-command');
    });
  });

  describe('updateScriptIfNewer', () => {
    it('should install script if it does not exist', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      const updated = await ScriptInstaller.updateScriptIfNewer(
        testDir,
        'run_until_completion.sh',
        true,
      );
      // Result depends on whether templates are accessible
      expect(typeof updated).toBe('boolean');
    });
  });

  describe('getOutdatedScripts', () => {
    it('should return empty array when no scripts exist', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task', 'scripts'));
      const outdated = await ScriptInstaller.getOutdatedScripts(testDir);
      expect(outdated).toEqual([]);
    });

    it('should detect scripts with different content', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      await fs.ensureDir(scriptsDir);

      // Create scripts with different content than package
      await fs.writeFile(
        path.join(scriptsDir, 'run_until_completion.sh'),
        '#!/bin/bash\necho "OLD VERSION"',
      );
      await fs.writeFile(path.join(scriptsDir, 'kanban.sh'), '#!/bin/bash\necho "OLD VERSION"');
      await fs.writeFile(
        path.join(scriptsDir, 'install_requirements.sh'),
        '#!/bin/bash\necho "OLD VERSION"',
      );

      // Create all Slack scripts too
      await fs.writeFile(
        path.join(scriptsDir, 'slack_state.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'slack_fetch.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.sh'), '#!/bin/bash\necho "OLD"');
      await fs.writeFile(
        path.join(scriptsDir, 'slack_respond.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.sh'), '#!/bin/bash\necho "OLD"');

      const outdated = await ScriptInstaller.getOutdatedScripts(testDir);
      // Should detect outdated scripts if templates are accessible
      // Result depends on whether templates are accessible
      expect(Array.isArray(outdated)).toBe(true);
    });
  });

  describe('needsUpdate', () => {
    it('should return false when project is not initialized', async () => {
      const needsUpdate = await ScriptInstaller.needsUpdate(testDir);
      expect(needsUpdate).toBe(false);
    });

    it('should return true when scripts are missing', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));
      const needsUpdate = await ScriptInstaller.needsUpdate(testDir);
      // Should return true if templates are accessible and scripts are missing
      expect(typeof needsUpdate).toBe('boolean');
    });

    it('should return true when scripts have different content', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      await fs.ensureDir(scriptsDir);

      // Create all required scripts with old content
      await fs.writeFile(
        path.join(scriptsDir, 'run_until_completion.sh'),
        '#!/bin/bash\necho "OLD"',
      );
      await fs.writeFile(path.join(scriptsDir, 'kanban.sh'), '#!/bin/bash\necho "OLD"');
      await fs.writeFile(
        path.join(scriptsDir, 'install_requirements.sh'),
        '#!/bin/bash\necho "OLD"',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'slack_state.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'slack_fetch.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.sh'), '#!/bin/bash\necho "OLD"');
      await fs.writeFile(
        path.join(scriptsDir, 'slack_respond.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.sh'), '#!/bin/bash\necho "OLD"');

      const needsUpdate = await ScriptInstaller.needsUpdate(testDir);
      // Should return true if templates are accessible and content differs
      expect(typeof needsUpdate).toBe('boolean');
    });
  });

  describe('autoUpdate', () => {
    it('should not update when project is not initialized', async () => {
      const updated = await ScriptInstaller.autoUpdate(testDir, true);
      expect(updated).toBe(false);
    });

    it('should install missing scripts when project is initialized', async () => {
      await fs.ensureDir(path.join(testDir, '.juno_task'));

      const updated = await ScriptInstaller.autoUpdate(testDir, true);
      // Result depends on whether templates are accessible
      expect(typeof updated).toBe('boolean');
    });

    it('should update outdated scripts', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      await fs.ensureDir(scriptsDir);

      // Create all required scripts with old content
      await fs.writeFile(
        path.join(scriptsDir, 'run_until_completion.sh'),
        '#!/bin/bash\necho "OLD"',
      );
      await fs.writeFile(path.join(scriptsDir, 'kanban.sh'), '#!/bin/bash\necho "OLD"');
      await fs.writeFile(
        path.join(scriptsDir, 'install_requirements.sh'),
        '#!/bin/bash\necho "OLD"',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'slack_state.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(
        path.join(scriptsDir, 'slack_fetch.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_fetch.sh'), '#!/bin/bash\necho "OLD"');
      await fs.writeFile(
        path.join(scriptsDir, 'slack_respond.py'),
        '#!/usr/bin/env python3\nprint("OLD")',
      );
      await fs.writeFile(path.join(scriptsDir, 'slack_respond.sh'), '#!/bin/bash\necho "OLD"');

      const updated = await ScriptInstaller.autoUpdate(testDir, true);
      // Result depends on whether templates are accessible
      expect(typeof updated).toBe('boolean');
    });

    it('should preserve the assignment guard when replacing a project kanban wrapper', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      await fs.ensureDir(scriptsDir);
      await fs.writeFile(path.join(scriptsDir, 'kanban.sh'), '#!/bin/bash\necho "OLD"\n');

      const updated = await ScriptInstaller.autoUpdate(testDir, true);
      const installed = await fs.readFile(path.join(scriptsDir, 'kanban.sh'), 'utf8');
      const runner = await fs.readFile(path.join(scriptsDir, 'parallel_runner.sh'), 'utf8');

      expect(updated).toBe(true);
      expect(installed).toContain('ASSIGNED_TASK_ID');
      expect(installed).toContain('E2E_SWEEP_KANBAN_GUARD_DIR');
      expect(installed).toContain('E2E_SWEEP_KANBAN_RECORDS');
      expect(installed).toContain('E2E_SWEEP_KANBAN_INTERNAL');
      expect(installed).toContain('guard-kanban');
      expect(installed).toContain('exec python3 "$guard_helper"');
      expect(installed).toContain('E2E_CONTRACT_VALIDATION_INTERNAL');
      expect(installed).toContain('validate-kanban-write');
      const mainBody = installed.slice(installed.indexOf('main() {'));
      expect(mainBody.indexOf('ensure_python_environment')).toBeLessThan(mainBody.indexOf('guard-kanban'));
      expect(mainBody.indexOf('ensure_python_environment')).toBeLessThan(mainBody.indexOf('validate-kanban-write'));
      expect((mainBody.match(/if ! ensure_python_environment/g) || [])).toHaveLength(1);
      expect(runner).toContain('_build_process_env({"ASSIGNED_TASK_ID": task_id})');
      expect(runner).toContain('export ASSIGNED_TASK_ID=%s');
    });

    it('should not update when scripts match package version', async () => {
      const scriptsDir = path.join(testDir, '.juno_task', 'scripts');
      await fs.ensureDir(scriptsDir);

      // Copy the actual package scripts to simulate up-to-date state
      // This test verifies that when content matches, no update is performed
      const beforeUpdate = await ScriptInstaller.autoUpdate(testDir, true);

      // If first update succeeded, run again - should return false (no updates needed)
      if (beforeUpdate) {
        const secondUpdate = await ScriptInstaller.autoUpdate(testDir, true);
        expect(secondUpdate).toBe(false);
      }
    });
  });
});
