import { USAGE_FIELDS, type UsageAggregate } from './schema.ts';

/** A missing source or replay window limits every measured dimension, not just the headline. */
export function partialUsage(usage: UsageAggregate) {
  if (usage.coverage === 'full') usage.coverage = 'partial';
  for (const field of USAGE_FIELDS)
    if (usage.fieldCoverage[field] === 'full') usage.fieldCoverage[field] = 'partial';
}
