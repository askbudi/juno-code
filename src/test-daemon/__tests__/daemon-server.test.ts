/**
 * Daemon server lifecycle and fail-safety tests (Wave 2 of PDR 7djT8N).
 * A fake warm runner exercises the protocol core: identity recheck before
 * dispatch and after completion, closure drift, environment mismatch, tree
 * races, busy serialization, managed-install lease ordering, bounded
 * resource limits, and stop semantics.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inputClosureDigest } from '../identity.js';
import { TestDaemonServer, requestIntersectsManagedInstallPool } from '../server.js';
import {
  DAEMON_REQUEST_SCHEMA,
  digestCanonical,
  ENVIRONMENT_BINDING_KEYS,
  sha256Hex,
  type DaemonIdentity,
  type DaemonRunResults,
} from '../protocol.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

/** Closure digest the server will compute for the fake project root. */
const CLOSURE_PROMISE = inputClosureDigest(
  '/wt/juno-code',
  ['src/a.test.ts'],
  { sha256: sha256Hex('runtime'), inputs: [] },
);

function identity(worktree: string, projectRoot: string): DaemonIdentity {
  return {
    protocol_version: 'juno.test.daemon.protocol.v1',
    repository_root: worktree,
    worktree,
    project_root: projectRoot,
    dependency_lock: { path: 'package-lock.json', sha256: sha256Hex('lock') },
    runtime_generation: { sha256: sha256Hex('runtime'), inputs: [] },
    toolchain: { node: process.versions.node, platform: 'darwin', arch: 'arm64' },
    identity_sha256: sha256Hex(worktree + projectRoot),
  };
}

function results(failed = 0): DaemonRunResults {
  const files = [
    {
      path: 'src/a.test.ts',
      status: failed > 0 ? 'failed' : 'passed',
      tests: 2,
      failed,
      duration_ms: 5,
      failures: failed > 0 ? ['boom'] : [],
    },
  ];
  return {
    files,
    totals: { files: 1, tests: 2, passed: 2 - failed, failed, skipped: 0 },
    exit_code: failed > 0 ? 1 : 0,
    results_digest: digestCanonical(files),
  };
}

function runRequest(
  id: string,
  overrides: Record<string, unknown> = {},
  closure: string | undefined = undefined,
): Promise<string> {
  const selected = (overrides.selected_tests as string[] | undefined) ?? [
    'src/a.test.ts',
  ];
  const closurePromise = closure
    ? Promise.resolve(closure)
    : inputClosureDigest(
        '/wt/juno-code',
        selected,
        { sha256: sha256Hex('runtime'), inputs: [] },
      );
  return closurePromise.then((expected) =>
    JSON.stringify({
      schema_version: DAEMON_REQUEST_SCHEMA,
      id,
      type: 'run',
      worktree: '/wt',
      project_root: '/wt/juno-code',
      identity_sha256: identity('/wt', '/wt/juno-code').identity_sha256,
      head: HEAD,
      tree_digest: sha256Hex('tree'),
      environment: Object.fromEntries(ENVIRONMENT_BINDING_KEYS.map((key) => [key, null])),
      selected_tests: selected,
      input_closure_sha256: closure ?? expected,
      timeout_ms: 60_000,
      command_argv: ['npm', 'test', '--', 'src/a.test.ts'],
      ...overrides,
    }),
  );
}

function statusRequest(id: string): string {
  return JSON.stringify({
    schema_version: DAEMON_REQUEST_SCHEMA,
    id,
    type: 'status',
    worktree: '/wt',
    project_root: '/wt/juno-code',
    identity_sha256: identity('/wt', '/wt/juno-code').identity_sha256,
  });
}

interface FakeRunner {
  runCalls: number;
  leaseAcquires: number;
  failNext: Error | null;
}

