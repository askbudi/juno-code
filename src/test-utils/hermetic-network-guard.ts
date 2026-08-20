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

function refuse(kind: string, target: string): never {
  const message = `[hermeticity] admission tests must not use the network: ${kind} -> ${target}. `
    + 'Serve the fixture from the local filesystem or a loopback in-process fake. '
    + 'Explicit override (never in admission lanes): JUNO_TEST_ALLOW_NETWORK=1.';
  throw new Error(message);
}

if (!allowNetwork) {
  // Patching the prototype method covers net.createConnection, net.connect,
  // and every higher-level client (undici/http) because they all funnel new
  // outbound connections through Socket.prototype.connect. The module exports
  // themselves are read-only in ESM and cannot be reassigned.
  const originalSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function hermeticConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    const options = args.find((arg) => typeof arg === 'object' && arg !== null);
    const isUnix = typeof options === 'object'
      && options !== null
      && typeof (options as Record<string, unknown>).path === 'string';
    if (!isUnix) refuse('net.Socket.connect', describeTarget(options));
    return (originalSocketConnect as (...a: unknown[]) => unknown).apply(this, args);
  };
}

export const hermeticNetworkGuardActive = !allowNetwork;
