import * as net from 'node:net';
import * as osLike from 'node:os';
import * as pathLike from 'node:path';
import { describe, expect, it } from 'vitest';
import { hermeticNetworkGuardActive } from '../../test-utils/hermetic-network-guard.js';

async function expectRefused(invoke: () => net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = invoke();
    socket.on('error', (error: Error) => {
      try {
        expect(String(error.message)).toMatch(/admission tests must not use the network/);
        resolve();
      } catch (assertion) {
        reject(assertion);
      }
    });
    setTimeout(() => reject(new Error('refused connect produced no error event')), 5_000);
  });
}

describe('admission hermeticity guard', () => {
  it('is active in the default test environment', () => {
    expect(process.env.JUNO_TEST_ALLOW_NETWORK).toBeUndefined();
    expect(hermeticNetworkGuardActive).toBe(true);
  });

  it('refuses new network connections with an actionable message', async () => {
    await expectRefused(() => net.createConnection({ host: 'registry.npmjs.invalid', port: 443 }));
    await expectRefused(() => net.connect({ host: 'registry.npmjs.invalid', port: 443 }) as net.Socket);
    await expectRefused(() => new net.Socket().connect({ host: 'example.invalid', port: 80 }));
  });

  it('permits loopback connects for local fixtures while refusing external hosts', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const socket = new net.Socket();
      socket.on('error', () => undefined);
      expect(() => socket.connect({ host, port: 9 })).not.toThrow(
        /admission tests must not use the network/);
      socket.destroy();
    }
  });

  it('normalizes every connect overload before applying the exemptions', async () => {
    // connect(port, host): external tcp host is refused.
    await expectRefused(() => new net.Socket().connect(443, 'registry.npmjs.invalid'));
    // net.createConnection(port, host) refuses external hosts too.
    await expectRefused(() => net.createConnection(443, 'example.invalid'));
    // connect(port): defaults to localhost and really connects to a live listener.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      const loop = net.createConnection(port);
      loop.on('connect', () => { loop.destroy(); resolve(); });
      loop.on('error', reject);
    });
    // connect(path): unix domain string overload reaches a live listener.
    const socketPath = pathLike.join(osLike.tmpdir(), `juno-hermeticity-${process.pid}.sock`);
    const unixServer = net.createServer();
    await new Promise<void>((resolve) => unixServer.listen(socketPath, resolve));
    await new Promise<void>((resolve, reject) => {
      const unix = new net.Socket().connect(socketPath);
      unix.on('connect', () => { unix.destroy(); resolve(); });
      unix.on('error', reject);
    });
    unixServer.close();
    server.close();
  });

  it('keeps unix domain socket connects available for local fixtures', () => {
    const socket = new net.Socket();
    socket.on('error', () => undefined);
    // A unix connect to a nonexistent path still reaches the kernel and fails
    // with a connection error, proving the guard did not intercept it.
    expect(() => socket.connect({ path: '/nonexistent-juno-hermeticity.sock' }))
      .not.toThrow(/admission tests must not use the network/);
    socket.destroy();
  });
});
