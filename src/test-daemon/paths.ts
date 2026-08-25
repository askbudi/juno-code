/**
 * Daemon filesystem layout (Wave 2 of PDR 7djT8N).
 *
 * Every daemon owns exactly one private directory keyed by its identity
 * digest under `$(realpath tmpdir)/yylo-test-daemons/`. Concurrent task
 * worktrees resolve different identities and therefore never observe or
 * mutate each other's sockets, logs, or state files.
 */

import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DAEMON_ROOT_DIRECTORY_NAME = 'yylo-test-daemons';

export function daemonRootDirectory(
  tmpdir: string = os.tmpdir(),
): string {
  // Match the fixture-base-cache convention: survive macOS per-user tmpdir
  // aliases by resolving the physical path once.
  return path.join(realpathSync(tmpdir), DAEMON_ROOT_DIRECTORY_NAME);
}

export function daemonDirectoryFor(
  identitySha256: string,
  tmpdir: string = os.tmpdir(),
): string {
  if (!/^[0-9a-f]{64}$/.test(identitySha256)) {
    throw new Error(`daemon identity must be a sha256 digest: ${identitySha256}`);
  }
  return path.join(daemonRootDirectory(tmpdir), identitySha256);
}

/**
 * Unix-domain socket paths are bounded by the kernel (`sun_path`: 104 bytes
 * on macOS, 108 on Linux). Longer paths are silently truncated, which
 * breaks cleanup and can collide across identities, so the socket lives at
 * a short generated name: 16 identity hex characters under the daemon root,
 * or directly under the tmpdir when even that exceeds a conservative
 * 100-byte budget. State files keep the full identity digest directory.
 */
export function daemonSocketPathFor(
  identitySha256: string,
  tmpdir: string = os.tmpdir(),
): string {
  if (!/^[0-9a-f]{64}$/.test(identitySha256)) {
    throw new Error(`daemon identity must be a sha256 digest: ${identitySha256}`);
  }
  const shortName = `yylo-td-${identitySha256.slice(0, 16)}.sock`;
  const candidate = path.join(daemonRootDirectory(tmpdir), shortName);
  if (Buffer.byteLength(candidate, 'utf8') <= 100) return candidate;
  const fallback = path.join(realpathSync(tmpdir), shortName);
  if (Buffer.byteLength(fallback, 'utf8') > 100) {
    throw new Error(
      `no Unix socket path fits the kernel sun_path budget under ${tmpdir}; use the cold test path`,
    );
  }
  return fallback;
}

export interface DaemonLayout {
  readonly directory: string;
  readonly socketPath: string;
  readonly runJsonPath: string;
  readonly logPath: string;
  readonly identityPath: string;
}

export function daemonLayoutFor(
  identitySha256: string,
  tmpdir: string = os.tmpdir(),
): DaemonLayout {
  const directory = daemonDirectoryFor(identitySha256, tmpdir);
  return {
    directory,
    socketPath: daemonSocketPathFor(identitySha256, tmpdir),
    runJsonPath: path.join(directory, 'run.json'),
    logPath: path.join(directory, 'daemon.log'),
    identityPath: path.join(directory, 'identity.json'),
  };
}
