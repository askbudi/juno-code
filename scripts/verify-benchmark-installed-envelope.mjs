#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function attempt(id, identity, versions) {
  const fixed = digest('installed-pair-fixture');
  return {
    schema_version: 'juno_benchmark_attempt.v1', attempt_id: id, experiment_id: 'installed-pair',
    case_input_hash: fixed, snapshot_hash: fixed, prompt_hash: fixed, agent: 'juno-code',
    provider: identity.provider, model: identity.exact, tool_policy_hash: fixed, budget_hash: fixed,
    package_version: versions.benchmark, juno_version: versions.juno, session_topology: 'fresh',
  };
}

/** Exercise the packed public pair without provider, network, or production access. */
export async function verifyInstalledExecutionEnvelope(options) {
  const { fixtureRoot, prefix, cleanEnvironment, versions } = options;
  const api = await import(join(prefix, 'node_modules/@juno-ai/juno-benchmark/dist/index.js'));
  const installedJunoEntry = join(prefix, 'node_modules/juno-code/dist/bin/cli.mjs');
  const fakeBin = join(fixtureRoot, 'offline-provider-bin');
  const home = join(fixtureRoot, 'offline-home');
  const project = join(fixtureRoot, 'offline-project');
  const metadata = join(fixtureRoot, 'offline-session-metadata');
  const calls = join(fixtureRoot, 'offline-provider-calls.jsonl');
  await Promise.all([mkdir(fakeBin), mkdir(home), mkdir(project), mkdir(metadata)]);
  const prepareProject = async (name) => {
    const repository = join(project, name); const scripts = join(repository, '.juno_task/scripts');
    await mkdir(scripts, { recursive: true });
    for (const hook of ['install_requirements.sh', 'cleanup_feedback.sh']) {
      await writeFile(join(scripts, hook), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    return repository;
  };

  // The real packed pi.py consumes this deterministic Pi-compatible stream. Identity
  // and economics live in provider events; assistant text is deliberately adversarial.
  const fakePi = join(fakeBin, 'pi');
  const fakePiSource = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OFFLINE_CALLS, JSON.stringify(args) + '\\n');
const provider = process.env.OFFLINE_PROVIDER;
const model = process.env.OFFLINE_MODEL;
const message = { role: 'assistant', content: [{ type: 'text', text: '{"resolved":true}' }], stopReason: process.env.OFFLINE_FAILURE === '1' ? 'error' : 'stop' };
console.log(JSON.stringify({ type: 'session', id: 'offline-' + model }));
const terminal = { type: 'agent_end', provider, model, messages: [message] };
if (process.env.OFFLINE_COST !== 'missing') terminal.total_cost_usd = Number(process.env.OFFLINE_COST);
console.log(JSON.stringify(terminal));
if (process.env.OFFLINE_FAILURE === '1') process.exitCode = 1;
`;
  await writeFile(fakePi, fakePiSource, { mode: 0o755 });
  const offlineEnvironment = Object.fromEntries(Object.entries(cleanEnvironment).filter(([key]) =>
    !key.startsWith('PI_') && !/(?:API_KEY|TOKEN|SECRET|CREDENTIAL|AUTH)/u.test(key)));
  const baseEnvironment = {
    ...offlineEnvironment, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    PATH: `${fakeBin}${delimiter}${cleanEnvironment.PATH ?? ''}`,
    JUNO_CODE_SESSION_METADATA_DIRECTORY: metadata, NO_COLOR: '1', CI: '1', OFFLINE_CALLS: calls,
  };
  const runner = api.createJunoRunner({ executable: process.execPath, leadingArguments: [installedJunoEntry], versionTimeoutMs: 30_000 });
  const identities = [
    { name: 'Sol', provider: 'openai-codex', model: 'gpt-5.6-sol', exact: 'openai-codex/gpt-5.6-sol', cost: '1.25', expectedCost: { completeness: 'complete', usd: 1.25 } },
    { name: 'Mini', provider: 'openai-codex', model: 'gpt-5.6-terra', exact: 'openai-codex/gpt-5.6-terra', cost: '0', expectedCost: { completeness: 'complete', usd: 0 } },
    { name: 'Luna', provider: 'openai-codex', model: 'gpt-5.6-luna', exact: 'openai-codex/gpt-5.6-luna', cost: 'missing', expectedCost: { completeness: 'unavailable', usd: null } },
    { name: 'GLM', provider: 'zai', model: 'glm-5.2', exact: 'zai/glm-5.2', cost: '0.5', expectedCost: { completeness: 'complete', usd: 0.5 } },
  ];
  const reconciled = [];
  for (const [index, identity] of identities.entries()) {
    const selected = attempt(`installed-${identity.name.toLowerCase()}`, identity, versions);
    const repository = await prepareProject(identity.name.toLowerCase());
    const evidence = await runner({ attempt: selected, repository, prompt: 'offline candidate fixture',
      environment: { ...baseEnvironment, JUNO_CODE_SESSION_METADATA_DIRECTORY: join(metadata, identity.name.toLowerCase()),
        OFFLINE_PROVIDER: identity.provider, OFFLINE_MODEL: identity.model, OFFLINE_COST: identity.cost }, timeoutMs: 30_000 });
    const patchHash = index === identities.length - 1 ? digest('successful installed patch') : null;
    const observed = api.reconcileJunoTelemetry({ ...evidence, patchHash });
    if (!observed.candidateSucceeded || observed.provider !== identity.provider || observed.model !== identity.model ||
        observed.sessionId !== `offline-${identity.model}` || observed.junoVersion !== versions.juno ||
        JSON.stringify(observed.result.cost) !== JSON.stringify(identity.expectedCost) || observed.result.resolved !== false ||
        observed.result.terminal_class !== 'model_failure' || observed.result.patch_hash !== patchHash) {
      throw new Error(`Installed ${identity.name} envelope did not reconcile exactly: ${JSON.stringify(observed)} stderr=${evidence.stderr} calls=${await readFile(calls, 'utf8')}`);
    }
    reconciled.push({ selected, observed });
  }
  const providerCalls = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  for (const [index, identity] of identities.entries()) {
    const args = providerCalls[index];
    if (args[args.indexOf('--provider') + 1] !== identity.provider || args[args.indexOf('--model') + 1] !== identity.model) {
      throw new Error(`Installed ${identity.name} dispatch weakened exact provider/model binding: ${JSON.stringify(args)}`);
    }
  }

  const failedIdentity = identities[0];
  const failedAttempt = attempt('installed-failure', failedIdentity, versions); const failureProject = await prepareProject('failure');
  const failedEvidence = await runner({ attempt: failedAttempt, repository: failureProject, prompt: 'offline failure fixture',
    environment: { ...baseEnvironment, JUNO_CODE_SESSION_METADATA_DIRECTORY: join(metadata, 'failure'), OFFLINE_PROVIDER: failedIdentity.provider, OFFLINE_MODEL: failedIdentity.model,
      OFFLINE_COST: 'missing', OFFLINE_FAILURE: '1' }, timeoutMs: 30_000 });
  const failed = api.reconcileJunoTelemetry(failedEvidence);
  if (failed.candidateSucceeded || failed.result.resolved || failed.result.terminal_class !== 'model_failure' || failed.result.cost.completeness !== 'unavailable') {
    throw new Error(`Installed failure envelope was misclassified: ${JSON.stringify(failed)}`);
  }

  // Grade retained installed-envelope evidence with executable bytes bound by SHA.
  const grader = join(fixtureRoot, 'governed-grader.mjs');
  const graderSource = `#!/usr/bin/env node
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{JSON.parse(input);process.stdout.write(JSON.stringify({passed:process.argv[2]==='pass'}));});
`;
  await writeFile(grader, graderSource, { mode: 0o555 }); await chmod(grader, 0o555);
  const registry = new api.ImmutableArtifactRegistry(join(fixtureRoot, 'installed-grader-registry'));
  const retained = reconciled.at(-1);
  const passV1 = api.createCommandGrader({ executable: grader, arguments: ['pass'], graderId: 'offline-tests',
    graderVersion: 'installed-v1', sha256: digest(graderSource), cwd: fixtureRoot, timeoutMs: 10_000 });
  const resolved = await api.gradeRetainedAttempt({ registry, experimentId: 'installed-pair', attempt: retained.selected,
    profile: 'required-offline', candidateResult: retained.observed.result, candidateSucceeded: true, runner: passV1 });
  if (!resolved.resolved || resolved.terminal_class !== 'resolved') throw new Error('SHA-bound required grader did not establish resolved truth');
  let entries = await registry.verifyExperiment('installed-pair');
  const receipt = await api.verifyRequiredGraderReceipt(registry, entries, retained.selected.attempt_id);
  if (receipt.grader_version !== 'installed-v1' || !receipt.passed) throw new Error('Installed grader receipt lost governed identity');
  let removalRejected = false;
  try { await api.verifyRequiredGraderReceipt(registry, entries.filter((entry) => entry.role !== 'grader-receipt'), retained.selected.attempt_id); }
  catch { removalRejected = true; }
  if (!removalRejected) throw new Error('Resolved truth survived required grader receipt removal');

  const failRunner = api.createCommandGrader({ executable: grader, arguments: ['fail'], graderId: 'offline-tests',
    graderVersion: 'installed-v2', sha256: digest(graderSource), cwd: fixtureRoot, timeoutMs: 10_000 });
  const unresolved = await api.gradeRetainedAttempt({ registry, experimentId: 'installed-pair', attempt: retained.selected,
    profile: 'required-offline', candidateResult: retained.observed.result, candidateSucceeded: true, runner: failRunner });
  if (unresolved.resolved || unresolved.terminal_class !== 'grader_failure') throw new Error('Required grader failure did not force unresolved');
  entries = await registry.verifyExperiment('installed-pair');
  if (entries.filter((entry) => entry.role === 'grader-receipt').length !== 2) throw new Error('Retained candidate was not independently reusable across grader versions');

  const selfDeclared = reconciled[0];
  const noGrader = await api.gradeRetainedAttempt({ registry, experimentId: 'installed-pair', attempt: selfDeclared.selected,
    profile: 'required-offline', candidateResult: selfDeclared.observed.result, candidateSucceeded: true });
  if (noGrader.resolved || noGrader.terminal_class !== 'grader_failure') throw new Error('Candidate self-declaration established resolved truth');

  // Smoke the installed authenticated-launcher export with an offline synthetic token.
  const launcher = join(fixtureRoot, 'authenticated-launcher.mjs');
  const launcherSource = `#!/usr/bin/env node
import fs from 'node:fs';const a=process.argv.slice(2);const get=n=>a[a.indexOf(n)+1];const op=a[0],provider=get('--provider'),exact=get('--model'),version=get('--juno-version');
if(op==='probe'){console.log(version);process.exit(0)}
const secret=fs.readFileSync(3,'utf8');fs.closeSync(3);fs.readFileSync(4);fs.closeSync(4);
console.log(JSON.stringify({schema_version:'juno_execution_envelope.v1',status:'success',session_id:'authenticated-offline',provider,model:exact.slice(provider.length+1),juno_version:version,cost:{completeness:'complete',usd:0}}));
`;
  await writeFile(launcher, launcherSource, { mode: 0o500 }); await chmod(launcher, 0o500); const launcherPath = await realpath(launcher);
  const moduleProbe = spawnSync(process.execPath, [launcherPath, 'probe', '--protocol', 'juno_benchmark_auth_launcher.v1',
    '--provider', 'openai-codex', '--model', identities[0].exact, '--juno-version', versions.juno], {
    cwd: fixtureRoot, env: baseEnvironment, encoding: 'utf8', input: '', timeout: 10_000,
  });
  if (moduleProbe.error || moduleProbe.status !== 0 || moduleProbe.signal !== null || moduleProbe.stdout.trim() !== versions.juno || moduleProbe.stderr !== '') {
    throw new Error(`Authenticated launcher module probe failed: ${JSON.stringify({ status: moduleProbe.status, signal: moduleProbe.signal,
      stdout: moduleProbe.stdout, stderr: moduleProbe.stderr, error: moduleProbe.error?.message })}`);
  }
  const credentialName = 'OPENAI_CODEX_TOKEN'; const priorCredential = process.env[credentialName]; process.env[credentialName] = 'offline-token-material-1234567890';
  try {
    const authProject = await prepareProject('authenticated');
    const authRunner = api.createAuthenticatedJunoRunner({ executable: launcherPath, sha256: digest(graderSource).slice(7), provider: 'openai-codex',
      credential: { kind: 'environment', name: credentialName } });
    // Deliberately replace the incorrect digest above before any credential resolution is attempted.
    let badDigestRejected = false;
    try { await authRunner.preflight?.({ attempt: reconciled[0].selected, repository: authProject, prompt: 'offline auth', environment: baseEnvironment, timeoutMs: 10_000 }); }
    catch { badDigestRejected = true; }
    if (!badDigestRejected) throw new Error('Authenticated launcher accepted unbound bytes');
    const boundRunner = api.createAuthenticatedJunoRunner({ executable: launcherPath, sha256: digest(launcherSource).slice(7), provider: 'openai-codex', credential: { kind: 'environment', name: credentialName } });
    const request = { attempt: reconciled[0].selected, repository: authProject, prompt: 'offline auth', environment: baseEnvironment, timeoutMs: 10_000 };
    await boundRunner.preflight?.(request); const authEvidence = await boundRunner(request); const authObserved = api.reconcileJunoTelemetry(authEvidence);
    if (!authObserved.candidateSucceeded || JSON.stringify(authEvidence).includes(process.env[credentialName])) throw new Error(`Installed authenticated launcher contract failed: ${JSON.stringify({ authObserved, authEvidence })}`);
  } finally {
    if (priorCredential === undefined) delete process.env[credentialName]; else process.env[credentialName] = priorCredential;
  }

  return { identities: identities.map(({ name, exact }) => ({ name, exact })), genuine_zero: true, missing_cost: true,
    failure: true, successful_patch: true, grader_receipts: 3, candidate_self_declaration_rejected: true,
    authenticated_launcher_module_probe: true, authenticated_launcher: true };
}