function makeServer(overrides: {
  tree?: () => Promise<{ head: string; digest: string }>;
  environment?: () => Record<string, string | null>;
  runner?: Partial<FakeRunner>;
  maxRequests?: number;
} = {}): { server: TestDaemonServer; fake: FakeRunner } {
  const fake: FakeRunner = {
    runCalls: 0,
    leaseAcquires: 0,
    failNext: null,
    ...overrides.runner,
  };
  const server = new TestDaemonServer({
    identity: identity('/wt', '/wt/juno-code'),
    runner: {
      kind: 'fake',
      version: '0',
      initialize: async () => undefined,
      run: async () => {
        fake.runCalls += 1;
        if (fake.failNext) {
          const error = fake.failNext;
          fake.failNext = null;
          throw error;
        }
        return results();
      },
      cancel: async () => undefined,
      close: async () => undefined,
    },
    treeSnapshot:
      overrides.tree ??
      (async () => ({ head: HEAD, digest: sha256Hex('tree') })),
    environmentBinding:
      overrides.environment ?? (() => Object.fromEntries(
        ENVIRONMENT_BINDING_KEYS.map((key) => [key, null]),
      )),
    acquireManagedInstallLease: async () => {
      fake.leaseAcquires += 1;
      return { release: async () => undefined };
    },
    ...(overrides.maxRequests !== undefined ? { maxRequests: overrides.maxRequests } : {}),
  });
  return { server, fake };
}

