#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const assets = [
  ['prompts', 'clean_worktree.md'],
  ['prompts', 'new_task_workflow.md'],
  ['prompts', 'run_workflow.md'],
  ['prompts', 'migrate_juno_code_v1_to_v2.md'],
  ['prompts', 'migrate_juno_kanban_v1_to_v2.md'],
  ['wiki', 'git_worktree_lifecycle.md'],
];

for (const [directory, file] of assets) {
  const source = readFileSync(path.join('src', 'templates', directory, file));
  const built = readFileSync(path.join('dist', 'templates', directory, file));
  if (!source.equals(built)) {
    throw new Error(`Managed asset differs between source and dist: ${directory}/${file}`);
  }
}

const packOutput = execFileSync('npm', ['pack', '--json', '--dry-run', '--ignore-scripts'], {
  encoding: 'utf8',
});
const pack = JSON.parse(packOutput);
if (!Array.isArray(pack) || !pack[0]?.files) throw new Error('npm pack returned no inventory');
const inventory = new Set(pack[0].files.map((entry) => entry.path));
for (const [directory, file] of assets) {
  const packedPath = `dist/templates/${directory}/${file}`;
  if (!inventory.has(packedPath)) throw new Error(`npm package omits managed asset: ${packedPath}`);
}
console.log(`Verified ${assets.length} managed assets in source, dist, and npm pack inventory.`);
