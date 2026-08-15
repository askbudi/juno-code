#!/usr/bin/env node

import { copyFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyInstalledExecutionEnvelope } from './verify-benchmark-installed-envelope.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const junoCodeRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(junoCodeRoot, '..');
const fixtureRoot = await mkdtemp(join(tmpdir(), 'juno-benchmark-release-smoke-'));
const sourceRoot = join(fixtureRoot, 'source');
const packDirectory = join(fixtureRoot, 'packs');
const prefix = join(fixtureRoot, 'prefix');

function runRaw(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    input: options.input ?? '',
    timeout: options.timeout ?? 300_000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.error.code ?? 'spawn'}): ${result.error.message}`);
  }
  return result;
}

function run(command, args, options = {}) {
  const result = runRaw(command, args, options);
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal ?? 'spawn'}):\n` +
      `${result.stderr || result.stdout}`,
    );
  }
  return result;
}

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const packageIdentity = (root) => JSON.parse(run('node', ['-e', "const p=require('./package.json');process.stdout.write(JSON.stringify({name:p.name,version:p.version}))"], { cwd: root }).stdout);
const versionOutput = (command, args, options) => run(command, args, options).stdout.trim().replace(/^juno-benchmark\s+/u, '');

function packedArtifact(projectRoot) {
  const result = run('npm', ['pack', '--silent', '--json', '--pack-destination', packDirectory], { cwd: projectRoot });
  const jsonStart = result.stdout.lastIndexOf('\n[');
  const records = JSON.parse(jsonStart >= 0 ? result.stdout.slice(jsonStart + 1) : result.stdout);
  if (!Array.isArray(records) || records.length !== 1 || typeof records[0]?.filename !== 'string') {
    throw new Error(`Unexpected npm pack response from ${projectRoot}`);
  }
  return join(packDirectory, records[0].filename);
}

async function stageTrackedSources() {
  const tracked = run('git', ['ls-files', '-z']);
  const paths = tracked.stdout.split('\0').filter(Boolean);
  if (paths.length === 0) throw new Error('Git returned no tracked release sources');
  for (const relativePath of paths) {
    const source = join(repositoryRoot, relativePath);
    let sourceStat;
    try {
      sourceStat = await stat(source);
    } catch (error) {
      if (error?.code === 'ENOENT') continue; // Honor a tracked deletion in the checkout under test.
      throw error;
    }
    if (sourceStat.isDirectory()) continue; // A Git submodule entry is not part of either npm artifact.
    const destination = join(sourceRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, sourceStat.mode);
  }
}

