import { describe, expect, it, vi } from 'vitest';

const loadState: { loadavg: number[]; cpus: number } = { loadavg: [0, 0, 0], cpus: 8 };

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    loadavg: () => loadState.loadavg,
    cpus: () => Array.from({ length: loadState.cpus }, () => ({} as ReturnType<typeof actual.cpus>[number])),
  };
});

function mockLoadRatio(ratio: number, cpus = 8): void {
  loadState.loadavg = [ratio * cpus, 0, 0];
  loadState.cpus = cpus;
}

import { contentionBudgetMs, contentionMultiplier } from '../../test-utils/contention-budget.js';

describe('contention-aware test budgets', () => {
  it('returns exactly the base budget when the machine is at or below capacity', () => {
    for (const ratio of [0, 0.5, 1]) {
      mockLoadRatio(ratio);
      expect(contentionMultiplier({ minMultiplier: 1 })).toBe(1);
      expect(contentionBudgetMs(120_000)).toBe(120_000);
      expect(contentionBudgetMs(300_000, { minMultiplier: 1 })).toBe(300_000);
    }
  });

  it('scales linearly between saturation and the configured maximum', () => {
    mockLoadRatio(2);
    expect(contentionMultiplier()).toBe(2);
    mockLoadRatio(3.5);
    expect(contentionMultiplier()).toBe(3.5);
    mockLoadRatio(12);
    expect(contentionMultiplier()).toBe(4);
    expect(contentionMultiplier({ maxMultiplier: 6 })).toBe(6);
  });

  it('rounds scaled budgets up to a stable 50ms grid', () => {
    mockLoadRatio(1.37);
    const budget = contentionBudgetMs(60_000);
    expect(budget % 50).toBe(0);
    expect(budget).toBe(82_200); // 60000 * 1.37 = 82200
    mockLoadRatio(1.111);
    expect(contentionBudgetMs(1_000)).toBe(1_150); // 1111 -> ceil to grid 1150
  });

  it('rejects invalid bases and bounds instead of silently producing budgets', () => {
    mockLoadRatio(2);
    expect(() => contentionBudgetMs(0)).toThrow(/invalid contention budget base/);
    expect(() => contentionBudgetMs(-5)).toThrow(/invalid contention budget base/);
    expect(() => contentionMultiplier({ minMultiplier: 4, maxMultiplier: 2 })).toThrow(/invalid contention multiplier bounds/);
    expect(() => contentionMultiplier({ minMultiplier: 0 })).toThrow(/invalid contention multiplier bounds/);
  });

  it('honors a single-cpu floor and non-integer load histories', () => {
    mockLoadRatio(5, 1);
    expect(contentionMultiplier()).toBe(4);
    mockLoadRatio(1.25, 3);
    expect(contentionMultiplier()).toBe(1.25);
  });
});
