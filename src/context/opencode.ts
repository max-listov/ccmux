import type { OpenCodeClient } from '../agent/opencode/server.ts';
import { openCodeToolObservation } from '../agent/opencode/toolObservation.ts';
import { toolHistoryStatus } from '../content/toolSchema.ts';
import { readSelection } from '../runtime/selection.ts';
import type { MachineConfig, Session } from '../types.ts';
import { boundedHistoryPage, historyCursor, historyImageReferences } from './history.ts';
import { openCodeHistoryReader } from './opencodeHistory.ts';
import type { NativeContextApi } from './pump.ts';
import type { NativeHistoryEntry } from './schema.ts';

/** Classic message/part history is the active writer's authority, not the distinct v2 durable message table. */
export function openCodeContextApi(
  m: MachineConfig,
  s: Session,
  client: OpenCodeClient,
): NativeContextApi {
  const sessionID = s.nativeSession?.id;
  if (!sessionID) throw new Error('Native context identity is absent');
  const reader = openCodeHistoryReader(client, sessionID);
  return {
    async history(query, signal) {
      const page = await reader.parts(query.limit, signal, historyCursor(m, s, query.cursor));
      const entries: NativeHistoryEntry[] = [];
      for (const { info, parts } of page.items) {
        if (info.sessionID !== sessionID) throw new Error('Native history identity mismatch');
        for (const part of parts) {
          const tool = part.type === 'tool' ? openCodeToolObservation(part) : null;
          let kind: NativeHistoryEntry['kind'] = 'other',
            text: string | null = null;
          // Native synthetic context and compaction summaries can contain private tool inputs.
          // Keep their existence/omission explicit without rewriting authored conversation text.
          const internal = part.synthetic === true || info.summary === true;
          if (part.type === 'compaction' || info.summary === true) kind = 'compaction';
          else if (part.type === 'text' && !internal) {
            kind = info.role;
            text = part.text ?? null;
          } else if (part.type === 'tool') kind = 'tool';
          // OpenCode reasoning text is not a promised reasoning summary: do not publish it.
          const pointers = part.type === 'file' && part.filename ? [part.filename] : [];
          const images = await historyImageReferences(m, s, pointers, signal);
          const status =
            tool !== null
              ? toolHistoryStatus(tool)
              : info.error !== undefined
                ? 'failed'
                : info.time.completed !== undefined || info.role === 'user'
                  ? 'completed'
                  : 'unknown';
          entries.push({
            turnId: info.parentID ?? info.id,
            itemId: part.id,
            kind,
            text,
            omittedBytes: internal && part.type === 'text' ? Buffer.byteLength(part.text ?? '') : 0,
            images,
            omittedImages: part.type === 'file' && images.length === 0 ? 1 : 0,
            status,
            tool,
          });
        }
      }
      return boundedHistoryPage(
        m,
        s,
        entries,
        page.cursor,
        page.cursor === null ? 'complete' : 'more',
      );
    },
    async compactionMarker(signal) {
      const page = await reader.messages(64, signal);
      return (
        page.items
          .filter(
            (message) =>
              message.info.role === 'assistant' &&
              message.info.summary === true &&
              message.info.time.completed !== undefined &&
              message.info.error === undefined,
          )
          .at(-1)?.info.id ?? null
      );
    },
    async compact(signal) {
      const selection = readSelection(m, s)?.options;
      if (selection?.runtime !== 'opencode') throw new Error('Native context model is unavailable');
      await client.session.summarize(
        {
          sessionID,
          providerID: selection.model.provider,
          modelID: selection.model.model,
          auto: false,
        },
        { signal },
      );
    },
  };
}
