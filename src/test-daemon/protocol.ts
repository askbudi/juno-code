/**
 * Versioned local protocol for the YYLO advisory test daemon (Wave 2 of
 * trusted-test performance PDR 7djT8N).
 *
 * Safety contract:
 * - Every result is advisory. Authoritative lifecycle admission stays on the
 *   cold, receipt-bound path (`yy task`/`yy evidence`/`yy merge`).
 * - Frames are newline-delimited JSON with strict schemas: unknown fields,
 *   wrong types, or protocol-version skew are rejected, never guessed.
 * - Identity drift (worktree, HEAD, tree, closure, environment, toolchain,
 *   dependency lock, runtime generation) returns a structured error with a
 *   cold fallback hint and never a successful PASS.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';

export const DAEMON_PROTOCOL_VERSION = 'juno.test.daemon.protocol.v1';
export const DAEMON_REQUEST_SCHEMA = 'juno.test.daemon.request.v1';
export const DAEMON_RESPONSE_SCHEMA = 'juno.test.daemon.response.v1';
export const DAEMON_RUNFILE_SCHEMA = 'juno.test.daemon.run.v1';

/** Bounded frame sizes: a larger line is malformed, not truncated. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Structured result bounds keep responses compact and parseable. */
export const MAX_RESULT_FILES = 512;
export const MAX_FAILURE_DETAILS = 64;
export const MAX_FAILURE_MESSAGE_CHARS = 2048;

/**
 * Environment variables that can change test selection or outcomes. Both
 * client and daemon bind their exact values; drift is an environment mismatch.
 * Diagnostic-only variables (for example the phase-report path) are excluded
 * because they cannot change an outcome.
 */
export const ENVIRONMENT_BINDING_KEYS = [
  'CI',
  'NODE_ENV',
  'TZ',
  'YYLO_TEST_QUARANTINE_RETRIES',
  'YYLO_TEST_DISABLE_FIXTURE_BASE_CACHE',
  'JUNO_TEST_RESOURCE_LOCK_PATH',
] as const;

export type DaemonRequestType = 'status' | 'run' | 'stop';

export interface DaemonToolchainIdentity {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}

export interface DaemonDependencyLockIdentity {
  readonly path: string;
  readonly sha256: string;
}

export interface DaemonRuntimeGenerationIdentity {
  readonly sha256: string;
  readonly inputs: readonly string[];
}

/**
 * One daemon per (repository, dependency lock, runtime generation, toolchain).
 * `identity_sha256` is the digest over the canonical serialization of the
 * other fields and keys the daemon's socket directory.
 */
export interface DaemonIdentity {
  readonly protocol_version: string;
  readonly repository_root: string;
  readonly worktree: string;
  readonly project_root: string;
  readonly dependency_lock: DaemonDependencyLockIdentity;
  readonly runtime_generation: DaemonRuntimeGenerationIdentity;
  readonly toolchain: DaemonToolchainIdentity;
  readonly identity_sha256: string;
}

/** HEAD plus a digest over the working-tree state (committed + uncommitted). */
export interface TreeSnapshot {
  readonly head: string;
  readonly digest: string;
}

export interface DaemonFileResult {
  readonly path: string;
  readonly status: 'passed' | 'failed' | 'skipped' | 'todo';
  readonly tests: number;
  readonly failed: number;
  readonly duration_ms: number;
  readonly failures: readonly string[];
}

