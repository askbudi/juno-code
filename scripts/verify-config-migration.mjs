#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { loadConfig } = require('../dist/index.js');
const roots = [];
let tarball;
const previousWrites = process.env.YYLO_PROJECT_BOOTSTRAP_WRITES;
process.env.YYLO_PROJECT_BOOTSTRAP_WRITES = '1';

try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  tarball = packed[0].filename;
  const packedDist = execFileSync('tar', ['-xOf', tarball, 'package/dist/index.js']);
  assert.deepEqual(packedDist, await readFile('dist/index.js'), 'npm tarball dist differs from built dist');

  const root = await mkdtemp(join(tmpdir(), 'juno-config-migration-'));
  roots.push(root);
  await mkdir(join(root, '.juno_task'), { recursive: true });
  const configPath = join(root, '.juno_task', 'config.json');
  const legacy = {
    defaultSubagent: 'claude',
    defaultModel: 'custom-model',
    defaultModels: { pi: ':gpt' },
    defaultMaxIterations: 50,
    hooks: { START_ITERATION: { commands: ['custom-hook'] } },
    promptMacros: { global: { custom: 'keep' } },
    gitCheckpoint: { include: [] },
  };
  await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  await loadConfig({ baseDir: root });
  const migrated = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(migrated.configVersion, 1);
  assert.equal(migrated.defaultBackend, 'shell');
  assert.equal(migrated.defaultModel, legacy.defaultModel);
  assert.deepEqual(migrated.defaultModels, legacy.defaultModels);
  assert.equal(migrated.defaultMaxIterations, 50);
  assert.deepEqual(migrated.hooks, legacy.hooks);
  assert.deepEqual(migrated.gitCheckpoint, legacy.gitCheckpoint);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  const stable = await readFile(configPath);
  await loadConfig({ baseDir: root });
  assert.deepEqual(await readFile(configPath), stable, 'second migration changed config bytes');

  const invalidRoot = await mkdtemp(join(tmpdir(), 'juno-config-invalid-'));
  roots.push(invalidRoot);
  await mkdir(join(invalidRoot, '.juno_task'), { recursive: true });
  const invalidPath = join(invalidRoot, '.juno_task', 'config.json');
  await writeFile(invalidPath, '{"defaultSubagent":"claude","hooks":{}}\n');
  const invalidBefore = await readFile(invalidPath);
  await assert.rejects(
    loadConfig({ baseDir: invalidRoot, cliConfig: { defaultMaxIterations: 2000 } }),
    /defaultMaxIterations/,
  );
  assert.deepEqual(await readFile(invalidPath), invalidBefore);

  console.log('Verified compiled/npm project-config migration and preservation contracts.');
} finally {
  if (previousWrites === undefined) delete process.env.YYLO_PROJECT_BOOTSTRAP_WRITES;
  else process.env.YYLO_PROJECT_BOOTSTRAP_WRITES = previousWrites;
  if (tarball) await rm(tarball, { force: true });
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
