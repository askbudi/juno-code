/**
 * Admission hermeticity guard.
 *
 * Merge-queue admission results must depend only on the candidate tree. A test
 * that opens a network socket makes the suite nondeterministic: registry or
 * API latency and outages become phantom candidate failures that restart
 * whole admissions. This guard fails fast with an actionable message instead.
 *
 * Allow-list escape hatch: JUNO_TEST_ALLOW_NETWORK=1 (explicit, per-invocation;
 * no admission lane may set it). Unix domain sockets and already-connected
 * sockets are unaffected; only new network connect attempts are refused.
 */
import * as net from 'node:net';

const allowNetwork = process.env.JUNO_TEST_ALLOW_NETWORK === '1';

function describeTarget(options: unknown): string {
  if (typeof options === 'object' && options !== null) {
    const record = options as Record<string, unknown>;
    if (typeof record.host === 'string' || typeof record.port === 'number') {
      return `${String(record.host)}:${String(record.port)}`;
    }
    if (typeof record.path === 'string') return record.path;
  }
  return 'unknown target';
}

/**
 * Normalize net connect overloads the way node's normalizeArgs does:
 * connect(options[, listener]), connect(port[, host][, listener]),
 * connect(path[, listener]). Returns one canonical options object so the
 * unix/loopback exemptions apply to every call signature, fail-closed for
 * unknown forms.
 */
function normalizedConnectOptions(args: unknown[]): Record<string, unknown> {
  let first: unknown = args[0];
  let second: unknown = args[1];
  // node's internal call form passes one pre-normalized [options, listener]
  // array (used by net.createConnection / net.connect): unwrap it first.
  if (Array.isArray(first) && args.length === 1) {
    second = first[1];
    first = first[0];
  }
  if (typeof first === 'object' && first !== null) {
    const record = first as Record<string, unknown>;
    if (record.host === undefined && typeof record.port === 'number') {
      return { ...record, host: 'localhost' };
    }
    return record;
  }
  if (typeof first === 'string') return { path: first };
  if (typeof first === 'number') {
    // connect(port) with no explicit host defaults to localhost.
    return { port: first, host: typeof second === 'string' ? second : 'localhost' };
  }
  return {};
}

function isLoopbackTarget(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) return false;
  const record = options as Record<string, unknown>;
  if (record.path !== undefined) return false; // unix domain socket: always local
  // An absent host means node's implicit localhost default (object or
  // number form); only an explicit non-loopback host is external.
  const host = typeof record.host === 'string' ? record.host : 'localhost';
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

if (!allowNetwork) {
  // Patching the prototype method covers net.createConnection, net.connect,
  // and every higher-level client (undici/http) because they all funnel new
  // outbound connections through Socket.prototype.connect. The module exports
  // themselves are read-only in ESM and cannot be reassigned.
  const prototype = net.Socket.prototype as unknown as Record<string,
    (this: net.Socket, ...args: unknown[]) => unknown>;
  const originalSocketConnect = prototype.connect as (
    this: net.Socket, ...args: unknown[]) => unknown;
  prototype.connect = function hermeticConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    const options: unknown = normalizedConnectOptions(args);
    const record = options as Record<string, unknown>;
    const isUnix = typeof record.path === 'string';
    if (!isUnix && !isLoopbackTarget(options)) {
      // Preserve node's asynchronous error contract: throwing synchronously
      // through the native connect bridge aborts the process. Destroying with
      // the error emits 'error' on the next turn, which fails the calling test.
      const message = `[hermeticity] admission tests must not use the network: `
        + `net.Socket.connect -> ${describeTarget(options)}. `
        + 'Serve the fixture from the local filesystem or a loopback in-process fake. '
        + 'Explicit override (never in admission lanes): JUNO_TEST_ALLOW_NETWORK=1.';
      setImmediate(() => this.destroy(new Error(message)));
      return this;
    }
    return originalSocketConnect.apply(this, args);
  };
}

export const hermeticNetworkGuardActive = !allowNetwork;
