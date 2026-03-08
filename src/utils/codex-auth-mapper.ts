import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
export const DEFAULT_PI_AUTH_PATH = path.join(os.homedir(), '.pi', 'agent', 'auth.json');

export interface ImportCodexAuthOptions {
  inputPath?: string;
  outputPath?: string;
  provider?: string;
}

export interface ImportCodexAuthResult {
  provider: string;
  outputPath: string;
  expires: number;
  replacedExisting: boolean;
}

type CodexAuthTokens = {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  account_id?: unknown;
};

type CodexAuthDocument = {
  tokens?: CodexAuthTokens;
  [key: string]: unknown;
};

type PiAuthCredential = {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

function expandHomePath(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function getRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required field: ${fieldName}`);
  }
  return value;
}

function decodeJwtExpiryMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }

  const payloadPart = parts[1];
  if (!payloadPart) {
    return undefined;
  }

  try {
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payloadText = Buffer.from(padded, 'base64').toString('utf-8');
    const payload = JSON.parse(payloadText) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return undefined;
    }
    return payload.exp * 1000;
  } catch {
    return undefined;
  }
}

function mapCodexToPiCredential(doc: CodexAuthDocument): PiAuthCredential {
  const tokens = asObject(doc.tokens, 'codex auth tokens') as CodexAuthTokens;

  const access = getRequiredString(tokens.access_token, 'tokens.access_token');
  const refresh = getRequiredString(tokens.refresh_token, 'tokens.refresh_token');
  const accountIdValue = tokens.account_id;
  const accountId = typeof accountIdValue === 'string' && accountIdValue.trim() ? accountIdValue : undefined;

  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : undefined;
  const expires = decodeJwtExpiryMs(access) ?? (idToken ? decodeJwtExpiryMs(idToken) : undefined) ?? Date.now();

  return {
    type: 'oauth',
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return asObject(parsed, `JSON at ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    if (error instanceof Error) {
      throw new Error(`Failed to read ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export async function importCodexAuth(options: ImportCodexAuthOptions = {}): Promise<ImportCodexAuthResult> {
  const inputPath = expandHomePath(options.inputPath ?? DEFAULT_CODEX_AUTH_PATH);
  const outputPath = expandHomePath(options.outputPath ?? DEFAULT_PI_AUTH_PATH);
  const provider = options.provider ?? 'openai-codex';

  const codexDoc = (await readJsonObject(inputPath)) as CodexAuthDocument;
  const piCredential = mapCodexToPiCredential(codexDoc);

  let outputDoc: Record<string, unknown> = {};
  if (await fs.pathExists(outputPath)) {
    outputDoc = await readJsonObject(outputPath);
  }

  const replacedExisting = Object.prototype.hasOwnProperty.call(outputDoc, provider);
  outputDoc[provider] = piCredential;

  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, `${JSON.stringify(outputDoc, null, 2)}\n`, 'utf-8');

  try {
    await fs.chmod(outputPath, 0o600);
  } catch {
    // Ignore chmod failures (e.g., on unsupported filesystems)
  }

  return {
    provider,
    outputPath,
    expires: piCredential.expires,
    replacedExisting,
  };
}
