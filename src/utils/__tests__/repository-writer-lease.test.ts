import fs from 'fs-extra';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const channel = path.resolve(process.cwd(), 'src/templates/scripts/merge_queue.py');
const manifest = path.resolve(process.cwd(), 'src/templates/managed-assets.json');

describe('per-target merge queue is the single writer authority', () => {
  it('keys its repository lock by identity and exact target ref and uses expected-SHA CAS', async () => {
    const source = await fs.readFile(channel, 'utf8');
    expect(source).toContain('target_key(repository, target_ref)');
    expect(source).toContain('juno-locks/merge-queue');
    expect(source).toContain('fcntl.LOCK_EX');
    expect(source).toContain('update-ref');
    expect(source).toContain('candidate_sha, expected_sha');
  });

  it('does not ship the obsolete repository-wide writer guard', async () => {
    const assets = JSON.stringify(await fs.readJson(manifest));
    expect(assets).not.toContain('repository_writer_guard.py');
    expect(await fs.pathExists(path.resolve(process.cwd(), 'src/templates/scripts/repository_writer_guard.py'))).toBe(false);
  });
});
