import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';
import fs from 'fs-extra';
import { z } from 'zod';

import { providerObservationsSchema } from './provider-observations.js';
import { resolveJunoProjectStateLocation } from './session-metadata.js';

export const INVOCATION_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const INVOCATION_TELEMETRY_EVENT_DIRECTORY = 'events';

const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const eventIdentifier = z.string().uuid();
const nullableIdentifier = identifier.nullable();
const timestamp = z.string().datetime({ offset: true });
const monotonicMilliseconds = z.number().finite().nonnegative();

const commonEventFields = {
  schema_version: z.literal(INVOCATION_TELEMETRY_SCHEMA_VERSION),
  event_id: eventIdentifier,
  recorded_at: timestamp,
  request_id: identifier,
  trace_id: identifier,
  span_id: identifier,
  parent_span_id: nullableIdentifier,
  task_id: nullableIdentifier,
  workflow_run_id: nullableIdentifier,
  workflow_step_id: nullableIdentifier,
  launch_surface: identifier,
  service: identifier,
  requested_model: z.string().min(1).max(256).nullable(),
  juno_code_version: z.string().min(1).max(128),
};

export const invocationStartedEventSchema = z.object({
  ...commonEventFields,
  event_type: z.literal('invocation_started'),
  started_at: timestamp,
  started_monotonic_ms: monotonicMilliseconds,
}).strict();

const invocationFinishedEventBaseSchema = z.object({
  ...commonEventFields,
  event_type: z.literal('invocation_finished'),
  finished_at: timestamp,
  finished_monotonic_ms: monotonicMilliseconds,
  duration_ms: monotonicMilliseconds,
  status: z.enum(['success', 'failure', 'timeout', 'interrupted']),
  exit_code: z.number().int(),
  // Optional only so immutable v1 events written before provider enrichment
  // remain parseable. Current lifecycle producers always emit this field.
  provider_observations: providerObservationsSchema.optional(),
}).strict();

export const invocationFinishedEventSchema = invocationFinishedEventBaseSchema.superRefine((event, context) => {
  if (event.status === 'success' && event.exit_code !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['exit_code'], message: 'success requires exit code 0' });
  }
  // Graceful SIGINT/SIGTERM intentionally preserve the CLI's historical exit-0
  // contract. The interrupted status carries semantic truth while exit_code
  // records the actual process code rather than inventing a failure code.
  if ((event.status === 'failure' || event.status === 'timeout') && event.exit_code === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['exit_code'], message: `${event.status} requires a non-zero exit code` });
  }
});

export const invocationTelemetryEventSchema = z.discriminatedUnion('event_type', [
  invocationStartedEventSchema,
  // ZodEffects cannot participate directly in a discriminated union; the terminal refinement runs below.
  invocationFinishedEventBaseSchema,
]).superRefine((event, context) => {
  if (event.event_type !== 'invocation_finished') return;
  const result = invocationFinishedEventSchema.safeParse(event);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue(issue);
  }
});

export type InvocationStartedEvent = z.infer<typeof invocationStartedEventSchema>;
export type InvocationFinishedEvent = z.infer<typeof invocationFinishedEventSchema>;
export type InvocationTelemetryEvent = InvocationStartedEvent | InvocationFinishedEvent;

export function parseInvocationTelemetryEvent(event: unknown): InvocationTelemetryEvent {
  return invocationTelemetryEventSchema.parse(event) as InvocationTelemetryEvent;
}

export function getInvocationTelemetryDirectory(
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    resolveJunoProjectStateLocation(workingDirectory, 'telemetry', env).directory,
    INVOCATION_TELEMETRY_EVENT_DIRECTORY,
  );
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await nodeFs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateTelemetryDirectories(
  eventDirectory: string,
  durabilityAnchor: string,
): Promise<void> {
  const telemetryDirectory = path.dirname(eventDirectory);
  await fs.ensureDir(eventDirectory, 0o700);
  await fs.chmod(telemetryDirectory, 0o700);
  await fs.chmod(eventDirectory, 0o700);

  // Idempotently persist the complete state path even when another writer raced to create it.
  let directory = eventDirectory;
  while (true) {
    await syncDirectory(directory);
    if (directory === durabilityAnchor) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  await syncDirectory(path.dirname(durabilityAnchor));
}

/** Validate and atomically publish one event. Existing event IDs are never replaced. */
export async function writeInvocationTelemetryEvent(
  workingDirectory: string,
  event: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const validated = parseInvocationTelemetryEvent(event);
  const location = resolveJunoProjectStateLocation(workingDirectory, 'telemetry', env);
  const eventDirectory = path.join(location.directory, INVOCATION_TELEMETRY_EVENT_DIRECTORY);
  await ensurePrivateTelemetryDirectories(eventDirectory, location.durabilityAnchor);

  const destination = path.join(eventDirectory, `${validated.event_id}.json`);
  const temporary = path.join(eventDirectory, `.event-${process.pid}-${randomUUID()}.tmp`);
  const handle = await nodeFs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();

    // A same-filesystem hard link is both exclusive-create and atomic publication of complete bytes.
    await nodeFs.link(temporary, destination);
    await nodeFs.unlink(temporary);
    await syncDirectory(eventDirectory);
    return destination;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await nodeFs.unlink(temporary).catch(() => undefined);
    await syncDirectory(eventDirectory).catch(() => undefined);
    throw error;
  }
}
