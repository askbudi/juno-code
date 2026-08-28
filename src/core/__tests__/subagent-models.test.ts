import { describe, expect, it } from 'vitest';

import {
  SUBAGENT_DEFAULT_MODELS,
  getConfiguredDefaultModelForSubagent,
  getDefaultModelForSubagent,
  isModelCompatibleWithSubagent,
} from '../subagent-models.js';

describe('subagent-models', () => {
  it('provides built-in defaults for all supported subagents', () => {
    expect(SUBAGENT_DEFAULT_MODELS).toEqual({
      claude: ':sonnet',
      codex: ':codex',
      gemini: ':pro',
      cursor: 'auto',
      pi: ':gpt',
    });

    expect(getDefaultModelForSubagent('pi')).toBe(':gpt');
    expect(getDefaultModelForSubagent('claude')).toBe(':sonnet');
  });

  it('prefers per-subagent map over legacy defaultModel for defaultSubagent', () => {
    const resolved = getConfiguredDefaultModelForSubagent(
      {
        defaultSubagent: 'claude',
        defaultModel: ':opus',
        defaultModels: {
          claude: ':sonnet',
          codex: ':codex',
        },
      },
      'claude',
    );

    expect(resolved).toBe(':sonnet');
  });

  it('falls back to legacy defaultModel when per-subagent map is missing', () => {
    const resolved = getConfiguredDefaultModelForSubagent(
      {
        defaultSubagent: 'claude',
        defaultModel: ':opus',
      },
      'claude',
    );

    expect(resolved).toBe(':opus');
  });

  it('uses per-subagent map for non-default subagents', () => {
    const resolved = getConfiguredDefaultModelForSubagent(
      {
        defaultSubagent: 'claude',
        defaultModel: ':opus',
        defaultModels: {
          codex: ':gpt-5',
        },
      },
      'codex',
    );

    expect(resolved).toBe(':gpt-5');
  });

  it('accepts an opaque project shortcut as a configured default for its subagent', () => {
    const config = {
      defaultSubagent: 'codex' as const,
      defaultModels: { codex: ':sonnet' },
      modelShortcuts: { codex: { ':sonnet': 'zai/glm-5.3' } },
    };

    expect(getConfiguredDefaultModelForSubagent(config, 'codex')).toBe(':sonnet');
    expect(isModelCompatibleWithSubagent(':sonnet', 'codex', config)).toBe(true);
  });

  it('ignores incompatible shorthand mappings', () => {
    const resolved = getConfiguredDefaultModelForSubagent(
      {
        defaultSubagent: 'codex',
        defaultModel: ':sonnet',
        defaultModels: {
          codex: ':sonnet',
        },
      },
      'codex',
    );

    expect(resolved).toBeUndefined();
    expect(isModelCompatibleWithSubagent(':sonnet', 'codex')).toBe(false);
  });
});
