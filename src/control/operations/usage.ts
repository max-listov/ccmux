import type { z } from 'zod';
import { readExternalContent, readExternalContentCapabilities } from '../../external/content.ts';
import type {
  ExternalContentReadSchema,
  ExternalContentSelectorSchema,
} from '../../external/contentSchema.ts';
import type { UsageListSchema, UsageReadSchema } from '../../usage/schema.ts';
import { listSessionUsage, readSessionUsage } from '../../usage/service.ts';
import type { OperationContext } from './context.ts';
import { controlRefusal } from './refusal.ts';

/** Usage and the external inventory: reads of what exists and what it cost. */
export function usageOperations(context: OperationContext) {
  const { m, external, reads, dependencies } = context;
  return {
    usage: (input: z.output<typeof UsageReadSchema>, signal?: AbortSignal) =>
      reads
        .run(
          undefined,
          ({ signal: admitted }) =>
            readSessionUsage(m, input.address, input.query, false, admitted),
          {
            ...(signal ? { signal } : {}),
            timeoutMs: 6_000,
          },
        )
        .catch(controlRefusal),
    usageList: (input: z.output<typeof UsageListSchema>, signal?: AbortSignal) =>
      reads
        .run(
          undefined,
          ({ signal: admitted }) =>
            listSessionUsage(
              m,
              input.query,
              input.cursor,
              input.limit,
              external.read().sessions.map((s) => s.identity.threadId),
              admitted,
            ),
          {
            ...(signal ? { signal } : {}),
            timeoutMs: 6_000,
          },
        )
        .catch(controlRefusal),
    externalHistory: (input: z.output<typeof ExternalContentReadSchema>, signal?: AbortSignal) =>
      reads
        .run(
          undefined,
          async ({ signal: admitted }) => {
            dependencies.assertExternalConfig?.();
            const result = await readExternalContent(m, input, admitted);
            dependencies.assertExternalConfig?.();
            return result;
          },
          {
            ...(signal ? { signal } : {}),
            timeoutMs: 6_000,
          },
        )
        .catch(controlRefusal),
    externalCapabilities: (
      input: z.output<typeof ExternalContentSelectorSchema>,
      signal?: AbortSignal,
    ) =>
      reads
        .run(
          undefined,
          async ({ signal: admitted }) => {
            dependencies.assertExternalConfig?.();
            const result = await readExternalContentCapabilities(m, input.target, admitted);
            dependencies.assertExternalConfig?.();
            return result;
          },
          {
            ...(signal ? { signal } : {}),
            timeoutMs: 6_000,
          },
        )
        .catch(controlRefusal),
  };
}