export interface DaemonRunTotals {
  readonly files: number;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface DaemonRunResults {
  readonly files: readonly DaemonFileResult[];
  readonly totals: DaemonRunTotals;
  readonly exit_code: number;
  /** sha256 over the canonical JSON of `files`; integrity of structure. */
  readonly results_digest: string;
}

export interface DaemonIdentityRecheck {
  readonly before_head: string;
  readonly before_tree_digest: string;
  readonly after_head: string;
  readonly after_tree_digest: string;
  readonly stable: boolean;
}

export interface DaemonTimings {
  readonly total_ms: number;
  readonly identity_check_ms: number;
  readonly acquire_ms: number;
  readonly run_ms: number;
  readonly recheck_ms: number;
}

export type DaemonErrorCode =
  | 'protocol_skew'
  | 'malformed_request'
  | 'identity_mismatch'
  | 'environment_mismatch'
  | 'stale_closure'
  | 'tree_race'
  | 'busy'
  | 'timeout'
  | 'resource_unavailable'
  | 'cancelled'
  | 'unsupported_platform'
  | 'internal_error';

export interface DaemonErrorBody {
  readonly code: DaemonErrorCode;
  readonly message: string;
  readonly cold_fallback: true;
}

export interface DaemonStatusBody {
  readonly pid: number;
  readonly started_at: string;
  readonly protocol_version: string;
  readonly identity_sha256: string;
  readonly requests_served: number;
  readonly runs_served: number;
  readonly idle_shutdown_at: string;
  readonly runner: { readonly kind: string; readonly version: string };
}

export interface DaemonResponse {
  readonly schema_version: string;
  readonly id: string;
  readonly type: 'status' | 'run' | 'stop' | 'error';
  readonly advisory: true;
  readonly outcome:
    | 'completed'
    | 'no_tests'
    | 'invalidated'
    | 'stopping'
    | 'status'
    | 'error';
  readonly request_id: string;
  readonly results?: DaemonRunResults;
  readonly identity_recheck?: DaemonIdentityRecheck;
  readonly timings_ms?: DaemonTimings;
  readonly error?: DaemonErrorBody;
  readonly daemon?: DaemonStatusBody;
  readonly notice?: string;
}

export interface DaemonRequest {
  readonly schema_version: string;
  readonly id: string;
  readonly type: DaemonRequestType;
  readonly worktree: string;
  readonly project_root: string;
  readonly identity_sha256: string;
  readonly head?: string;
  readonly tree_digest?: string;
  readonly environment?: Readonly<Record<string, string | null>>;
  readonly selected_tests?: readonly string[];
  readonly input_closure_sha256?: string;
  readonly timeout_ms?: number;
  readonly command_argv?: readonly string[];
}

export class DaemonProtocolError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonProtocolError';
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HEAD_PATTERN = /^[0-9a-f]{7,40}$/;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const RELATIVE_PATH_PATTERN = /^[^/\0]|^src\//; // starter char, no NULs
const RELATIVE_TEST_PATH_PATTERN =
  /^(?!\/)(?!\.\.(\/|$))[\w./@-]+$/;

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical JSON: sorted object keys, no whitespace — digest-stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function digestCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  context: string,
): void {
  for (const field of fields) {
    if (!(field in value)) {
      throw new DaemonProtocolError(
        'malformed_request',
        `${context}: missing field ${JSON.stringify(field)}`,
      );
    }
  }
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new DaemonProtocolError(
        'malformed_request',
        `${context}: unknown field ${JSON.stringify(key)}`,
      );
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  context: string,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DaemonProtocolError(
      'malformed_request',
      `${context}: field ${JSON.stringify(field)} must be a non-empty string`,
    );
  }
  if (pattern && !pattern.test(value)) {
    throw new DaemonProtocolError(
      'malformed_request',
      `${context}: field ${JSON.stringify(field)} failed its format constraint`,
    );
  }
  return value;
}

const REQUEST_FIELDS_BY_TYPE: Record<DaemonRequestType, readonly string[]> = {
  status: [
    'schema_version',
    'id',
    'type',
    'worktree',
    'project_root',
    'identity_sha256',
  ],
  stop: [
    'schema_version',
    'id',
    'type',
    'worktree',
    'project_root',
    'identity_sha256',
  ],
  run: [
    'schema_version',
    'id',
    'type',
    'worktree',
    'project_root',
    'identity_sha256',
    'head',
    'tree_digest',
    'environment',
    'selected_tests',
    'input_closure_sha256',
    'timeout_ms',
    'command_argv',
  ],
};

/**
 * Strict request validation. Throws {@link DaemonProtocolError} with a
 * cold-fallback error code on any skew, unknown field, or type violation.
 */
