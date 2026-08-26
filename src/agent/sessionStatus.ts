import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { LaunchStampSchema, type LaunchStamp } from "./launchStamp.ts";
import { STATUS_DIR } from "../config/paths.ts";
import { atomicWrite } from "../util/atomic.ts";

// Per-session structured status, written by the Claude hooks (`ccmux hook-status`) and the statusLine
// tee (`ccmux status-line`), read by `list`/TUI. TWO files per session, one topic each, so a write
// about the turn can never clobber a write about the context window (lifecycle = turn boundaries,
// metrics = statusLine only). Keyed by the ccmux session NAME (stable — CCMUX_SESSION env), not the
// agent's own uuid.
//
// The lifecycle file has a second writer, and it is there by necessity: the supervisor closes a turn
// the hook never closed. `Stop` fires only when a turn ends VOLUNTARILY, so a `working` stamp
// outlives its turn whenever one is interrupted or the hook simply does not run — and nothing inside
// the session survives to correct it. They do not race for the same instant: the hook writes turn
// boundaries as they happen, the supervisor writes only when it has PROVEN a turn is over and the
// hook stayed silent. Every write is atomic, so a reader sees one record or the other, never a
// mixture.

/** The `event` the supervisor stamps when it closes a turn the hook abandoned. Not a Claude hook
 *  name, and deliberately shaped so it cannot collide with one: a late `Stop` reads it and stays
 *  quiet rather than announcing the same turn's end a second time. */
export const SUPERVISOR_CLOSED_EVENT = "ccmux:turn-closed";

export const LifecycleStatusSchema = z.object({
  state: z.enum(["working", "idle"]),
  ts: z.number(),
  /** What set it: a Claude hook (UserPromptSubmit/Stop/SessionStart), or `ccmux:turn-closed` when
   *  the supervisor closed a turn no hook ever ended. */
  event: z.string(),
  permissionMode: z.string().optional(),
  effort: z.string().optional(),
  transcriptPath: z.string().optional(),
});
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

// `msgId` is what keeps the reason ATTACHED to the message it describes: the daemon holds on ONE
// picked message per recipient, so stamping that reason under every unread letter would confidently
// label a deferred one "a human is typing" when the hold was about something else entirely.
export const ChatHoldSchema = z.object({
  reason: z.string(),
  ts: z.number(),
  /** When the daemon FIRST held this same message. A hold is rewritten every pass, so `ts` only ever
   *  says "a moment ago" — which is true and useless: it is the same answer after three seconds and
   *  after eleven hours, and the difference between those two is the whole question. */
  since: z.number().optional(),
  msgId: z.string().nullable().default(null),
});
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
const launchPath = (name: string): string => `${STATUS_DIR}/${safe(name)}.launch.json`;

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

/**
 * The record that closes a turn the hook never ended.
 *
 * Carries the session-shaped fields (`permissionMode`, `effort`, `transcriptPath`) forward from the
 * record it replaces: they describe the SESSION, not the turn, and dropping them would blank a
 * reader's view of a session merely because its last turn was interrupted.
 */
export function closedTurnRecord(previous: LifecycleStatus, endedMs: number): LifecycleStatus {
  return { ...previous, state: "idle", ts: endedMs, event: SUPERVISOR_CLOSED_EVENT };
}

export async function closeLifecycleTurn(name: string, previous: LifecycleStatus, endedMs: number): Promise<void> {
  await writeLifecycle(name, closedTurnRecord(previous, endedMs));
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
    const now = Date.now();
    // Carried forward while it is the SAME letter being held, so "how long has this been stuck" is a
    // fact rather than an inference. A different message starts its own clock: a reason recorded
    // about another letter is not evidence about this one.
    const previous = ChatHoldSchema.safeParse(readRaw(chatHoldPath(name))).data;
    const since = previous !== undefined && previous.msgId === msgId ? previous.since ?? previous.ts : now;
    await atomicWrite(chatHoldPath(name), JSON.stringify({ reason, ts: now, since, msgId }));
  } catch {
    // best-effort diagnostics
  }
}

export function readChatHold(name: string, maxAgeMs = 15_000): { reason: string; msgId: string | null; heldForMs: number } | null {
  const h = ChatHoldSchema.safeParse(readRaw(chatHoldPath(name))).data;
  if (h === undefined) return null;
  const now = Date.now();
  return now - h.ts <= maxAgeMs ? { reason: h.reason, msgId: h.msgId, heldForMs: Math.max(0, now - (h.since ?? h.ts)) } : null;
}

export function clearChatHold(name: string): void {
  try {
    rmSync(chatHoldPath(name), { force: true });
  } catch {
    // best-effort
  }
}

export function clearStatus(name: string): void {
  for (const p of [lifecyclePath(name), metricsPath(name), chatHoldPath(name), launchPath(name)]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Record what this launch is using, so `list` can later answer "would a restart change anything?".
 *  Best-effort: a session must start even if we cannot write a note about it. */
export function writeLaunchStamp(name: string, stamp: Omit<LaunchStamp, "ts">): void {
  try {
    mkdirSync(STATUS_DIR, { recursive: true });
    writeFileSync(launchPath(name), JSON.stringify({ ...stamp, ts: Date.now() }));
  } catch {
    // best-effort bookkeeping
  }
}

export function readLaunchStamp(name: string): LaunchStamp | null {
  return LaunchStampSchema.safeParse(readRaw(launchPath(name))).data ?? null;
}
