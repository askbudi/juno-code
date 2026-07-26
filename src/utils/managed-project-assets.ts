import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { version as packageVersion } from '../version.js';

export const MANAGED_PROMPT_MACROS = {
  clean_worktree: { path: '.juno_task/prompts/clean_worktree.md' },
  new_task_workflow: { path: '.juno_task/prompts/new_task_workflow.md' },
  run_workflow: { path: '.juno_task/prompts/run_workflow.md' },
  migrate_juno_code_v1_to_v2: { path: '.juno_task/prompts/migrate_juno_code_v1_to_v2.md' },
  migrate_juno_kanban_v1_to_v2: { path: '.juno_task/prompts/migrate_juno_kanban_v1_to_v2.md' },
} as const;

export const MANAGED_PROJECT_ASSETS = [
  {
    source: 'prompts/clean_worktree.md',
    destination: '.juno_task/prompts/clean_worktree.md',
    type: 'prompt',
  },
  {
    source: 'prompts/new_task_workflow.md',
    destination: '.juno_task/prompts/new_task_workflow.md',
    type: 'prompt',
  },
  {
    source: 'prompts/run_workflow.md',
    destination: '.juno_task/prompts/run_workflow.md',
    type: 'prompt',
  },
  {
    source: 'prompts/migrate_juno_code_v1_to_v2.md',
    destination: '.juno_task/prompts/migrate_juno_code_v1_to_v2.md',
    type: 'prompt',
  },
  {
    source: 'prompts/migrate_juno_kanban_v1_to_v2.md',
    destination: '.juno_task/prompts/migrate_juno_kanban_v1_to_v2.md',
    type: 'prompt',
  },
  {
    source: 'wiki/git_worktree_lifecycle.md',
    destination: '.juno_task/wiki/git_worktree_lifecycle.md',
    type: 'wiki',
  },
] as const;

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

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function writeAtomic(destination: string, content: Buffer | string): Promise<void> {
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

    for (const asset of MANAGED_PROJECT_ASSETS) {
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
          await writeAtomic(path.join(projectDir, candidateRelative), sourceContent);
          result.conflicts.push({ destination: asset.destination, candidate: candidateRelative });
          continue;
        }
        await writeAtomic(destinationPath, sourceContent);
        result.installed.push(asset.destination);
      } else {
        const currentContent = await fs.readFile(destinationPath);
        const currentHash = sha256(currentContent);
        const safelyManaged = currentHash === sourceHash || currentHash === record?.installedSha256;

        if (currentHash === sourceHash) {
          result.unchanged.push(asset.destination);
        } else if (safelyManaged || options.force) {
          if (options.force && !safelyManaged) {
            const backupRelative = path.join(
              '.juno_task',
              'managed-conflicts',
              new Date().toISOString().replace(/[:.]/g, '-'),
              `${asset.destination}.backup`,
            );
            const backupPath = path.join(projectDir, backupRelative);
            await writeAtomic(backupPath, currentContent);
            result.backups.push({ destination: asset.destination, backup: backupRelative });
          }
          await writeAtomic(destinationPath, sourceContent);
          result.updated.push(asset.destination);
        } else {
          const candidateRelative = path.join(
            '.juno_task',
            'managed-conflicts',
            safeVersion(packageVersion),
            `${asset.destination}.candidate`,
          );
          await writeAtomic(path.join(projectDir, candidateRelative), sourceContent);
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
    await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

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
      const backupRelative = path.join(
        '.juno_task',
        'managed-conflicts',
        new Date().toISOString().replace(/[:.]/g, '-'),
        '.juno_task/config.json.backup',
      );
      await writeAtomic(path.join(projectDir, backupRelative), original);
      result.backups.push({ destination: '.juno_task/config.json', backup: backupRelative });
    }
    await writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}