export function parseDaemonRequest(raw: string): DaemonRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new DaemonProtocolError(
      'malformed_request',
      `request is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!isPlainObject(value)) {
    throw new DaemonProtocolError('malformed_request', 'request must be a JSON object');
  }
  const context = 'request';
  requireFields(value, ['schema_version', 'id', 'type'], context);
  if (value.schema_version !== DAEMON_REQUEST_SCHEMA) {
    throw new DaemonProtocolError(
      'protocol_skew',
      `request schema ${JSON.stringify(String(value.schema_version))} is not ${DAEMON_REQUEST_SCHEMA}; restart the daemon and retry cold`,
    );
  }
  const type = requireString(value.type, 'type', context) as DaemonRequestType;
  if (!['status', 'run', 'stop'].includes(type)) {
    throw new DaemonProtocolError(
      'malformed_request',
      `${context}: unknown type ${JSON.stringify(type)}`,
    );
  }
  rejectUnknownFields(value, REQUEST_FIELDS_BY_TYPE[type], context);
  requireFields(value, REQUEST_FIELDS_BY_TYPE[type], context);
  requireString(value.id, 'id', context, ID_PATTERN);
  requireString(value.worktree, 'worktree', context);
  if (!path.isAbsolute(value.worktree as string)) {
    throw new DaemonProtocolError(
      'malformed_request',
      'worktree must be an absolute path',
    );
  }
  requireString(value.project_root, 'project_root', context);
  if (!path.isAbsolute(value.project_root as string)) {
    throw new DaemonProtocolError(
      'malformed_request',
      'project_root must be an absolute path',
    );
  }
  requireString(value.identity_sha256, 'identity_sha256', context, SHA256_PATTERN);

  const request: DaemonRequest = {
    schema_version: value.schema_version as string,
    id: value.id as string,
    type,
    worktree: value.worktree as string,
    project_root: value.project_root as string,
    identity_sha256: value.identity_sha256 as string,
  };

  if (type === 'run') {
    const head = requireString(value.head, 'head', context, HEAD_PATTERN);
    const tree_digest = requireString(
      value.tree_digest,
      'tree_digest',
      context,
      SHA256_PATTERN,
    );
    const environmentValue = value.environment;
    if (!isPlainObject(environmentValue)) {
      throw new DaemonProtocolError(
        'malformed_request',
        'environment must be an object keyed by binding variable',
      );
    }
    const bound: Record<string, string | null> = {};
    for (const key of Object.keys(environmentValue).sort()) {
      if (!(ENVIRONMENT_BINDING_KEYS as readonly string[]).includes(key)) {
        throw new DaemonProtocolError(
          'malformed_request',
          `environment key ${JSON.stringify(key)} is not a bindable variable`,
        );
      }
      const entry = environmentValue[key];
      if (entry !== null && typeof entry !== 'string') {
        throw new DaemonProtocolError(
          'malformed_request',
          `environment[${JSON.stringify(key)}] must be a string or null`,
        );
      }
      bound[key] = entry as string | null;
    }
    for (const key of ENVIRONMENT_BINDING_KEYS) {
      if (!(key in bound)) {
        throw new DaemonProtocolError(
          'malformed_request',
          `environment is missing binding for ${JSON.stringify(key)}`,
        );
      }
    }
    const environment: Readonly<Record<string, string | null>> = bound;
    const selected = value.selected_tests;
    if (!Array.isArray(selected) || selected.length === 0) {
      throw new DaemonProtocolError(
        'malformed_request',
        'selected_tests must be a non-empty array of relative test paths',
      );
    }
    if (selected.length > MAX_RESULT_FILES) {
      throw new DaemonProtocolError(
        'malformed_request',
        `selected_tests exceeds ${MAX_RESULT_FILES} entries; narrow the selection`,
      );
    }
    const seen = new Set<string>();
    for (const entry of selected) {
      const testPath = requireString(entry, 'selected_tests[]', context);
      if (
        !RELATIVE_TEST_PATH_PATTERN.test(testPath) ||
        testPath.includes('\0') ||
        testPath.includes('..')
      ) {
        throw new DaemonProtocolError(
          'malformed_request',
          `selected_tests entry ${JSON.stringify(testPath)} must be a relative path inside the project root`,
        );
      }
      if (seen.has(testPath)) {
        throw new DaemonProtocolError(
          'malformed_request',
          `selected_tests contains duplicate entry ${JSON.stringify(testPath)}`,
        );
      }
      seen.add(testPath);
    }
    const selected_tests = selected as string[];

    const input_closure_sha256 = requireString(
      value.input_closure_sha256,
      'input_closure_sha256',
      context,
      SHA256_PATTERN,
    );
    const timeout_ms = (() => {
      const t = value.timeout_ms;
      if (
        typeof t !== 'number' ||
        !Number.isSafeInteger(t) ||
        t < 1_000 ||
        t > 3_600_000
      ) {
        throw new DaemonProtocolError(
          'malformed_request',
          'timeout_ms must be an integer in [1000, 3600000]',
        );
      }
      return t;
    })();
    const argv = value.command_argv;
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new DaemonProtocolError(
        'malformed_request',
        'command_argv must be a non-empty array',
      );
    }
    for (const entry of argv) {
      requireString(entry, 'command_argv[]', context);
    }
    const command_argv = argv as string[];
    return {
      ...request,
      head,
      tree_digest,
      environment,
      selected_tests,
      input_closure_sha256,
      timeout_ms,
      command_argv,
    };
  }
  return request;
}

/**
 * Validate a parsed response frame on the client. The daemon is untrusted
 * advisory infrastructure: malformed results never become success.
 */
export function parseDaemonResponse(raw: string): DaemonResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new DaemonProtocolError(
      'malformed_request',
      `response is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!isPlainObject(value)) {
    throw new DaemonProtocolError('malformed_request', 'response must be a JSON object');
  }
  const context = 'response';
  requireFields(
    value,
    ['schema_version', 'id', 'type', 'advisory', 'outcome', 'request_id'],
    context,
  );
  if (value.schema_version !== DAEMON_RESPONSE_SCHEMA) {
    throw new DaemonProtocolError(
      'protocol_skew',
      `response schema ${JSON.stringify(String(value.schema_version))} is not ${DAEMON_RESPONSE_SCHEMA}`,
    );
  }
  if (value.advisory !== true) {
    throw new DaemonProtocolError(
      'malformed_request',
      'response must carry advisory=true; daemon results are never authoritative',
    );
  }
  const allowed = [
    'schema_version',
    'id',
    'type',
    'advisory',
    'outcome',
    'request_id',
    'results',
    'identity_recheck',
    'timings_ms',
    'error',
    'daemon',
    'notice',
  ];
  rejectUnknownFields(value, allowed, context);
  const base = {
    schema_version: value.schema_version as string,
    id: requireString(value.id, 'id', context, ID_PATTERN),
    type: value.type as DaemonResponse['type'],
    advisory: true as const,
    outcome: value.outcome as DaemonResponse['outcome'],
    request_id: requireString(value.request_id, 'request_id', context, ID_PATTERN),
  };
  if (!['status', 'run', 'stop', 'error'].includes(base.type)) {
    throw new DaemonProtocolError('malformed_request', `unknown response type`);
  }
  if (
    ![
      'completed',
      'no_tests',
      'invalidated',
      'stopping',
      'status',
      'error',
    ].includes(base.outcome)
  ) {
    throw new DaemonProtocolError('malformed_request', `unknown response outcome`);
  }
  let errorBody: NonNullable<DaemonResponse['error']> | undefined;
  if (base.type === 'error') {
    const error = value.error;
    if (!isPlainObject(error)) {
      throw new DaemonProtocolError('malformed_request', 'error responses need an error body');
    }
    rejectUnknownFields(error, ['code', 'message', 'cold_fallback'], 'response.error');
    if (error.cold_fallback !== true) {
      throw new DaemonProtocolError(
        'malformed_request',
        'error.cold_fallback must be true',
      );
    }
    errorBody = {
      code: requireString(error.code, 'error.code', context) as DaemonErrorCode,
      message: requireString(error.message, 'error.message', context),
      cold_fallback: true,
    };
  }
  const results = value.results !== undefined ? parseRunResults(value.results) : undefined;
  const timings = isPlainObject(value.timings_ms)
    ? (value.timings_ms as unknown as DaemonResponse['timings_ms'])
    : undefined;
  const daemon = value.daemon !== undefined ? parseStatusBody(value.daemon) : undefined;
  return {
    ...base,
    ...(errorBody ? { error: errorBody } : {}),
    ...(results ? { results } : {}),
    ...(timings ? { timings_ms: timings } : {}),
    ...(daemon ? { daemon } : {}),
  };
}

