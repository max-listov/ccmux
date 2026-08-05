import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { STATUS_DIR } from "../config/paths.ts";
import { atomicWrite } from "../util/atomic.ts";

// Per-session structured status, written by the Claude hooks (`ccmux hook-status`) and the statusLine
// tee (`ccmux status-line`), read by `list`/TUI. TWO files per session, single-writer each, so the
// two writers never race on one file (lifecycle = hooks only, metrics = statusLine only). Keyed by
// the ccmux session NAME (stable — CCMUX_SESSION env), not the agent's own uuid.

export const LifecycleStatusSchema = z.object({
  state: z.enum(["working", "idle"]),
  ts: z.number(),
  event: z.string(), // the hook that set it (UserPromptSubmit/Stop/SessionStart)
  permissionMode: z.string().optional(),
  effort: z.string().optional(),
  transcriptPath: z.string().optional(),
});
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

// `msgId` is what keeps the reason ATTACHED to the message it describes: the daemon holds on ONE
// picked message per recipient, so stamping that reason under every unread letter would confidently
// label a deferred one "a human is typing" when the hold was about something else entirely.
export const ChatHoldSchema = z.object({ reason: z.string(), ts: z.number(), msgId: z.string().nullable().default(null) });
export type ChatHold = z.infer<typeof ChatHoldSchema>;

export const MetricsStatusSchema = z.object({
  ts: z.number(),
  pct: z.number().nullable(), // context_window.used_percentage
  contextSizeTokens: z.number().nullable(), // context_window.context_window_size
  model: z.string().nullable(), // model.display_name
  costUsd: z.number().nullable(),
});
export type MetricsStatus = z.infer<typeof MetricsStatusSchema>;

/**
 * Resolve the live working/idle state, pane-DECISIVE. A live pane spinner → working; a drawn idle UI
 * (`paneReady`) → idle — this OVERRIDES a stale lifecycle `working` (e.g. after an ESC-interrupt,
 * where Claude fires no Stop hook, so the lifecycle file would otherwise stay `working` forever). The
 * lifecycle file only fills the ambiguous cold-start window where the pane isn't drawn yet.
 */
export function resolveLiveState(
  paneWorking: boolean,
  paneReady: boolean,
  lifecycleState: LifecycleStatus["state"] | null,
): LifecycleStatus["state"] {
  if (paneWorking) return "working";
  if (paneReady) return "idle";
  return lifecycleState ?? "idle";
}

const safe = (name: string): string => name.replace(/[^\w.-]/g, "_");
const lifecyclePath = (name: string): string => `${STATUS_DIR}/${safe(name)}.lifecycle.json`;
const chatHoldPath = (name: string): string => `${STATUS_DIR}/${safe(name)}.chathold.json`;
const metricsPath = (name: string): string => `${STATUS_DIR}/${safe(name)}.metrics.json`;

function readRaw(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readLifecycle(name: string): LifecycleStatus | null {
  return LifecycleStatusSchema.safeParse(readRaw(lifecyclePath(name))).data ?? null;
}

export function readMetrics(name: string): MetricsStatus | null {
  return MetricsStatusSchema.safeParse(readRaw(metricsPath(name))).data ?? null;
}

export async function writeLifecycle(name: string, data: LifecycleStatus): Promise<void> {
  mkdirSync(STATUS_DIR, { recursive: true });
  await atomicWrite(lifecyclePath(name), JSON.stringify(data));
}

export async function writeMetrics(name: string, data: MetricsStatus): Promise<void> {
  mkdirSync(STATUS_DIR, { recursive: true });
  await atomicWrite(metricsPath(name), JSON.stringify(data));
}

/** Drop both status files for a session — called from every kill path (stop/rm/restart) so a
 *  stopped session never shows a stale live status. */
/** Why the daemon last HELD chat delivery for this session (menu / typing / not settled). Written
 *  only on an actual hold and cleared on delivery, so `inbox` can name the live reason without
 *  re-deriving it (which would be a second source of truth, and wrong when asked from inside the
 *  session itself). Stale records are ignored by the reader — the daemon passes every few seconds. */
/** Best-effort, like every other status write here: this is bookkeeping ABOUT a delivery pass, and
 *  a failed note must never abort the pass itself (which would skip the remaining recipients and
 *  their cursor save). */
export async function writeChatHold(name: string, msgId: string, reason: string): Promise<void> {
  try {
    mkdirSync(STATUS_DIR, { recursive: true });
    await atomicWrite(chatHoldPath(name), JSON.stringify({ reason, ts: Date.now(), msgId }));
  } catch {
    // best-effort diagnostics
  }
}

export function readChatHold(name: string, maxAgeMs = 15_000): { reason: string; msgId: string | null } | null {
  const h = ChatHoldSchema.safeParse(readRaw(chatHoldPath(name))).data;
  if (h === undefined) return null;
  return Date.now() - h.ts <= maxAgeMs ? { reason: h.reason, msgId: h.msgId } : null;
}

export function clearChatHold(name: string): void {
  try {
    rmSync(chatHoldPath(name), { force: true });
  } catch {
    // best-effort
  }
}

export function clearStatus(name: string): void {
  for (const p of [lifecyclePath(name), metricsPath(name), chatHoldPath(name)]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
