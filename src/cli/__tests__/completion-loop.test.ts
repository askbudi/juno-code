import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CompletionInstaller } from '../utils/completion-enhanced.js';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

describe('loop completion and documentation contract', () => {
  it.each(['bash', 'zsh', 'fish'] as const)(
    'exposes the loop command, options, and enum values for %s',
    (shell) => {
      const script = new CompletionInstaller().generateEnhancedCompletion(shell, 'yylo');
      expect(script).toContain('loop');
      const optionPrefix = shell === 'fish' ? '-l ' : '--';
      expect(script).toContain(`${optionPrefix}iterations`);
      expect(script).toContain(`${optionPrefix}step`);
      expect(script).toContain(`${optionPrefix}workflow`);
      expect(script).toContain(`${optionPrefix}continuity`);
      expect(script).toContain(`${optionPrefix}on-error`);
      expect(script).toMatch(/iteration.*run.*shell/s);
      expect(script).toMatch(/continue.*stop/s);
    },
  );

  it('documents copyable inline and YAML forms without conflating -n and -i', async () => {
    const readme = await fs.readFile(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('yylo loop -n 5');
    expect(readme).toContain('yylo loop --workflow flow.yaml');
    expect(readme).toContain('continuity: iteration');
    expect(readme).toContain('on_error: continue');
    expect(readme).toContain('`-n/--iterations`');
    expect(readme).toContain('`-i/--max-iterations`');
    for (const variable of [
      'YYLO_LOOP_ID', 'YYLO_ITERATION', 'YYLO_ITERATION_COUNT', 'YYLO_STEP', 'YYLO_STEP_COUNT',
    ]) {
      expect(readme).toContain(variable);
    }
  });

  it('keeps the installed and source public command inventories aligned', async () => {
    const installed = await fs.readJson(path.join(PROJECT_ROOT, '..', '.juno_task/config/task-workspace.json'));
    const template = await fs.readJson(path.join(PROJECT_ROOT, 'src/templates/config/task-workspace.json'));
    expect(installed.documentation_validation.cli_top_level).toContain('loop');
    expect(template.documentation_validation.cli_top_level).toContain('loop');
    expect(installed.documentation_validation.cli_top_level)
      .toEqual(template.documentation_validation.cli_top_level);
  });
});
