import { z } from 'zod';
import type { CodexAppRpc } from '../agent/codex/rpc.ts';
import { supportsNativeTurnMetadata } from './native-list.ts';
import type { ExternalTurnState } from './turnSchema.ts';

export const MAX_NATIVE_TURN_READS = 64;
const CONCURRENCY = 4;
export const NativeTurnSchema = z.object({
  id: z.string().min(1).max(128),
  status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
  startedAt: z.number().int().nonnegative().max(253_402_300_799).nullable().optional(),
});
export type NativeTurn = z.infer<typeof NativeTurnSchema>;
export const NativeTurnEventSchema = z.object({ threadId: z.uuid(), turn: NativeTurnSchema });
const PageSchema = z.object({
  data: z
    .array(
      NativeTurnSchema.extend({
        itemsView: z.literal('notLoaded'),
        items: z.array(z.unknown()).max(0),
      }),
    )
    .max(1),
  nextCursor: z.string().max(4096).nullable(),
});

export function withNativeTurn(state: ExternalTurnState, turn?: NativeTurn): ExternalTurnState {
  if (state.state === 'unknown' || state.state === 'idle' || turn?.status !== 'inProgress')
    return { ...state, turnId: null, startedAt: null };
  return {
    ...state,
    turnId: turn.id,
    startedAt: turn.startedAt == null ? null : new Date(turn.startedAt * 1000).toISOString(),
  };
}

/** A bounded metadata page, never thread/read(includeTurns) or a history walk. */
export async function readNativeTurns(
  rpc: CodexAppRpc,
  activeIds: string[],
  signal: AbortSignal,
): Promise<Map<string, NativeTurn>> {
  const result = new Map<string, NativeTurn>();
  if (!supportsNativeTurnMetadata(rpc.userAgent)) return result;
  const ids = activeIds.slice(0, MAX_NATIVE_TURN_READS);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      for (;;) {
        signal.throwIfAborted();
        const id = ids[next++];
        if (id === undefined) return;
        try {
          const page = PageSchema.parse(
            await rpc.request('thread/turns/list', {
              threadId: id,
              cursor: null,
              limit: 1,
              sortDirection: 'desc',
              itemsView: 'notLoaded',
            }),
          );
          signal.throwIfAborted();
          const turn = page.data[0];
          if (turn?.status === 'inProgress') result.set(id, turn);
        } catch {
          // A missing/unreadable turn is not a new turn and does not invalidate a native status.
          signal.throwIfAborted();
        }
      }
    }),
  );
  return result;
}
