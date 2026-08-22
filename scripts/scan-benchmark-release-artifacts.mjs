#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const canonicalJson = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalHash = (value) => sha256(canonicalJson(value));
const emptyHash = sha256('');

const SENSITIVE_ENV = /(?:TOKEN|SECRET|PASSWORD|AUTH|REGISTRY|API_KEY|^(?:HOME|XDG_))/u;
const DETECTORS = Object.freeze({
  'private-registry': /(?:registry\s*=\s*https?:\/\/(?!registry\.npmjs\.org)|https?:\/\/(?:npm|packages|registry)\.[^\s/]*(?:private|internal)[^\s/]*)/iu,
  'auth-credentials': /(?:https?:\/\/[^\s"']+@|_authToken\s*=|\b(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{16,})/iu,
  'candidate-home-xdg': /(?:\b(?:HOME|XDG_(?:CONFIG|CACHE|DATA)_HOME)\s*=\s*\/[^\s]*candidate|\/(?:candidate-home|candidate-xdg)(?:\/|\b))/iu,
  'canonical-controller-route': /(?:\/canonical-controller\/\.juno_task\/|JUNO_TASK_ROOT\s*=\s*\/[^\s]+\/controller(?:\/|\b))/iu,
  'host-paths': /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\\\Users\\\\[^\\\s]+\\\\)/u,
  'candidate-git-metadata': /(?:gitdir:\s*\/[^\s]*candidate[^\s]*\/\.git|GIT_(?:DIR|WORK_TREE)\s*=\s*\/[^\s]*candidate)/iu,
});
const SYNTHETIC_ARTIFACTS = Object.freeze({
  'private-registry': 'registry=https://npm.private.invalid/juno-release-canary/\n',
  'auth-credentials': '_authToken=juno_release_canary_credential_2d65aa\n',
  'candidate-home-xdg': 'HOME=/candidate-home/release-canary\nXDG_CONFIG_HOME=/candidate-xdg/release-canary\n',
  'canonical-controller-route': 'JUNO_TASK_ROOT=/canonical-controller/.juno_task/release-canary\n',
  'host-paths': '/Users/juno-release-canary/artifact.json\n',
  'candidate-git-metadata': 'gitdir: /candidate-worktree/.git/worktrees/release-canary\n',
});

const forbiddenRuntimeValues = Object.entries(process.env)
  .filter(([name, value]) => value !== undefined && value.length >= 4 && SENSITIVE_ENV.test(name) && !name.startsWith('YYLO_BENCHMARK_RELEASE_'))
  .map(([, value]) => Buffer.from(value));

const files = [];
async function walk(entry) {
  const info = await stat(entry);
  if (info.isSymbolicLink()) throw new Error('leak scan refuses symbolic links');
  if (info.isDirectory()) for (const child of (await readdir(entry)).sort()) await walk(resolve(entry, child));
  else if (info.isFile()) files.push(entry);
  else throw new Error('leak scan refuses non-regular entries');
}

let bytesScanned = 0;
function detections(bytes) {
  const text = bytes.toString('utf8');
  const classes = Object.entries(DETECTORS).filter(([, detector]) => detector.test(text)).map(([id]) => id);
  if (forbiddenRuntimeValues.some((value) => bytes.indexOf(value) >= 0)) classes.push('sensitive-runtime-value');
  return classes;
}
class LeakageDetectionError extends Error {
  constructor(detectedClasses, label) {
    super(`leak classes ${detectedClasses.join(',')} detected in ${label}`);
    this.name = 'LeakageDetectionError';
    this.detectedClasses = Object.freeze([...detectedClasses]);
    this.label = label;
  }
}

export function inspect(bytes, label, count = true) {
  if (count) bytesScanned += bytes.length;
  const found = [...new Set(detections(bytes))].sort();
  if (found.length > 0) throw new LeakageDetectionError(found, label);
}

// Execute one bounded, realistic synthetic artifact per required leak class through
// the same rejection path used for release files. Evidence comes from the caught
// production rejection and never retains the canary bytes.
export function runSyntheticLeakageCanaries(sourceTree, commandHash, inspectArtifact = inspect) {
  return Object.entries(SYNTHETIC_ARTIFACTS).map(([checkId, text]) => {
    const bytes = Buffer.from(text);
    const label = `synthetic:${checkId}`;
    let rejection;
    try {
      inspectArtifact(bytes, label, false);
    } catch (error) {
      if (!(error instanceof LeakageDetectionError)) throw error;
      rejection = error;
    }
    if (rejection?.label !== label || !rejection.detectedClasses.includes(checkId)) {
      throw new Error(`leak detector positive control failed: ${checkId}`);
    }
    const detectedClasses = [...rejection.detectedClasses];
    const observed = { detected: true, rejected: true, detected_classes: detectedClasses };
    const output = { synthetic_artifact_hash: sha256(bytes), bytes_scanned: bytes.length, detector: checkId, detected_classes: detectedClasses };
    const stderrHash = sha256(rejection.message);
    const log = { stdout_hash: emptyHash, stderr_hash: stderrHash, combined_hash: canonicalHash({ stdout_hash: emptyHash, stderr_hash: stderrHash }) };
    const core = { schema_version: 'juno_benchmark_release_leakage_result.v1', check_id: checkId, source_tree: sourceTree, command_hash: commandHash, observed, output, output_hash: canonicalHash(output), log, log_hash: canonicalHash(log), passed: true };
    return { ...core, result_hash: canonicalHash(core) };
  });
}

async function main() {
  const roots = process.argv.slice(2);
  if (roots.length !== 4) throw new Error('expected benchmark dist, YYLO dist, and two packed artifact paths');
  const sourceTree = process.env.YYLO_BENCHMARK_RELEASE_SOURCE_TREE;
  const commandHash = process.env.YYLO_BENCHMARK_RELEASE_COMMAND_HASH;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceTree ?? '') || !/^sha256:[0-9a-f]{64}$/u.test(commandHash ?? '')) {
    throw new Error('leak scan requires a valid source tree and command hash binding');
  }

  for (const root of roots) await walk(resolve(root));
  if (files.length === 0) throw new Error('leak scan received no release artifact files');
  for (const file of files) {
    const bytes = await readFile(file);
    inspect(bytes, relative(process.cwd(), file));
    if (file.endsWith('.tgz')) inspect(gunzipSync(bytes), `${relative(process.cwd(), file)} (expanded)`);
  }

  const results = runSyntheticLeakageCanaries(sourceTree, commandHash);
  const resultsHash = canonicalHash(results);
  const core = { schema_version: 'juno_benchmark_release_leakage_bundle.v1', source_tree: sourceTree, command_hash: commandHash, results, results_hash: resultsHash };
  process.stdout.write(`${JSON.stringify({ passed: true, files_scanned: files.length, bytes_scanned: bytesScanned, canaries_checked: results.length, sensitive_environment_values_checked: forbiddenRuntimeValues.length, ...core, bundle_hash: canonicalHash(core) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
