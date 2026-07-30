import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveContinueScopeContext } from '../continue-scope.js';
import {
  applyContinuityMigrationPlan,
  createContinuityMigrationPlan,
  inspectContinuityState,
  rollbackContinuityMigration,
} from '../continuity-maintenance.js';
import {
  getSessionContinuityFilePath,
  loadSessionContinuityDocument,
} from '../session-continuity-state.js';

const roots: string[] = [];
const originalMetadata = process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function fixture(): Promise<{ root: string; metadata: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-continuity-maintenance-'));
  const metadata = path.join(root, 'metadata');
  roots.push(root);
  process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = metadata;
  await fs.ensureDir(path.join(root, '.juno_task'));
  await fs.writeJson(path.join(root, '.juno_task', 'config.json'), {
    envFilePath: '.env.juno',
    envFileCopied: false,
  });
  return { root, metadata };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.remove(root);
  if (originalMetadata === undefined) delete process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY;
  else process.env.JUNO_CODE_SESSION_METADATA_DIRECTORY = originalMetadata;
});
function legacy(scope: string, session = 'SESSION', settings = '{"version":1,"subagent":"pi"}') {
  const suffix = scope.replace(/^SCOPE_/, '');
  return `JUNO_CODE_LAST_SESSION_ID_SCOPE_${suffix}=${session}\nJUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_${suffix}='${settings}'\n`;
}

