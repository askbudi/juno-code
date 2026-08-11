import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const project = process.cwd();
const sourceRoot = path.join(project, 'src/templates/skills');
const destinations = {
  pi: '.pi/skills',
  claude: '.claude/skills',
  codex: '.agents/skills',
} as const;

describe('managed skill argument contracts', () => {
  it('passes the declared inventory/schema lint', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/verify-skill-argument-contracts.mjs'], {
        cwd: project,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('keeps source and checked-in installed surfaces byte-identical', async () => {
    const contract = (await fs.readJson(path.join(sourceRoot, 'argument-contracts.json'))) as {
      surfaces: Array<keyof typeof destinations>;
      skills: Record<string, unknown>;
    };
    const repository = path.dirname(project);
    for (const surface of contract.surfaces) {
      for (const skill of Object.keys(contract.skills)) {
        const source = await fs.readFile(path.join(sourceRoot, surface, skill, 'SKILL.md'));
        for (const runtimeRoot of [project, repository]) {
          const installed = await fs.readFile(
            path.join(runtimeRoot, destinations[surface], skill, 'SKILL.md'),
          );
          expect(installed, `${runtimeRoot}/${destinations[surface]}/${skill}`).toEqual(source);
        }
      }
    }
  });

  it('declares complete-request and structured understand-project schemas', async () => {
    const contract = await fs.readJson(path.join(sourceRoot, 'argument-contracts.json'));
    expect(contract.skills['ralph-loop'].placeholders).toEqual({ $ARGUMENTS: 1 });
    expect(contract.skills['understand-project'].placeholders).toEqual({
      $1: 1,
      $2: 1,
      $ARGUMENTS: 1,
    });
  });
});
