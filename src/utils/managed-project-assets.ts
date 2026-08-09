import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import managedAssetManifest from '../templates/managed-assets.json';
import { version as packageVersion } from '../version.js';

type ManagedAssetDefinition = {
  source: string;
  destination: string;
  installClass: 'project' | 'script';
  type: string;
  macro?: string;
};

const MANAGED_ASSET_DEFINITIONS = managedAssetManifest.assets as ManagedAssetDefinition[];

export const MANAGED_ASSETS = MANAGED_ASSET_DEFINITIONS;

export const MANAGED_PROJECT_ASSETS = MANAGED_ASSET_DEFINITIONS.filter(
  (asset) => asset.installClass === 'project',
);

export const MANAGED_PROMPT_MACROS = Object.fromEntries(
  MANAGED_ASSET_DEFINITIONS.filter((asset) => asset.macro).map((asset) => [
    asset.macro as string,
    { path: asset.destination },
  ]),
) as Record<string, { path: string }>;

interface ManagedAssetRecord {
  type: string;
  templateVersion: string;
  sourceSha256: string;
  installedSha256: string;
}

interface ManagedAssetManifest {
  schemaVersion: 1;
  packageName: 'juno-code';
  packageVersion: string;
  assets: Record<string, ManagedAssetRecord>;
}

export interface ManagedAssetUpdateResult {
  installed: string[];
  updated: string[];
  unchanged: string[];
  conflicts: Array<{ destination: string; candidate: string }>;
  backups: Array<{ destination: string; backup: string }>;
  macrosAdded: string[];
  macroConflicts: string[];
}

// Version-bound migration inventory for installations created before the Bolt
// task-worktree generation. Every removed byte is copied to managed-conflicts.
const RETIRED_BEFORE_BOLT_2_0_32 = [
  '.juno_task/scripts/task_lifecycle.py',
  '.juno_task/scripts/integration_candidate.py',
  '.juno_task/scripts/integration_owner_preflight.py',
  '.juno_task/scripts/worktree_lifecycle.py',
  '.juno_task/scripts/tests/test_task_lifecycle.py',
  '.juno_task/scripts/tests/test_controller_workspace.py',
  '.juno_task/scripts/tests/test_integration_concurrency.py',
  '.juno_task/config/lifecycle.json',
  '.juno_task/config/controller-workspace.json',
] as const;

const RETIRED_SPECIALIZATION_RECEIPT =
  '.juno_task/managed-specializations/clean-worktree.json';
const BOLT_PROMPT = '.juno_task/prompts/clean_worktree.md';

export type ManagedAssetGenerationState =
  | 'current'
  | 'specialized'
  | 'missing'
  | 'outdated'
  | 'customized';

export interface ManagedAssetGenerationReport {
  status: 'coherent' | 'mixed' | 'incomplete' | 'customized';
  coherent: boolean;
  entries: Array<{
    destination: string;
    installClass: 'project' | 'script';
    state: ManagedAssetGenerationState;
  }>;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function assertSafeProjectWritePath(projectRoot: string, destination: string): Promise<void> {
  const root = path.resolve(projectRoot);
  const target = path.resolve(destination);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Managed asset path escapes project root: ${destination}`);
  }
  const relative = path.relative(root, target);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (await fs.pathExists(cursor) && (await fs.lstat(cursor)).isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link managed path component: ${path.relative(root, cursor)}`);
    }
  }
}

async function writeAtomic(
  destination: string,
  content: Buffer | string,
  projectRoot: string,
): Promise<void> {
  await assertSafeProjectWritePath(projectRoot, destination);
  await fs.ensureDir(path.dirname(destination));
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, destination);
}

function emptyManifest(): ManagedAssetManifest {
  return {
    schemaVersion: 1,
    packageName: 'juno-code',
    packageVersion,
    assets: {},
  };
}

