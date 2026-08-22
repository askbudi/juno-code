import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((item) => fs.remove(item))));

describe('YYLO launch identity', () => {
  it('refuses a yy collision with a different yylo installation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yylo-collision-'));
    temporary.push(root);
    const yy = path.join(root, 'yy');
    const yylo = path.join(root, 'yylo');
    await fs.copy(path.resolve('src/bin/yylo.sh'), yy);
    await fs.writeFile(yylo, '#!/usr/bin/env bash\nexit 0\n');
    await Promise.all([fs.chmod(yy, 0o755), fs.chmod(yylo, 0o755)]);

    const result = await execa(yy, ['--version'], {
      env: { PATH: `${root}:${process.env.PATH ?? ''}` },
      reject: false,
    });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('yy and yylo resolve to different installations');
    expect(result.stderr).toContain('reinstall @yylo/cli');
  });
});
