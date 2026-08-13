#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'juno-installed-test-fixture-'));
const packDirectory = path.join(temporary, 'pack');
await mkdir(packDirectory);

try {
  const packed = JSON.parse(execFileSync(
    'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    { cwd: root, encoding: 'utf8' },
  ))[0];
  const archive = path.join(packDirectory, packed.filename);
  execFileSync('tar', ['-xzf', archive, '-C', packDirectory]);
  const packageRoot = path.join(packDirectory, 'package');
  const templates = path.join(packageRoot, 'dist/templates');
  const installed = path.join(temporary, 'consumer');
  const installedScripts = path.join(installed, '.juno_task/scripts');
  await mkdir(installedScripts, { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(templates, 'managed-assets.json'), 'utf8'));
  for (const asset of manifest.assets) {
    await cp(path.join(templates, asset.source), path.join(installed, asset.destination));
  }
  const adjacentFixture = path.join(installedScripts, 'tests/real_git_fixture.py');
  assert.equal(
    await import('node:fs').then(({ existsSync }) => existsSync(adjacentFixture)),
    false,
    'isolated installed layout must not duplicate canonical fixture authority',
  );
  const hostileFixture = 'raise RuntimeError("non-authoritative fixture was loaded")\n';
  await writeFile(adjacentFixture, hostileFixture);
  const guessedFixture = path.join(installed, 'juno-code/src/templates/scripts/tests/real_git_fixture.py');
  await mkdir(path.dirname(guessedFixture), { recursive: true });
  await writeFile(guessedFixture, hostileFixture);

  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const executable = path.join(packageRoot, 'dist/bin/cli.mjs');
  const executableBytes = await readFile(executable);
  const inventory = {
    schemaVersion: 1,
    packageName: 'juno-code',
    packageVersion: packageJson.version,
    assets: {},
  };
  const identity = {
    package: 'juno-code', version: packageJson.version, executable,
    executable_sha256: createHash('sha256').update(executableBytes).digest('hex'),
    source: 'installed-release', tracked: false,
  };
  await mkdir(path.join(installed, '.juno_task/runtime'), { recursive: true });
  await writeFile(path.join(installed, '.juno_task/managed-assets.json'), JSON.stringify(inventory));
  await writeFile(path.join(installed, '.juno_task/runtime/identity.json'), JSON.stringify(identity));

  const selections = [
    ['test_task_workspace.py',
      'TaskWorkspaceTests.test_authoritative_juno_fixture_missing_asset_has_one_setup_diagnostic'],
    ['test_merge_queue.py',
      'MergeQueueTests.test_parallel_x_y_then_moved_target_uses_one_two_parent_composition'],
    ['test_integration_workspace.py',
      'IntegrationWorkspaceTests.test_status_is_offline_and_reports_stale_owner_as_data'],
  ];
  const testEnv = { ...process.env, JUNO_TASK_ROOT: installed,
    PYTHONPYCACHEPREFIX: path.join(temporary, 'pycache') };
  for (const [file, selection] of selections) {
    execFileSync('python3', [path.join(installedScripts, 'tests', file), selection], {
      cwd: installed, env: testEnv, stdio: 'pipe',
    });
  }

  const identityPath = path.join(installed, '.juno_task/runtime/identity.json');
  const assertUnavailable = (label) => {
    const unavailable = spawnSync(
      'python3', [path.join(installedScripts, 'tests/test_task_workspace.py'), '--help'],
      { cwd: installed, env: testEnv, encoding: 'utf8' },
    );
    assert.notEqual(unavailable.status, 0, `${label} installed tests must fail closed`);
    assert.equal((unavailable.stderr.match(/package-bound test fixture unavailable/g) ?? []).length, 1,
      `${label} package fixture must emit one setup diagnostic`);
    assert.match(unavailable.stderr, /yy scripts update --force/,
      `${label} package fixture diagnostic must name supported recovery`);
  };
  const hiddenIdentity = identityPath + '.unavailable';
  await rename(identityPath, hiddenIdentity);
  assertUnavailable('unbound');
  await writeFile(identityPath, JSON.stringify({ ...identity, executable_sha256: '0'.repeat(64) }));
  assertUnavailable('invalid-identity');
  await rm(identityPath);
  await rename(hiddenIdentity, identityPath);
  console.log('Installed consumers ignored conflicting adjacent/guessed fixtures, loaded canonical package bytes, and passed focused setup.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
