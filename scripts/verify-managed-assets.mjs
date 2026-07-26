#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const manifest = JSON.parse(readFileSync(path.join('src', 'templates', 'managed-assets.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
  throw new Error('Unsupported managed asset manifest');
}
const assets = manifest.assets;
const manifestSource = readFileSync(path.join('src', 'templates', 'managed-assets.json'));
const uniqueSources = new Set(assets.map((asset) => asset.source));
const uniqueDestinations = new Set(assets.map((asset) => asset.destination));
if (uniqueSources.size !== assets.length || uniqueDestinations.size !== assets.length) {
  throw new Error('Managed asset manifest contains duplicate source or destination entries');
}

for (const asset of assets) {
  const source = readFileSync(path.join('src', 'templates', asset.source));
  const built = readFileSync(path.join('dist', 'templates', asset.source));
  const [directory, file] = asset.source.split(/\/(.*)/s);
  if (!source.equals(built)) {
    throw new Error(`Managed asset differs between source and dist: ${directory}/${file}`);
  }
}

const manifestBuilt = readFileSync(path.join('dist', 'templates', 'managed-assets.json'));
if (!manifestSource.equals(manifestBuilt)) {
  throw new Error('Managed asset manifest differs between source and dist');
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
  const manifestPackedPath = 'dist/templates/managed-assets.json';
  if (!inventory.has(manifestPackedPath)) {
    throw new Error(`npm package omits managed asset manifest: ${manifestPackedPath}`);
  }
  const archivePath = path.join(packDirectory, pack[0].filename);
  execFileSync('tar', ['-xzf', archivePath, '-C', packDirectory]);

  const packedManifest = readFileSync(path.join(packDirectory, 'package', manifestPackedPath));
  if (!manifestSource.equals(packedManifest)) {
    throw new Error('Managed asset manifest differs between source and packed npm artifact');
  }

  for (const asset of assets) {
    const packedPath = `dist/templates/${asset.source}`;
    if (!inventory.has(packedPath)) {
      throw new Error(`npm package omits managed asset: ${packedPath}`);
    }
    const source = readFileSync(path.join('src', 'templates', asset.source));
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
