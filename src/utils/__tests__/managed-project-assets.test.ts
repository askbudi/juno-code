import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigLoader, getPromptMacroDictionary } from '../../core/config.js';
import { ScriptInstaller } from '../script-installer.js';
import {
  MANAGED_PROJECT_ASSETS,
  MANAGED_PROMPT_MACROS,
  ManagedProjectAssets,
} from '../managed-project-assets.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('ManagedProjectAssets', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-managed-assets-'));
    await fs.ensureDir(path.join(projectDir, '.juno_task'));
    await fs.writeJson(path.join(projectDir, '.juno_task', 'config.json'), {
      promptMacros: {
        global: { existing: 'keep me' },
        local: { clean_worktree: 'local override' },
      },
    });
  });

  afterEach(async () => {
    await fs.remove(projectDir);
  });

  it('installs every managed asset and registers resolvable file-backed macros', async () => {
    const result = await ManagedProjectAssets.update(projectDir, { silent: true });
    expect(result.installed).toHaveLength(MANAGED_PROJECT_ASSETS.length);

    const configJson = await fs.readJson(path.join(projectDir, '.juno_task', 'config.json'));
    expect(configJson.promptMacros.global.existing).toBe('keep me');
    expect(configJson.promptMacros.local.clean_worktree).toBe('local override');
    for (const [name, mapping] of Object.entries(MANAGED_PROMPT_MACROS)) {
      expect(configJson.promptMacros.global[name]).toEqual(mapping);
      expect(await fs.pathExists(path.join(projectDir, mapping.path))).toBe(true);
    }

    const overrideLoader = new ConfigLoader(projectDir);
    await overrideLoader.fromProjectConfig();
    expect(getPromptMacroDictionary(overrideLoader.merge()).clean_worktree).toBe('local override');

    configJson.promptMacros.local = {};
    await fs.writeJson(path.join(projectDir, '.juno_task', 'config.json'), configJson);
    const freshLoader = new ConfigLoader(projectDir);
    await freshLoader.fromProjectConfig();
    const dictionary = getPromptMacroDictionary(freshLoader.merge());
    expect(dictionary.clean_worktree).toContain('# Clean Bolt task workspaces');
    expect(dictionary.clean_worktree).toContain('yy task start TASK_ID');
    expect(dictionary.clean_worktree).toContain('Low risk needs no semantic review');
    expect(dictionary.clean_worktree).toContain('expected-SHA CAS');
    expect(dictionary.reflect).toContain('# End-of-session reflection');
    expect(dictionary.reflect).toContain('REFLECTION_TABLE');
    expect(dictionary.reflect).toContain('complete reflection table');
    expect(dictionary.new_task_workflow).toContain('# Start a feature task');
    expect(dictionary.new_task_workflow).toContain('task-workspace policy');
    expect(dictionary.new_task_workflow).toContain('one task branch and one product worktree');
    expect(dictionary.new_task_workflow).toContain('exact frozen base');
    expect(dictionary.new_task_workflow).toContain('yy task start TASK_ID');
    expect(dictionary.new_task_workflow).toContain('yy task finish TASK_ID');
    expect(dictionary.run_workflow).toContain('# Run a workflow or Bolt task');
    expect(dictionary.run_workflow).toContain('read-only doctor support');
    expect(dictionary.run_workflow).toContain('low zero, normal at most one');
    expect(dictionary.migrate_juno_code_v1_to_v2).toContain('# Migrate a Juno Code v1 project');
    expect(dictionary.migrate_juno_kanban_v1_to_v2).toContain('# Migrate juno-kanban v1 storage');
    expect(dictionary.migrate_juno_kanban_v1_to_v2).toContain('resolve its latest reviewed commit');
    expect(dictionary.migrate_juno_kanban_v1_to_v2).toContain(
      'a merely compatible but older installed v2 is stale',
    );
    for (const prompt of [dictionary.migrate_juno_code_v1_to_v2, dictionary.migrate_juno_kanban_v1_to_v2]) {
      expect(prompt).toContain('548d1e6763bb6c5b3f2b27a63398faf225ebbb1c');
      expect(prompt).toContain('2.0.5');
      expect(prompt).toContain('ruamel.yaml');
      expect(prompt).toContain('--no-deps');
      expect(prompt).toContain('before any canonical board access');
    }
    expect(dictionary.migrate_juno_code_v1_to_v2).toContain('absolute integration-owner worktree');
    expect(dictionary.migrate_juno_code_v1_to_v2).toContain('screenshots');
    expect(dictionary.migrate_juno_code_v1_to_v2).toContain('separate yes/no authorities');
    const reviewPrompt = await fs.readFile(
      path.join(projectDir, '.juno_task/prompts/review_commit_parallel_runner.md'),
      'utf8',
    );
    const metadataPolicy = await fs.readJson(
      path.join(projectDir, '.juno_task/config/metadata-controller.json'),
    );
    const riskPolicy = await fs.readJson(
      path.join(projectDir, '.juno_task/config/risk-policy.json'),
    );
    expect(metadataPolicy.schema_version).toBe('juno_metadata_controller_policy.v1');
    expect(metadataPolicy.product_forbidden).toContain('.juno_task/tasks');
    expect(metadataPolicy.runtime.ignored_roots).toContain('.juno_task/scripts');
    expect(metadataPolicy.tracked_exact).not.toContain('.juno_task/state/queue.json');
    expect(metadataPolicy.tracked_exact).toContain('.juno_task/state/tasks.json');
    expect(metadataPolicy.tracked_exact).toContain('.juno_task/config/task-workspace.json');
    expect(metadataPolicy.tracked_exact).toContain('.juno_task/config/risk-policy.json');
    expect(metadataPolicy.generated_metadata).toContain('.juno_task/config/task-workspace.json');
    expect(metadataPolicy.generated_metadata).toContain('.juno_task/config/risk-policy.json');
    expect(metadataPolicy.tracked_top_level_files).toContain('.juno_task/receipts');
    expect(riskPolicy.schema_version).toBe('juno_bolt_risk_policy.v1');
    expect(riskPolicy.review_policy).toEqual({
      low: { sequence: [], min: 0, max: 0 },
      normal: { sequence: ['reviewer'], min: 0, max: 1 },
      high: { sequence: ['reviewer_a', 'reviewer_b'], min: 2, max: 2 },
      release: { sequence: [], min: 0, max: 0 },
    });
    expect(
      await fs.readFile(
        path.join(projectDir, '.juno_task/wiki/metadata_controller_boundary.md'),
        'utf8',
      ),
    ).toContain('Controller commits never merge or synchronize into a product target');
    expect(reviewPrompt).toContain('Never use bare `pi`');
    expect(reviewPrompt).toContain('Review only');
    expect(reviewPrompt).toContain('do not edit, commit, update Kanban, launch another reviewer');
    expect(reviewPrompt).toContain('JUNO_REVIEW_VERDICT: PASS');
    expect(reviewPrompt).not.toContain('then resolve it');
    expect(
      await fs.readFile(
        path.join(projectDir, '.juno_task/wiki/parallel_runner_and_spec_review.md'),
        'utf8',
      ),
    ).toContain('Reviewer launcher identity');
    expect(
      await fs.readFile(path.join(projectDir, '.juno_task/wiki/git_worktree_lifecycle.md'), 'utf8'),
    ).toContain('yy task finish TASK_ID');

    const canonicalImplementationReference = await fs.readFile(
      path.join(process.cwd(), 'src/templates/skills/canonical/ralph-loop/references/implement.md'),
      'utf8',
    );
    expect(canonicalImplementationReference).toContain('GENERATED DESTINATIONS');
    for (const agent of ['claude', 'codex', 'pi']) {
      const implementationReference = await fs.readFile(
        path.join(
          process.cwd(),
          'src/templates/skills',
          agent,
          'ralph-loop/references/implement.md',
        ),
        'utf8',
      );
      expect(implementationReference).toBe(canonicalImplementationReference);
      expect(implementationReference).toContain('# Bolt implementation worker contract');
      expect(implementationReference).toContain('yy task start TASK_ID');
      expect(implementationReference).toContain('yy task finish TASK_ID');
      expect(implementationReference).toContain('low zero');
      expect(implementationReference).toContain('expected-SHA CAS');
      expect(implementationReference).toContain('controller checkpoint');
    }

    const distributedSkills = [
      ['claude', '.claude/skills/ralph-loop/references/implement.md'],
      ['codex', '.agents/skills/ralph-loop/references/implement.md'],
      ['pi', '.pi/skills/ralph-loop/references/implement.md'],
    ] as const;
    for (const [agent, relativePath] of distributedSkills) {
      const canonical = await fs.readFile(
        path.join(
          process.cwd(),
          'src/templates/skills',
          agent,
          'ralph-loop/references/implement.md',
        ),
        'utf8',
      );
      expect(await fs.readFile(path.resolve(process.cwd(), '..', relativePath), 'utf8')).toBe(
        canonical,
      );
      expect(await fs.readFile(path.resolve(process.cwd(), relativePath), 'utf8')).toBe(canonical);
    }

    const unchanged = await ManagedProjectAssets.update(projectDir, { silent: true });
    expect(unchanged.unchanged).toHaveLength(MANAGED_PROJECT_ASSETS.length);
  });

  it('installs an operationally closed managed wiki generation', async () => {
    const templatesDir = ManagedProjectAssets.getTemplatesDirectory();
    expect(templatesDir).not.toBeNull();
    const definitions = (await fs.readJson(path.join(templatesDir!, 'managed-assets.json')))
      .assets as Array<{
      source: string;
      destination: string;
      installClass: 'project' | 'script';
      type: string;
    }>;

    await ManagedProjectAssets.update(projectDir, { silent: true });
    await ScriptInstaller.autoUpdate(projectDir, true);

    const taskWorkflowHelper = await fs.readFile(
      path.join(projectDir, '.juno_task/scripts/task_workflow_helper.py'),
      'utf8',
    );
    expect(taskWorkflowHelper).toContain(
      'role review must not declare edit_capable true or edit_admission',
    );
    expect(taskWorkflowHelper).not.toContain('review_fix');

    const managedWikis = definitions.filter((asset) => asset.type === 'wiki');
    const relativeLink = /\[[^\]]+\]\((?![a-z]+:|#)([^)#]+)(?:#[^)]*)?\)/gi;
    for (const wiki of managedWikis) {
      const wikiPath = path.join(projectDir, wiki.destination);
      const content = await fs.readFile(wikiPath, 'utf8');
      for (const match of content.matchAll(relativeLink)) {
        expect(
          await fs.pathExists(path.resolve(path.dirname(wikiPath), match[1])),
          `${wiki.destination} has an unresolved installed link: ${match[1]}`,
        ).toBe(true);
      }
    }

    for (const requiredPath of [
      '.juno_task/scripts/wiki_lint.sh',
      '.juno_task/scripts/wiki_lint.py',
      '.juno_task/scripts/managed_agent_runner.py',
      '.juno_task/scripts/tests/test_managed_agent_runner.py',
      '.juno_task/scripts/metadata_controller.py',
      '.juno_task/scripts/tests/test_metadata_controller.py',
      '.juno_task/scripts/risk_policy.py',
      '.juno_task/scripts/tests/test_risk_policy.py',
      '.juno_task/scripts/release_gate.py',
      '.juno_task/scripts/tests/test_release_gate.py',
      '.juno_task/config/metadata-controller.json',
      '.juno_task/config/risk-policy.json',
      '.juno_task/wiki/metadata_controller_boundary.md',
      '.juno_task/wiki/runtime_migration_and_replacement_contract.md',
    ]) {
      expect(await fs.pathExists(path.join(projectDir, requiredPath)), requiredPath).toBe(true);
    }

    for (const command of [
      './.juno_task/scripts/wiki_lint.sh --file .juno_task/wiki/parallel_runner_and_spec_review.md',
      './.juno_task/scripts/wiki_lint.sh --file .juno_task/wiki/runtime_migration_and_replacement_contract.md',
      // Keep the fast suite bounded: this proves the installed lifecycle modules load;
      // the exact installed concurrency gate is exercised by the package acceptance loop.
      'python3 -m py_compile .juno_task/scripts/task_workspace.py .juno_task/scripts/merge_queue.py .juno_task/scripts/risk_policy.py',
      'python3 .juno_task/scripts/tests/test_metadata_controller.py',
      'python3 .juno_task/scripts/tests/test_risk_policy.py',
      'python3 .juno_task/scripts/tests/test_release_gate.py',
    ]) {
      const result = spawnSync('/bin/bash', ['-c', command], {
        cwd: projectDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPYCACHEPREFIX: '/tmp/juno-managed-assets-pycache',
        },
        timeout: 30_000,
      });
      expect(
        result.status,
        `${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
    }
  }, 60_000);

  it('detects a mixed lifecycle generation without changing project files', async () => {
    await ManagedProjectAssets.update(projectDir, { silent: true });
    await ScriptInstaller.autoUpdate(projectDir, true);
    expect((await ManagedProjectAssets.inspectGeneration(projectDir)).status).toBe('coherent');

    const wikiPath = path.join(projectDir, '.juno_task/wiki/git_worktree_lifecycle.md');
    await fs.writeFile(wikiPath, '# stale lifecycle guidance\n');
    const report = await ManagedProjectAssets.inspectGeneration(projectDir);

    expect(report.status).toBe('mixed');
    expect(report.coherent).toBe(false);
    expect(
      report.entries.find(
        (entry) => entry.destination === '.juno_task/wiki/git_worktree_lifecycle.md',
      )?.state,
    ).toBe('customized');
    expect(await fs.readFile(wikiPath, 'utf8')).toBe('# stale lifecycle guidance\n');
  });

  it('updates a stale unmodified managed file and reinstalls a missing file', async () => {
    await ManagedProjectAssets.update(projectDir, { silent: true });
    const destination = '.juno_task/prompts/run_workflow.md';
    const destinationPath = path.join(projectDir, destination);
    const oldManagedContent = 'old managed bytes\n';
    await fs.writeFile(destinationPath, oldManagedContent);
    const manifestPath = path.join(projectDir, '.juno_task', 'managed-assets.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.assets[destination].installedSha256 = sha256(oldManagedContent);
    await fs.writeJson(manifestPath, manifest);
    await fs.remove(path.join(projectDir, '.juno_task/prompts/new_task_workflow.md'));

    const result = await ManagedProjectAssets.update(projectDir, { silent: true });
    expect(result.updated).toContain(destination);
    expect(result.installed).toContain('.juno_task/prompts/new_task_workflow.md');
    expect(await fs.readFile(destinationPath, 'utf8')).toContain(
      '# Run a workflow or Bolt task',
    );
  });

  it('preserves customized prompts and writes a package-version candidate', async () => {
    await ManagedProjectAssets.update(projectDir, { silent: true });
    const destination = '.juno_task/prompts/clean_worktree.md';
    const destinationPath = path.join(projectDir, destination);
    await fs.writeFile(destinationPath, 'exact integration target: refs/heads/customer-release\n');

    const result = await ManagedProjectAssets.update(projectDir, { silent: true });
    const conflict = result.conflicts.find((entry) => entry.destination === destination);
    expect(conflict).toBeDefined();
    expect(await fs.readFile(destinationPath, 'utf8')).toContain('refs/heads/customer-release');
    expect(await fs.readFile(path.join(projectDir, conflict!.candidate), 'utf8')).toContain(
      '# Clean Bolt task workspaces',
    );
  });

  it('backs up a customized prompt before explicit force replacement', async () => {
    await ManagedProjectAssets.update(projectDir, { silent: true });
    const destination = '.juno_task/prompts/clean_worktree.md';
    const destinationPath = path.join(projectDir, destination);
    const customized = 'refs/heads/owner-specific\n';
    await fs.writeFile(destinationPath, customized);

    const result = await ManagedProjectAssets.update(projectDir, { force: true, silent: true });
    const backup = result.backups.find((entry) => entry.destination === destination);
    expect(backup).toBeDefined();
    expect(await fs.readFile(path.join(projectDir, backup!.backup), 'utf8')).toBe(customized);
    expect(await fs.readFile(destinationPath, 'utf8')).toContain('# Clean Bolt task workspaces');
  });

  it('archives retired managed and customized assets during the Bolt upgrade', async () => {
    const retiredManaged = '.juno_task/scripts/task_lifecycle.py';
    const retiredCustomized = '.juno_task/config/lifecycle.json';
    const managedBytes = '# old managed executor\n';
    const customizedBytes = '{"owner":"custom"}\n';
    await fs.ensureDir(path.join(projectDir, '.juno_task/scripts'));
    await fs.ensureDir(path.join(projectDir, '.juno_task/config'));
    await fs.writeFile(path.join(projectDir, retiredManaged), managedBytes);
    await fs.writeFile(path.join(projectDir, retiredCustomized), customizedBytes);
    await fs.writeJson(path.join(projectDir, '.juno_task/managed-assets.json'), {
      schemaVersion: 1,
      packageName: 'juno-code',
      packageVersion: '2.0.31',
      assets: {
        [retiredManaged]: {
          type: 'script',
          templateVersion: '2.0.31',
          sourceSha256: sha256(managedBytes),
          installedSha256: sha256(managedBytes),
        },
      },
    });

    await expect(ManagedProjectAssets.update(projectDir, { silent: true })).rejects.toThrow(
      'customized retired asset',
    );
    expect(await fs.pathExists(path.join(projectDir, retiredCustomized))).toBe(true);

    const forced = await ManagedProjectAssets.update(projectDir, { force: true, silent: true });
    expect(await fs.pathExists(path.join(projectDir, retiredManaged))).toBe(false);
    expect(await fs.pathExists(path.join(projectDir, retiredCustomized))).toBe(false);
    for (const retired of [retiredManaged, retiredCustomized]) {
      const backup = forced.backups.find((entry) => entry.destination === retired);
      expect(backup).toBeDefined();
      expect(await fs.pathExists(path.join(projectDir, backup!.backup))).toBe(true);
    }
  });

  it('reuses identical retired archives and never overwrites collisions on reappearance', async () => {
    const destination = '.juno_task/scripts/task_lifecycle.py';
    const destinationPath = path.join(projectDir, destination);
    const firstBytes = '# retired generation A\n';
    const secondBytes = '# retired generation B\n';
    await fs.ensureDir(path.dirname(destinationPath));
    await fs.writeFile(destinationPath, firstBytes);
    await fs.writeJson(path.join(projectDir, '.juno_task/managed-assets.json'), {
      schemaVersion: 1,
      packageName: 'juno-code',
      packageVersion: '2.0.31',
      assets: {
        [destination]: {
          type: 'script',
          templateVersion: '2.0.31',
          sourceSha256: sha256(firstBytes),
          installedSha256: sha256(firstBytes),
        },
      },
    });

    const initial = await ManagedProjectAssets.update(projectDir, { silent: true });
    const initialBackup = initial.backups.find((entry) => entry.destination === destination)!;
    expect(await fs.readFile(path.join(projectDir, initialBackup.backup), 'utf8')).toBe(firstBytes);

    await fs.writeFile(destinationPath, firstBytes);
    const identicalRetry = await ManagedProjectAssets.update(projectDir, {
      force: true,
      silent: true,
    });
    expect(identicalRetry.backups.find((entry) => entry.destination === destination)?.backup).toBe(
      initialBackup.backup,
    );
    expect(await fs.readFile(path.join(projectDir, initialBackup.backup), 'utf8')).toBe(firstBytes);

    const manifest = await fs.readJson(path.join(projectDir, '.juno_task/managed-assets.json'));
    const collisionRelative = path.join(
      '.juno_task',
      'managed-conflicts',
      `bolt-${manifest.packageVersion}`,
      `${destination}.${sha256(secondBytes).slice(0, 16)}.backup`,
    );
    await fs.ensureDir(path.dirname(path.join(projectDir, collisionRelative)));
    await fs.writeFile(path.join(projectDir, collisionRelative), 'preserve collision bytes\n');
    await fs.writeFile(destinationPath, secondBytes);

    const differingRetry = await ManagedProjectAssets.update(projectDir, {
      force: true,
      silent: true,
    });
    const differingBackup = differingRetry.backups.find(
      (entry) => entry.destination === destination,
    )!;
    expect(differingBackup.backup).not.toBe(initialBackup.backup);
    expect(differingBackup.backup).not.toBe(collisionRelative);
    expect(await fs.readFile(path.join(projectDir, initialBackup.backup), 'utf8')).toBe(firstBytes);
    expect(await fs.readFile(path.join(projectDir, collisionRelative), 'utf8')).toBe(
      'preserve collision bytes\n',
    );
    expect(await fs.readFile(path.join(projectDir, differingBackup.backup), 'utf8')).toBe(
      secondBytes,
    );
    expect(await fs.pathExists(destinationPath)).toBe(false);
  });

  it('archives a generated specialization receipt and installs the Bolt prompt', async () => {
    const prompt = 'generated exact-target specialization\n';
    const promptPath = path.join(projectDir, '.juno_task/prompts/clean_worktree.md');
    const receiptPath = path.join(
      projectDir,
      '.juno_task/managed-specializations/clean-worktree.json',
    );
    await fs.ensureDir(path.dirname(promptPath));
    await fs.ensureDir(path.dirname(receiptPath));
    await fs.writeFile(promptPath, prompt);
    await fs.writeJson(receiptPath, {
      schemaVersion: 2,
      promptPath: '.juno_task/prompts/clean_worktree.md',
      promptSha256: sha256(prompt),
    });

    const result = await ManagedProjectAssets.update(projectDir, { silent: true });
    expect(await fs.pathExists(receiptPath)).toBe(false);
    expect(await fs.readFile(promptPath, 'utf8')).toContain('# Clean Bolt task workspaces');
    expect(result.backups.map((entry) => entry.destination)).toEqual(
      expect.arrayContaining([
        '.juno_task/prompts/clean_worktree.md',
        '.juno_task/managed-specializations/clean-worktree.json',
      ]),
    );
  });

  it('preserves a conflicting macro unless force is explicit', async () => {
    const configPath = path.join(projectDir, '.juno_task', 'config.json');
    const config = await fs.readJson(configPath);
    config.promptMacros.global.run_workflow = { path: 'private/run.md' };
    await fs.writeJson(configPath, config);

    const ordinary = await ManagedProjectAssets.update(projectDir, { silent: true });
    expect(ordinary.macroConflicts).toContain('run_workflow');
    expect((await fs.readJson(configPath)).promptMacros.global.run_workflow.path).toBe(
      'private/run.md',
    );

    const forced = await ManagedProjectAssets.update(projectDir, { force: true, silent: true });
    expect((await fs.readJson(configPath)).promptMacros.global.run_workflow).toEqual(
      MANAGED_PROMPT_MACROS.run_workflow,
    );
    expect(forced.backups.some((entry) => entry.destination === '.juno_task/config.json')).toBe(
      true,
    );
  });
});
