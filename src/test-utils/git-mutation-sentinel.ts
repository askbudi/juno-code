import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitMutationSnapshot {
  identity: string;
  root: string;
  head: string;
  indexSha256: string;
  indexEntriesSha256: string;
  indexPathMetadata: Record<string, string>;
  status: string;
  statusPaths: string[];
  trackedFiles: Record<string, string>;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function captureGitMutationSnapshot(identity: string, candidateRoot: string): GitMutationSnapshot {
  const root = fs.realpathSync(git(candidateRoot, ['rev-parse', '--show-toplevel']).trim());
  const indexPathText = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  const indexPath = path.resolve(root, indexPathText);
  // Null-prototype maps preserve every valid Git path, including JavaScript
  // object metakeys such as `__proto__`, as ordinary own properties.
  const trackedFiles = Object.create(null) as Record<string, string>;
  const names = git(root, ['ls-files', '-z']).split('\0').filter(Boolean).sort();
  const indexPathMetadata = Object.create(null) as Record<string, string>;
  const debug = git(root, ['ls-files', '--debug', '-z']);
  let debugOffset = 0;
  for (const [index, name] of names.entries()) {
    const marker = `${name}\0`;
    if (!debug.startsWith(marker, debugOffset)) {
      throw new Error(`Juno test mutation sentinel could not map index metadata for ${name}`);
    }
    const metadataStart = debugOffset + marker.length;
    const nextMarker = index + 1 < names.length ? `\n${names[index + 1]}\0` : undefined;
    const metadataEnd = nextMarker ? debug.indexOf(nextMarker, metadataStart) + 1 : debug.length;
    if (nextMarker && metadataEnd === 0) {
      throw new Error(`Juno test mutation sentinel could not find index metadata boundary after ${name}`);
    }
    indexPathMetadata[name] = sha256(debug.slice(metadataStart, metadataEnd));
    debugOffset = metadataEnd;
  }
  for (const name of names) {
    const file = path.join(root, name);
    // A missing tracked path is part of the protected state too.
    trackedFiles[name] = fs.existsSync(file) && fs.statSync(file).isFile()
      ? sha256(fs.readFileSync(file))
      : '<missing-or-non-file>';
  }
  return {
    identity,
    root,
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    indexSha256: fs.existsSync(indexPath) ? sha256(fs.readFileSync(indexPath)) : '<missing>',
    indexEntriesSha256: sha256(git(root, ['ls-files', '--stage', '-z'])),
    indexPathMetadata,
    status: git(root, ['status', '--porcelain=v2', '--untracked-files=all']),
    statusPaths: [
      ...git(root, ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
      ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
    ].filter(Boolean).sort(),
    trackedFiles,
  };
}

export function changedGitMutationPaths(before: GitMutationSnapshot, after: GitMutationSnapshot): string[] {
  const changed = new Set<string>();
  if (before.root !== after.root) changed.add('<repository-root>');
  if (before.head !== after.head) changed.add('<HEAD>');
  if (before.indexSha256 !== after.indexSha256 || before.indexEntriesSha256 !== after.indexEntriesSha256) {
    changed.add('<index>');
    for (const name of new Set([
      ...Object.keys(before.indexPathMetadata),
      ...Object.keys(after.indexPathMetadata),
    ])) {
      if (before.indexPathMetadata[name] !== after.indexPathMetadata[name]) changed.add(name);
    }
  }
  if (before.status !== after.status) {
    changed.add('<status>');
    for (const name of new Set([...before.statusPaths, ...after.statusPaths])) changed.add(name);
  }
  for (const name of new Set([...Object.keys(before.trackedFiles), ...Object.keys(after.trackedFiles)])) {
    if (before.trackedFiles[name] !== after.trackedFiles[name]) changed.add(name);
  }
  return [...changed].sort();
}

export function assertGitMutationSnapshotsUnchanged(
  before: GitMutationSnapshot[],
  after: GitMutationSnapshot[],
): void {
  const afterByIdentity = new Map(after.map(snapshot => [snapshot.identity, snapshot]));
  const diagnostics: string[] = [];
  for (const snapshot of before) {
    const current = afterByIdentity.get(snapshot.identity);
    if (!current) {
      diagnostics.push(`${snapshot.identity} (${snapshot.root}): <identity-missing>`);
      continue;
    }
    const changed = changedGitMutationPaths(snapshot, current);
    if (changed.length) diagnostics.push(`${snapshot.identity} (${snapshot.root}): ${changed.join(', ')}`);
  }
  if (diagnostics.length) {
    throw new Error(
      'Juno test mutation sentinel refused external Git mutation; evidence was not restored:\n' +
      diagnostics.map(line => `- ${line}`).join('\n'),
    );
  }
}
