import fs from 'fs-extra';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const channel = path.resolve(process.cwd(), 'src/templates/scripts/integration_owner_preflight.py');
const manifest = path.resolve(process.cwd(), 'src/templates/managed-assets.json');

describe('integration channel is the single writer authority', () => {
  it('keys locks by common directory and full target ref in fixed order', async () => {
    const source = await fs.readFile(channel, 'utf8');
    expect(source).toContain('common(item');
    expect(source).toContain("item['target_ref']");
    expect(source).toContain('sorted(a.repository');
    expect(source).toContain('fcntl.LOCK_EX');
    expect(source).toContain('update-ref');
  });

  it('does not ship the obsolete repository-wide writer guard', async () => {
    const assets = JSON.stringify(await fs.readJson(manifest));
    expect(assets).not.toContain('repository_writer_guard.py');
    expect(await fs.pathExists(path.resolve(process.cwd(), 'src/templates/scripts/repository_writer_guard.py'))).toBe(false);
  });
});