function parseStatusBody(value: unknown): NonNullable<DaemonResponse['daemon']> {
  if (!isPlainObject(value)) {
    throw new DaemonProtocolError('malformed_request', 'daemon status body must be an object');
  }
  rejectUnknownFields(
    value,
    [
      'pid',
      'started_at',
      'protocol_version',
      'identity_sha256',
      'requests_served',
      'runs_served',
      'idle_shutdown_at',
      'runner',
    ],
    'response.daemon',
  );
  requireFields(
    value,
    [
      'pid',
      'started_at',
      'protocol_version',
      'identity_sha256',
      'requests_served',
      'runs_served',
      'idle_shutdown_at',
      'runner',
    ],
    'response.daemon',
  );
  const runner = value.runner;
  if (!isPlainObject(runner)) {
    throw new DaemonProtocolError('malformed_request', 'daemon.runner must be an object');
  }
  return {
    pid: requireCount(value.pid, 'daemon.pid', 'response.daemon'),
    started_at: requireString(value.started_at, 'daemon.started_at', 'response.daemon'),
    protocol_version: requireString(value.protocol_version, 'daemon.protocol_version', 'response.daemon'),
    identity_sha256: requireString(value.identity_sha256, 'daemon.identity_sha256', 'response.daemon', SHA256_PATTERN),
    requests_served: requireCount(value.requests_served, 'daemon.requests_served', 'response.daemon'),
    runs_served: requireCount(value.runs_served, 'daemon.runs_served', 'response.daemon'),
    idle_shutdown_at: requireString(value.idle_shutdown_at, 'daemon.idle_shutdown_at', 'response.daemon'),
    runner: {
      kind: requireString(runner.kind, 'daemon.runner.kind', 'response.daemon'),
      version: requireString(runner.version, 'daemon.runner.version', 'response.daemon'),
    },
  };
}

