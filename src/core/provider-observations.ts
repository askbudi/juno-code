import { z } from 'zod';

const boundedNullableString = z.string().min(1).max(256).nullable();
const knownNumber = z.number().finite().nonnegative().nullable();
const completeness = z.enum(['available', 'partial', 'unavailable']);

export const normalizedTokenUsageSchema = z.object({
  status: completeness,
  input_tokens: knownNumber,
  output_tokens: knownNumber,
  cache_read_tokens: knownNumber,
  cache_write_tokens: knownNumber,
  reasoning_tokens: knownNumber,
  total_tokens: knownNumber,
}).strict();

export const normalizedEstimatedCostSchema = z.object({
  status: completeness,
  amount: knownNumber,
  currency: z.string().min(1).max(16).nullable(),
  provenance: z.string().min(1).max(128).nullable(),
}).strict();

export const providerObservationSchema = z.object({
  session_id: boundedNullableString,
  provider: boundedNullableString,
  resolved_model: boundedNullableString,
  usage: normalizedTokenUsageSchema,
  estimated_cost: normalizedEstimatedCostSchema,
}).strict();

export const providerObservationsSchema = z.object({
  status: completeness,
  execution_service: z.string().min(1).max(256),
  observations: z.array(providerObservationSchema).max(100),
  usage: normalizedTokenUsageSchema,
  estimated_cost: normalizedEstimatedCostSchema,
}).strict();

export type NormalizedTokenUsage = z.infer<typeof normalizedTokenUsageSchema>;
export type NormalizedEstimatedCost = z.infer<typeof normalizedEstimatedCostSchema>;
export type ProviderObservation = z.infer<typeof providerObservationSchema>;
export type ProviderObservations = z.infer<typeof providerObservationsSchema>;