export class ManagedProjectAssets {
  static getTemplatesDirectory(): string | null {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(dirname, '..', '..', 'templates'),
      path.join(dirname, '..', 'templates'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  static async update(
    projectDir: string,
    options: { force?: boolean; silent?: boolean } = {},
  ): Promise<ManagedAssetUpdateResult> {
    const result: ManagedAssetUpdateResult = {
      installed: [],
      updated: [],
      unchanged: [],
      conflicts: [],
      backups: [],
      macrosAdded: [],
      macroConflicts: [],
    };
    const junoTaskDir = path.join(projectDir, '.juno_task');
    if (!(await fs.pathExists(junoTaskDir))) {
      return result;
    }
    const projectConfigPath = path.join(junoTaskDir, 'config.json');
    let projectConfig: Record<string, any> = {};
    if (await fs.pathExists(projectConfigPath)) {
      projectConfig = await fs.readJson(projectConfigPath);
      const controllerWorkspace = projectConfig?.controllerWorkspace;
      const metadataOnlyController =
        controllerWorkspace?.mode === 'metadata-only' &&
        controllerWorkspace?.policy === '.juno_task/config/metadata-controller.json';
      if (projectConfig?.lifecycle !== undefined ||
          (controllerWorkspace !== undefined && !metadataOnlyController)) {
        throw new Error(
          'Legacy Juno 2.0 lifecycle/controllerWorkspace config requires the reviewed 2.1 ' +
            'migration flow. Run `yy migrate inventory`, generate the owner-reviewed policy, ' +
            'then apply and verify `yy migrate evacuation-*` in a disposable worktree before ' +
            'updating managed assets.',
        );
      }
    }
    const templatesDir = this.getTemplatesDirectory();
    if (!templatesDir) {
      throw new Error('Juno Code managed prompt/wiki templates are missing from this package');
    }

    const manifestPath = path.join(junoTaskDir, 'managed-assets.json');
    let manifest = emptyManifest();
    if (await fs.pathExists(manifestPath)) {
      const parsed = await fs.readJson(manifestPath);
      if (
        parsed?.schemaVersion !== 1 ||
        typeof parsed.assets !== 'object' ||
        parsed.assets === null
      ) {
        throw new Error(`Unsupported managed asset manifest: ${manifestPath}`);
      }
      manifest = parsed as ManagedAssetManifest;
    }

    await this.assertRetiredGenerationSafe(projectDir, manifest, Boolean(options.force));

    // Validate all possible install/candidate/backup parents before the first
    // generation write. A missing leaf below a symlinked directory is just as
    // unsafe as a symlinked leaf.
    await assertSafeProjectWritePath(projectDir, projectConfigPath);
    await assertSafeProjectWritePath(projectDir, manifestPath);
    await assertSafeProjectWritePath(
      projectDir,
      path.join(projectDir, RETIRED_SPECIALIZATION_RECEIPT),
    );
    for (const asset of MANAGED_ASSET_DEFINITIONS) {
      await assertSafeProjectWritePath(projectDir, path.join(projectDir, asset.destination));
      await assertSafeProjectWritePath(
        projectDir,
        path.join(
          projectDir, '.juno_task', 'managed-conflicts', safeVersion(packageVersion),
          `${asset.destination}.candidate`,
        ),
      );
      await assertSafeProjectWritePath(
        projectDir,
        path.join(
          projectDir, '.juno_task', 'managed-conflicts', `bolt-${safeVersion(packageVersion)}`,
          `${asset.destination}.backup`,
        ),
      );
    }

    // Discover every ordinary managed conflict before changing the installed
    // generation. Candidate files are review aids; installed bytes and the
    // manifest stay untouched until the whole generation is admissible.
    if (!options.force) {
      for (const asset of MANAGED_ASSET_DEFINITIONS) {
        const sourcePath = path.join(templatesDir, asset.source);
        if (!(await fs.pathExists(sourcePath))) {
          throw new Error(`Missing managed package asset: ${sourcePath}`);
        }
        const sourceContent = await fs.readFile(sourcePath);
        const destinationPath = path.join(projectDir, asset.destination);
        const record = manifest.assets[asset.destination];
        if (await fs.pathExists(destinationPath)) {
          const currentHash = sha256(await fs.readFile(destinationPath));
          const sourceHash = sha256(sourceContent);
          const generatedSpecialization =
            asset.destination === BOLT_PROMPT &&
            await fs.pathExists(path.join(projectDir, RETIRED_SPECIALIZATION_RECEIPT));
          if (!generatedSpecialization &&
              currentHash !== sourceHash && currentHash !== record?.installedSha256) {
            const candidateRelative = path.join(
              '.juno_task', 'managed-conflicts', safeVersion(packageVersion),
              `${asset.destination}.candidate`,
            );
            await writeAtomic(path.join(projectDir, candidateRelative), sourceContent, projectDir);
            result.conflicts.push({ destination: asset.destination, candidate: candidateRelative });
          }
        }
      }
      const config = projectConfig;
      const global = config?.promptMacros?.global;
      if (global && typeof global === 'object' && !Array.isArray(global)) {
        const mappings = global as Record<string, unknown>;
        for (const [name, mapping] of Object.entries(MANAGED_PROMPT_MACROS)) {
          if (mappings[name] !== undefined && JSON.stringify(mappings[name]) !== JSON.stringify(mapping)) {
            result.macroConflicts.push(name);
          }
        }
      }
      if (result.macroConflicts.length > 0) {
        const candidateConfig = structuredClone(config);
        candidateConfig.promptMacros = candidateConfig.promptMacros ?? {};
        candidateConfig.promptMacros.global = candidateConfig.promptMacros.global ?? {};
        for (const name of result.macroConflicts) {
          candidateConfig.promptMacros.global[name] = MANAGED_PROMPT_MACROS[name];
        }
        const candidateRelative = path.join(
          '.juno_task', 'managed-conflicts', safeVersion(packageVersion),
          '.juno_task/config.json.candidate',
        );
        await writeAtomic(
          path.join(projectDir, candidateRelative),
          `${JSON.stringify(candidateConfig, null, 2)}\n`,
          projectDir,
        );
        result.conflicts.push({
          destination: '.juno_task/config.json',
          candidate: candidateRelative,
        });
      }
      if (result.conflicts.length > 0) return result;
    }

    await this.migrateRetiredGeneration(projectDir, manifest, result, Boolean(options.force));

    // Scripts and project guidance are one migration generation.  Handling only
    // prompts/config here and letting ScriptInstaller overwrite scripts later
    // would bypass checksum conflict detection for customized runtime bytes.
    for (const asset of MANAGED_ASSET_DEFINITIONS) {
      const sourcePath = path.join(templatesDir, asset.source);
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error(`Missing managed package asset: ${sourcePath}`);
      }
      const sourceContent = await fs.readFile(sourcePath);
      const sourceHash = sha256(sourceContent);
      const destinationPath = path.join(projectDir, asset.destination);
      const record = manifest.assets[asset.destination];

      if (!(await fs.pathExists(destinationPath))) {
        const specializationReceipt = path.join(
          projectDir,
          '.juno_task',
          'managed-specializations',
          'clean-worktree.json',
        );
        const missingSpecializedPolicy =
          asset.destination === '.juno_task/prompts/clean_worktree.md' &&
          (await fs.pathExists(specializationReceipt));
        if (missingSpecializedPolicy && !options.force) {
          const candidateRelative = path.join(
            '.juno_task',
            'managed-conflicts',
            safeVersion(packageVersion),
            `${asset.destination}.candidate`,
          );
          await writeAtomic(path.join(projectDir, candidateRelative), sourceContent, projectDir);
          result.conflicts.push({ destination: asset.destination, candidate: candidateRelative });
          continue;
        }
        await writeAtomic(destinationPath, sourceContent, projectDir);
        if (asset.installClass === 'script') await fs.chmod(destinationPath, 0o755);
        result.installed.push(asset.destination);
      } else {
        const currentContent = await fs.readFile(destinationPath);
        const currentHash = sha256(currentContent);
        const safelyManaged = currentHash === sourceHash || currentHash === record?.installedSha256;

        if (currentHash === sourceHash) {
          result.unchanged.push(asset.destination);
        } else if (safelyManaged || options.force) {
          if (options.force && !safelyManaged) {
            await this.archiveRetired(projectDir, asset.destination, currentContent, result);
          }
          await writeAtomic(destinationPath, sourceContent, projectDir);
          if (asset.installClass === 'script') await fs.chmod(destinationPath, 0o755);
          result.updated.push(asset.destination);
        } else {
          const candidateRelative = path.join(
            '.juno_task',
            'managed-conflicts',
            safeVersion(packageVersion),
            `${asset.destination}.candidate`,
          );
          await writeAtomic(path.join(projectDir, candidateRelative), sourceContent, projectDir);
          result.conflicts.push({ destination: asset.destination, candidate: candidateRelative });
          continue;
        }
      }

      manifest.assets[asset.destination] = {
        type: asset.type,
        templateVersion: packageVersion,
        sourceSha256: sourceHash,
        installedSha256: sourceHash,
      };
    }

    await this.registerPromptMacros(projectDir, result, Boolean(options.force));
    manifest.packageVersion = packageVersion;
    await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, projectDir);

    if (!options.silent) {
      console.log(
        `Managed assets: ${result.installed.length} installed, ${result.updated.length} updated, ` +
          `${result.unchanged.length} unchanged, ${result.conflicts.length} conflict(s)`,
      );
      for (const conflict of result.conflicts) {
        console.log(`⚠ Preserved ${conflict.destination}; review ${conflict.candidate}`);
      }
    }
    return result;
  }

