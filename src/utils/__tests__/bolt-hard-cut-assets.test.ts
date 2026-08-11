import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src/templates');
const metadataBoundary = join(sourceRoot, 'wiki/metadata_controller_boundary.md');
const projectAgents = resolve(process.cwd(), '..', 'AGENTS.md');
const retired = [
  'scripts/task_lifecycle.py',
  'scripts/integration_candidate.py',
  'scripts/integration_owner_preflight.py',
  'scripts/worktree_lifecycle.py',
  'scripts/tests/test_task_lifecycle.py',
  'scripts/tests/test_controller_workspace.py',
  'scripts/tests/test_integration_concurrency.py',
  'config/lifecycle.json',
  'config/controller-workspace.json',
];

function textFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...textFiles(path));
    else if (/\.(md|json)$/.test(entry.name)) output.push(path);
  }
  return output;
}

const retiredReference =
  /integration_(?:candidate|owner_preflight)\.py|controller-workspace\.json/i;
const canonicalRetiredConfigProse =
  /exact retired generated `controllerWorkspace\.enabled` \/ `controller-workspace\.json` config must not be registered or refreshed as if it were canonical/i;

function operationalRetiredReferences(file: string, text: string): string[] {
  return text.split('\n').filter((line) => {
    if (!retiredReference.test(line)) return false;
    if (file === projectAgents) return !/rollback-only/i.test(line);
    if (file === metadataBoundary && canonicalRetiredConfigProse.test(line)) {
      return /integration_(?:candidate|owner_preflight)\.py/i.test(line);
    }
    return true;
  });
}

describe('Bolt shipped hard cut', () => {
  it('does not package retired executors or configuration', () => {
    const manifest = readFileSync(join(sourceRoot, 'managed-assets.json'), 'utf8');
    for (const relative of retired) {
      expect(existsSync(join(sourceRoot, relative)), relative).toBe(false);
      expect(manifest, relative).not.toContain(relative);
    }
    expect(existsSync(join(sourceRoot, 'scripts/controller_workspace.py'))).toBe(true);
    expect(manifest).not.toContain('scripts/controller_workspace.py');
  });

  it('ships only Bolt task/merge guidance', () => {
    const files = [
      ...textFiles(join(sourceRoot, 'prompts')),
      ...textFiles(join(sourceRoot, 'wiki')),
      ...textFiles(join(sourceRoot, 'skills')),
      resolve(process.cwd(), 'README.md'),
      resolve(process.cwd(), '..', 'README.md'),
      projectAgents,
      resolve(process.cwd(), '..', 'CLAUDE.md'),
      resolve(process.cwd(), 'docs', 'bolt-package-acceptance.md'),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/yy lifecycle(?:\s|`)/i);
      expect(text, file).not.toMatch(/controller[- ]sync/i);
      expect(text, file).not.toMatch(/--checkpoint-controller|--exec-command/i);
      expect(operationalRetiredReferences(file, text), file).toEqual([]);
      expect(text, file).not.toMatch(/task_lifecycle\.py/i);
      expect(text, file).not.toMatch(/worktree_lifecycle\.py/i);
    }
  });

  it('admits canonical migration prose but rejects operational retired references', () => {
    const canonicalProse =
      'A controller with the exact retired generated `controllerWorkspace.enabled` / `controller-workspace.json` config must not be registered or refreshed as if it were canonical.';
    expect(operationalRetiredReferences(metadataBoundary, canonicalProse)).toEqual([]);

    const operationalProse = [
      'Run python3 .juno_task/scripts/integration_candidate.py target-preflight.',
      'Load .juno_task/config/controller-workspace.json before starting a task.',
    ].join('\n');
    expect(operationalRetiredReferences(metadataBoundary, operationalProse)).toEqual(
      operationalProse.split('\n'),
    );
  });

  it('keeps the legacy CLI command as a refusal, never a dispatcher', () => {
    const cli = readFileSync(resolve(process.cwd(), 'src/bin/cli.ts'), 'utf8');
    expect(cli).toContain('legacy lifecycle executor was removed');
    expect(cli).toContain('yy task start|status|finish');
    expect(cli).not.toContain("scripts', 'task_lifecycle.py");
    expect(cli).not.toContain("spawn('python3', args");
    expect(cli).not.toContain('specialize-clean-worktree');
    const workflowRunner = readFileSync(join(sourceRoot, 'scripts/workflow_runner.sh'), 'utf8');
    expect(workflowRunner).not.toMatch(/yy lifecycle(?:\s|`)/i);
    expect(workflowRunner).toContain('yy task start TASK_ID');
    expect(workflowRunner).toContain('yy merge next');
  });
});
