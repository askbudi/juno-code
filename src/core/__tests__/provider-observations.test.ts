import { describe, expect, it } from 'vitest';

import { normalizeProviderObservations } from '../provider-observations.js';

function result(subagent: string, payloads: unknown[]) {
  return {
    request: { subagent },
    iterations: payloads.map((payload, index) => ({
      iterationNumber: index + 1,
      toolResult: {
        content: typeof payload === 'string' ? payload : JSON.stringify({ type: 'result', ...(payload as object) }),
        metadata: { structuredOutput: true },
      },
    })),
  };
}

describe('provider observation normalization', () => {
  it('normalizes Claude-native identity, usage, and explicitly reported USD cost', () => {
    const normalized = normalizeProviderObservations(result('claude', [{
      session_id: 'claude-session-1',
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 30,
      },
      modelUsage: { 'claude-sonnet-4-6': { inputTokens: 100 } },
    }]));

    expect(normalized.execution_service).toBe('claude');
    expect(normalized.observations).toEqual([expect.objectContaining({
      session_id: 'claude-session-1',
      provider: null,
      resolved_model: 'claude-sonnet-4-6',
      usage: {
        status: 'partial',
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_write_tokens: 4,
        reasoning_tokens: null,
        total_tokens: null,
      },
      estimated_cost: {
        status: 'available',
        amount: 0.0123,
        currency: 'USD',
        provenance: 'provider_reported_total_cost_usd',
      },
    })]);
  });

  it('normalizes Pi provider metadata without retaining messages or content', () => {
    const normalized = normalizeProviderObservations(result('pi', [{
      session_id: 'pi-session-1',
      result: 'private completion',
      usage: {
        input: 64,
        output: 137,
        cacheRead: 8,
        cacheWrite: 2,
        totalTokens: 211,
        cost: { total: 0.000402 },
      },
      sub_agent_response: {
        message: {
          provider: 'zai',
          model: 'glm-5',
          usage: { input: 64, output: 137 },
        },
        messages: [{ role: 'user', content: 'private prompt' }],
      },
    }]));

    expect(normalized.observations[0]).toMatchObject({
      session_id: 'pi-session-1',
      provider: 'zai',
      resolved_model: 'glm-5',
      usage: {
        status: 'partial',
        input_tokens: 64,
        output_tokens: 137,
        cache_read_tokens: 8,
        cache_write_tokens: 2,
        reasoning_tokens: null,
        total_tokens: 211,
      },
      estimated_cost: {
        status: 'partial',
        amount: 0.000402,
        currency: null,
        provenance: 'provider_reported_usage_cost_total',
      },
    });
    expect(JSON.stringify(normalized)).not.toContain('private');
  });

  it('maps Codex/OpenAI token detail fields and preserves known zeroes only when reported', () => {
    const normalized = normalizeProviderObservations(result('codex', [{
      thread_id: 'codex-thread-1',
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        total_tokens: 60,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    }]));

    expect(normalized.observations[0]).toMatchObject({
      session_id: 'codex-thread-1',
      provider: 'openai-codex',
      resolved_model: 'gpt-5-codex',
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_write_tokens: null,
        reasoning_tokens: 7,
        total_tokens: 60,
      },
    });
  });

  it('reports unavailable truth for malformed/content-only results without prose parsing or invented zeroes', () => {
    const normalized = normalizeProviderObservations(result('pi', [
      '{not-json',
      { result: 'session_id: invented-from-prose; tokens: 0' },
    ]));

    expect(normalized).toEqual({
      status: 'unavailable',
      execution_service: 'pi',
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
      estimated_cost: {
        status: 'unavailable',
        amount: null,
        currency: null,
        provenance: null,
      },
    });
  });

  it('refuses identity and billing fields from unmarked or non-terminal JSON', () => {
    const normalized = normalizeProviderObservations({
      request: { subagent: 'codex' },
      iterations: [{
        toolResult: {
          content: JSON.stringify({
            type: 'assistant',
            session_id: 'not-terminal',
            usage: { input_tokens: 12 },
            total_cost_usd: 1,
          }),
          metadata: { structuredOutput: true },
        },
      }],
    });

    expect(normalized.status).toBe('unavailable');
    expect(normalized.observations).toEqual([]);
    expect(normalized.usage.input_tokens).toBeNull();
    expect(normalized.estimated_cost.amount).toBeNull();

    const unmarked = normalizeProviderObservations({
      request: { subagent: 'pi' },
      iterations: [{ toolResult: { content: JSON.stringify({
        type: 'result', session_id: 'assistant-authored', total_cost_usd: 9,
      }) } }],
    });
    expect(unmarked).toMatchObject({ status: 'unavailable', observations: [] });
  });

  it('ignores copied/forked message history and sums only one top-level result observation per iteration', () => {
    const copiedUsage = { input: 9999, output: 9999, totalTokens: 19998, cost: { total: 99 } };
    const normalized = normalizeProviderObservations(result('pi', [
      {
        session_id: 'fork-a',
        usage: { input: 10, output: 2, totalTokens: 12 },
        sub_agent_response: { messages: [{ role: 'assistant', usage: copiedUsage }] },
      },
      {
        session_id: 'fork-b',
        usage: { input: 20, output: 3, totalTokens: 23 },
        messages: [{ role: 'assistant', usage: copiedUsage }],
      },
    ]));

    expect(normalized.observations.map((entry) => entry.session_id)).toEqual(['fork-a', 'fork-b']);
    expect(normalized.usage).toMatchObject({ input_tokens: 30, output_tokens: 5, total_tokens: 35 });
    expect(normalized.estimated_cost.amount).toBeNull();
  });
});
