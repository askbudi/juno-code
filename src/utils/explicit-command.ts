import type { Command, Option } from 'commander';

export type ExplicitInvocation =
  | { kind: 'prompt' | 'supported-command' }
  | { kind: 'unknown-option' | 'unknown-command'; token: string };

const PROMPT_BOUNDARY_OPTIONS = new Set(['-p', '--prompt', '-f', '--prompt-file']);

function optionForToken(options: readonly Option[], token: string): Option | undefined {
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  return options.find((option) => option.short === name || option.long === name);
}

function matchingCommand(parent: Command, token: string): Command | undefined {
  return parent.commands.find(
    (command) => command.name() === token || command.aliases().includes(token),
  );
}

function allowsUnknownOptions(command: Command): boolean {
  return Boolean((command as Command & { _allowUnknownOption?: boolean })._allowUnknownOption);
}

function validateKnownCommand(
  argv: readonly string[],
  start: number,
  command: Command,
  root: Command,
): ExplicitInvocation {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || token === '--') return { kind: 'supported-command' };

    if (token.startsWith('-')) {
      const option = optionForToken([...command.options, ...root.options], token);
      if (!option) {
        return allowsUnknownOptions(command)
          ? { kind: 'supported-command' }
          : { kind: 'unknown-option', token };
      }
      if (!token.includes('=') && option.required) index += 1;
      continue;
    }

    const child = matchingCommand(command, token);
    if (child) return validateKnownCommand(argv, index + 1, child, root);

    // Commands with positional arguments intentionally own free-form text. In
    // particular, backend aliases such as `pi` also have one nested maintenance
    // command but otherwise treat their positionals as prompts.
    if (command.registeredArguments.length > 0) return { kind: 'supported-command' };
    return { kind: 'unknown-command', token };
  }
  return { kind: 'supported-command' };
}

/**
 * Distinguish objective command input from the root free-form prompt interface.
 * Top-level and nested command names come from the configured Commander tree,
 * so adding/removing commands cannot desynchronise this guard. An unknown first
 * positional token is always ambiguous and remains a prompt; only a known
 * namespace or an unknown leading option supplies evidence of command intent.
 */
export function classifyExplicitInvocation(
  argv: readonly string[],
  program: Command,
): ExplicitInvocation {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--') return { kind: 'prompt' };

    if (token.startsWith('-')) {
      const option = optionForToken(program.options, token);
      if (!option) return { kind: 'unknown-option', token };
      const optionName = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (PROMPT_BOUNDARY_OPTIONS.has(optionName)) return { kind: 'prompt' };
      if (!token.includes('=') && option.required) index += 1;
      else if (
        !token.includes('=') &&
        option.optional &&
        argv[index + 1] &&
        !argv[index + 1]!.startsWith('-') &&
        /^(?:0|1|2|true|false|yes|no)$/i.test(argv[index + 1]!)
      ) index += 1;
      continue;
    }

    const command = matchingCommand(program, token);
    if (!command) return { kind: 'prompt' };
    return validateKnownCommand(argv, index + 1, command, program);
  }

  return { kind: 'prompt' };
}

export function formatExplicitInvocationError(
  classification: Extract<ExplicitInvocation, { token: string }>,
  executable: string,
  version: string,
): string {
  const subject = classification.kind === 'unknown-option'
    ? `unknown explicit option '${classification.token}'`
    : `unknown explicit command '${classification.token}'`;
  return [
    `juno-code: ${subject}; refusing to reinterpret it as an agent prompt`,
    `effective executable: ${executable}`,
    `effective version: ${version}`,
    'Use -- <prompt>, -p <prompt>, or -f <path> for intentional prompt input.',
  ].join('\n');
}
