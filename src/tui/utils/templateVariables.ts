/**
 * Template Variable Utilities for Prompt Editor
 *
 * Provides template variable parsing, highlighting, and completion functionality
 * as specified in the Prompt Editor Module specification.
 */

import type { TemplateVariable, SyntaxToken } from '../types.js';

/**
 * Template variable patterns for different syntax styles
 */
export const VARIABLE_PATTERNS = {
  /** Standard {VARIABLE_NAME} syntax */
  standard: /\{([A-Z_][A-Z0-9_]*)\}/g,
  /** Conditional {% if condition %} syntax */
  conditional: /\{%\s*(if|unless|for)\s+([^%]+)\s*%\}/g,
  /** Expression {{ expression }} syntax */
  expression: /\{\{([^}]+)\}\}/g,
  /** Environment variable $VAR or ${VAR} syntax */
  environment: /\$\{?([A-Z_][A-Z0-9_]*)\}?/g
} as const;

/**
 * Extract template variables from text
 */
export function extractTemplateVariables(text: string): string[] {
  const variables = new Set<string>();

  // Extract standard variables
  const standardMatches = text.matchAll(VARIABLE_PATTERNS.standard);
  for (const match of standardMatches) {
    variables.add(match[1]);
  }

  // Extract environment variables
  const envMatches = text.matchAll(VARIABLE_PATTERNS.environment);
  for (const match of envMatches) {
    variables.add(match[1]);
  }

  return Array.from(variables);
}

/**
 * Parse text and return syntax tokens for highlighting
 */
export function parseTemplateTokens(
  text: string,
  knownVariables: Record<string, any> = {}
): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let lastIndex = 0;

  // Find all variable matches
  const allMatches: Array<{ match: RegExpMatchArray; type: string }> = [];

  // Standard variables
  for (const match of text.matchAll(VARIABLE_PATTERNS.standard)) {
    allMatches.push({ match, type: 'variable' });
  }

  // Environment variables
  for (const match of text.matchAll(VARIABLE_PATTERNS.environment)) {
    allMatches.push({ match, type: 'variable' });
  }

  // Sort matches by position
  allMatches.sort((a, b) => (a.match.index || 0) - (b.match.index || 0));

  // Process matches and create tokens
  for (const { match, type } of allMatches) {
    const start = match.index || 0;
    const end = start + match[0].length;

    // Add plain text before match
    if (start > lastIndex) {
      tokens.push({
        text: text.slice(lastIndex, start),
        type: 'plain',
        start: lastIndex,
        end: start
      });
    }

    // Add variable token
    const variableName = match[1];
    const isValid = variableName in knownVariables;

    tokens.push({
      text: match[0],
      type: 'variable',
      start,
      end,
      isValid
    });

    lastIndex = end;
  }

  // Add remaining plain text
  if (lastIndex < text.length) {
    tokens.push({
      text: text.slice(lastIndex),
      type: 'plain',
      start: lastIndex,
      end: text.length
    });
  }

  return tokens;
}

/**
 * Substitute template variables in text
 */
export function substituteTemplateVariables(
  text: string,
  variables: Record<string, any>
): string {
  let result = text;

  // Substitute standard variables
  result = result.replace(VARIABLE_PATTERNS.standard, (match, varName) => {
    const value = variables[varName];
    if (value !== undefined) {
      return String(value);
    }
    return match; // Keep original if no value
  });

  // Substitute environment variables
  result = result.replace(VARIABLE_PATTERNS.environment, (match, varName) => {
    const value = variables[varName] || process.env[varName];
    if (value !== undefined) {
      return String(value);
    }
    return match; // Keep original if no value
  });

  return result;
}

/**
 * Get template variable completions for a given position
 */
export function getVariableCompletions(
  text: string,
  cursorPosition: number,
  knownVariables: Record<string, any>
): Array<{ name: string; description?: string; value?: any }> {
  // Find if cursor is inside a variable pattern
  const beforeCursor = text.slice(0, cursorPosition);
  const afterCursor = text.slice(cursorPosition);

  // Check if we're inside a variable
  const openBrace = beforeCursor.lastIndexOf('{');
  const closeBrace = afterCursor.indexOf('}');

  if (openBrace === -1 || closeBrace === -1) {
    return []; // Not inside a variable
  }

  // Extract partial variable name
  const partialVariable = beforeCursor.slice(openBrace + 1);

  // Filter known variables that match the partial name
  return Object.entries(knownVariables)
    .filter(([name]) => name.toUpperCase().startsWith(partialVariable.toUpperCase()))
    .map(([name, value]) => ({
      name,
      value,
      description: `Value: ${String(value)}`
    }));
}

/**
 * Validate template variables in text
 */
export function validateTemplateVariables(
  text: string,
  knownVariables: Record<string, any>
): Array<{ variable: string; line: number; column: number; message: string }> {
  const errors: Array<{ variable: string; line: number; column: number; message: string }> = [];
  const lines = text.split('\n');

  lines.forEach((line, lineIndex) => {
    const matches = line.matchAll(VARIABLE_PATTERNS.standard);
    for (const match of matches) {
      const variableName = match[1];
      if (!(variableName in knownVariables)) {
        errors.push({
          variable: variableName,
          line: lineIndex + 1,
          column: (match.index || 0) + 1,
          message: `Undefined variable: ${variableName}`
        });
      }
    }
  });

  return errors;
}

/**
 * Create template variable definitions from text
 */
export function createVariableDefinitions(
  text: string,
  existingVariables: Record<string, any> = {}
): TemplateVariable[] {
  const extractedVars = extractTemplateVariables(text);
  const definitions: TemplateVariable[] = [];

  extractedVars.forEach(varName => {
    if (!(varName in existingVariables)) {
      definitions.push({
        name: varName,
        type: 'string',
        required: true,
        description: `Auto-detected variable: ${varName}`,
        value: undefined
      });
    } else {
      const value = existingVariables[varName];
      definitions.push({
        name: varName,
        type: typeof value as 'string' | 'number' | 'boolean',
        required: true,
        description: `Existing variable: ${varName}`,
        value
      });
    }
  });

  return definitions;
}

/**
 * Format variable tooltip text
 */
export function formatVariableTooltip(
  variableName: string,
  variable?: TemplateVariable
): string {
  if (!variable) {
    return `Undefined variable: ${variableName}`;
  }

  const parts = [
    `Variable: ${variableName}`,
    `Type: ${variable.type}`,
    variable.required ? 'Required' : 'Optional'
  ];

  if (variable.value !== undefined) {
    parts.push(`Value: ${String(variable.value)}`);
  }

  if (variable.description) {
    parts.push(`Description: ${variable.description}`);
  }

  return parts.join('\n');
}