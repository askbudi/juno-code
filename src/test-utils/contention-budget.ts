import * as os from 'node:os';

/**
 * Contention-aware test budgets.
 *
 * Merge-queue admission suites run on shared machines where ambient load can
 * exceed CPU capacity for minutes. Fixed wall-clock budgets that are tight on
 * an idle machine fail on a loaded one even though the candidate is correct:
 * every such failure restarts a whole admission run. These helpers scale a
 * test's base budget by the current one-minute load ratio (loadavg / cpus) so
 * borderline tests keep their idle-machine speed while surviving contention.
 *
 * The multiplier is clamped to [min, max] (default [1, 4]) so budgets stay
 * bounded and deterministic on quiet machines (exactly the base value) and at
 * most max times the base under heavy oversubscription.
 */
export interface ContentionBudgetOptions {
  readonly minMultiplier?: number;
  readonly maxMultiplier?: number;
}

export function contentionMultiplier(options: ContentionBudgetOptions = {}): number {
  const min = options.minMultiplier ?? 1;
  const max = options.maxMultiplier ?? 4;
  if (!(max >= min) || !(min > 0)) throw new Error(`invalid contention multiplier bounds: min=${min} max=${max}`);
  const cpus = Math.max(1, os.cpus().length);
  const load = Math.max(0, os.loadavg()[0] ?? 0);
  return Math.min(max, Math.max(min, load / cpus));
}

/**
 * Scale a base budget by the current contention multiplier and round up to a
 * 50ms grid so asserted/derived values stay stable and readable in output.
 */
export function contentionBudgetMs(baseMs: number, options: ContentionBudgetOptions = {}): number {
  if (!(baseMs > 0)) throw new Error(`invalid contention budget base: ${baseMs}`);
  return Math.ceil((baseMs * contentionMultiplier(options)) / 50) * 50;
}