  private static async archiveRetired(
    projectDir: string,
    destination: string,
    content: Buffer | string,
    result: ManagedAssetUpdateResult,
  ): Promise<void> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const backupRoot = path.join(
      '.juno_task',
      'managed-conflicts',
      `bolt-${safeVersion(packageVersion)}`,
    );
    const baseRelative = path.join(backupRoot, `${destination}.backup`);
    const contentRelative = path.join(
      backupRoot,
      `${destination}.${sha256(bytes).slice(0, 16)}.backup`,
    );

    for (let attempt = 0; ; attempt += 1) {
      const backupRelative =
        attempt === 0
          ? baseRelative
          : attempt === 1
            ? contentRelative
            : `${contentRelative}.${attempt - 1}`;
      const backupPath = path.join(projectDir, backupRelative);
      await assertSafeProjectWritePath(projectDir, backupPath);
      if (await fs.pathExists(backupPath)) {
        if ((await fs.lstat(backupPath)).isSymbolicLink()) {
          throw new Error(`Refusing symbolic-link managed backup: ${backupRelative}`);
        }
        if ((await fs.readFile(backupPath)).equals(bytes)) {
          result.backups.push({ destination, backup: backupRelative });
          return;
        }
        continue;
      }
      await fs.ensureDir(path.dirname(backupPath));
      try {
        await fs.writeFile(backupPath, bytes, { flag: 'wx' });
        result.backups.push({ destination, backup: backupRelative });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }

  private static async migrateRetiredGeneration(
    projectDir: string,
    manifest: ManagedAssetManifest,
    result: ManagedAssetUpdateResult,
    force: boolean,
  ): Promise<void> {
    await this.assertRetiredGenerationSafe(projectDir, manifest, force);
    for (const destination of RETIRED_BEFORE_BOLT_2_0_32) {
      const destinationPath = path.join(projectDir, destination);
      if (!(await fs.pathExists(destinationPath))) continue;
      await assertSafeProjectWritePath(projectDir, destinationPath);
      if ((await fs.lstat(destinationPath)).isSymbolicLink()) {
        throw new Error(`Refusing symbolic-link retired managed asset: ${destination}`);
      }
      const content = await fs.readFile(destinationPath);
      await this.archiveRetired(projectDir, destination, content, result);
      await fs.remove(destinationPath);
      delete manifest.assets[destination];
    }

    const receiptPath = path.join(projectDir, RETIRED_SPECIALIZATION_RECEIPT);
    if (!(await fs.pathExists(receiptPath))) return;
    const receiptContent = await fs.readFile(receiptPath);
    let receipt: { promptSha256?: unknown } = {};
    try {
      receipt = JSON.parse(receiptContent.toString('utf8')) as { promptSha256?: unknown };
    } catch {
      // Invalid receipt bytes are customized state and require explicit force.
    }
    const promptPath = path.join(projectDir, BOLT_PROMPT);
    const promptContent = (await fs.pathExists(promptPath)) ? await fs.readFile(promptPath) : null;
    const generated =
      promptContent !== null &&
      typeof receipt.promptSha256 === 'string' &&
      receipt.promptSha256 === sha256(promptContent);
    if (!generated && !force) {
      throw new Error(
        `Refusing to migrate customized retired specialization ${RETIRED_SPECIALIZATION_RECEIPT}; ` +
          'run `yy scripts update --force` to archive it and install the Bolt prompt',
      );
    }
    if (promptContent !== null) {
      await this.archiveRetired(projectDir, BOLT_PROMPT, promptContent, result);
      await fs.remove(promptPath);
    }
    await this.archiveRetired(projectDir, RETIRED_SPECIALIZATION_RECEIPT, receiptContent, result);
    await fs.remove(receiptPath);
    delete manifest.assets[BOLT_PROMPT];
  }

  private static async assertRetiredGenerationSafe(
    projectDir: string,
    manifest: ManagedAssetManifest,
    force: boolean,
  ): Promise<void> {
    for (const destination of RETIRED_BEFORE_BOLT_2_0_32) {
      const destinationPath = path.join(projectDir, destination);
      if (!(await fs.pathExists(destinationPath))) continue;
      await assertSafeProjectWritePath(projectDir, destinationPath);
      if ((await fs.lstat(destinationPath)).isSymbolicLink()) {
        throw new Error(`Refusing symbolic-link retired managed asset: ${destination}`);
      }
      const content = await fs.readFile(destinationPath);
      const managed = manifest.assets[destination]?.installedSha256 === sha256(content);
      if (!managed && !force) {
        throw new Error(
          `Refusing to migrate customized retired asset ${destination}; ` +
            'run `yy scripts update --force` to archive it and complete the Bolt migration',
        );
      }
    }
    const preflightReceiptPath = path.join(projectDir, RETIRED_SPECIALIZATION_RECEIPT);
    if (await fs.pathExists(preflightReceiptPath)) {
      const preflightReceiptContent = await fs.readFile(preflightReceiptPath);
      let preflightReceipt: { promptSha256?: unknown } = {};
      try {
        preflightReceipt = JSON.parse(preflightReceiptContent.toString('utf8')) as {
          promptSha256?: unknown;
        };
      } catch {
        // Invalid receipt bytes are customized state and require explicit force.
      }
      const preflightPromptPath = path.join(projectDir, BOLT_PROMPT);
      const preflightPromptContent = (await fs.pathExists(preflightPromptPath))
        ? await fs.readFile(preflightPromptPath)
        : null;
      const generated =
        preflightPromptContent !== null &&
        typeof preflightReceipt.promptSha256 === 'string' &&
        preflightReceipt.promptSha256 === sha256(preflightPromptContent);
      if (!generated && !force) {
        throw new Error(
          `Refusing to migrate customized retired specialization ${RETIRED_SPECIALIZATION_RECEIPT}; ` +
            'run `yy scripts update --force` to archive it and install the Bolt prompt',
        );
      }
    }
  }

  /** Inspect the installed lifecycle bundle without changing project files. */
  static async inspectGeneration(projectDir: string): Promise<ManagedAssetGenerationReport> {
    const templatesDir = this.getTemplatesDirectory();
    if (!templatesDir) {
      throw new Error('Juno Code managed prompt/wiki templates are missing from this package');
    }
    const manifestPath = path.join(projectDir, '.juno_task', 'managed-assets.json');
    let manifest = emptyManifest();
    if (await fs.pathExists(manifestPath)) {
      const parsed = await fs.readJson(manifestPath);
      if (
        parsed?.schemaVersion !== 1 ||
        typeof parsed.assets !== 'object' ||
        parsed.assets === null
      ) {
        throw new Error(`Unsupported managed asset manifest: ${manifestPath}`);
      }
      manifest = parsed as ManagedAssetManifest;
    }

    const specializationReceipt = path.join(
      projectDir,
      '.juno_task',
      'managed-specializations',
      'clean-worktree.json',
    );
    const retiredSpecializationPresent = await fs.pathExists(specializationReceipt);
    const entries: ManagedAssetGenerationReport['entries'] = [];
    for (const asset of MANAGED_ASSET_DEFINITIONS) {
      const sourceContent = await fs.readFile(path.join(templatesDir, asset.source));
      const sourceHash = sha256(sourceContent);
      const destinationPath = path.join(projectDir, asset.destination);
      let state: ManagedAssetGenerationState;
      if (!(await fs.pathExists(destinationPath))) {
        state = 'missing';
      } else {
        const currentHash = sha256(await fs.readFile(destinationPath));
        const record = manifest.assets[asset.destination];
        if (currentHash === sourceHash) {
          state = 'current';
        } else if (
          asset.destination === '.juno_task/prompts/clean_worktree.md' &&
          (await fs.pathExists(specializationReceipt))
        ) {
          state = 'specialized';
        } else if (record?.installedSha256 === currentHash) {
          state = 'outdated';
        } else {
          state = 'customized';
        }
      }
      entries.push({
        destination: asset.destination,
        installClass: asset.installClass,
        state,
      });
    }

    const scripts = entries.filter((entry) => entry.installClass === 'script');
    const guidance = entries.filter(
      (entry) =>
        entry.installClass === 'project' &&
        entry.destination !== '.juno_task/prompts/clean_worktree.md',
    );
    const cleanPolicy = entries.find(
      (entry) => entry.destination === '.juno_task/prompts/clean_worktree.md',
    );
    const scriptsCurrent = scripts.every((entry) => entry.state === 'current');
    const guidanceCurrent = guidance.every((entry) => entry.state === 'current');
    // A retired specialization receipt can never certify a coherent Bolt generation.
    const cleanCurrent = cleanPolicy?.state === 'current' && !retiredSpecializationPresent;
    const coherent = scriptsCurrent && guidanceCurrent && cleanCurrent;
    const anyMissing = entries.some((entry) => entry.state === 'missing');
    const someScriptsCurrent = scripts.some((entry) => entry.state === 'current');
    const someGuidanceCurrent = guidance.some((entry) => entry.state === 'current');
    const mixed =
      (someScriptsCurrent && !guidanceCurrent) || (someGuidanceCurrent && !scriptsCurrent);
    return {
      status: coherent ? 'coherent' : mixed ? 'mixed' : anyMissing ? 'incomplete' : 'customized',
      coherent,
      entries,
    };
  }

  private static async registerPromptMacros(
    projectDir: string,
    result: ManagedAssetUpdateResult,
    force: boolean,
  ): Promise<void> {
    const configPath = path.join(projectDir, '.juno_task', 'config.json');
    const config = (await fs.pathExists(configPath)) ? await fs.readJson(configPath) : {};
    const original = `${JSON.stringify(config, null, 2)}\n`;
    const promptMacros =
      config.promptMacros &&
      typeof config.promptMacros === 'object' &&
      !Array.isArray(config.promptMacros)
        ? config.promptMacros
        : {};
    const global =
      promptMacros.global &&
      typeof promptMacros.global === 'object' &&
      !Array.isArray(promptMacros.global)
        ? promptMacros.global
        : {};
    let changed = false;

    for (const [name, mapping] of Object.entries(MANAGED_PROMPT_MACROS)) {
      const existing = global[name];
      if (existing === undefined) {
        global[name] = mapping;
        result.macrosAdded.push(name);
        changed = true;
      } else if (JSON.stringify(existing) !== JSON.stringify(mapping)) {
        result.macroConflicts.push(name);
        if (force) {
          global[name] = mapping;
          changed = true;
        }
      }
    }

    if (!force && result.macroConflicts.length > 0) {
      const candidateConfig = structuredClone(config);
      candidateConfig.promptMacros = candidateConfig.promptMacros ?? {};
      candidateConfig.promptMacros.global = candidateConfig.promptMacros.global ?? {};
      for (const name of result.macroConflicts) {
        candidateConfig.promptMacros.global[name] =
          MANAGED_PROMPT_MACROS[name as keyof typeof MANAGED_PROMPT_MACROS];
      }
      const candidateRelative = path.join(
        '.juno_task',
        'managed-conflicts',
        safeVersion(packageVersion),
        '.juno_task/config.json.candidate',
      );
      await writeAtomic(
        path.join(projectDir, candidateRelative),
        `${JSON.stringify(candidateConfig, null, 2)}\n`,
        projectDir,
      );
      result.conflicts.push({
        destination: '.juno_task/config.json',
        candidate: candidateRelative,
      });
    }

    if (!changed) return;
    promptMacros.global = global;
    config.promptMacros = promptMacros;

    if (force && result.macroConflicts.length > 0) {
      await this.archiveRetired(
        projectDir,
        '.juno_task/config.json',
        original,
        result,
      );
    }
    await writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, projectDir);
  }
}
