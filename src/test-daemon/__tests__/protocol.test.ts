/**
 * Protocol schema and skew tests for the advisory test daemon (Wave 2 of
 * PDR 7djT8N). Strict validation: unknown fields, wrong types, protocol
 * drift, and malformed results are rejected — never guessed.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  DAEMON_REQUEST_SCHEMA,
  digestCanonical,
  ENVIRONMENT_BINDING_KEYS,
  MAX_RESULT_FILES,
  parseDaemonRequest,
  parseDaemonResponse,
  sha256Hex,
} from '../protocol.js';

function validRunRequest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: DAEMON_REQUEST_SCHEMA,
    id: 'run-1',
    type: 'run',
    worktree: '/tmp/worktree',
    project_root: '/tmp/worktree/juno-code',
    identity_sha256: sha256Hex('identity'),
    head: '0123456789abcdef',
    tree_digest: sha256Hex('tree'),
    environment: Object.fromEntries(
      ENVIRONMENT_BINDING_KEYS.map((key) => [key, null]),
    ),
    selected_tests: ['src/utils/__tests__/environment.test.ts'],
    input_closure_sha256: sha256Hex('closure'),
    timeout_ms: 60_000,
    command_argv: ['npm', 'test', '--', 'src/utils/__tests__/environment.test.ts'],
    ...overrides,
  });
}

function passingResponse(id = 'run-1'): Record<string, unknown> {
  const files = [
    {
      path: 'src/utils/__tests__/environment.test.ts',
      status: 'passed',
      tests: 3,
      failed: 0,
      duration_ms: 120,
      failures: [],
    },
  ];
  return {
    schema_version: 'juno.test.daemon.response.v1',
    id,
    request_id: id,
    type: 'run',
    advisory: true,
    outcome: 'completed',
    results: {
      files,
      totals: { files: 1, tests: 3, passed: 3, failed: 0, skipped: 0 },
      exit_code: 0,
      results_digest: digestCanonical(files),
    },
  };
}

describe('daemon protocol request validation', () => {
  it('accepts a well-formed run request', () => {
    const request = parseDaemonRequest(validRunRequest());
    expect(request.type).toBe('run');
    expect(request.selected_tests).toEqual(['src/utils/__tests__/environment.test.ts']);
    expect(request.environment?.CI).toBeNull();
  });

  it('rejects protocol-version skew with a protocol_skew code', () => {
    expect(() =>
      parseDaemonRequest(validRunRequest({ schema_version: 'juno.test.daemon.request.v2' })),
    ).toThrowError(/protocol_skew|schema/);
  });

  it('rejects unknown fields', () => {
    expect(() => parseDaemonRequest(validRunRequest({ surprise: 1 }))).toThrowError(
      /unknown field/,
    );
  });

  it('rejects absolute or escaping selected tests', () => {
    expect(() =>
      parseDaemonRequest(validRunRequest({ selected_tests: ['/etc/passwd'] })),
    ).toThrowError(/relative path inside the project root/);
    expect(() =>
      parseDaemonRequest(validRunRequest({ selected_tests: ['../outside.test.ts'] })),
    ).toThrowError(/relative path inside the project root/);
  });

  it('rejects duplicate selected tests and oversized selections', () => {
    expect(() =>
      parseDaemonRequest(
        validRunRequest({
          selected_tests: ['a.test.ts', 'a.test.ts'],
        }),
      ),
    ).toThrowError(/duplicate/);
    expect(() =>
      parseDaemonRequest(
        validRunRequest({
          selected_tests: Array.from(
            { length: MAX_RESULT_FILES + 1 },
            (_, index) => `f${index}.test.ts`,
          ),
        }),
      ),
    ).toThrowError(/exceeds/);
  });

  it('requires every bindable environment key and rejects foreign ones', () => {
    const partial = Object.fromEntries(
      ENVIRONMENT_BINDING_KEYS.slice(0, -1).map((key) => [key, null]),
    );
    expect(() => parseDaemonRequest(validRunRequest({ environment: partial }))).toThrowError(
      /missing binding/,
    );
    expect(() =>
      parseDaemonRequest(
        validRunRequest({ environment: { ...partial, YYLO_SECRET: '1' } }),
      ),
    ).toThrowError(/not a bindable variable/);
  });

  it('rejects non-relative worktrees, bad digests, and out-of-range timeouts', () => {
    expect(() => parseDaemonRequest(validRunRequest({ worktree: 'relative/path' }))).toThrow();
    expect(() =>
      parseDaemonRequest(validRunRequest({ tree_digest: 'not-a-digest' })),
    ).toThrowError(/format constraint/);
    expect(() => parseDaemonRequest(validRunRequest({ timeout_ms: 5 }))).toThrowError(
      /timeout_ms/,
    );
  });

  it('accepts minimal status and stop requests and rejects run fields on them', () => {
    const status = parseDaemonRequest(
      JSON.stringify({
        schema_version: DAEMON_REQUEST_SCHEMA,
        id: 's1',
        type: 'status',
        worktree: '/tmp/worktree',
        project_root: '/tmp/worktree/juno-code',
        identity_sha256: sha256Hex('identity'),
      }),
    );
    expect(status.type).toBe('status');
    expect(() =>
      parseDaemonRequest(
        JSON.stringify({
          schema_version: DAEMON_REQUEST_SCHEMA,
          id: 's2',
          type: 'status',
          worktree: '/tmp/worktree',
          project_root: '/tmp/worktree/juno-code',
          identity_sha256: sha256Hex('identity'),
          head: '0123456789abcdef',
        }),
      ),
    ).toThrowError(/unknown field/);
  });
});

describe('daemon protocol response validation', () => {
  it('accepts a passing run response with a matching digest', () => {
    const response = parseDaemonResponse(JSON.stringify(passingResponse()));
    expect(response.outcome).toBe('completed');
    expect(response.advisory).toBe(true);
    expect(response.results?.totals.tests).toBe(3);
  });

  it('rejects responses that drop the advisory marker', () => {
    const frame = passingResponse();
    (frame as Record<string, unknown>).advisory = false;
    expect(() => parseDaemonResponse(JSON.stringify(frame))).toThrowError(/advisory/);
  });

  it('rejects a tampered results digest', () => {
    const frame = passingResponse();
    const results = frame.results as Record<string, unknown>;
    (results.files as Array<Record<string, unknown>>)[0].tests = 999;
    expect(() => parseDaemonResponse(JSON.stringify(frame))).toThrowError(
      /results_digest/,
    );
  });

  it('rejects malformed error bodies without a cold-fallback hint', () => {
    const frame = passingResponse();
    frame.type = 'error';
    frame.outcome = 'error';
    frame.error = { code: 'identity_mismatch', message: 'x' };
    expect(() => parseDaemonResponse(JSON.stringify(frame))).toThrowError(/cold_fallback/);
  });

  it('rejects unknown response fields and invalid JSON', () => {
    const frame = passingResponse();
    (frame as Record<string, unknown>).extra = true;
    expect(() => parseDaemonResponse(JSON.stringify(frame))).toThrowError(/unknown field/);
    expect(() => parseDaemonResponse('{nope')).toThrowError(/not valid JSON/);
  });
});

describe('canonical json digests', () => {
  it('is stable under key reordering and rejects value drift', () => {
    expect(canonicalJson({ b: 1, a: [2, { z: null, y: 's' }] })).toBe(
      canonicalJson({ a: [2, { y: 's', z: null }], b: 1 }),
    );
    expect(digestCanonical({ a: 1 })).not.toBe(digestCanonical({ a: 2 }));
  });
});
