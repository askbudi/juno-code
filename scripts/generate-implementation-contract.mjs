#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonical = path.join(root, 'src/templates/skills/canonical/ralph-loop/references/implement.md');
const relativeDestinations = [
  'src/templates/skills/claude/ralph-loop/references/implement.md',
  'src/templates/skills/codex/ralph-loop/references/implement.md',
  'src/templates/skills/pi/ralph-loop/references/implement.md',
  '.claude/skills/ralph-loop/references/implement.md',
  '.agents/skills/ralph-loop/references/implement.md',
  '.pi/skills/ralph-loop/references/implement.md',
  '../.claude/skills/ralph-loop/references/implement.md',
  '../.agents/skills/ralph-loop/references/implement.md',
  '../.pi/skills/ralph-loop/references/implement.md',
];
const content = fs.readFileSync(canonical, 'utf8');
if (!content.startsWith('<!-- GENERATED DESTINATIONS:')) {
  throw new Error('canonical implementation contract must identify generated destinations');
}
const check = process.argv.includes('--check');
const drift = [];
for (const relative of relativeDestinations) {
  const destination = path.resolve(root, relative);
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) {
    drift.push(path.relative(path.resolve(root, '..'), destination));
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
console.log(check ? 'implementation contract parity: OK' : `generated ${relativeDestinations.length} implementation contracts`);