describe('continuity maintenance', () => {
  it('inventories and plans without values, then imports/removes only continuity bytes with mode-600 backup and receipt', async () => {
    const { root } = await fixture();
    const current = resolveContinueScopeContext(
      { JUNO_CODE_CONTINUE_SCOPE: 'fixture-pane' },
      1,
      root,
    );
    const original = Buffer.from(
      `# keep\r\nTOKEN = "s3cr3t"\r\n\r\n${legacy(current.scopeHash, 'SESSION_SECRET').replaceAll('\n', '\r\n')}TAIL=' exact '`,
      'utf8',
    );
    await fs.writeFile(path.join(root, '.env.juno'), original);

    const report = await inspectContinuityState({ workingDirectory: root, context: current });
    expect(report.files[0]).toMatchObject({
      bytes: original.length,
      completePairs: 1,
      orphanPairs: 0,
      duplicates: 0,
      malformed: 0,
    });
    expect(JSON.stringify(report)).not.toContain('s3cr3t');
    expect(JSON.stringify(report)).not.toContain('SESSION_SECRET');

    const planPath = path.join(root, 'reviewed-plan.json');
    const plan = await createContinuityMigrationPlan({
      workingDirectory: root,
      context: current,
      planPath,
    });
    expect(plan.projected.removedAssignments).toBe(2);
    expect(JSON.stringify(plan)).not.toContain('SESSION_SECRET');
    expect(await fs.readFile(path.join(root, '.env.juno'))).toEqual(original);

    const result = await applyContinuityMigrationPlan({ workingDirectory: root, planPath });
    expect(await fs.readFile(path.join(root, '.env.juno'))).toEqual(
      Buffer.from(`# keep\r\nTOKEN = "s3cr3t"\r\n\r\nTAIL=' exact '`),
    );
    expect(
      (await loadSessionContinuityDocument(root)).scopes[current.scopeHash]?.branches.main
        ?.session_id,
    ).toBe('SESSION_SECRET');
    const receipt = await fs.readJson(result.receiptPath);
    expect(JSON.stringify(receipt)).not.toContain('SESSION_SECRET');
    expect((await fs.stat(receipt.backups[0].path)).mode & 0o777).toBe(0o600);

    await rollbackContinuityMigration({ workingDirectory: root, receiptPath: result.receiptPath });
    expect(await fs.readFile(path.join(root, '.env.juno'))).toEqual(original);
    expect(await fs.pathExists(getSessionContinuityFilePath(root))).toBe(false);
  });

  it('handles default and custom files, rejects conflicts, duplicates and malformed continuity assignments', async () => {
    const { root } = await fixture();
    const scope = 'SCOPE_0123456789ABCDEF';
    await fs.writeJson(path.join(root, '.juno_task', 'config.json'), {
      envFilePath: '.env.custom',
      envFileCopied: true,
    });
    await fs.writeFile(path.join(root, '.env.juno'), legacy(scope, 'A'));
    await fs.writeFile(path.join(root, '.env.custom'), legacy(scope, 'B'));
    await expect(
      createContinuityMigrationPlan({
        workingDirectory: root,
        planPath: path.join(root, 'p.json'),
      }),
    ).rejects.toThrow(/conflicting/i);

    await fs.writeFile(
      path.join(root, '.env.custom'),
      `${legacy(scope, 'A')}JUNO_CODE_LAST_SESSION_ID_SCOPE_0123456789ABCDEF=A\n`,
    );
    await expect(inspectContinuityState({ workingDirectory: root })).rejects.toThrow(/duplicate/i);
    await fs.writeFile(
      path.join(root, '.env.custom'),
      'JUNO_CODE_LAST_SESSION_ID_SCOPE_NOT_A_HASH=x\n',
    );
    await expect(inspectContinuityState({ workingDirectory: root })).rejects.toThrow(/malformed/i);
  });

  it('rewrites both default and custom env files while preserving each non-continuity byte stream', async () => {
    const { root } = await fixture();
    const scope = 'SCOPE_0123456789ABCDEF';
    await fs.writeJson(path.join(root, '.juno_task', 'config.json'), {
      envFilePath: 'private/custom.env',
      envFileCopied: true,
    });
    await fs.writeFile(
      path.join(root, '.env.juno'),
      `DEFAULT = ' exact '  \n${legacy(scope, 'A')}`,
    );
    await fs.ensureDir(path.join(root, 'private'));
    await fs.writeFile(
      path.join(root, 'private/custom.env'),
      `${legacy(scope, 'A')}CUSTOM="untouched"`,
    );
    const planPath = path.join(root, 'plan.json');
    await createContinuityMigrationPlan({ workingDirectory: root, planPath });
    await applyContinuityMigrationPlan({ workingDirectory: root, planPath });
    expect(await fs.readFile(path.join(root, '.env.juno'), 'utf8')).toBe("DEFAULT = ' exact '  \n");
    expect(await fs.readFile(path.join(root, 'private/custom.env'), 'utf8')).toBe(
      'CUSTOM="untouched"',
    );
  });

  it('rejects stale plans and rollback after concurrent changes', async () => {
    const { root } = await fixture();
    const scope = 'SCOPE_0123456789ABCDEF';
    const envPath = path.join(root, '.env.juno');
    await fs.writeFile(envPath, legacy(scope));
    const planPath = path.join(root, 'plan.json');
    await createContinuityMigrationPlan({ workingDirectory: root, planPath });
    await fs.appendFile(envPath, 'SAFE=changed\n');
    await expect(
      applyContinuityMigrationPlan({ workingDirectory: root, planPath }),
    ).rejects.toThrow(/stale|changed/i);

    await fs.writeFile(envPath, legacy(scope));
    await createContinuityMigrationPlan({ workingDirectory: root, planPath });
    const { receiptPath } = await applyContinuityMigrationPlan({
      workingDirectory: root,
      planPath,
    });
    await fs.appendFile(envPath, 'SAFE=concurrent\n');
    await expect(
      rollbackContinuityMigration({ workingDirectory: root, receiptPath }),
    ).rejects.toThrow(/changed/i);
  });

  it('never embeds env values in plan hashes or summaries', async () => {
    const { root } = await fixture();
    await fs.writeFile(
      path.join(root, '.env.juno'),
      `${legacy('SCOPE_0123456789ABCDEF', 'DO_NOT_PRINT')}API_SECRET=TOP_SECRET\n`,
    );
    const plan = await createContinuityMigrationPlan({
      workingDirectory: root,
      planPath: path.join(root, 'plan.json'),
    });
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('DO_NOT_PRINT');
    expect(serialized).not.toContain('TOP_SECRET');
    expect(plan.files[0]?.sha256).toBe(sha(await fs.readFile(path.join(root, '.env.juno'))));
  });
});
