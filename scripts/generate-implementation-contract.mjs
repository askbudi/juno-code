#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const declarationPath = path.join(root, 'scripts/implementation-contract.json');
const declaration = JSON.parse(fs.readFileSync(declarationPath, 'utf8'));
if (
  declaration.schema_version !== 'juno_generated_output_contract.v1' ||
  typeof declaration.source !== 'string' ||
  !Array.isArray(declaration.destinations) ||
  declaration.destinations.some((item) => typeof item !== 'string')
) {
  throw new Error('invalid implementation-contract output declaration');
}
const projectRoot = path.resolve(root, '..');
const canonical = path.resolve(projectRoot, declaration.source);
const destinations = declaration.destinations.map((relative) => ({
  relative,
  absolute: path.resolve(projectRoot, relative),
}));
if (
  path.relative(projectRoot, canonical).startsWith('..') ||
  destinations.some(({ absolute }) => path.relative(projectRoot, absolute).startsWith('..'))
) {
  throw new Error('implementation-contract outputs must stay inside the project');
}
const content = fs.readFileSync(canonical, 'utf8');
if (!content.startsWith('<!-- GENERATED DESTINATIONS:')) {
  throw new Error('canonical implementation contract must identify generated destinations');
}
const check = process.argv.includes('--check');
const drift = [];
for (const { relative, absolute: destination } of destinations) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) {
    drift.push(relative);
    if (!check) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
  }
}
if (check && drift.length) {
  console.error(`implementation contract drift:\n${drift.map((item) => `  ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(check ? 'implementation contract parity: OK' : `generated ${destinations.length} implementation contracts`);
