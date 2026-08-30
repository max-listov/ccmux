import { z } from "zod";
import { AppError } from "stitchkit";
import type { MachineConfig, Session } from "../types.ts";
import type { CodexAppRpc, CodexRpcEvent } from "../agent/codex/rpc.ts";
import type { NativeContextApi } from "./pump.ts";
import type { NativeHistoryEntry } from "./schema.ts";
import { boundedHistoryPage, historyCursor, historyImageReferences } from "./history.ts";
import { HISTORY_LIMITS } from "./schema.ts";

// Cancellation releases the caller, not the native request. Retain its one slot until ACK/timeout
// so repeated cancelled reads cannot accumulate work on the shared owner connection.
const pendingRequests = new WeakMap<CodexAppRpc, Promise<unknown>>();
async function contextRequest(rpc: CodexAppRpc, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (pendingRequests.has(rpc)) throw new AppError("CONTEXT_RPC_PENDING", "A native context request is still pending", 409);
  const reply = rpc.request(method, params);
  pendingRequests.set(rpc, reply);
  void reply.then(() => pendingRequests.delete(rpc), () => pendingRequests.delete(rpc));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void reply.then(value => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener("abort", aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}
const boundedSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(HISTORY_LIMITS.deadlineMs)]);

const Id = z.string().min(1).max(256);
const InputSchema = z.object({ type: z.string(), text: z.string().optional(), path: z.string().optional(), url: z.string().optional() });
const ItemSchema = z.object({ id: Id, type: z.string(), text: z.string().optional(), summary: z.array(z.string()).optional(),
  content: z.unknown().optional(), status: z.string().optional() });
const PageSchema = z.object({ data: z.array(z.object({ turnId: Id, item: ItemSchema })).max(64), nextCursor: z.string().max(4_096).nullable() });
const CompletionSchema = z.object({ threadId: Id, turnId: Id, item: z.object({ type: z.literal("contextCompaction"), id: Id }) });

/** Current native lifecycle: the completed item follows replacement of the compacted history. */
export function isCodexContextCompletion(event: CodexRpcEvent, threadId: string): boolean {
  if (event.method !== "item/completed") return false;
  const parsed = CompletionSchema.safeParse(event.params);
  return parsed.success && parsed.data.threadId === threadId;
}
export function codexContextApi(m: MachineConfig, s: Session, rpc: CodexAppRpc): NativeContextApi {
  const read = async (limit: number, signal: AbortSignal, cursor?: string) => PageSchema.parse(await contextRequest(rpc, "thread/items/list", {
    threadId: s.uuid, limit, sortDirection: "desc", ...(cursor === undefined ? {} : { cursor }),
  }, signal));
  return {
    async history(query, callerSignal) {
      const signal = boundedSignal(callerSignal);
      signal.throwIfAborted();
      const page = await read(query.limit, signal, historyCursor(m, s, query.cursor));
      const entries: NativeHistoryEntry[] = [];
      for (const { turnId, item } of page.data) {
        signal.throwIfAborted();
        let text: string | null = null, kind: NativeHistoryEntry["kind"] = "other", pointers: string[] = [], images = 0;
        if (item.type === "userMessage") {
          kind = "user";
          const inputs = z.array(InputSchema).max(256).parse(item.content);
          text = inputs.filter(input => input.type === "text").map(input => input.text ?? "").join("\n");
          const nativeImages = inputs.filter(input => input.type === "image" || input.type === "localImage");
          images = nativeImages.length; pointers = nativeImages.flatMap(input => input.path === undefined ? [] : [input.path]);
        } else if (item.type === "agentMessage" || item.type === "plan") { kind = "assistant"; text = item.text ?? null; }
        else if (item.type === "reasoning") { kind = "reasoning-summary"; text = item.summary?.join("\n") ?? null; }
        else if (item.type === "contextCompaction") kind = "compaction";
        else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration"].includes(item.type)) kind = "tool";
        const references = await historyImageReferences(m, s, pointers, signal);
        const status = item.status === "inProgress" || item.status === "completed" || item.status === "failed" ? item.status : "unknown";
        entries.push({ turnId, itemId: item.id, kind, text, omittedBytes: 0, images: references,
          omittedImages: Math.max(0, images - references.length), status });
      }
      signal.throwIfAborted();
      return boundedHistoryPage(m, s, entries, page.nextCursor, page.nextCursor === null ? "complete" : "more");
    },
    async compactionMarker(callerSignal) {
      const signal = boundedSignal(callerSignal);
      signal.throwIfAborted();
      const page = await read(64, signal);
      const marker = page.data.find(entry => entry.item.type === "contextCompaction");
      return marker ? `${marker.turnId}/${marker.item.id}` : null;
    },
    async compact(signal) { await contextRequest(rpc, "thread/compact/start", { threadId: s.uuid }, boundedSignal(signal)); },
  };
}
