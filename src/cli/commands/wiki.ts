import fs from 'fs-extra';
import path from 'node:path';
import { Command } from 'commander';
import { routeControlPlane } from '../../utils/control-plane-router.js';

const HIDDEN_OR_RUNTIME = new Set(['.git', 'node_modules', '__pycache__', 'runtime', 'cache']);

type WikiEntry = { name: string; directory: boolean; children: WikiEntry[] };

async function readWikiDirectory(current: string): Promise<WikiEntry[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !entry.name.startsWith('.') && !HIDDEN_OR_RUNTIME.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const result: WikiEntry[] = [];
  for (const entry of visible) {
    const absolute = path.join(current, entry.name);
    const metadata = await fs.lstat(absolute);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) {
      result.push({ name: entry.name, directory: true, children: await readWikiDirectory(absolute) });
    } else if (metadata.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      result.push({ name: entry.name, directory: false, children: [] });
    }
  }
  return result;
}

function renderEntries(entries: WikiEntry[], prefix = ''): string[] {
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1;
    lines.push(`${prefix}${last ? '`-- ' : '|-- '}${entry.name}${entry.directory ? '/' : ''}`);
    if (entry.directory) {
      lines.push(...renderEntries(entry.children, `${prefix}${last ? '    ' : '|   '}`));
    }
  });
  return lines;
}

export async function wikiOutput(workingDirectory: string, pathOnly = false): Promise<string> {
  const route = routeControlPlane(workingDirectory, 'diagnostic');
  const root = path.resolve(route.controllerRoot, '.juno_task', 'wiki');
  const metadata = await fs.stat(root).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new Error(
      `Canonical controller wiki is missing or is not a directory: ${root}. ` +
      'Run the reviewed controller-wiki migration, then retry `yy wiki`.',
    );
  }
  if (pathOnly) return `${root}\n`;
  const entries = await readWikiDirectory(root);
  return `Wiki root: ${root}\n\n.\n${renderEntries(entries).join('\n')}${entries.length ? '\n' : ''}`;
}

export function configureWikiCommand(program: Command): void {
  program.command('wiki')
    .description('Show the canonical controller wiki root and sorted ASCII inventory')
    .option('--path', 'Print only the absolute wiki path')
    .action(async (options: { path?: boolean }) => {
      process.stdout.write(await wikiOutput(process.cwd(), Boolean(options.path)));
    });
}
