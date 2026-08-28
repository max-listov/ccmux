import { z } from "zod";
import type { CodexAppRpc } from "../agent/codex/rpc.ts";
import { compareSemver } from "../util/version.ts";

export const NATIVE_PAGE_SIZE = 128;
export const NATIVE_MAX_PAGES = 4;
export const NativeStatusEnvelopeSchema = z.object({
  type: z.string().max(128), activeFlags: z.array(z.string().max(128)).max(16).optional(),
});
export const NativeThreadSummarySchema = z.object({
  id: z.uuid(), status: NativeStatusEnvelopeSchema,
  name: z.string().max(4096).nullable().optional(),
  cwd: z.string().max(4096).nullable().optional(),
  updatedAt: z.number().int().nonnegative().max(253_402_300_799).optional(),
});
const PageSchema = z.object({
  data: z.array(NativeThreadSummarySchema).max(NATIVE_PAGE_SIZE),
  nextCursor: z.string().max(4096).nullable(),
});
export type NativeThreadSummary = z.infer<typeof NativeThreadSummarySchema>;

/** Older providers may ignore useStateDbOnly and scan/repair rollouts. */
export function supportsNativeStatus(userAgent: string | undefined): boolean {
  const version = userAgent?.match(/^[^/]+\/(\d+\.\d+\.\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\s|$)/);
  const core = version?.[1];
  const compared = core ? compareSemver(core, "0.144.6") : -1;
  return !!core && (compared > 0 || (compared === 0 && !version?.[2]));
}

export async function nativeStatusPage(rpc: CodexAppRpc, cursor: string | null) {
  return PageSchema.parse(await rpc.request("thread/list", {
    cursor, limit: NATIVE_PAGE_SIZE, sortKey: "updated_at", useStateDbOnly: true,
    sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"],
  }));
}

export async function nativeStatusInventory(rpc: CodexAppRpc, signal: AbortSignal) {
  const rows = new Map<string, NativeThreadSummary>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < NATIVE_MAX_PAGES; page++) {
    signal.throwIfAborted();
    const result = await nativeStatusPage(rpc, cursor);
    signal.throwIfAborted();
    for (const row of result.data) rows.set(row.id, row);
    cursor = result.nextCursor;
    if (cursor === null) break;
    if (cursors.has(cursor)) throw new Error("Native inventory cursor repeated");
    cursors.add(cursor);
  }
  return { rows: [...rows.values()], truncated: cursor !== null };
}
