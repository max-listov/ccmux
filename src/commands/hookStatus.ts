import { z } from "zod";
import { readLifecycle, writeLifecycle, type LifecycleStatus } from "../agent/sessionStatus.ts";
import { appendEvent } from "../events/feed.ts";
import { eventsEnabledFor } from "../config/events.ts";
import { loadMachineConfig } from "../config/machine.ts";
import { findSession, loadSessions } from "../config/sessions.ts";
import type { EmitInput } from "../events/feed.ts";

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

/**
 * The same hook event, said as a TRANSITION for the feed.
 *
 * The lifecycle file answers "what is this session doing"; the feed answers "what just happened",
 * and only the second one survives being read a minute later. `turn-end` carries how long the turn
 * ran, measured from the `working` stamp the previous hook left — which is why the duration is
 * available at all without anyone keeping a timer.
 *
 * Pure: the previous status and the clock come in as arguments. `null` means this event says nothing
 * a reader would want (an unmapped event, or a `SessionStart` that is merely clearing a stale flag).
 */
export function eventForLifecycle(status: LifecycleStatus, previous: LifecycleStatus | null): EmitInput | null {
  // A turn begins with a TRANSITION, not with a message. A prompt that lands while a turn is already
  // running joins that turn instead of starting one — a delivered chat message, a background
  // watcher's notification, a second question typed after the first. Measured before this check
  // existed: three starts 50ms apart with no end between them, which for a reader tracking state is
  // three turns that never finished.
  if (status.event === "UserPromptSubmit") return previous?.state === "working" ? null : { event: "turn-start" };
  if (status.event === "SessionStart") return { event: "session-start" };
  if (status.event !== "Stop") return null;
  // A turn we never saw start (the hook was added mid-conversation, or the daemon already closed an
  // interrupted turn) still ended — report it without inventing a duration.
  if (previous === null || previous.state !== "working") return { event: "turn-end" };
  const durationMs = status.ts - previous.ts;
  return durationMs >= 0 ? { event: "turn-end", durationMs } : { event: "turn-end" };
}

/**
 * The status to persist, given what was already there.
 *
 * A prompt arriving inside a running turn must not move the turn's START forward. It did: the status
 * was written with the current instant every time, so `turn-end`'s duration — computed as stop minus
 * that instant — measured from the LAST prompt rather than from the beginning of the work. That is a
 * lie about the one number this feed exists to report, and a convincing one: it is plausible on its
 * face, and the busier the session the more it under-reports.
 */
export function lifecycleToWrite(status: LifecycleStatus, previous: LifecycleStatus | null): LifecycleStatus {
  if (status.state === "working" && previous?.state === "working") return { ...status, ts: previous.ts };
  return status;
}

export async function cmdHookStatus(): Promise<number> {
  try {
    const raw = await Bun.stdin.text().catch(() => "");
    const self = process.env.CCMUX_SESSION;
    if (self === undefined || self === "") return 0;
    const status = parseLifecycle(raw, Date.now());
    if (status === null) return 0;
    // Read BEFORE the write: the previous status is what carries the turn's start instant, and this
    // write is about to replace it.
    const previous = readLifecycle(self);
    await writeLifecycle(self, lifecycleToWrite(status, previous));
    // The feed comes after the status file, and cannot fail into it. The status file is what the
    // fleet's own health reads; the feed is what outside surfaces listen to, and an outside surface
    // must never be able to cost a session its state.
    try {
      const input = eventForLifecycle(status, previous);
      if (input !== null) {
        const m = loadMachineConfig();
        const session = findSession(loadSessions(m), self);
        if (session && eventsEnabledFor(session, m)) appendEvent(m, session, input);
      }
    } catch {
      // fail-open, separately from the status write above
    }
    return 0;
  } catch {
    return 0; // fail-open — never break the turn over a status write
  }
}
