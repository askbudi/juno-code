import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');
const PACKAGE_LOCK_JSON = path.join(PROJECT_ROOT, 'package-lock.json');
const YPL_SOURCE = path.join(PROJECT_ROOT, 'src/bin/ypl.sh');
const JUNO_CODE_SOURCE = path.join(PROJECT_ROOT, 'src/bin/juno-code.sh');

describe('ypl wrapper', () => {
  it('is exposed as an npm binary beside yy', async () => {
    const pkg = await fs.readJson(PACKAGE_JSON);

    const lock = await fs.readJson(PACKAGE_LOCK_JSON);

    expect(pkg.bin.yy).toBe('./dist/bin/juno-code.sh');
    expect(pkg.bin.ypl).toBe('./dist/bin/ypl.sh');
    expect(lock.packages[''].bin.ypl).toBe('dist/bin/ypl.sh');
    expect(pkg.scripts['build:copy-wrapper']).toContain('src/bin/ypl.sh');
    expect(pkg.scripts['build:copy-wrapper']).toContain('dist/bin/ypl.sh');
  });

  it('executes the juno-code wrapper with pi --live before forwarded args', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-ypl-wrapper-'));
    try {
      const binDir = path.join(tempDir, 'bin');
      await fs.ensureDir(binDir);
      await fs.copy(YPL_SOURCE, path.join(binDir, 'ypl.sh'));
      await fs.copy(JUNO_CODE_SOURCE, path.join(binDir, 'juno-code.sh'));
      await fs.chmod(path.join(binDir, 'ypl.sh'), 0o755);
      await fs.chmod(path.join(binDir, 'juno-code.sh'), 0o755);
      await fs.writeFile(
        path.join(binDir, 'cli.mjs'),
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
        'utf8',
      );

      const result = await execa(path.join(binDir, 'ypl.sh'), ['hello world', '--model', 'sonnet'], {
        cwd: tempDir,
        reject: false,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['pi', '--live', 'hello world', '--model', 'sonnet']);
    } finally {
      await fs.remove(tempDir);
    }
  });
});
