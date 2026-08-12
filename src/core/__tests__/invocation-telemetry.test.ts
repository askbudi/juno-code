import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getInvocationTelemetryDirectory,
  parseInvocationTelemetryEvent,
  writeInvocationTelemetryEvent,
} from '../invocation-telemetry.js';

const roots: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const root = path.join('/tmp', `juno-invocation-telemetry-${name}-${process.pid}-${Date.now()}-${roots.length}`);
  roots.push(root);
  await fs.ensureDir(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function started(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: '019ff6fd-89eb-7e75-9a5e-35bae7d3a3c3',
    event_type: 'invocation_started',
    recorded_at: '2026-08-12T17:20:38.891Z',
    request_id: 'req-123',
    trace_id: '019ff6fd-89eb-7e75-9a5e-35bae7d3a3c4',
    span_id: '019ff6fd-89eb-7e75-9a5e-35bae7d3a3c5',
    parent_span_id: null,
    task_id: null,
    workflow_run_id: null,
    workflow_step_id: null,
    launch_surface: 'juno-code',
    service: 'pi',
    requested_model: null,
    juno_code_version: '2.1.3-rc.0.5',
    started_at: '2026-08-12T17:20:38.890Z',
    started_monotonic_ms: 42.25,
    ...overrides,
  };
}

function finished(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: '019ff6fd-89eb-7e75-9a5e-35bae7d3a3c6',
    event_type: 'invocation_finished',
    recorded_at: '2026-08-12T17:20:40.000Z',
    request_id: 'req-123',
    trace_id: '019ff6fd-89eb-7e75-9a5e-35bae7d3a3c4',
    span_id: '019ff6fd-89eb-7e75-9a5e-35bae7d3a3c5',
    parent_span_id: null,
    task_id: null,
    workflow_run_id: null,
    workflow_step_id: null,
    launch_surface: 'juno-code',
    service: 'pi',
    requested_model: null,
    juno_code_version: '2.1.3-rc.0.5',
    finished_at: '2026-08-12T17:20:40.000Z',
    finished_monotonic_ms: 1151.5,
    duration_ms: 1109.25,
    status: 'success',
    exit_code: 0,
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.remove(root);
});

describe('invocation telemetry schema', () => {
  it('accepts bounded v1 start and finish events', () => {
    expect(parseInvocationTelemetryEvent(started()).event_type).toBe('invocation_started');
    expect(parseInvocationTelemetryEvent(finished()).event_type).toBe('invocation_finished');
  });

  it('rejects unknown content fields and malformed terminal truth', () => {
    for (const forbidden of [
      'prompt', 'response', 'command', 'environment', 'transcript', 'tool_output', 'project_path',
    ]) {
      expect(() => parseInvocationTelemetryEvent(started({ [forbidden]: 'secret' }))).toThrow();
    }
    expect(() => parseInvocationTelemetryEvent(finished({ status: 'success', exit_code: 1 }))).toThrow();
    expect(() => parseInvocationTelemetryEvent(finished({ status: 'failure', exit_code: null }))).toThrow();
    expect(parseInvocationTelemetryEvent(finished({ status: 'interrupted', exit_code: 0 })))
      .toMatchObject({ status: 'interrupted', exit_code: 0 });
    expect(() => parseInvocationTelemetryEvent(started({ request_id: 'x'.repeat(257) }))).toThrow();
    expect(() => parseInvocationTelemetryEvent(started({ event_id: '../escape' }))).toThrow();
    expect(() => parseInvocationTelemetryEvent(started({ started_monotonic_ms: Number.POSITIVE_INFINITY }))).toThrow();
    expect(() => parseInvocationTelemetryEvent(finished({ duration_ms: Number.POSITIVE_INFINITY }))).toThrow();
  });
});

