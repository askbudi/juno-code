import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { buildChildProcessEnvironment } from './child-process-environment.js';

export type PromptCommandSubstitutionSyntax = 'single-quoted' | 'triple-backtick';

export interface PromptCommandSubstitutionMatch {
  readonly syntax: PromptCommandSubstitutionSyntax;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly command: string;
  readonly raw: string;
}

export interface PromptCommandSubstitutionOptions {
  readonly workingDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly maxBufferBytes?: number;
  readonly commandTimeoutMs?: number;
  readonly executor?: PromptCommandExecutor;
}

export type PromptCommandExecutor = (command: string) => Promise<string>;

const SINGLE_QUOTED_MARKER = "!'";
const TRIPLE_BACKTICK_MARKER = '!```';
const TRIPLE_BACKTICK_CLOSER = '```';
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_ENV_KEY = 'JUNO_CODE_PROMPT_SUBSTITUTION_TIMEOUT_MS';

export function findPromptCommandSubstitutions(prompt: string): PromptCommandSubstitutionMatch[] {
  const matches: PromptCommandSubstitutionMatch[] = [];
  let cursor = 0;

  while (cursor < prompt.length) {
    const singleQuotedStart = prompt.indexOf(SINGLE_QUOTED_MARKER, cursor);
    const tripleBacktickStart = prompt.indexOf(TRIPLE_BACKTICK_MARKER, cursor);

    const markerStart = chooseNearestMarker(singleQuotedStart, tripleBacktickStart);
    if (markerStart === null) {
      break;
    }

    if (markerStart === singleQuotedStart) {
      const parsedSingleQuoted = parseSingleQuotedSubstitution(prompt, markerStart);
      if (!parsedSingleQuoted) {
        cursor = markerStart + SINGLE_QUOTED_MARKER.length;
        continue;
      }

      matches.push(parsedSingleQuoted);
      cursor = parsedSingleQuoted.endIndex;
      continue;
    }

    const parsedTripleBacktick = parseTripleBacktickSubstitution(prompt, markerStart);
    if (!parsedTripleBacktick) {
      cursor = markerStart + TRIPLE_BACKTICK_MARKER.length;
      continue;
    }

    matches.push(parsedTripleBacktick);
    cursor = parsedTripleBacktick.endIndex;
  }

  return matches;
}

export async function resolvePromptCommandSubstitutions(
  prompt: string,
  options: PromptCommandSubstitutionOptions,
): Promise<string> {
  const matches = findPromptCommandSubstitutions(prompt);
  if (matches.length === 0) {
    return prompt;
  }

  const executor = options.executor ?? createDefaultPromptCommandExecutor(options);

  let result = '';
  let cursor = 0;

  for (const match of matches) {
    result += prompt.slice(cursor, match.startIndex);

    const commandOutput = await executor(match.command);
    result += normalizeCommandOutput(commandOutput);

    cursor = match.endIndex;
  }

  result += prompt.slice(cursor);
  return result;
}

function chooseNearestMarker(singleQuotedStart: number, tripleBacktickStart: number): number | null {
  const singleExists = singleQuotedStart >= 0;
  const tripleExists = tripleBacktickStart >= 0;

  if (!singleExists && !tripleExists) {
    return null;
  }

  if (!singleExists) {
    return tripleBacktickStart;
  }

  if (!tripleExists) {
    return singleQuotedStart;
  }

  return Math.min(singleQuotedStart, tripleBacktickStart);
}

function parseSingleQuotedSubstitution(
  prompt: string,
  markerStart: number,
): PromptCommandSubstitutionMatch | null {
  const contentStart = markerStart + SINGLE_QUOTED_MARKER.length;
  const closingQuote = findClosingSingleQuote(prompt, contentStart);
  if (closingQuote < 0) {
    return null;
  }

  const raw = prompt.slice(markerStart, closingQuote + 1);
  const command = prompt.slice(contentStart, closingQuote);

  return {
    syntax: 'single-quoted',
    startIndex: markerStart,
    endIndex: closingQuote + 1,
    command,
    raw,
  };
}

