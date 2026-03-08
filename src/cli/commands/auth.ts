import { Command } from 'commander';
import chalk from 'chalk';
import {
  DEFAULT_CODEX_AUTH_PATH,
  DEFAULT_PI_AUTH_PATH,
  importCodexAuth,
} from '../../utils/codex-auth-mapper.js';

function formatExpiry(expiresMs: number): string {
  if (!Number.isFinite(expiresMs) || expiresMs <= 0) {
    return 'unknown';
  }
  return new Date(expiresMs).toISOString();
}

export function createAuthCommand(): Command {
  const authCmd = new Command('auth')
    .description('Manage provider auth credentials for Pi-compatible backends')
    .addHelpText(
      'after',
      `
Examples:
  $ juno-code auth import-codex
  $ juno-code auth import-codex --input ~/.codex/auth.json --output ~/.pi/agent/auth.json
  $ juno-code auth import-codex --provider openai-codex
      `,
    );

  authCmd
    .command('import-codex')
    .description('Translate ~/.codex/auth.json into Pi auth.json format (type=oauth)')
    .option('--input <path>', `Input Codex auth file path (default: ${DEFAULT_CODEX_AUTH_PATH})`)
    .option('--output <path>', `Output Pi auth file path (default: ${DEFAULT_PI_AUTH_PATH})`)
    .option('--provider <id>', 'Provider id to write in Pi auth.json (default: openai-codex)')
    .action(async (options) => {
      try {
        const result = await importCodexAuth({
          inputPath: options.input,
          outputPath: options.output,
          provider: options.provider,
        });

        console.log(chalk.green('✓ Codex auth imported successfully'));
        console.log(chalk.dim(`  Provider: ${result.provider}`));
        console.log(chalk.dim(`  Output: ${result.outputPath}`));
        console.log(chalk.dim(`  Expires: ${formatExpiry(result.expires)}`));
        if (result.replacedExisting) {
          console.log(chalk.yellow('  Existing provider credentials were replaced.'));
        }
      } catch (error) {
        console.error(chalk.red('✗ Failed to import Codex auth:'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  return authCmd;
}
