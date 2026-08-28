import { z } from "zod";
import { connectCodexAppServer, type CodexAppRpc } from "../agent/codex/appServer.ts";
import type { ExternalSession, MachineConfig } from "../types.ts";
import { unknownTurnState, type ExternalTurnState } from "./turnSchema.ts";
import { compareSemver } from "../util/version.ts";

export const TURN_OBSERVATION_TTL_MS = 5_000;
export const TURN_OBSERVATION_DEADLINE_MS = 2_000;
const PAGE_SIZE = 128;
const MAX_PAGES = 4;
const PageSchema = z.object({
  data: z.array(z.object({ id: z.uuid(), status: z.unknown() })).max(PAGE_SIZE),
  nextCursor: z.string().max(4096).nullable(),
});
const StatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({ type: z.literal("active"), activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).max(2) }),
]);

export function nativeTurnState(status: unknown, now: number): ExternalTurnState {
  const parsed = StatusSchema.safeParse(status);
  let result = unknownTurnState("codex-app-server", "unsupported-status");
  if (parsed.success) {
    const value = parsed.data;
    if (value.type === "notLoaded") result.reason = "not-loaded";
    else if (value.type === "systemError") result.reason = "system-error";
    else {
      result = {
        ...result, evidence: "observed", reason: "native-status",
        state: value.type === "idle" ? "idle"
          : value.activeFlags.includes("waitingOnApproval") ? "waiting-approval"
          : value.activeFlags.includes("waitingOnUserInput") ? "waiting-input" : "working",
      };
    }
  }
  return { ...result, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + TURN_OBSERVATION_TTL_MS).toISOString() };
}

/** No cached working state survives a failed read. Ownership and admission are never inputs. */
export async function observeExternalTurns(
  machine: MachineConfig,
  sessions: ExternalSession[],
  connect: (machine: MachineConfig, options: { signal: AbortSignal; maxMessageBytes: number }) => Promise<CodexAppRpc> = connectCodexAppServer,
): Promise<ExternalSession[]> {
  const wanted = new Set(sessions.filter((row) => row.provider === "codex").map((row) => row.threadId));
  if (wanted.size === 0) return sessions.map((row) => ({ ...row, turnState: unknownTurnState("unsupported", "unsupported-provider") }));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_OBSERVATION_DEADLINE_MS);
  const observed = new Map<string, ExternalTurnState>();
  let missing = unknownTurnState("codex-app-server", "not-reported");
  let rpc: CodexAppRpc | undefined;
  try {
    rpc = await connect(machine, { signal: abort.signal, maxMessageBytes: 2 * 1024 * 1024 });
    // Older servers may silently ignore unknown request fields. Never risk their JSONL
    // repair fallback: this floor was verified against the installed provider protocol.
    const version = rpc.userAgent?.match(/^[^/]+\/(\d+\.\d+\.\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\s|$)/);
    const core = version?.[1];
    const compared = core ? compareSemver(core, "0.144.6") : -1;
    // A newer prerelease contains the floor's contract; a prerelease of the floor does not.
    if (!core || compared < 0 || (compared === 0 && version?.[2])) {
      return sessions.map((row) => ({ ...row, turnState: row.provider === "codex"
        ? unknownTurnState("codex-app-server", "unsupported-runtime")
        : unknownTurnState("unsupported", "unsupported-provider") }));
    }
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      abort.signal.throwIfAborted();
      const page = PageSchema.parse(await rpc.request("thread/list", {
        cursor, limit: PAGE_SIZE, sortKey: "updated_at", useStateDbOnly: true,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"],
      }));
      abort.signal.throwIfAborted();
      const now = Date.now();
      for (const thread of page.data) {
        if (wanted.has(thread.id)) observed.set(thread.id, nativeTurnState(thread.status, now));
      }
      if (page.nextCursor === null) { missing = unknownTurnState("codex-app-server", "not-reported"); break; }
      if (observed.size === wanted.size) break;
      missing = unknownTurnState("codex-app-server", "read-limit");
      if (cursors.has(page.nextCursor)) break;
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  } catch {
    observed.clear();
    missing = abort.signal.aborted
      ? unknownTurnState("codex-app-server", "deadline", "stale")
      : unknownTurnState("codex-app-server", "connection-unavailable", "unavailable");
  } finally {
    clearTimeout(timer);
    rpc?.close();
  }
  return sessions.map((row) => ({ ...row, turnState: row.provider === "codex"
    ? observed.get(row.threadId) ?? missing
    : unknownTurnState("unsupported", "unsupported-provider") }));
}
