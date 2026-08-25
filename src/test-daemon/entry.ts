/**
 * Daemon child-process entry (Wave 2 of PDR 7djT8N).
 *
 * The daemon is spawned as the same CLI surface that launched it (`yy test
 * daemon _serve`), so source checkouts and installed packages route through
 * identical code. It reads its frozen identity, serves the socket, keeps a
 * bounded log, publishes `run.json`, and always removes its socket on exit.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { TestDaemonServer, type DaemonRunFileState } from './server.js';
import { resolveProjectVitestVersion, VitestWarmRunner } from './warm-runner.js';
import { daemonLayoutFor } from './paths.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonIdentity } from './protocol.js';
import { daemonStatus } from './client.js';

const MARKER = 'yylo-test-daemon-serve';

export async function runDaemonServe(argv: readonly string[]): Promise<number> {
  const identityFile = readOption(argv, '--identity-file');
  if (!identityFile) {
    process.stderr.write('usage: yy test daemon _serve --identity-file <path>\n');
    return 2;
  }
  const identity = JSON.parse(
    fs.readFileSync(identityFile, 'utf8'),
  ) as DaemonIdentity;
  if (identity.protocol_version !== DAEMON_PROTOCOL_VERSION) {
    process.stderr.write(
      `identity protocol ${identity.protocol_version} is not ${DAEMON_PROTOCOL_VERSION}\n`,
    );
    return 2;
  }
  const layout = daemonLayoutFor(identity.identity_sha256);
  // Refuse to shadow a live daemon for this identity: a serving listener
  // owns the socket, and a second child must exit deterministically.
  const live = await daemonStatus(identity).then(
    () => true,
    () => false,
  );
  if (live) {
    process.stderr.write(
      `daemon for identity ${identity.identity_sha256.slice(0, 12)} is already serving; refusing a second child\n`,
    );
    return 3;
  }
  // Pin NODE_ENV before Vite initializes: Vitest's cold child pins 'test'
  // when unset, and the warm daemon must not drift to Vite's 'development'.
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
  fs.mkdirSync(layout.directory, { recursive: true });
  fs.copyFileSync(identityFile, layout.identityPath);
  const logStream = fs.createWriteStream(layout.logPath, { flags: 'a' });
  const log = (line: string): void => {
    try {
      logStream.write(`${new Date().toISOString()} ${line}\n`);
      trimLogIfLarge(layout.logPath);
    } catch {
      // Logging must never break serving.
    }
  };

  const version = await resolveProjectVitestVersion(identity.project_root);
  const typedRunner = new VitestWarmRunner(identity.project_root, version);

  const idleTimeoutMs = readNumberOption(argv, '--idle-timeout-ms');
  const maxRequests = readNumberOption(argv, '--max-requests');
  const server = new TestDaemonServer({
    identity,
    runner: typedRunner,
    log,
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(maxRequests !== undefined ? { maxRequests } : {}),
  });

  const writeRunFile = (state: DaemonRunFileState['state']): void => {
    const payload = server.runFileState(state);
    const temporary = `${layout.runJsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(temporary, layout.runJsonPath);
  };

  process.on('SIGTERM', () => {
    log('SIGTERM received');
    void server.shutdown('sigterm').finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void server.shutdown('sigint').finally(() => process.exit(0));
  });
  process.on('exit', () => {
    try {
      fs.rmSync(layout.socketPath, { force: true });
    } catch {
      // Best effort; clients also recover stale sockets.
    }
  });

  writeRunFile('starting');
  try {
    await server.listen(layout.socketPath, async () => {
      writeRunFile('serving');
      log(
        `${MARKER} identity=${identity.identity_sha256.slice(0, 12)} project=${identity.project_root}`,
      );
    });
  } catch (error) {
    log(`listen failed: ${(error as Error).stack ?? error}`);
    writeRunFile('stopped');
    return 1;
  }
  writeRunFile('stopped');
  return 0;
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : undefined;
}

function readNumberOption(argv: readonly string[], name: string): number | undefined {
  const raw = readOption(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function trimLogIfLarge(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 8 * 1024 * 1024) {
      const content = fs.readFileSync(logPath, 'utf8');
      const kept = content.slice(Math.floor(content.length / 2));
      fs.writeFileSync(logPath, kept);
    }
  } catch {
    // Diagnostic only.
  }
}

/**
 * Spawn the daemon child for the current CLI surface. Source checkouts
 * (`.ts` entry under tsx) and installed bundles (`.mjs`/`.js`) route
 * consistently: the child re-executes the exact entry that is running now.
 */
export function spawnDaemonChild(options: {
  identityFile: string;
  projectRoot: string;
  idleTimeoutMs?: number;
  maxRequests?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: explicit CLI entry (source or installed) to re-execute. */
  entryOverride?: string;
}): ReturnType<typeof spawn> {
  const entry = options.entryOverride ?? process.argv[1];
  if (!entry) throw new Error('cannot determine the current CLI entry for the daemon child');
  const isTypeScriptEntry = entry.endsWith('.ts');
  const args = isTypeScriptEntry
    ? ['--import', 'tsx', entry, 'test', 'daemon', '_serve', '--identity-file', options.identityFile]
    : [entry, 'test', 'daemon', '_serve', '--identity-file', options.identityFile];
  if (options.idleTimeoutMs !== undefined) {
    args.push('--idle-timeout-ms', String(options.idleTimeoutMs));
  }
  if (options.maxRequests !== undefined) {
    args.push('--max-requests', String(options.maxRequests));
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
    YYLO_TEST_DAEMON_CHILD: MARKER,
  };
  const child = spawn(process.execPath, args, {
    cwd: options.projectRoot,
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();
  return child;
}