type JsonObject = Record<string, unknown>;
const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'total_tokens',
] as const;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function parseObject(value: unknown): JsonObject | null {
  if (typeof value !== 'string') return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function boundedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function candidates(payload: JsonObject): JsonObject[] {
  // These are allowlisted fields in provider terminal envelopes, not a generic
  // recursive walk. In particular, messages/history are never candidates.
  const values: JsonObject[] = [payload];
  const appendEnvelope = (value: unknown): void => {
    const envelope = object(value);
    if (!envelope || values.includes(envelope)) return;
    values.push(envelope);
    const message = object(envelope.message);
    if (message) values.push(message);
  };
  appendEnvelope(payload.message);
  appendEnvelope(payload.sub_agent_response);
  appendEnvelope(object(payload.sub_agent_response)?.sub_agent_response);
  return values;
}

function firstString(values: JsonObject[], keys: string[]): string | null {
  for (const value of values) {
    for (const key of keys) {
      const candidate = boundedString(value[key]);
      if (candidate) return candidate;
    }
  }
  return null;
}

function firstNumber(values: JsonObject[], keys: string[]): number | null {
  for (const value of values) {
    for (const key of keys) {
      const candidate = number(value[key]);
      if (candidate !== null) return candidate;
    }
  }
  return null;
}

function usageStatus(usage: Omit<NormalizedTokenUsage, 'status'>): NormalizedTokenUsage['status'] {
  const values = USAGE_FIELDS.map((field) => usage[field]);
  if (values.every((value) => value === null)) return 'unavailable';
  return values.every((value) => value !== null) ? 'available' : 'partial';
}

function normalizeUsage(payloadCandidates: JsonObject[]): NormalizedTokenUsage {
  let usage: JsonObject | null = null;
  for (const candidate of payloadCandidates) {
    usage = object(candidate.usage);
    if (usage) break;
  }
  const inputDetails = object(usage?.input_tokens_details ?? usage?.inputTokensDetails);
  const outputDetails = object(usage?.output_tokens_details ?? usage?.outputTokensDetails);

  const normalized = {
    input_tokens: usage ? firstNumber([usage], ['input', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']) : null,
    output_tokens: usage ? firstNumber([usage], ['output', 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']) : null,
    cache_read_tokens: usage
      ? firstNumber([usage], ['cacheRead', 'cache_read', 'cache_read_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens'])
        ?? firstNumber(inputDetails ? [inputDetails] : [], ['cached_tokens', 'cachedTokens'])
      : null,
    cache_write_tokens: usage
      ? firstNumber([usage], ['cacheWrite', 'cache_write', 'cache_write_tokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens'])
      : null,
    reasoning_tokens: usage
      ? firstNumber([usage], ['reasoning', 'reasoning_tokens', 'reasoningTokens'])
        ?? firstNumber(outputDetails ? [outputDetails] : [], ['reasoning_tokens', 'reasoningTokens'])
      : null,
    total_tokens: usage ? firstNumber([usage], ['totalTokens', 'total_tokens']) : null,
  };
  return { status: usageStatus(normalized), ...normalized };
}

function normalizeCost(payloadCandidates: JsonObject[]): NormalizedEstimatedCost {
  const directUsd = firstNumber(payloadCandidates, ['total_cost_usd', 'totalCostUsd', 'totalCostUSD']);
  if (directUsd !== null) {
    return {
      status: 'available',
      amount: directUsd,
      currency: 'USD',
      provenance: 'provider_reported_total_cost_usd',
    };
  }

  for (const candidate of payloadCandidates) {
    const usage = object(candidate.usage);
    const usageCost = object(usage?.cost);
    const amount = number(usageCost?.total);
    if (amount !== null) {
      return {
        status: 'partial',
        amount,
        currency: null,
        provenance: 'provider_reported_usage_cost_total',
      };
    }
  }
  return { status: 'unavailable', amount: null, currency: null, provenance: null };
}

function modelFromModelUsage(payloadCandidates: JsonObject[]): string | null {
  for (const candidate of payloadCandidates) {
    const modelUsage = object(candidate.modelUsage ?? candidate.model_usage);
    if (!modelUsage) continue;
    const models = Object.keys(modelUsage).filter((key) => boundedString(key));
    if (models.length === 1) return boundedString(models[0]);
  }
  return null;
}

function normalizeObservation(payload: JsonObject): ProviderObservation | null {
  const payloadCandidates = candidates(payload);
  let sessionId = firstString(payloadCandidates, ['session_id', 'sessionId', 'thread_id', 'threadId']);
  if (!sessionId) {
    for (const candidate of payloadCandidates) {
      if (candidate.type === 'session') {
        sessionId = boundedString(candidate.id);
        if (sessionId) break;
      }
    }
  }
  const provider = firstString(payloadCandidates, ['provider']);
  const resolvedModel = firstString(payloadCandidates, ['model']) ?? modelFromModelUsage(payloadCandidates);
  const usage = normalizeUsage(payloadCandidates);
  const estimatedCost = normalizeCost(payloadCandidates);

  if (!sessionId && !provider && !resolvedModel && usage.status === 'unavailable' && estimatedCost.status === 'unavailable') {
    return null;
  }
  return { session_id: sessionId, provider, resolved_model: resolvedModel, usage, estimated_cost: estimatedCost };
}

function aggregateUsage(observations: ProviderObservation[]): NormalizedTokenUsage {
  const normalized = Object.fromEntries(USAGE_FIELDS.map((field) => {
    const known = observations.map((entry) => entry.usage[field]).filter((value): value is number => value !== null);
    return [field, known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0)];
  })) as Omit<NormalizedTokenUsage, 'status'>;
  const hasIncompleteObservation = observations.some((entry) => entry.usage.status !== 'available');
  const status = usageStatus(normalized);
  return { status: status === 'available' && hasIncompleteObservation ? 'partial' : status, ...normalized };
}

function aggregateCost(observations: ProviderObservation[]): NormalizedEstimatedCost {
  const known = observations.filter((entry) => entry.estimated_cost.amount !== null);
  if (known.length === 0) return { status: 'unavailable', amount: null, currency: null, provenance: null };
  const currencies = new Set(known.map((entry) => entry.estimated_cost.currency).filter((value): value is string => value !== null));
  const complete = known.length === observations.length && known.every((entry) => entry.estimated_cost.status === 'available');
  return {
    status: complete ? 'available' : 'partial',
    amount: known.reduce((sum, entry) => sum + entry.estimated_cost.amount!, 0),
    currency: currencies.size === 1 && known.every((entry) => entry.estimated_cost.currency !== null)
      ? [...currencies][0]!
      : null,
    provenance: 'normalized_sum_of_provider_observations',
  };
}

export function unavailableProviderObservations(executionService: unknown): ProviderObservations {
  return {
    status: 'unavailable',
    execution_service: boundedString(executionService) ?? 'unknown',
    observations: [],
    usage: {
      status: 'unavailable',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      total_tokens: null,
    },
    estimated_cost: { status: 'unavailable', amount: null, currency: null, provenance: null },
  };
}

/** Normalize only backend/provider structured terminal envelopes; never inspect prose or message history. */
export function normalizeProviderObservations(result: unknown): ProviderObservations {
  const root = object(result);
  const request = object(root?.request);
  const executionService = boundedString(request?.subagent) ?? 'unknown';
  const iterations = Array.isArray(root?.iterations) ? root.iterations.slice(0, 100) : [];
  const observations: ProviderObservation[] = [];

  for (const iterationValue of iterations) {
    const iteration = object(iterationValue);
    const toolResult = object(iteration?.toolResult);
    const metadata = object(toolResult?.metadata);
    const payload = parseObject(toolResult?.content);
    // ShellBackend explicitly marks provider terminal envelopes. Requiring both
    // signals prevents JSON-looking assistant output from becoming evidence.
    if (metadata?.structuredOutput !== true || !payload || payload.type !== 'result') continue;
    const observation = normalizeObservation(payload);
    if (observation) observations.push(observation);
  }

  if (observations.length === 0) return unavailableProviderObservations(executionService);

  const usage = aggregateUsage(observations);
  const estimatedCost = aggregateCost(observations);
  const fullyAvailable = observations.every((entry) =>
    entry.session_id !== null && entry.provider !== null && entry.resolved_model !== null &&
    entry.usage.status === 'available' && entry.estimated_cost.status === 'available');

  return providerObservationsSchema.parse({
    status: fullyAvailable ? 'available' : 'partial',
    execution_service: executionService,
    observations,
    usage,
    estimated_cost: estimatedCost,
  });
}
