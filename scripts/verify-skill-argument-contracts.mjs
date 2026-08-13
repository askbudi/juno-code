#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const skillsRoot = path.join(root, 'src/templates/skills');
const contractPath = path.join(skillsRoot, 'argument-contracts.json');
const placeholderPattern = /\$\{@:\d+(?::\d+)?\}|\$ARGUMENTS|\$@|\$\d+/g;

function fail(message) {
  console.error(`Managed skill argument contract violation: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(contractPath)) {
  fail(`missing declaration ${path.relative(root, contractPath)}`);
} else {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  if (contract.schemaVersion !== 1 || !Array.isArray(contract.surfaces) || !contract.skills) {
    fail('argument-contracts.json must use schemaVersion 1 with surfaces and skills');
  } else {
    const declaredSkills = Object.keys(contract.skills).sort();
    for (const surface of contract.surfaces) {
      const surfaceDir = path.join(skillsRoot, surface);
      const actualSkills = fs.readdirSync(surfaceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(surfaceDir, entry.name, 'SKILL.md')))
        .map((entry) => entry.name)
        .sort();
      if (JSON.stringify(actualSkills) !== JSON.stringify(declaredSkills)) {
        fail(`${surface} inventory ${JSON.stringify(actualSkills)} differs from declaration ${JSON.stringify(declaredSkills)}`);
      }
      for (const skill of declaredSkills) {
        const file = path.join(surfaceDir, skill, 'SKILL.md');
        const counts = {};
        for (const placeholder of fs.readFileSync(file, 'utf8').match(placeholderPattern) ?? []) {
          counts[placeholder] = (counts[placeholder] ?? 0) + 1;
        }
        const expected = contract.skills[skill].placeholders;
        if (JSON.stringify(counts) !== JSON.stringify(expected)) {
          fail(`${surface}/${skill}/SKILL.md placeholders ${JSON.stringify(counts)} differ from ${JSON.stringify(expected)}`);
        }
      }
    }
  }
}

if (!process.exitCode) console.log('Managed skill argument contracts verified.');