describe('invocation telemetry project-state resolver', () => {
  it('routes a repository and linked worktree to one Git-common event directory', async () => {
    const root = await temporaryDirectory('linked');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(root, 'tracked'), 'x');
    git(root, 'add', 'tracked');
    git(root, 'commit', '-qm', 'base');
    const linked = `${root}-linked`;
    roots.push(linked);
    git(root, 'worktree', 'add', '-q', '-b', `telemetry-${process.pid}-${Date.now()}`, linked);

    const events = getInvocationTelemetryDirectory(root);
    expect(getInvocationTelemetryDirectory(linked)).toBe(events);
    expect(events.endsWith(path.join('.git', 'juno', 'telemetry', 'events'))).toBe(true);
  });

  it('uses a stable, isolated state-home identity outside Git', async () => {
    const first = await temporaryDirectory('nongit-a');
    const second = await temporaryDirectory('nongit-b');
    const state = await temporaryDirectory('state');
    const env = { XDG_STATE_HOME: state };

    expect(getInvocationTelemetryDirectory(first, env)).toBe(getInvocationTelemetryDirectory(first, env));
    expect(getInvocationTelemetryDirectory(first, env)).not.toBe(getInvocationTelemetryDirectory(second, env));
    expect(getInvocationTelemetryDirectory(first, env).startsWith(state)).toBe(true);
    expect(getInvocationTelemetryDirectory(first, env).startsWith(first)).toBe(false);
  });
});

describe('immutable invocation telemetry event writer', () => {
  it('publishes complete exclusive-create events with private modes and never rewrites', async () => {
    const root = await temporaryDirectory('immutable');
    const event = started();
    const file = await writeInvocationTelemetryEvent(root, event, { XDG_STATE_HOME: path.join(root, 'state') });
    const original = await fs.readFile(file, 'utf8');

    expect(JSON.parse(original)).toEqual(event);
    expect(original.endsWith('\n')).toBe(true);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await expect(writeInvocationTelemetryEvent(root, { ...event, service: 'changed' }, {
      XDG_STATE_HOME: path.join(root, 'state'),
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  it('forces exact private file mode under a restrictive process umask', async () => {
    const root = await temporaryDirectory('restrictive-umask');
    const script = path.join(root, 'write-event.ts');
    const stateHome = path.join(root, 'state');
    const eventDirectory = getInvocationTelemetryDirectory(root, { XDG_STATE_HOME: stateHome });
    await fs.ensureDir(eventDirectory);
    await fs.chmod(path.dirname(eventDirectory), 0o700);
    await fs.chmod(eventDirectory, 0o700);
    const modulePath = path.resolve('src/core/invocation-telemetry.ts');
    await fs.writeFile(script, [
      `import { writeInvocationTelemetryEvent } from ${JSON.stringify(modulePath)};`,
      `(async () => {`,
      `  process.umask(0o777);`,
      `  const file = await writeInvocationTelemetryEvent(${JSON.stringify(root)}, ${JSON.stringify(started())}, { XDG_STATE_HOME: ${JSON.stringify(stateHome)} });`,
      `  console.log(file);`,
      `})().catch((error) => { console.error(error); process.exitCode = 1; });`,
    ].join('\n'));

    const file = childProcess.execFileSync(path.resolve('node_modules/.bin/tsx'), [script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('does not require a finish event and preserves parallel writer cardinality', async () => {
    const root = await temporaryDirectory('parallel');
    const env = { XDG_STATE_HOME: path.join(root, 'state') };
    const events = Array.from({ length: 32 }, (_, index) => started({
      event_id: `019ff6fd-89eb-7e75-9a5e-${index.toString().padStart(12, '0')}`,
      request_id: `req-${index}`,
    }));

    await Promise.all(events.map((event) => writeInvocationTelemetryEvent(root, event, env)));
    const directory = getInvocationTelemetryDirectory(root, env);
    const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(events.length);
    expect((await Promise.all(files.map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')))))
      .every((event) => event.event_type === 'invocation_started')).toBe(true);
  });
});
