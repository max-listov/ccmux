import { loadMachineConfig } from "../config/machine.ts";
import { followEvents, readEvents } from "../events/feed.ts";
import { humanizeDuration } from "../util/duration.ts";
import type { SessionEvent } from "../types.ts";
import { usageLine } from "./help.ts";

/**
 * `ccmux events` — the contract an outside surface reads the feed through.
 *
 * The file format is deliberately NOT the contract. A consumer that parsed `events.jsonl` itself
 * would have to know about rotation, about partially-written last lines, and about where the state
 * directory is on that machine — three things that are ours to change and none of which it should
 * ever have to learn. It also could not be run over a transport: `ccmux events --follow` works the
 * same locally and through whatever runs a command on another machine, which is what makes one
 * consumer able to watch a whole fleet.
 *
 * `--since` is a TIME, and the events it returns are at-least-once by design: reconnecting re-reads
 * the boundary instant rather than risking a gap. Every event carries `id` for exactly that reason —
 * a consumer that acts on events drops the ids it has already handled.
 */
const HUMAN: Record<SessionEvent["event"], string> = {
  "turn-start": "started a turn",
  "turn-end": "finished a turn",
  waiting: "is waiting at a menu",
  resumed: "left the menu and went back to work",
  "session-start": "session started",
  "session-stop": "session stopped",
  "session-blocked": "session is blocked",
};

/** One event as a line a person can read. Pure, so the wording is testable and cannot drift from
 *  the machine-readable shape it describes. */
export function formatEvent(event: SessionEvent): string {
  const when = event.ts.slice(11, 19);
  const address = `${event.machine}:${event.session}`;
  const parts = [HUMAN[event.event]];
  if (event.durationMs !== undefined) parts.push(`after ${humanizeDuration(Math.round(event.durationMs / 1000))}`);
  if (event.interrupted === true) parts.push("(interrupted — it did not end on its own)");
  if (event.detail !== undefined && event.detail !== "") parts.push(`— ${event.detail}`);
  return `${when}  ${address.padEnd(24)} ${parts.join(" ")}`;
}

/**
 * One event wrapped for a transport that resumes.
 *
 * Some transports carry a follow-style feed as **framed** NDJSON rather than raw bytes: each line is
 * an envelope whose `data` is the payload and whose `cursor` marks where the reader got to, so a
 * broken stream can be reopened from that point instead of from the beginning or from now. The
 * envelope shape is fixed and strict on the other side — extra keys are a protocol error, not a
 * courtesy — so this builds exactly it and nothing more.
 *
 * The cursor is the event's own timestamp, which is precisely what `--since` takes: whatever a reader
 * hands back, it is asking the same question in the same units. Duplicates at the boundary are
 * expected (delivery is at-least-once by design) and are dropped by `id`.
 */
export function framedLine(event: SessionEvent): string {
  return `${JSON.stringify({ data: `${JSON.stringify(event)}\n`, cursor: event.ts })}\n`;
}

export async function cmdEvents(args: string[]): Promise<number> {
  let follow = false;
  let json = false;
  let framed = false;
  let since: string | undefined;
  let session: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--follow" || a === "-f") follow = true;
    else if (a === "--json") json = true;
    // Kept separate from `--json` on purpose: `--json` is the clean stream of events, which is what a
    // person reads and what a local consumer wants. Wrapping every line in an envelope by default
    // would make the common case pay for the transport's contract.
    else if (a === "--framed") framed = true;
    else if (a === "--since") since = args[++i];
    else if (a === "--session") session = args[++i];
    else if (a === "-n") {
      const parsed = Number.parseInt(args[++i] ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return console.error("events: -n needs a positive count"), 1;
      limit = parsed;
    } else if (a?.startsWith("-")) return console.error(`events: unknown flag '${a}'\n${usageLine("events")}`), 1;
  }
  if (since !== undefined && !Number.isFinite(Date.parse(since))) {
    console.error(`events: --since needs an ISO instant (e.g. ${new Date().toISOString()})`);
    return 1;
  }

  const m = loadMachineConfig();
  // `process.stdout.write`, deliberately not `console.log`: measured, console.log SWALLOWS the EPIPE
  // a closed reader produces, so a follower whose consumer had gone away kept watching the feed
  // forever. Writing directly surfaces the error, which is what turns "reader left" into an exit.
  const emit = (event: SessionEvent): void => {
    if (framed) {
      process.stdout.write(framedLine(event));
      return;
    }
    process.stdout.write(`${json ? JSON.stringify(event) : formatEvent(event)}\n`);
  };

  if (!follow) {
    const opts: Parameters<typeof readEvents>[1] = {};
    if (since !== undefined) opts.since = since;
    if (session !== undefined) opts.session = session;
    if (limit !== undefined) opts.limit = limit;
    else if (since === undefined) opts.limit = 30; // a bare call is a look at recent history, not a dump
    for (const event of readEvents(m, opts)) emit(event);
    return 0;
  }

  // Follow never returns on its own: the caller ends it by closing the pipe or killing the process,
  // which is how every long-running reader in a pipeline behaves.
  const opts: Parameters<typeof followEvents>[2] = {};
  if (since !== undefined) opts.since = since;
  if (session !== undefined) opts.session = session;
  const stop = followEvents(m, emit, opts);
  const done = new Promise<void>((resolve) => {
    const end = (): void => {
      stop();
      resolve();
    };
    process.on("SIGINT", end);
    process.on("SIGTERM", end);
    // A reader that went away is noticed on the next WRITE, not the moment it left: a closed pipe is
    // only observable by writing into it — measured, `destroyed`/`writable`/`close` all stay quiet
    // until then. So this behaves like every other follow tool, and the handler's real job is to
    // make that moment a clean exit instead of an unhandled EPIPE crash.
    process.stdout.on("error", end);
  });
  await done;
  return 0;
}
