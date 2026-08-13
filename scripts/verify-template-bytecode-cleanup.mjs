#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const sourceScript = path.join(root, 'src/templates/scripts/tests/real_git_fixture.py');
const sourceService = path.join(root, 'src/templates/services/environment_boundary.py');
const sourceCache = path.join(root, 'src/templates/scripts/tests/__pycache__');
const serviceCache = path.join(root, 'src/templates/services/__pycache__');
const standaloneSource = path.join(root, 'src/templates/scripts/nested/package-fixture.pyc');
const standaloneService = path.join(root, 'src/templates/services/nested/package-fixture.pyc');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'juno-bytecode-package-'));
const sourceBefore = await readFile(sourceScript);
const serviceBefore = await readFile(sourceService);

async function generatedPaths(directory) {
  const found = [];
  async function visit(current) {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      if (entry.name === '__pycache__') found.push(relative + '/');
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.name.endsWith('.pyc')) found.push(relative);
    }
  }
  await visit(directory);
  return found.sort();
}

try {
  execFileSync('python3', ['-m', 'py_compile', sourceScript, sourceService],
    { cwd: root, stdio: 'pipe' });
  assert.ok((await generatedPaths(sourceCache)).some((name) => name.endsWith('.pyc')),
    'script fixture compilation did not create nested __pycache__ bytecode');
  assert.ok((await generatedPaths(serviceCache)).some((name) => name.endsWith('.pyc')),
    'service fixture compilation did not create nested __pycache__ bytecode');
  for (const standalone of [standaloneSource, standaloneService]) {
    await mkdir(path.dirname(standalone), { recursive: true });
    await writeFile(standalone, 'standalone bytecode fixture\n');
  }

  // prepack is the canonical release build path; package inventory is then
  // inspected without running it a second time.
  execFileSync('npm', ['run', 'prepack'], { cwd: root, stdio: 'inherit' });
  assert.deepEqual(await generatedPaths(path.join(root, 'dist/templates')), [],
    'canonical prepack left Python cache/bytecode in dist templates');
  assert.deepEqual(await readFile(sourceScript), sourceBefore,
    'canonical build modified a script source template');
  assert.deepEqual(await readFile(sourceService), serviceBefore,
    'canonical build modified a service source template');
  for (const standalone of [standaloneSource, standaloneService]) {
    assert.ok((await stat(standalone)).isFile(),
      'dist cleanup must not remove source-side generated evidence');
  }

  const packedText = execFileSync(
    'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: temporary } },
  );
  const packed = JSON.parse(packedText)[0];
  assert.ok(packed?.files, 'npm pack returned no file inventory');
  const leaked = packed.files.map((entry) => entry.path).filter(
    (name) => name.split('/').includes('__pycache__') || name.endsWith('.pyc'),
  );
  assert.deepEqual(leaked, [], 'npm tarball contains Python cache/bytecode');
  console.log(`Template bytecode cleanup verified in dist and ${packed.filename}.`);
} finally {
  await rm(sourceCache, { recursive: true, force: true });
  await rm(serviceCache, { recursive: true, force: true });
  for (const standalone of [standaloneSource, standaloneService]) {
    await rm(standalone, { force: true });
    await rm(path.dirname(standalone), { recursive: true, force: true });
  }
  await rm(temporary, { recursive: true, force: true });
}
