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
export function clearStatus(name: string): void {
  for (const p of [lifecyclePath(name), metricsPath(name)]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
