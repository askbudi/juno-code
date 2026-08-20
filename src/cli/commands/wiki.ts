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

async function canonicalWikiRoot(workingDirectory: string): Promise<string> {
  const route = routeControlPlane(workingDirectory, 'diagnostic');
  const root = path.resolve(route.controllerRoot, '.juno_task', 'wiki');
  const metadata = await fs.stat(root).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new Error(
      `Canonical controller wiki is missing or is not a directory: ${root}. ` +
      'Run the reviewed controller-wiki migration, then retry `yy wiki`.',
    );
  }
  return root;
}

/** Resolve one wiki page inside the canonical root; Markdown files only. */
export async function wikiShowOutput(workingDirectory: string, page: string): Promise<string> {
  const root = await canonicalWikiRoot(workingDirectory);
  const segments = page.split('/');
  if (page.length === 0 || path.isAbsolute(page) || page.includes('\0')
      || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(
      `Wiki page reference must be a relative path inside the controller wiki: ${page}`,
    );
  }
  const normalized = segments[segments.length - 1]!.toLowerCase().endsWith('.md') ? segments : [...segments.slice(0, -1), `${segments[segments.length - 1]}.md`];
  const absolute = path.resolve(root, ...normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Wiki page reference escapes the controller wiki root: ${page}`);
  }
  // Refuse symlinks at every path component, mirroring the inventory rule;
  // lstat alone cannot see an intermediate directory symlink.
  let cumulative = root;
  for (const segment of normalized) {
    cumulative = path.join(cumulative, segment);
    const step = await fs.lstat(cumulative).catch(() => null);
    if (step === null) {
      const raw = await fs.lstat(path.resolve(root, ...segments)).catch(() => null);
      if (raw?.isFile()) {
        throw new Error(`Wiki page is not a regular Markdown file: ${page}`);
      }
      throw new Error(
        `Wiki page not found: ${page}. List available pages with \`yy wiki\` (root: ${root}).`,
      );
    }
    if (step.isSymbolicLink()) {
      throw new Error(`Wiki page traverses a symbolic link: ${page}`);
    }
    if (segment !== normalized[normalized.length - 1] && !step.isDirectory()) {
      throw new Error(`Wiki page traverses a non-directory: ${page}`);
    }
  }
  const metadata = await fs.lstat(absolute).catch(() => null);
  if (metadata === null) {
    throw new Error(
      `Wiki page not found: ${page}. List available pages with \`yy wiki\` (root: ${root}).`,
    );
  }
  if (!metadata.isFile()) {
    throw new Error(`Wiki page is not a regular Markdown file: ${page}`);
  }
  return fs.readFile(absolute, 'utf8');
}

export async function wikiOutput(workingDirectory: string, pathOnly = false): Promise<string> {
  const root = await canonicalWikiRoot(workingDirectory);
  if (pathOnly) return `${root}\n`;
  const entries = await readWikiDirectory(root);
  return `Wiki root: ${root}\n\n.\n${renderEntries(entries).join('\n')}${entries.length ? '\n' : ''}`;
}

export function configureWikiCommand(program: Command): void {
  const wiki = program.command('wiki')
    .description('Show the canonical controller wiki root and sorted ASCII inventory')
    .option('--path', 'Print only the absolute wiki path')
    .action(async (options: { path?: boolean }) => {
      process.stdout.write(await wikiOutput(process.cwd(), Boolean(options.path)));
    });
  wiki.command('show <page>')
    .description('Print one canonical controller wiki page (relative path; .md optional)')
    .action(async (page: string) => {
      process.stdout.write(await wikiShowOutput(process.cwd(), page));
    });
}