function findClosingSingleQuote(prompt: string, startIndex: number): number {
  let escaped = false;

  for (let index = startIndex; index < prompt.length; index++) {
    const char = prompt[index];

    if (char === "'" && !escaped) {
      return index;
    }

    if (char === '\\' && !escaped) {
      escaped = true;
      continue;
    }

    escaped = false;
  }

  return -1;
}

function parseTripleBacktickSubstitution(
  prompt: string,
  markerStart: number,
): PromptCommandSubstitutionMatch | null {
  const contentStart = markerStart + TRIPLE_BACKTICK_MARKER.length;
  const closingBackticks = prompt.indexOf(TRIPLE_BACKTICK_CLOSER, contentStart);
  if (closingBackticks < 0) {
    return null;
  }

  const raw = prompt.slice(markerStart, closingBackticks + TRIPLE_BACKTICK_CLOSER.length);
  const command = prompt.slice(contentStart, closingBackticks);

  return {
    syntax: 'triple-backtick',
    startIndex: markerStart,
    endIndex: closingBackticks + TRIPLE_BACKTICK_CLOSER.length,
    command,
    raw,
  };
}

function createDefaultPromptCommandExecutor(
  options: PromptCommandSubstitutionOptions,
): PromptCommandExecutor {
  const execFile = promisify(childProcess.execFile);
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const commandTimeoutMs = resolvePromptCommandTimeoutMs(options.commandTimeoutMs);
  const shell = process.env.SHELL || '/bin/bash';

  return async (command: string): Promise<string> => {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) {
      return '';
    }

    const commandForExecution = wrapCommandForNonInteractiveExecution(normalizedCommand);

    try {
      const result = await execFile(shell, ['-lc', commandForExecution], {
        cwd: options.workingDirectory,
        env: buildChildProcessEnvironment(options.environment ?? process.env),
        maxBuffer: maxBufferBytes,
        timeout: commandTimeoutMs,
      });

      const stdout =
        typeof result === 'string' || Buffer.isBuffer(result)
          ? String(result)
          : String((result as { stdout?: unknown }).stdout ?? '');

      return stdout;
    } catch (error) {
      const failedCommand = normalizedCommand.replace(/\s+/g, ' ').trim();
      const details =
        error && typeof error === 'object' && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '').trim()
          : '';

      const timeoutDetected =
        error &&
        typeof error === 'object' &&
        (('code' in error
          ? String((error as { code?: unknown }).code ?? '').toUpperCase() === 'ETIMEDOUT'
          : false) ||
          ('killed' in error && Boolean((error as { killed?: unknown }).killed) &&
            String((error as { signal?: unknown }).signal ?? '').toUpperCase() === 'SIGTERM') ||
          ('message' in error &&
            /timed?\s*out/i.test(String((error as { message?: unknown }).message ?? ''))));

      if (timeoutDetected) {
        throw new Error(
          `Prompt command substitution timed out after ${commandTimeoutMs}ms for \`${failedCommand}\``,
        );
      }

      const suffix = details ? `: ${details}` : '';
      throw new Error(`Prompt command substitution failed for \`${failedCommand}\`${suffix}`);
    }
  };
}

function resolvePromptCommandTimeoutMs(explicitTimeoutMs: number | undefined): number {
  if (typeof explicitTimeoutMs === 'number' && Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }

  const envValue = process.env[COMMAND_TIMEOUT_ENV_KEY];
  if (envValue !== undefined) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_COMMAND_TIMEOUT_MS;
}

function wrapCommandForNonInteractiveExecution(command: string): string {
  return `(${command}) </dev/null`;
}

function normalizeCommandOutput(output: string): string {
  return output.replace(/\r?\n$/, '');
}