function parseRunResults(value: unknown): DaemonRunResults {
  if (!isPlainObject(value)) {
    throw new DaemonProtocolError('malformed_request', 'results must be an object');
  }
  rejectUnknownFields(
    value,
    ['files', 'totals', 'exit_code', 'results_digest'],
    'response.results',
  );
  requireFields(value, ['files', 'totals', 'exit_code', 'results_digest'], 'response.results');
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new DaemonProtocolError('malformed_request', 'results.files must be a non-empty array');
  }
  if (value.files.length > MAX_RESULT_FILES) {
    throw new DaemonProtocolError(
      'malformed_request',
      `results.files exceeds ${MAX_RESULT_FILES} entries`,
    );
  }
  const files: DaemonFileResult[] = [];
  for (const entry of value.files) {
    if (!isPlainObject(entry)) {
      throw new DaemonProtocolError('malformed_request', 'results.files[] must be objects');
    }
    rejectUnknownFields(
      entry,
      ['path', 'status', 'tests', 'failed', 'duration_ms', 'failures'],
      'response.results.files[]',
    );
    requireFields(
      entry,
      ['path', 'status', 'tests', 'failed', 'duration_ms', 'failures'],
      'response.results.files[]',
    );
    const fileResult: DaemonFileResult = {
      path: requireString(entry.path, 'files[].path', 'response.results'),
      status: requireString(entry.status, 'files[].status', 'response.results') as DaemonFileResult['status'],
      tests: requireCount(entry.tests, 'files[].tests', 'response.results'),
      failed: requireCount(entry.failed, 'files[].failed', 'response.results'),
      duration_ms:
        typeof entry.duration_ms === 'number' && Number.isFinite(entry.duration_ms)
          ? entry.duration_ms
          : 0,
      failures: Array.isArray(entry.failures)
        ? entry.failures.map((failure) =>
            typeof failure === 'string' ? failure.slice(0, MAX_FAILURE_MESSAGE_CHARS) : '',
          )
        : [],
    };
    if (!['passed', 'failed', 'skipped', 'todo'].includes(fileResult.status)) {
      throw new DaemonProtocolError('malformed_request', 'files[].status is unknown');
    }
    if (!RELATIVE_PATH_PATTERN.test(fileResult.path) || fileResult.path.startsWith('..')) {
      throw new DaemonProtocolError(
        'malformed_request',
        'files[].path must be relative to the project root',
      );
    }
    files.push(fileResult);
  }
  const totalsValue = value.totals;
  if (!isPlainObject(totalsValue)) {
    throw new DaemonProtocolError('malformed_request', 'results.totals must be an object');
  }
  rejectUnknownFields(
    totalsValue,
    ['files', 'tests', 'passed', 'failed', 'skipped'],
    'response.results.totals',
  );
  const totals: DaemonRunTotals = {
    files: requireCount(totalsValue.files, 'totals.files', 'response.results'),
    tests: requireCount(totalsValue.tests, 'totals.tests', 'response.results'),
    passed: requireCount(totalsValue.passed, 'totals.passed', 'response.results'),
    failed: requireCount(totalsValue.failed, 'totals.failed', 'response.results'),
    skipped: requireCount(totalsValue.skipped, 'totals.skipped', 'response.results'),
  };
  if (totals.files !== files.length) {
    throw new DaemonProtocolError(
      'malformed_request',
      'results.totals.files does not match results.files length',
    );
  }
  const digest = requireString(
    value.results_digest,
    'results.results_digest',
    'response.results',
    SHA256_PATTERN,
  );
  if (digest !== digestCanonical(files)) {
    throw new DaemonProtocolError(
      'malformed_request',
      'results_digest does not match the canonical digest of results.files',
    );
  }
  const exitCode = value.exit_code;
  if (typeof exitCode !== 'number' || ![0, 1].includes(exitCode)) {
    throw new DaemonProtocolError(
      'malformed_request',
      'results.exit_code must be 0 or 1',
    );
  }
  return { files, totals, exit_code: exitCode, results_digest: digest };
}

function requireCount(value: unknown, field: string, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DaemonProtocolError(
      'malformed_request',
      `${context}: field ${JSON.stringify(field)} must be a non-negative integer`,
    );
  }
  return value;
}
