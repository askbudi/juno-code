import type { JunoTaskConfig, SubagentType } from '../types/index.js';

export const SUBAGENT_DEFAULT_MODELS: Readonly<Record<SubagentType, string>> = {
  claude: ':sonnet',
  codex: ':codex',
  gemini: ':pro',
  cursor: 'auto',
  pi: ':pi',
};

/**
 * Get the built-in default model for a subagent.
 */
export function getDefaultModelForSubagent(subagent: SubagentType): string {
  return SUBAGENT_DEFAULT_MODELS[subagent] || SUBAGENT_DEFAULT_MODELS.claude;
}

/**
 * Check if a model string is compatible with a given subagent.
 *
 * Full model names (non-shorthand) are considered compatible because users
 * may provide provider-specific model ids.
 */
export function isModelCompatibleWithSubagent(model: string, subagent: SubagentType): boolean {
  if (!model.startsWith(':')) {
    return true;
  }

  const claudeShorthands = [':sonnet', ':haiku', ':opus'];
  const codexShorthands = [':codex', ':codex-mini', ':gpt-5', ':mini'];
  const geminiShorthands = [':pro', ':flash'];

  const isClaudeModel = claudeShorthands.includes(model) || model.startsWith(':claude');
  const isCodexModel = codexShorthands.includes(model) || model.startsWith(':gpt');
  const isGeminiModel = geminiShorthands.includes(model) || model.startsWith(':gemini');

  switch (subagent) {
    case 'claude':
      return isClaudeModel || (!isCodexModel && !isGeminiModel);
    case 'codex':
      return isCodexModel || (!isClaudeModel && !isGeminiModel);
    case 'gemini':
      return isGeminiModel || (!isClaudeModel && !isCodexModel);
    case 'cursor':
      return true;
    case 'pi':
      return true;
    default:
      return true;
  }
}

/**
 * Resolve configured model for a specific subagent.
 *
 * Priority:
 * 1) `defaultModels[subagent]` (single source of truth)
 * 2) Legacy `defaultModel` when it belongs to `defaultSubagent`
 * 3) undefined (caller should fallback to built-in defaults)
 */
export function getConfiguredDefaultModelForSubagent(
  config: Pick<JunoTaskConfig, 'defaultSubagent' | 'defaultModel' | 'defaultModels'>,
  subagent: SubagentType,
): string | undefined {
  const modelFromMap = config.defaultModels?.[subagent];
  if (typeof modelFromMap === 'string' && isModelCompatibleWithSubagent(modelFromMap, subagent)) {
    return modelFromMap;
  }

  const legacyDefaultModel =
    config.defaultSubagent === subagent &&
    typeof config.defaultModel === 'string' &&
    isModelCompatibleWithSubagent(config.defaultModel, subagent)
      ? config.defaultModel
      : undefined;

  if (legacyDefaultModel) {
    return legacyDefaultModel;
  }

  return undefined;
}
