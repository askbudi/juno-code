export type PromptMacroWarningCode = 'unresolved' | 'cycle' | 'max-depth';

export interface PromptMacroWarning {
  readonly code: PromptMacroWarningCode;
  readonly key: string;
  readonly token: string;
  readonly message: string;
}

export interface ResolvePromptMacrosOptions {
  readonly dictionary: Record<string, string>;
  readonly maxDepth: number;
}

export interface ResolvePromptMacrosResult {
  readonly resolvedPrompt: string;
  readonly warnings: PromptMacroWarning[];
}

const MACRO_TOKEN_PREFIX = '@@';
const KEY_CHAR_REGEX = /[A-Za-z0-9_.:-]/;

export function resolvePromptMacros(
  prompt: string,
  options: ResolvePromptMacrosOptions,
): ResolvePromptMacrosResult {
  const warnings: PromptMacroWarning[] = [];
  const warningSet = new Set<string>();

  const addWarning = (warning: PromptMacroWarning): void => {
    const signature = `${warning.code}:${warning.key}:${warning.token}`;
    if (warningSet.has(signature)) {
      return;
    }
    warningSet.add(signature);
    warnings.push(warning);
  };

  const resolveToken = (key: string, token: string, stack: string[], depth: number): string => {
    if (!(key in options.dictionary)) {
      addWarning({
        code: 'unresolved',
        key,
        token,
        message: `Unresolved prompt macro ${token}; leaving token unchanged.`,
      });
      return token;
    }

    if (stack.includes(key)) {
      addWarning({
        code: 'cycle',
        key,
        token,
        message: `Circular prompt macro reference detected for ${token}; leaving token unchanged.`,
      });
      return token;
    }

    if (depth >= options.maxDepth) {
      addWarning({
        code: 'max-depth',
        key,
        token,
        message: `Prompt macro expansion reached maxDepth=${options.maxDepth} at ${token}; leaving token unchanged.`,
      });
      return token;
    }

    const value = options.dictionary[key] ?? '';
    return resolveText(value, [...stack, key], depth + 1);
  };

  const resolveText = (input: string, stack: string[], depth: number): string => {
    let result = '';
    let index = 0;

    while (index < input.length) {
      const escapedStart =
        input[index] === '\\' && input.slice(index + 1, index + 3) === MACRO_TOKEN_PREFIX;

      if (escapedStart) {
        const escapedToken = parseMacroToken(input, index + 1, false);
        if (escapedToken) {
          result += escapedToken.token;
          index = escapedToken.endIndex;
          continue;
        }
      }

      const token = parseMacroToken(input, index, true);
      if (!token) {
        result += input[index];
        index += 1;
        continue;
      }

      result += resolveToken(token.key, token.token, stack, depth);
      index = token.endIndex;
    }

    return result;
  };

  // life_cycle is a prefix contract: expand its managed body, but keep the
  // caller-owned suffix opaque. This prevents nested project macros such as
  // @@no_code from being reinterpreted or duplicated.
  const leading = parseMacroToken(prompt, 0, true);
  const resolvedPrompt = leading?.key === 'life_cycle'
    ? resolveToken(leading.key, leading.token, [], 0) + prompt.slice(leading.endIndex)
    : resolveText(prompt, [], 0);
  return { resolvedPrompt, warnings };
}

interface ParsedToken {
  readonly key: string;
  readonly token: string;
  readonly endIndex: number;
}

function parseMacroToken(input: string, startIndex: number, requireLeadingBoundary: boolean): ParsedToken | null {
  if (input.slice(startIndex, startIndex + 2) !== MACRO_TOKEN_PREFIX) {
    return null;
  }

  if (requireLeadingBoundary && startIndex > 0 && !isWhitespace(input[startIndex - 1] ?? '')) {
    return null;
  }

  const keyStart = startIndex + 2;
  let keyEnd = keyStart;

  while (keyEnd < input.length && KEY_CHAR_REGEX.test(input[keyEnd] ?? '')) {
    keyEnd += 1;
  }

  if (keyEnd === keyStart) {
    return null;
  }

  const next = input[keyEnd];
  if (next !== undefined && !isWhitespace(next)) {
    return null;
  }

  const key = input.slice(keyStart, keyEnd);
  return {
    key,
    token: `@@${key}`,
    endIndex: keyEnd,
  };
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}
