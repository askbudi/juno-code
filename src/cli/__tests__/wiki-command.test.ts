import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/control-plane-router.js', () => ({
  routeControlPlane: (cwd: string) => ({ controllerRoot: cwd }),
}));

import { wikiOutput } from '../commands/wiki.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-wiki-'));
  roots.push(root);
  await fs.ensureDir(path.join(root, '.juno_task/wiki/controller'));
  return root;
}

describe('wiki command', () => {
  it('prints a deterministic Markdown-only ASCII tree and a script-safe path', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, '.juno_task/wiki/controller/z.md'), 'z');
    await fs.writeFile(path.join(root, '.juno_task/wiki/controller/a.md'), 'a');
    await fs.writeFile(path.join(root, '.juno_task/wiki/controller/ignored.txt'), 'x');
    expect(await wikiOutput(root)).toContain('|-- a.md\n    `-- z.md');
    expect(await wikiOutput(root, true)).toBe(`${path.join(root, '.juno_task/wiki')}\n`);
  });

  it('does not follow wiki symlinks', async () => {
    const root = await fixture();
    const outside = path.join(root, 'outside');
    await fs.ensureDir(outside);
    await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
    await fs.symlink(outside, path.join(root, '.juno_task/wiki/external'));
    expect(await wikiOutput(root)).not.toContain('external');
  });

  it('fails actionably when the canonical wiki is absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-wiki-missing-'));
    roots.push(root);
    await expect(wikiOutput(root)).rejects.toThrow('reviewed controller-wiki migration');
  });
});
