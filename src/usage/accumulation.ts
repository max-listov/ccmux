import { USAGE_FIELDS, type UsageAggregate, type UsageFact } from './schema.ts';

const formatters = new Map<string, Intl.DateTimeFormat>();
function dayOf(at: string, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value ?? '');
    formatters.set(timezone, formatter);
  }
  return formatter.format(new Date(at));
}

export function usageBucket(fact: UsageFact, timezone: string) {
  return {
    day: fact.at ? dayOf(fact.at, timezone) : null,
    model: fact.model,
    provider: fact.provider,
    inputIncludesCache: fact.inputIncludesCache,
    outputIncludesReasoning: fact.outputIncludesReasoning,
    ...(fact.provenance ? { provenance: fact.provenance } : {}),
    ...(fact.details ? { details: fact.details } : {}),
  };
}

export function addUsage(target: UsageAggregate, fact: UsageFact, sign: number) {
  target.observations += sign;
  for (const field of USAGE_FIELDS) {
    const value = fact.metrics[field];
    if (value === null) continue;
    target.measured[field] += sign;
    const sum = (target.values[field] ?? 0) + sign * value;
    if (!Number.isSafeInteger(sum) || sum < 0)
      throw new Error('Usage aggregate exceeds safe integer range');
    target.values[field] = target.measured[field] ? sum : null;
  }
  const cost = fact.cost;
  if (cost) {
    let row = target.costs.find(
      (c) => c.currency === cost.currency && c.provenance === (cost.provenance ?? null),
    );
    if (!row) {
      if (target.costs.length >= 32) throw new Error('Usage currency dimension limit exceeded');
      row = {
        currency: cost.currency,
        reported: 0,
        observations: 0,
        provenance: cost.provenance ?? null,
      };
      target.costs.push(row);
    }
    row.reported = Math.max(0, row.reported + sign * cost.value);
    if (!Number.isFinite(row.reported)) throw new Error('Usage cost exceeds numeric range');
    row.observations += sign;
    target.costs = target.costs.filter((c) => c.observations > 0);
  }
}

export function finishUsage(value: UsageAggregate, partial: boolean) {
  value.coverage = !Object.values(value.measured).some((n) => n > 0)
    ? 'unknown'
    : partial
      ? 'partial'
      : 'full';
  for (const field of USAGE_FIELDS)
    value.fieldCoverage[field] = !value.measured[field]
      ? 'unknown'
      : partial || value.measured[field] !== value.observations
        ? 'partial'
        : 'full';
  if (Object.values(value.fieldCoverage).includes('partial')) value.coverage = 'partial';
}
