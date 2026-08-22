import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('YYLO release documentation identity', () => {
  it('uses only the scoped RC package in the launch post', async () => {
    const launchPost = await fs.readFile(path.resolve('docs/hackernews_post.md'), 'utf8');
    expect(launchPost).toContain('npm install -g @yylo/cli@0.1.0-rc.1');
    expect(launchPost).toContain('https://www.npmjs.com/package/%40yylo%2Fcli');
    expect(launchPost).not.toMatch(/npm install -g (?:juno-code|yylo)(?:\s|`|$)/m);
    expect(launchPost).not.toContain('https://www.npmjs.com/package/juno-code');
  });
});