describe('daemon server protocol core', () => {
  it('serves status with counters under bounded work', async () => {
    const { server } = makeServer();
    const response = JSON.parse(await server.handleRequest(statusRequest('s1')));
    expect(response.type).toBe('status');
    expect(response.daemon.pid).toBe(process.pid);
    expect(response.daemon.protocol_version).toBe('juno.test.daemon.protocol.v1');
  });

  it('executes a warm run with stable identity rechecks', async () => {
    const { server, fake } = makeServer();
    const response = JSON.parse(await server.handleRequest(await runRequest('r1')));
    expect(fake.runCalls).toBe(1);
    expect(response.outcome).toBe('completed');
    expect(response.identity_recheck.stable).toBe(true);
    expect(response.advisory).toBe(true);
    expect(response.results.totals.tests).toBe(2);
  });

  it('rejects identity mismatch without dispatching', async () => {
    const { server, fake } = makeServer();
    const response = JSON.parse(
      await server.handleRequest(
        await runRequest('r2', { identity_sha256: sha256Hex('other-daemon') }),
      ),
    );
    expect(response.type).toBe('error');
    expect(response.error.code).toBe('identity_mismatch');
    expect(response.error.cold_fallback).toBe(true);
    expect(fake.runCalls).toBe(0);
  });

  it('rejects environment mismatch between request and daemon', async () => {
    const { server } = makeServer();
    const response = JSON.parse(
      await server.handleRequest(
        await runRequest('r3', {
          environment: Object.fromEntries(
            ENVIRONMENT_BINDING_KEYS.map((key) => [
              key,
              key === 'CI' ? 'true' : null,
            ]),
          ),
        }),
      ),
    );
    expect(response.error.code).toBe('environment_mismatch');
  });

  it('rejects a tree race between request and dispatch', async () => {
    const { server, fake } = makeServer({
      tree: async () => ({ head: HEAD, digest: sha256Hex('mutated-tree') }),
    });
    const response = JSON.parse(await server.handleRequest(await runRequest('r4')));
    expect(response.error.code).toBe('tree_race');
    expect(fake.runCalls).toBe(0);
  });

  it('rejects a stale input closure', async () => {
    const { server, fake } = makeServer();
    const response = JSON.parse(
      await server.handleRequest(await runRequest('r5', {}, sha256Hex('older-closure'))),
    );
    expect(response.error.code).toBe('stale_closure');
    expect(fake.runCalls).toBe(0);
  });

  it('invalidates results when the tree mutates during the run', async () => {
    let call = 0;
    const { server } = makeServer({
      tree: async () => {
        call += 1;
        return call <= 1
          ? { head: HEAD, digest: sha256Hex('tree') }
          : { head: HEAD, digest: sha256Hex('changed-mid-run') };
      },
    });
    const response = JSON.parse(await server.handleRequest(await runRequest('r6')));
    expect(response.outcome).toBe('invalidated');
    expect(response.identity_recheck.stable).toBe(false);
    expect(response.notice).toContain('advisory-only');
  });

  it('serializes managed-install selections through the lease', async () => {
    const { server, fake } = makeServer();
    const response = JSON.parse(
      await server.handleRequest(
        await runRequest('r7', {
          selected_tests: ['src/utils/__tests__/script-installer.test.ts'],
        }),
      ),
    );
    expect(response.outcome).toBe('completed');
    expect(fake.leaseAcquires).toBe(1);
    const ordinary = JSON.parse(await server.handleRequest(await runRequest('r8')));
    expect(ordinary.outcome).toBe('completed');
    expect(fake.leaseAcquires).toBe(1);
  });

  it('reports busy while another run is in flight', async () => {
    const gate = (() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    const fake: FakeRunner = { runCalls: 0, leaseAcquires: 0, failNext: null };
    const server = new TestDaemonServer({
      identity: identity('/wt', '/wt/juno-code'),
      runner: {
        kind: 'fake',
        version: '0',
        initialize: async () => undefined,
        run: async () => {
          fake.runCalls += 1;
          await gate.promise;
          return results();
        },
        cancel: async () => undefined,
        close: async () => undefined,
      },
      treeSnapshot: async () => ({ head: HEAD, digest: sha256Hex('tree') }),
      environmentBinding: () =>
        Object.fromEntries(ENVIRONMENT_BINDING_KEYS.map((key) => [key, null])),
      acquireManagedInstallLease: async () => ({ release: async () => undefined }),
    });
    const first = server.handleRequest(await runRequest('r9'));
    const concurrent = JSON.parse(await server.handleRequest(await runRequest('r10')));
    expect(concurrent.error.code).toBe('busy');
    gate.release();
    const settled = JSON.parse(await first);
    expect(settled.outcome).toBe('completed');
  });

  it('poisons and stops the daemon after a runner failure', async () => {
    const { server, fake } = makeServer();
    fake.failNext = new Error('warm instance exploded');
    const response = JSON.parse(await server.handleRequest(await runRequest('r11')));
    expect(response.error.code).toBe('internal_error');
    expect(response.error.message).toContain('restarting');
    expect(server.isStopping).toBe(true);
    const after = JSON.parse(await server.handleRequest(await runRequest('r12')));
    expect(after.error.code).toBe('busy');
  });

  it('acknowledges stop and stops serving', async () => {
    const { server } = makeServer();
    const response = JSON.parse(
      await server.handleRequest(
        JSON.stringify({
          schema_version: DAEMON_REQUEST_SCHEMA,
          id: 'stop1',
          type: 'stop',
          worktree: '/wt',
          project_root: '/wt/juno-code',
          identity_sha256: identity('/wt', '/wt/juno-code').identity_sha256,
        }),
      ),
    );
    expect(response.outcome).toBe('stopping');
    expect(server.isStopping).toBe(true);
  });

  it('reports malformed requests without crashing', async () => {
    const { server } = makeServer();
    const response = JSON.parse(await server.handleRequest('{not json'));
    expect(response.error.code).toBe('malformed_request');
  });
});

describe('managed-install pool matching', () => {
  it('matches exactly the shared real-Git install suites', () => {
    expect(
      requestIntersectsManagedInstallPool(['src/utils/__tests__/a.test.ts']),
    ).toBe(false);
    expect(
      requestIntersectsManagedInstallPool([
        'src/utils/__tests__/managed-project-assets.test.ts',
      ]),
    ).toBe(true);
    expect(
      requestIntersectsManagedInstallPool(['src/utils/__tests__/script-installer.test.ts']),
    ).toBe(true);
  });
});

describe('daemon socket serving', () => {
  const socketDir = path.join(os.tmpdir(), `yylo-daemon-socket-${process.pid}`);
  let server: TestDaemonServer;
  let socketPath: string;

  beforeAll(async () => {
    const made = makeServer();
    server = made.server;
    socketPath = path.join(socketDir, 'socket');
    // Serve in the background; the test client exercises the real framing.
    void server.listen(socketPath, () => undefined);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fs.access(socketPath).then(() => true).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  afterAll(async () => {
    await server.shutdown('test-complete');
    await fs.rm(socketDir, { recursive: true, force: true });
  });

  it('serves framed requests over the Unix socket', async () => {
    const { connect } = await import('node:net');
    const response: string = await new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let buffer = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`${statusRequest('sock1')}\n`));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline !== -1) {
          socket.end();
          resolve(buffer.slice(0, newline));
        }
      });
    });
    const parsed = JSON.parse(response);
    expect(parsed.type).toBe('status');
    expect(parsed.daemon.pid).toBe(process.pid);
  });
});

describe('bounded run file state', () => {
  it('tracks counters and the runner identity', async () => {
    const { server } = makeServer();
    await server.handleRequest(statusRequest('f1'));
    const state = server.runFileState('serving');
    expect(state.schema_version).toBe('juno.test.daemon.run.v1');
    expect(state.requests_served).toBe(1);
    expect(state.runner.kind).toBe('fake');
  });
});
