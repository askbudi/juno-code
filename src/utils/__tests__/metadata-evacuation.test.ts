import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const engine = path.resolve(process.cwd(), 'src/templates/scripts/metadata_evacuation.py');
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const run = (cwd: string, ...args: string[]) => spawnSync('python3', [engine, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});
const digest = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

describe('Juno 2.1 product metadata evacuation', () => {
  let temporary: string;
  let project: string;
  let inventoryPath: string;
  let policyPath: string;
  let head: string;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-metadata-evacuation-'));
    project = path.join(temporary, 'product'); await fs.ensureDir(project);
    expect(git(project, 'init', '-q', '-b', 'product').status).toBe(0);
    git(project, 'config', 'user.name', 'Test'); git(project, 'config', 'user.email', 'test@example.com');
    await fs.outputFile(path.join(project, 'src/product.ts'), 'export const product = true;\n');
    await fs.outputFile(path.join(project, '.gitignore'), '.juno_task/specs/local-cache/\n');
    await fs.outputJson(path.join(project, '.juno_task/config.json'), {
      configVersion: 2, lifecycle: { enabled: true }, controllerWorkspace: { enabled: true },
      promptMacros: { product_prompt: '.juno_task/prompts/product.md' }, customProductSetting: true,
    }, { spaces: 2 });
    await fs.outputFile(path.join(project, '.juno_task/prompts/product.md'), 'keep product prompt\n');
    await fs.outputFile(path.join(project, '.juno_task/tasks/aa/A.md'), 'task\n');
    await fs.outputFile(path.join(project, '.juno_task/ledger/aa/A/0001.ndjson'), '{}\n');
    await fs.outputFile(path.join(project, '.juno_task/specs/huge.md'), 'x'.repeat(1024 * 1024));
    await fs.outputFile(path.join(project, '.juno_task/workflows/run/receipt.json'), '{}\n');
    git(project, 'add', '.'); expect(git(project, 'commit', '-qm', 'product with controller metadata').status).toBe(0);
    head = git(project, 'rev-parse', 'HEAD').stdout.trim();
    const common = git(project, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.trim();
    const controller = path.join(temporary, 'rollback-controller'); await fs.ensureDir(controller);
    git(controller, 'init', '-q', '-b', 'controller-old'); git(controller, 'config', 'user.name', 'Test'); git(controller, 'config', 'user.email', 'test@example.com');
    await fs.outputFile(path.join(controller, '.juno_task/tasks/aa/A.md'), 'task\n');
    await fs.outputFile(path.join(controller, 'historical-product.txt'), 'full-tree rollback controller\n');
    git(controller, 'add', '.'); git(controller, 'commit', '-qm', 'controller');
    const controllerHead = git(controller, 'rev-parse', 'HEAD').stdout.trim();
    const privatePaths = ['.juno_task/ledger', '.juno_task/specs', '.juno_task/tasks', '.juno_task/workflows'];
    const decisions = privatePaths.map((privatePath, index) => ({ id: `private-${index}`, kind: 'controller_private', path: privatePath }));
    inventoryPath = path.join(temporary, 'inventory.json');
    await fs.writeJson(inventoryPath, {
      schema_version: 'juno_migration_inventory.v1',
      git: { root: project, git_common_dir: common, selected_product_ref: 'refs/heads/product', selected_product_head: head,
        worktrees: [{ path: project, head, branch: 'refs/heads/product' }] },
      controller: { selected_path: controller, branch: 'refs/heads/controller-old', head: controllerHead,
        git_common_dir: git(controller, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.trim() },
      gitlinks: [], nested_repositories: [], required_owner_answers: { dispositions: decisions },
    });
    policyPath = path.join(temporary, 'policy.json');
    await fs.writeJson(policyPath, {
      schema_version: 'juno_migration_policy_bundle.v1', inventory_sha256: await digest(inventoryPath),
      selected_paths: { controller: path.join(temporary, 'controller-2.1'), integration: path.join(temporary, 'integration') },
      dispositions: Object.fromEntries(decisions.map((row) => [row.id, 'keep'])),
      policies: {
        task_workspace: { target_ref: 'refs/heads/product', controller_private_paths: privatePaths },
        metadata_controller: { controller_branch: 'refs/heads/juno/controller-2.1', product_forbidden: privatePaths,
          copied_metadata: privatePaths },
      },
    });
  });

  afterEach(async () => fs.remove(temporary));

  it('creates a stable complete plan and applies it only to a disposable linked worktree', async () => {
    const planOne = path.join(temporary, 'plan-one.json'); const planTwo = path.join(temporary, 'plan-two.json');
    for (const output of [planOne, planTwo]) {
      const result = run(project, 'evacuation-plan', '--inventory', inventoryPath, '--policy', policyPath,
        '--project', project, '--output', output);
      expect(result.status, result.stderr).toBe(0);
    }
    expect(await fs.readFile(planOne)).toEqual(await fs.readFile(planTwo));
    const plan = await fs.readJson(planOne);
    expect(plan.changes.remove_count).toBe(4);
    expect(plan.changes.remove.map((row: any) => row.path)).toContain('.juno_task/specs/huge.md');
    expect(plan.changes.remove.map((row: any) => row.path)).not.toContain('.juno_task/prompts/product.md');
    expect(plan.changes.config_transform.removed_top_level_keys).toEqual(['controllerWorkspace', 'lifecycle']);
    expect(plan.ownership.unclassified_paths).toEqual([]);
    expect(plan.rollback.independent_identities).toBe(true);

    const sourceRefused = run(project, 'evacuation-apply', '--plan', planOne, '--candidate', project,
      '--output', path.join(temporary, 'source-apply.json'), '--allow-disposable-mutation');
    expect(sourceRefused.status).toBe(2); expect(sourceRefused.stderr).toContain('source worktree');
    expect(await fs.pathExists(path.join(project, '.juno_task/tasks/aa/A.md'))).toBe(true);

    const candidate = path.join(temporary, 'candidate');
    expect(git(project, 'worktree', 'add', '-q', '-b', 'evacuation-candidate', candidate, head).status).toBe(0);
    await fs.outputFile(path.join(candidate, '.juno_task/specs/local-cache/evidence.log'), 'preserve me\n');
    const evidenceRefused = run(project, 'evacuation-apply', '--plan', planOne, '--candidate', candidate,
      '--output', path.join(temporary, 'evidence-refused.json'), '--allow-disposable-mutation');
    expect(evidenceRefused.status).toBe(2); expect(evidenceRefused.stderr).toContain('untracked/ignored evidence');
    expect(await fs.readFile(path.join(candidate, '.juno_task/specs/local-cache/evidence.log'), 'utf8')).toBe('preserve me\n');
    await fs.remove(path.join(candidate, '.juno_task/specs/local-cache'));
    const appliedPath = path.join(temporary, 'applied.json');
    const applied = run(project, 'evacuation-apply', '--plan', planOne, '--candidate', candidate,
      '--output', appliedPath, '--allow-disposable-mutation');
    expect(applied.status, applied.stderr).toBe(0);
    expect((await fs.readJson(appliedPath)).passed).toBe(true);
    expect(await fs.pathExists(path.join(candidate, '.juno_task/tasks/aa/A.md'))).toBe(false);
    expect(await fs.pathExists(path.join(candidate, '.juno_task/prompts/product.md'))).toBe(true);
    const config = await fs.readJson(path.join(candidate, '.juno_task/config.json'));
    expect(config.lifecycle).toBeUndefined(); expect(config.controllerWorkspace).toBeUndefined();
    expect(config.customProductSetting).toBe(true); expect(config.promptMacros.product_prompt).toBeDefined();
    const verified = run(project, 'evacuation-verify', '--plan', planOne, '--candidate', candidate,
      '--output', path.join(temporary, 'verified.json'));
    expect(verified.status, verified.stderr).toBe(0);
    expect(git(project, 'rev-parse', 'refs/heads/product').stdout.trim()).toBe(head);
  });

  it('fails closed for unclassified ownership and stale refs', async () => {
    const policy = await fs.readJson(policyPath);
    delete policy.dispositions['private-2']; await fs.writeJson(policyPath, policy);
    const missing = run(project, 'evacuation-plan', '--inventory', inventoryPath, '--policy', policyPath,
      '--project', project, '--output', path.join(temporary, 'missing.json'));
    expect(missing.status).toBe(2); expect(missing.stderr).toContain('unclassified controller-private roots');

    policy.dispositions['private-2'] = 'keep'; await fs.writeJson(policyPath, policy);
    await fs.writeFile(path.join(project, 'moved.txt'), 'move\n'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'move target');
    const moved = run(project, 'evacuation-plan', '--inventory', inventoryPath, '--policy', policyPath,
      '--project', project, '--output', path.join(temporary, 'moved.json'));
    expect(moved.status).toBe(2); expect(moved.stderr).toContain('product ref moved');
  });

  it('detects unplanned candidate changes after a valid apply', async () => {
    const planPath = path.join(temporary, 'plan.json');
    expect(run(project, 'evacuation-plan', '--inventory', inventoryPath, '--policy', policyPath,
      '--project', project, '--output', planPath).status).toBe(0);
    const candidate = path.join(temporary, 'candidate-extra');
    expect(git(project, 'worktree', 'add', '-q', '-b', 'candidate-extra', candidate, head).status).toBe(0);
    expect(run(project, 'evacuation-apply', '--plan', planPath, '--candidate', candidate,
      '--output', path.join(temporary, 'apply.json'), '--allow-disposable-mutation').status).toBe(0);
    await fs.writeFile(path.join(candidate, 'src/product.ts'), 'unplanned\n');
    const result = run(project, 'evacuation-verify', '--plan', planPath, '--candidate', candidate,
      '--output', path.join(temporary, 'verify-extra.json'));
    expect(result.status).toBe(2); expect(result.stderr).toContain('differs from the exact evacuation plan');
  });

  it('protects a child repository that crosses a controller-private root', async () => {
    const child = path.join(temporary, 'child'); await fs.ensureDir(child);
    git(child, 'init', '-q', '-b', 'main'); git(child, 'config', 'user.name', 'Test'); git(child, 'config', 'user.email', 'test@example.com');
    await fs.writeFile(path.join(child, 'child.txt'), 'child\n'); git(child, 'add', '.'); git(child, 'commit', '-qm', 'child');
    expect(git(project, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, '.juno_task/specs/child').status).toBe(0);
    git(project, 'commit', '-qm', 'nested boundary');
    const movedHead = git(project, 'rev-parse', 'HEAD').stdout.trim();
    const inventory = await fs.readJson(inventoryPath);
    inventory.git.selected_product_head = movedHead; inventory.git.worktrees[0].head = movedHead;
    inventory.gitlinks = [{ path: '.juno_task/specs/child', recorded_head: git(child, 'rev-parse', 'HEAD').stdout.trim() }];
    await fs.writeJson(inventoryPath, inventory);
    const policy = await fs.readJson(policyPath); policy.inventory_sha256 = await digest(inventoryPath); await fs.writeJson(policyPath, policy);
    const result = run(project, 'evacuation-plan', '--inventory', inventoryPath, '--policy', policyPath,
      '--project', project, '--output', path.join(temporary, 'gitlink.json'));
    expect(result.status).toBe(2); expect(result.stderr).toContain('nested repository/gitlink boundaries');
  });
});
