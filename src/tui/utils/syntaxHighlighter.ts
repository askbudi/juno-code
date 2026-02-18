/**
 * Advanced Syntax Highlighter for Prompt Editor
 *
 * Provides comprehensive syntax highlighting including template variables,
 * code blocks, URLs, and other prompt elements as specified in the
 * Prompt Editor Module specification.
 */

import type { SyntaxToken } from '../types.js';
import { parseTemplateTokens } from './templateVariables.js';

/**
 * Syntax highlighting patterns
 */
const SYNTAX_PATTERNS = {
  // Code blocks (triple backticks or single backticks)
  codeBlock: /```[\s\S]*?```|`[^`]+`/g,
  // URLs (http/https)
  url: /(https?:\/\/[^\s]+)/g,
  // File paths (Unix and Windows)
  filePath: /(?:\/[^\s/]+)+\/[^\s]*|[A-Za-z]:[^\s]*/g,
  // Email addresses
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  // Numbers
  number: /\b\d+(?:\.\d+)?\b/g,
  // Keywords for prompt structure
  keywords: /\b(task|objective|goal|context|background|example|constraint|requirement|format|output|input|note|important|warning)\b/gi,
  // Emphasis (markdown-style)
  bold: /\*\*([^*]+)\*\*/g,
  italic: /\*([^*]+)\*/g,
  // Lists
  list: /^\s*[-*+]\s/gm,
  // Headers
  header: /^#+\s.*/gm,
  // Comments (# or //)
  comment: /(?:^|\s)(#[^#].*$|\/\/.*$)/gm
} as const;

/**
 * Color scheme for different token types
 */
export const SYNTAX_COLORS = {
  variable: '#10b981', // green for valid variables
  variableInvalid: '#ef4444', // red for invalid variables
  keyword: '#3b82f6', // blue for keywords
  string: '#f59e0b', // amber for strings
  comment: '#6b7280', // gray for comments
  url: '#8b5cf6', // purple for URLs
  path: '#f97316', // orange for paths
  code: '#059669', // emerald for code
  email: '#06b6d4', // cyan for emails
  number: '#dc2626', // red for numbers
  bold: '#111827', // dark for bold text (weight handled separately)
  italic: '#374151', // gray for italic
  header: '#1f2937', // dark gray for headers
  list: '#4b5563', // medium gray for lists
  plain: '#111827' // default text color
} as const;

/**
 * Parse text and return all syntax tokens for highlighting
 */
export function parseAllTokens(
  text: string,
  knownVariables: Record<string, any> = {}
): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const processedRanges: Array<{ start: number; end: number }> = [];

  // Helper function to check if a range overlaps with already processed ranges
  const hasOverlap = (start: number, end: number): boolean => {
    return processedRanges.some(range =>
      (start >= range.start && start < range.end) ||
      (end > range.start && end <= range.end) ||
      (start <= range.start && end >= range.end)
    );
  };

  // Helper function to add a token if it doesn't overlap
  const addToken = (match: RegExpMatchArray, type: SyntaxToken['type'], isValid?: boolean) => {
    const start = match.index || 0;
    const end = start + match[0].length;

    if (!hasOverlap(start, end)) {
      tokens.push({
        text: match[0],
        type,
        start,
        end,
        isValid
      });
      processedRanges.push({ start, end });
    }
  };

  // Process template variables first (highest priority)
  const variableTokens = parseTemplateTokens(text, knownVariables);
  variableTokens.forEach(token => {
    if (token.type === 'variable') {
      tokens.push(token);
      processedRanges.push({ start: token.start, end: token.end });
    }
  });

  // Process code blocks (high priority to avoid conflicts)
  for (const match of text.matchAll(SYNTAX_PATTERNS.codeBlock)) {
    addToken(match, 'code');
  }

  // Process URLs
  for (const match of text.matchAll(SYNTAX_PATTERNS.url)) {
    addToken(match, 'url');
  }

  // Process file paths
  for (const match of text.matchAll(SYNTAX_PATTERNS.filePath)) {
    addToken(match, 'path');
  }

  // Process email addresses
  for (const match of text.matchAll(SYNTAX_PATTERNS.email)) {
    addToken(match, 'string'); // Use string type for emails
  }

  // Process keywords
  for (const match of text.matchAll(SYNTAX_PATTERNS.keywords)) {
    addToken(match, 'keyword');
  }

  // Process numbers
  for (const match of text.matchAll(SYNTAX_PATTERNS.number)) {
    addToken(match, 'string'); // Use string type for numbers in prompts
  }

  // Process comments
  for (const match of text.matchAll(SYNTAX_PATTERNS.comment)) {
    addToken(match, 'comment');
  }

  // Sort tokens by start position
  tokens.sort((a, b) => a.start - b.start);

  return tokens;
}

/**
 * Apply syntax highlighting to a line of text
 */
export function highlightLine(
  line: string,
  lineOffset: number = 0,
  knownVariables: Record<string, any> = {}
): string {
  const tokens = parseAllTokens(line, knownVariables);

  if (tokens.length === 0) {
    return line; // No highlighting needed
  }

  let result = '';
  let lastEnd = 0;

  for (const token of tokens) {
    // Add unhighlighted text before this token
    if (token.start > lastEnd) {
      result += line.slice(lastEnd, token.start);
    }

    // Add highlighted token
    result += applyTokenStyle(token);

    lastEnd = token.end;
  }

  // Add remaining unhighlighted text
  if (lastEnd < line.length) {
    result += line.slice(lastEnd);
  }

  return result;
}

/**
 * Apply ANSI color codes to a token
 */
function applyTokenStyle(token: SyntaxToken): string {
  let color: string;

  switch (token.type) {
    case 'variable':
      color = token.isValid ? SYNTAX_COLORS.variable : SYNTAX_COLORS.variableInvalid;
      break;
    case 'keyword':
      color = SYNTAX_COLORS.keyword;
      break;
    case 'string':
      color = SYNTAX_COLORS.string;
      break;
    case 'comment':
      color = SYNTAX_COLORS.comment;
      break;
    case 'url':
      color = SYNTAX_COLORS.url;
      break;
    case 'path':
      color = SYNTAX_COLORS.path;
      break;
    case 'code':
      color = SYNTAX_COLORS.code;
      break;
    default:
      color = SYNTAX_COLORS.plain;
  }

  // Convert hex color to ANSI escape code (approximation)
  const ansiColor = hexToAnsi(color);
  return `\x1b[${ansiColor}m${token.text}\x1b[39m`;
}

/**
 * Convert hex color to approximate ANSI color code
 */
function hexToAnsi(hex: string): string {
  // Simple mapping of common colors to ANSI codes
  const colorMap: Record<string, string> = {
    '#10b981': '32', // green
    '#ef4444': '31', // red
    '#3b82f6': '34', // blue
    '#f59e0b': '33', // yellow
    '#6b7280': '90', // bright black (gray)
    '#8b5cf6': '35', // magenta
    '#f97316': '33', // yellow (orange approximation)
    '#059669': '32', // green
    '#06b6d4': '36', // cyan
    '#dc2626': '31', // red
    '#111827': '37', // white
    '#374151': '90', // bright black
    '#1f2937': '37', // white
    '#4b5563': '90'  // bright black
  };

  return colorMap[hex] || '37'; // default to white
}

/**
 * Get syntax highlighting statistics
 */
export function getHighlightingStats(
  text: string,
  knownVariables: Record<string, any> = {}
): {
  totalTokens: number;
  tokensByType: Record<string, number>;
  variableCount: number;
  invalidVariableCount: number;
} {
  const tokens = parseAllTokens(text, knownVariables);

  const tokensByType: Record<string, number> = {};
  let variableCount = 0;
  let invalidVariableCount = 0;

  for (const token of tokens) {
    tokensByType[token.type] = (tokensByType[token.type] || 0) + 1;

    if (token.type === 'variable') {
      variableCount++;
      if (!token.isValid) {
        invalidVariableCount++;
      }
    }
  }

  return {
    totalTokens: tokens.length,
    tokensByType,
    variableCount,
    invalidVariableCount
  };
}

/**
 * Validate syntax highlighting for potential issues
 */
export function validateSyntax(
  text: string,
  knownVariables: Record<string, any> = {}
): Array<{
  type: 'warning' | 'error';
  message: string;
  line?: number;
  column?: number;
}> {
  const issues: Array<{
    type: 'warning' | 'error';
    message: string;
    line?: number;
    column?: number;
  }> = [];

  const lines = text.split('\n');

  lines.forEach((line, lineIndex) => {
    const tokens = parseAllTokens(line, knownVariables);

    // Check for invalid template variables
    tokens.forEach(token => {
      if (token.type === 'variable' && !token.isValid) {
        issues.push({
          type: 'error',
          message: `Undefined template variable: ${token.text}`,
          line: lineIndex + 1,
          column: token.start + 1
        });
      }
    });

    // Check for potential issues
    if (line.includes('http://')) {
      issues.push({
        type: 'warning',
        message: 'HTTP URL detected - consider using HTTPS for security',
        line: lineIndex + 1
      });
    }

    // Check for very long lines
    if (line.length > 200) {
      issues.push({
        type: 'warning',
        message: 'Very long line detected - consider breaking into multiple lines',
        line: lineIndex + 1
      });
    }
  });

  return issues;
}

/**
 * Generate highlighting legend for help display
 */
export function getHighlightingLegend(): Array<{
  type: string;
  description: string;
  color: string;
  example: string;
}> {
  return [
    {
      type: 'Variable (Valid)',
      description: 'Template variables with known values',
      color: SYNTAX_COLORS.variable,
      example: '{USER_NAME}'
    },
    {
      type: 'Variable (Invalid)',
      description: 'Template variables without defined values',
      color: SYNTAX_COLORS.variableInvalid,
      example: '{UNDEFINED_VAR}'
    },
    {
      type: 'Keyword',
      description: 'Prompt structure keywords',
      color: SYNTAX_COLORS.keyword,
      example: 'task, objective, context'
    },
    {
      type: 'Code',
      description: 'Code blocks and inline code',
      color: SYNTAX_COLORS.code,
      example: '`code` or ```block```'
    },
    {
      type: 'URL',
      description: 'Web addresses',
      color: SYNTAX_COLORS.url,
      example: 'https://example.com'
    },
    {
      type: 'Path',
      description: 'File and directory paths',
      color: SYNTAX_COLORS.path,
      example: '/path/to/file'
    },
    {
      type: 'Comment',
      description: 'Comments and notes',
      color: SYNTAX_COLORS.comment,
      example: '# This is a comment'
    }
  ];
}