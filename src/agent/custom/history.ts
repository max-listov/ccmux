import { AppError } from 'stitchkit';
import type { AgentMessage } from 'stitchkit/agent-runtime';
import {
  boundedHistoryPage,
  historyCursor,
  historyImageReferences,
} from '../../context/history.ts';
import type { NativeContextApi } from '../../context/pump.ts';
import { HISTORY_LIMITS, type NativeHistoryEntry } from '../../context/schema.ts';
import type { MachineConfig, Session } from '../../types.ts';
import type { openCustomEngine } from './engine.ts';
import { CustomInputMetadataSchema } from './input.ts';
import { customToolObservation } from './toolObservation.ts';

export function customContextApi(
  m: MachineConfig,
  s: Session,
  engine: Awaited<ReturnType<typeof openCustomEngine>>,
): NativeContextApi {
  return {
    async history(query, signal) {
      signal.throwIfAborted();
      const cursor = historyCursor(m, s, query.cursor);
      const page = await engine.sqlite.conversations.messages({
        conversationId: engine.conversationId,
        direction: 'before',
        limit: query.limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const entries: NativeHistoryEntry[] = [];
      let omitted = 0;
      for (const message of page.items) {
        signal.throwIfAborted();
        if (message.conversationId !== engine.conversationId)
          throw new Error('History identity differs');
        const metadata = CustomInputMetadataSchema.safeParse(message.metadata);
        const turnId = message.runId ?? (metadata.success ? metadata.data.messageId : undefined);
        if (!turnId || !['user', 'assistant'].includes(message.role)) {
          omitted++;
          continue;
        }
        const pointers = message.parts.filter((p) => p.type === 'file').map((p) => p.reference);
        const images = await historyImageReferences(m, s, pointers, signal);
        const text = message.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('');
        const reasoning = message.parts
          .filter((p) => p.type === 'reasoning')
          .map((p) => p.text)
          .join('');
        const base = {
          turnId,
          text: null,
          omittedBytes: 0,
          images: [],
          omittedImages: 0,
          status: historyStatus(message),
          tool: null,
        } satisfies Omit<NativeHistoryEntry, 'itemId' | 'kind'>;
        const append = (entry: NativeHistoryEntry) => {
          if (entries.length < HISTORY_LIMITS.entries) entries.push(entry);
          else omitted++;
        };
        if (text || images.length)
          append({
            ...base,
            itemId: message.id,
            kind: message.role === 'user' ? 'user' : 'assistant',
            text,
            images,
            omittedImages: Math.max(0, pointers.length - images.length),
          });
        if (reasoning)
          append({
            ...base,
            itemId: `${message.id}:reasoning`,
            kind: 'reasoning-summary',
            text: reasoning,
          });
        for (const part of message.parts)
          if (part.type === 'tool-result')
            append({
              ...base,
              itemId: part.callId,
              kind: 'tool',
              tool: customToolObservation(
                part.toolName,
                part.callId,
                part.outcome === 'success'
                  ? 'succeeded'
                  : part.outcome === 'interrupted'
                    ? 'interrupted'
                    : 'failed',
                part.output,
              ),
            });
      }
      signal.throwIfAborted();
      return boundedHistoryPage(
        m,
        s,
        entries,
        page.nextCursor ?? null,
        page.nextCursor ? 'more' : 'complete',
        omitted,
      );
    },
    async compact() {
      throw new AppError('UNSUPPORTED', 'Native compaction is unavailable', 409);
    },
    async compactionMarker() {
      return null;
    },
  };
}
function historyStatus(message: AgentMessage): NativeHistoryEntry['status'] {
  if (message.status === 'streaming') return 'inProgress';
  if (message.status === 'failed' || message.status === 'interrupted') return 'failed';
  return message.status === 'completed' || message.status === 'committed' ? 'completed' : 'unknown';
}
