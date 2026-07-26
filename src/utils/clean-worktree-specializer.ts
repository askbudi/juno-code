import { createHash } from 'node:crypto';
import * as path from 'node:path';
import fs from 'fs-extra';
import { z } from 'zod';
import { ManagedProjectAssets } from './managed-project-assets.js';

const AbsolutePath = z.string().min(1).refine(path.isAbsolute, 'must be an absolute path');
const ExactBranchRef = z
  .string()
  .regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/, 'must be an exact refs/heads/... ref');
const ExactRemoteRef = z
  .string()
  .regex(
    /^refs\/remotes\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/,
    'must be an exact refs/remotes/REMOTE/... ref',
  );

const RepositoryPolicySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['root', 'nested']),
  repositoryPath: AbsolutePath,
  integrationTarget: ExactBranchRef,
  remoteTarget: ExactRemoteRef,
  integrationOwner: z.object({
    checkoutPath: AbsolutePath,
    role: z.literal('integration-owner'),
    expectedBranch: ExactBranchRef,
    cleanlinessContract: z.literal('clean'),
  }),
  fetchedBaseShaPolicy: z.string().min(1),
  approvedIntegrationMethod: z.enum([
    'fast-forward-only',
    'reviewed-merge',
    'reviewed-rebase',
    'reviewed-cherry-pick',
    'reviewed-squash',
  ]),
  preMergeValidation: z.array(z.string().min(1)).min(1),
  integratedTargetValidation: z.array(z.string().min(1)).min(1),
});

export const CleanWorktreePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    controller: z.object({ checkoutPath: AbsolutePath, branch: ExactBranchRef }),
    taskWorktree: z.object({
      pathConvention: z.string().min(1),
      branchConvention: z.string().min(1),
    }),
    repositories: z.array(RepositoryPolicySchema).min(1),
    cleanup: z.object({
      reachabilityPolicy: z.string().min(1),
      fallback: z.literal('integration_pending_dirty_owner'),
    }),
  })
  .superRefine((policy, context) => {
    if (policy.repositories.filter((repository) => repository.kind === 'root').length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositories'],
        message: 'must contain exactly one root repository',
      });
    }
    const names = new Set<string>();
    for (const [index, repository] of policy.repositories.entries()) {
      if (names.has(repository.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repositories', index, 'name'],
          message: 'must be unique',
        });
      }
      names.add(repository.name);
      if (repository.integrationOwner.expectedBranch !== repository.integrationTarget) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repositories', index, 'integrationOwner', 'expectedBranch'],
          message: 'must exactly equal integrationTarget',
        });
      }
    }
  });

export type CleanWorktreePolicy = z.infer<typeof CleanWorktreePolicySchema>;

export interface SpecializationResult {
  promptPath: string;
  promptSha256: string;
  backupPath?: string;
  receiptPath: string;
}

function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function atomicWrite(destination: string, content: Buffer | string): Promise<void> {
  await fs.ensureDir(path.dirname(destination));
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, destination);
}

export class CleanWorktreeSpecializer {
  static async specialize(projectDir: string, rawPolicy: unknown): Promise<SpecializationResult> {
    const policy = CleanWorktreePolicySchema.parse(rawPolicy);
    if (!(await fs.pathExists(path.join(projectDir, '.juno_task')))) {
      throw new Error(
        `Clean-worktree specialization requires an initialized project: ${projectDir}`,
      );
    }
    await ManagedProjectAssets.update(projectDir, { silent: true });
    const templatesDir = ManagedProjectAssets.getTemplatesDirectory();
    if (!templatesDir) throw new Error('Managed templates directory is unavailable');

    const portableTemplate = await fs.readFile(
      path.join(templatesDir, 'prompts', 'clean_worktree.md'),
      'utf8',
    );
    const rootPolicy = policy.repositories.find((repository) => repository.kind === 'root')!;
    const boundTemplate = portableTemplate
      .replaceAll('origin/<target>', rootPolicy.remoteTarget.replace(/^refs\/remotes\//, ''))
      .replaceAll('refs/heads/<target>', rootPolicy.integrationTarget)
      .replaceAll('refs/heads/<local-target>', rootPolicy.integrationTarget)
      .replaceAll('<remote-target>', rootPolicy.remoteTarget);
    const rendered =
      `${boundTemplate.trimEnd()}\n\n## Project-specialized integration policy\n\n` +
      `This section is generated from owner-reviewed migration facts. It is the exact policy for this project; ` +
      `do not substitute another branch, checkout, or repository.\n\n` +
      `\`\`\`json\n${JSON.stringify(policy, null, 2)}\n\`\`\`\n\n` +
      `Local reviewed integration grants no authority to push, publish, deploy, mutate production, or run post-deploy E2E.\n`;

    const promptRelative = '.juno_task/prompts/clean_worktree.md';
    const promptPath = path.join(projectDir, promptRelative);
    let backupPath: string | undefined;
    if (await fs.pathExists(promptPath)) {
      const current = await fs.readFile(promptPath);
      if (hash(current) !== hash(rendered)) {
        backupPath = path.join(
          '.juno_task',
          'managed-conflicts',
          new Date().toISOString().replace(/[:.]/g, '-'),
          `${promptRelative}.backup`,
        );
        await atomicWrite(path.join(projectDir, backupPath), current);
      }
    }
    await atomicWrite(promptPath, rendered);

    const promptSha256 = hash(rendered);
    const receiptRelative = '.juno_task/managed-specializations/clean-worktree.json';
    const receipt = {
      schemaVersion: 1,
      promptPath: promptRelative,
      promptSha256,
      specializedAt: new Date().toISOString(),
      repositoryNames: policy.repositories.map((repository) => repository.name),
      backupPath: backupPath ?? null,
    };
    await atomicWrite(
      path.join(projectDir, receiptRelative),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return {
      promptPath: promptRelative,
      promptSha256,
      ...(backupPath ? { backupPath } : {}),
      receiptPath: receiptRelative,
    };
  }

  static async specializeFromFile(
    projectDir: string,
    policyFile: string,
  ): Promise<SpecializationResult> {
    return this.specialize(projectDir, await fs.readJson(path.resolve(policyFile)));
  }
}
