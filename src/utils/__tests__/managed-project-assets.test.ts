import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigLoader, getPromptMacroDictionary } from '../../core/config.js';
import { CleanWorktreeSpecializer } from '../clean-worktree-specializer.js';
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
    expect(dictionary.clean_worktree).toContain('# Run an exact-base product-change workflow');
    expect(dictionary.clean_worktree).toContain('REVIEW_READY');
    expect(dictionary.clean_worktree).toContain('Reviewer A and then Reviewer B');
    expect(dictionary.clean_worktree).toContain('Do not repair between Reviewer A and Reviewer B');
    expect(dictionary.reflect).toContain('# End-of-session reflection');
    expect(dictionary.reflect).toContain('REFLECTION_TABLE');
    expect(dictionary.reflect).toContain('complete reflection table');
    expect(dictionary.new_task_workflow).toContain('# Create task workflow');
    expect(dictionary.new_task_workflow).toContain('{{ receipts.<id>.path }}');
    expect(dictionary.new_task_workflow).toContain('Do not add standalone `implementation_guard`, `pre_merge_guard`, or `candidate_guard` steps');
    expect(dictionary.new_task_workflow).toContain('same frozen base and tip');
    expect(dictionary.run_workflow).toContain('# Run task workflow');
    expect(dictionary.run_workflow).toContain('--amends-run PRIOR_RUN --from-step STEP');
    expect(dictionary.run_workflow).toContain('Wait for both review results before repair');
    expect(dictionary.migrate_juno_code_v1_to_v2).toContain('# Migrate a Juno Code v1 project');
    expect(dictionary.migrate_juno_kanban_v1_to_v2).toContain('# Migrate juno-kanban v1 storage');
    expect(dictionary.migrate_juno_kanban_v1_to_v2).toContain('resolve its latest reviewed commit');
    expect(dictionary.migrate_juno_kanban_v1_to_v2).toContain('a merely compatible but older installed v2 is stale');
    const reviewPrompt = await fs.readFile(
      path.join(projectDir, '.juno_task/prompts/review_commit_parallel_runner.md'),
      'utf8',
    );
    expect(reviewPrompt).toContain('Never use bare `pi`');
    expect(reviewPrompt).toContain('Review only');
    expect(reviewPrompt).toContain('do not edit, commit, update Kanban, launch another reviewer');
    expect(reviewPrompt).toContain('JUNO_REVIEW_VERDICT: PASS');
    expect(reviewPrompt).not.toContain('then resolve it');
    expect(
      await fs.readFile(path.join(projectDir, '.juno_task/wiki/parallel_runner_and_spec_review.md'), 'utf8'),
    ).toContain('Reviewer launcher identity');
    expect(
      await fs.readFile(path.join(projectDir, '.juno_task/wiki/git_worktree_lifecycle.md'), 'utf8'),
    ).toContain('Sequential same-tip review policy');

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
      expect(implementationReference).toContain('Review-ready boundary');
      expect(implementationReference).toContain('Implementation workers never launch semantic reviewers');
    }

    const unchanged = await ManagedProjectAssets.update(projectDir, { silent: true });
    expect(unchanged.unchanged).toHaveLength(MANAGED_PROJECT_ASSETS.length);
  });

  it(
    'installs an operationally closed managed wiki generation',
    async () => {
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
        '.juno_task/scripts/tests/test_integration_concurrency.py',
        '.juno_task/wiki/runtime_migration_and_replacement_contract.md',
      ]) {
        expect(await fs.pathExists(path.join(projectDir, requiredPath)), requiredPath).toBe(true);
      }

      for (const command of [
        './.juno_task/scripts/wiki_lint.sh --file .juno_task/wiki/parallel_runner_and_spec_review.md',
        './.juno_task/scripts/wiki_lint.sh --file .juno_task/wiki/runtime_migration_and_replacement_contract.md',
        // Keep the fast suite bounded: this proves the installed lifecycle modules load;
        // the exact installed concurrency gate is exercised by the package acceptance loop.
        'python3 -m py_compile .juno_task/scripts/worktree_lifecycle.py .juno_task/scripts/integration_candidate.py .juno_task/scripts/integration_owner_preflight.py',
      ]) {
        const result = spawnSync('/bin/bash', ['-c', command], {
          cwd: projectDir,
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(result.status, `${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      }
    },
    60_000,
  );

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
    expect(await fs.readFile(destinationPath, 'utf8')).toContain('# Run task workflow');
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
      '# Run an exact-base product-change workflow',
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
    expect(await fs.readFile(destinationPath, 'utf8')).toContain(
      '# Run an exact-base product-change workflow',
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

describe('CleanWorktreeSpecializer', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-clean-policy-'));
    await fs.ensureDir(path.join(projectDir, '.juno_task'));
    await fs.writeJson(path.join(projectDir, '.juno_task', 'config.json'), {});
  });

  afterEach(async () => fs.remove(projectDir));

  const policy = {
    schemaVersion: 2 as const,
    controller: { checkoutPath: '/workspace/controller', branch: 'refs/heads/juno/controller-v2' },
    taskWorktree: {
      pathConvention: '/tmp/juno/tasks/{run-id}',
      branchConvention: 'juno/{task-id}-{run-id}',
    },
    repositories: [
      {
        name: 'root',
        kind: 'root' as const,
        repositoryPath: '/workspace/product',
        targetRef: 'refs/heads/release/customer-a',
        remoteTarget: 'refs/remotes/upstream/release/customer-a',
        exactBasePolicy: 'approved_target_sha_or_narrow_fetch_head' as const,
        integrationChannel: 'git_common_dir_and_target_ref' as const,
        targetMovement: 'rebuild_and_rereview' as const,
        preMergeValidation: ['npm test'],
        actualTargetValidation: ['npm test', 'npm run build'],
      },
      {
        name: 'nested-api',
        kind: 'nested' as const,
        repositoryPath: '/workspace/product/api',
        targetRef: 'refs/heads/integration/api-v7',
        remoteTarget: 'refs/remotes/vendor/integration/api-v7',
        exactBasePolicy: 'approved_target_sha_or_narrow_fetch_head' as const,
        integrationChannel: 'git_common_dir_and_target_ref' as const,
        targetMovement: 'rebuild_and_rereview' as const,
        preMergeValidation: ['python -m pytest -q'],
        actualTargetValidation: ['python -m pytest -q'],
      },
    ],
    cleanup: {
      reachabilityPolicy: 'remove only after every reviewed tip is reachable from its exact target',
      fallback: 'preserve_with_owner_and_reason' as const,
    },
  };

  it('renders exact nonstandard root and nested targets while preserving authority boundaries', async () => {
    const result = await CleanWorktreeSpecializer.specialize(projectDir, policy);
    const prompt = await fs.readFile(path.join(projectDir, result.promptPath), 'utf8');
    expect(prompt).toContain('refs/heads/release/customer-a');
    expect(prompt).toContain('refs/heads/integration/api-v7');
    expect(prompt).toContain('refs/remotes/upstream/release/customer-a');
    expect(prompt).not.toContain('refs/heads/<local-target>');
    expect(prompt).not.toContain('origin/<target>');
    expect(prompt).toContain('git_common_dir_and_target_ref');
    expect(prompt).toContain('preserve_with_owner_and_reason');
    expect(prompt).toContain('grants no authority to push, publish, deploy');
    expect(prompt).not.toContain('002-e-mail-services');
  });

  it('rejects an absent nested target and retired repository-wide integration policy', async () => {
    const invalid: any = structuredClone(policy);
    invalid.repositories[1].targetRef = '';
    await expect(CleanWorktreeSpecializer.specialize(projectDir, invalid)).rejects.toThrow();

    const mismatch: any = structuredClone(policy);
    mismatch.repositories[1].integrationChannel = 'repository_wide_lease';
    await expect(CleanWorktreeSpecializer.specialize(projectDir, mismatch)).rejects.toThrow();
  });

  it('leaves specialization customized so routine update preserves exact targets', async () => {
    await CleanWorktreeSpecializer.specialize(projectDir, policy);
    const update = await ManagedProjectAssets.update(projectDir, { silent: true });
    expect(update.conflicts.some((entry) => entry.destination.endsWith('clean_worktree.md'))).toBe(
      true,
    );
    expect(
      await fs.readFile(path.join(projectDir, '.juno_task/prompts/clean_worktree.md'), 'utf8'),
    ).toContain('refs/heads/release/customer-a');
  });

  it('fails closed instead of replacing a missing specialized policy with the portable default', async () => {
    await CleanWorktreeSpecializer.specialize(projectDir, policy);
    const promptPath = path.join(projectDir, '.juno_task/prompts/clean_worktree.md');
    await fs.remove(promptPath);

    const update = await ManagedProjectAssets.update(projectDir, { silent: true });
    const conflict = update.conflicts.find((entry) =>
      entry.destination.endsWith('clean_worktree.md'),
    );
    expect(conflict).toBeDefined();
    expect(await fs.pathExists(promptPath)).toBe(false);
    expect(await fs.readFile(path.join(projectDir, conflict!.candidate), 'utf8')).toContain(
      '# Run an exact-base product-change workflow',
    );
  });
});
