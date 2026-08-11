/**
 * Juno Skill Preprocessor — Pi Extension
 *
 * Adds variable substitution ($1, $2, $ARGUMENTS, $@, ${@:N}, ${@:N:L})
 * and opted-in shell directive execution (!`command`) to Pi skill invocations.
 * Placeholder-consumed arguments are not appended; every other argument is
 * appended with Pi's native `skillBlock + "\n\n" + rawArgs` semantics.
 */
import type { ExtensionAPI, InputEvent } from '@mariozechner/pi-coding-agent';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

const SHELL_DIRECTIVE_REGEX = /!`([^`]+)`/g;
const ARG_PLACEHOLDER_REGEX = /\$\{@:(\d+)(?::(\d+))?\}|\$ARGUMENTS|\$@|\$(\d+)/g;
const DEFAULT_SHELL_TIMEOUT = 5000;
const SKILL_DIRS = ['.pi/skills', '.claude/skills'];

interface CommandArgument {
  value: string;
  start: number;
  end: number;
}

function findSkillFile(skillName: string, cwd: string): string | null {
  for (const dir of SKILL_DIRS) {
    const candidates = [join(cwd, dir, skillName, 'SKILL.md'), join(cwd, dir, `${skillName}.md`)];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | boolean>;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string | boolean> = {};
  for (const rawLine of match[1]!.split('\n')) {
    const colonIndex = rawLine.indexOf(':');
    if (colonIndex === -1) continue;
    const key = rawLine.slice(0, colonIndex).trim();
    const value = rawLine.slice(colonIndex + 1).trim();
    frontmatter[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return { frontmatter, body: match[2] ?? '' };
}

/** Parse shell-like arguments without executing or otherwise interpreting them. */
function parseCommandArgumentDetails(input: string): CommandArgument[] {
  const args: CommandArgument[] = [];
  let current = '';
  let start = -1;
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  let started = false;

  const finish = (end: number) => {
    if (started) args.push({ value: current, start, end });
    current = '';
    start = -1;
    started = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (!started && !/\s/.test(char)) {
      started = true;
      start = index;
    }
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (/\s/.test(char) && !inSingle && !inDouble) {
      finish(index);
      continue;
    }
    current += char;
  }
  if (escape) current += '\\';
  finish(input.length);
  return args;
}

function parseCommandArgs(input: string): string[] {
  return parseCommandArgumentDetails(input).map(({ value }) => value);
}

/**
 * Substitute placeholders once and report argument indexes intentionally consumed.
 * $ARGUMENTS/$@ use the original raw request, including quoting/newlines/spacing.
 * Positional and slice placeholders retain their established decoded values.
 */
function substituteArgsWithConsumption(
  content: string,
  args: string[],
  rawArguments: string,
  encode: (value: string, offset: number) => string = (value) => value,
): { text: string; consumed: Set<number>; consumesAll: boolean } {
  const consumed = new Set<number>();
  let consumesAll = false;
  const text = content.replace(
    ARG_PLACEHOLDER_REGEX,
    (placeholder, startText, lengthText, positionText, offset: number) => {
      if (placeholder === '$ARGUMENTS' || placeholder === '$@') {
        consumesAll = true;
        args.forEach((_, index) => consumed.add(index));
        return encode(rawArguments, offset);
      }
      if (positionText !== undefined) {
        const index = Number.parseInt(positionText, 10) - 1;
        if (index >= 0 && index < args.length) consumed.add(index);
        return encode(args[index] ?? '', offset);
      }
      const start = Math.max(0, Number.parseInt(startText, 10) - 1);
      const length =
        lengthText === undefined ? args.length - start : Number.parseInt(lengthText, 10);
      const selected = args.slice(start, start + length);
      selected.forEach((_, selectedOffset) => consumed.add(start + selectedOffset));
      return encode(selected.join(' '), offset);
    },
  );
  return { text, consumed, consumesAll };
}

function substituteArgs(
  content: string,
  args: string[],
  rawArguments: string = args.join(' '),
): string {
  return substituteArgsWithConsumption(content, args, rawArguments).text;
}

/** Keep each unconsumed token byte-for-byte; preserve separators within contiguous runs. */
function unconsumedRawArguments(
  rawArguments: string,
  details: CommandArgument[],
  consumed: Set<number>,
  consumesAll = false,
): string {
  if (consumesAll) return '';
  if (consumed.size === 0) return rawArguments;
  if (details.length === 0 || consumed.size >= details.length) return '';
  const runs: string[] = [];
  for (let index = 0; index < details.length; ) {
    if (consumed.has(index)) {
      index += 1;
      continue;
    }
    const start = details[index]!.start;
    let end = details[index]!.end;
    index += 1;
    while (index < details.length && !consumed.has(index)) {
      end = details[index]!.end;
      index += 1;
    }
    runs.push(rawArguments.slice(start, end));
  }
  return runs.join(' ');
}

function executeShellDirective(
  command: string,
  cwd: string,
  timeout: number,
  environment: Record<string, string> = {},
): string {
  try {
    return execSync(command, {
      cwd,
      timeout,
      encoding: 'utf-8',
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return `[Error executing: ${command}]`;
  }
}

function processShellDirectives(
  content: string,
  cwd: string,
  timeout: number = DEFAULT_SHELL_TIMEOUT,
): string {
  return content.replace(SHELL_DIRECTIVE_REGEX, (_, command: string) =>
    executeShellDirective(command, cwd, timeout),
  );
}

/** Heredoc bodies expand parameters without reparsing their values as shell source. */
function isInHeredocBody(command: string, offset: number): boolean {
  const lines = command.split('\n');
  const queued: Array<{ delimiter: string; stripTabs: boolean; expands: boolean }> = [];
  let active: (typeof queued)[number] | undefined;
  let lineStart = 0;

  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    if (active) {
      const comparison = active.stripTabs ? line.replace(/^\t+/, '') : line;
      if (comparison === active.delimiter) {
        active = queued.shift();
      } else {
        if (offset >= lineStart && offset <= lineEnd) return active.expands;
        lineStart = lineEnd + 1;
        continue;
      }
    }

    const declaration = /<<(-)?\s*(?:'([^']+)'|"([^"]+)"|\\?([^\s;|&<>]+))/g;
    for (const match of line.matchAll(declaration)) {
      queued.push({
        delimiter: match[2] ?? match[3] ?? match[4] ?? '',
        stripTabs: match[1] === '-',
        expands: match[2] === undefined && match[3] === undefined,
      });
    }
    if (!active) active = queued.shift();
    lineStart = lineEnd + 1;
  }
  return false;
}

/**
 * Return a shell parameter reference suitable for the authored context. Argument
 * bytes live only in the child environment and are never inserted into shell source.
 */
function referenceShellPlaceholder(command: string, offset: number, variableName: string): string {
  if (isInHeredocBody(command, offset)) return `\${${variableName}}`;

  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const char of command.slice(0, offset)) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
  }
  if (inSingle) return `'"\${${variableName}}"'`;
  if (inDouble) return `\${${variableName}}`;
  return `"\${${variableName}}"`;
}

/**
 * Substitute every body segment once, but execute only directives present in the
 * authored skill body. Values inserted by arguments can therefore never create
 * a new directive. Placeholder consumption is merged across ordinary/directive spans.
 */
function processSkillBody(
  body: string,
  args: string[],
  rawArguments: string,
  shellEnabled: boolean,
  cwd: string,
): { text: string; consumed: Set<number>; consumesAll: boolean } {
  if (!shellEnabled) return substituteArgsWithConsumption(body, args, rawArguments);

  const consumed = new Set<number>();
  let consumesAll = false;
  let cursor = 0;
  let text = '';
  const merge = (substitution: { consumed: Set<number>; consumesAll: boolean }) => {
    substitution.consumed.forEach((index) => consumed.add(index));
    consumesAll ||= substitution.consumesAll;
  };

  for (const match of body.matchAll(new RegExp(SHELL_DIRECTIVE_REGEX.source, 'g'))) {
    const index = match.index ?? 0;
    const ordinary = substituteArgsWithConsumption(body.slice(cursor, index), args, rawArguments);
    merge(ordinary);
    text += ordinary.text;

    const authoredCommand = match[1] ?? '';
    const environment: Record<string, string> = {};
    let variableIndex = 0;
    const command = substituteArgsWithConsumption(
      authoredCommand,
      args,
      rawArguments,
      (value, offset) => {
        const variableName = `JUNO_SKILL_ARGUMENT_${variableIndex}`;
        variableIndex += 1;
        environment[variableName] = value;
        return referenceShellPlaceholder(authoredCommand, offset, variableName);
      },
    );
    merge(command);
    text += executeShellDirective(command.text, cwd, DEFAULT_SHELL_TIMEOUT, environment);
    cursor = index + match[0].length;
  }

  const trailing = substituteArgsWithConsumption(body.slice(cursor), args, rawArguments);
  merge(trailing);
  text += trailing.text;
  return { text, consumed, consumesAll };
}

/** Expand one registered skill invocation, or return null so Pi can handle it natively. */
function expandSkillInvocation(text: string, cwd: string): string | null {
  const command = text.match(/^\/skill:([^\s]+)([\s\S]*)$/);
  if (!command) return null;
  const skillName = command[1]!;
  const suffix = command[2] ?? '';
  // Remove only the command/argument delimiter. Everything after it is user payload.
  const rawArguments = /^\s/.test(suffix) ? suffix.slice(1) : suffix;
  const details = parseCommandArgumentDetails(rawArguments);
  const args = details.map(({ value }) => value);
  const skillPath = findSkillFile(skillName, cwd);
  if (!skillPath) return null;

  try {
    const { frontmatter, body } = parseFrontmatter(readFileSync(skillPath, 'utf-8'));
    const substitution = processSkillBody(
      body.trim(),
      args,
      rawArguments,
      frontmatter['enable-shell-directives'] === true,
      cwd,
    );
    const processedBody = substitution.text;
    const baseDir = dirname(skillPath);
    const skillBlock = [
      `<skill name="${skillName}" location="${skillPath}">`,
      `References are relative to ${baseDir}.`,
      '',
      processedBody,
      '</skill>',
    ].join('\n');
    const remaining = unconsumedRawArguments(
      rawArguments,
      details,
      substitution.consumed,
      substitution.consumesAll,
    );
    return remaining ? `${skillBlock}\n\n${remaining}` : skillBlock;
  } catch {
    return null;
  }
}

export default function junoSkillPreprocessor(pi: ExtensionAPI) {
  pi.on('input', (event: InputEvent) => {
    const expanded = expandSkillInvocation(
      typeof event.text === 'string' ? event.text : '',
      process.cwd(),
    );
    return expanded === null ? { action: 'continue' } : { action: 'transform', text: expanded };
  });
}

export {
  expandSkillInvocation,
  findSkillFile,
  parseCommandArgs,
  parseFrontmatter,
  processShellDirectives,
  substituteArgs,
  substituteArgsWithConsumption,
  unconsumedRawArguments,
};