try {
  await stageTrackedSources();
  await mkdir(packDirectory, { recursive: true });
  await mkdir(prefix, { recursive: true });
  const stagedBenchmarkRoot = join(sourceRoot, 'juno-benchmark');
  const stagedJunoCodeRoot = join(sourceRoot, 'juno-code');
  run('npm', ['ci', '--ignore-scripts'], { cwd: stagedBenchmarkRoot });
  run('npm', ['ci', '--ignore-scripts'], { cwd: stagedJunoCodeRoot });
  const benchmarkArtifact = packedArtifact(stagedBenchmarkRoot);
  const junoCodeArtifact = packedArtifact(stagedJunoCodeRoot);
  const evidenceArtifacts = join(stagedBenchmarkRoot, '.release-evidence');
  await mkdir(evidenceArtifacts);
  await copyFile(benchmarkArtifact, join(evidenceArtifacts, 'juno-benchmark.tgz'));
  await copyFile(junoCodeArtifact, join(evidenceArtifacts, 'juno-code.tgz'));
  run('npm', ['install', '--prefix', prefix, benchmarkArtifact, junoCodeArtifact]);

  const bin = join(prefix, 'node_modules', '.bin');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('JUNO_')),
  );
  env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  const yy = join(bin, 'yy');
  const benchmark = join(bin, 'juno-benchmark');
  const benchmarkPackage = packageIdentity(stagedBenchmarkRoot);
  const junoPackage = packageIdentity(stagedJunoCodeRoot);
  const requiredBenchmarkVersion = JSON.parse(await readFile(join(stagedJunoCodeRoot, 'package.json'), 'utf8')).junoBenchmark?.version;
  if (requiredBenchmarkVersion !== benchmarkPackage.version) {
    throw new Error(`Juno Code requires benchmark ${requiredBenchmarkVersion ?? '<missing>'}, packed artifact is ${benchmarkPackage.version}`);
  }

  const yyHelp = run(yy, ['--help'], { cwd: fixtureRoot, env });
  if (!/(^|\s)benchmark(\s|$)/m.test(yyHelp.stdout)) {
    throw new Error('Packed yy --help does not list benchmark');
  }

  for (const args of [['--version'], ['--help']]) {
    const standalone = run(benchmark, args, { cwd: fixtureRoot, env });
    const delegated = run(yy, ['benchmark', ...args], { cwd: fixtureRoot, env });
    if (standalone.status !== delegated.status ||
        standalone.stdout !== delegated.stdout || standalone.stderr !== delegated.stderr) {
      throw new Error(`Packed delegate differs from standalone for ${args.join(' ')}: ` +
        JSON.stringify({ standalone, delegated }, null, 2));
    }
  }
  if (versionOutput(benchmark, ['--version'], { cwd: fixtureRoot, env }) !== requiredBenchmarkVersion) {
    throw new Error('Packed standalone version does not satisfy the exact Juno Code contract');
  }
  const installedEnvelopeEvidence = await verifyInstalledExecutionEnvelope({
    fixtureRoot, prefix, cleanEnvironment: env,
    versions: { benchmark: benchmarkPackage.version, juno: junoPackage.version },
  });

  // Exercise process fidelity from the clean installed prefix. The probe wraps
  // the real packed executable for the mandatory version handshake, then gives
  // standalone and delegated launches one identical observable child process.
  const probeBin = join(fixtureRoot, 'probe-bin'); await mkdir(probeBin);
  const probeRecord = join(fixtureRoot, 'probe-record.json');
  const probe = join(probeBin, 'juno-benchmark');
  await writeFile(probe, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const actual = ${JSON.stringify(benchmark)};
if (process.argv[2] === '--version') {
  const result = spawnSync(actual, ['--version'], { stdio: 'inherit' });
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.JUNO_DISTRIBUTION_RECORD, JSON.stringify({ cwd: process.cwd(), marker: process.env.JUNO_DISTRIBUTION_MARKER, input }));
if (process.env.JUNO_DISTRIBUTION_SIGNAL) process.kill(process.pid, process.env.JUNO_DISTRIBUTION_SIGNAL);
process.stdout.write('probe stdout:' + input);
process.stderr.write('probe stderr:' + process.env.JUNO_DISTRIBUTION_MARKER);
process.exit(Number(process.env.JUNO_DISTRIBUTION_EXIT));
`, { mode: 0o755 });
  const probeEnv = { ...env, PATH: `${probeBin}${delimiter}${env.PATH}`, JUNO_DISTRIBUTION_RECORD: probeRecord,
    JUNO_DISTRIBUTION_MARKER: 'installed pair environment', JUNO_DISTRIBUTION_EXIT: '43' };
  const input = 'installed pair stdin\n';
  const standaloneProbe = runRaw(probe, ['distribution-probe'], { cwd: fixtureRoot, env: probeEnv, input });
  const standaloneRecord = JSON.parse(await readFile(probeRecord, 'utf8'));
  const delegatedProbe = runRaw(yy, ['benchmark', 'distribution-probe'], { cwd: fixtureRoot, env: probeEnv, input });
  const delegatedRecord = JSON.parse(await readFile(probeRecord, 'utf8'));
  for (const key of ['status', 'signal', 'stdout', 'stderr']) {
    if (standaloneProbe[key] !== delegatedProbe[key]) throw new Error(`Packed process fidelity differs for ${key}`);
  }
  if (standaloneProbe.status !== 43 || JSON.stringify(standaloneRecord) !== JSON.stringify(delegatedRecord) ||
      delegatedRecord.cwd !== await realpath(fixtureRoot) || delegatedRecord.marker !== probeEnv.JUNO_DISTRIBUTION_MARKER || delegatedRecord.input !== input) {
    throw new Error('Packed process fidelity lost cwd, environment, stdin, or exit status');
  }
  const signalEnv = { ...probeEnv, JUNO_DISTRIBUTION_SIGNAL: 'SIGTERM', JUNO_DISTRIBUTION_EXIT: '0' };
  const standaloneSignal = runRaw(probe, ['distribution-probe'], { cwd: fixtureRoot, env: signalEnv });
  const delegatedSignal = runRaw(yy, ['benchmark', 'distribution-probe'], { cwd: fixtureRoot, env: signalEnv });
  if (standaloneSignal.signal !== 'SIGTERM' || delegatedSignal.signal !== standaloneSignal.signal) {
    throw new Error('Packed delegate does not mirror standalone signal termination');
  }

  if (process.argv.includes('--distribution-only')) {
    process.stdout.write(`${JSON.stringify(installedEnvelopeEvidence)}\nbenchmark installed-pair distribution smoke passed\n`);
  } else {
  const builtBin = join(fixtureRoot, 'built-bin'); await mkdir(builtBin);
  const builtBenchmarkEntry = join(stagedBenchmarkRoot, 'dist/bin.js');
  const builtBenchmark = join(builtBin, 'juno-benchmark');
  await writeFile(builtBenchmark, `#!/bin/sh\nexec "${process.execPath}" "${builtBenchmarkEntry}" "$@"\n`, { mode: 0o755 });
  const builtEnv = { ...env, PATH: `${builtBin}${delimiter}${env.PATH}` };
  const builtYy = join(stagedJunoCodeRoot, 'dist/bin/juno-code.sh');
  const gitCommit = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const gitTreeBefore = run('git', ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  if (run('git', ['status', '--porcelain']).stdout !== '') throw new Error('release-readiness source worktree is not clean');
  const benchmarkSource = run('git', ['rev-parse', 'HEAD:juno-benchmark']).stdout.trim();
  const junoSource = run('git', ['rev-parse', 'HEAD:juno-code']).stdout.trim();
  const api = await import(join(stagedBenchmarkRoot, 'dist/index.js'));

  const releaseCaseEvidencePath = join(fixtureRoot, 'release-case-evidence.json');
  const executeEvidence = (kind) => {
    const command = api.RELEASE_VERIFICATION_COMMANDS[kind];
    const executionEnv = {
      ...env,
      JUNO_BENCHMARK_RELEASE_SOURCE_TREE: gitTreeBefore,
      JUNO_BENCHMARK_RELEASE_COMMAND_HASH: api.canonicalHash(command),
      ...(kind === 'coverage' ? { JUNO_BENCHMARK_RELEASE_CASE_EVIDENCE: releaseCaseEvidencePath } : {}),
    };
    const result = run(command.executable, [...command.arguments], { cwd: join(sourceRoot, command.cwd), env: executionEnv, timeout: command.timeout_ms });
    return { command, result };
  };
  const coverageExecution = executeEvidence('coverage');
  const coverageSummary = await readFile(join(stagedBenchmarkRoot, 'coverage/coverage-summary.json'));
  const caseBundle = JSON.parse(await readFile(releaseCaseEvidencePath, 'utf8'));
  if (caseBundle?.schema_version !== 'juno_benchmark_release_case_bundle.v1' || caseBundle.source_tree !== gitTreeBefore ||
      caseBundle.command_hash !== api.canonicalHash(coverageExecution.command) ||
      caseBundle.results_hash !== api.canonicalHash(caseBundle.results)) {
    throw new Error('coverage command produced stale, mismatched, or forged release case bundle');
  }
  const coverageAssertions = api.deriveReleaseCoverageAssertions(caseBundle.results, {
    sourceTree: gitTreeBefore, commandHash: api.canonicalHash(coverageExecution.command),
  });
  const plainCoverageLog = coverageExecution.result.stdout.replace(/\u001b\[[0-9;]*m/gu, '');
  const testFiles = Number(/Test Files\s+(\d+) passed/u.exec(plainCoverageLog)?.[1]);
  const tests = Number(/Tests\s+(\d+) passed/u.exec(plainCoverageLog)?.[1]);
  if (!Number.isInteger(testFiles) || testFiles <= 0 || !Number.isInteger(tests) || tests <= 0) throw new Error('coverage command did not report passing test and file counts');
  const leakageExecution = executeEvidence('leakage');
  const leakageScan = JSON.parse(leakageExecution.result.stdout);
  const leakageCommandHash = api.canonicalHash(leakageExecution.command);
  if (leakageScan.passed !== true || leakageScan.schema_version !== 'juno_benchmark_release_leakage_bundle.v1' ||
      leakageScan.source_tree !== gitTreeBefore || leakageScan.command_hash !== leakageCommandHash ||
      leakageScan.results_hash !== api.canonicalHash(leakageScan.results)) {
    throw new Error('credential/leak scan produced stale, mismatched, or forged check results');
  }
  const leakageBundleCore = { schema_version: leakageScan.schema_version, source_tree: leakageScan.source_tree,
    command_hash: leakageScan.command_hash, results: leakageScan.results, results_hash: leakageScan.results_hash };
  if (leakageScan.bundle_hash !== api.canonicalHash(leakageBundleCore)) throw new Error('credential/leak scan bundle hash mismatch');
  const leakageAssertions = api.deriveReleaseLeakageAssertions(leakageScan.results, {
    sourceTree: gitTreeBefore, commandHash: leakageCommandHash,
  });
  const gitTreeAfter = run('git', ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  if (gitTreeAfter !== gitTreeBefore || run('git', ['status', '--porcelain']).stdout !== '') throw new Error('release-readiness source changed during verification');

  const measured = {
    coverage: { execution: coverageExecution, output: { test_files_passed: testFiles, tests_passed: tests, coverage_summary_hash: sha256(coverageSummary), case_results: caseBundle.results, case_results_hash: caseBundle.results_hash }, assertions: coverageAssertions },
    leakage: { execution: leakageExecution, output: { files_scanned: leakageScan.files_scanned, bytes_scanned: leakageScan.bytes_scanned, canaries_checked: leakageScan.canaries_checked, sensitive_environment_values_checked: leakageScan.sensitive_environment_values_checked, check_results: leakageScan.results, check_results_hash: leakageScan.results_hash, bundle_hash: leakageScan.bundle_hash }, assertions: leakageAssertions },
  };
  const verificationEvidence = Object.entries(measured).map(([kind, measurement]) => {
    const result = kind === 'coverage'
      ? { passed: true, case_results_hash: measurement.output.case_results_hash }
      : { passed: true, assertions: measurement.assertions };
    const result_hash = api.canonicalHash(result);
    const stdout_hash = sha256(measurement.execution.result.stdout);
    const stderr_hash = sha256(measurement.execution.result.stderr);
    const log = { stdout_hash, stderr_hash, combined_hash: api.canonicalHash({ stdout_hash, stderr_hash }) };
    const evidence = {
      schema_version: 'juno_benchmark_release_verification_evidence.v2', assertion_kind: kind,
      source_tree_before: gitTreeBefore, source_tree_after: gitTreeAfter,
      command: measurement.execution.command, command_hash: api.canonicalHash(measurement.execution.command),
      execution: { exit_code: measurement.execution.result.status, signal: measurement.execution.result.signal, timed_out: false },
      output: measurement.output, output_hash: api.canonicalHash(measurement.output),
      log, log_hash: api.canonicalHash(log), result_hash,
    };
    return { kind, result, result_hash, evidence, evidence_hash: api.canonicalHash(evidence) };
  });
  const readiness = api.generateReleaseReadinessReceipt({
    source: { commit: gitCommit, tree: gitTreeBefore, clean: true, packages: [benchmarkPackage, junoPackage] },
    artifacts: [
      { package: benchmarkPackage.name, kind: 'source', version: benchmarkPackage.version, sha256: sha256(benchmarkSource) },
      { package: benchmarkPackage.name, kind: 'dist', version: benchmarkPackage.version, sha256: await api.hashReleaseDirectory(join(stagedBenchmarkRoot, 'dist')) },
      { package: benchmarkPackage.name, kind: 'npm_tarball', version: benchmarkPackage.version, sha256: sha256(await readFile(benchmarkArtifact)) },
      { package: junoPackage.name, kind: 'source', version: junoPackage.version, sha256: sha256(junoSource) },
      { package: junoPackage.name, kind: 'dist', version: junoPackage.version, sha256: await api.hashReleaseDirectory(join(stagedJunoCodeRoot, 'dist')) },
      { package: junoPackage.name, kind: 'npm_tarball', version: junoPackage.version, sha256: sha256(await readFile(junoCodeArtifact)) },
    ],
    cli_identities: [
      { installation: 'built', surface: 'standalone', benchmark_version: versionOutput(process.execPath, [builtBenchmarkEntry, '--version'], { env: builtEnv }), juno_code_version: null },
      { installation: 'built', surface: 'delegate', benchmark_version: versionOutput(builtYy, ['benchmark', '--version'], { env: builtEnv }), juno_code_version: junoPackage.version },
      { installation: 'installed', surface: 'standalone', benchmark_version: versionOutput(benchmark, ['--version'], { env }), juno_code_version: null },
      { installation: 'installed', surface: 'delegate', benchmark_version: versionOutput(yy, ['benchmark', '--version'], { env }), juno_code_version: junoPackage.version },
    ],
    verification_evidence: verificationEvidence,
  }, { forbiddenValues: [fixtureRoot, process.env.HOME ?? '', process.env.XDG_CONFIG_HOME ?? '', process.env.JUNO_BENCHMARK_REGISTRY ?? ''] });
  process.stdout.write(`${JSON.stringify(readiness)}\nbenchmark release artifact smoke passed\n`);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
