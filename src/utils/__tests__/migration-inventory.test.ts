import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const engine = path.resolve(process.cwd(), 'src/templates/scripts/migration_inventory.py');
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const run = (cwd: string, ...args: string[]) => spawnSync('python3', [engine, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});

describe('Juno 2.1 migration inventory', { timeout: 30_000 }, () => {
  let temporary: string;
  let project: string;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-migration-inventory-'));
    project = path.join(temporary, 'project');
    await fs.ensureDir(project);
    expect(git(project, 'init', '-q', '-b', 'product').status).toBe(0);
    git(project, 'config', 'user.name', 'Test'); git(project, 'config', 'user.email', 'test@example.com');
    await fs.outputFile(path.join(project, '.gitignore'), 'cache/\n.env*\nvendor/\n**/__pycache__/\n');
    await fs.outputFile(path.join(project, '.juno_task/tasks/aa/AA1.md'), 'task\n');
    await fs.outputFile(path.join(project, '.juno_task/ledger/aa/AA1/000001.ndjson'), '{}\n');
    await fs.outputFile(path.join(project, '.juno_task/scripts/kanban.sh'), '#!/bin/sh\n');
    const prompt = '.juno_task/prompts/custom.md';
    await fs.outputFile(path.join(project, prompt), 'managed\n');
    const installedSha = spawnSync('shasum', ['-a', '256', path.join(project, prompt)], { encoding: 'utf8' }).stdout.split(' ')[0];
    await fs.outputJson(path.join(project, '.juno_task/managed-assets.json'), {
      schemaVersion: 1, packageName: 'juno-code', packageVersion: '2.0.31',
      assets: { [prompt]: { type: 'prompt', templateVersion: '2.0.31', sourceSha256: installedSha, installedSha256: installedSha } },
    });
    await fs.outputJson(path.join(project, '.juno_task/config.json'), {
      configVersion: 2, lifecycle: { enabled: true }, controllerWorkspace: { enabled: true },
      hooks: { BeforeTask: [{ command: 'JUNO_CONFIG_SECRET_COMMAND' }] },
      gitCheckpoint: { include: ['owner/private/path'] }, envFilePath: '/owner/private/.env',
      promptMacros: { safe_macro: '.juno_task/prompts/custom.md' },
    });
    const child = path.join(temporary, 'child'); await fs.ensureDir(child);
    git(child, 'init', '-q', '-b', 'main'); git(child, 'config', 'user.name', 'Test'); git(child, 'config', 'user.email', 'test@example.com');
    await fs.writeFile(path.join(child, 'child.txt'), 'child\n'); git(child, 'add', '.'); git(child, 'commit', '-qm', 'child');
    expect(git(project, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'deps/child').status).toBe(0);
    git(project, 'add', '.'); git(project, 'commit', '-qm', 'base');
    git(project, 'checkout', '-q', '--detach', 'HEAD');
    await fs.writeFile(path.join(project, prompt), 'owner customization\n');
    await fs.outputFile(path.join(project, 'cache/heavy.bin'), 'x'.repeat(64));
    await fs.writeFile(path.join(project, 'ordinary-heavy.bin'), 'y'.repeat(64));
    await fs.writeFile(path.join(project, '.env.secret'), 'SUPER_SECRET_VALUE\n');
    await fs.outputFile(path.join(project, '.juno_task/scripts/__pycache__/generated.pyc'), 'generated\n');
    await fs.writeFile(path.join(project, '.git/hooks/custom-hook'), '#!/bin/sh\nexit 0\n');
    await fs.outputJson(path.join(project, '.claude/settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'DO_NOT_PRINT_ME' }] }] } });
    const nested = path.join(project, 'vendor/nested'); await fs.ensureDir(nested);
    git(nested, 'init', '-q', '-b', 'nested');
  });

  afterEach(async () => fs.remove(temporary));

  it('is byte-stable, complete, redacted, and does not mutate the source', async () => {
    const before = git(project, 'status', '--porcelain=v1', '--untracked-files=all').stdout;
    const first = path.join(temporary, 'inventory-1.json'); const second = path.join(temporary, 'inventory-2.json');
    const one = run(project, 'inventory', '--project', project, '--heavy-threshold-bytes', '32', '--output', first);
    const two = run(project, 'inventory', '--project', project, '--heavy-threshold-bytes', '32', '--output', second);
    expect(one.status, one.stderr).toBe(0); expect(two.status, two.stderr).toBe(0);
    expect(await fs.readFile(first)).toEqual(await fs.readFile(second));
    expect(git(project, 'status', '--porcelain=v1', '--untracked-files=all').stdout).toBe(before);
    const text = await fs.readFile(first, 'utf8'); const receipt = JSON.parse(text);
    expect(text).not.toContain('SUPER_SECRET_VALUE'); expect(text).not.toContain('.env.secret');
    expect(text).not.toContain('DO_NOT_PRINT_ME');
    expect(receipt.git.detached).toBe(true); expect(receipt.git.product_ref_ambiguous).toBe(true);
    expect(receipt.controller.registration_missing).toBe(true); expect(receipt.status.clean).toBe(false);
    expect(receipt.gitlinks).toHaveLength(1); expect(receipt.nested_repositories.map((row: any) => row.path)).toContain('vendor/nested');
    expect(receipt.controller_private_roots).toEqual(expect.arrayContaining([expect.objectContaining({ path: '.juno_task/tasks', tracked_blob_bytes: expect.any(Number) }), expect.objectContaining({ path: '.juno_task/ledger', tracked_blob_bytes: expect.any(Number) })]));
    expect(receipt.managed_assets).toContainEqual(expect.objectContaining({ path: '.juno_task/prompts/custom.md', state: 'customized' }));
    expect(receipt.heavy_paths).toContainEqual(expect.objectContaining({ path: 'cache/heavy.bin', tracked: false }));
    expect(receipt.heavy_paths).toContainEqual(expect.objectContaining({ path: 'ordinary-heavy.bin', tracked: false }));
    expect(receipt.ignored_paths).toContainEqual(expect.objectContaining({ group: 'redacted-secret-like', count: 1 }));
    expect(receipt.custom_project_assets).toEqual(expect.arrayContaining([expect.objectContaining({ path: '.juno_task/scripts/kanban.sh' }), expect.objectContaining({ path: '.git/hooks/custom-hook', kind: 'git-hook' })]));
    expect(receipt.hook_config_shapes).toContainEqual(expect.objectContaining({ path: '.claude/settings.json', events: [{ event: 'PreToolUse', definition_count: 1 }], values_collected: false }));
    expect(receipt.hook_config_shapes).toContainEqual(expect.objectContaining({ path: '.juno_task/config.json', lifecycle_present: true, controller_workspace_present: true, values_collected: false }));
    expect(text).not.toContain('JUNO_CONFIG_SECRET_COMMAND'); expect(text).not.toContain('/owner/private');
    expect(receipt.policy_generation_blocked).toBe(true);
    expect(receipt.policy_generation_block_reasons).toContain('explicit_product_ref_required');
    expect(receipt.required_owner_answers.automatic_classifications).toContainEqual(expect.objectContaining({ path: '.juno_task/scripts/__pycache__/generated.pyc', handling: 'automatic', reason: 'generated_rebuildable_cache' }));
    for (const reserved of ['.juno_task/artifacts', '.juno_task/logs', '.juno_task/receipts', '.juno_task/state']) {
      expect(receipt.required_owner_answers.dispositions).toContainEqual(expect.objectContaining({
        kind: 'controller_private', path: reserved,
        reason: 'absent_but_policy_reserved_controller_state',
      }));
    }
  });

  it('refuses unresolved answers and validates a complete generic policy bundle', async () => {
    const receiptPath = path.join(temporary, 'inventory.json');
    expect(run(project, 'inventory', '--project', project, '--product-ref', 'refs/heads/product', '--heavy-threshold-bytes', '32', '--output', receiptPath).status).toBe(0);
    const receipt = await fs.readJson(receiptPath); const incomplete = path.join(temporary, 'incomplete.json');
    expect(run(project, 'owner-template', '--inventory', receiptPath, '--output', incomplete).status).toBe(0);
    const template = await fs.readJson(incomplete);
    expect(template.schema_version).toBe('juno_migration_owner_answers.v1');
    expect(template.inventory_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(template.dispositions)).toContain(null);
    const refused = run(project, 'generate-policy', '--inventory', receiptPath, '--answers', incomplete, '--output', path.join(temporary, 'refused.json'));
    expect(refused.status).toBe(2); expect(refused.stderr).toContain('owner answers unresolved');
    const dispositions = Object.fromEntries(receipt.required_owner_answers.dispositions.map((row: any) => [row.id, 'keep']));
    const authorities = Object.fromEntries(receipt.required_owner_answers.separate_authorities.map((name: string) => [name, false]));
    const answers = {
      schema_version: template.schema_version, inventory_sha256: template.inventory_sha256,
      product_ref: 'refs/heads/product', expected_product_head: receipt.git.local_product_refs['refs/heads/product'],
      controller_branch: 'refs/heads/juno/controller-metadata-approved', controller_path: path.join(temporary, 'controller'),
      integration_path: path.join(temporary, 'integration'), task_workspace_root: path.join(temporary, 'tasks'),
      branch_prefix: 'refs/heads/feature-', rollback_owner: 'repository-owner', cleanup_owner: 'repository-owner',
      allowed_paths: ['src', 'tests'],
      controller_private_paths: ['.juno_task/ledger', '.juno_task/specs', '.juno_task/tasks', '.juno_task/tasks.md'],
      copied_metadata: ['.juno_task/ledger', '.juno_task/specs', '.juno_task/tasks', '.juno_task/tasks.md'],
      focused_validation: [{ id: 'focused', cwd: 'src', argv: ['npm', 'test'], timeout_seconds: 60, max_output_bytes: 4096 }],
      full_suite_validation: { id: 'full', cwd: 'src', argv: ['npm', 'test'], timeout_seconds: 120, max_output_bytes: 8192 },
      risk_policy: await fs.readJson(path.resolve(process.cwd(), 'src/templates/config/risk-policy.json')),
      dispositions, authorities,
    };
    const answersPath = path.join(temporary, 'answers.json'); const output = path.join(temporary, 'policies.json');
    await fs.writeJson(answersPath, answers);
    const generated = run(project, 'generate-policy', '--inventory', receiptPath, '--answers', answersPath, '--output', output);
    expect(generated.status, generated.stderr).toBe(0);
    const bundle = await fs.readJson(output);
    expect(bundle.migration_authorized).toBe(false);
    expect(bundle.policies.metadata_controller.product_ref).toBe('refs/heads/product');
    expect(bundle.policies.task_workspace.workspace_root).toBe(path.join(temporary, 'tasks'));
    expect(JSON.stringify(bundle)).not.toContain('juno-mono-002'); expect(JSON.stringify(bundle)).not.toContain('convert_IF_chat');
    const taskDecision = receipt.required_owner_answers.dispositions.find((row: any) => row.path === '.juno_task/tasks');
    answers.dispositions[taskDecision.id] = 'retire';
    await fs.writeJson(answersPath, answers);
    const contradiction = run(project, 'generate-policy', '--inventory', receiptPath, '--answers', answersPath, '--output', path.join(temporary, 'contradiction.json'));
    expect(contradiction.status).toBe(2); expect(contradiction.stderr).toContain('contradicts copied_metadata');
  });

  it('refuses a receipt inside the inspected repository', () => {
    const result = run(project, 'inventory', '--project', project, '--output', path.join(project, 'inventory.json'));
    expect(result.status).toBe(2); expect(result.stderr).toContain('outside all inspected repositories');
    expect(fs.existsSync(path.join(project, 'inventory.json'))).toBe(false);
  });

  it('binds policy answers to an explicitly frozen product ref and protects controller output', async () => {
    const controller = path.join(temporary, 'controller'); await fs.ensureDir(controller);
    git(controller, 'init', '-q', '-b', 'controller'); git(controller, 'config', 'user.name', 'Test'); git(controller, 'config', 'user.email', 'test@example.com');
    await fs.writeFile(path.join(controller, 'product.txt'), 'full controller fixture\n');
    await fs.writeFile(path.join(controller, 'AGENTS.md'), 'committed owner instructions\n');
    await fs.outputFile(path.join(controller, '.claude/skills/owner/SKILL.md'), 'committed owner skill\n');
    git(controller, 'add', '.'); git(controller, 'add', '-f', 'AGENTS.md', '.claude/skills/owner/SKILL.md');
    git(controller, 'commit', '-qm', 'full controller');
    const inside = run(project, 'inventory', '--project', project, '--controller', controller, '--output', path.join(controller, 'receipt.json'));
    expect(inside.status).toBe(2); expect(inside.stderr).toContain('outside all inspected repositories');
    const receiptPath = path.join(temporary, 'frozen.json');
    expect(run(project, 'inventory', '--project', project, '--controller', controller, '--product-ref', 'refs/heads/product', '--output', receiptPath).status).toBe(0);
    const receipt = await fs.readJson(receiptPath);
    expect(receipt.git.selected_product_ref).toBe('refs/heads/product');
    expect(receipt.git.selected_product_head).toBe(receipt.git.local_product_refs['refs/heads/product']);
    expect(receipt.controller.metadata_only).toBe(false);
    expect(receipt.controller.tracked_product_roots).toContain('product.txt');
    expect(receipt.controller.tracked_agent_surface).toEqual([
      '.claude/skills/owner/SKILL.md',
      'AGENTS.md',
    ]);
    expect(receipt.required_owner_answers.dispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'controller_agent_surface', path: 'AGENTS.md', recommended_disposition: 'externalize' }),
      expect.objectContaining({ kind: 'controller_agent_surface', path: '.claude/skills/owner/SKILL.md', recommended_disposition: 'externalize' }),
    ]));
    const protectedTemplate = run(project, 'owner-template', '--inventory', receiptPath, '--output', path.join(project, 'answers.json'));
    expect(protectedTemplate.status).toBe(2); expect(protectedTemplate.stderr).toContain('outside all inventoried repositories');
  });

  it('records an ahead product ref without requiring a network remote', async () => {
    git(project, 'checkout', '-q', 'product');
    git(project, 'branch', 'baseline', 'HEAD');
    expect(git(project, 'branch', '--set-upstream-to=baseline', 'product').status).toBe(0);
    await fs.writeFile(path.join(project, 'ahead.txt'), 'ahead\n');
    git(project, 'add', 'ahead.txt'); git(project, 'commit', '-qm', 'ahead');
    const receiptPath = path.join(temporary, 'ahead.json');
    const result = run(project, 'inventory', '--project', project, '--product-ref', 'refs/heads/product', '--output', receiptPath);
    expect(result.status, result.stderr).toBe(0);
    const receipt = await fs.readJson(receiptPath);
    expect(receipt.git.upstream).toBe('baseline');
    expect(receipt.git.ahead).toBe(1); expect(receipt.git.behind).toBe(0); expect(receipt.git.diverged).toBe(false);
    expect(receipt.git.selected_product_upstream).toBe('refs/heads/baseline');
    expect(receipt.git.selected_product_ahead).toBe(1); expect(receipt.git.selected_product_behind).toBe(0);
  });

  it('records checkout mismatch and refuses policy generation from the wrong tree', async () => {
    await fs.writeFile(path.join(project, 'detached-only.txt'), 'not on product ref\n');
    git(project, 'add', 'detached-only.txt'); expect(git(project, 'commit', '-qm', 'detached-only').status).toBe(0);
    const receiptPath = path.join(temporary, 'mismatch.json'); const answersPath = path.join(temporary, 'mismatch-answers.json');
    expect(run(project, 'inventory', '--project', project, '--product-ref', 'refs/heads/product', '--output', receiptPath).status).toBe(0);
    const receipt = await fs.readJson(receiptPath);
    expect(receipt.git.checkout_matches_selected_product).toBe(false);
    expect(receipt.inventory_warnings).toContain('inspected_checkout_does_not_match_selected_product_ref');
    expect(receipt.policy_generation_block_reasons).toContain('inspected_checkout_does_not_match_selected_product_ref');
    expect(run(project, 'owner-template', '--inventory', receiptPath, '--output', answersPath).status).toBe(0);
    const refused = run(project, 'generate-policy', '--inventory', receiptPath, '--answers', answersPath, '--output', path.join(temporary, 'mismatch-policy.json'));
    expect(refused.status).toBe(2); expect(refused.stderr).toContain('exact selected product ref commit');
  });

  it('protects child repositories, rejects fake controller roots, and never executes runtime candidates', async () => {
    const malicious = path.join(temporary, 'yy-malicious'); const marker = path.join(project, 'runtime-was-executed');
    await fs.writeFile(malicious, `#!/bin/sh\ntouch '${marker}'\n`); await fs.chmod(malicious, 0o755);
    const childRoot = path.join(project, 'deps/child'); const nestedRoot = path.join(project, 'vendor/nested');
    for (const destination of [path.join(childRoot, 'receipt.json'), path.join(nestedRoot, 'receipt.json')]) {
      const refused = run(project, 'inventory', '--project', project, '--runtime', malicious, '--output', destination);
      expect(refused.status).toBe(2); expect(refused.stderr).toContain('outside all inspected repositories');
    }
    expect(await fs.pathExists(marker)).toBe(false);

    const receiptPath = path.join(temporary, 'protected-children.json');
    expect(run(project, 'inventory', '--project', project, '--runtime', malicious, '--output', receiptPath).status).toBe(0);
    expect(await fs.pathExists(marker)).toBe(false);
    const ownerInChild = run(project, 'owner-template', '--inventory', receiptPath, '--output', path.join(childRoot, 'answers.json'));
    expect(ownerInChild.status).toBe(2); expect(ownerInChild.stderr).toContain('outside all inventoried repositories');
    const policyInNested = run(project, 'generate-policy', '--inventory', receiptPath, '--answers', path.join(temporary, 'missing.json'), '--output', path.join(nestedRoot, 'policy.json'));
    expect(policyInNested.status).toBe(2); expect(policyInNested.stderr).toContain('outside all inventoried repositories');

    const fakeController = path.join(project, 'ordinary-controller-directory'); await fs.ensureDir(fakeController);
    const fakeReceipt = path.join(temporary, 'fake-controller.json');
    expect(run(project, 'inventory', '--project', project, '--controller', fakeController, '--output', fakeReceipt).status).toBe(0);
    const fake = await fs.readJson(fakeReceipt);
    expect(fake.controller.available).toBe(false);
    expect(fake.controller.invalid_reason).toContain('exact Git worktree root');
  }, 60_000);
});
