import type { UsageFact } from './schema.ts';
import { emptyUsage, USAGE_FIELDS } from './schema.ts';

/** One normalized contribution; counter resets need provider evidence, never a clamp. */
export function usageContribution(fact: UsageFact, previous: UsageFact | null): UsageFact {
  if (fact.mode !== 'cumulative') return fact;
  if (!previous) return { ...fact, mode: 'replacement', at: null };
  const metrics = emptyUsage();
  let ambiguous = false;
  for (const field of USAGE_FIELDS) {
    const current = fact.metrics[field],
      before = previous.metrics[field];
    if (current === null) continue;
    if (before === null) {
      metrics[field] = current;
      ambiguous = true;
      continue;
    }
    if (current < before) ambiguous = true;
    else metrics[field] = current - before;
  }
  const cost =
    fact.cost &&
    previous.cost &&
    fact.cost.currency === previous.cost.currency &&
    fact.cost.value >= previous.cost.value
      ? { ...fact.cost, value: fact.cost.value - previous.cost.value }
      : null;
  return {
    ...fact,
    mode: 'replacement',
    metrics,
    cost,
    at: ambiguous ? null : fact.at,
    counterAmbiguous: ambiguous,
  };
}
