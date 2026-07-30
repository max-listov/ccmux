import { z } from "zod";
import { writeLifecycle, type LifecycleStatus } from "../agent/sessionStatus.ts";

/**
 * `ccmux hook-status` — Claude Code lifecycle hooks (UserPromptSubmit / Stop / SessionStart) for a
 * managed session. Turns the authoritative turn-boundary events into a `working`/`idle` lifecycle
 * status file, so `list`/TUI stop guessing working-vs-idle from the pane spinner.
 *
 *   UserPromptSubmit → working   (a turn just started)
 *   Stop             → idle      (turn ended voluntarily)
 *   SessionStart     → idle      (fresh launch/resume — no turn running; clears a stale `working`
 *                                 left by a crash/interrupt, since Stop never fires on interrupt)
 *
 * Identity is `CCMUX_SESSION` (the stable session NAME set at launch), like `stop-hook`. Writes
 * NOTHING to stdout (a Stop hook's stdout is parsed by Claude — the chat `stop-hook` runs on the same
 * event and owns the `{decision:block}` channel; this must stay silent). Fully fail-open: any error
 * exits 0 so a status hiccup can never wedge a turn.
 */
const PayloadSchema = z.object({
  hook_event_name: z.string().optional(),
  permission_mode: z.string().optional(),
  effort: z.string().optional(),
  transcript_path: z.string().optional(),
});

const EVENT_STATE: Record<string, LifecycleStatus["state"]> = {
  UserPromptSubmit: "working",
  Stop: "idle",
  SessionStart: "idle",
};

/** Pure: hook stdin payload → the lifecycle status to persist, or null (unmapped event / bad JSON,
 *  meaning "leave the current status as-is"). Separated from IO so it's unit-testable. */
export function parseLifecycle(raw: string, now: number): LifecycleStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = PayloadSchema.safeParse(parsed).data;
  if (p === undefined || p.hook_event_name === undefined) return null;
  const event = p.hook_event_name;
  const state = EVENT_STATE[event];
  if (state === undefined) return null; // event we don't map → leave status untouched
  return {
    state,
    ts: now,
    event,
    ...(p.permission_mode !== undefined ? { permissionMode: p.permission_mode } : {}),
    ...(p.effort !== undefined ? { effort: p.effort } : {}),
    ...(p.transcript_path !== undefined ? { transcriptPath: p.transcript_path } : {}),
  };
}

export async function cmdHookStatus(): Promise<number> {
  try {
    const raw = await Bun.stdin.text().catch(() => "");
    const self = process.env.CCMUX_SESSION;
    if (self === undefined || self === "") return 0;
    const status = parseLifecycle(raw, Date.now());
    if (status === null) return 0;
    await writeLifecycle(self, status);
    return 0;
  } catch {
    return 0; // fail-open — never break the turn over a status write
  }
}
