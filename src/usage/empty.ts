import { emptyUsage, type UsageAggregate } from './schema.ts';

export function emptyAggregate(): UsageAggregate {
  return {
    values: emptyUsage(),
    observations: 0,
    measured: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    fieldCoverage: {
      inputTokens: 'unknown',
      outputTokens: 'unknown',
      cacheReadTokens: 'unknown',
      cacheCreationTokens: 'unknown',
      reasoningTokens: 'unknown',
      totalTokens: 'unknown',
    },
    coverage: 'unknown',
    costs: [],
  };
}
