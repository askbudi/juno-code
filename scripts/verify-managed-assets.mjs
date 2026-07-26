#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const assets = [
  ['prompts', 'clean_worktree.md'],
  ['prompts', 'new_task_workflow.md'],
  ['prompts', 'run_workflow.md'],
  ['prompts', 'migrate_juno_code_v1_to_v2.md'],
  ['prompts', 'migrate_juno_kanban_v1_to_v2.md'],
  ['wiki', 'git_worktree_lifecycle.md'],
  ['scripts', 'worktree_lifecycle_audit.py'],
];

for (const [directory, file] of assets) {
  const source = readFileSync(path.join('src', 'templates', directory, file));
  const built = readFileSync(path.join('dist', 'templates', directory, file));
  if (!source.equals(built)) {
    throw new Error(`Managed asset differs between source and dist: ${directory}/${file}`);
  }
}

const packDirectory = mkdtempSync(path.join(os.tmpdir(), 'juno-code-managed-pack-'));
try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    { encoding: 'utf8' },
  );
  const pack = JSON.parse(packOutput);
  if (!Array.isArray(pack) || !pack[0]?.files || !pack[0]?.filename) {
    throw new Error('npm pack returned no artifact inventory');
  }
  const inventory = new Set(pack[0].files.map((entry) => entry.path));
  const archivePath = path.join(packDirectory, pack[0].filename);
  execFileSync('tar', ['-xzf', archivePath, '-C', packDirectory]);

  for (const [directory, file] of assets) {
    const packedPath = `dist/templates/${directory}/${file}`;
    if (!inventory.has(packedPath)) {
      throw new Error(`npm package omits managed asset: ${packedPath}`);
    }
    const source = readFileSync(path.join('src', 'templates', directory, file));
    const packed = readFileSync(path.join(packDirectory, 'package', packedPath));
    if (!source.equals(packed)) {
      throw new Error(
        `Managed asset differs between source and packed npm artifact: ${packedPath}`,
      );
    }
  }
} finally {
  rmSync(packDirectory, { recursive: true, force: true });
}

console.log(
  `Verified ${assets.length} managed assets byte-identically in source, dist, and the npm tarball.`,
);
