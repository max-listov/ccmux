import { z } from "zod";
import type { MachineConfig, Session } from "../types.ts";
import type { OpenCodeClient } from "../agent/opencode/server.ts";
import { readSelection } from "../runtime/selection.ts";
import { boundedHistoryPage, historyCursor, historyImageReferences } from "./history.ts";
import type { NativeContextApi } from "./pump.ts";
import type { NativeHistoryEntry } from "./schema.ts";

const Id = z.string().min(1).max(256);
const MessageSchema = z.object({ info: z.object({ id: Id, sessionID: Id, role: z.enum(["user", "assistant"]),
  parentID: Id.optional(), summary: z.union([z.boolean(), z.object({}).strip()]).optional(), time: z.object({ completed: z.number().optional() }),
  error: z.unknown().optional() }),
  parts: z.array(z.object({ id: Id, type: z.string(), text: z.string().optional(), filename: z.string().optional(),
    state: z.object({ status: z.string() }).optional() })).max(256) });
const PageSchema = z.array(MessageSchema).max(64);

/** Classic message/part history is the active writer's authority, not the distinct v2 durable message table. */
export function openCodeContextApi(m: MachineConfig, s: Session, client: OpenCodeClient): NativeContextApi {
  const sessionID = s.nativeSession?.id;
  if (!sessionID) throw new Error("Native context identity is absent");
  const read = async (limit: number, signal: AbortSignal, before?: string) => {
    const response = await client.session.messages({ sessionID, limit, ...(before === undefined ? {} : { before }) }, { signal });
    const cursor = response.response.headers.get("X-Next-Cursor");
    return { items: PageSchema.parse(response.data), cursor: cursor === null ? null : z.string().min(1).max(4_096).parse(cursor) };
  };
  return {
    async history(query, signal) {
      const page = await read(query.limit, signal, historyCursor(m, s, query.cursor));
      const entries: NativeHistoryEntry[] = [];
      for (const { info, parts } of page.items) {
        if (info.sessionID !== sessionID) throw new Error("Native history identity mismatch");
        for (const part of parts) {
          let kind: NativeHistoryEntry["kind"] = "other", text: string | null = null;
          if (part.type === "text") { kind = info.role; text = part.text ?? null; }
          else if (part.type === "tool") kind = "tool";
          else if (part.type === "compaction" || info.summary === true) kind = "compaction";
          // OpenCode reasoning text is not a promised reasoning summary: do not publish it.
          const pointers = part.type === "file" && part.filename ? [part.filename] : [];
          const images = await historyImageReferences(m, s, pointers, signal);
          const status = part.state?.status === "error" || info.error !== undefined ? "failed"
            : info.time.completed !== undefined || info.role === "user" ? "completed" : "unknown";
          entries.push({ turnId: info.parentID ?? info.id, itemId: part.id, kind, text, omittedBytes: 0,
            images, omittedImages: part.type === "file" && images.length === 0 ? 1 : 0, status });
        }
      }
      return boundedHistoryPage(m, s, entries, page.cursor, page.cursor === null ? "complete" : "more");
    },
    async compactionMarker(signal) {
      const page = await read(64, signal);
      return page.items.filter(message => message.info.role === "assistant" && message.info.summary === true
        && message.info.time.completed !== undefined && message.info.error === undefined).at(-1)?.info.id ?? null;
    },
    async compact(signal) {
      const selection = readSelection(m, s)?.options;
      if (selection?.runtime !== "opencode") throw new Error("Native context model is unavailable");
      await client.session.summarize({ sessionID, providerID: selection.model.provider, modelID: selection.model.model, auto: false }, { signal });
    },
  };
}
